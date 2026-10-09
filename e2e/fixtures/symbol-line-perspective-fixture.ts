import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, LineString } from 'geojson';
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
const sdf = new URLSearchParams(location.search).get('sdf') === '1';
const requestedAlignment = new URLSearchParams(location.search).get('alignment') ?? 'viewport';
if (!['viewport', 'map', 'auto'].includes(requestedAlignment))
  throw new Error('Unknown pitch alignment');
const alignment = requestedAlignment as 'viewport' | 'map' | 'auto';
// Keep every pitched anchor in the same canonical source row. At maxzoom 13
// these finite paths fit the icon but end before getAnchors' fixed initial
// offset, so MapLibre's short-line midpoint fallback supplies one anchor.
// This avoids mistaking a nominal feature midpoint for the real worker anchor.
// The former 3300m far path lay beyond MapLibre's p75 ground far plane
// (actual clip z/w=1.000119), although Native's frustum still included it.
const points = [{ id: 'near', x: -144, y: 800, length: 120 }, { id: 'mid', x: -450, y: 2500, length: 240 }, { id: 'far', x: 500, y: 3000, length: 260 }];
const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features: points.map((point, index) => ({ type: 'Feature', id: index + 1, properties: { name: point.id }, geometry: { type: 'LineString', coordinates: [coordinate(point.x - point.length / 2, point.y), coordinate(point.x + point.length / 2, point.y)] } })) };
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { lines: { type: 'geojson', data, maxzoom: 13 } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'icons', type: 'symbol', source: 'lines', layout: { 'symbol-placement': 'line', 'symbol-spacing': 100000, 'icon-image': 'square', 'icon-size': 1, 'icon-pitch-alignment': alignment, 'icon-rotation-alignment': 'map', 'icon-padding': 0, 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': 1, 'icon-color': '#ff0000', 'icon-halo-width': 0 } },
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
        const final = multiply(coordinates, [d[0] + cosine * x - sine * y, d[1] + sine * x + cosine * y, 0, 1]);
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
  const x0 = Math.floor(center.x - 110);
  const x1 = Math.ceil(center.x + 110);
  const y0 = Math.floor(center.y - 40);
  const y1 = Math.ceil(center.y + 40);
  let area = 0;
  let count = 0;
  let supportClipped = false;
  const rows = new Map<number, number>();
  const columns: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let alpha = 0;
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
        continue;
      const index = ((canvas.height - 1 - y) * canvas.width + x) * 4;
      if (pixels[index] > pixels[index + 1] && pixels[index] > pixels[index + 2]) {
        const coverage = pixels[index] / 255;
        if (x === x0 || x === x1 || y === y0 || y === y1)
          supportClipped = true;
        alpha += coverage;
        rows.set(y, (rows.get(y) ?? 0) + coverage);
        count++;
      }
    }
    area += alpha;
    columns.push(alpha);
  }
  let components = 0;
  for (let index = 0; index < columns.length; index++) {
    if (columns[index] > 0.1 && (index === 0 || columns[index - 1] <= 0.1))
      components++;
  }
  return { alphaEquivalentSide: Math.sqrt(area), horizontalIntegral: area / Math.max(...columns, 1e-12), verticalIntegral: area / Math.max(...rows.values(), 1e-12), area, count, components, columns, bounds: { x0, x1, y0, y1 }, supportClipped, bounded: x0 > 0 && y0 > 0 && x1 < canvas.width && y1 < canvas.height && !supportClipped };
}
async function createLinePerspective() {
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
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      // Synthetic signed distance to a 4px circle, with the official SDF
      // contour at 192/256. Both engines consume this same public image.
      const alpha = Math.max(0, Math.min(255, Math.round(192 + (4 - Math.hypot(x + 0.5 - 8, y + 0.5 - 8)) * 32)));
      image.data.set(sdf ? [255, 255, 255, alpha] : [255, 0, 0, 255], (y * 16 + x) * 4);
    }
  }
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
  let referenceDraws: Array<{ alongLine: boolean; pitchWithMap: boolean }> = [];
  let pendingReferenceDraws: Array<{ alongLine: boolean; pitchWithMap: boolean }> = [];
  let referenceQuads: DrawQuad[] = [];
  let pendingReferenceQuads: DrawQuad[] = [];
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
    if (program && alongLineLocation && pitchLocation) {
      pendingReferenceDraws.push({ alongLine: !!this.getUniform(program, alongLineLocation), pitchWithMap: !!this.getUniform(program, pitchLocation) });
      if (this.getUniform(program, alongLineLocation))
        pendingReferenceQuads.push(...drawnReferenceQuads(this, program, args[1], args[2], args[3]));
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
    referenceQuads = pendingReferenceQuads;
    pendingReferenceQuads = [];
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
    viewer.camera.setView({ destination: new Cartesian3(x, y, height), convert: false, orientation: { heading: 0, pitch: pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    reference.jumpTo({ center: [0, 0], elevation: 0, zoom: 14, pitch: 0, bearing: 0, roll: 0 });
    const lngLat = coordinate(x, y);
    const altitude = (height / circumference) / MercatorCoordinate.fromLngLat(lngLat, 1).z;
    reference.jumpTo(reference.calculateCameraOptionsFromCameraLngLatAltRotation(lngLat, altitude, 0, pitch, 0));
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    draws = 0;
    drawnTiles.clear();
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  setView(0);
  return {
    setView,
    // tilesLoaded alone can precede the first symbol command after a pose
    // change. Qualify the last captured frame's actual draw, never its pixels.
    ready: () => performance.now() - changedAt > 350 && tileset.tilesLoaded && reference.loaded() && nativeFrames > 20 && referenceFrames > 0 && draws > 0 && drawnTiles.size > 0 && referenceDraws.length > 0 && !!nativePixels && !!referencePixels,
    capture() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both renderers must draw');
      const transform = (reference as unknown as { _camera: { transform: { getCameraLngLat: () => { lng: number; lat: number }; getCameraAltitude: () => number; _pixelMatrix3D: number[]; _viewProjMatrix: number[]; cameraToCenterDistance: number; worldSize: number; coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number } } } })._camera.transform;
      const referencePosition = MercatorCoordinate.fromLngLat(transform.getCameraLngLat());
      referencePosition.z = MercatorCoordinate.fromLngLat(reference.getCenter(), transform.getCameraAltitude()).z;
      const actualNative = viewer.camera.positionWC;
      const nativePosition = { x: 0.5 + actualNative.y / circumference, y: 0.5 - actualNative.z / circumference, z: actualNative.x / circumference };
      const loaded = reference.querySourceFeatures('lines').map(feature => String(feature.properties.name));
      // Read the actual draw inputs: no shader copy, synthesized glyph anchor,
      // or pixel-driven calibration participates in the reference.
      interface TileID { canonical: { z: number; x: number; y: number }; wrap: number }
      interface Placed { anchorX: number; anchorY: number; lineLength: number; numGlyphs: number; vertexStartIndex: number; glyphStartIndex: number; lineOffsetX: number; lineOffsetY: number; hidden: boolean }
      interface Bucket { sdfIcons: boolean; glyphOffsetArray?: { length: number; getoffsetX: (index: number) => number }; icon: { hasVisibleVertices: boolean; placedSymbolArray: { length: number; get: (index: number) => Placed }; dynamicLayoutVertexArray: { float32: Float32Array } }; lineVertexArray: { length: number } }
      interface Layer { layout: { get: (name: string) => unknown } }
      const actualStyle = (reference as unknown as { style: { getLayer: (id: string) => Layer; tileManagers: Record<string, { getVisibleCoordinates: (symbols: boolean) => TileID[]; getTile: (id: TileID) => { getBucket: (layer: Layer) => Bucket | undefined } }> } }).style;
      const layer = actualStyle.getLayer('icons');
      const manager = actualStyle.tileManagers.lines;
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
          const quad = referenceQuads.find(({ anchor }) => Math.hypot((anchor[0] / anchor[3] + 1) * reference.getCanvas().width / 2 - expected.x, (1 - anchor[1] / anchor[3]) * reference.getCanvas().height / 2 - expected.y) < 0.01);
          return { position, expected, dynamic, w, depth, corners: quad?.corners, sdf: bucket.sdfIcons, hidden: symbol.hidden, glyphOffset: glyphOffsets.getoffsetX(symbol.glyphStartIndex), lineOffset: [symbol.lineOffsetX, symbol.lineOffsetY], glyphs: symbol.numGlyphs, lineLength: symbol.lineLength, lineVertexCount: bucket.lineVertexArray.length, hasVisibleVertices: bucket.icon.hasVisibleVertices, precision: Math.SQRT2 / (scale * 8192), shaderRatio: Math.max(0, Math.min(4, 0.5 + 0.5 * distanceRatio)) };
        });
      });
      const viewProjection = Matrix4.multiply((viewer.camera.frustum as PerspectiveFrustum).projectionMatrix, viewer.camera.viewMatrix, new Matrix4());
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
              const distance = tileset._sceneCovering.cameraFrame?.cameraToCenterDistance;
              if (!distance)
                throw new Error('Actual Native symbol camera distance must exist');
              const ratio = Math.max(0, Math.min(4, 0.5 + 0.5 * (geometry.mapPitch ? w / distance : distance / w)));
              const size = Math.floor(geometry.sizes[instance.vertexStart] / 4) / 128 * (geometry.sizePerspective ? ratio : 1);
              const metresPerPixel = circumference / (512 * 2 ** tileset._styleEvaluation.zoom);
              const corners = Array.from({ length: 4 }, (_, corner) => {
                const vertex = instance.vertexStart + corner;
                const x = geometry.offsets[vertex * 2] * Math.max(size, geometry.minfontscales[vertex * 2]) + geometry.pxoffsets[vertex * 2];
                const y = geometry.offsets[vertex * 2 + 1] * Math.max(size, geometry.minfontscales[vertex * 2 + 1]) + geometry.pxoffsets[vertex * 2 + 1];
                const east = Math.cos(dynamic[2]) * x - Math.sin(dynamic[2]) * y;
                const south = Math.sin(dynamic[2]) * x + Math.cos(dynamic[2]) * y;
                const clip = multiply(viewProjection, [projected.z, projected.x, projected.y, 1]);
                if (geometry.mapPitch)
                  return multiply(viewProjection, [projected.z, projected.x + dynamic[0] + east * metresPerPixel, projected.y - dynamic[1] - south * metresPerPixel, 1]);
                clip[0] += (east + dynamic[0]) / viewer.canvas.width * w * 2;
                clip[1] -= (south + dynamic[1]) / viewer.canvas.height * w * 2;
                return clip;
              });
              return { drawnTile: entry.input.tileId, position, center: { x: center.x + dynamic[0], y: center.y + dynamic[1] }, dynamic, w, corners, opacity: geometry.opacities[instance.vertexStart], lineLength: line?.pathECEF.length ?? 0, glyphs: line?.glyphOffsets.length ?? 0, alongLine: !!line, pointPerspective: geometry.viewportPerspective, sdf: geometry.sdf, vertexSdf: Math.floor(geometry.sizes[instance.vertexStart] / 2) % 2 === 1, precision: Math.SQRT2 / (2 ** tile.z * 8192) };
            })
          : []);
      });
      const pointRows = points.map((point) => {
        const position = MercatorCoordinate.fromLngLat(coordinate(point.x, point.y));
        const distance = (anchor: { position: { x: number; y: number } }) => Math.hypot(anchor.position.x - position.x, anchor.position.y - position.y);
        const native = nativeAnchors.filter(anchor => distance(anchor) <= anchor.precision).sort((a, b) => distance(a) - distance(b))[0];
        const selectedReference = referenceAnchors.filter(anchor => distance(anchor) <= anchor.precision && !anchor.hidden).sort((a, b) => distance(a) - distance(b))[0];
        return {
          ...point,
          sourceLoaded: loaded.includes(point.id),
          native: native && { ...native, pixels: measure(viewer.canvas, nativePixels!, native.center) },
          reference: selectedReference && { ...selectedReference, pixels: measure(reference.getCanvas(), referencePixels!, selectedReference.expected) },
        };
      });
      return {
        pitch,
        sdf,
        referenceImageSdf: reference.getImage('square').sdf,
        errors,
        alignment,
        resolvedAlignment: layer.layout.get('icon-pitch-alignment'),
        resolvedRotation: (layer.layout.get('icon-rotation-alignment') as { constantOr: (fallback: string) => string }).constantOr('viewport'),
        referenceOverlap: reference.getLayoutProperty('icons', 'icon-allow-overlap'),
        loaded,
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
declare global { interface Window { symbolLinePerspective: Awaited<ReturnType<typeof createLinePerspective>> } }
void createLinePerspective().then(value => window.symbolLinePerspective = value);
