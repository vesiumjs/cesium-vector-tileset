import type { BoundingSphere, Geometry, GeometryInstance, MapProjection, Matrix4 } from 'cesium';
import * as Cesium from 'cesium';

interface CreatedGeometry {
  packedData: Float64Array;
}

interface CombineOptions {
  ellipsoid: MapProjection['ellipsoid'];
  projection: MapProjection;
  elementIndexUintSupported: boolean;
  scene3DOnly: boolean;
  vertexCacheOptimize: boolean;
  compressVertices: boolean;
  modelMatrix: Matrix4;
  createPickOffsets?: boolean;
}

interface CombineInput extends CombineOptions {
  createGeometryResults: CreatedGeometry[];
  instances: GeometryInstance[];
}

interface UnpackedCombineInput extends CombineOptions {
  instances: GeometryInstance[];
}

export interface CombinedGeometry extends Geometry {
  boundingSphereCV?: BoundingSphere;
}

interface CombineResult {
  geometries?: CombinedGeometry[];
  modelMatrix: Matrix4;
  pickOffsets: unknown;
  offsetInstanceExtend: unknown;
  boundingSpheres: Array<BoundingSphere | undefined>;
  boundingSpheresCV: Array<BoundingSphere | undefined>;
}

/** Runtime contracts omitted from Cesium's public TypeScript declarations. */
interface CesiumGeometryRuntime {
  ContextLimits: { maximumTextureSize: number };
  PrimitivePipeline: {
    packCombineGeometryParameters: (parameters: CombineInput, transfers: ArrayBuffer[]) => object;
    unpackCombineGeometryParameters: (parameters: object) => UnpackedCombineInput;
    combineGeometry: (parameters: UnpackedCombineInput) => CombineResult;
    packCombineGeometryResults: (result: CombineResult, transfers: ArrayBuffer[]) => object;
    unpackCombineGeometryResults: (result: object) => CombineResult;
  };
  PrimitiveState: { CREATING: number; COMBINING: number; COMBINED: number; COMPLETE: number; FAILED: number };
}

export const primitivePipeline = (Cesium as unknown as CesiumGeometryRuntime).PrimitivePipeline;
export const primitiveState = (Cesium as unknown as CesiumGeometryRuntime).PrimitiveState;
export const geometryContextLimits = (Cesium as unknown as CesiumGeometryRuntime).ContextLimits;
