import type Point from '@mapbox/point-geometry';

import type { ImagePosition } from '../../assets/image-atlas';
import type { FillStyleLayer } from '../../style/style-layer/fill-style-layer';
import type { CanonicalTileID } from '../../tile/tile-id';
import type {
  BucketFeature,
  BucketParameters,
  IndexedFeature,
  PopulateParameters,
} from '../bucket';
import { classifyRings } from '@maplibre/maplibre-gl-style-spec';

import earcut from 'earcut';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { FillLayoutArray, TriangleIndexArray } from '../array-types.g';
import { getPrimaryLayer } from '../bucket';
import { FillBucket as FillBucketRuntime } from '../bucket-runtime';
import { toEvaluationFeature } from '../evaluation-feature';
import { EXTENT } from '../extent';
import { loadGeometry } from '../load-geometry';
import { ProgramConfigurationSet } from '../program-configuration';
import { fillSegmentsTriangles, fixWindingOrder, SegmentVector } from '../segment';
import { addPatternDependencies, hasPattern } from './pattern-bucket-features';

const EARCUT_MAX_RINGS = 500;

function isEntirelyOutside(ring: Point[]): boolean {
  return ring.every(p => p.x < 0)
    || ring.every(p => p.x > EXTENT)
    || ring.every(p => p.y < 0)
    || ring.every(p => p.y > EXTENT);
}

export class FillBucket extends FillBucketRuntime {
  patternFeatures: BucketFeature[];
  availableImages?: string[];

  constructor(options: BucketParameters<FillStyleLayer>) {
    super();
    this.availableImages = options.availableImages;
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;
    this.layers = options.layers;
    this.layerIds = this.layers.map(layer => layer.id);
    this.index = options.index;
    this.hasDependencies = false;
    this.patternFeatures = [];

    this.layoutVertexArray = new FillLayoutArray();
    this.indexArray = new TriangleIndexArray();
    this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
    this.segments = new SegmentVector();
    this.polygons = [];
    this.stateDependentLayers = this.layers.filter(layer => layer.isStateDependent());
    this.stateDependentLayerIds = this.stateDependentLayers.map(layer => layer.id);
  }

  populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
    this.hasDependencies = hasPattern('fill', this.layers, options);
    const layer = getPrimaryLayer(this.layers);
    const fillSortKey = layer.layout.get('fill-sort-key');
    const sortFeaturesByKey = !fillSortKey.isConstant();
    const bucketFeatures: BucketFeature[] = [];
    const sourceFeaturesByIndex = new Map(features.map(({ index, feature }) => [index, feature]));

    const globalProperties = new EvaluationParameters(this.zoom);
    const needGeometry = layer._featureFilter.needGeometry;
    for (const { feature, id, index, sourceLayerIndex } of features) {
      const evaluationFeature = toEvaluationFeature(feature, needGeometry);

      if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical))
        continue;

      const sortKey = sortFeaturesByKey
        ? fillSortKey.evaluate(evaluationFeature, {}, canonical, options.availableImages)
        : undefined;

      const bucketFeature: BucketFeature = {
        id,
        properties: feature.properties,
        type: feature.type,
        sourceLayerIndex,
        index,
        geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
        patterns: {},
        sortKey,
      };

      bucketFeatures.push(bucketFeature);
    }

    if (sortFeaturesByKey) {
      bucketFeatures.sort((a, b) => {
        if (a.sortKey === undefined || b.sortKey === undefined)
          return 0;
        return a.sortKey - b.sortKey;
      });
    }

    for (const bucketFeature of bucketFeatures) {
      const { geometry, index, sourceLayerIndex } = bucketFeature;

      if (this.hasDependencies) {
        const patternFeature = addPatternDependencies('fill', this.layers, bucketFeature, { zoom: this.zoom }, options);
        // pattern features are added only once the pattern is loaded into the image atlas
        // so are stored during populate until later updated with positions by tile worker in addFeatures
        this.patternFeatures.push(patternFeature);
      }
      else {
        this.addFeature(bucketFeature, geometry, index, canonical, {});
      }

      const feature = sourceFeaturesByIndex.get(index)!;
      options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
    }
  }

  addFeatures(_options: PopulateParameters, canonical: CanonicalTileID, imagePositions: {
    [_: string]: ImagePosition;
  }): void {
    for (const feature of this.patternFeatures) {
      this.addFeature(feature, feature.geometry, feature.index, canonical, imagePositions);
    }
  }

  addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: {
    [_: string]: ImagePosition;
  }): void {
    for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
      const outerRing = polygon[0];
      // A valid hole cannot lie inside an outer ring that is wholly outside
      // the tile. Skip the complete polygon instead of letting an orphaned
      // hole become a new outer ring in the compacted earcut input.
      if (!outerRing || isEntirelyOutside(outerRing)) {
        continue;
      }
      let numVertices = 0;
      for (const ring of polygon) {
        numVertices += ring.length;
      }
      const segment = this.segments.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray);
      // TriangleIndexArray indices are local to a segment. The polygon may
      // start after earlier polygons already stored in that segment, so use
      // the segment's current vertex cursor rather than its absolute offset.
      const vertexBase = segment.vertexLength;
      const polygonVertexOffset = this.layoutVertexArray.length;
      const flat: number[] = [];
      const holeIndices: number[] = [];
      let includedRingCount = 0;
      for (const ring of polygon) {
        if (ring.length === 0 || isEntirelyOutside(ring)) {
          continue;
        }
        for (const point of ring) {
          flat.push(point.x, point.y);
        }
        // A ring can be omitted by the tile-boundary fast path.  Hole indices
        // are offsets into the compacted `flat` array, so the original ring
        // ordinal is not a valid indication that this ring is a hole.
        if (includedRingCount > 0) {
          holeIndices.push(flat.length / 2 - ring.length);
        }
        includedRingCount++;
      }
      // earcut can throw on pathological self-intersecting rings; a single
      // malformed polygon must not fail the whole tile build (MapLibre wraps
      // the same call, see src/render/subdivision.ts).
      let triangles: number[];
      try {
        triangles = earcut(flat, holeIndices, 2);
      }
      catch (e) {
        console.error(e);
        triangles = [];
      }
      // earcut preserves the input ring winding, and the MVT spec does not
      // mandate an orientation. Back-face culling would hide polygons whose
      // triangles wind the wrong way, so normalize the winding (see MapLibre's
      // fixWindingOrder in src/render/subdivision.ts).
      fixWindingOrder(flat, triangles);

      if (vertexBase + flat.length / 2 <= SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
        // Vertices are appended after triangulation; the vertex and index
        // arrays end up identical to appending them before it.
        for (let i = 0; i < flat.length; i += 2) {
          this.layoutVertexArray.emplaceBack(flat[i], flat[i + 1]);
        }
        for (let i = 0; i < triangles.length; i += 3) {
          this.indexArray.emplaceBack(vertexBase + triangles[i], vertexBase + triangles[i + 1], vertexBase + triangles[i + 2]);
        }
        segment.vertexLength += flat.length / 2;
        segment.primitiveLength += triangles.length / 3;
        this.polygons.push({
          featureIndex: index,
          vertexOffset: polygonVertexOffset,
          vertexLength: flat.length / 2,
          primitiveOffset: this.indexArray.length - triangles.length / 3,
          primitiveLength: triangles.length / 3,
          holes: holeIndices,
        });
      }
      else {
        // A single polygon with more vertices than fit into a Uint16-indexed
        // segment would silently wrap its triangle indices. Split the
        // emission into several segment chunks, duplicating vertices that
        // straddle a chunk boundary (MapLibre's fillSegmentsTriangles slow
        // path, src/render/fill_large_mesh_arrays.ts).
        const polygonPrimitiveStart = this.indexArray.length;
        const chunks = fillSegmentsTriangles(
          this.segments,
          this.layoutVertexArray,
          this.indexArray,
          flat,
          triangles,
          (x, y) => {
            this.layoutVertexArray.emplaceBack(x, y);
          },
        );
        // The chunked buffer no longer preserves ring order and duplicates
        // shared vertices, so ring metadata is meaningless here. Emit one
        // polygons entry per chunk so that each entry maps to a single
        // segment; the Cesium geometry extractor re-bases triangle indices
        // by their segment's vertex offset.
        let chunkVertexOffset = polygonVertexOffset;
        let chunkPrimitiveOffset = polygonPrimitiveStart;
        for (const chunk of chunks) {
          this.polygons.push({
            featureIndex: index,
            vertexOffset: chunkVertexOffset,
            vertexLength: chunk.vertexLength,
            primitiveOffset: chunkPrimitiveOffset,
            primitiveLength: chunk.primitiveLength,
            holes: [],
          });
          chunkVertexOffset += chunk.vertexLength;
          chunkPrimitiveOffset += chunk.primitiveLength;
        }
      }
    }
    const paintSlotCount = this.programConfigurations.getFeatureRanges().length + 1;
    this.programConfigurations.populatePaintArrays(paintSlotCount, feature, index, { imagePositions, canonical, availableImages: this.availableImages });
  }
}
