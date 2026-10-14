import type { InterpolationType } from '@maplibre/maplibre-gl-style-spec';
import type { PossiblyEvaluatedPropertyValue, PropertyValue } from '../style/properties';
import { Interpolate, interpolates } from '@maplibre/maplibre-gl-style-spec';
import { Math as CesiumMath } from 'cesium';

import { EvaluationParameters } from '../style/evaluation-parameters';

const MAX_GLYPH_ICON_SIZE = 255;
const SIZE_PACK_FACTOR = 128;
const MAX_PACKED_SIZE: number = MAX_GLYPH_ICON_SIZE * SIZE_PACK_FACTOR;

export type SizeData = {
  kind: 'constant';
  layoutSize: number;
} | {
  kind: 'source';
} | {
  kind: 'camera';
  zoomStops: number[];
  sizes: number[];
  layoutSize: number;
  interpolationType: InterpolationType;
} | {
  kind: 'composite';
  minZoom: number;
  maxZoom: number;
  interpolationType: InterpolationType;
};

export interface EvaluatedZoomSize { uSizeT: number; uSize: number }

// For {text,icon}-size, get the bucket-level data that will be needed by
// the painter to set symbol-size-related uniforms
function getSizeData(
  tileZoom: number,
  value: PropertyValue<number, PossiblyEvaluatedPropertyValue<number>>,
): SizeData {
  const { expression } = value;

  if (expression.kind === 'constant') {
    const layoutSize = expression.evaluate(new EvaluationParameters(tileZoom + 1));
    return { kind: 'constant', layoutSize };
  }
  else if (expression.kind === 'source') {
    return { kind: 'source' };
  }
  else {
    const { zoomStops, interpolationType } = expression;

    if (expression.kind === 'composite') {
      // Feature endpoints cover the tile's layout interval; camera functions
      // retain every stop so overzoom can select the actual drawn interval.
      let lower = 0;
      while (lower < zoomStops.length && zoomStops[lower] <= tileZoom) lower++;
      lower = Math.max(0, lower - 1);
      let upper = lower;
      while (upper < zoomStops.length && zoomStops[upper] < tileZoom + 1) upper++;
      upper = Math.min(zoomStops.length - 1, upper);
      return { kind: 'composite', minZoom: zoomStops[lower], maxZoom: zoomStops[upper], interpolationType };
    }

    const sizes = zoomStops.map(zoomStop => expression.evaluate(new EvaluationParameters(
      zoomStop === -Infinity ? zoomStops[1] - 1 : zoomStop,
    )));
    const layoutSize = expression.evaluate(new EvaluationParameters(tileZoom + 1));
    return { kind: 'camera', zoomStops, sizes, layoutSize, interpolationType };
  }
}

function evaluateSizeForFeature(sizeData: SizeData, {
  uSize,
  uSizeT,
}: {
  uSize: number;
  uSizeT: number;
}, {
  lowerSize,
  upperSize,
}: {
  lowerSize: number;
  upperSize: number;
}): number {
  if (sizeData.kind === 'source') {
    return lowerSize / SIZE_PACK_FACTOR;
  }
  else if (sizeData.kind === 'composite') {
    return interpolates.number(lowerSize / SIZE_PACK_FACTOR, upperSize / SIZE_PACK_FACTOR, uSizeT);
  }
  return uSize;
}

function evaluateSizeForZoom(sizeData: SizeData, zoom: number): EvaluatedZoomSize {
  let uSizeT = 0;
  let uSize = 0;

  if (sizeData.kind === 'constant') {
    uSize = sizeData.layoutSize;
  }
  else if (sizeData.kind === 'camera') {
    const { zoomStops, sizes, layoutSize, interpolationType } = sizeData;
    let lower = zoomStops.length - 1;
    while (lower > 0 && zoomStops[lower] > zoom) lower--;
    const upper = Math.min(lower + 1, zoomStops.length - 1);
    const t = !interpolationType
      ? 0
      : CesiumMath.clamp(
          Interpolate.interpolationFactor(interpolationType, zoom, zoomStops[lower], zoomStops[upper]),
          0,
          1,
        );
    // The worker collision boxes were built at layoutSize. Drawing larger
    // than that would allow labels to overlap (MapLibre 6.14 semantics).
    uSize = Math.min(interpolates.number(sizes[lower], sizes[upper], t), layoutSize);
  }
  else if (sizeData.kind === 'composite') {
    const { interpolationType, minZoom, maxZoom } = sizeData;
    uSizeT = !interpolationType
      ? 0
      : CesiumMath.clamp(
          Interpolate.interpolationFactor(interpolationType, zoom, minZoom, maxZoom),
          0,
          1,
        );
  }

  return { uSizeT, uSize };
}

export { evaluateSizeForFeature, evaluateSizeForZoom, getSizeData, MAX_GLYPH_ICON_SIZE, MAX_PACKED_SIZE, SIZE_PACK_FACTOR };
