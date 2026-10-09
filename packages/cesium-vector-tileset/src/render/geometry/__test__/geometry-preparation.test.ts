import type { GeometryPrepareBatchRequest } from '../geometry-preparation';
import * as Cesium from 'cesium';
import { Appearance, BoundingSphere, buildModuleUrl, Cartesian3, ComponentDatatype, Ellipsoid, GeographicProjection, Geometry, GeometryAttribute, GeometryInstance, Matrix4, Primitive, PrimitiveType, SceneMode, TaskProcessor, WebMercatorProjection } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLineGeometry } from '../../line/line-geometry';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { packAttributes, prepareLineInstances } from '../geometry-line';
import { createGeometryPacket } from '../geometry-packet';
import { prepareGeometry, prepareGeometryBatch } from '../geometry-preparation';
import { GeometryPrimitive, updateGeometryWithBudget } from '../geometry-primitive';
import { lineInputs } from '../line-input';
import { compileLinePositionTexture } from '../line-position-packing';

const pipeline = (Cesium as unknown as { PrimitivePipeline: {
  packCreateGeometryResults: (geometries: Geometry[], transfers: ArrayBuffer[]) => object;
  packCombineGeometryParameters: (parameters: object, transfers: ArrayBuffer[]) => object;
  unpackCombineGeometryParameters: (request: object) => object;
  combineGeometry: (request: object) => { geometries: Array<Geometry & { boundingSphereCV?: BoundingSphere }>; boundingSpheresCV?: Array<BoundingSphere | undefined> };
  packCombineGeometryResults: (result: object, transfers: ArrayBuffer[]) => object;
  unpackCombineGeometryResults: (result: object) => { geometries: Geometry[] };
}; }).PrimitivePipeline;

afterEach(() => vi.restoreAllMocks());

function finish<T>(compiler: Generator<void, T>): T {
  let step = compiler.next();
  while (!step.done) step = compiler.next();
  return step.value;
}

function sourceGeometry() {
  const positions = new Float64Array(10000).subarray(17, 26);
  for (let index = 0; index < 3; index++) {
    Cartesian3.pack(Cartesian3.fromDegrees(12 + index * 0.00001, 30 + (index % 2) * 0.00001), positions as unknown as number[], index * 3);
  }
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
      flags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: new Uint8Array([2, 4, 6]) }),
    } as Geometry['attributes'],
    indices: new Uint16Array([0, 1, 2]) as never,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(positions as unknown as number[]),
  });
}

describe('owned geometry preparation', () => {
  it('accepts compatible Native packets without an exact runtime version requirement', () => {
    const geometry = sourceGeometry();
    const packet = finish(createGeometryPacket([geometry]));
    const transfers: ArrayBuffer[] = [];
    const parameters = pipeline.packCombineGeometryParameters({
      createGeometryResults: [],
      instances: [new GeometryInstance({ geometry })],
      ellipsoid: Ellipsoid.WGS84,
      projection: new WebMercatorProjection(),
      elementIndexUintSupported: true,
      scene3DOnly: true,
      vertexCacheOptimize: false,
      compressVertices: false,
      modelMatrix: Matrix4.IDENTITY,
    }, transfers);
    const request = structuredClone({
      version: 'compatible-scene-runtime',
      parameters,
      geometries: packet.subTasks.map(task => task.geometry),
      layout: 'native' as const,
      scene3DOnly: true,
      maximumTextureSize: 4096,
    }, { transfer: [...transfers, ...packet.transfers] });
    expect(prepareGeometry(request, []).combined).toBeDefined();
    expect((geometry.attributes.position.values as Float64Array).buffer.byteLength).toBe(80000);
  });

  it('transfers Native 16-bit splits with typed attribute and index storage', () => {
    const vertexCount = 65538;
    const triangle = sourceGeometry();
    const positions = Float64Array.from({ length: vertexCount * 3 }, (_, index) => triangle.attributes.position.values[index % 9]);
    const geometry = new Geometry({
      attributes: {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        flags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: Uint8Array.from({ length: vertexCount }, (_, index) => (index % 3 + 1) * 2) }),
      } as Geometry['attributes'],
      indices: Uint32Array.from({ length: vertexCount }, (_, index) => index) as never,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.clone(triangle.boundingSphere),
    });
    const instances = [new GeometryInstance({ geometry, id: 'large-triangles' })];
    const packet = finish(createGeometryPacket([geometry]));
    const inputOwners: ArrayBuffer[] = [];
    const parameters = pipeline.packCombineGeometryParameters({
      createGeometryResults: [],
      instances,
      ellipsoid: Ellipsoid.WGS84,
      projection: new WebMercatorProjection(),
      elementIndexUintSupported: false,
      scene3DOnly: true,
      vertexCacheOptimize: false,
      compressVertices: false,
      modelMatrix: Matrix4.IDENTITY,
      createPickOffsets: true,
    }, inputOwners);
    const request = structuredClone({ parameters, geometries: packet.subTasks.map(task => task.geometry), layout: 'native' as const, scene3DOnly: true, maximumTextureSize: 4096 }, { transfer: [...inputOwners, ...packet.transfers] });
    const outputOwners: ArrayBuffer[] = [];
    const prepared = prepareGeometry(request, outputOwners);
    const received = structuredClone(prepared, { transfer: outputOwners });
    expect(outputOwners.every(buffer => buffer instanceof ArrayBuffer && buffer.byteLength === 0)).toBe(true);
    const output = pipeline.unpackCombineGeometryResults(received.combined).geometries;
    expect(output).toHaveLength(2);
    expect(output.reduce((total, part) => total + part.indices.length, 0)).toBe(vertexCount);
    for (const part of output) {
      const attributes = part.attributes as unknown as Record<string, GeometryAttribute>;
      // structuredClone returns arrays from Node's realm rather than jsdom's.
      expect(Object.prototype.toString.call(part.indices)).toBe('[object Uint16Array]');
      expect(Object.prototype.toString.call(attributes.position3DHigh.values)).toBe('[object Float32Array]');
      expect(Object.prototype.toString.call(attributes.position3DLow.values)).toBe('[object Float32Array]');
      expect(Object.prototype.toString.call(attributes.batchId.values)).toBe('[object Float32Array]');
      expect(Object.prototype.toString.call(attributes.flags.values)).toBe('[object Uint8Array]');
      expect(Array.from(attributes.flags.values.slice(0, 3))).toEqual([2, 4, 6]);
      expect(part.boundingSphere).toEqual(geometry.boundingSphere);
    }
    expect(positions.byteLength).toBe(vertexCount * 3 * 8);
    expect(instances[0].id).toBe('large-triangles');
  });

  it('yields chunk planning before inspecting the next 512-instance group', () => {
    const geometry = sourceGeometry();
    const lastGeometry = sourceGeometry();
    const position = lastGeometry.attributes.position;
    const inspectLast = vi.fn(() => position);
    Object.defineProperty(lastGeometry.attributes, 'position', { get: inspectLast, enumerable: true });
    const instances = Array.from({ length: 513 }, (_, index) => new GeometryInstance({ geometry: index === 512 ? lastGeometry : geometry }));
    const owner = new GeometryPrimitive({ geometryInstances: instances }, 'native');
    const frame = { mode: SceneMode.SCENE3D, mapProjection: new WebMercatorProjection(), scene3DOnly: true, context: { elementIndexUint: true }, commandList: [], afterRender: [] };
    const budget = { allowance: 0, deadline: 0, elapsed: 0, exhausted: true };
    try {
      updateGeometryWithBudget(frame, budget, () => owner.update(frame));
      expect(inspectLast).not.toHaveBeenCalled();
      expect(owner.hasRunnableIdlePreparation).toBe(true);
      owner.advancePreparation(frame, budget);
      expect(inspectLast).toHaveBeenCalled();
    }
    finally {
      owner.destroy();
    }
  });

  it('fills a queued Native batch with small owners while refusing an oversized raw copy', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const geometries = [sourceGeometry(), sourceGeometry(), sourceGeometry()];
    const oversized = sourceGeometry();
    const positions = new Float64Array(65538);
    oversized.attributes.position.values = positions;
    const owners = [...geometries, oversized, sourceGeometry()].map((geometry, index) => new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry, id: `batch-${index}` }), vertexCacheOptimize: false, compressVertices: false }, 'native'));
    const worker = { addEventListener() {}, removeEventListener() {}, terminate() {} };
    const batches: GeometryPrepareBatchRequest[] = [];
    const replies: Array<() => void> = [];
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (request, transfers) {
      Object.assign(this, { _worker: worker });
      const input = structuredClone(request, { transfer: transfers as ArrayBuffer[] }) as GeometryPrepareBatchRequest;
      batches.push(input);
      return new Promise(resolve => replies.push(() => {
        const outputs: ArrayBuffer[] = [];
        resolve(structuredClone(prepareGeometryBatch(input, outputs), { transfer: outputs }));
      }));
    });
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const copies = vi.spyOn(Float64Array.prototype, 'set');
    const metadata = vi.spyOn(pipeline, 'packCombineGeometryParameters');
    const frame = { mode: SceneMode.SCENE3D, mapProjection: new WebMercatorProjection(), scene3DOnly: true, context: { elementIndexUint: true }, commandList: [], afterRender: [] };
    const settle = async () => {
      for (let turn = 0; turn < 16; turn++) await Promise.resolve();
    };
    try {
      updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => owners[0].update(frame));
      await settle();
      expect(batches.map(batch => batch.requests.length)).toEqual([1]);
      updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => {
        owners[1].update(frame);
        owners[2].update(frame);
        owners[3].update(frame);
      });
      await settle();
      expect(batches.map(batch => batch.requests.length)).toEqual([1, 2]);
      expect(copies.mock.calls.some(([source]) => ArrayBuffer.isView(source) && source.buffer === positions.buffer)).toBe(false);
      expect(owners[3].hasRunnableIdlePreparation).toBe(false);
      updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => owners[4].update(frame));
      expect(metadata.mock.calls.some(([parameters]) => (parameters as { instances: GeometryInstance[] }).instances.some(instance => instance.id === 'batch-4'))).toBe(false);
      expect(owners[4].hasRunnableIdlePreparation).toBe(false);
      for (const reply of replies) reply();
      await settle();
      for (const owner of owners.slice(0, 3)) {
        expect((owner as unknown as { _combinedResult?: object })._combinedResult).toBeDefined();
        updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => owner.update(frame));
        expect((owner as unknown as { _geometries: Geometry[] })._geometries).toHaveLength(1);
      }
      for (const geometry of geometries)
        expect((geometry.attributes.position.values as Float64Array).buffer.byteLength).toBe(80000);
      expect(positions.byteLength).toBe(524304);
    }
    finally {
      for (const owner of owners) owner.destroy();
    }
  });

  it('transfers independent Native results around a failed owner in original batch order', () => {
    const geometries = [sourceGeometry(), sourceGeometry()];
    const buffers: ArrayBuffer[] = [];
    const requests = geometries.map((geometry, index) => {
      const packet = finish(createGeometryPacket([geometry]));
      const parameters = pipeline.packCombineGeometryParameters({
        createGeometryResults: [],
        instances: [new GeometryInstance({ geometry, id: `owner-${index}`, modelMatrix: Matrix4.fromTranslation(new Cartesian3(index * 10, 0, 0)) })],
        ellipsoid: Ellipsoid.WGS84,
        projection: new WebMercatorProjection(),
        elementIndexUintSupported: true,
        scene3DOnly: false,
        vertexCacheOptimize: false,
        compressVertices: false,
        modelMatrix: Matrix4.IDENTITY,
        createPickOffsets: true,
      }, buffers);
      buffers.push(...packet.transfers);
      return { parameters, geometries: packet.subTasks.map(task => task.geometry), layout: 'native' as const, scene3DOnly: false, maximumTextureSize: 4096 };
    });
    const expected = requests.map(request => structuredClone(prepareGeometry(structuredClone(request), [])));
    const input = structuredClone({ requests: [requests[0], { ...requests[0], geometries: [] }, requests[1]] }, { transfer: buffers });
    const outputs: ArrayBuffer[] = [];
    const packed = prepareGeometryBatch(input, outputs);
    expect(new Set(outputs).size).toBe(outputs.length);
    expect(outputs.length).toBeGreaterThan(0);
    const reply = structuredClone(packed, { transfer: outputs });
    expect(outputs.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(reply.results[0]).toEqual({ result: expected[0] });
    expect(reply.results[2]).toEqual({ result: expected[1] });
    expect(reply.results[1]).toEqual({ error: expect.objectContaining({ name: 'RangeError', message: expect.stringContaining('one geometry per instance') }) });
    for (const geometry of geometries)
      expect((geometry.attributes.position.values as Float64Array).buffer.byteLength).toBe(80000);
  });

  it('encloses actual decoded spatial centres without expanding the shared source sphere', () => {
    const positions = new Float64Array([65536.1, 0, 0, 65536.1, 0, 0]);
    const sphere = new BoundingSphere(new Cartesian3(65536.1, 0, 0), 0);
    const geometry = new Geometry({
      attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }) } as Geometry['attributes'],
      indices: new Uint16Array([0, 1]) as never,
      primitiveType: PrimitiveType.LINES,
      boundingSphere: sphere,
    });
    lineInputs.set(geometry, { positions, vertices: new Uint32Array([0, 1]), closed: false });
    const result = finish(prepareLineInstances([new GeometryInstance({ geometry })], new GeographicProjection(), true));
    const decoded = new Cartesian3(result.records.spatial[0] * 65536 + result.records.spatial[3], 0, 0);
    expect(decoded.x).not.toBe(positions[0]);
    const preparedSphere = result.instances[0].geometry.boundingSphere!;
    expect(Cartesian3.distance(decoded, preparedSphere.center)).toBeLessThanOrEqual(preparedSphere.radius);
    expect(preparedSphere).not.toBe(sphere);
    expect(sphere.radius).toBe(0);
    expect(geometry.boundingSphere).toBe(sphere);
  });

  it.each([
    [GeographicProjection, false, 'round', false],
    [WebMercatorProjection, false, 'miter', false],
    [WebMercatorProjection, true, 'round', false],
    [WebMercatorProjection, false, 'round', true],
  ] as const)('matches stock Native combine, line records and DOUBLE CV bounds %#', (Projection, scene3DOnly, join, dashed) => {
    const projection = new Projection();
    const coordinates = [[179.99, 30], [179.99, 30], [180.01, 30.01], [180.02, 30]];
    const geometry = createLineGeometry(Float64Array.from(coordinates.flatMap(([longitude, latitude]) => Cartesian3.pack(Cartesian3.fromDegrees(longitude, latitude), []))), {
      widthPx: 12,
      join,
      cap: 'round',
      miterLimit: 2,
      roundLimit: 1.05,
      ...(dashed ? { dashFrom: { y: 0, height: 1, width: 8 }, dashTo: { y: 2, height: 1, width: 12 } } : {}),
    }) as Geometry;
    const topology = lineInputs.get(geometry)!;
    lineInputs.set(geometry, { ...topology, longitudes: Float64Array.from([179.99, 180.01, 180.02], longitude => longitude * Math.PI / 180) });
    expect(topology.positions.length / 3).toBe(3);
    const source = structuredClone(topology);
    const instances = [Matrix4.IDENTITY, Matrix4.fromTranslation(new Cartesian3(1, 2, 3))].map((modelMatrix, index) => new GeometryInstance({ geometry, modelMatrix, id: `line-${index}` }));
    const metadata = (createGeometryResults: object[], preparedInstances = instances, transfers: ArrayBuffer[] = []) => pipeline.packCombineGeometryParameters({
      createGeometryResults,
      instances: preparedInstances,
      ellipsoid: Ellipsoid.WGS84,
      projection,
      elementIndexUintSupported: true,
      scene3DOnly: true,
      vertexCacheOptimize: false,
      compressVertices: false,
      modelMatrix: Matrix4.IDENTITY,
      createPickOffsets: true,
    }, transfers);
    const prepared = finish(prepareLineInstances(instances, projection, scene3DOnly));
    const reference = pipeline.combineGeometry(pipeline.unpackCombineGeometryParameters(metadata([pipeline.packCreateGeometryResults(prepared.instances.map(instance => instance.geometry), [])], prepared.instances)));
    for (const output of reference.geometries) finish(packAttributes(output, 'line'));
    if (prepared.spheresCV) {
      reference.boundingSpheresCV = prepared.spheresCV;
      const sphere = BoundingSphere.fromBoundingSpheres(prepared.spheresCV);
      for (const output of reference.geometries) output.boundingSphereCV = BoundingSphere.clone(sphere);
    }
    const expected = structuredClone(pipeline.packCombineGeometryResults(reference, []));
    const packet = finish(createGeometryPacket(instances.map(instance => instance.geometry), lineInputs));
    expect(packet.subTasks.every(task => task.geometry.attributes.position === undefined)).toBe(true);
    const transfers: ArrayBuffer[] = [];
    const parameters = metadata([], instances, transfers);
    const request = structuredClone({ parameters, geometries: packet.subTasks.map(task => task.geometry), lineInputs: packet.lineInputs, layout: 'line' as const, scene3DOnly, maximumTextureSize: 4096 }, { transfer: [...transfers, ...packet.transfers] });
    const outputOwners: ArrayBuffer[] = [];
    const result = structuredClone(prepareGeometry(request, outputOwners), { transfer: outputOwners });
    expect(result.combined).toEqual(expected);
    expect(result.linePositions).toEqual(structuredClone(finish(compileLinePositionTexture(prepared.records, 4096))));
    expect(result.lineBoundsCV && Array.from(result.lineBoundsCV)).toEqual(prepared.spheresCV && prepared.spheresCV.flatMap(sphere => BoundingSphere.pack(sphere, [])));
    if (result.lineBoundsCV) {
      expect(result.lineBoundsCV.BYTES_PER_ELEMENT).toBe(8);
      expect(result.lineBoundsCV[0]).toBeGreaterThan(19000000);
      expect(Math.fround(result.lineBoundsCV[0])).not.toBe(result.lineBoundsCV[0]);
    }
    expect(Array.from(topology.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(topology.vertices)).toEqual(Array.from(source.vertices));
    expect(topology.closed).toBe(source.closed);
    expect(geometry.attributes.position.values.byteLength).toBeGreaterThan(0);
    expect(instances.map(instance => instance.id)).toEqual(['line-0', 'line-1']);
    expect(instances[1].modelMatrix).toEqual(Matrix4.fromTranslation(new Cartesian3(1, 2, 3)));
  });

  it('rejects incompatible Native packets and respects the real Scene texture capability', () => {
    expect(() => prepareGeometry({ parameters: {}, geometries: [], layout: 'native', scene3DOnly: true, maximumTextureSize: 4096 }, [])).toThrow('Unsupported Cesium geometry instance packet');
    const records = { spatial: Float32Array.from({ length: 1200 }, (_, index) => index + 0.125) };
    expect(() => finish(compileLinePositionTexture(records, 1))).toThrow('exceeding Native');
    expect(finish(compileLinePositionTexture(records, 4096)).values.byteLength).toBeGreaterThan(0);
  });

  it.each([
    new Float32Array([0]),
    new Float64Array(),
    new Float64Array([-1]),
    new Float64Array([NaN]),
    new Float64Array([Number.MAX_SAFE_INTEGER]),
    new Float64Array([1]),
  ])('rejects incompatible instance metadata before Native allocates or unpacks it %#', (packedInstances) => {
    const unpack = vi.spyOn(pipeline, 'unpackCombineGeometryParameters');
    expect(() => prepareGeometry({ parameters: { packedInstances }, geometries: [], layout: 'native', scene3DOnly: true, maximumTextureSize: 4096 }, []))
      .toThrow('Unsupported Cesium geometry instance packet');
    expect(unpack).not.toHaveBeenCalled();
  });

  it('prepares already constructed Geometry with one Worker task and no Float64 create serialization', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const geometry = sourceGeometry();
    const original = new Float64Array(geometry.attributes.position.values);
    const matrices = [Matrix4.IDENTITY, Matrix4.fromTranslation(new Cartesian3(1, 2, 3))];
    const instances = matrices.map((modelMatrix, index) => new GeometryInstance({ geometry, modelMatrix, id: `pick-${index}` }));
    const owner = new GeometryPrimitive({ geometryInstances: instances, vertexCacheOptimize: false, compressVertices: false }, 'native');
    const referenceTransfers: ArrayBuffer[] = [];
    const referenceParameters = pipeline.packCombineGeometryParameters({
      createGeometryResults: [pipeline.packCreateGeometryResults([geometry, geometry], referenceTransfers)],
      instances,
      ellipsoid: Cesium.Ellipsoid.WGS84,
      projection: new WebMercatorProjection(),
      elementIndexUintSupported: true,
      scene3DOnly: false,
      vertexCacheOptimize: false,
      compressVertices: false,
      modelMatrix: Matrix4.IDENTITY,
      createPickOffsets: (owner as unknown as { _createPickOffsets: boolean })._createPickOffsets,
    }, []);
    const reference = structuredClone(pipeline.packCombineGeometryResults(pipeline.combineGeometry(pipeline.unpackCombineGeometryParameters(referenceParameters)), []));
    const worker = { addEventListener() {}, removeEventListener() {}, terminate() {} };
    const create = vi.spyOn(pipeline, 'packCreateGeometryResults');
    const schedule = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (request, transfers) {
      Object.assign(this, { _worker: worker });
      const input = structuredClone(request, { transfer: transfers as ArrayBuffer[] });
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(input, outputs);
      return Promise.resolve(structuredClone(result, { transfer: outputs }));
    });
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const frame = { mode: SceneMode.SCENE3D, mapProjection: new WebMercatorProjection(), scene3DOnly: false, context: { elementIndexUint: true }, commandList: [], afterRender: [] };
    try {
      updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => owner.update(frame));
      for (let turn = 0; turn < 16; turn++) await Promise.resolve();
      expect((owner as unknown as { _error?: unknown })._error).toBeUndefined();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect((owner as unknown as { _combinedResult: { combined: object } })._combinedResult.combined).toEqual(reference);
      expect(geometry.attributes.position.values).toEqual(original);
      expect((geometry.attributes.position.values as Float64Array).buffer.byteLength).toBe(80000);
      expect(instances.map(instance => instance.id)).toEqual(['pick-0', 'pick-1']);
      expect(instances.map(instance => instance.modelMatrix)).toEqual(matrices);
    }
    finally {
      owner.destroy();
    }
  });

  it('hands line projection to the Worker without doing it during main preparation', async () => {
    const geometry = createLineGeometry(new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(179.99, 30), []), ...Cartesian3.pack(Cartesian3.fromDegrees(180.01, 30.01), [])]), { widthPx: 12, join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05 }) as Geometry;
    const owner = new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry, id: 'line' }), appearance: new Appearance() }, 'line');
    const worker = { addEventListener() {}, removeEventListener() {}, terminate() {} };
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const project = vi.spyOn(WebMercatorProjection.prototype, 'project');
    const schedule = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    const frame = { mode: SceneMode.SCENE3D, mapProjection: new WebMercatorProjection(), scene3DOnly: false, context: { elementIndexUint: true }, commandList: [], afterRender: [] };
    try {
      updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => owner.update(frame));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(project).not.toHaveBeenCalled();
    }
    finally {
      owner.destroy();
    }
  });
});
