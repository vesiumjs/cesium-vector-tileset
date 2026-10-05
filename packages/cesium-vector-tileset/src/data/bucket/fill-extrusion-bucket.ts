import type Point from '@mapbox/point-geometry';

import type { ImagePosition } from '../../assets/image-atlas';
import type { FillExtrusionStyleLayer } from '../../style/style-layer/fill-extrusion-style-layer';
import type { CanonicalTileID } from '../../tile/tile-id';
import type {
  BucketFeature,
  BucketParameters,
  IndexedFeature,
  PopulateParameters,
} from '../bucket';
import type { Segment } from '../segment';
import { VectorTileFeature } from '@mapbox/vector-tile';
import { classifyRings } from '@maplibre/maplibre-gl-style-spec';

import earcut from 'earcut';
import { EvaluationParameters } from '../../style/evaluation-parameters';

import { FillExtrusionLayoutArray, TriangleIndexArray } from '../array-types.g';
import { getPrimaryLayer } from '../bucket';
import { FillExtrusionBucket as FillExtrusionBucketRuntime } from '../bucket-runtime';
import { toEvaluationFeature } from '../evaluation-feature';
import { EXTENT } from '../extent';
import { loadGeometry } from '../load-geometry';
import { ProgramConfigurationSet } from '../program-configuration';
import { fillSegmentsTriangles, fixWindingOrder, SegmentVector } from '../segment';
import { addPatternDependencies, hasPattern } from './pattern-bucket-features';

import { roundPolygonCorners } from './round-polygon-corners';

const EARCUT_MAX_RINGS = 500;

const FACTOR = 2 ** 13;

function addVertex(vertexArray: FillExtrusionLayoutArray, x: number, y: number, nx: number, ny: number, nz: number, t: number, e: number): void {
  vertexArray.emplaceBack(
    // a_pos
    x,
    y,
    // a_normal_ed: 3-component normal and 1-component edgedistance
    Math.floor(nx * FACTOR) * 2 + t,
    ny * FACTOR * 2,
    nz * FACTOR * 2,
    // edgedistance (used for wrapping patterns around extrusion sides)
    Math.round(e),
  );
}

export class FillExtrusionBucket extends FillExtrusionBucketRuntime {
  features: BucketFeature[];
  availableImages?: string[];

  constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
    super();
    this.availableImages = options.availableImages;
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;
    this.layers = options.layers;
    this.layerIds = this.layers.map(layer => layer.id);
    this.index = options.index;
    this.hasDependencies = false;

    this.layoutVertexArray = new FillExtrusionLayoutArray();
    this.geometryRanges = [];
    this.indexArray = new TriangleIndexArray();
    this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
    this.segments = new SegmentVector();
    this.features = [];
    this.stateDependentLayers = this.layers.filter(layer => layer.isStateDependent());
    this.stateDependentLayerIds = this.stateDependentLayers.map(layer => layer.id);
  }

  populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
    this.hasDependencies = hasPattern('fill-extrusion', this.layers, options);

    const globalProperties = new EvaluationParameters(this.zoom);
    const layer = getPrimaryLayer(this.layers);
    const roundedCornerDistance = layer.layout.get('fill-extrusion-rounded-corner-distance');
    const needGeometry = layer._featureFilter.needGeometry;

    for (const { feature, id, index, sourceLayerIndex } of features) {
      const evaluationFeature = toEvaluationFeature(feature, needGeometry);

      if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical))
        continue;

      const rawGeometry = needGeometry ? evaluationFeature.geometry : loadGeometry(feature);
      const geometry = roundedCornerDistance > 0 ? roundPolygonCorners(rawGeometry, roundedCornerDistance, canonical) : rawGeometry;

      const bucketFeature: BucketFeature = {
        id,
        sourceLayerIndex,
        index,
        geometry,
        properties: feature.properties,
        type: feature.type,
        patterns: {},
      };

      if (this.hasDependencies) {
        this.features.push(addPatternDependencies('fill-extrusion', this.layers, bucketFeature, { zoom: this.zoom }, options));
      }
      else {
        this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, {});
      }

      options.featureIndex.insert(feature, bucketFeature.geometry, index, sourceLayerIndex, this.index, true);
    }
  }

  addFeatures(_options: PopulateParameters, canonical: CanonicalTileID, imagePositions: { [_: string]: ImagePosition }): void {
    for (const feature of this.features) {
      const { geometry } = feature;
      this.addFeature(feature, geometry, feature.index, canonical, imagePositions);
    }
  }

  addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: { [_: string]: ImagePosition }): void {
    const start = this.layoutVertexArray.length;
    const layer = getPrimaryLayer(this.layers);
    const roundedCornerDistance = layer.layout.get('fill-extrusion-rounded-corner-distance');
    const processedGeometry = roundedCornerDistance > 0 ? roundPolygonCorners(geometry, roundedCornerDistance, canonical) : geometry;

    for (const polygon of classifyRings(processedGeometry, EARCUT_MAX_RINGS)) {
      this.processPolygon(feature, polygon);
    }

    this.geometryRanges.push({ featureIndex: index, start, end: this.layoutVertexArray.length });
    const paintSlotCount = this.programConfigurations.getFeatureRanges().length + 1;
    this.programConfigurations.populatePaintArrays(paintSlotCount, feature, index, { imagePositions, canonical, availableImages: this.availableImages });
  }

  private processPolygon(
    feature: BucketFeature,
    polygon: Point[][],
  ): void {
    if (polygon.length < 1) {
      return;
    }

    const outerRing = polygon[0];
    if (!outerRing || isEntirelyOutside(outerRing)) {
      return;
    }

    const isPolygon = VectorTileFeature.types[feature.type] === 'Polygon';
    // Surface subdivision is projection-dependent. It belongs to the Cesium
    // renderer, which knows whether the scene is in 2D, Columbus View, or
    // 3D. Doing a fixed 4x4 split here used to duplicate that work on the
    // main thread and made 2D tiles unnecessarily large.
    const renderPolygon = polygon;

    const segmentReference = {
      segment: this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray),
    };
    for (const ring of renderPolygon) {
      if (ring.length === 0 || isEntirelyOutside(ring)) {
        continue;
      }

      this._generateSideFaces(ring, segmentReference);
    }

    // Only triangulate and draw the area of the feature if it is a polygon
    // Other feature types (e.g. LineString) do not have area, so triangulation is pointless / undefined
    if (!isPolygon)
      return;

    // Triangulate the top face of the extrusion.
    const flat: number[] = [];
    const holeIndices: number[] = [];
    let includedRingCount = 0;
    for (const ring of renderPolygon) {
      if (!ring) {
        continue;
      }
      if (ring.length === 0 || isEntirelyOutside(ring)) {
        continue;
      }
      for (const point of ring) {
        flat.push(point.x, point.y);
      }
      // The outside-ring fast path compacts the rings before earcut sees
      // them. Use the compacted order; the original ring ordinal is not a
      // valid hole offset when an earlier ring was skipped.
      if (includedRingCount > 0) {
        holeIndices.push(flat.length / 2 - ring.length);
      }
      includedRingCount++;
    }
    const segment = this.segments.prepareSegment(flat.length / 2, this.layoutVertexArray, this.indexArray);
    // TriangleIndexArray indices are segment-local. The top face may start
    // after the side faces already stored in that segment, so use the
    // segment's current vertex cursor rather than its absolute offset.
    const triangleIndex = segment.vertexLength;
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

    if (triangleIndex + flat.length / 2 <= SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
      for (let i = 0; i < flat.length; i += 2) {
        addVertex(this.layoutVertexArray, flat[i], flat[i + 1], 0, 0, 1, 1, 0);
      }
      for (let i = 0; i < triangles.length; i += 3) {
        this.indexArray.emplaceBack(triangleIndex + triangles[i], triangleIndex + triangles[i + 1], triangleIndex + triangles[i + 2]);
      }
      segment.vertexLength += flat.length / 2;
      segment.primitiveLength += triangles.length / 3;
    }
    else {
      // A top face with more vertices than fit into a Uint16-indexed segment
      // would silently wrap its triangle indices. Split the emission into
      // several segment chunks, duplicating vertices that straddle a chunk
      // boundary (MapLibre's fillSegmentsTriangles slow path,
      // src/render/fill_large_mesh_arrays.ts).
      fillSegmentsTriangles(
        this.segments,
        this.layoutVertexArray,
        this.indexArray,
        flat,
        triangles,
        (x, y) => {
          addVertex(this.layoutVertexArray, x, y, 0, 0, 1, 1, 0);
        },
      );
    }
  }

  /**
   * Generates side faces for the supplied geometry. Assumes `geometry` to be a line string, like the output of {@link subdivideVertexLine}.
   * For rings, it is assumed that the first and last vertex of `geometry` are equal.
   */
  private _generateSideFaces(geometry: Point[], segmentReference: { segment: Segment }): void {
    let edgeDistance = 0;

    for (let p = 1; p < geometry.length; p++) {
      const p1 = geometry[p];
      const p2 = geometry[p - 1];
      if (!p1 || !p2) {
        continue;
      }

      if (isBoundaryEdge(p1, p2)) {
        continue;
      }

      if (segmentReference.segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
        segmentReference.segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
      }

      const perp = p1.sub(p2)._perp()._unit();
      const dist = p2.dist(p1);
      if (edgeDistance + dist > 32768)
        edgeDistance = 0;

      addVertex(this.layoutVertexArray, p1.x, p1.y, perp.x, perp.y, 0, 0, edgeDistance);
      addVertex(this.layoutVertexArray, p1.x, p1.y, perp.x, perp.y, 0, 1, edgeDistance);

      edgeDistance += dist;

      addVertex(this.layoutVertexArray, p2.x, p2.y, perp.x, perp.y, 0, 0, edgeDistance);
      addVertex(this.layoutVertexArray, p2.x, p2.y, perp.x, perp.y, 0, 1, edgeDistance);

      const bottomRight = segmentReference.segment.vertexLength;

      // ┌──────┐
      // │ 0  1 │ Counter-clockwise winding order.
      // │      │ Triangle 1: 0 => 2 => 1
      // │ 2  3 │ Triangle 2: 1 => 2 => 3
      // └──────┘
      this.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
      this.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

      segmentReference.segment.vertexLength += 4;
      segmentReference.segment.primitiveLength += 2;
    }
  }
}

function isBoundaryEdge(p1: Point, p2: Point): boolean {
  return (p1.x === p2.x && (p1.x < 0 || p1.x > EXTENT))
    || (p1.y === p2.y && (p1.y < 0 || p1.y > EXTENT));
}

function isEntirelyOutside(ring: Point[]): boolean {
  return ring.every(p => p.x < 0)
    || ring.every(p => p.x > EXTENT)
    || ring.every(p => p.y < 0)
    || ring.every(p => p.y > EXTENT);
}
