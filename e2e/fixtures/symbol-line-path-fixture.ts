import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, LineString } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Color, Matrix4, SceneMode, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { SymbolBucket } from '../../packages/cesium-vector-tileset/src/data/bucket-runtime';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const circumference = 2 * Math.PI * 6378137;
const fov = 36.875112943;
const height = 120;
const coordinate = (east: number, north: number): [number, number] => [east / circumference * 360, Math.atan(Math.sinh(north / 6378137)) * 180 / Math.PI];
const query = new URLSearchParams(location.search);
const scenario = query.get('scenario') ?? 'curve';
const keepUpright = query.get('upright') !== '0';
const offsetY = Number(query.get('offset') ?? 0);
if (!['curve', 'behind'].includes(scenario) || !Number.isFinite(offsetY))
  throw new Error('Invalid line path scenario');
const path: [number, number][] = scenario === 'behind'
  ? [[-250, 1700], [-50, 1700], [-50, 100]]
  : [[-160, 750], [-110, 800], [-30, 800], [-10, 850]];
if (!keepUpright)
  path.reverse();
let focus = scenario === 'behind' ? [-50, 1000] : [-80, 800];
const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { name: 'RIVER' }, geometry: { type: 'LineString', coordinates: path.map(([east, north]) => coordinate(east, north)) } }] };
function multiply(matrix: ArrayLike<number>, point: readonly number[]) {
  return Array.from({ length: 4 }, (_, row) => matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12] * point[3]);
}
const screen = (clip: number[]) => ({ x: (clip[0] / clip[3] + 1) * 320, y: (1 - clip[1] / clip[3]) * 360, w: clip[3], depth: clip[2] / clip[3] });
function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}
function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
  const location = gl.getUniformLocation(program, name);
  if (location)
    return gl.getUniform(program, location);
  const index = gl.getUniformIndices(program, [name])?.[0];
  if (index === undefined || index === gl.INVALID_INDEX)
    throw new Error(`Actual compiled symbol program lacks ${name}`);
  const active = gl.getActiveUniform(program, index)!;
  const block = gl.getActiveUniforms(program, [index], gl.UNIFORM_BLOCK_INDEX)[0] as number;
  const offset = gl.getActiveUniforms(program, [index], gl.UNIFORM_OFFSET)[0] as number;
  const binding = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_BINDING) as number;
  const buffer = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, binding) as WebGLBuffer | null;
  const length = active.type === gl.FLOAT_MAT4 ? 16 : active.type === gl.FLOAT_VEC4 ? 4 : active.type === gl.FLOAT_VEC3 ? 3 : active.type === gl.FLOAT_VEC2 ? 2 : active.type === gl.FLOAT ? 1 : 0;
  if (!buffer || block < 0 || !length)
    throw new Error(`Actual ${name} uniform block must be bound`);
  const start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, binding) as number;
  const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING) as WebGLBuffer | null;
  const value = new Float32Array(length);
  try {
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.getBufferSubData(gl.UNIFORM_BUFFER, start + offset, value);
  }
  finally {
    gl.bindBuffer(gl.UNIFORM_BUFFER, previous);
  }
  return value.length === 1 ? value[0] : value;
}
// Capture the actual linked VA while drawElements has it bound. The mutable
// worker arrays can already describe a different tile/placement generation.
function boundVertices(gl: WebGL2RenderingContext, program: WebGLProgram, count: number, type: number, offset: number) {
  const previous = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const buffers = new Map<WebGLBuffer, DataView>();
  const read = (buffer: WebGLBuffer, target: number) => {
    let data = buffers.get(buffer);
    if (!data) {
      gl.bindBuffer(target, buffer);
      const bytes = new Uint8Array(gl.getBufferParameter(target, gl.BUFFER_SIZE) as number);
      gl.getBufferSubData(target, 0, bytes);
      data = new DataView(bytes.buffer);
      buffers.set(buffer, data);
    }
    return data;
  };
  try {
    const indices = read(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer, gl.ELEMENT_ARRAY_BUFFER);
    const indexWidth = type === gl.UNSIGNED_SHORT ? 2 : type === gl.UNSIGNED_INT ? 4 : 1;
    const vertices = [...new Set(Array.from({ length: count }, (_, index) => indexWidth === 2 ? indices.getUint16(offset + index * 2, true) : indexWidth === 4 ? indices.getUint32(offset + index * 4, true) : indices.getUint8(offset + index)))].sort((a, b) => a - b);
    const attributes: Record<string, { location: number; components: number; type: number; normalized: boolean; stride: number; offset: number; bytes: number; values: number[][] }> = {};
    for (let index = 0; index < (gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number); index++) {
      const active = gl.getActiveAttrib(program, index)!;
      const location = gl.getAttribLocation(program, active.name);
      const components = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_SIZE) as number;
      const type = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE) as number;
      const normalized = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED) as boolean;
      const stride = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_STRIDE) as number;
      const offset = gl.getVertexAttribOffset(location, gl.VERTEX_ATTRIB_ARRAY_POINTER);
      const enabled = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
      const buffer = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
      const bytes = enabled && buffer ? read(buffer, gl.ARRAY_BUFFER) : undefined;
      const width = type === gl.FLOAT || type === gl.INT || type === gl.UNSIGNED_INT ? 4 : type === gl.SHORT || type === gl.UNSIGNED_SHORT ? 2 : 1;
      const constant = Array.from(gl.getVertexAttrib(location, gl.CURRENT_VERTEX_ATTRIB) as Float32Array);
      const values = vertices.map(vertex => Array.from({ length: components }, (_, component) => {
        if (!bytes)
          return constant[component];
        const position = offset + vertex * (stride || components * width) + component * width;
        if (position + width > bytes.byteLength)
          throw new Error(`Actual ${active.name} vertex ${vertex} exceeds its bound buffer`);
        return type === gl.FLOAT ? bytes.getFloat32(position, true) : type === gl.SHORT ? bytes.getInt16(position, true) : type === gl.UNSIGNED_SHORT ? bytes.getUint16(position, true) : type === gl.INT ? bytes.getInt32(position, true) : type === gl.UNSIGNED_INT ? bytes.getUint32(position, true) : type === gl.BYTE ? bytes.getInt8(position) : bytes.getUint8(position);
      }));
      attributes[active.name] = { location, components, type, normalized, stride, offset, bytes: bytes?.byteLength ?? 0, values };
    }
    return { vertices, attributes };
  }
  finally {
    gl.bindBuffer(gl.ARRAY_BUFFER, previous);
  }
}
type BoundVertices = ReturnType<typeof boundVertices>;
interface Draw { projection: number[]; coordinates: number[]; pitchWithMap: boolean; alongLine: boolean; size: number; fontScale: number; vao: BoundVertices; labels: Array<{ tileID: TileID; symbol: Placed; offsets: number[]; path: number[][]; cpuDynamic: number[][]; cpuProjection: number[] }> }
interface TileID { canonical: { z: number; x: number; y: number }; wrap: number; overscaledZ: number }
interface Placed { anchorX: number; anchorY: number; lineStartIndex: number; lineLength: number; numGlyphs: number; glyphStartIndex: number; vertexStartIndex: number; lineOffsetX: number; lineOffsetY: number; hidden: boolean }
interface Bucket { symbolInstances: { length: number }; glyphOffsetArray: { length: number; getoffsetX: (index: number) => number }; lineVertexArray: { getx: (index: number) => number; gety: (index: number) => number }; text: { hasVisibleVertices: boolean; placedSymbolArray: { length: number; get: (index: number) => Placed }; dynamicLayoutVertexArray: { float32: Float32Array }; dynamicLayoutVertexBuffer?: { buffer: WebGLBuffer } } }
interface Layer { layout: { get: (name: string) => unknown } }

async function createLinePath() {
  // Both actual workers download the public Liberty font. No local font
  // surrogate, copied glyph layout or Native shader becomes the oracle.
  const publicStyle = await fetch('https://tiles.openfreemap.org/styles/liberty').then(response => response.json()) as StyleSpecification;
  if (!publicStyle.glyphs)
    throw new Error('The public Liberty style must declare its glyph source');
  const style: StyleSpecification = {
    version: 8,
    glyphs: publicStyle.glyphs,
    transition: { duration: 0, delay: 0 },
    sources: { lines: { type: 'geojson', data, maxzoom: 13 } },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#000000' } }, {
      id: 'text',
      type: 'symbol',
      source: 'lines',
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 100000, 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 24, 'text-max-angle': 180, 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map', 'text-keep-upright': keepUpright, 'text-offset': [0, offsetY], 'text-padding': 0, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#ff0000', 'text-opacity': 1, 'text-halo-width': 0 },
    }],
  };
  setWorkerUrl(workerUrl);
  const viewer = new Viewer('cesium', { baseLayer: false, animation: false, baseLayerPicker: false, fullscreenButton: false, geocoder: false, homeButton: false, infoBox: false, navigationHelpButton: false, sceneModePicker: false, selectionIndicator: false, timeline: false, requestRenderMode: false, useBrowserRecommendedResolution: false, contextOptions: { webgl: { antialias: false } }, msaaSamples: 1, mapProjection: new WebMercatorProjection(), sceneMode: SceneMode.COLUMBUS_VIEW }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(style), center: coordinate(focus[0], focus[1]), zoom: 17, maxPitch: 180, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.on('error', event => errors.push(event.error.message));
  reference.setCenterClampedToGround(false);
  reference.setVerticalFieldOfView(fov);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  viewer.scene.primitives.add(tileset);
  await new Promise<void>(resolve => reference.once('load', () => resolve()));
  // A text worker chooses its own canonical anchor; it need not be the
  // nominal feature midpoint. Target that actual ground location before
  // the top positive control, without using glyph pixels or width feedback.
  const loadedStyle = (reference as unknown as { style: { getLayer: (id: string) => Layer; tileManagers: Record<string, { getVisibleCoordinates: (symbols: boolean) => TileID[]; getTile: (id: TileID) => { getBucket: (layer: Layer) => Bucket | undefined } }> } }).style;
  const loadedLayer = loadedStyle.getLayer('text');
  const manager = loadedStyle.tileManagers.lines;
  const anchors = manager.getVisibleCoordinates(true).flatMap((tileID) => {
    const bucket = manager.getTile(tileID).getBucket(loadedLayer);
    if (!bucket)
      return [];
    return Array.from({ length: bucket.text.placedSymbolArray.length }, (_, index) => {
      const symbol = bucket.text.placedSymbolArray.get(index);
      const scale = 2 ** tileID.canonical.z;
      return { glyphs: symbol.numGlyphs, east: ((tileID.canonical.x + symbol.anchorX / 8192) / scale + tileID.wrap - 0.5) * circumference, north: (0.5 - (tileID.canonical.y + symbol.anchorY / 8192) / scale) * circumference };
    });
  }).filter(anchor => anchor.glyphs >= 3).sort((a, b) => Math.hypot(a.east - focus[0], a.north - focus[1]) - Math.hypot(b.east - focus[0], b.north - focus[1]));
  if (!anchors[0])
    throw new Error('The real public-font worker must load a multi-glyph anchor');
  focus = [anchors[0].east, anchors[0].north];
  let nativePixels: Uint8Array = new Uint8Array();
  let referencePixels: Uint8Array = new Uint8Array();
  let nativeFrames = 0;
  let referenceFrames = 0;
  let nativeDraws = 0;
  let nativeGpuDraws: Array<{ vao: BoundVertices; uniforms: Record<string, number | boolean | number[]>; modelMatrix?: number[] }> = [];
  let pendingNativeGpuDraws: typeof nativeGpuDraws = [];
  let drawingNativeSymbol = false;
  let nativeModelMatrix: number[] | undefined;
  let draws: Draw[] = [];
  let pendingDraws: Draw[] = [];
  let changedAt = performance.now();
  let pose = { pitch: 0, heading: 0 };
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command, ...args) {
    drawingNativeSymbol = drawBatchForOwner(command.owner)?.kind === 'symbol';
    nativeModelMatrix = 'modelMatrix' in command && command.modelMatrix instanceof Matrix4 ? Array.from(command.modelMatrix) : undefined;
    if (drawingNativeSymbol)
      nativeDraws++;
    try {
      return originalDraw.call(this, command, ...args);
    }
    finally {
      drawingNativeSymbol = false;
    }
  };
  const nativeGl = viewer.scene.context._gl;
  const originalNativeElements = nativeGl.drawElements;
  nativeGl.drawElements = function (...args) {
    if (drawingNativeSymbol) {
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
      const uniforms: Record<string, number | boolean | number[]> = {};
      for (let index = 0; index < (this.getProgramParameter(program, this.ACTIVE_UNIFORMS) as number); index++) {
        const active = this.getActiveUniform(program, index)!;
        if (active.type === this.SAMPLER_2D || active.type === this.SAMPLER_CUBE)
          continue;
        const value = uniform(this, program, active.name) as number | boolean | Float32Array;
        uniforms[active.name] = typeof value === 'object' ? Array.from(value) : value;
      }
      pendingNativeGpuDraws.push({ vao: boundVertices(this, program, args[1], args[2], args[3]), uniforms, modelMatrix: nativeModelMatrix });
    }
    return originalNativeElements.call(this, ...args);
  };
  viewer.scene.preRender.addEventListener(() => nativeDraws = 0);
  viewer.scene.postRender.addEventListener(() => {
    nativePixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    nativeGpuDraws = pendingNativeGpuDraws;
    pendingNativeGpuDraws = [];
    nativeFrames++;
  });
  const gl = reference.getCanvas().getContext('webgl2')!;
  const originalElements = gl.drawElements;
  gl.drawElements = function (...args) {
    const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram | null;
    const location = program && this.getUniformLocation(program, 'u_is_along_line');
    if (program && location && this.getUniform(program, location)) {
      const size = uniform(this, program, 'u_size') as number;
      const transform = (reference as unknown as { _camera: { transform: { calculatePosMatrix: (id: TileID) => ArrayLike<number> } } })._camera.transform;
      const dynamicBuffer = this.getVertexAttrib(this.getAttribLocation(program, 'a_projected_pos'), this.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer;
      const labels = manager.getVisibleCoordinates(true).flatMap((tileID) => {
        const bucket = manager.getTile(tileID).getBucket(loadedLayer);
        if (bucket?.text.dynamicLayoutVertexBuffer?.buffer !== dynamicBuffer)
          return [];
        return Array.from({ length: bucket.text.placedSymbolArray.length }, (_, index) => {
          const placed = bucket.text.placedSymbolArray.get(index);
          const symbol: Placed = { anchorX: placed.anchorX, anchorY: placed.anchorY, lineStartIndex: placed.lineStartIndex, lineLength: placed.lineLength, numGlyphs: placed.numGlyphs, glyphStartIndex: placed.glyphStartIndex, vertexStartIndex: placed.vertexStartIndex, lineOffsetX: placed.lineOffsetX, lineOffsetY: placed.lineOffsetY, hidden: placed.hidden };
          return { tileID, symbol, offsets: Array.from({ length: symbol.numGlyphs }, (_, glyph) => bucket.glyphOffsetArray.getoffsetX(symbol.glyphStartIndex + glyph)), path: Array.from({ length: symbol.lineLength }, (_, vertex) => [bucket.lineVertexArray.getx(symbol.lineStartIndex + vertex), bucket.lineVertexArray.gety(symbol.lineStartIndex + vertex)]), cpuDynamic: Array.from({ length: symbol.numGlyphs }, (_, glyph) => Array.from(bucket.text.dynamicLayoutVertexArray.float32.subarray((symbol.vertexStartIndex + glyph * 4) * 3, (symbol.vertexStartIndex + glyph * 4) * 3 + 3))), cpuProjection: Array.from(transform.calculatePosMatrix(tileID)) };
        });
      });
      pendingDraws.push({ projection: Array.from(uniform(this, program, 'u_projection_matrix') as Float32Array), coordinates: Array.from(uniform(this, program, 'u_coord_matrix') as Float32Array), pitchWithMap: !!uniform(this, program, 'u_pitch_with_map'), alongLine: true, size, fontScale: size / 24, vao: boundVertices(this, program, args[1], args[2], args[3]), labels });
    }
    return originalElements.call(this, ...args);
  };
  reference.on('render', () => {
    referencePixels = new Uint8Array(640 * 720 * 4);
    gl.readPixels(0, 0, 640, 720, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    draws = pendingDraws;
    pendingDraws = [];
    referenceFrames++;
  });
  const entries = () => new Set([...tileset._symbolRenderer._tiles.values(), ...tileset._symbolRenderer._visibleEntries.values(), ...tileset._symbolRenderer._held.values()]);
  const setView = (pitch: number, heading: number) => {
    pose = { pitch, heading };
    changedAt = performance.now();
    const theta = heading * Math.PI / 180;
    const horizontal = height * Math.tan(pitch * Math.PI / 180);
    const east = focus[0] - Math.sin(theta) * horizontal;
    const north = focus[1] - Math.cos(theta) * horizontal;
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = 640 / 720;
    viewer.camera.setView({ destination: new Cartesian3(east, north, height), convert: false, orientation: { heading: theta, pitch: pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    reference.jumpTo({ center: [0, 0], elevation: 0, zoom: 17, pitch: 0, bearing: 0, roll: 0 });
    const lngLat = coordinate(east, north);
    const altitude = (height / circumference) / MercatorCoordinate.fromLngLat(lngLat, 1).z;
    reference.jumpTo(reference.calculateCameraOptionsFromCameraLngLatAltRotation(lngLat, altitude, heading, pitch, 0));
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  setView(0, 0);
  const coverage = (pixels: Uint8Array) => {
    let area = 0;
    const columns = Array.from<number>({ length: 640 }).fill(0);
    const rows = Array.from<number>({ length: 720 }).fill(0);
    let minX = 640;
    let maxX = -1;
    let minY = 720;
    let maxY = -1;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > pixels[index + 1] && pixels[index] > pixels[index + 2]) {
        const alpha = pixels[index] / 255;
        const x = index / 4 % 640;
        const y = 719 - Math.floor(index / 4 / 640);
        area += alpha;
        columns[x] += alpha;
        rows[y] += alpha;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return { area, columns, rows, bounds: maxX >= 0 ? { minX, maxX, minY, maxY } : undefined };
  };
  const readyState = () => {
    const pyramid = tileset._style.tilePyramids.lines;
    const nativeLayer = tileset._style.getLayer('text');
    const nativeTiles = pyramid?.getIds().map((id) => {
      const tile = pyramid.getTileByID(id)!;
      const bucket = nativeLayer && tile.getBucket(nativeLayer);
      return { id, tileID: tile.tileID, state: tile.state, symbolBucket: bucket instanceof SymbolBucket, symbols: bucket instanceof SymbolBucket ? bucket.symbolInstances.length : undefined, glyphs: bucket instanceof SymbolBucket ? Array.from({ length: bucket.text.placedSymbolArray.length }, (_, index) => bucket.text.placedSymbolArray.get(index).numGlyphs) : undefined };
    });
    const referenceTiles = manager.getVisibleCoordinates(true).map((tileID) => {
      const bucket = manager.getTile(tileID).getBucket(loadedLayer);
      return { tileID, symbols: bucket?.symbolInstances.length, glyphs: bucket && Array.from({ length: bucket.text.placedSymbolArray.length }, (_, index) => bucket.text.placedSymbolArray.get(index).numGlyphs) };
    });
    return { elapsed: performance.now() - changedAt, tilesLoaded: tileset.tilesLoaded, referenceLoaded: reference.loaded(), nativeFrames, referenceFrames, nativeDraws, referenceDraws: draws.length, nativeZoom: tileset._styleEvaluation.zoom, referenceZoom: reference.getZoom(), nativeTiles, referenceTiles, nativeGeometry: [...entries()].map(entry => ({ tileID: entry.input.tileID, batches: entry.batches.map(batch => ({ glyphs: batch.text?.instances.map(instance => instance.line?.glyphOffsets.length), instances: batch.text?.instances.length })) })), errors };
  };
  return {
    setView,
    readyState,
    ready: () => performance.now() - changedAt > 350 && tileset.tilesLoaded && reference.loaded() && nativeFrames > 20 && referenceFrames > 0 && [...entries()].some(entry => entry.batches.some(batch => batch.text?.instances.some(instance => instance.line && instance.line.glyphOffsets.length >= 3))),
    capture() {
      const transform = (reference as unknown as { _camera: { transform: { getCameraLngLat: () => { lng: number; lat: number }; getCameraAltitude: () => number; _pixelMatrix3D: number[]; coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number } } } })._camera.transform;
      const referenceLabels = draws.flatMap(draw => draw.labels.flatMap(({ tileID, symbol, offsets, path: tilePath, cpuDynamic, cpuProjection }) => {
        const scale = 2 ** tileID.canonical.z;
        const anchor = new MercatorCoordinate((tileID.canonical.x + symbol.anchorX / 8192) / scale + tileID.wrap, (tileID.canonical.y + symbol.anchorY / 8192) / scale);
        const expected = transform.coordinatePoint(anchor, 0, transform._pixelMatrix3D);
        const actualAnchor = screen(multiply(draw.projection, [symbol.anchorX, symbol.anchorY, 0, 1]));
        if (Math.hypot(actualAnchor.x - expected.x, actualAnchor.y - expected.y) >= 0.05)
          return [];
        const rows = draw.vao.vertices.map((vertex, index) => ({ vertex, index })).filter(({ vertex, index }) => vertex % 4 === 0 && draw.vao.attributes.a_pos_offset.values[index][0] === symbol.anchorX && draw.vao.attributes.a_pos_offset.values[index][1] === symbol.anchorY);
        if (rows.length !== symbol.numGlyphs)
          return [];
        const glyphs = Array.from({ length: symbol.numGlyphs }, (_, glyph) => {
          const row = rows[glyph].index;
          const dynamic = draw.vao.attributes.a_projected_pos.values[row];
          const label = multiply(draw.coordinates, [dynamic[0], dynamic[1], 0, 1]);
          const clip = multiply(draw.projection, [label[0], label[1], label[2], 1]);
          const corners = Array.from({ length: 4 }, (_, corner) => {
            const p = draw.vao.attributes.a_pos_offset.values[row + corner];
            const px = draw.vao.attributes.a_pixeloffset.values[row + corner];
            const x = p[2] / 32 * Math.max(px[2] / 256, draw.fontScale) + px[0] / 16;
            const y = p[3] / 32 * Math.max(px[3] / 256, draw.fontScale) + px[1] / 16;
            const cosine = Math.cos(dynamic[2]);
            const sine = Math.sin(dynamic[2]);
            const final = multiply(draw.coordinates, [dynamic[0] + cosine * x - sine * y, dynamic[1] + sine * x + cosine * y, 0, 1]);
            const projected = multiply(draw.projection, [final[0], final[1], final[2], 1]);
            return { clip: projected, screen: screen(projected) };
          });
          const fade = draw.vao.attributes.a_fade_opacity.values[row][0];
          const cpuClip = multiply(cpuProjection, [label[0], label[1], label[2], 1]);
          return { offset: offsets[glyph], dynamic, cpuDynamic: cpuDynamic[glyph], cpuClip, cpuScreen: screen(cpuClip), clip, screen: screen(clip), corners, fade };
        });
        const path = tilePath.map(([x, y]) => screen(multiply(draw.projection, [x, y, 0, 1])));
        const gpuVisible = glyphs.every(glyph => glyph.fade >>> 1 > 0 && glyph.dynamic.every(Number.isFinite) && glyph.corners.every(corner => corner.clip.every(Number.isFinite)));
        return [{ anchor, expected, glyphs, path, hidden: symbol.hidden, gpuVisible, draw, lineOffset: [symbol.lineOffsetX, symbol.lineOffsetY], precision: Math.SQRT2 / (scale * 8192) }];
      }));
      const matrix = Matrix4.multiply((viewer.camera.frustum as PerspectiveFrustum).projectionMatrix, viewer.camera.viewMatrix, new Matrix4());
      const nativeLabels = [...entries()].flatMap(entry => entry.batches.flatMap((batch) => {
        const geometry = batch.text;
        if (!geometry)
          return [];
        return geometry.instances.flatMap((instance) => {
          const line = instance.line;
          if (!line)
            return [];
          const location = viewer.scene.mapProjection.ellipsoid.cartesianToCartographic(new Cartesian3(line.anchorECEF.x, line.anchorECEF.y, line.anchorECEF.z))!;
          const anchor = MercatorCoordinate.fromLngLat({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI });
          const glyphs = Array.from(line.glyphOffsets, (offset, glyph) => {
            const base = (instance.vertexStart + glyph * 4) * 3;
            const world = new Cartesian3(geometry.positions[base], geometry.positions[base + 1], geometry.positions[base + 2]);
            const location = viewer.scene.mapProjection.ellipsoid.cartesianToCartographic(world)!;
            const projected = viewer.scene.mapProjection.project(location);
            const dynamic = Array.from(geometry.dynamics.subarray(base, base + 3));
            const clip = multiply(matrix, [projected.z, projected.x + dynamic[0], projected.y - dynamic[1], 1]);
            return { offset, dynamic, clip, screen: screen(clip) };
          });
          const path = Array.from({ length: line.pathECEF.length / 3 }, (_, vertex) => {
            const world = new Cartesian3(line.pathECEF[vertex * 3], line.pathECEF[vertex * 3 + 1], line.pathECEF[vertex * 3 + 2]);
            const location = viewer.scene.mapProjection.ellipsoid.cartesianToCartographic(world)!;
            const projected = viewer.scene.mapProjection.project(location);
            return screen(multiply(matrix, [projected.z, projected.x, projected.y, 1]));
          });
          return [{ tile: entry.input.tileId, anchor, glyphs, path, opacity: geometry.opacities[instance.vertexStart], mapPitch: geometry.mapPitch, lineOffsetX: line.lineOffsetX }];
        });
      }));
      const nominal = MercatorCoordinate.fromLngLat(coordinate(focus[0], focus[1]));
      const referenceLabel = referenceLabels.filter(label => label.gpuVisible && label.glyphs.length >= 3).sort((a, b) => Math.hypot(a.anchor.x - nominal.x, a.anchor.y - nominal.y) - Math.hypot(b.anchor.x - nominal.x, b.anchor.y - nominal.y))[0];
      const nativeLabel = referenceLabel && nativeLabels.sort((a, b) => Math.hypot(a.anchor.x - referenceLabel.anchor.x, a.anchor.y - referenceLabel.anchor.y) - Math.hypot(b.anchor.x - referenceLabel.anchor.x, b.anchor.y - referenceLabel.anchor.y))[0];
      const referencePosition = MercatorCoordinate.fromLngLat(transform.getCameraLngLat());
      referencePosition.z = MercatorCoordinate.fromLngLat(reference.getCenter(), transform.getCameraAltitude()).z;
      const camera = viewer.camera.positionWC;
      const nativeCoverage = coverage(nativePixels);
      const referenceCoverage = coverage(referencePixels);
      return { scenario, keepUpright, offsetY, pose, errors, readyState: readyState(), sourceLoaded: reference.querySourceFeatures('lines').some(feature => feature.properties.name === 'RIVER'), native: nativeLabel, reference: referenceLabel, nativeLabels, referenceLabels, draws, nativeDraws, nativeGpuDraws, nativeCoverage, referenceCoverage, nativeArea: nativeCoverage.area, referenceArea: referenceCoverage.area, glyphSource: publicStyle.glyphs, camera: { nativePosition: { x: 0.5 + camera.y / circumference, y: 0.5 - camera.z / circumference, z: camera.x / circumference }, referencePosition, nativePitch: 90 + viewer.camera.pitch * 180 / Math.PI, pitch: reference.getPitch(), nativeHeading: viewer.camera.heading * 180 / Math.PI, heading: reference.getBearing(), nativeFov: (viewer.camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI, fov: reference.getVerticalFieldOfView(), nativeDistance: tileset._sceneCovering.cameraFrame?.cameraToCenterDistance, nativeZoom: tileset._styleEvaluation.zoom, referenceZoom: reference.getZoom() }, gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(gl) } };
    },
  };
}
declare global { interface Window { symbolLinePath: Awaited<ReturnType<typeof createLinePath>> } }
void createLinePath().then(value => window.symbolLinePath = value);
