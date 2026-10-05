import type { PromoteIdSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { BucketParameters, IndexedFeature } from '../data/bucket';
import type { FeatureSnapshotInput } from '../data/feature-snapshot';
import type { StyleLayer } from '../style/style-layer';
import type { StyleLayerIndex } from '../style/style-layer-index';
import type { GetDashesResponse, GetGlyphsResponse, GetImagesResponse } from '../worker/messages';
import type { WorkerMessageSender } from '../worker/worker-channel';
import type { VectorTileData } from './vector-tile-data';
import type {
  WorkerTileParameters,
  WorkerTileResult,
} from './worker-source';
import { GlyphAtlas } from '../assets/glyph-atlas';
import { ImageAtlas } from '../assets/image-atlas';
import { CollisionBoxArray } from '../data/array-types.g';
import { CircleBucket } from '../data/bucket/circle-bucket';
import { FillBucket } from '../data/bucket/fill-bucket';
import { FillExtrusionBucket } from '../data/bucket/fill-extrusion-bucket';

import { LineBucket } from '../data/bucket/line-bucket';
import { SymbolBucket } from '../data/bucket/symbol-bucket';
import { FeatureIndex, GEOJSON_TILE_LAYER_NAME } from '../data/feature-index';
import { FeatureSnapshot } from '../data/feature-snapshot';
import { loadGeometry } from '../data/load-geometry';
import { EvaluationParameters } from '../style/evaluation-parameters';
import { performSymbolLayout } from '../symbol/symbol-layout';
import { OverscaledTileID } from '../tile/tile-id';
import { DictionaryCoder } from '../util/dictionary-coder';
import { warnOnce } from '../util/errors';
import { mapObject } from '../util/objects';
import { MessageType } from '../worker/messages';

type WorkerBucket = CircleBucket<any> | FillBucket | FillExtrusionBucket | LineBucket | SymbolBucket;

function createBucket(type: StyleLayer['type'], parameters: BucketParameters<any>): WorkerBucket {
  switch (type) {
    case 'circle': return new CircleBucket(parameters);
    case 'fill': return new FillBucket(parameters);
    case 'fill-extrusion': return new FillExtrusionBucket(parameters);
    case 'line': return new LineBucket(parameters);
    case 'symbol': return new SymbolBucket(parameters);
    default: throw new Error(`Unsupported worker bucket type: ${type}`);
  }
}

export class WorkerTile {
  tileID: OverscaledTileID;
  uid: string | number;
  zoom: number;
  pixelRatio: number;
  tileSize: number;
  source: string;
  promoteId: PromoteIdSpecification;
  overscaling: number;
  collectResourceTiming: boolean;
  returnDependencies: boolean;

  status: 'parsing' | 'done' = 'done';
  collisionBoxArray: CollisionBoxArray;

  abort?: AbortController;
  vectorTile?: VectorTileData;
  inFlightDependencies: AbortController[];

  constructor(params: WorkerTileParameters) {
    this.tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
    this.uid = params.uid;
    this.zoom = params.zoom;
    this.pixelRatio = params.pixelRatio;
    this.tileSize = params.tileSize;
    this.source = params.source;
    this.overscaling = this.tileID.overscaleFactor();
    this.collectResourceTiming = !!params.collectResourceTiming;
    this.returnDependencies = !!params.returnDependencies;
    this.promoteId = params.promoteId;
    this.collisionBoxArray = new CollisionBoxArray();
    this.inFlightDependencies = [];
  }

  async parse(data: VectorTileData, layerIndex: StyleLayerIndex, availableImages: string[], channel: WorkerMessageSender): Promise<WorkerTileResult> {
    this.status = 'parsing';
    // WorkerTile instances are reused for reloads. Collision boxes belong to
    // one parse result; retaining the previous array duplicates collision
    // data and leaves stale boxes in the next serialized tile.
    this.collisionBoxArray = new CollisionBoxArray();
    const sourceLayerCoder = new DictionaryCoder(Object.keys(data.layers).sort());

    const featureIndex = new FeatureIndex(this.tileID, this.promoteId);
    featureIndex.bucketLayerIDs = [];
    featureIndex.sourceLayerIds = Object.keys(data.layers).sort();

    const buckets: { [_: string]: WorkerBucket } = {};
    const sourceFeatures = new Map<string, IndexedFeature[]>();

    const options = {
      featureIndex,
      iconDependencies: {},
      patternDependencies: {},
      glyphDependencies: {},
      dashDependencies: {},
      availableImages,
    };

    const layerFamilies = layerIndex.familiesBySource[this.source];
    for (const sourceLayerId in layerFamilies) {
      const sourceLayer = data.layers[sourceLayerId];
      if (!sourceLayer) {
        continue;
      }

      if (sourceLayer.version === 1) {
        warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" `
          + 'does not use vector tile spec v2 and therefore may have some rendering errors.');
      }

      const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
      const features: IndexedFeature[] = [];
      for (let index = 0; index < sourceLayer.length; index++) {
        const feature = sourceLayer.feature(index);
        const id = featureIndex.getId(feature, sourceLayerId);
        features.push({ feature, id, index, sourceLayerIndex });
      }
      sourceFeatures.set(sourceLayerId, features);

      for (const family of layerFamilies[sourceLayerId]) {
        const layer = family[0];

        if (layer.source !== this.source) {
          warnOnce(`layer.source = ${layer.source} does not equal this.source = ${this.source}`);
        }
        if (layer.isHidden(this.zoom, true))
          continue;
        recalculateLayers(family, this.zoom, availableImages);

        const bucket = buckets[layer.id] = createBucket(layer.type, {
          index: featureIndex.bucketLayerIDs.length,
          layers: family,
          availableImages,
          zoom: this.zoom,
          pixelRatio: this.pixelRatio,
          overscaling: this.overscaling,
          collisionBoxArray: this.collisionBoxArray,
          sourceLayerIndex,
          sourceID: this.source,
        });

        bucket.populate(features, options, this.tileID.canonical);
        featureIndex.bucketLayerIDs.push(family.map(l => l.id));
      }
    }

    // options.glyphDependencies looks like: {"SomeFontName":{"10":true,"32":true}}
    // this line makes an object like: {"SomeFontName":[10,32]}
    const stacks: { [_: string]: number[] } = mapObject(options.glyphDependencies, glyphs => Object.keys(glyphs).map(Number));

    for (const request of this.inFlightDependencies) {
      request?.abort();
    }
    this.inFlightDependencies = [];

    let getGlyphsPromise = Promise.resolve<GetGlyphsResponse>({});
    if (Object.keys(stacks).length) {
      const abortController = new AbortController();
      this.inFlightDependencies.push(abortController);
      getGlyphsPromise = channel.sendAsync({ type: MessageType.getGlyphs, data: { stacks, source: this.source, tileID: this.tileID, type: 'glyphs' } }, abortController);
    }

    const icons = Object.keys(options.iconDependencies);
    let getIconsPromise = Promise.resolve<GetImagesResponse>({});
    if (icons.length) {
      const abortController = new AbortController();
      this.inFlightDependencies.push(abortController);
      getIconsPromise = channel.sendAsync({ type: MessageType.getImages, data: { icons, source: this.source, tileID: this.tileID, type: 'icons' } }, abortController);
    }

    const patterns = Object.keys(options.patternDependencies);
    let getPatternsPromise = Promise.resolve<GetImagesResponse>({});
    if (patterns.length) {
      const abortController = new AbortController();
      this.inFlightDependencies.push(abortController);
      getPatternsPromise = channel.sendAsync({ type: MessageType.getImages, data: { icons: patterns, source: this.source, tileID: this.tileID, type: 'patterns' } }, abortController);
    }

    const dashes = options.dashDependencies;
    let getDashesPromise = Promise.resolve<GetDashesResponse>({} as GetDashesResponse);
    if (Object.keys(dashes).length) {
      const abortController = new AbortController();
      this.inFlightDependencies.push(abortController);
      getDashesPromise = channel.sendAsync({ type: MessageType.getDashes, data: { dashes } }, abortController);
    }

    const [glyphMap, iconMap, patternMap, dashPositions] = await Promise.all([getGlyphsPromise, getIconsPromise, getPatternsPromise, getDashesPromise]);

    // Resolve the numeric dash patterns the getDashes round-trip received.
    // The atlas positions come back keyed by the same dash key; the renderer
    // reads the per-feature atlas row from the vertex attributes, so the rows
    // are re-keyed by `y:height` here.
    const dashRows: { [_: string]: { dasharray: number[]; round: boolean } } = {};
    for (const key in dashPositions) {
      const entry = dashPositions[key];
      const dependency = dashes[key];
      if (entry && dependency) {
        dashRows[`${entry.y}:${entry.height}`] = {
          dasharray: dependency.dasharray,
          round: dependency.round,
        };
      }
    }

    const glyphAtlas = new GlyphAtlas(glyphMap);
    const imageAtlas = new ImageAtlas(iconMap, patternMap);

    for (const key in buckets) {
      const bucket = buckets[key];
      if (bucket instanceof SymbolBucket) {
        // Symbol layout is a separate pass: shaping needs the resolved glyph
        // and icon bitmaps, which only exist after the dependency requests.
        recalculateLayers(bucket.layers, this.zoom, availableImages);
        performSymbolLayout({
          bucket,
          glyphMap,
          glyphPositions: glyphAtlas.positions,
          imageMap: iconMap,
          imagePositions: imageAtlas.iconPositions,
          canonical: this.tileID.canonical,
        });
      }
      else if (bucket.hasDependencies && (bucket instanceof FillBucket || bucket instanceof FillExtrusionBucket || bucket instanceof LineBucket)) {
        recalculateLayers(bucket.layers, this.zoom, availableImages);
        bucket.addFeatures(options, this.tileID.canonical, imageAtlas.patternPositions, dashPositions);
      }
    }

    const outputBuckets = Object.values(buckets).filter(bucket => !bucket.isEmpty());
    const outputIndices = new Set(outputBuckets.map(bucket => bucket.index));
    const selected = new Map<string, Map<number, boolean>>();
    const select = (sourceLayer: string, index: number, needsGeometry: boolean) => {
      let indices = selected.get(sourceLayer);
      if (!indices) {
        indices = new Map();
        selected.set(sourceLayer, indices);
      }
      indices.set(index, needsGeometry || indices.get(index) === true);
    };
    for (let i = 0; i < featureIndex.featureIndexArray.length; i++) {
      const entry = featureIndex.featureIndexArray.get(i);
      if (outputIndices.has(entry.bucketIndex))
        select(featureIndex.sourceLayerIds[entry.sourceLayerIndex], entry.featureIndex, false);
    }
    for (const bucket of outputBuckets) {
      const sourceLayer = bucket.layers[0].sourceLayer || GEOJSON_TILE_LAYER_NAME;
      const configurations = bucket instanceof SymbolBucket
        ? [bucket.text.programConfigurations, bucket.icon.programConfigurations]
        : [bucket.programConfigurations];
      for (const configuration of configurations) {
        const needsGeometry = configuration.hasStateDependentGeometry();
        for (const range of configuration.getFeatureRanges())
          select(sourceLayer, range.index, needsGeometry);
      }
    }
    const snapshot: FeatureSnapshotInput[] = [];
    for (const [sourceLayer, indices] of selected) {
      const features = sourceFeatures.get(sourceLayer)!;
      for (const [index, needsGeometry] of indices) {
        const { feature, id } = features[index];
        snapshot.push({
          sourceLayer,
          index,
          id,
          type: feature.type,
          properties: feature.properties,
          geometry: needsGeometry ? loadGeometry(feature) : undefined,
        });
      }
    }
    featureIndex.features = new FeatureSnapshot(snapshot);

    this.status = 'done';
    return {
      buckets: outputBuckets,
      featureIndex,
      collisionBoxArray: this.collisionBoxArray,
      glyphAtlasImage: glyphAtlas.image,
      imageAtlas,
      dashPositions,
      dashRows,
      // Only used for benchmarking:
      glyphMap: this.returnDependencies ? glyphMap : null,
      iconMap: this.returnDependencies ? iconMap : null,
      glyphPositions: this.returnDependencies ? glyphAtlas.positions : null,
    };
  }
}

function recalculateLayers(layers: readonly StyleLayer[], zoom: number, availableImages: string[]) {
  // Layers are shared and may have been used by a WorkerTile with a different zoom.
  const parameters = new EvaluationParameters(zoom);
  for (const layer of layers) {
    layer.recalculate(parameters, availableImages);
  }
}
