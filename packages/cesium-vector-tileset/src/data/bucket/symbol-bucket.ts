import type Point from '@mapbox/point-geometry';

import type { VectorTileFeature } from '../../source/vector-tile-data';
import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import type { Anchor } from '../../symbol/anchor';
import type { SymbolQuad } from '../../symbol/quads';
import type { CanonicalTileID } from '../../tile/tile-id';
import type { StructArray } from '../../util/struct-array';
import type { CollisionBoxArray } from '../array-types.g';
import type {
  BucketParameters,
  IndexedFeature,
  PopulateParameters,
} from '../bucket';
import { VectorTileFeature as MapboxVectorTileFeature } from '@mapbox/vector-tile';

import { Formatted, ResolvedImage } from '@maplibre/maplibre-gl-style-spec';
import { rtlWorkerPlugin } from '../../source/rtl-text-plugin-worker';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { getOverlapMode } from '../../style/style-layer/overlap-mode';
import { mergeLines } from '../../symbol/merge-lines';
import { allowsVerticalWritingMode, stringContainsRTLText } from '../../symbol/script-detection';
import { WritingMode } from '../../symbol/shaping';
import { getSizeData, MAX_PACKED_SIZE } from '../../symbol/symbol-size';
import { transformText } from '../../symbol/transform-text';
import { verticalizedCharacterMap } from '../../symbol/verticalize-punctuation';
import { GlyphOffsetArray, SymbolInstanceArray, SymbolLineVertexArray, TextAnchorOffsetArray } from '../array-types.g';
import { SymbolBucket as SymbolBucketRuntime, SymbolBuffers } from '../bucket-runtime';
import { toEvaluationFeature } from '../evaluation-feature';
import { loadGeometry } from '../load-geometry';
import { ProgramConfigurationSet } from '../program-configuration';

export interface SymbolFeature {
  sortKey: number | void;
  text: Formatted | void;
  icon: ResolvedImage;
  index: number;
  sourceLayerIndex: number;
  geometry: Point[][];
  properties: VectorTileFeature['properties'];
  type: 'Unknown' | 'Point' | 'LineString' | 'Polygon';
  id?: number | string;
}

export interface SortKeyRange {
  sortKey: number;
  symbolInstanceStart: number;
  symbolInstanceEnd: number;
}

function addVertex(
  array: StructArray,
  anchorX: number,
  anchorY: number,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  sizeVertex: [number, number] | undefined,
  isSDF: boolean,
  pixelOffsetX: number,
  pixelOffsetY: number,
  minFontScaleX: number,
  minFontScaleY: number,
) {
  const aSizeX = sizeVertex ? Math.min(MAX_PACKED_SIZE, Math.round(sizeVertex[0])) : 0;
  const aSizeY = sizeVertex ? Math.min(MAX_PACKED_SIZE, Math.round(sizeVertex[1])) : 0;
  array.emplaceBack(
    // a_pos_offset
    anchorX,
    anchorY,
    Math.round(ox * 32),
    Math.round(oy * 32),

    // a_data
    tx, // x coordinate of symbol on glyph atlas texture
    ty, // y coordinate of symbol on glyph atlas texture
    (aSizeX << 1) + (isSDF ? 1 : 0),
    aSizeY,
    pixelOffsetX * 16,
    pixelOffsetY * 16,
    minFontScaleX * 256,
    minFontScaleY * 256,
  );
}

function containsRTLText(formattedText: Formatted): boolean {
  for (const section of formattedText.sections) {
    if (stringContainsRTLText(section.text)) {
      return true;
    }
  }
  return false;
}

/**
 * Unlike other buckets, which simply implement `addFeature` with type-specific
 * logic for (essentially) triangulating feature geometries, SymbolBucket
 * requires specialized behavior:
 * 1. WorkerTile.parse(), the logical owner of the bucket creation process,
 *    calls SymbolBucket.populate(), which resolves text and icon tokens on
 *    each feature, adds each glyphs and symbols needed to the passed-in
 *    collections options.glyphDependencies and options.iconDependencies, and
 *    stores the feature data for use in subsequent step (this.features).
 * 2. WorkerTile asynchronously requests from the main thread all of the glyphs
 *    and icons needed (by this bucket and any others). When glyphs and icons
 *    have been received, the WorkerTile creates a CollisionIndex and invokes:
 * 3. performSymbolLayout(bucket, stacks, icons) perform texts shaping and
 *    layout on a Symbol Bucket. This step populates:
 *      `this.symbolInstances`: metadata on generated symbols
 *      `this.collisionBoxArray`: collision data for use by foreground
 *      `this.text`: SymbolBuffers for text symbols
 *      `this.icons`: SymbolBuffers for icons
 *    The results are sent to the foreground for rendering
 * 4. The Cesium backend extracts static geometry and creates dynamic displacement
 *    and opacity channels for each render generation. Its placement pass uses
 *    collision data and current camera settings to update those channels before
 *    the symbol renderer uploads them to Cesium's vertex buffers.
 * @internal
 */
export class SymbolBucket extends SymbolBucketRuntime {
  static MAX_GLYPHS: number;

  collisionBoxArray: CollisionBoxArray;
  overscaling: number;
  iconsInText: boolean;
  iconsNeedLinear: boolean;
  features: SymbolFeature[];
  textAnchorOffsets: TextAnchorOffsetArray;
  sortKeyRanges: SortKeyRange[];
  pixelRatio: number;
  compareText: { [_: string]: Point[] };
  sortFeaturesByKey: boolean;
  canOverlap: boolean;

  sourceLayerIndex: number;
  sourceID: string;
  writingModes: WritingMode[];
  allowVerticalPlacement: boolean;
  availableImages?: string[];

  constructor(options: BucketParameters<SymbolStyleLayer>) {
    super();
    this.availableImages = options.availableImages;
    this.collisionBoxArray = options.collisionBoxArray;
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;
    this.layers = options.layers;
    this.layerIds = this.layers.map(layer => layer.id);
    this.index = options.index;
    this.pixelRatio = options.pixelRatio;
    this.sourceLayerIndex = options.sourceLayerIndex;
    this.sourceID = options.sourceID;
    this.hasDependencies = false;
    this.hasRTLText = false;
    this.justReloaded = false;
    this.iconsInText = false;
    this.iconsNeedLinear = false;
    this.tilePixelRatio = 0;
    this.compareText = {};
    this.features = [];
    this.stateDependentLayers = [];
    this.writingModes = [];
    this.allowVerticalPlacement = false;
    this.sortKeyRanges = [];

    const layer = this.layers[0];
    if (!layer) {
      throw new Error('A symbol bucket must contain at least one style layer');
    }
    const unevaluatedLayoutValues = layer._unevaluatedLayout._values;

    this.textSizeData = getSizeData(this.zoom, unevaluatedLayoutValues['text-size']);
    this.iconSizeData = getSizeData(this.zoom, unevaluatedLayoutValues['icon-size']);

    const layout = this.layers[0].layout;
    const sortKey = layout.get('symbol-sort-key');
    const zOrder = layout.get('symbol-z-order');
    this.canOverlap
      = getOverlapMode(layout, 'text-overlap', 'text-allow-overlap') !== 'never'
        || getOverlapMode(layout, 'icon-overlap', 'icon-allow-overlap') !== 'never'
        || layout.get('text-ignore-placement')
        || layout.get('icon-ignore-placement');
    this.sortFeaturesByKey = zOrder !== 'viewport-y' && !sortKey.isConstant();

    if (layout.get('symbol-placement') === 'point') {
      this.writingModes = layout.get('text-writing-mode').map(wm => WritingMode[wm]);
    }

    this.stateDependentLayerIds = this.layers.filter(l => l.isStateDependent()).map(l => l.id);

    this.text = new SymbolBuffers(new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('text')));
    this.icon = new SymbolBuffers(new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('icon')));
    this.glyphOffsetArray = new GlyphOffsetArray();
    this.lineVertexArray = new SymbolLineVertexArray();
    this.symbolInstances = new SymbolInstanceArray();
    this.textAnchorOffsets = new TextAnchorOffsetArray();
  }

  createArrays(): void {
    this.text = new SymbolBuffers(new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('text')));
    this.icon = new SymbolBuffers(new ProgramConfigurationSet(this.layers, this.zoom, property => property.startsWith('icon')));

    this.glyphOffsetArray = new GlyphOffsetArray();
    this.lineVertexArray = new SymbolLineVertexArray();
    this.symbolInstances = new SymbolInstanceArray();
    this.textAnchorOffsets = new TextAnchorOffsetArray();
  }

  private calculateGlyphDependencies(
    text: string,
    stack: { [_: number]: boolean },
    textAlongLine: boolean,
    allowVerticalPlacement: boolean,
    doesAllowVerticalWritingMode: boolean,
  ): void {
    for (const char of text) {
      stack[char.codePointAt(0)] = true;
      if ((textAlongLine || allowVerticalPlacement) && doesAllowVerticalWritingMode) {
        const verticalChar = verticalizedCharacterMap[char];
        if (verticalChar) {
          stack[verticalChar.codePointAt(0)] = true;
        }
      }
    }
  }

  populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
    const layer = this.layers[0];
    const layout = layer.layout;

    const textFont = layout.get('text-font');
    const textField = layout.get('text-field');
    const iconImage = layout.get('icon-image');
    const hasText
      = (textField.value.kind !== 'constant'
        || (textField.value.value instanceof Formatted && !textField.value.value.isEmpty())
        || textField.value.value.toString().length > 0)
      && (textFont.value.kind !== 'constant' || textFont.value.value.length > 0);
    // we should always resolve the icon-image value if the property was defined in the style
    // this allows us to fire the styleimagemissing event if image evaluation returns null
    // the only way to distinguish between null returned from a coalesce statement with no valid images
    // and null returned because icon-image wasn't defined is to check whether or not iconImage.parameters is an empty object
    const hasIcon = iconImage.value.kind !== 'constant' || !!iconImage.value.value || Object.keys(iconImage.parameters).length > 0;
    const symbolSortKey = layout.get('symbol-sort-key');

    this.features = [];

    if (!hasText && !hasIcon) {
      return;
    }

    const icons = options.iconDependencies;
    const stacks = options.glyphDependencies;
    const availableImages = options.availableImages;
    const globalProperties = new EvaluationParameters(this.zoom);

    for (const { feature, id, index, sourceLayerIndex } of features) {
      const needGeometry = layer._featureFilter.needGeometry;
      const evaluationFeature = toEvaluationFeature(feature, needGeometry);
      if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical)) {
        continue;
      }

      if (!needGeometry)
        evaluationFeature.geometry = loadGeometry(feature);

      let text: Formatted | void;
      if (hasText) {
        // Expression evaluation will automatically coerce to Formatted
        // but plain string token evaluation skips that pathway so do the
        // conversion here.
        const resolvedTokens = layer.getValueAndResolveTokens('text-field', evaluationFeature, canonical, availableImages);
        const formattedText = Formatted.factory(resolvedTokens);

        // on this instance: if hasRTLText is already true, all future calls to containsRTLText can be skipped.
        this.hasRTLText ||= containsRTLText(formattedText);
        if (
          !this.hasRTLText // non-rtl text so can proceed safely
          || rtlWorkerPlugin.getRTLTextPluginStatus() === 'unavailable' // We don't intend to lazy-load the rtl text plugin, so proceed with incorrect shaping
          || (this.hasRTLText && rtlWorkerPlugin.isParsed()) // Use the rtlText plugin to shape text
        ) {
          text = transformText(formattedText, layer, evaluationFeature);
        }
      }

      let icon: ResolvedImage;
      if (hasIcon) {
        // Expression evaluation will automatically coerce to Image
        // but plain string token evaluation skips that pathway so do the
        // conversion here.
        const resolvedTokens = layer.getValueAndResolveTokens('icon-image', evaluationFeature, canonical, availableImages);
        if (resolvedTokens instanceof ResolvedImage) {
          icon = resolvedTokens;
        }
        else {
          icon = ResolvedImage.fromString(resolvedTokens);
        }
      }

      if (!text && !icon) {
        continue;
      }
      const sortKey = this.sortFeaturesByKey
        ? symbolSortKey.evaluate(evaluationFeature, {}, canonical)
        : undefined;

      const symbolFeature: SymbolFeature = {
        id,
        text,
        icon,
        index,
        sourceLayerIndex,
        geometry: evaluationFeature.geometry,
        properties: feature.properties,
        type: MapboxVectorTileFeature.types[feature.type],
        sortKey,
      };
      this.features.push(symbolFeature);

      if (icon) {
        icons[icon.name] = true;
      }

      if (text) {
        const fontStack = textFont.evaluate(evaluationFeature, {}, canonical).join(',');
        const textAlongLine = layout.get('text-rotation-alignment') !== 'viewport' && layout.get('symbol-placement') !== 'point';
        this.allowVerticalPlacement = this.writingModes?.includes(WritingMode.vertical);
        for (const section of text.sections) {
          if (!section.image) {
            const doesAllowVerticalWritingMode = allowsVerticalWritingMode(text.toString());
            const sectionFont = section.fontStack || fontStack;
            stacks[sectionFont] ||= {};
            this.calculateGlyphDependencies(section.text, stacks[sectionFont], textAlongLine, this.allowVerticalPlacement, doesAllowVerticalWritingMode);
          }
          else {
            // Add section image to the list of dependencies.
            icons[section.image.name] = true;
          }
        }
      }
    }

    if (layout.get('symbol-placement') === 'line') {
      // Merge adjacent lines with the same text to improve labeling.
      // It's better to place labels on one long line than on many short segments.
      this.features = mergeLines(this.features);
    }

    if (this.sortFeaturesByKey) {
      this.features.sort((a, b) => {
        // a.sortKey is always a number when sortFeaturesByKey is true
        return (a.sortKey as number) - (b.sortKey as number);
      });
    }
  }

  addToLineVertexArray(anchor: Anchor, line: Point[]): { lineStartIndex: number; lineLength: number } {
    const lineStartIndex = this.lineVertexArray.length;
    if (anchor.segment !== undefined) {
      let sumForwardLength = anchor.dist(line[anchor.segment + 1]);
      let sumBackwardLength = anchor.dist(line[anchor.segment]);
      const vertices = {};
      for (let i = anchor.segment + 1; i < line.length; i++) {
        vertices[i] = { x: line[i].x, y: line[i].y, tileUnitDistanceFromAnchor: sumForwardLength };
        if (i < line.length - 1) {
          sumForwardLength += line[i + 1].dist(line[i]);
        }
      }
      for (let i = anchor.segment || 0; i >= 0; i--) {
        vertices[i] = { x: line[i].x, y: line[i].y, tileUnitDistanceFromAnchor: sumBackwardLength };
        if (i > 0) {
          sumBackwardLength += line[i - 1].dist(line[i]);
        }
      }
      for (let i = 0; i < line.length; i++) {
        const vertex = vertices[i];
        this.lineVertexArray.emplaceBack(vertex.x, vertex.y, vertex.tileUnitDistanceFromAnchor);
      }
    }
    const result: { lineStartIndex: number; lineLength: number } = {
      lineStartIndex,
      lineLength: this.lineVertexArray.length - lineStartIndex,
    };
    return result;
  }

  addSymbols(arrays: SymbolBuffers, quads: SymbolQuad[], sizeVertex: any, lineOffset: [number, number], alongLine: boolean, feature: SymbolFeature, writingMode: WritingMode, labelAnchor: Anchor, lineStartIndex: number, lineLength: number, associatedIconIndex: number, canonical: CanonicalTileID): void {
    const indexArray = arrays.indexArray;
    const layoutVertexArray = arrays.layoutVertexArray;

    const segment = arrays.segments.prepareSegment(4 * quads.length, layoutVertexArray, indexArray, this.canOverlap ? feature.sortKey as number : undefined);
    const glyphOffsetArrayStart = this.glyphOffsetArray.length;
    const vertexStartIndex = segment.vertexLength;

    const sections = feature.text && feature.text.sections;

    for (let i = 0; i < quads.length; i++) {
      const { tl, tr, bl, br, tex, pixelOffsetTL, pixelOffsetBR, minFontScaleX, minFontScaleY, glyphOffset, isSDF, sectionIndex } = quads[i];
      const index = segment.vertexLength;

      const y = glyphOffset[1];
      addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, tl.x, y + tl.y, tex.x, tex.y, sizeVertex, isSDF, pixelOffsetTL.x, pixelOffsetTL.y, minFontScaleX, minFontScaleY);
      addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, tr.x, y + tr.y, tex.x + tex.w, tex.y, sizeVertex, isSDF, pixelOffsetBR.x, pixelOffsetTL.y, minFontScaleX, minFontScaleY);
      addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, bl.x, y + bl.y, tex.x, tex.y + tex.h, sizeVertex, isSDF, pixelOffsetTL.x, pixelOffsetBR.y, minFontScaleX, minFontScaleY);
      addVertex(layoutVertexArray, labelAnchor.x, labelAnchor.y, br.x, y + br.y, tex.x + tex.w, tex.y + tex.h, sizeVertex, isSDF, pixelOffsetBR.x, pixelOffsetBR.y, minFontScaleX, minFontScaleY);

      indexArray.emplaceBack(index, index + 2, index + 1);
      indexArray.emplaceBack(index + 1, index + 2, index + 3);

      segment.vertexLength += 4;
      segment.primitiveLength += 2;

      this.glyphOffsetArray.emplaceBack(glyphOffset[0]);

      if (i === quads.length - 1 || sectionIndex !== quads[i + 1].sectionIndex) {
        arrays.programConfigurations.populatePaintArrays(layoutVertexArray.length, feature, feature.index, { imagePositions: {}, canonical, formattedSection: sections?.[sectionIndex], availableImages: this.availableImages });
      }
    }

    arrays.placedSymbolArray.emplaceBack(
      labelAnchor.x,
      labelAnchor.y,
      glyphOffsetArrayStart,
      this.glyphOffsetArray.length - glyphOffsetArrayStart,
      vertexStartIndex,
      lineStartIndex,
      alongLine ? lineLength : 0,
      labelAnchor.segment,
      sizeVertex ? sizeVertex[0] : 0,
      sizeVertex ? sizeVertex[1] : 0,
      lineOffset[0],
      lineOffset[1],
      writingMode,
      // placedOrientation is null initially; will be updated to horizontal(1)/vertical(2) if placed
      0,
      false as unknown as number,
      // The crossTileID is only filled/used on the foreground for dynamic text anchors
      0,
      associatedIconIndex,
    );
  }

  addToSortKeyRanges(symbolInstanceIndex: number, sortKey: number): void {
    const last = this.sortKeyRanges[this.sortKeyRanges.length - 1];
    if (last?.sortKey === sortKey) {
      last.symbolInstanceEnd = symbolInstanceIndex + 1;
    }
    else {
      this.sortKeyRanges.push({
        sortKey,
        symbolInstanceStart: symbolInstanceIndex,
        symbolInstanceEnd: symbolInstanceIndex + 1,
      });
    }
  }
}

// this constant is based on the size of StructArray indexes used in a symbol
// bucket--namely, glyphOffsetArrayStart
// eg the max valid UInt16 is 65,535
// lineStartIndex and textBoxStartIndex could potentially be concerns
// but we expect there to be many fewer boxes/lines than glyphs
SymbolBucket.MAX_GLYPHS = 65535;
