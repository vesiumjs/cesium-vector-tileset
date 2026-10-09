import type { Geometry } from 'cesium';

/** Cached source topology is copied with owned geometry before Worker preparation. */
export interface LineInput {
  positions: Float64Array;
  vertices: Uint32Array;
  closed: boolean;
}

export interface CanonicalLineInput extends LineInput {
  longitudes: Float64Array;
}

/** Geometry producers and upload preparation share topology without a Scene dependency. */
export const lineInputs = new WeakMap<Geometry, CanonicalLineInput | LineInput>();
