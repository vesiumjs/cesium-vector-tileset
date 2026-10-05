import type { Geometry } from 'cesium';

/**
 * Cesium declares `Geometry.indices` as `any[]` although it holds a
 * `Uint16Array | Uint32Array` at runtime, and attribute `values` is typed
 * `any`. Read `byteLength` structurally so the size stays a number without
 * casting a typed array to an array type it never is.
 */
function viewByteLength(view: unknown): number {
  const byteLength = (view as { byteLength?: unknown } | undefined)?.byteLength;
  return typeof byteLength === 'number' ? byteLength : 0;
}

/**
 * CPU-retained size of a Cesium geometry: the typed arrays the GPU upload
 * was fed from. A monotonic proxy for GPU cost (not a GL meter): shared
 * textures/materials are owned once elsewhere and never counted here.
 */
export function geometryBytes(geometry: Pick<Geometry, 'attributes' | 'indices'>): number {
  let bytes = 0;
  for (const name in geometry.attributes) {
    bytes += viewByteLength(geometry.attributes[name]?.values);
  }
  bytes += viewByteLength(geometry.indices);
  return bytes;
}
