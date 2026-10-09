import type { PreparedLineGeometry } from '../../data/projected-geometry';
import type { CanonicalTileID } from '../../tile/tile-id';
import type { LineGeometryOptions, LineGeometrySource } from './line-geometry';
import { BoundingSphere, Cartesian3, ComponentDatatype, Geometry, GeometryAttribute, PrimitiveType } from 'cesium';
import { lineInputs } from '../geometry/line-input';
import { createLineGeometry, lineLayoutKey } from './line-geometry';

const geometries = new WeakMap<PreparedLineGeometry, Geometry>();

/** Worker compilation has no atlas or scene projection dependency. */
export function prepareLineGeometry(source: LineGeometrySource, options: LineGeometryOptions, tileID: CanonicalTileID): PreparedLineGeometry {
  if (options.dashFrom || options.dashTo)
    throw new TypeError('worker line preparation requires a solid layout');
  const geometry = createLineGeometry(source.positions, options, false, { tileID, tilePositions: source.tilePositions });
  const input = geometry && lineInputs.get(geometry);
  if (geometry && (!input || !('longitudes' in input)))
    throw new TypeError('prepared line geometry requires canonical source records');
  const sphere = geometry?.boundingSphere;
  return {
    layoutKey: lineLayoutKey(options),
    originalPositions: source.positions,
    originalTilePositions: source.tilePositions,
    positions: geometry ? geometry.attributes.position!.values as Float64Array : new Float64Array(),
    flags: geometry ? (geometry.attributes as unknown as Record<string, GeometryAttribute>).a_lineFlags.values as Uint8Array : new Uint8Array(),
    indices: geometry ? geometry.indices as unknown as Uint16Array | Uint32Array : new Uint16Array(),
    sourcePositions: input?.positions ?? new Float64Array(),
    sourceVertices: input?.vertices ?? new Uint32Array(),
    longitudes: input && 'longitudes' in input ? input.longitudes : new Float64Array(),
    bounds: sphere ? new Float64Array([sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius]) : new Float64Array(4),
    closed: input?.closed ?? false,
  };
}

/** Repeated publications share the same completed immutable Geometry wrapper. */
export function restorePreparedLineGeometry(prepared: PreparedLineGeometry): Geometry | undefined {
  if (!prepared.flags.length)
    return undefined;
  let geometry = geometries.get(prepared);
  if (!geometry) {
    geometry = new Geometry({
      attributes: {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: prepared.positions }),
        a_lineFlags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: prepared.flags }),
      } as unknown as Geometry['attributes'],
      indices: prepared.indices as never,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: new BoundingSphere(new Cartesian3(prepared.bounds[0], prepared.bounds[1], prepared.bounds[2]), prepared.bounds[3]),
    });
    lineInputs.set(geometry, { positions: prepared.sourcePositions, vertices: prepared.sourceVertices, longitudes: prepared.longitudes, closed: prepared.closed });
    geometries.set(prepared, geometry);
  }
  return geometry;
}
