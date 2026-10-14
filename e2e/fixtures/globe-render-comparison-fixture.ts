import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian2, Cartesian3, Cartesian4, Color, EllipsoidTerrainProvider, IntersectionTests, Matrix4, Ray, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { CircleCollection } from '../../packages/cesium-vector-tileset/src/render/circle/circle-collection';
import { cameraZoom } from '../../packages/cesium-vector-tileset/src/render/scene/covering';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const radius = 6378137;
const circumference = 2 * Math.PI * radius;
const zoom = Number(new URLSearchParams(location.search).get('zoom') ?? 14);
if (zoom !== 11 && zoom !== 14)
  throw new Error('The comparison uses a city-scale or native automatic globe zoom');
const geometryScale = 2 ** (14 - zoom);
const fov = 45;
const mode = new URLSearchParams(location.search).get('projection') ?? 'vertical-perspective';
if (mode !== 'globe' && mode !== 'vertical-perspective')
  throw new Error('The comparison requires a supported public globe projection');
const pureGlobe = mode === 'vertical-perspective' || zoom === 11;
const occlusion = new URLSearchParams(location.search).has('occlusion');
// Opt-in diagnostic: linking a feedback varying can change driver optimization.
// The test compares this page's pixels with an uninstrumented page before using
// its vertex evidence. The normal rendering acceptance never changes its link.
const feedbackEnabled = new URLSearchParams(location.search).has('tf');
if (feedbackEnabled) {
  const link = WebGL2RenderingContext.prototype.linkProgram;
  WebGL2RenderingContext.prototype.linkProgram = function (program) {
    this.transformFeedbackVaryings(program, ['gl_Position'], this.INTERLEAVED_ATTRIBS);
    return link.call(this, program);
  };
}

interface VertexFeedback {
  kind: string;
  mode: number;
  indices: number[];
  first: number;
  clip: number[];
  attributes: Record<string, { size: number; type: number; normalized: boolean; values: number[] }>;
  uniforms: Record<string, number | number[]>;
  errors: number[];
}

// Replay the *actual* linked program while its VAO, textures and uniform blocks
// are still bound. GLES disallows indexed draws during feedback, so the replay
// uses POINTS over the actual index range, preserving every gl_VertexID. It
// discards rasterization and restores the feedback state before the real draw.
function vertexFeedback(gl: WebGL2RenderingContext, kind: string, mode: number, indices: number[]): VertexFeedback {
  const first = Math.min(...indices);
  const count = Math.max(...indices) - first + 1;
  const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
  if (feedbackEnabled && gl.getTransformFeedbackVarying(program, 0)?.name !== 'gl_Position')
    throw new Error('The actual linked program must capture gl_Position');
  const attributes: VertexFeedback['attributes'] = {};
  const uniforms: VertexFeedback['uniforms'] = {};
  const arrayBinding = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const uniformBinding = gl.getParameter(gl.UNIFORM_BUFFER_BINDING) as WebGLBuffer | null;
  const feedbackBinding = gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING) as WebGLTransformFeedback | null;
  const feedbackBuffer = gl.getParameter(gl.TRANSFORM_FEEDBACK_BUFFER_BINDING) as WebGLBuffer | null;
  const discarded = gl.isEnabled(gl.RASTERIZER_DISCARD);
  const buffer = feedbackEnabled ? gl.createBuffer() : null;
  const feedback = feedbackEnabled ? gl.createTransformFeedback() : null;
  const clip = new Float32Array(feedbackEnabled ? count * 4 : 0);
  try {
    for (let index = 0; index < (gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number); index++) {
      const attribute = gl.getActiveAttrib(program, index)!;
      const location = gl.getAttribLocation(program, attribute.name);
      const binding = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
      if (!binding || !gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_ENABLED))
        continue;
      if (gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_DIVISOR) !== 0)
        throw new Error('The geometry probe requires non-instanced actual vertices');
      const size = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_SIZE) as number;
      const type = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE) as number;
      const bytes = type === gl.BYTE || type === gl.UNSIGNED_BYTE ? 1 : type === gl.SHORT || type === gl.UNSIGNED_SHORT ? 2 : 4;
      const stride = (gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_STRIDE) as number) || size * bytes;
      const offset = gl.getVertexAttribOffset(location, gl.VERTEX_ATTRIB_ARRAY_POINTER);
      const data = new Uint8Array((count - 1) * stride + size * bytes);
      gl.bindBuffer(gl.ARRAY_BUFFER, binding);
      gl.getBufferSubData(gl.ARRAY_BUFFER, offset + first * stride, data);
      const view = new DataView(data.buffer);
      const values: number[] = [];
      for (let vertex = 0; vertex < count; vertex++) {
        for (let component = 0; component < size; component++) {
          const at = vertex * stride + component * bytes;
          values.push(type === gl.FLOAT
            ? view.getFloat32(at, true)
            : type === gl.INT
              ? view.getInt32(at, true)
              : type === gl.UNSIGNED_INT
                ? view.getUint32(at, true)
                : type === gl.SHORT
                  ? view.getInt16(at, true)
                  : type === gl.UNSIGNED_SHORT
                    ? view.getUint16(at, true)
                    : type === gl.BYTE ? view.getInt8(at) : view.getUint8(at));
        }
      }
      attributes[attribute.name] = { size, type, normalized: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED) as boolean, values };
    }
    for (let index = 0; index < (gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number); index++) {
      const uniform = gl.getActiveUniform(program, index)!;
      const location = gl.getUniformLocation(program, uniform.name);
      if (location) {
        const value = gl.getUniform(program, location) as number | boolean | ArrayLike<number>;
        uniforms[uniform.name] = typeof value === 'object' ? Array.from(value) : Number(value);
      }
    }
    // Record the bound std140 data verbatim, including projection matrices and
    // tile coordinates. The replay itself uses the original indexed bindings.
    for (let block = 0; block < (gl.getProgramParameter(program, gl.ACTIVE_UNIFORM_BLOCKS) as number); block++) {
      const binding = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_BINDING) as number;
      const bound = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, binding) as WebGLBuffer | null;
      if (!bound)
        throw new Error('Actual program has an unbound uniform block');
      const start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, binding) as number;
      const size = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_DATA_SIZE) as number;
      const data = new Float32Array(size / 4);
      gl.bindBuffer(gl.UNIFORM_BUFFER, bound);
      gl.getBufferSubData(gl.UNIFORM_BUFFER, start, data);
      uniforms[`block:${gl.getActiveUniformBlockName(program, block)}`] = Array.from(data);
      const members = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES) as Uint32Array;
      for (const index of members) {
        const uniform = gl.getActiveUniform(program, index)!;
        const offset = gl.getActiveUniforms(program, [index], gl.UNIFORM_OFFSET)[0] as number;
        const components = uniform.type === gl.FLOAT_MAT4 ? 16 : uniform.type === gl.FLOAT_VEC4 ? 4 : uniform.type === gl.FLOAT_VEC3 ? 3 : uniform.type === gl.FLOAT_VEC2 ? 2 : 1;
        const values = Array.from(data.subarray(offset / 4, offset / 4 + components));
        uniforms[uniform.name] = components === 1 ? values[0] : values;
      }
    }
    if (feedbackEnabled) {
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
      gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, clip.byteLength, gl.STREAM_READ);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      WebGL2RenderingContext.prototype.drawArrays.call(gl, gl.POINTS, first, count);
      gl.endTransformFeedback();
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, clip);
    }
  }
  finally {
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedbackBinding);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, feedbackBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, arrayBinding);
    gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBinding);
    if (!discarded)
      gl.disable(gl.RASTERIZER_DISCARD);
    gl.deleteTransformFeedback(feedback);
    gl.deleteBuffer(buffer);
  }
  const errors: number[] = [];
  for (let error = gl.getError(); error !== gl.NO_ERROR; error = gl.getError())
    errors.push(error);
  return { kind, mode, indices, first, clip: Array.from(clip), attributes, uniforms, errors };
}

function indexedVertices(gl: WebGL2RenderingContext, count: number, type: number, offset: number): number[] {
  const data = type === gl.UNSIGNED_INT ? new Uint32Array(count) : type === gl.UNSIGNED_SHORT ? new Uint16Array(count) : new Uint8Array(count);
  gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, data);
  const restart = type === gl.UNSIGNED_INT ? 0xFFFFFFFF : type === gl.UNSIGNED_SHORT ? 0xFFFF : 0xFF;
  return Array.from(data).filter(value => value !== restart);
}

interface ScreenVertex { x: number; y: number }
function bounds(vertices: ScreenVertex[]) {
  const left = Math.min(...vertices.map(vertex => vertex.x));
  const right = Math.max(...vertices.map(vertex => vertex.x));
  const top = Math.min(...vertices.map(vertex => vertex.y));
  const bottom = Math.max(...vertices.map(vertex => vertex.y));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}
function convexHull(vertices: ScreenVertex[]): ScreenVertex[] {
  const sorted = [...vertices].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: ScreenVertex, b: ScreenVertex, c: ScreenVertex) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (points: ScreenVertex[]) => {
    const result: ScreenVertex[] = [];
    for (const point of points) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], point) <= 0)
        result.pop();
      result.push(point);
    }
    result.pop();
    return result;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}
function hullCoverage(vertices: ScreenVertex[], grid: number[]): number[] {
  const hull = convexHull(vertices);
  const [x0, y0, width, height] = grid;
  return Array.from({ length: width * height }, (_, index) => {
    const x = x0 + index % width + 0.5;
    const y = y0 + Math.floor(index / width) + 0.5;
    let inside = false;
    for (let a = 0, b = hull.length - 1; a < hull.length; b = a++) {
      const start = hull[a];
      const end = hull[b];
      if ((start.y > y) !== (end.y > y) && x < (end.x - start.x) * (y - start.y) / (end.y - start.y) + start.x)
        inside = !inside;
    }
    return Number(inside);
  });
}
function uniform(geometry: VertexFeedback, name: string): number | number[] {
  const entry = Object.entries(geometry.uniforms).find(([key]) => key === name || key.endsWith(`.${name}`));
  if (!entry)
    throw new Error(`The actual extrusion program is missing ${name}`);
  return entry[1];
}
const coordinate = (x: number, y: number): [number, number] => [x * geometryScale / radius * 180 / Math.PI, Math.atan(Math.sinh(y * geometryScale / radius)) * 180 / Math.PI];
const landmarks = [
  { id: 'line', color: 'red' as const, coordinate: coordinate(-610, 0) },
  { id: 'circle', color: 'green' as const, coordinate: coordinate(-220, 0) },
  { id: 'extrusion', color: 'blue' as const, coordinate: coordinate(210, 0) },
  { id: 'symbol', color: 'white' as const, coordinate: coordinate(620, 0) },
];
// Same finite geometry in both real workers. All centers are on the equator:
// the WGS84 and spherical ground coordinates coincide after radius normalization.
// This controls the model difference without moving features to match pixels.
const data: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: [coordinate(-750, 0), coordinate(-470, 0)] } },
    { type: 'Feature', properties: { kind: 'occlusion' }, geometry: { type: 'LineString', coordinates: [coordinate(210, -200), coordinate(210, 200)] } },
    { type: 'Feature', properties: { kind: 'circle' }, geometry: { type: 'Point', coordinates: landmarks[1].coordinate } },
    { type: 'Feature', properties: { kind: 'building' }, geometry: { type: 'Polygon', coordinates: [[coordinate(170, -40), coordinate(250, -40), coordinate(250, 40), coordinate(170, 40), coordinate(170, -40)]] } },
    { type: 'Feature', properties: { kind: 'symbol' }, geometry: { type: 'Point', coordinates: landmarks[3].coordinate } },
  ],
};
const style: StyleSpecification = {
  version: 8,
  projection: { type: mode },
  transition: { duration: 0, delay: 0 },
  light: { anchor: 'map', intensity: 0 },
  sources: { features: { type: 'geojson', data, maxzoom: 14 } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'buildings', type: 'fill-extrusion', source: 'features', filter: ['==', 'kind', 'building'], paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 80 * geometryScale, 'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': false } },
    // The line crossing the building is drawn later: a covered sample therefore
    // tests real geometric depth, rather than only painter-order overdraw.
    { id: 'lines', type: 'line', source: 'features', filter: occlusion ? ['in', 'kind', 'line', 'occlusion'] : ['==', 'kind', 'line'], layout: { 'line-cap': 'butt', 'line-join': 'miter' }, paint: { 'line-color': '#ff0000', 'line-width': 14, 'line-blur': 0 } },
    { id: 'circles', type: 'circle', source: 'features', filter: ['==', 'kind', 'circle'], paint: { 'circle-color': '#00ff00', 'circle-radius': 16, 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map', 'circle-blur': 0 } },
    { id: 'icons', type: 'symbol', source: 'features', filter: ['==', 'kind', 'symbol'], layout: { 'icon-image': 'square', 'icon-size': 1, 'icon-pitch-alignment': 'map', 'icon-rotation-alignment': 'map', 'icon-padding': 0, 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': 1 } },
  ],
};

interface ReferenceTransform {
  cameraPosition: ArrayLike<number>;
  projectionMatrix: ArrayLike<number>;
  modelViewProjectionMatrix: ArrayLike<number>;
  cameraToCenterDistance: number;
  worldSize: number;
  getCameraLngLat: () => { lng: number; lat: number };
  getCameraAltitude: () => number;
  isGlobeRendering?: boolean;
}
interface ReferenceDraw { kind: string; globeShader: boolean; transition?: number }
function gpu(gl: WebGL2RenderingContext): string {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}
// Read the linked program's actual uniform or std140 member. A declared
// style projection alone does not establish which GPU branch rendered.
function projectionTransition(gl: WebGL2RenderingContext, program: WebGLProgram): number | undefined {
  const name = 'u_projection_transition';
  const location = gl.getUniformLocation(program, name);
  if (location)
    return gl.getUniform(program, location) as number;
  const index = gl.getUniformIndices(program, [name])?.[0];
  if (index === undefined || index === gl.INVALID_INDEX)
    return undefined;
  const block = gl.getActiveUniforms(program, [index], gl.UNIFORM_BLOCK_INDEX)[0] as number;
  if (block < 0)
    return undefined;
  const offset = gl.getActiveUniforms(program, [index], gl.UNIFORM_OFFSET)[0] as number;
  const binding = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_BINDING) as number;
  const buffer = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, binding) as WebGLBuffer | null;
  if (!buffer)
    throw new Error('Actual globe projection block is unbound');
  const start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, binding) as number;
  const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING) as WebGLBuffer | null;
  const value = new Float32Array(1);
  try {
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.getBufferSubData(gl.UNIFORM_BUFFER, start + offset, value);
  }
  finally {
    gl.bindBuffer(gl.UNIFORM_BUFFER, previous);
  }
  return value[0];
}
function pixelColor(pixels: Uint8Array, canvas: HTMLCanvasElement, x: number, y: number): number[] {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
    return [0, 0, 0];
  const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
  return Array.from(pixels.subarray(offset, offset + 3));
}
function measure(canvas: HTMLCanvasElement, pixels: Uint8Array, center: { x: number; y: number }, color: typeof landmarks[number]['color']) {
  const x0 = Math.floor(center.x) - 48;
  const y0 = Math.floor(center.y) - 48;
  const alpha: number[] = [];
  const columns = new Float64Array(97);
  const rows = new Float64Array(97);
  let area = 0;
  let touchesEdge = false;
  for (let y = 0; y < 97; y++) {
    for (let x = 0; x < 97; x++) {
      const [r, g, b] = pixelColor(pixels, canvas, x0 + x, y0 + y);
      const value = color === 'red'
        ? Math.max(0, r - Math.max(g, b)) / 255
        : color === 'green'
          ? Math.max(0, g - Math.max(r, b)) / 255
          : color === 'white'
            ? Math.min(r, g, b) / 255
            // Lighting is a different contract; only the geometric coverage
            // of the opaque extrusion is measured by its exclusive blue mask.
            : Number(b > r + 20 && b > g + 20);
      alpha.push(value);
      columns[x] = Math.max(columns[x], value);
      rows[y] = Math.max(rows[y], value);
      area += value;
      touchesEdge ||= value > 0.02 && (x === 0 || y === 0 || x === 96 || y === 96);
    }
  }
  return { grid: [x0, y0, 97, 97], area, width: columns.reduce((a, b) => a + b, 0), height: rows.reduce((a, b) => a + b, 0), bounded: !touchesEdge && x0 > 0 && y0 > 0 && x0 + 97 < canvas.width && y0 + 97 < canvas.height, alpha };
}

async function createComparison() {
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
    sceneMode: pureGlobe ? SceneMode.SCENE3D : SceneMode.COLUMBUS_VIEW,
    mapProjection: new WebMercatorProjection(),
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(style), center: [0, 0], zoom, pitch: 0, maxPitch: 85, bearing: 0, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.setVerticalFieldOfView(fov);
  reference.on('error', event => errors.push(event.error.message));
  const image = { width: 24, height: 24, data: new Uint8Array(24 * 24 * 4).fill(255) };
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  tileset.addImage('square', image, { pixelRatio: 1 });
  viewer.scene.primitives.add(tileset);
  await new Promise<void>(resolve => reference.once('load', () => resolve()));
  reference.addImage('square', image, { pixelRatio: 1, sdf: false });
  const transform = () => (reference as unknown as { _camera: { transform: ReferenceTransform } })._camera.transform;
  const gl = reference.getCanvas().getContext('webgl2')!;
  let nativePixels: Uint8Array | undefined;
  let referencePixels: Uint8Array | undefined;
  let nativeFrames = 0;
  let referenceFrames = 0;
  let changedAt = performance.now();
  let referenceDraws: ReferenceDraw[] = [];
  let nativeKinds = new Set<string>();
  let nativeDraws: Array<{ kind: string; layerId: string }> = [];
  let nativeGeometry: VertexFeedback[] = [];
  let referenceGeometry: VertexFeedback[] = [];
  let nativeGeometryComplete = false;
  let referenceGeometryComplete = false;
  let nativeDrawingKind: string | undefined;
  let deletedNativeBuffers = 0;
  const nativeGl = viewer.scene.context._gl;
  const deleteBuffer = nativeGl.deleteBuffer;
  nativeGl.deleteBuffer = function (buffer) {
    if (buffer)
      deletedNativeBuffers++;
    return deleteBuffer.call(this, buffer);
  };
  const shaderKinds = new WeakMap<WebGLProgram, { kind: string; globeShader: boolean }>();
  const originalDraw = gl.drawElements;
  gl.drawElements = function (...args) {
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    let detail = shaderKinds.get(program);
    if (!detail) {
      const sources = (gl.getAttachedShaders(program) ?? []).map(shader => gl.getShaderSource(shader) ?? '').join('\n');
      const kind = gl.getAttribLocation(program, 'a_normal_ed') >= 0
        ? 'extrusion'
        : gl.getAttribLocation(program, 'a_pos_offset') >= 0
          ? 'symbol'
          : gl.getAttribLocation(program, 'a_data') >= 0
            ? 'line'
            : sources.includes('vec2 circle_center') ? 'circle' : 'other';
      detail = { kind, globeShader: /^\s*#define\s+GLOBE\b/m.test(sources) };
      shaderKinds.set(program, detail);
    }
    referenceDraws.push({ ...detail, transition: projectionTransition(gl, program) });
    if (!referenceGeometryComplete && (feedbackEnabled ? detail.kind !== 'other' : detail.kind === 'extrusion') && reference.loaded() && performance.now() - changedAt > 400)
      referenceGeometry.push(vertexFeedback(gl, detail.kind, args[0], indexedVertices(gl, args[1], args[2], args[3])));
    return originalDraw.apply(this, args);
  };
  reference.on('render', () => {
    const canvas = reference.getCanvas();
    referencePixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    referenceFrames++;
    referenceGeometryComplete = new Set(referenceGeometry.map(value => value.kind)).size === (feedbackEnabled ? 4 : 1);
    if (!referenceGeometryComplete) {
      referenceGeometry = [];
      // A loaded MapLibre map stops scheduling static frames. Request the
      // settled measurement frame explicitly rather than waiting for an idle
      // renderer to draw after the 400ms qualification interval.
      reference.triggerRepaint();
    }
  });
  const draw = viewer.scene.context.draw;
  const nativeDrawElements = nativeGl.drawElements;
  nativeGl.drawElements = function (mode, count, type, offset) {
    if (!nativeGeometryComplete && nativeDrawingKind && (feedbackEnabled || nativeDrawingKind === 'extrusion') && tileset.tilesLoaded && performance.now() - changedAt > 400)
      nativeGeometry.push(vertexFeedback(nativeGl, nativeDrawingKind, mode, indexedVertices(nativeGl, count, type, offset)));
    return nativeDrawElements.call(this, mode, count, type, offset);
  };
  const nativeDrawArrays = nativeGl.drawArrays;
  nativeGl.drawArrays = function (mode, first, count) {
    if (!nativeGeometryComplete && nativeDrawingKind && (feedbackEnabled || nativeDrawingKind === 'extrusion') && tileset.tilesLoaded && performance.now() - changedAt > 400)
      nativeGeometry.push(vertexFeedback(nativeGl, nativeDrawingKind, mode, Array.from({ length: count }, (_, index) => first + index)));
    return nativeDrawArrays.call(this, mode, first, count);
  };
  viewer.scene.context.draw = function (command, ...args) {
    const batch = drawBatchForOwner(command) ?? drawBatchForOwner(command.owner);
    if (batch) {
      nativeKinds.add(batch.kind);
      nativeDraws.push({ kind: batch.kind, layerId: batch.layerId });
    }
    nativeDrawingKind = batch && ['line', 'circle', 'extrusion', 'symbol'].includes(batch.kind) ? batch.kind : undefined;
    try {
      return draw.call(this, command, ...args);
    }
    finally {
      nativeDrawingKind = undefined;
    }
  };
  viewer.scene.preRender.addEventListener(() => {
    nativeKinds = new Set();
    nativeDraws = [];
    if (!nativeGeometryComplete)
      nativeGeometry = [];
  });
  viewer.scene.postRender.addEventListener(() => {
    nativePixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    nativeFrames++;
    nativeGeometryComplete = new Set(nativeGeometry.map(value => value.kind)).size === (feedbackEnabled ? 4 : 1);
  });
  function referencePose() {
    const tr = transform();
    const view = Matrix4.multiply(Matrix4.inverse(Matrix4.fromArray(Array.from(tr.projectionMatrix)), new Matrix4()), Matrix4.fromArray(Array.from(tr.modelViewProjectionMatrix)), new Matrix4());
    const direction = Cartesian3.normalize(new Cartesian3(-view[2], -view[6], -view[10]), new Cartesian3());
    const up = Cartesian3.normalize(new Cartesian3(view[1], view[5], view[9]), new Cartesian3());
    if (pureGlobe) {
      // MapLibre's sphere axes (east, north, radial at 0/0) map to ECEF
      // (Y, Z, X). The camera is calibrated from its actual rendered matrices.
      return { position: new Cartesian3(tr.cameraPosition[2] * radius, tr.cameraPosition[0] * radius, tr.cameraPosition[1] * radius), direction: new Cartesian3(direction.z, direction.x, direction.y), up: new Cartesian3(up.z, up.x, up.y) };
    }
    const location = MercatorCoordinate.fromLngLat(tr.getCameraLngLat());
    const altitude = MercatorCoordinate.fromLngLat(reference.getCenter(), tr.getCameraAltitude()).z;
    // Mercator transform matrices use east/south/altitude pixel-world axes.
    return { position: new Cartesian3(altitude * circumference, (location.x - 0.5) * circumference, (0.5 - location.y) * circumference), direction: new Cartesian3(direction.z, direction.x, -direction.y), up: new Cartesian3(up.z, up.x, -up.y) };
  }
  function setView(pitch: number) {
    reference.jumpTo({ center: [0, 0], zoom, bearing: 0, pitch, roll: 0 });
    const pose = referencePose();
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    viewer.camera.setView({ destination: pose.position, convert: pureGlobe, orientation: { direction: pose.direction, up: pose.up } });
    // transform matrices determine WC in 3D. CV setView expects local east/
    // north/height for convert:false; its world axes are height/east/north.
    if (!pureGlobe) {
      viewer.camera.setView({ destination: new Cartesian3(pose.position.y, pose.position.z, pose.position.x), convert: false, orientation: { heading: 0, pitch: pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    }
    changedAt = performance.now();
    nativeFrames = 0;
    referenceFrames = 0;
    nativePixels = undefined;
    referencePixels = undefined;
    referenceDraws = [];
    nativeGeometry = [];
    referenceGeometry = [];
    nativeGeometryComplete = false;
    referenceGeometryComplete = false;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  }
  setView(0);
  return {
    setView,
    sourceData: data,
    beginSourceReplacement(url: string) {
      const next = structuredClone(style);
      next.sources = { replacement: { type: 'geojson', data: url, maxzoom: 14 } };
      next.layers = next.layers.map(layer => ({ ...layer, id: `replacement-${layer.id}`, ...('source' in layer ? { source: 'replacement' } : {}) }));
      tileset.setStyle(next);
      changedAt = performance.now();
      nativeFrames = 0;
      viewer.scene.requestRender();
    },
    removeNative() {
      nativeFrames = 0;
      viewer.scene.primitives.remove(tileset);
      viewer.scene.requestRender();
    },
    nativeDepthSample: () => ({ frames: nativeFrames, tilesLoaded: tileset.tilesLoaded, deletedBuffers: deletedNativeBuffers, kinds: [...nativeKinds], draws: nativeDraws, color: nativePixels ? pixelColor(nativePixels, viewer.canvas, Math.floor(reference.project(coordinate(210, 0)).x), Math.floor(reference.project(coordinate(210, 0)).y)) : undefined }),
    status: () => ({ errors, nativeFrames, referenceFrames, tilesLoaded: tileset.tilesLoaded, referenceLoaded: reference.loaded(), nativeGeometryComplete, referenceGeometryComplete, nativeGeometryKinds: nativeGeometry.map(value => value.kind), referenceGeometryKinds: referenceGeometry.map(value => value.kind) }),
    async framebufferHashes() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both actual framebuffers are required');
      const hash = async (pixels: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(pixels))), value => value.toString(16).padStart(2, '0')).join('');
      return { native: await hash(nativePixels), reference: await hash(referencePixels) };
    },
    ready: () => performance.now() - changedAt > 400 && tileset.tilesLoaded && reference.loaded() && nativeFrames > 20 && referenceFrames > 0 && !!nativePixels && !!referencePixels && nativeGeometryComplete && referenceGeometryComplete,
    capture() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both actual renderers must have a framebuffer');
      const actual = viewer.camera;
      const pose = referencePose();
      const nativeCanvas = viewer.canvas;
      const referenceCanvas = reference.getCanvas();
      // Diagnose MapLibre's actual globe camera definition independently of
      // Native's altitude-based style scale. No pitch correction is applied.
      const focalPixels = nativeCanvas.clientHeight / (2 * Math.tan((actual.frustum as PerspectiveFrustum).fovy! / 2));
      const ray = actual.getPickRay(new Cartesian2(nativeCanvas.clientWidth / 2, nativeCanvas.clientHeight / 2))!;
      const intersection = pureGlobe && IntersectionTests.rayEllipsoid(ray, viewer.scene.mapProjection.ellipsoid);
      const focus = intersection ? Ray.getPoint(ray, intersection.start, new Cartesian3()) : undefined;
      const focusLocation = focus && viewer.scene.mapProjection.ellipsoid.cartesianToCartographic(focus);
      const focusDistance = focus && Cartesian3.distance(actual.positionWC, focus);
      const focusZoom = focusDistance && focusLocation ? Math.log2(focalPixels * circumference * Math.cos(focusLocation.latitude) / (512 * focusDistance)) : undefined;
      const sampledZoom = cameraZoom({ camera: actual, mode: viewer.scene.mode, projection: viewer.scene.mapProjection, width: nativeCanvas.clientWidth, height: nativeCanvas.clientHeight });
      const sourceFeatures = reference.querySourceFeatures('features');
      const circleAnchors: Cartesian3[] = [];
      for (const record of tileset._renderer.vector._records.values()) {
        for (const collection of record.collections.values()) {
          if (collection instanceof CircleCollection)
            circleAnchors.push(...collection.entries.map(entry => entry.position));
        }
      }
      const iconAnchors = [...tileset._renderer.symbol._tiles.values()].flatMap(entry => entry.batches.flatMap(batch => batch.icon?.instances.map((instance) => {
        const offset = instance.vertexStart * 3;
        return Cartesian3.fromArray(Array.from(batch.icon!.positions), offset);
      }) ?? []));
      const points = landmarks.map((landmark) => {
        const native = SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(...landmark.coordinate))!;
        const expected = reference.project(landmark.coordinate);
        const anchors = landmark.id === 'circle' ? circleAnchors : landmark.id === 'symbol' ? iconAnchors : [];
        const target = Cartesian3.fromDegrees(...landmark.coordinate);
        const anchor = anchors.sort((a, b) => Cartesian3.distanceSquared(a, target) - Cartesian3.distanceSquared(b, target))[0];
        const nativeAnchor = anchor && SceneTransforms.worldToWindowCoordinates(viewer.scene, anchor);
        const referenceAnchor = sourceFeatures.flatMap(feature => feature.geometry.type === 'Point' && feature.properties.kind === landmark.id ? [reference.project(feature.geometry.coordinates as [number, number])] : []).sort((a, b) => Math.hypot(a.x - expected.x, a.y - expected.y) - Math.hypot(b.x - expected.x, b.y - expected.y))[0];
        const workerAnchorError = nativeAnchor && referenceAnchor ? Math.hypot(nativeAnchor.x - referenceAnchor.x, nativeAnchor.y - referenceAnchor.y) : undefined;
        return { id: landmark.id, color: landmark.color, nativeCenter: native, referenceCenter: expected, projectionError: Math.hypot(native.x - expected.x, native.y - expected.y), nativeAnchor, referenceAnchor, workerAnchorError, native: measure(nativeCanvas, nativePixels!, expected, landmark.color), reference: measure(referenceCanvas, referencePixels!, expected, landmark.color) };
      });
      let building;
      if (pureGlobe) {
        const parameters: Array<{ height: number; base: number; tile: number[]; translate: number[] }> = [];
        const model = (draws: VertexFeedback[], project: (geometry: VertexFeedback) => ScreenVertex[]) => {
          const used: ScreenVertex[] = [];
          const gpuVertices: ScreenVertex[] = [];
          for (const geometry of draws.filter(value => value.kind === 'extrusion')) {
            const vertices = project(geometry);
            used.push(...geometry.indices.map(index => vertices[index - geometry.first]));
            if (feedbackEnabled) {
              gpuVertices.push(...geometry.indices.map((index) => {
                const offset = (index - geometry.first) * 4;
                return { x: (geometry.clip[offset] / geometry.clip[offset + 3] + 1) * nativeCanvas.width / 2, y: (1 - geometry.clip[offset + 1] / geometry.clip[offset + 3]) * nativeCanvas.height / 2 };
              }));
            }
          }
          return { bounds: bounds(used), vertices: used, coverage: hullCoverage(used, points[2].native.grid), gpuBounds: feedbackEnabled ? bounds(gpuVertices) : undefined, gpuModelError: feedbackEnabled ? Math.max(...used.map((vertex, index) => Math.hypot(vertex.x - gpuVertices[index].x, vertex.y - gpuVertices[index].y))) : undefined };
        };
        const native = model(nativeGeometry, (geometry) => {
          const high = geometry.attributes.a_extrusionHigh3D.values;
          const low = geometry.attributes.a_extrusionLow3D.values;
          return Array.from({ length: high.length / 3 }, (_, index) => SceneTransforms.worldToWindowCoordinates(viewer.scene, new Cartesian3(high[index * 3] * 65536 + low[index * 3], high[index * 3 + 1] * 65536 + low[index * 3 + 1], high[index * 3 + 2] * 65536 + low[index * 3 + 2]))!);
        });
        const reference = model(referenceGeometry, (geometry) => {
          const tile = uniform(geometry, 'u_projection_tile_mercator_coords') as number[];
          const translate = uniform(geometry, 'u_fill_translate') as number[];
          const height = uniform(geometry, 'u_height') as number;
          const base = uniform(geometry, 'u_base') as number;
          parameters.push({ height, base, tile, translate });
          const position = geometry.attributes.a_pos.values;
          const normal = geometry.attributes.a_normal_ed.values;
          const matrix = Matrix4.fromArray(Array.from(transform().modelViewProjectionMatrix));
          return Array.from({ length: position.length / 2 }, (_, index) => {
            const mx = tile[0] + tile[2] * (position[index * 2] + translate[0]);
            const my = tile[1] + tile[3] * (position[index * 2 + 1] + translate[1]);
            const lng = (mx - 0.5) * 2 * Math.PI;
            const lat = Math.atan(Math.sinh((0.5 - my) * 2 * Math.PI));
            const scale = 1 + ((normal[index * 4] & 1) ? height : base) / 6371008.8;
            const clip = Matrix4.multiplyByVector(matrix, new Cartesian4(Math.sin(lng) * Math.cos(lat) * scale, Math.sin(lat) * scale, Math.cos(lng) * Math.cos(lat) * scale, 1), new Cartesian4());
            return { x: (clip.x / clip.w + 1) * referenceCanvas.width / 2, y: (1 - clip.y / clip.w) * referenceCanvas.height / 2 };
          });
        });
        building = { parameters: { draws: parameters, nativePositionEncoding: 'high * 65536 + low', referenceRadius: 6371008.8, nativeRadii: viewer.scene.mapProjection.ellipsoid.radii }, native, reference };
      }
      const occlusionPoint = reference.project(coordinate(210, 0));
      return {
        mode,
        requestedZoom: zoom,
        pureGlobe,
        errors,
        tilesLoaded: tileset.tilesLoaded,
        terrain: { native: viewer.terrainProvider instanceof EllipsoidTerrainProvider ? 'EllipsoidTerrainProvider' : viewer.terrainProvider.constructor.name, reference: reference.getTerrain() ?? null },
        models: { native: 'WGS84', nativeEquatorialRadius: radius, reference: pureGlobe ? 'sphere' : 'Mercator', referenceSphereRadius: 6371008.8, cameraNormalization: 'equatorial-radius' },
        viewport: { native: [nativeCanvas.width, nativeCanvas.height, nativeCanvas.clientWidth, nativeCanvas.clientHeight], reference: [referenceCanvas.width, referenceCanvas.height, referenceCanvas.clientWidth, referenceCanvas.clientHeight] },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(gl) },
        projection: { declared: reference.getProjection(), transformGlobe: transform().isGlobeRendering ?? pureGlobe, draws: referenceDraws },
        camera: { pitch: reference.getPitch(), nativeMode: viewer.scene.mode, fov: reference.getVerticalFieldOfView(), nativeFov: (actual.frustum as PerspectiveFrustum).fovy! * 180 / Math.PI, positionError: Cartesian3.distance(actual.positionWC, pose.position), directionError: Cartesian3.distance(actual.directionWC, pose.direction), upError: Cartesian3.distance(actual.upWC, pose.up), nativePosition: Cartesian3.clone(actual.positionWC), calibratedPosition: pose.position, nativeDirection: Cartesian3.clone(actual.directionWC), calibratedDirection: pose.direction, zoom: reference.getZoom(), nativeStyleZoom: tileset._renderer.evaluation.zoom, scaleDiagnostic: { focalPixels, sampledZoom, focusZoom, focusDistance, focusLatitude: focusLocation?.latitude, cameraHeight: actual.positionCartographic.height, referenceNormalizedFocusDistance: transform().cameraToCenterDistance / (transform().worldSize / (2 * Math.PI * Math.cos(reference.getCenter().lat * Math.PI / 180))) }, referenceSpherePosition: Array.from(transform().cameraPosition), actualProjectionMatrix: Array.from(transform().projectionMatrix), actualModelViewProjectionMatrix: Array.from(transform().modelViewProjectionMatrix) },
        nativeKinds: [...nativeKinds],
        geometry: { enabled: feedbackEnabled, native: nativeGeometry, reference: referenceGeometry },
        building,
        sourceKinds: sourceFeatures.map(feature => feature.geometry.type),
        points,
        occlusion: { enabled: occlusion, point: occlusionPoint, native: pixelColor(nativePixels, nativeCanvas, Math.floor(occlusionPoint.x), Math.floor(occlusionPoint.y)), reference: pixelColor(referencePixels, referenceCanvas, Math.floor(occlusionPoint.x), Math.floor(occlusionPoint.y)) },
      };
    },
  };
}

declare global { interface Window { globeRenderComparison: Awaited<ReturnType<typeof createComparison>> } }
void createComparison().then(value => window.globeRenderComparison = value);
