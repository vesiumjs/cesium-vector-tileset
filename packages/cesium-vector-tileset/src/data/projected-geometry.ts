/** Local projected geometry, independent of Cesium objects. */
export interface FillPrimitiveGeometry {
  positions: Float64Array;
  ringVertexCount: number;
  holes: number[];
  triangles: Uint32Array;
  /** Source polygon and subdivision used to build this mesh. */
  polygonIndex: number;
  subdivision: number;
  featureIndex: number;
}

export interface FillPatternGeometry extends FillPrimitiveGeometry {
  tilePositions: Float64Array;
}

/** Lazily projected original polygon rings, independent of the fill mesh. */
export interface FillOutlinePath {
  positions: Float64Array;
  tilePositions: Float64Array;
  closed: boolean;
}

export interface LinePrimitiveGeometry {
  positions: Float64Array;
  tilePositions: Float64Array;
  featureIndex: number;
}

export interface CirclePrimitiveGeometry {
  position: [number, number, number];
  featureIndex: number;
}

/** Geometry owned by a bucket, projected on the worker before channel transfer. */
export interface ProjectedBucketGeometry {
  fill?: FillPrimitiveGeometry[];
  lines?: LinePrimitiveGeometry[];
  circles?: CirclePrimitiveGeometry[];
}
