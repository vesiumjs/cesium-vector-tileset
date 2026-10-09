import type { MapProjection } from 'cesium';
import type { GeometryLayout } from './geometry-preparation';
import type { CanonicalLineInput, LineInput } from './line-input';
import type { LinePositionRecords } from './line-position-packing';
import * as Cesium from 'cesium';
import { BoundingSphere, Cartesian3, Cartographic, Math as CesiumMath, ComponentDatatype, Geometry, GeometryAttribute, GeometryInstance, Matrix4 } from 'cesium';
import { geometryBoundingSphere } from './geometry-bounds';
import { lineInputs } from './line-input';

const EncodedCartesian3 = (Cesium as unknown as { EncodedCartesian3: { encode: (value: number, result: { high: number; low: number }) => void } }).EncodedCartesian3;

function* projectedSourceLine(input: LineInput | CanonicalLineInput, projection: MapProjection, records: Float32Array, recordOffset: number, transformed: boolean): Generator<void, Float64Array> {
  const count = input.positions.length / 3;
  // Each final record has 48 bytes. Its first 24 bytes temporarily hold
  // DOUBLE xyz; the last 24 already hold the final FLOAT neighbour offsets.
  const source = new Float64Array(records.buffer, records.byteOffset + recordOffset * 48, input.positions.length * 2);
  const position = new Cartesian3();
  const cartographic = new Cartographic();
  const projected = new Cartesian3();
  for (let index = 0; index < count; index++) {
    Cartesian3.unpack(input.positions as unknown as number[], index * 3, position);
    const point = projection.ellipsoid.cartesianToCartographic(position, cartographic);
    if (!point)
      throw new TypeError('source line position cannot be projected to cartographic coordinates');
    if ('longitudes' in input) {
      const longitude = input.longitudes[index];
      point.longitude = transformed ? longitude + CesiumMath.negativePiToPi(point.longitude - longitude) : longitude;
    }
    projection.project(point, projected);
    Cartesian3.pack(projected, source as unknown as number[], index * 6);
    if (count > 32 && (index + 1) % 32 === 0)
      yield;
  }
  for (let point = 0; point < count; point++) {
    const prior = input.closed ? (point + count - 1) % count : Math.max(0, point - 1);
    const following = input.closed ? (point + 1) % count : Math.min(count - 1, point + 1);
    for (let component = 0; component < 3; component++) {
      const center = source[point * 6 + component];
      const offset = (recordOffset + point) * 12 + component;
      // The missing endpoint neighbour is mirrored after scene projection.
      // It has no original ECEF or source coordinate to inverse-project.
      records[offset + 6] = !input.closed && point === 0
        ? center - source[following * 6 + component]
        : source[prior * 6 + component] - center;
      records[offset + 9] = !input.closed && point === count - 1
        ? center - source[prior * 6 + component]
        : source[following * 6 + component] - center;
    }
    if (count > 32 && (point + 1) % 32 === 0)
      yield;
  }
  return source;
}

function* lineInstance(instance: GeometryInstance, projection: MapProjection, records: { spatial: Float32Array; planar?: Float32Array }, recordOffset: number): Generator<void, GeometryInstance> {
  const source = instance.geometry;
  const input = lineInputs.get(source);
  if (!input)
    throw new TypeError('line geometry requires source coordinates');
  let positions = input.positions;
  let sphere = source.boundingSphere;
  const transformed = !Matrix4.equals(instance.modelMatrix, Matrix4.IDENTITY);
  if (transformed) {
    // Native's multi-mode contract uses world coordinates. Transform only
    // owned source storage; the cached Geometry and caller's matrix survive.
    const world = new Float64Array(positions.length);
    const point = new Cartesian3();
    for (let index = 0; index < positions.length; index += 3) {
      Cartesian3.unpack(positions as unknown as number[], index, point);
      Matrix4.multiplyByPoint(instance.modelMatrix, point, point);
      Cartesian3.pack(point, world as unknown as number[], index);
      if (positions.length > 32 * 3 && (index / 3 + 1) % 32 === 0)
        yield;
    }
    positions = world;
    sphere = BoundingSphere.transform(sphere, instance.modelMatrix);
  }
  const pointCount = positions.length / 3;
  const projected = records.planar ? yield* projectedSourceLine({ ...input, positions }, projection, records.planar, recordOffset, transformed) : undefined;
  const sphereCV = projected ? yield* geometryBoundingSphere(projected, 6) : undefined;
  const centers = transformed || !source.attributes.position
    ? new Float64Array(input.vertices.length * 3)
    : source.attributes.position.values as Float64Array;
  const ids = new Float32Array(input.vertices.length);
  for (let vertex = 0; vertex < input.vertices.length; vertex++) {
    const point = input.vertices[vertex];
    ids[vertex] = recordOffset + point;
    if (transformed || !source.attributes.position) {
      for (let component = 0; component < 3; component++) centers[vertex * 3 + component] = positions[point * 3 + component];
    }
    if (input.vertices.length > 32 && (vertex + 1) % 32 === 0)
      yield;
  }
  const encoded = { high: 0, low: 0 };
  let maximumSpatialErrorSquared = 0;
  let maximumProjectionErrorSquared = 0;
  for (let point = 0; point < pointCount; point++) {
    const record = recordOffset + point;
    if (Math.fround(record) !== record)
      throw new RangeError('line position record ID exceeds exact FLOAT integer representation');
    const prior = input.closed ? (point + pointCount - 1) % pointCount : Math.max(0, point - 1);
    const following = input.closed ? (point + 1) % pointCount : Math.min(pointCount - 1, point + 1);
    // Read the DOUBLE planar scratch before overwriting it with final words.
    const planarX = projected?.[point * 6];
    const planarY = projected?.[point * 6 + 1];
    const planarZ = projected?.[point * 6 + 2];
    let projectionErrorSquared = 0;
    let spatialErrorSquared = 0;
    for (let component = 0; component < 3; component++) {
      const output = record * 12 + component;
      const center = positions[point * 3 + component];
      EncodedCartesian3.encode(center, encoded);
      records.spatial[output] = encoded.high === 0 ? 0 : encoded.high / 65536;
      records.spatial[output + 3] = encoded.low;
      const spatialDelta = records.spatial[output] * 65536 + records.spatial[output + 3] - center;
      spatialErrorSquared += spatialDelta * spatialDelta;
      const previous = !input.closed && point === 0 ? center + (center - positions[following * 3 + component]) : positions[prior * 3 + component];
      const next = !input.closed && point === pointCount - 1 ? center + (center - positions[prior * 3 + component]) : positions[following * 3 + component];
      records.spatial[output + 6] = previous - center;
      records.spatial[output + 9] = next - center;
      if (records.planar) {
        EncodedCartesian3.encode(component === 0 ? planarX : component === 1 ? planarY : planarZ, encoded);
        records.planar[output] = encoded.high === 0 ? 0 : encoded.high / 65536;
        records.planar[output + 3] = encoded.low;
        const delta = records.planar[output] * 65536 + records.planar[output + 3] - (component === 0 ? planarX : component === 1 ? planarY : planarZ);
        projectionErrorSquared += delta * delta;
      }
    }
    maximumProjectionErrorSquared = Math.max(maximumProjectionErrorSquared, projectionErrorSquared);
    maximumSpatialErrorSquared = Math.max(maximumSpatialErrorSquared, spatialErrorSquared);
    if (pointCount > 32 && (point + 1) % 32 === 0)
      yield;
  }
  if (sphereCV)
    sphereCV.radius += Math.sqrt(maximumProjectionErrorSquared);
  // Source bounds can belong to multiple layers/owners. Only the prepared
  // sphere encloses the actual high-FLOAT/low-FLOAT spatial reconstruction.
  sphere = BoundingSphere.clone(sphere);
  sphere.radius += Math.sqrt(maximumSpatialErrorSquared);
  const attributes = {
    ...source.attributes,
    position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: centers }),
    a_lineRecord: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: ids }),
  };
  const geometry = Object.assign(new Geometry({ attributes: attributes as Geometry['attributes'] }), source, { attributes, boundingSphere: sphere, boundingSphereCV: sphereCV });
  return Object.assign(new GeometryInstance({ geometry }), instance, { geometry, modelMatrix: Matrix4.clone(Matrix4.IDENTITY) });
}

/** Pack only the attributes consumed by the layout's explicit position shader. */
export function* packAttributes(geometry: Geometry, layout: GeometryLayout): Generator<void> {
  if (layout === 'native')
    return;
  const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
  // Native assigns each vertex its original instance index, including both
  // date-line halves. The constructor bounds those indices to 16 bits.
  const batchIds = new Uint16Array(attributes.batchId.values.length);
  for (let index = 0; index < batchIds.length; index++) {
    batchIds[index] = attributes.batchId.values[index];
    if (batchIds.length > 32 && (index + 1) % 32 === 0)
      yield;
  }
  attributes.batchId = new GeometryAttribute({
    componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
    componentsPerAttribute: 1,
    values: batchIds,
  });
  if (layout === 'line') {
    // Native needed the centres for batch IDs, cache reordering and bounds.
    // Rendering now reads immutable source records through a_lineRecord.
    for (const name of ['position3DHigh', 'position3DLow', 'position2DHigh', 'position2DLow'])
      delete attributes[name];
  }
}

export function* prepareLineInstances(instances: GeometryInstance[], projection: MapProjection, scene3DOnly: boolean): Generator<void, { instances: GeometryInstance[]; records: LinePositionRecords; spheresCV?: BoundingSphere[] }> {
  let recordCount = 0;
  for (const instance of instances) {
    const input = lineInputs.get(instance.geometry);
    if (!input)
      throw new TypeError('line geometry requires source coordinates');
    recordCount += input.positions.length / 3;
  }
  const records = { spatial: new Float32Array(recordCount * 12), planar: scene3DOnly ? undefined : new Float32Array(recordCount * 12) };
  const prepared: GeometryInstance[] = [];
  let recordOffset = 0;
  for (const instance of instances) {
    prepared.push(yield* lineInstance(instance, projection, records, recordOffset));
    recordOffset += lineInputs.get(instance.geometry).positions.length / 3;
  }
  return { instances: prepared, records, spheresCV: records.planar ? prepared.map(instance => (instance.geometry as Geometry & { boundingSphereCV: BoundingSphere }).boundingSphereCV) : undefined };
}
