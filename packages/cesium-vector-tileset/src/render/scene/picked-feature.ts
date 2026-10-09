import type { PatternPrimitiveID, PatternTileRenderer } from '../pattern/pattern-renderer';
import type { RasterPrimitivePickObject, RasterTileRenderer } from '../raster/raster-renderer';
import type { TilePickObject } from '../vector/tile-conversion';
import type { TileResidency } from './tile-residency';

/**
 * Resolves a renderer-owned pick to the retained source feature generation.
 * @internal
 */
export function pickedFeature(
  pickObject: TilePickObject | RasterPrimitivePickObject | PatternPrimitiveID,
  raster: Pick<RasterTileRenderer, 'hasPickObject'>,
  pattern: Pick<PatternTileRenderer, 'hasPickObject'>,
  residency: Pick<TileResidency, 'featureIndex'>,
): { layerId: string; properties: Record<string, unknown> } | undefined {
  if ('type' in pickObject && pickObject.type === 'raster') {
    if (!raster.hasPickObject(pickObject)) {
      return undefined;
    }
    return { layerId: pickObject.layerId, properties: {} };
  }
  if ('type' in pickObject && pickObject.type === 'pattern'
    && !pattern.hasPickObject(pickObject)) {
    return undefined;
  }
  const vectorPickObject = pickObject as TilePickObject;
  const featureIndex = 'type' in pickObject && pickObject.type === 'pattern'
    ? pickObject.tileFeatureIndex
    : residency.featureIndex(vectorPickObject.tileId, vectorPickObject.generationId);
  if (!featureIndex) {
    return undefined;
  }
  const indexArray = featureIndex.featureIndexArray;
  let entry: ReturnType<typeof indexArray.get> | undefined;
  for (let i = 0; i < indexArray.length; i++) {
    const candidate = indexArray.get(i);
    const bucketLayerIds = featureIndex.bucketLayerIDs[candidate.bucketIndex] ?? [];
    if (candidate.featureIndex === vectorPickObject.featureIndex && bucketLayerIds.includes(vectorPickObject.layerId)) {
      entry = candidate;
      break;
    }
  }
  if (!entry) {
    return undefined;
  }
  const sourceLayerName = featureIndex.sourceLayerIds[entry.sourceLayerIndex];
  if (sourceLayerName === undefined) {
    return undefined;
  }
  const feature = featureIndex.features.getFeature(sourceLayerName, entry.featureIndex);
  if (!feature) {
    return undefined;
  }
  return {
    layerId: vectorPickObject.layerId,
    properties: feature.properties,
  };
}
