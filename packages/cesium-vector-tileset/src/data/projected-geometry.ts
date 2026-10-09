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

/** Original polygon rings, with views into the bucket's packed outline storage. */
export interface FillOutlinePath {
  readonly positions: Float64Array;
  readonly tilePositions: Float64Array;
  readonly closed: boolean;
}

export interface LinePrimitiveGeometry {
  positions: Float64Array;
  tilePositions: Float64Array;
  featureIndex: number;
  /** Solid globe strip prepared for this exact source and layout. */
  prepared?: PreparedLineGeometry;
}

/** Immutable strip data; Cesium wrappers remain local to the scene thread. */
export interface PreparedLineGeometry {
  layoutKey: string;
  originalPositions: Float64Array;
  originalTilePositions: Float64Array;
  positions: Float64Array;
  flags: Uint8Array;
  indices: Uint16Array | Uint32Array;
  sourcePositions: Float64Array;
  sourceVertices: Uint32Array;
  longitudes: Float64Array;
  bounds: Float64Array;
  closed: boolean;
}

export interface CirclePrimitiveGeometry {
  position: [number, number, number];
  featureIndex: number;
}

/** Geometry owned by a bucket, projected on the worker before channel transfer. */
export interface ProjectedGeometryList<T> extends Iterable<T> {
  readonly length: number;
  /** Materialize a stable immutable view only when the primitive is consumed. */
  get: (index: number) => T;
}

export interface ProjectedBucketGeometry {
  fill?: ProjectedGeometryList<FillPrimitiveGeometry>;
  /** Polygon-indexed subdivided rings shared by globe/morph family layers. */
  fillOutlines?: ProjectedGeometryList<readonly FillOutlinePath[]>;
  /** Original unsampled rings shared by planar family layers. */
  fillPlanarOutlines?: ProjectedGeometryList<readonly FillOutlinePath[]>;
  lines?: ProjectedGeometryList<LinePrimitiveGeometry>;
  circles?: ProjectedGeometryList<CirclePrimitiveGeometry>;
}
