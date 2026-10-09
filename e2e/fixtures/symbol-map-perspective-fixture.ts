import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, Point } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Color, Matrix4, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const circumference = 2 * Math.PI * 6378137;
const fov = 36.875112943;
const height = 120;
const coordinate = (x: number, y: number): [number, number] => [x / circumference * 360, Math.atan(Math.sinh(y / 6378137)) * 180 / Math.PI];
const requestedRotation = new URLSearchParams(location.search).get('rotation') ?? 'map';
if (!['map', 'viewport'].includes(requestedRotation))
  throw new Error('Unknown point rotation alignment');
const rotation = requestedRotation as 'map' | 'viewport';
const requestedBearing = Number(new URLSearchParams(location.search).get('bearing') ?? 0);
if (![0, 35].includes(requestedBearing))
  throw new Error('Unknown point camera bearing');
const sdf = false;
const alignment = 'map';
const angle = requestedBearing * Math.PI / 180;
const points = [{ id: 'near', x: -144, y: 800 }, { id: 'mid', x: -450, y: 2500 }, { id: 'far', x: 500, y: 3000 }].map(point => ({ ...point, x: point.x * Math.cos(angle) + point.y * Math.sin(angle), y: -point.x * Math.sin(angle) + point.y * Math.cos(angle) }));
const data: FeatureCollection<Point> = { type: 'FeatureCollection', features: points.map((point, index) => ({ type: 'Feature', id: index + 1, properties: { name: point.id }, geometry: { type: 'Point', coordinates: coordinate(point.x, point.y) } })) };
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { points: { type: 'geojson', data, maxzoom: 13 } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'icons', type: 'symbol', source: 'points', layout: { 'symbol-placement': 'point', 'icon-image': 'square', 'icon-size': 1, 'icon-pitch-alignment': alignment, 'icon-rotation-alignment': rotation, 'icon-padding': 0, 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': 1, 'icon-color': '#ff0000', 'icon-halo-width': 0 } },
  ],
};
function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}
function multiply(matrix: ArrayLike<number>, point: readonly number[]) {
  return Array.from({ length: 4 }, (_, row) => matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12] * point[3]);
}
interface DrawQuad { anchor: number[]; corners: number[][] }
// Read the real bound vertex buffers and public GL uniforms. This evaluates
// the installed MapLibre program's coordinate transforms, not a Native shader
// copy or a pixel-calibrated reference.
function drawnReferenceQuads(gl: WebGL2RenderingContext, program: WebGLProgram, count: number, indexType: number, indexOffset: number): DrawQuad[] {
  const uniform = (name: string) => {
    const location = gl.getUniformLocation(program, name);
    if (location)
      return gl.getUniform(program, location);
    // Current MapLibre puts projection and frame values in std140 UBOs.
    // Query the linked program's actual block, byte offset and binding;
    // getUniformLocation intentionally returns null for block members.
    const indices = gl.getUniformIndices(program, [name]);
    const index = indices?.[0];
    if (index === undefined || index === gl.INVALID_INDEX)
      throw new Error(`Actual MapLibre linked program lacks active ${name}`);
    const active = gl.getActiveUniform(program, index);
    const block = gl.getActiveUniforms(program, [index], gl.UNIFORM_BLOCK_INDEX)[0] as number;
    const offset = gl.getActiveUniforms(program, [index], gl.UNIFORM_OFFSET)[0] as number;
    if (!active || block < 0 || (active.type !== gl.FLOAT && active.type !== gl.FLOAT_MAT4))
      throw new Error(`Unexpected actual uniform block member ${name}`);
    const binding = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_BINDING) as number;
    const buffer = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, binding) as WebGLBuffer | null;
    if (!buffer)
      throw new Error(`Actual uniform block for ${name} is unbound`);
    const start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, binding) as number;
    const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING) as WebGLBuffer | null;
    const value = new Float32Array(active.type === gl.FLOAT_MAT4 ? 16 : 1);
    try {
      gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
      gl.getBufferSubData(gl.UNIFORM_BUFFER, start + offset, value);
    }
    finally {
      gl.bindBuffer(gl.UNIFORM_BUFFER, previous);
    }
    return value.length === 1 ? value[0] : value;
  };
  const projection = uniform('u_projection_matrix') as Float32Array;
  const coordinates = uniform('u_coord_matrix') as Float32Array;
  const labelPlane = uniform('u_label_plane_matrix') as Float32Array;
  const pitchWithMap = !!uniform('u_pitch_with_map');
  const size = uniform('u_size') as number;
  const distance = uniform('u_camera_to_center_distance') as number;
  const isOffset = !!uniform('u_is_offset');
  const buffers = new Map<WebGLBuffer, DataView>();
  const binding = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const read = (buffer: WebGLBuffer, target: number) => {
    const cached = buffers.get(buffer);
    if (cached)
      return cached;
    gl.bindBuffer(target, buffer);
    const bytes = new Uint8Array(gl.getBufferParameter(target, gl.BUFFER_SIZE) as number);
    gl.getBufferSubData(target, 0, bytes);
    const view = new DataView(bytes.buffer);
    buffers.set(buffer, view);
    return view;
  };
  const attribute = (name: string) => {
    const location = gl.getAttribLocation(program, name);
    if (location < 0)
      throw new Error(`Actual MapLibre symbol program lacks ${name}`);
    const components = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_SIZE) as number;
    const type = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE) as number;
    const stride = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_STRIDE) as number;
    const offset = gl.getVertexAttribOffset(location, gl.VERTEX_ATTRIB_ARRAY_POINTER);
    const buffer = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer;
    const bytes = read(buffer, gl.ARRAY_BUFFER);
    const width = type === gl.FLOAT ? 4 : 2;
    if (type !== gl.FLOAT && type !== gl.SHORT && type !== gl.UNSIGNED_SHORT)
      throw new Error(`Unexpected actual symbol attribute type ${type}`);
    return (vertex: number) => Array.from({ length: components }, (_, component) => {
      const position = offset + vertex * (stride || components * width) + component * width;
      return type === gl.FLOAT ? bytes.getFloat32(position, true) : type === gl.SHORT ? bytes.getInt16(position, true) : bytes.getUint16(position, true);
    });
  };
  try {
    const position = attribute('a_pos_offset');
    const dynamic = attribute('a_projected_pos');
    const pixel = attribute('a_pixeloffset');
    const indexBuffer = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer;
    const indices = read(indexBuffer, gl.ELEMENT_ARRAY_BUFFER);
    const starts = new Set<number>();
    const indexWidth = indexType === gl.UNSIGNED_SHORT ? 2 : 4;
    if (indexType !== gl.UNSIGNED_SHORT && indexType !== gl.UNSIGNED_INT)
      throw new Error('Unexpected actual symbol index type');
    for (let index = 0; index < count; index++) {
      const vertex = indexWidth === 2 ? indices.getUint16(indexOffset + index * 2, true) : indices.getUint32(indexOffset + index * 4, true);
      starts.add(Math.floor(vertex / 4) * 4);
    }
    return [...starts].map((start) => {
      const anchorPosition = position(start);
      const anchor = multiply(projection, [anchorPosition[0], anchorPosition[1], 0, 1]);
      const ratio = Math.max(0, Math.min(4, 0.5 + 0.5 * (pitchWithMap ? anchor[3] / distance : distance / anchor[3])));
      const effectiveSize = size * (isOffset ? 1 : ratio);
      const corners = Array.from({ length: 4 }, (_, corner) => {
        const p = position(start + corner);
        const d = dynamic(start + corner);
        const px = pixel(start + corner);
        const x = p[2] / 32 * Math.max(px[2] / 256, effectiveSize) + px[0] / 16;
        const y = p[3] / 32 * Math.max(px[3] / 256, effectiveSize) + px[1] / 16;
        const cosine = Math.cos(d[2]);
        const sine = Math.sin(d[2]);
        const label = multiply(labelPlane, [d[0], d[1], 0, 1]);
        const final = multiply(coordinates, [label[0] / label[3] + cosine * x - sine * y, label[1] / label[3] + sine * x + cosine * y, label[2] / label[3], 1]);
        return pitchWithMap ? multiply(projection, [final[0], final[1], final[2], 1]) : final;
      });
      return { anchor, corners };
    });
  }
  finally {
    gl.bindBuffer(gl.ARRAY_BUFFER, binding);
  }
}
function measure(canvas: HTMLCanvasElement, pixels: Uint8Array, center: { x: number; y: number }) {
  const radiusX = 110;
  const radiusY = 40;
  const width = radiusX * 2 + 1;
  const rows = Array.from<number>({ length: radiusY * 2 + 1 }).fill(0);
  const columns = Array.from<number>({ length: width }).fill(0);
  const alpha: number[] = [];
  let area = 0;
  let supportClipped = false;
  const coverage = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
      return 0;
    const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
    return pixels[offset] > pixels[offset + 1] && pixels[offset] > pixels[offset + 2] ? pixels[offset] / 255 : 0;
  };
  const left = Math.floor(center.x);
  const top = Math.floor(center.y);
  const fractionX = center.x - left;
  const fractionY = center.y - top;
  for (let y = -radiusY; y <= radiusY; y++) {
    for (let x = -radiusX; x <= radiusX; x++) {
      // Sample both actual masks on the same anchor-relative pixel grid.
      // Bilinear resampling accounts for real worker anchor subpixel phase;
      // it does not scale either mask or infer a width from its area.
      const value = coverage(left + x, top + y) * (1 - fractionX) * (1 - fractionY)
        + coverage(left + x + 1, top + y) * fractionX * (1 - fractionY)
        + coverage(left + x, top + y + 1) * (1 - fractionX) * fractionY
        + coverage(left + x + 1, top + y + 1) * fractionX * fractionY;
      alpha.push(value);
      rows[y + radiusY] += value;
      columns[x + radiusX] += value;
      area += value;
      if (value > 0 && (Math.abs(x) === radiusX || Math.abs(y) === radiusY))
        supportClipped = true;
    }
  }
  const bounds = { x0: center.x - radiusX - 1, x1: center.x + radiusX + 1, y0: center.y - radiusY - 1, y1: center.y + radiusY + 1 };
  return {
    width: area / Math.max(...columns, 1e-12),
    height: area / Math.max(...rows, 1e-12),
    area,
    rows,
    columns,
    alpha,
    grid: [width, rows.length],
    bounds,
    supportClipped,
    bounded: bounds.x0 > 0 && bounds.y0 > 0 && bounds.x1 < canvas.width && bounds.y1 < canvas.height && !supportClipped,
  };
}
async function createMapPerspective() {
  setWorkerUrl(workerUrl);
  const viewer = new Viewer('cesium', {
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
    contextOptions: { webgl: { antialias: false } },
    msaaSamples: 1,
    mapProjection: new WebMercatorProjection(),
    sceneMode: SceneMode.COLUMBUS_VIEW,
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(style), center: [0, 0], zoom: 14, pitch: 75, maxPitch: 180, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.on('error', event => errors.push(event.error.message));
  reference.setCenterClampedToGround(false);
  reference.setVerticalFieldOfView(fov);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  const image = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
  for (let index = 0; index < image.data.length; index += 4)
    image.data.set([255, 0, 0, 255], index);
  tileset.addImage('square', image, { pixelRatio: 1, sdf });
  viewer.scene.primitives.add(tileset);
  await new Promise<void>(resolve => reference.once('load', () => {
    reference.addImage('square', image, { pixelRatio: 1, sdf });
    resolve();
  }));
  let nativePixels: Uint8Array | undefined;
  let referencePixels: Uint8Array | undefined;
  let nativeFrames = 0;
  let referenceFrames = 0;
  let referenceDraws: Array<{ alongLine: boolean; pitchWithMap: boolean; rotateSymbol: boolean; quads: DrawQuad[] }> = [];
  let pendingReferenceDraws: typeof referenceDraws = [];
  let draws = 0;
  const drawnTiles = new Set<string>();
  let pitch = 75;
  let changedAt = performance.now();
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command, ...args) {
    const batch = drawBatchForOwner(command.owner);
    if (batch?.kind === 'symbol') {
      draws++;
      if (batch.tileId)
        drawnTiles.add(batch.tileId);
    }
    return originalDraw.call(this, command, ...args);
  };
  viewer.scene.preRender.addEventListener(() => {
    draws = 0;
    drawnTiles.clear();
  });
  viewer.scene.postRender.addEventListener(() => {
    nativePixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    nativeFrames++;
  });
  const referenceGl = reference.getCanvas().getContext('webgl2')!;
  const originalElements = referenceGl.drawElements;
  referenceGl.drawElements = function (...args) {
    const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram | null;
    const alongLineLocation = program && this.getUniformLocation(program, 'u_is_along_line');
    const pitchLocation = program && this.getUniformLocation(program, 'u_pitch_with_map');
    const rotationLocation = program && this.getUniformLocation(program, 'u_rotate_symbol');
    if (program && alongLineLocation && pitchLocation && rotationLocation) {
      pendingReferenceDraws.push({ alongLine: !!this.getUniform(program, alongLineLocation), pitchWithMap: !!this.getUniform(program, pitchLocation), rotateSymbol: !!this.getUniform(program, rotationLocation), quads: drawnReferenceQuads(this, program, args[1], args[2], args[3]) });
    }
    return originalElements.call(this, ...args);
  };
  reference.on('render', () => {
    const canvas = reference.getCanvas();
    const gl = canvas.getContext('webgl2')!;
    referencePixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    referenceDraws = pendingReferenceDraws;
    pendingReferenceDraws = [];
    referenceFrames++;
  });
  const setView = (value: number) => {
    changedAt = performance.now();
    pitch = value;
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    const x = pitch === 0 ? points[0].x : 0;
    const y = pitch === 0 ? points[0].y : 0;
    const bearing = pitch === 0 ? 0 : requestedBearing;
    viewer.camera.setView({ destination: new Cartesian3(x, y, height), convert: false, orientation: { heading: bearing * Math.PI / 180, pitch: pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    reference.jumpTo({ center: [0, 0], elevation: 0, zoom: 14, pitch: 0, bearing: 0, roll: 0 });
    const lngLat = coordinate(x, y);
    const altitude = (height / circumference) / MercatorCoordinate.fromLngLat(lngLat, 1).z;
    reference.jumpTo(reference.calculateCameraOptionsFromCameraLngLatAltRotation(lngLat, altitude, bearing, pitch, 0));
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  setView(0);
  return {
    setView,
    ready: () => performance.now() - changedAt > 350 && tileset.tilesLoaded && reference.loaded() && nativeFrames > 20 && referenceFrames > 0 && !!nativePixels && !!referencePixels,
    capture() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both renderers must draw');
      const transform = (reference as unknown as { _camera: { transform: { getCameraLngLat: () => { lng: number; lat: number }; getCameraAltitude: () => number; _pixelMatrix3D: number[]; _viewProjMatrix: number[]; cameraToCenterDistance: number; worldSize: number; coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number } } } })._camera.transform;
      const referencePosition = MercatorCoordinate.fromLngLat(transform.getCameraLngLat());
      referencePosition.z = MercatorCoordinate.fromLngLat(reference.getCenter(), transform.getCameraAltitude()).z;
      const actualNative = viewer.camera.positionWC;
      const nativePosition = { x: 0.5 + actualNative.y / circumference, y: 0.5 - actualNative.z / circumference, z: actualNative.x / circumference };
      const sourceFeatures = reference.querySourceFeatures('points');
      const loaded = sourceFeatures.map(feature => String(feature.properties.name));
      // Read the actual draw inputs: no shader copy, synthesized glyph anchor,
      // or pixel-driven calibration participates in the reference.
      interface TileID { canonical: { z: number; x: number; y: number }; wrap: number }
      interface Placed { anchorX: number; anchorY: number; lineLength: number; numGlyphs: number; vertexStartIndex: number; glyphStartIndex: number; lineOffsetX: number; lineOffsetY: number; hidden: boolean }
      interface Bucket { sdfIcons: boolean; glyphOffsetArray?: { length: number; getoffsetX: (index: number) => number }; icon: { hasVisibleVertices: boolean; placedSymbolArray: { length: number; get: (index: number) => Placed }; dynamicLayoutVertexArray: { float32: Float32Array } }; lineVertexArray: { length: number } }
      interface Layer { layout: { get: (name: string) => unknown } }
      const actualStyle = (reference as unknown as { style: { getLayer: (id: string) => Layer; tileManagers: Record<string, { getVisibleCoordinates: (symbols: boolean) => TileID[]; getTile: (id: TileID) => { getBucket: (layer: Layer) => Bucket | undefined } }> } }).style;
      const layer = actualStyle.getLayer('icons');
      const manager = actualStyle.tileManagers.points;
      const referenceAnchors = manager.getVisibleCoordinates(true).flatMap((tileID) => {
        const bucket = manager.getTile(tileID).getBucket(layer);
        if (!bucket)
          return [];
        const glyphOffsets = bucket.glyphOffsetArray;
        if (!glyphOffsets || typeof glyphOffsets.getoffsetX !== 'function')
          throw new Error('Actual MapLibre symbol bucket must expose its glyph offset array');
        return Array.from({ length: bucket.icon.placedSymbolArray.length }, (_, index) => {
          const symbol = bucket.icon.placedSymbolArray.get(index);
          if (symbol.glyphStartIndex < 0 || symbol.glyphStartIndex + symbol.numGlyphs > glyphOffsets.length)
            throw new Error('Actual MapLibre placed symbol must reference valid glyph offsets');
          const scale = 2 ** tileID.canonical.z;
          const position = new MercatorCoordinate((tileID.canonical.x + symbol.anchorX / 8192) / scale + tileID.wrap, (tileID.canonical.y + symbol.anchorY / 8192) / scale);
          const expected = transform.coordinatePoint(position, 0, transform._pixelMatrix3D);
          const offset = symbol.vertexStartIndex * 3;
          const dynamic = Array.from(bucket.icon.dynamicLayoutVertexArray.float32.subarray(offset, offset + 3));
          const m = transform._viewProjMatrix;
          const wx = position.x * transform.worldSize;
          const wy = position.y * transform.worldSize;
          const w = m[3] * wx + m[7] * wy + m[15];
          const depth = (m[2] * wx + m[6] * wy + m[14]) / w;
          const distanceRatio = layer.layout.get('icon-pitch-alignment') === 'map' ? w / transform.cameraToCenterDistance : transform.cameraToCenterDistance / w;
          return { position, expected, dynamic, w, wMeters: w / transform.worldSize * circumference, depth, sdf: bucket.sdfIcons, hidden: symbol.hidden, glyphOffset: glyphOffsets.getoffsetX(symbol.glyphStartIndex), lineOffset: [symbol.lineOffsetX, symbol.lineOffsetY], glyphs: symbol.numGlyphs, lineLength: symbol.lineLength, lineVertexCount: bucket.lineVertexArray.length, hasVisibleVertices: bucket.icon.hasVisibleVertices, precision: Math.SQRT2 / (scale * 8192), shaderRatio: Math.max(0, Math.min(4, 0.5 + 0.5 * distanceRatio)) };
        });
      });
      const viewProjection = Matrix4.multiply((viewer.camera.frustum as PerspectiveFrustum).projectionMatrix, viewer.camera.viewMatrix, new Matrix4());
      const eye = viewer.camera.viewMatrix;
      const normalized = (x: number, y: number) => {
        const length = Math.hypot(x, y);
        return length < 1e-9 ? [0, 0] : [x / length, y / length];
      };
      const viewportEast = normalized(eye[9], eye[5]);
      const viewportSouth = normalized(eye[8], eye[4]);
      const nativeEntries = new Set([...tileset._symbolRenderer._tiles.values(), ...tileset._symbolRenderer._visibleEntries.values(), ...tileset._symbolRenderer._held.values()]);
      const nativeAnchors = [...nativeEntries].filter(entry => drawnTiles.has(entry.input.tileId)).flatMap((entry) => {
        const tile = 'canonical' in entry.input.tileID ? entry.input.tileID.canonical : entry.input.tileID;
        return entry.batches.flatMap(batch => batch.icon
          ? batch.icon.instances.map((instance) => {
              const geometry = batch.icon!;
              const line = instance.line;
              const base = instance.vertexStart * 3;
              const world = new Cartesian3(geometry.positions[base], geometry.positions[base + 1], geometry.positions[base + 2]);
              const location = viewer.scene.mapProjection.ellipsoid.cartesianToCartographic(world)!;
              const position = MercatorCoordinate.fromLngLat({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI });
              const projected = viewer.scene.mapProjection.project(location);
              const center = SceneTransforms.worldToWindowCoordinates(viewer.scene, world)!;
              const dynamic = Array.from(geometry.dynamics.subarray(base, base + 3));
              const w = viewProjection[3] * projected.z + viewProjection[7] * projected.x + viewProjection[11] * projected.y + viewProjection[15];
              const clip = multiply(viewProjection, [projected.z, projected.x, projected.y, 1]);
              const distance = tileset._sceneCovering.cameraFrame?.cameraToCenterDistance;
              if (!distance)
                throw new Error('Actual Native camera focus distance is required');
              const ratio = geometry.sizePerspective ? Math.min(4, 0.5 + 0.5 * (geometry.mapPitch ? w / distance : geometry.viewportPerspective ? distance / w : 1)) : 1;
              const mpp = circumference / (512 * 2 ** tileset._styleEvaluation.zoom);
              const clipCorners = Array.from({ length: instance.vertexCount }, (_, corner) => {
                const vertex = instance.vertexStart + corner;
                const size = Math.floor(geometry.sizes[vertex] / 4) / 128 * ratio;
                const x = geometry.offsets[vertex * 2] * Math.max(geometry.minfontscales[vertex * 2], size) + geometry.pxoffsets[vertex * 2];
                const y = geometry.offsets[vertex * 2 + 1] * Math.max(geometry.minfontscales[vertex * 2 + 1], size) + geometry.pxoffsets[vertex * 2 + 1];
                if (!geometry.mapPitch)
                  return [clip[0] + x / viewer.canvas.width * w * 2, clip[1] - y / viewer.canvas.height * w * 2, clip[2], w];
                const east = geometry.pointMapRotation === 'viewport' ? viewportEast : [1, 0];
                const south = geometry.pointMapRotation === 'viewport' ? viewportSouth : [0, 1];
                return multiply(viewProjection, [projected.z, projected.x + (east[0] * x + south[0] * y) * mpp, projected.y - (east[1] * x + south[1] * y) * mpp, 1]);
              });
              return { drawnTile: entry.input.tileId, position, center: { x: center.x + dynamic[0], y: center.y + dynamic[1] }, dynamic, w, clipCorners, opacity: geometry.opacities[instance.vertexStart], lineLength: line?.pathECEF.length ?? 0, glyphs: line?.glyphOffsets.length ?? 0, alongLine: !!line, pointPerspective: geometry.viewportPerspective, mapPitch: geometry.mapPitch, pointMapRotation: geometry.pointMapRotation, sdf: geometry.sdf, vertexSdf: Math.floor(geometry.sizes[instance.vertexStart] / 2) % 2 === 1, precision: Math.SQRT2 / (2 ** tile.z * 8192) };
            })
          : []);
      });
      const pointRows = points.map((point) => {
        const position = MercatorCoordinate.fromLngLat(coordinate(point.x, point.y));
        const distance = (anchor: { position: { x: number; y: number } }) => Math.hypot(anchor.position.x - position.x, anchor.position.y - position.y);
        const native = nativeAnchors.filter(anchor => distance(anchor) <= anchor.precision && anchor.opacity > 0).sort((a, b) => distance(a) - distance(b))[0];
        const selectedReference = referenceAnchors.filter(anchor => distance(anchor) <= anchor.precision && !anchor.hidden).sort((a, b) => distance(a) - distance(b))[0];
        const drawnReference = selectedReference && referenceDraws.flatMap(draw => draw.quads).find((quad) => {
          const sx = (quad.anchor[0] / quad.anchor[3] + 1) * reference.getCanvas().width * 0.5;
          const sy = (1 - quad.anchor[1] / quad.anchor[3]) * reference.getCanvas().height * 0.5;
          return Math.hypot(sx - selectedReference.expected.x, sy - selectedReference.expected.y) < 0.01;
        });
        return {
          ...point,
          sourceLoaded: loaded.includes(point.id),
          native: native && { ...native, pixels: measure(viewer.canvas, nativePixels!, native.center) },
          reference: selectedReference && { ...selectedReference, clipCorners: drawnReference?.corners, pixels: measure(reference.getCanvas(), referencePixels!, selectedReference.expected) },
        };
      });
      return {
        pitch,
        sdf,
        referenceImageSdf: reference.getImage('square').sdf,
        errors,
        alignment,
        rotation,
        requestedBearing,
        tilesLoaded: tileset.tilesLoaded,
        resolvedAlignment: layer.layout.get('icon-pitch-alignment'),
        resolvedRotation: (layer.layout.get('icon-rotation-alignment') as { constantOr: (fallback: string) => string }).constantOr('viewport'),
        referenceOverlap: reference.getLayoutProperty('icons', 'icon-allow-overlap'),
        loaded,
        sourceGeometryTypes: sourceFeatures.map(feature => feature.geometry.type),
        nativeAnchors,
        referenceAnchors,
        referenceDraws,
        draws,
        drawnTiles: [...drawnTiles],
        camera: { nativeDistance: tileset._sceneCovering.cameraFrame?.cameraToCenterDistance, nativeZoom: tileset._styleEvaluation.zoom, referenceDistance: transform.cameraToCenterDistance / transform.worldSize * circumference, nativePosition, referencePosition, pitch: reference.getPitch(), nativePitch: 90 + viewer.camera.pitch * 180 / Math.PI, fov: reference.getVerticalFieldOfView(), nativeFov: (viewer.camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI, bearing: reference.getBearing(), roll: reference.getRoll(), nativeHeading: viewer.camera.heading, nativeRoll: viewer.camera.roll, elevation: reference.getCenterElevation(), zoom: reference.getZoom() },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(reference.getCanvas().getContext('webgl2')!) },
        viewport: { native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight], reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight] },
        points: pointRows,
      };
    },
  };
}
declare global { interface Window { symbolMapPerspective: Awaited<ReturnType<typeof createMapPerspective>> } }
void createMapPerspective().then(value => window.symbolMapPerspective = value);
