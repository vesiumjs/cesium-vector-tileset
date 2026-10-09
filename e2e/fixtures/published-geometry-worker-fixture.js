import * as Cesium from 'cesium';

const cdn = new URL(location.origin);
cdn.hostname = 'localhost';
const suffix = new URLSearchParams(location.search).get('minify') === 'true' ? '.min' : '';
const workerUrl = new URL(`/package/dist/geometry-worker${suffix}.mjs`, cdn);
const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl.href)};`], { type: 'application/javascript' }));
let processor;
let terminated = 0;
let taskCount = 0;
async function start() {
  try {
    const api = await import(new URL(`/package/dist/index${suffix}.mjs`, cdn).href);
    Cesium.buildModuleUrl.setBaseUrl(new URL('/cesium/', location.origin).href);
    const positions = [Cesium.Cartesian3.fromDegrees(179.98, 30), Cesium.Cartesian3.fromDegrees(179.99, 30.01)];
    const geometry = Cesium.PolylineGeometry.createGeometry(new Cesium.PolylineGeometry({ positions, width: 12, arcType: Cesium.ArcType.NONE }));
    const source = geometry.attributes.position.values;
    const original = Array.from(source);
    const topology = {
      positions: Float64Array.from(positions.flatMap(position => Cesium.Cartesian3.pack(position, []))),
      vertices: Uint32Array.from({ length: source.length / 3 }, (_, index) => {
        const point = Cesium.Cartesian3.unpack(source, index * 3);
        return Cesium.Cartesian3.distance(point, positions[0]) < 1 ? 0 : 1;
      }),
      longitudes: Float64Array.from([179.98, 179.99], longitude => longitude * Math.PI / 180),
      closed: false,
    };
    // This consumer owns exact logical copies; the real library's bounded packet
    // copier and full Native equivalence are exercised by the source seam tests.
    const attributes = Object.fromEntries(Object.entries(geometry.attributes).filter(([, attribute]) => attribute).map(([name, attribute]) => [name, { ...attribute, values: attribute.values.slice() }]));
    const owned = { ...geometry, attributes, indices: geometry.indices.slice() };
    const ownedTopology = { ...topology, positions: topology.positions.slice(), vertices: topology.vertices.slice(), longitudes: topology.longitudes.slice() };
    const transfers = [];
    const parameters = Cesium.PrimitivePipeline.packCombineGeometryParameters({
      createGeometryResults: [],
      instances: [new Cesium.GeometryInstance({ geometry })],
      ellipsoid: Cesium.Ellipsoid.WGS84,
      projection: new Cesium.WebMercatorProjection(),
      elementIndexUintSupported: true,
      scene3DOnly: true,
      vertexCacheOptimize: false,
      compressVertices: false,
      modelMatrix: Cesium.Matrix4.IDENTITY,
      createPickOffsets: true,
    }, transfers);
    transfers.push(...Object.values(attributes).map(attribute => attribute.values.buffer), owned.indices.buffer, ownedTopology.positions.buffer, ownedTopology.vertices.buffer, ownedTopology.longitudes.buffer);
    const worker = new Worker(bootstrap, { type: 'module' });
    const nativePost = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      taskCount++;
      nativePost(message, transfer);
    };
    const nativeTerminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminated++;
      nativeTerminate();
    };
    processor = new Cesium.TaskProcessor(workerUrl.href);
    processor._worker = worker;
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl)
      throw new Error('published Worker consumer requires real WebGL2 capabilities');
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const batch = await processor.scheduleTask({ requests: [{
      parameters,
      geometries: [owned],
      layout: 'line',
      lineInputs: [ownedTopology],
      scene3DOnly: false,
      maximumTextureSize,
    }] }, transfers);
    const entry = batch.results[0];
    if (entry.error)
      throw new Error(entry.error.message);
    const packed = entry.result;
    const combined = Cesium.PrimitivePipeline.unpackCombineGeometryResults(packed.combined);
    processor.destroy();
    processor = undefined;
    URL.revokeObjectURL(bootstrap);
    window.publishedGeometryResult = {
      mainConstructor: typeof api.CesiumVectorTileset === 'function',
      indices: Array.from(combined.geometries[0].indices),
      attributes: Object.keys(combined.geometries[0].attributes),
      textureBytes: packed.linePositions.values.byteLength,
      doubleBounds: packed.lineBoundsCV.BYTES_PER_ELEMENT === 8 && packed.lineBoundsCV[0] > 19000000 && Math.fround(packed.lineBoundsCV[0]) !== packed.lineBoundsCV[0],
      sourceIntact: source.byteLength > 0 && JSON.stringify(Array.from(source)) === JSON.stringify(original) && topology.positions.byteLength > 0,
      taskCount,
      detached: transfers.every(buffer => buffer.byteLength === 0),
      terminated,
      bootstrapRevoked: true,
    };
  }
  catch (error) {
    processor?.destroy();
    URL.revokeObjectURL(bootstrap);
    window.publishedGeometryResult = { error: String(error.stack ?? error) };
  }
}
void start();
