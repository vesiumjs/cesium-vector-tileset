import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { NativeCommand, TestTileset, TestViewer } from './browser-types';
import * as Cesium from 'cesium';
import { Cartesian2, Cartesian3, Color, ComponentDatatype, Ray, SceneMode, Viewer, WebMercatorProjection } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner, linePaintForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import { layerRadialOffsetMeters } from '../../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import 'cesium/Build/Cesium/Widgets/widgets.css';

type Layers = 'water' | 'road' | 'combined';
export interface SurfaceCase {
  layers: Layers;
  globeDraw: boolean;
  pitch: number;
  depthTest?: boolean;
  terrainDepth?: boolean;
  logDepth?: boolean;
  seamSubdivision?: boolean;
}
const radius = 6378137;
const circumference = 2 * Math.PI * radius;
const water = { west: -800, east: 800, south: 500, north: 18000 };
const road = { east: 150, south: 800, north: 12000, width: 10 };
const coordinate = (x: number, y: number): [number, number] => [x / radius * 180 / Math.PI, Math.atan(Math.sinh(y / radius)) * 180 / Math.PI];
const offsets = Array.from({ length: 20 }, (_, index) => index === 0 ? 0 : (index % 2 ? 1 : -1) * Math.ceil(index / 2) * 0.002);
const layerOrder = new Map([['water', 0], ['road', 1]]);
const waterHeight = layerRadialOffsetMeters('water', layerOrder);

function style(layers: Layers): StyleSpecification {
  return {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: {
      finite: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { kind: 'water' }, geometry: { type: 'Polygon', coordinates: [[coordinate(water.west, water.south), coordinate(water.east, water.south), coordinate(water.east, water.north), coordinate(water.west, water.north), coordinate(water.west, water.south)]] } },
            { type: 'Feature', properties: { kind: 'road' }, geometry: { type: 'LineString', coordinates: [coordinate(road.east, road.south), coordinate(road.east, road.north)] } },
          ],
        },
      },
    },
    layers: [
      // Retain the same layer order and radial height in the road-only oracle.
      { id: 'water', type: 'fill' as const, source: 'finite', filter: ['==', 'kind', 'water'] as ['==', string, string], layout: { visibility: layers === 'road' ? 'none' as const : 'visible' as const }, paint: { 'fill-color': '#0000ff', 'fill-opacity': 1, 'fill-antialias': false } },
      ...(layers === 'water' ? [] : [{ id: 'road', type: 'line' as const, source: 'finite', filter: ['==', 'kind', 'road'] as ['==', string, string], layout: { 'line-cap': 'butt' as const, 'line-join': 'miter' as const }, paint: { 'line-color': '#ff0000', 'line-width': road.width, 'line-blur': 0 } }]),
    ],
  };
}

interface DrawObservation {
  kind: 'water' | 'road';
  tile: string;
  near: number;
  far: number;
  depthTest: boolean;
  depthMask: boolean;
  logShader: boolean;
  bounds?: { west: number; east: number; south: number; north: number };
}
interface RowObservation {
  y: number;
  surfaceHeight: number;
  north: number;
  eyeDepth: number;
  expected: number;
  missing: number;
  runs: Array<[number, number]>;
  colors: number[][];
}

/** Read only the two executed water VAs at the known seam-hole pose. */
function captureSeamCommand(command: NativeCommand, gl: WebGL2RenderingContext, pendingSurfaceWords?: number[][]) {
  const shader = command.shaderProgram as NativeCommand['shaderProgram'] & {
    _program: WebGLProgram;
    _vertexShaderText: string;
    _fragmentShaderText: string;
    vertexAttributes: Record<string, { index: number; type: number }>;
  };
  const buffers = new Map<WebGLBuffer, Uint8Array>();
  const readBuffer = (buffer: NonNullable<NativeCommand['vertexArray']['indexBuffer']>) => {
    const native = buffer._getBuffer();
    let bytes = buffers.get(native);
    if (!bytes) {
      bytes = new Uint8Array(buffer.sizeInBytes);
      const previous = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) as WebGLBuffer | null;
      try {
        gl.bindBuffer(gl.COPY_READ_BUFFER, native);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, bytes);
      }
      finally {
        gl.bindBuffer(gl.COPY_READ_BUFFER, previous);
      }
      buffers.set(native, bytes);
    }
    return bytes;
  };
  const scalar = (bytes: Uint8Array, type: number, offset: number): number => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
      case gl.BYTE: return view.getInt8(offset);
      case gl.UNSIGNED_BYTE: return view.getUint8(offset);
      case gl.SHORT: return view.getInt16(offset, true);
      case gl.UNSIGNED_SHORT: return view.getUint16(offset, true);
      case gl.INT: return view.getInt32(offset, true);
      case gl.UNSIGNED_INT: return view.getUint32(offset, true);
      case gl.FLOAT: return view.getFloat32(offset, true);
      default: throw new Error(`Unsupported actual seam attribute datatype ${type}`);
    }
  };
  const size = (type: number) => {
    switch (type) {
      case gl.BYTE:
      case gl.UNSIGNED_BYTE: return 1;
      case gl.SHORT:
      case gl.UNSIGNED_SHORT: return 2;
      case gl.INT:
      case gl.UNSIGNED_INT:
      case gl.FLOAT: return 4;
      default: throw new Error(`Unsupported actual seam attribute datatype ${type}`);
    }
  };
  const array = command.vertexArray;
  const attributes = Object.entries(shader.vertexAttributes).map(([name, active]) => {
    const attribute = Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index))
      .find(value => value.index === active.index) as ReturnType<typeof array.getAttribute> & { offsetInBytes: number; value?: number[] };
    if (!attribute)
      throw new Error(`Actual seam shader attribute ${name} has no VA input`);
    const bytes = attribute.vertexBuffer && readBuffer(attribute.vertexBuffer);
    const stride = attribute.strideInBytes || attribute.componentsPerAttribute * size(attribute.componentDatatype);
    const values = Array.from({ length: array.numberOfVertices }, (_, vertex) => Array.from({ length: attribute.componentsPerAttribute }, (_, component) =>
      bytes ? scalar(bytes, attribute.componentDatatype, (attribute.offsetInBytes ?? 0) + vertex * stride + component * size(attribute.componentDatatype)) : attribute.value![component]));
    return { name, index: active.index, datatype: attribute.componentDatatype, components: attribute.componentsPerAttribute, normalize: attribute.normalize, stride, offset: attribute.offsetInBytes, values };
  });
  const indexBuffer = array.indexBuffer as NonNullable<typeof array.indexBuffer> & { indexDatatype: number; numberOfIndices: number };
  if (!indexBuffer)
    throw new Error('Actual seam water draw must have an index buffer');
  const indexBytes = readBuffer(indexBuffer);
  const indices = Array.from({ length: indexBuffer.numberOfIndices }, (_, index) => scalar(indexBytes, indexBuffer.indexDatatype, index * size(indexBuffer.indexDatatype)));
  const uniform = (name: string): number[] | null => {
    const location = gl.getUniformLocation(shader._program, name);
    if (location === null)
      return null;
    const value = gl.getUniform(shader._program, location) as number | ArrayLike<number>;
    return typeof value === 'number' ? [value] : Array.from(value);
  };
  const surfaceWords = pendingSurfaceWords ?? Array.from({ length: 6 }, (_, field) => uniform(`surface_words[${field}]`));
  if (surfaceWords.some(value => !value || value.length !== 4))
    throw new Error('Actual seam water shader must expose six surface word descriptors');
  const scratch = new DataView(new ArrayBuffer(4));
  const projected = Array.from({ length: array.numberOfVertices }, (_, vertex) => {
    const fields = surfaceWords.map((descriptor, field) => {
      const [offset, width, low, high] = descriptor!;
      let word = (low | high << 16) >>> 0;
      let consumed = 0;
      let bit = offset;
      while (consumed < width) {
        const byte = bit >> 3;
        const lane = attributes.find(attribute => attribute.name === `a_surface${byte >> 2}`);
        if (!lane)
          throw new Error(`Actual seam surface byte ${byte} has no VA lane`);
        const count = Math.min(8 - (bit & 7), width - consumed);
        word = (word | ((lane.values[vertex][byte & 3] >>> (bit & 7)) & ((1 << count) - 1)) << consumed) >>> 0;
        consumed += count;
        bit += count;
      }
      if (field < 3)
        return ((word << 16) >> 16) * 65536;
      scratch.setUint32(0, word, true);
      return scratch.getFloat32(0, true);
    });
    return { vertex, high: fields.slice(0, 3), low: fields.slice(3), east: fields[0] + fields[3], north: fields[1] + fields[4], height: fields[2] + fields[5] };
  });
  return {
    vertices: array.numberOfVertices,
    attributes,
    indices,
    indexDatatype: indexBuffer.indexDatatype,
    projected,
    surfaceWords,
    mvp: uniform('czm_modelViewProjectionRelativeToEye'),
    cameraHigh: uniform('czm_encodedCameraPositionMCHigh'),
    cameraLow: uniform('czm_encodedCameraPositionMCLow'),
    viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
    vertexShader: shader._vertexShaderText,
    fragmentShader: shader._fragmentShaderText,
  };
}

/** Insert the actually uploaded left T vertex into the right tile's straight edge. */
function subdivideSeamCommand(command: NativeCommand, context: TestViewer['scene']['context'], left: ReturnType<typeof captureSeamCommand>) {
  // Context.draw has not uploaded this command's uniforms yet: the shared
  // program still contains the preceding left tile's packed-word descriptors.
  // Use the pending right command's exact values to decode its VA, then qualify
  // these descriptors against real GL uniforms after the replacement executes.
  const pending = command.uniformMap.surface_words?.() as Array<{ x: number; y: number; z: number; w: number }> | undefined;
  if (!pending || pending.length !== 6)
    throw new Error('Seam control requires six pending right surface word descriptors');
  const source = captureSeamCommand(command, context._gl, pending.map(word => [word.x, word.y, word.z, word.w]));
  const west = Math.min(...source.projected.map(vertex => vertex.east));
  const edge = source.projected.filter(vertex => vertex.east === west).sort((a, b) => a.north - b.north);
  if (edge.length !== 2 || edge[0].height !== edge[1].height)
    throw new Error('Seam control requires the actual right straight edge with exactly two endpoints');
  const candidates = left.projected.filter(vertex => vertex.east === west && vertex.height === edge[0].height
    && vertex.north > edge[0].north && vertex.north < edge[1].north);
  if (candidates.length !== 1)
    throw new Error('Seam control requires exactly one actual left T vertex');
  const inserted = candidates[0];
  const addedIndex = source.vertices;
  const indices: number[] = [];
  let splits = 0;
  let copyVertex: number | undefined;
  for (let offset = 0; offset < source.indices.length; offset += 3) {
    const triangle = source.indices.slice(offset, offset + 3);
    const side = triangle.findIndex((vertex, index) => edge.some(point => point.vertex === vertex)
      && edge.some(point => point.vertex === triangle[(index + 1) % 3]));
    if (side < 0) {
      indices.push(...triangle);
      continue;
    }
    const first = triangle[side];
    const second = triangle[(side + 1) % 3];
    const opposite = triangle[(side + 2) % 3];
    indices.push(first, addedIndex, opposite, addedIndex, second, opposite);
    copyVertex = first;
    splits++;
  }
  if (splits !== 1)
    throw new Error('Seam control must split exactly one actual boundary triangle');
  const bytes = new Uint8Array(Math.ceil(Math.max(...source.surfaceWords.map(word => word![0] + word![1])) / 8));
  const scratch = new DataView(new ArrayBuffer(4));
  for (const [field, descriptor] of source.surfaceWords.entries()) {
    const [offset, width, low, high] = descriptor!;
    const prefix = (low | high << 16) >>> 0;
    let word: number;
    if (field < 3) {
      word = (inserted.high[field] / 65536) & 0xFFFF;
    }
    else {
      scratch.setFloat32(0, inserted.low[field - 3], true);
      word = scratch.getUint32(0, true);
    }
    const mask = width === 32 ? 0xFFFFFFFF : 2 ** width - 1;
    if (((word & ~mask) >>> 0) !== prefix)
      throw new Error('Exact inserted T vertex must fit the original right shader descriptors');
    let remaining = width;
    let bit = offset;
    while (remaining > 0) {
      const count = Math.min(8 - (bit & 7), remaining);
      bytes[bit >> 3] |= (word & ((1 << count) - 1)) << (bit & 7);
      word >>>= count;
      bit += count;
      remaining -= count;
    }
  }
  const gpu = Cesium as unknown as {
    BufferUsage: { STATIC_DRAW: number };
    Buffer: {
      createVertexBuffer: (options: { context: unknown; typedArray: ArrayBufferView; usage: number }) => NonNullable<NativeCommand['vertexArray']['indexBuffer']>;
      createIndexBuffer: (options: { context: unknown; typedArray: ArrayBufferView; usage: number; indexDatatype: number }) => NonNullable<NativeCommand['vertexArray']['indexBuffer']>;
    };
    VertexArray: new (options: { context: unknown; attributes: unknown[]; indexBuffer: unknown }) => NativeCommand['vertexArray'] & { destroy: () => void };
  };
  const datatypes = ComponentDatatype as unknown as { createTypedArray: (datatype: number, values: number[]) => ArrayBufferView };
  const attributes = source.attributes.map((attribute) => {
    const values = attribute.values.map(value => [...value]);
    const lane = /^a_surface(\d+)$/.exec(attribute.name);
    const extra = lane
      ? Array.from({ length: attribute.components }, (_, component) => bytes[Number(lane[1]) * 4 + component] ?? 0)
      : [...attribute.values[copyVertex!]];
    // The new vertex carries the same instance paint as both edge endpoints.
    if (!lane && !attribute.values[edge[0].vertex].every((value, component) => value === attribute.values[edge[1].vertex][component]))
      throw new Error(`Seam control cannot interpolate varying ${attribute.name} paint`);
    values.push(extra);
    const typedArray = datatypes.createTypedArray(attribute.datatype, values.flat());
    return { index: attribute.index, vertexBuffer: gpu.Buffer.createVertexBuffer({ context, typedArray, usage: gpu.BufferUsage.STATIC_DRAW }), componentsPerAttribute: attribute.components, componentDatatype: attribute.datatype, normalize: attribute.normalize };
  });
  const indexBuffer = gpu.Buffer.createIndexBuffer({ context, typedArray: datatypes.createTypedArray(source.indexDatatype, indices), usage: gpu.BufferUsage.STATIC_DRAW, indexDatatype: source.indexDatatype });
  const vertexArray = new gpu.VertexArray({ context, attributes, indexBuffer });
  // Retain Native's actual owner, program, uniforms, model and render state.
  const replacement = Object.assign(Object.create(Object.getPrototypeOf(command)), command, { vertexArray, count: indices.length, offset: 0 }) as NativeCommand;
  return { command: replacement, vertexArray, inserted, edge: edge.map(point => point.vertex), splitTriangles: splits, source };
}

async function createSurfaceHorizon() {
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
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const tileset = new CesiumVectorTileset({ style: style('water') }) as unknown as TestTileset;
  viewer.scene.primitives.add(tileset);
  const defaultTerrainDepth = viewer.scene.globe.depthTestAgainstTerrain;
  const defaultLogDepth = viewer.scene.logarithmicDepthBuffer;
  const states = new WeakMap<object, object>();
  const nativeRenderState = (Cesium as unknown as { RenderState: { fromCache: (state: object) => object } }).RenderState;
  const draws: DrawObservation[] = [];
  let current: SurfaceCase = { layers: 'water', globeDraw: true, pitch: 89 };
  let globeDrawAttempts = 0;
  let globeDraws = 0;
  const globePass = (Cesium as unknown as { Pass: { GLOBE: number } }).Pass.GLOBE;
  let warmFrames = 0;
  let collecting = false;
  let sampleIndex = 0;
  let metersPerPixel = 0;
  let roadHeight = layerRadialOffsetMeters('road', layerOrder);
  const seamDraws: Array<{ tile: string; canonical: { z: number; x: number; y: number }; capture: ReturnType<typeof captureSeamCommand> }> = [];
  let seamSubdivision: {
    inserted: ReturnType<typeof captureSeamCommand>['projected'][number];
    edge: number[];
    splitTriangles: number;
    source: ReturnType<typeof captureSeamCommand>;
    pendingDescriptorsMatch: boolean;
    shaderUnchanged: boolean;
    uniformsUnchanged: boolean;
    renderStateUnchanged: boolean;
    ownerUnchanged: boolean;
  } | undefined;
  const controlArrays: Array<{ destroy: () => void }> = [];
  const frames: ReturnType<typeof capture>[] = [];
  const roadReferences = new Map<string, Array<{ mask: Uint8Array; pitch: number; position: Cartesian3; direction: Cartesian3; metersPerPixel: number; surfaceHeight: number }>>();
  const setCamera = (pitch: number) => {
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    const aspect = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    frustum.aspectRatio = aspect;
    frustum.fov = 2 * Math.atan(Math.tan(36.875112943 * Math.PI / 360) * aspect);
    viewer.camera.setView({ destination: new Cartesian3(0, 0, 120), convert: false, orientation: { heading: 0, pitch: (pitch - 90) * Math.PI / 180, roll: 0 } });
  };
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command: NativeCommand, ...args) {
    if (command.pass === globePass) {
      globeDrawAttempts++;
      // Keep the actual Globe and its tile authorization available to the
      // tileset. This control isolates only the Globe's executing GPU draws.
      if (!current.globeDraw)
        return;
      globeDraws++;
    }
    const batch = drawBatchForOwner(command.owner);
    if (batch?.layerId === 'water' || batch?.layerId === 'road') {
      if (current.depthTest !== undefined && command.renderState.depthTest.enabled !== current.depthTest) {
        let state = states.get(command.renderState);
        if (!state) {
          state = nativeRenderState.fromCache({ ...command.renderState, depthTest: { ...command.renderState.depthTest, enabled: current.depthTest } });
          states.set(command.renderState, state);
        }
        // The diagnostic changes only this actual executing command's state,
        // after Native has derived log depth. It cannot suppress shader discard.
        command = Object.assign(Object.create(Object.getPrototypeOf(command)), command, { renderState: state });
      }
      const frustum = (this as unknown as { uniformState: { currentFrustum: Cartesian2 } }).uniformState.currentFrustum;
      const id = tileset._renderer.vector._records.get(batch.tileId)?.tileID;
      const canonical = id && ('canonical' in id ? id.canonical : id);
      const world = canonical && 2 ** canonical.z;
      draws.push({
        kind: batch.layerId,
        tile: batch.tileId,
        near: frustum.x,
        far: frustum.y,
        depthTest: command.renderState.depthTest.enabled,
        depthMask: command.renderState.depthMask,
        logShader: command.shaderProgram.fragmentShaderSource.defines.includes('LOG_DEPTH'),
        bounds: canonical && world
          ? {
              west: (canonical.x / world - 0.5) * circumference,
              east: ((canonical.x + 1) / world - 0.5) * circumference,
              south: (0.5 - (canonical.y + 1) / world) * circumference,
              north: (0.5 - canonical.y / world) * circumference,
            }
          : undefined,
      });
      const paint = linePaintForOwner(command.owner);
      if (paint) {
        metersPerPixel = paint.metersPerPixelUniform();
        roadHeight = paint.offsetUniform();
      }
    }
    let canonical: { z: number; x: number; y: number } | undefined;
    if (collecting && current.pitch === 89 && sampleIndex === 16 && batch?.layerId === 'water') {
      const id = tileset._renderer.vector._records.get(batch.tileId)?.tileID;
      canonical = id && ('canonical' in id ? id.canonical : id);
    }
    let control: ReturnType<typeof subdivideSeamCommand> | undefined;
    const sourceCommand = command;
    if (current.seamSubdivision && canonical?.z === 17 && canonical.x === 65535 && canonical.y === 65534) {
      const left = seamDraws.find(draw => draw.canonical.x === 65534);
      if (!left)
        throw new Error('Seam control requires the actual left draw before replacing the right VA');
      control = subdivideSeamCommand(command, viewer.scene.context, left.capture);
      controlArrays.push(control.vertexArray);
      command = control.command;
    }
    const result = originalDraw.call(this, command, ...args);
    if (canonical?.z === 17 && canonical.y === 65534 && (canonical.x === 65534 || canonical.x === 65535)) {
      const actual = captureSeamCommand(command, viewer.scene.context._gl);
      if (control) {
        seamSubdivision = {
          inserted: control.inserted,
          edge: control.edge,
          splitTriangles: control.splitTriangles,
          source: captureSeamCommand(sourceCommand, viewer.scene.context._gl),
          pendingDescriptorsMatch: actual.surfaceWords.every((word, field) => word!.every((value, component) => value === control!.source.surfaceWords[field]![component])),
          shaderUnchanged: command.shaderProgram === sourceCommand.shaderProgram,
          uniformsUnchanged: command.uniformMap === sourceCommand.uniformMap,
          renderStateUnchanged: command.renderState === sourceCommand.renderState,
          ownerUnchanged: command.owner === sourceCommand.owner,
        };
      }
      if (batch?.layerId === 'water') {
        seamDraws.push({ tile: batch.tileId, canonical: { z: canonical.z, x: canonical.x, y: canonical.y }, capture: actual });
      }
    }
    return result;
  };

  function capture() {
    const canvas = viewer.canvas;
    const width = canvas.width;
    const height = canvas.height;
    const pixels = viewer.scene.context.readPixels({ width, height });
    const pitch = 90 + viewer.camera.pitch * 180 / Math.PI;
    const referenceKey = `${current.pitch}/${current.globeDraw}`;
    const roadFrames = roadReferences.get(referenceKey);
    if (current.layers === 'road') {
      const mask = new Uint8Array(width * height);
      // The independent road-only render has primary red paint over black.
      // Any nonzero red channel is its actual GPU support, including AA and
      // the real surface offset; no invented geometric/epsilon margin.
      for (let index = 0; index < mask.length; index++) mask[index] = pixels[index * 4] > 0 ? 1 : 0;
      roadFrames![sampleIndex] = { mask, pitch, position: Cartesian3.clone(viewer.camera.positionWC), direction: Cartesian3.clone(viewer.camera.directionWC), metersPerPixel, surfaceHeight: roadHeight };
    }
    const overlay = current.layers === 'combined' ? roadFrames?.[sampleIndex] : undefined;
    const overlayPaired = !!overlay && overlay.pitch === pitch && overlay.metersPerPixel === metersPerPixel && overlay.surfaceHeight === roadHeight
      && Cartesian3.equals(overlay.position, viewer.camera.positionWC) && Cartesian3.equals(overlay.direction, viewer.camera.directionWC);
    let overlayExcluded = 0;
    const rows = { water: [] as RowObservation[], road: [] as RowObservation[] };
    const totals = { water: { expected: 0, missing: 0, rows: 0 }, road: { expected: 0, missing: 0, rows: 0 } };
    const controls = { water: 0, road: 0 };
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 2] > 200 && pixels[index] < 32 && pixels[index + 1] < 32)
        controls.water++;
      if (pixels[index] > 200 && pixels[index + 1] < 32 && pixels[index + 2] < 32)
        controls.road++;
    }
    const coverage = (kind: 'water' | 'road', east: number, north: number, depth: number) => draws.some(draw => draw.kind === kind && draw.bounds
      && depth > draw.near && depth < draw.far && east >= draw.bounds.west && east <= draw.bounds.east && north >= draw.bounds.south && north <= draw.bounds.north);
    const ground = (x: number, y: number, surfaceHeight: number) => {
      const ray = viewer.camera.getPickRay(new Cartesian2(x, y));
      if (!ray)
        return undefined;
      const distance = (surfaceHeight - ray.origin.x) / ray.direction.x;
      return Number.isFinite(distance) && distance > 0 ? Ray.getPoint(ray, distance, new Cartesian3()) : undefined;
    };
    // With qualified heading=roll=0, a screen row intersects this actual
    // projected plane affinely in east; north and eye depth stay constant.
    for (let y = 4; y < height - 4; y++) {
      for (const kind of ['water', 'road'] as const) {
        if (current.layers !== 'combined' && current.layers !== kind)
          continue;
        const surfaceHeight = kind === 'water' ? waterHeight : roadHeight;
        const center = ground(width / 2 + 0.5, y + 0.5, surfaceHeight);
        const neighbor = ground(width / 2 + 1.5, y + 0.5, surfaceHeight);
        const above = ground(width / 2 + 0.5, y - 3.5, surfaceHeight);
        const below = ground(width / 2 + 0.5, y + 4.5, surfaceHeight);
        if (!center || !neighbor || !above || !below)
          continue;
        const perPixel = neighbor.y - center.y;
        if (!(perPixel > 0) || !Number.isFinite(perPixel))
          continue;
        const depth = Cartesian3.dot(Cartesian3.subtract(center, viewer.camera.positionWC, new Cartesian3()), viewer.camera.directionWC);
        const bounds = kind === 'water' ? water : road;
        if (Math.min(above.z, below.z) <= bounds.south || Math.max(above.z, below.z) >= bounds.north)
          continue;
        const halfWidth = metersPerPixel * road.width / 2;
        const west = kind === 'water' ? water.west : road.east - halfWidth;
        const east = kind === 'water' ? water.east : road.east + halfWidth;
        const first = Math.max(4, Math.ceil(width / 2 + (west - center.y) / perPixel + 4));
        const last = Math.min(width - 5, Math.floor(width / 2 + (east - center.y) / perPixel - 4));
        const row: RowObservation = { y, surfaceHeight, north: center.z, eyeDepth: depth, expected: 0, missing: 0, runs: [], colors: [] };
        let start: number | undefined;
        for (let x = first; x <= last; x++) {
          const groundEast = center.y + (x - width / 2) * perPixel;
          if (!coverage(kind, groundEast, center.z, depth))
            continue;
          const index = ((height - 1 - y) * width + x) * 4;
          if (kind === 'water' && overlayPaired && overlay!.mask[index / 4]) {
            overlayExcluded++;
            continue;
          }
          row.expected++;
          const present = kind === 'water'
            ? pixels[index + 2] > 200 && pixels[index] < 32 && pixels[index + 1] < 32
            : pixels[index] > 200 && pixels[index + 1] < 32 && pixels[index + 2] < 32;
          if (!present) {
            row.missing++;
            start ??= x;
            if (row.colors.length < 4)
              row.colors.push([x, ...pixels.subarray(index, index + 4)]);
          }
          else if (start !== undefined) {
            row.runs.push([start, x - 1]);
            start = undefined;
          }
        }
        if (start !== undefined)
          row.runs.push([start, last]);
        if (row.expected) {
          totals[kind].expected += row.expected;
          totals[kind].missing += row.missing;
          totals[kind].rows++;
          if (row.missing)
            rows[kind].push(row);
        }
      }
    }
    const frusta = (viewer.scene as unknown as { frustumCommandsList: Array<{ near: number; far: number; indices: number[] }> }).frustumCommandsList;
    return {
      index: sampleIndex,
      offset: offsets[sampleIndex],
      pitch,
      overlayPaired,
      overlayReference: current.layers === 'combined' ? referenceKey : undefined,
      overlayExcluded,
      frameNumber: viewer.scene._frameState.frameNumber,
      tilesLoaded: tileset.tilesLoaded,
      viewport: [width, height, canvas.clientWidth, canvas.clientHeight],
      camera: { position: Cartesian3.clone(viewer.camera.positionWC), direction: Cartesian3.clone(viewer.camera.directionWC), heading: viewer.camera.heading, roll: viewer.camera.roll, fov: (viewer.camera.frustum as PerspectiveFrustum).fovy },
      useLogDepth: viewer.scene._frameState.useLogDepth,
      sourceGlobeShow: viewer.scene.globe.show,
      globeDrawEnabled: current.globeDraw,
      globeDrawAttempts,
      globeDraws,
      terrainDepth: viewer.scene.globe.depthTestAgainstTerrain,
      frusta: frusta.map(frustum => ({ near: frustum.near, far: frustum.far, counts: [...frustum.indices] })),
      draws: [...draws],
      metersPerPixel,
      surfaceHeights: { water: waterHeight, road: roadHeight },
      seamDraws: [...seamDraws],
      seamSubdivision,
      seamProbe: current.pitch === 89 && sampleIndex === 16 && current.layers !== 'road'
        ? { pixel: [29, 578], center: [29.5, 578.5], surfaceHeight: waterHeight, surface: ground(29.5, 578.5, waterHeight), rgba: Array.from(pixels.subarray(((height - 1 - 578) * width + 29) * 4, ((height - 1 - 578) * width + 29) * 4 + 4)) }
        : undefined,
      controls,
      totals,
      holes: rows,
    };
  }
  viewer.scene.preUpdate.addEventListener(() => {
    if (collecting) {
      sampleIndex = frames.length;
      setCamera(current.pitch + offsets[sampleIndex]);
    }
  });
  viewer.scene.preRender.addEventListener(() => {
    draws.length = 0;
    globeDrawAttempts = 0;
    globeDraws = 0;
    seamDraws.length = 0;
    seamSubdivision = undefined;
  });
  viewer.scene.postRender.addEventListener(() => {
    warmFrames++;
    if (collecting) {
      frames.push(capture());
      if (frames.length === offsets.length)
        collecting = false;
    }
  });
  setCamera(current.pitch);
  return {
    setCase(next: SurfaceCase) {
      for (const array of controlArrays.splice(0)) array.destroy();
      current = next;
      collecting = false;
      frames.length = 0;
      warmFrames = 0;
      metersPerPixel = 0;
      roadHeight = layerRadialOffsetMeters('road', layerOrder);
      if (next.layers === 'road')
        roadReferences.set(`${next.pitch}/${next.globeDraw}`, []);
      tileset.setStyle(style(next.layers));
      viewer.scene.globe.show = true;
      viewer.scene.globe.depthTestAgainstTerrain = next.terrainDepth ?? defaultTerrainDepth;
      viewer.scene.logarithmicDepthBuffer = next.logDepth ?? defaultLogDepth;
      setCamera(next.pitch);
    },
    ready: () => tileset.tilesLoaded && warmFrames > 8 && (current.layers === 'road' || draws.some(draw => draw.kind === 'water')) && (current.layers === 'water' || draws.some(draw => draw.kind === 'road')),
    start() {
      if (!this.ready())
        throw new Error('Finite Native owners must be loaded and actually draw');
      frames.length = 0;
      collecting = true;
    },
    done: () => frames.length === offsets.length,
    capture() {
      const gl = viewer.scene.context._gl;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { configuration: current, errors: [...errors], gpu: String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)), subpixelBits: gl.getParameter(gl.SUBPIXEL_BITS) as number, defaults: { terrainDepth: defaultTerrainDepth, logDepth: defaultLogDepth }, liveQualification: { tilesLoaded: tileset.tilesLoaded, warmFrames, sourceGlobeShow: viewer.scene.globe.show, globeDrawAttempts, globeDraws, draws: [...draws] }, frames: [...frames] };
    },
  };
}
declare global { interface Window { cvSurfaceHorizon: Awaited<ReturnType<typeof createSurfaceHorizon>> } }
void createSurfaceHorizon().then(value => window.cvSurfaceHorizon = value);
