import type { OrthographicOffCenterFrustum, Viewer } from 'cesium';
import type { Map as MapLibre } from 'maplibre-gl';
import type { CesiumVectorTileset } from '../../packages/cesium-vector-tileset/index';
import type { GeometryTextureUpload } from './performance-buffer-snapshot';
import { maplibreBufferSnapshot } from './maplibre-buffer-snapshot';
import { performanceBufferSnapshot } from './performance-buffer-snapshot';

interface Pose { longitude: number; latitude: number; zoom: number }
interface Frame {
  phase: string;
  pose: Pose;
  time: number;
  cpuMs: number;
  stages: Record<string, number>;
  drawCalls: number;
  submittedVertices: number;
  bufferBytes: number;
  uploads: number;
  uploadedBytes: number;
}
interface GeometryProbe {
  kind: 'parcel' | 'road';
  geographic: number[];
  pixel: number[];
  rgba: number[];
  matches: boolean;
}
interface PackedGeometry { packedData: Float64Array; stringTable: string[] }
interface PackedCombine { createGeometryResults: PackedGeometry[]; packedInstances: Float64Array }
type Method = (...args: unknown[]) => unknown;

// The same geographic path and 512 CSS pixel world are used by both engines.
const origin = { longitude: -0.1276, latitude: 51.5072, zoom: 14 };
function poseAt(progress: number): Pose {
  const angle = progress * Math.PI * 2;
  return {
    longitude: origin.longitude + Math.sin(angle) * 0.04,
    latitude: origin.latitude + (Math.cos(angle) - 1) * 0.013,
    zoom: origin.zoom + Math.sin(angle * 2) * 0.35,
  };
}

async function createMeasurement() {
  const query = new URLSearchParams(location.search);
  const renderer = query.get('renderer');
  if (renderer !== 'cesium' && renderer !== 'maplibre')
    throw new Error('renderer must be cesium or maplibre');
  const styleUrl = new URL('/performance-local/style.json', location.href).href;
  const errors: string[] = [];
  const frames: Frame[] = [];
  let phase = 'cold';
  let measuring = true;
  const nativePacking: Array<{ method: string; durationMs: number; instances: number; bytes: number; attributes: string[] }> = [];
  let active: Frame | undefined;
  let viewer: Viewer | undefined;
  let tileset: CesiumVectorTileset | undefined;
  let map: MapLibre | undefined;
  let lastPose = origin;
  let driverMs = 0;
  let projectedBounds: (() => number[][]) | undefined;
  let project: (longitude: number, latitude: number) => number[];
  let setPose: (pose: Pose) => void;
  const landmarks = [[-0.1476, 51.4972], [-0.1076, 51.5172], [-0.1276, 51.5072]];
  const glCounts = { drawCalls: 0, submittedVertices: 0, bufferBytes: 0, uploads: 0, uploadedBytes: 0 };
  const bufferSizes = new Map<WebGLBuffer, number>();
  const textureUploads = new Map<WebGLTexture, GeometryTextureUpload[]>();
  let gl: WebGL2RenderingContext;
  let capturePixels = false;
  let captureComplete: (() => void) | undefined;
  let pixelEvidence: { parcelFraction: number; roadFraction: number; sampledPixels: number; probes: GeometryProbe[] } | undefined;

  // Instrument the actual context before any renderer allocates its buffers.
  // Buffer capacity remains the common comparison. Geometry texture uploads
  // are attributed separately outside frame timings; neither is driver VRAM.
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    const context = (getContext as unknown as Method).apply(this, args);
    if (context instanceof WebGL2RenderingContext && document.getElementById('map')!.contains(this) && context !== gl) {
      gl = context;
      const target = context as unknown as Record<string, Method>;
      let textureUnit: number = context.TEXTURE0;
      const textureBindings = new Map<number, WebGLTexture | null>();
      const activeTexture = target.activeTexture;
      target.activeTexture = function (...values) {
        textureUnit = Number(values[0]);
        return activeTexture.apply(this, values);
      };
      const bindTexture = target.bindTexture;
      target.bindTexture = function (...values) {
        if (values[0] === context.TEXTURE_2D)
          textureBindings.set(textureUnit, values[1] as WebGLTexture | null);
        return bindTexture.apply(this, values);
      };
      for (const method of ['texImage2D', 'texSubImage2D']) {
        const original = target[method];
        target[method] = function (...values) {
          const result = original.apply(this, values);
          const texture = textureBindings.get(textureUnit);
          // The Native position texture uses the explicit width/height integer
          // upload overload. Other textures stay outside this capacity ledger.
          if (texture && values[0] === context.TEXTURE_2D && values[6] === context.RGBA_INTEGER
            && values[7] === context.UNSIGNED_INT && typeof values[3] === 'number') {
            const events = textureUploads.get(texture) ?? [];
            events.push({ phase, method, width: Number(values[method === 'texImage2D' ? 3 : 4]), height: Number(values[method === 'texImage2D' ? 4 : 5]), bytes: transferBytes(values[8] as ArrayBufferView | null, values[9], values[10]) });
            textureUploads.set(texture, events);
          }
          return result;
        };
      }
      const deleteTexture = target.deleteTexture;
      target.deleteTexture = function (...values) {
        const texture = values[0] as WebGLTexture;
        textureUploads.delete(texture);
        for (const [unit, bound] of textureBindings) {
          if (bound === texture)
            textureBindings.set(unit, null);
        }
        return deleteTexture.apply(this, values);
      };
      for (const method of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
        const original = target[method];
        target[method] = function (...values) {
          glCounts.drawCalls++;
          const count = Number(values[method.startsWith('drawElements') ? 1 : 2]);
          const instances = method.endsWith('Instanced') ? Number(values[method.startsWith('drawElements') ? 4 : 3]) : 1;
          glCounts.submittedVertices += count * instances;
          return original.apply(this, values);
        };
      }
      const bufferBindings: Record<number, number> = {
        [context.ARRAY_BUFFER]: context.ARRAY_BUFFER_BINDING,
        [context.ELEMENT_ARRAY_BUFFER]: context.ELEMENT_ARRAY_BUFFER_BINDING,
        [context.COPY_READ_BUFFER]: context.COPY_READ_BUFFER_BINDING,
        [context.COPY_WRITE_BUFFER]: context.COPY_WRITE_BUFFER_BINDING,
        [context.PIXEL_PACK_BUFFER]: context.PIXEL_PACK_BUFFER_BINDING,
        [context.PIXEL_UNPACK_BUFFER]: context.PIXEL_UNPACK_BUFFER_BINDING,
        [context.TRANSFORM_FEEDBACK_BUFFER]: context.TRANSFORM_FEEDBACK_BUFFER_BINDING,
        [context.UNIFORM_BUFFER]: context.UNIFORM_BUFFER_BINDING,
      };
      const bufferData = target.bufferData;
      target.bufferData = function (...values) {
        const data = values[1] as number | ArrayBuffer | ArrayBufferView | null;
        const bytes = typeof data === 'number' ? data : transferBytes(data, values[3], values[4]);
        const binding = bufferBindings[Number(values[0])];
        const buffer = context.getParameter(binding) as WebGLBuffer | null;
        const result = bufferData.apply(this, values);
        if (buffer) {
          glCounts.bufferBytes += bytes - (bufferSizes.get(buffer) ?? 0);
          bufferSizes.set(buffer, bytes);
        }
        glCounts.uploads++;
        glCounts.uploadedBytes += bytes;
        return result;
      };
      const bufferSubData = target.bufferSubData;
      target.bufferSubData = function (...values) {
        glCounts.uploads++;
        glCounts.uploadedBytes += transferBytes(values[2] as ArrayBufferView, values[3], values[4]);
        return bufferSubData.apply(this, values);
      };
      const deleteBuffer = target.deleteBuffer;
      target.deleteBuffer = function (...values) {
        const buffer = values[0] as WebGLBuffer;
        glCounts.bufferBytes -= bufferSizes.get(buffer) ?? 0;
        bufferSizes.delete(buffer);
        return deleteBuffer.apply(this, values);
      };
    }
    return context;
  } as typeof getContext;

  function transferBytes(data: ArrayBuffer | ArrayBufferView | null, offset: unknown, length: unknown) {
    if (!data)
      return 0;
    const elementSize = (data as ArrayBufferView & { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const remaining = data.byteLength - Number(offset ?? 0) * elementSize;
    return length === undefined || Number(length) === 0 ? remaining : Number(length) * elementSize;
  }

  function measure(owner: object, method: string, name: string, wholeFrame = false) {
    const target = owner as Record<string, Method>;
    const original = target[method];
    if (typeof original !== 'function')
      throw new Error(`Missing measurement method ${name}: ${method}`);
    target[method] = function (...args) {
      if (!measuring) {
        const result = original.apply(this, args);
        if (wholeFrame && capturePixels) {
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let parcels = 0;
          let roads = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if ([140, 159, 188].every((channel, axis) => Math.abs(pixels[index + axis] - channel) <= 5))
              parcels++;
            if ([0, 1, 2].every(axis => pixels[index + axis] >= 250))
              roads++;
          }
          pixelEvidence = { parcelFraction: parcels / (width * height), roadFraction: roads / (width * height), sampledPixels: width * height, probes: geometryProbes(pixels, width, height) };
          capturePixels = false;
          captureComplete?.();
        }
        return result;
      }
      const before = wholeFrame ? { ...glCounts } : undefined;
      const start = performance.now();
      if (wholeFrame) {
        active = { phase, pose: { ...lastPose }, time: start, cpuMs: 0, stages: {}, drawCalls: 0, submittedVertices: 0, bufferBytes: 0, uploads: 0, uploadedBytes: 0 };
      }
      try {
        return original.apply(this, args);
      }
      finally {
        const duration = performance.now() - start;
        if (active) {
          if (wholeFrame) {
            active.cpuMs = duration;
            active.drawCalls = glCounts.drawCalls - before!.drawCalls;
            active.submittedVertices = glCounts.submittedVertices - before!.submittedVertices;
            active.bufferBytes = glCounts.bufferBytes;
            active.uploads = glCounts.uploads - before!.uploads;
            active.uploadedBytes = glCounts.uploadedBytes - before!.uploadedBytes;
            frames.push(active);
            active = undefined;
          }
          else {
            active.stages[name] = (active.stages[name] ?? 0) + duration;
          }
        }
      }
    };
  }

  function geometryProbes(pixels: Uint8Array, width: number, height: number): GeometryProbe[] {
    const world = 2 ** 14 * 4096;
    const latitudeRadians = lastPose.latitude * Math.PI / 180;
    const centerX = (lastPose.longitude + 180) / 360 * world;
    const centerY = (1 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / Math.PI) / 2 * world;
    const scale = 512 * 2 ** lastPose.zoom / world;
    const firstColumn = Math.floor((centerX - innerWidth / 2 / scale) / 128);
    const lastColumn = Math.ceil((centerX + innerWidth / 2 / scale) / 128);
    const firstRow = Math.floor((centerY - innerHeight / 2 / scale) / 128);
    const lastRow = Math.ceil((centerY + innerHeight / 2 / scale) / 128);
    const probes: GeometryProbe[] = [];
    const rgbaAt = (x: number, y: number) => {
      const offset = ((height - 1 - y) * width + x) * 4;
      return Array.from(pixels.subarray(offset, offset + 4));
    };
    function sample(kind: 'parcel' | 'road', x: number, y: number) {
      const expectedPixelX = innerWidth / 2 + (x - centerX) * scale;
      const expectedPixelY = innerHeight / 2 + (y - centerY) * scale;
      if (expectedPixelX < 2 || expectedPixelX > innerWidth - 3 || expectedPixelY < 2 || expectedPixelY > innerHeight - 3)
        return;
      const geographic = [x / world * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - y / world * 2))) * 180 / Math.PI];
      const pixel = project(geographic[0], geographic[1]);
      const pixelX = Math.floor(pixel[0] * width / innerWidth);
      const pixelY = Math.floor(pixel[1] * height / innerHeight);
      const rgba = rgbaAt(pixelX, pixelY);
      let matches = [140, 159, 188].every((channel, axis) => Math.abs(rgba[axis] - channel) <= 5);
      if (kind === 'road') {
        matches = false;
        // One-pixel positional allowance handles MVT quantization and the
        // antialiased edges of the same three-pixel road, not grid spacing.
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          for (let offsetX = -1; offsetX <= 1; offsetX++) {
            const nearby = rgbaAt(pixelX + offsetX, pixelY + offsetY);
            matches ||= [0, 1, 2].every(axis => nearby[axis] >= 250);
          }
        }
      }
      probes.push({ kind, geographic, pixel, rgba, matches });
    }
    for (let row = firstRow; row <= lastRow; row += 4) {
      for (let column = firstColumn; column <= lastColumn; column += 4) {
        sample('parcel', column * 128 + 60, row * 128 + 60);
        const bend = Math.sin((row % 32) * Math.PI / 4) * 4;
        sample('road', column * 128 + 32 + bend, row * 128);
        sample('road', column * 128 + 96 + bend, row * 128);
      }
    }
    return probes;
  }

  function observeNativePacking(pipeline: Record<string, Method>, geometryPipeline: Record<string, Method>) {
    let pendingAttributes: { geometry: object; start: number; attributes: string[] } | undefined;
    for (const method of ['packCreateGeometryResults', 'packCombineGeometryParameters', 'unpackCombineGeometryResults']) {
      const original = pipeline[method];
      pipeline[method] = function (...args) {
        const start = performance.now();
        const result = original.apply(this, args);
        const durationMs = performance.now() - start;
        if (phase !== 'cold')
          return result;
        const geometry = result as PackedGeometry;
        const combined = result as PackedCombine;
        const geometries = (result as { geometries?: Array<{ attributes: object }> }).geometries;
        const attributes = geometry.stringTable ?? combined.createGeometryResults?.[0]?.stringTable ?? Object.keys(geometries?.[0]?.attributes ?? {});
        const bytes = geometry.packedData?.byteLength ?? (combined.packedInstances
          ? combined.packedInstances.byteLength + combined.createGeometryResults.reduce((sum, item) => sum + item.packedData.byteLength, 0)
          : 0);
        const instances = Array.isArray(args[0]) ? args[0].length : combined.packedInstances?.[0] ?? 0;
        nativePacking.push({ method, durationMs, instances, bytes, attributes });
        if (method === 'unpackCombineGeometryResults')
          pendingAttributes = { geometry: geometries![0], start, attributes };
        return result;
      };
    }
    const createAttributeLocations = geometryPipeline.createAttributeLocations;
    geometryPipeline.createAttributeLocations = function (...args) {
      const result = createAttributeLocations.apply(this, args);
      // GeometryPrimitive packs every returned geometry before asking Native
      // for locations on the first one. Correlate the actual returned object,
      // including that async main-thread work outside Scene.render timings.
      if (phase === 'cold' && pendingAttributes?.geometry === args[0]) {
        nativePacking.push({ method: 'unpackAndAttributePacking', durationMs: performance.now() - pendingAttributes.start, instances: 0, bytes: 0, attributes: pendingAttributes.attributes });
        pendingAttributes = undefined;
      }
      return result;
    };
  }

  const coldStart = performance.now();
  if (renderer === 'cesium') {
    const cesium = await import('cesium');
    const { Cartesian3, Cartographic, SceneMode, SceneTransforms, Viewer: CesiumViewer, WebMercatorProjection } = cesium;
    const nativePipelines = cesium as unknown as { PrimitivePipeline: Record<string, Method>; GeometryPipeline: Record<string, Method> };
    observeNativePacking(nativePipelines.PrimitivePipeline, nativePipelines.GeometryPipeline);
    await import('cesium/Build/Cesium/Widgets/widgets.css');
    const { CesiumVectorTileset: Tileset } = await import('../../packages/cesium-vector-tileset/index');
    const projection = new WebMercatorProjection();
    viewer = new CesiumViewer('map', {
      baseLayer: false,
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      requestRenderMode: false,
      useBrowserRecommendedResolution: false,
      mapProjection: projection,
      sceneMode: SceneMode.SCENE2D,
      // Both contexts disable MSAA; antialiasing is handled by layer shaders.
      contextOptions: { webgl: { antialias: false } },
      msaaSamples: 1,
    });
    viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
    viewer.scene.debugShowFramesPerSecond = true;
    projectedBounds = () => {
      const center = viewer!.camera.position;
      const frustum = viewer!.camera.frustum as OrthographicOffCenterFrustum;
      return [[frustum.left, frustum.bottom], [frustum.right, frustum.top]].map(([x, y]) => {
        const point = projection.unproject(new Cartesian3(center.x + x, center.y + y, 0));
        return [point.longitude * 180 / Math.PI, point.latitude * 180 / Math.PI];
      });
    };
    project = (longitude, latitude) => {
      const point = SceneTransforms.worldToWindowCoordinates(viewer!.scene, Cartesian3.fromDegrees(longitude, latitude));
      if (!point)
        throw new Error('Cesium failed to project a reference landmark');
      return [point.x, point.y];
    };
    tileset = await Tileset.fromUrl(styleUrl, { requestRender: () => viewer?.scene.requestRender() });
    viewer.scene.primitives.add(tileset);
    const work = tileset as unknown as {
      _tilePublishQueue: object;
      _tileResidency: object;
      _sourceRenderSync: object;
      _styleEvaluation: object;
      _vectorRenderer: object;
      _sceneCollections: object;
      _symbolRenderer: object;
    };
    measure(viewer.scene, 'render', 'scene', true);
    measure(tileset, 'update', 'tileset');
    measure(work._tilePublishQueue, 'drain', 'publication');
    measure(work._sourceRenderSync, 'updateSource', 'source');
    measure(work._styleEvaluation, 'evaluate', 'style');
    measure(work._vectorRenderer, 'updatePaint', 'paint');
    measure(work._sceneCollections, 'pumpFirstUpdates', 'firstUploads');
    measure(work._sceneCollections, 'updateChildren', 'children');
    measure(work._symbolRenderer, 'update', 'placement');
    setPose = (pose) => {
      const position = projection.project(Cartographic.fromDegrees(pose.longitude, pose.latitude));
      const span = 2 * Math.PI * projection.ellipsoid.maximumRadius * innerWidth / (512 * 2 ** pose.zoom);
      viewer!.camera.setView({ destination: new Cartesian3(position.x, position.y, span), convert: false });
      const frustum = viewer!.camera.frustum as OrthographicOffCenterFrustum;
      frustum.right = span / 2;
      frustum.left = -span / 2;
      frustum.top = span * innerHeight / innerWidth / 2;
      frustum.bottom = -frustum.top;
    };
  }
  else {
    const { Map: ReferenceMap, setWorkerUrl } = await import('maplibre-gl');
    const { default: workerUrl } = await import('maplibre-gl/dist/maplibre-gl-worker.mjs?url');
    await import('maplibre-gl/dist/maplibre-gl.css');
    setWorkerUrl(workerUrl);
    map = new ReferenceMap({
      container: 'map',
      style: styleUrl,
      center: [origin.longitude, origin.latitude],
      zoom: origin.zoom,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      interactive: false,
      fadeDuration: 0,
      pixelRatio: devicePixelRatio,
      canvasContextAttributes: { antialias: false },
    });
    map.on('error', event => errors.push(event.error.message));
    map.repaint = true;
    project = (longitude, latitude) => {
      const point = map!.project([longitude, latitude]);
      return [point.x, point.y];
    };
    const work = map as unknown as { painter: object; style: object };
    measure(map, '_render', 'map', true);
    measure(work.painter, 'render', 'painter');
    await new Promise<void>(resolve => map!.once('load', () => resolve()));
    measure(work.style, 'update', 'style');
    measure(work.style, '_updateSources', 'source');
    measure(work.style, '_updatePlacement', 'placement');
    setPose = pose => map!.jumpTo({ center: [pose.longitude, pose.latitude], zoom: pose.zoom, pitch: 0, bearing: 0 });
  }

  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function move(pose: Pose) {
    const start = performance.now();
    setPose(pose);
    lastPose = pose;
    if (measuring)
      driverMs += performance.now() - start;
  }
  async function settle() {
    const deadline = performance.now() + 60_000;
    let stable = 0;
    while (stable < 12) {
      await nextFrame();
      const loaded = tileset ? tileset.tilesLoaded && viewer!.scene.globe.tilesLoaded : map!.loaded() && map!.areTilesLoaded();
      stable = loaded ? stable + 1 : 0;
      if (errors.length)
        throw new Error(errors.join('\n'));
      if (performance.now() > deadline)
        throw new Error(`${renderer} failed to settle`);
    }
  }
  function footprint() {
    if (projectedBounds)
      return projectedBounds();
    const bounds = map!.getBounds();
    return [bounds.getSouthWest().toArray(), bounds.getNorthEast().toArray()];
  }
  function resources() {
    if (measuring)
      throw new Error('Buffer snapshots must run outside measured frames');
    // Query the driver outside frame timings without disturbing render bindings.
    const copyReadBuffer = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      for (const [buffer, bytes] of bufferSizes) {
        gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
        const actualBytes = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE) as number;
        if (actualBytes !== bytes)
          throw new Error(`WebGL buffer capacity ledger mismatch: tracked ${bytes}, actual ${actualBytes}`);
      }
    }
    finally {
      gl.bindBuffer(gl.COPY_READ_BUFFER, copyReadBuffer);
    }
    const contextBytes = [...bufferSizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (contextBytes !== glCounts.bufferBytes)
      throw new Error('WebGL allocation ledger differs from the frame counter');
    if (tileset) {
      return {
        stats: tileset.stats(),
        zoom: (tileset as unknown as { _styleEvaluation: { zoom: number } })._styleEvaluation.zoom,
        buffers: performanceBufferSnapshot((tileset as unknown as { _vectorRenderer: object })._vectorRenderer, bufferSizes, textureUploads),
      };
    }
    const buffers = maplibreBufferSnapshot(map!, bufferSizes);
    const active = buffers.rows.filter(row => row.state === 'active');
    return {
      tiles: buffers.tiles.filter(tile => tile.state === 'active').length,
      buckets: active.length,
      layoutVertices: active.reduce((sum, row) => sum + row.vertices, 0),
      indexTriangles: active.reduce((sum, row) => sum + row.indexTriangles, 0),
      buffers,
      zoom: map!.getZoom(),
    };
  }

  move(origin);
  await settle();
  measuring = false;
  const cold = { phase, steps: frames.length, wallMs: performance.now() - coldStart, frames: [...frames], nativePacking: [...nativePacking] };
  phase = 'warm';
  const debug = gl!.getExtension('WEBGL_debug_renderer_info');
  const hardware = {
    renderer: debug ? gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl!.getParameter(gl!.RENDERER),
    vendor: debug ? gl!.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl!.getParameter(gl!.VENDOR),
    version: gl!.getParameter(gl!.VERSION),
    attributes: gl!.getContextAttributes(),
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    framebuffer: [gl!.drawingBufferWidth, gl!.drawingBufferHeight],
  };
  const initialFootprint = footprint();
  const projections = () => landmarks.map(([longitude, latitude]) => ({ geographic: [longitude, latitude], pixel: project(longitude, latitude) }));
  return {
    cold,
    hardware,
    errors,
    initialFootprint,
    async checkPose(progress: number) {
      move(poseAt(progress));
      await settle();
      return { pose: lastPose, footprint: footprint(), projections: projections(), resources: resources() };
    },
    async warm(steps = 360) {
      // Visit every measurement position, including the fast path's subset.
      // No module compilation, initial shaders, network or cold geometry loads
      // are included in the timings below.
      for (let step = 0; step <= steps; step++) {
        move(poseAt(step / steps));
        await nextFrame();
        if (step % 12 === 0)
          await settle();
      }
      await settle();
      move(origin);
      await settle();
      await new Promise<void>((resolve) => {
        capturePixels = true;
        captureComplete = resolve;
      });
      return { footprint: footprint(), projections: projections(), resources: resources(), bufferBytes: glCounts.bufferBytes, pixelEvidence };
    },
    async run(name: 'stationary' | 'slow' | 'fast', steps: number) {
      move(origin);
      await settle();
      frames.length = 0;
      driverMs = 0;
      phase = name;
      measuring = true;
      const start = performance.now();
      try {
        for (let step = 0; step < steps; step++) {
          if (name !== 'stationary')
            move(poseAt((step + 1) / steps));
          await nextFrame();
        }
      }
      finally {
        measuring = false;
      }
      const wallMs = performance.now() - start;
      return { phase: name, steps, wallMs, driverMs, frames: [...frames], pose: lastPose, footprint: footprint(), resources: resources() };
    },
    destroy() {
      viewer?.destroy();
      map?.remove();
    },
  };
}

declare global {
  interface Window { performanceMeasurement: Awaited<ReturnType<typeof createMeasurement>> }
}
void createMeasurement().then(measurement => window.performanceMeasurement = measurement);
