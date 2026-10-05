import type { SceneMode } from 'cesium';
import type { FillExtrusionBucket } from '../../data/bucket-runtime';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { ExtrusionFeatureStyle } from './feature-attributes';
import { latFromMercatorY, lngFromMercatorX } from '../../geo/mercator-coordinate';
import { subdivideTriangles, surfaceGranularity } from '../geometry/surface-subdivision';
import { tileLocalToMercatorFraction, WGS84_A, WGS84_F } from '../geometry/tile-to-ecef';
import { extrusionStyleForFeature } from './feature-attributes';

type TileID = CanonicalTileID | OverscaledTileID;

/**
 * Fill-extrusion geometry extraction.
 *
 * Each vertex carries a_pos (x/y), a_normal_ed (packed normal + top bit) and
 * the per-feature evaluated height/base from the paint slots. The
 * extrusion z is `t ? height : base` where t is the low bit of a_normal_ed[0].
 * Vertices are raised along the ellipsoid surface normal so buildings stand
 * upright on the globe.
 */

/**
 * Style light inputs for extrusion lighting, mirroring MapLibre's
 * fill-extrusion uniforms (fill_extrusion_program.ts). The position is the
 * already-converted cartesian direction (sphericalToCartesian, length
 * included, exactly like MapLibre's u_lightpos).
 */
export interface ExtrusionLighting {
  position: [number, number, number];
  color: { red: number; green: number; blue: number };
  intensity: number;
}

interface ExtrusionGeometry {
  /** ECEF positions, 3 doubles per vertex */
  positions: Float64Array;
  /** triangle indices relative to positions */
  triangles: Uint32Array;
  vertexCount: number;
  featureIndex: number;
}

export interface ExtrusionPrimitiveGeometry extends ExtrusionGeometry {
  /** Tile-local positions consumed by pattern UV construction. */
  tilePositions: Float64Array;
  /** Rounded source lighting, with subdivision interpolation baked into bytes. */
  vertexColors?: Uint8Array;
}

interface SolidExtrusionPrimitiveGeometry extends ExtrusionGeometry {
  /** Packed normal values in FLOAT storage, avoiding Native IDL truncation. */
  normals: Float32Array;
  /** Continuous interpolation of the source top bit after subdivision. */
  topWeights: Float32Array;
  style: ExtrusionFeatureStyle;
}

const FACTOR = 2 ** 13;

/**
 * The MapLibre fill-extrusion lighting formula (fill_extrusion.vertex.glsl)
 * baked per vertex. `color` is the pre-opacity style color; opacity is baked
 * into the alpha channel the same way the shader's trailing `v_color *=
 * u_opacity` does.
 */
function createVertexColorWriter(style: ExtrusionFeatureStyle, lighting: ExtrusionLighting): (colors: Uint8Array, offset: number, a0: number, a1: number, a2: number) => void {
  const { color, base, height, verticalGradient } = style;
  const alpha = Math.round(color.alpha * 255);
  // Relative luminance of the (pre-ambient) surface color.
  const colorvalue = color.red * 0.2126 + color.green * 0.7152 + color.blue * 0.0722;
  // Ambient light is added to the surface color before the diffuse term.
  const ambientRed = color.red + 0.03;
  const ambientGreen = color.green + 0.03;
  const ambientBlue = color.blue + 0.03;

  return (colors, offset, a0, a1, a2) => {
    const nx = Math.floor(a0 / 2) / FACTOR;
    const ny = a1 / (2 * FACTOR);
    const nz = a2 / (2 * FACTOR);
    let directional = Math.max(0, Math.min(1, nx * lighting.position[0]
      + ny * lighting.position[1]
      + nz * lighting.position[2]));
    // Intensity compression: mix(1 - intensity, max(1 - colorvalue +
    // intensity, 1), directional) - the range of highlight/shade values
    // narrows with lower light intensity and brighter surface colors.
    directional = (1.0 - lighting.intensity)
      + (Math.max(1.0 - colorvalue + lighting.intensity, 1.0) - (1.0 - lighting.intensity)) * directional;

    // Vertical gradient along side faces. MapLibre branches on the raw normal
    // y component, so north-south walls skip the gradient exactly like the
    // reference implementation (fill_extrusion.vertex.glsl).
    if (verticalGradient && ny !== 0) {
      const t = (a0 & 1) === 1 ? 1 : 0;
      const value = (t + base) * (height / 150.0) ** 0.5;
      // clamp(value, mix(0.7, 0.98, 1 - intensity), 1)
      const lower = 0.7 + (0.98 - 0.7) * (1.0 - lighting.intensity);
      directional *= Math.max(lower, Math.min(1.0, value));
    }

    // clamp(color.rgb * directional * lightColor, mix(0, 0.3, 1 - lightColor), 1)
    const r = Math.max(0.3 * (1.0 - lighting.color.red), Math.min(1, ambientRed * directional * lighting.color.red));
    const g = Math.max(0.3 * (1.0 - lighting.color.green), Math.min(1, ambientGreen * directional * lighting.color.green));
    const b = Math.max(0.3 * (1.0 - lighting.color.blue), Math.min(1, ambientBlue * directional * lighting.color.blue));
    colors[offset] = Math.round(r * 255);
    colors[offset + 1] = Math.round(g * 255);
    colors[offset + 2] = Math.round(b * 255);
    colors[offset + 3] = alpha;
  };
}

/**
 * Per-call memoized tile-local → ECEF converter. Subdivided grids revisit
 * the same localX/localY values many times and the mercator→geodetic trig is
 * one-dimensional in each axis, so caching them leaves only the closed-form
 * WGS84 evaluation per vertex (the same equations the worker's ECEF
 * precompute uses) and no per-vertex Cesium object allocations.
 */
function createTileEcefWriter(tileID: TileID): (positions: Float64Array, offset: number, localX: number, localY: number, height: number) => void {
  const lngByX = new Map<number, { sin: number; cos: number }>();
  const latByY = new Map<number, { sin: number; cos: number; normalRadius: number }>();
  const e2 = WGS84_F * (2 - WGS84_F);
  const poleLongitude = { sin: Math.sin(0), cos: Math.cos(0) };
  return (positions, offset, localX, localY, height) => {
    // MapLibre reserves these localY values for the exact globe poles; the
    // geodetic position there is independent of localX.
    const pole = localY === -32768 || localY === 32767;
    let lng = pole ? poleLongitude : lngByX.get(localX);
    if (lng === undefined) {
      const mx = tileLocalToMercatorFraction(tileID, localX, localY).x;
      const radians = lngFromMercatorX(mx) * Math.PI / 180;
      lng = { sin: Math.sin(radians), cos: Math.cos(radians) };
      lngByX.set(localX, lng);
    }
    let lat = latByY.get(localY);
    if (lat === undefined) {
      const radians = pole
        ? localY === -32768 ? Math.PI / 2 : -Math.PI / 2
        : latFromMercatorY(tileLocalToMercatorFraction(tileID, localX, localY).y) * Math.PI / 180;
      const sin = Math.sin(radians);
      lat = {
        sin,
        cos: Math.cos(radians),
        normalRadius: WGS84_A / Math.sqrt(1 - e2 * sin * sin),
      };
      latByY.set(localY, lat);
    }
    // Keep the worker WGS84 conversion's operation order while caching only
    // axis-dependent terms and writing directly into the final owner.
    const radius = lat.normalRadius + height;
    positions[offset] = radius * lat.cos * lng.cos;
    positions[offset + 1] = radius * lat.cos * lng.sin;
    positions[offset + 2] = (lat.normalRadius * (1 - e2) + height) * lat.sin;
  };
}

export function extrusionBucketPrimitives(
  bucket: FillExtrusionBucket,
  tileID: TileID,
  layerId?: string,
  mode?: SceneMode,
  zoom?: number,
  lighting?: ExtrusionLighting,
): ExtrusionPrimitiveGeometry[] {
  const primitives: ExtrusionPrimitiveGeometry[] = [];
  for (const primitive of iterateExtrusionBucketPrimitives(bucket, tileID, layerId, mode, zoom, lighting)) {
    if (primitive) {
      primitives.push(primitive);
    }
  }
  return primitives;
}

/** Yield during large features so a district-sized multipolygon cannot freeze the scene. */
export function iterateExtrusionBucketPrimitives(
  bucket: FillExtrusionBucket,
  tileID: TileID,
  layerId?: string,
  mode?: SceneMode,
  zoom?: number,
  lighting?: ExtrusionLighting,
): Generator<ExtrusionPrimitiveGeometry | undefined>;
export function iterateExtrusionBucketPrimitives(
  bucket: FillExtrusionBucket,
  tileID: TileID,
  layerId: string | undefined,
  mode: SceneMode | undefined,
  zoom: number | undefined,
  lighting: ExtrusionLighting | undefined,
  output: 'solid',
): Generator<SolidExtrusionPrimitiveGeometry | undefined>;
export function* iterateExtrusionBucketPrimitives(
  bucket: FillExtrusionBucket,
  tileID: TileID,
  layerId?: string,
  mode?: SceneMode,
  zoom?: number,
  lighting?: ExtrusionLighting,
  output: 'surface' | 'solid' = 'surface',
): Generator<ExtrusionPrimitiveGeometry | SolidExtrusionPrimitiveGeometry | undefined> {
  const int16 = bucket.layoutVertexArray.int16;
  const ranges = bucket.geometryRanges;

  // Segment indices are local to each segment, while geometry ranges are absolute
  // layout-vertex ranges. Build the ownership table once and classify every
  // triangle once. The previous implementation repeated the full index scan
  // for every feature, making a bucket with F features and T triangles cost
  // O(F*T) before any ECEF conversion was performed.
  const maxVertex = ranges.reduce((max, range) => Math.max(max, range.end), 0);
  const rangeByVertex = new Int32Array(maxVertex);
  rangeByVertex.fill(-1);
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const subdivision = mode === undefined ? 1 : surfaceGranularity('extrusion', canonical.z, mode);
  const writeEcef = createTileEcefWriter(tileID);
  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
    const range = ranges[rangeIndex];
    rangeByVertex.fill(rangeIndex, range.start, range.end);
  }
  const triangleValuesByRange: number[][] = ranges.map(() => []);
  const indexArray = bucket.indexArray.uint16;
  let triangleCount = 0;
  for (const segment of bucket.segments.get()) {
    const indexStart = segment.primitiveOffset * 3;
    const indexEnd = indexStart + segment.primitiveLength * 3;
    for (let i = indexStart; i < indexEnd; i += 3) {
      const a = segment.vertexOffset + indexArray[i];
      const b = segment.vertexOffset + indexArray[i + 1];
      const c = segment.vertexOffset + indexArray[i + 2];
      if (a >= maxVertex || b >= maxVertex || c >= maxVertex) {
        continue;
      }
      const rangeIndex = rangeByVertex[a];
      if (rangeIndex >= 0 && rangeIndex === rangeByVertex[b] && rangeIndex === rangeByVertex[c]) {
        const range = ranges[rangeIndex];
        triangleValuesByRange[rangeIndex].push(a - range.start, b - range.start, c - range.start);
      }
      if ((++triangleCount & 4095) === 0) {
        yield;
      }
    }
  }

  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
    const range = ranges[rangeIndex];
    const vertexCount = range.end - range.start;
    const triangleValues = triangleValuesByRange[rangeIndex];
    if (vertexCount === 0 || triangleValues.length === 0) {
      continue;
    }
    const style = extrusionStyleForFeature(bucket, range.featureIndex, layerId, zoom);
    const heightValue = style.height;
    const baseValue = style.base;
    const writeColor = lighting && output === 'surface' ? createVertexColorWriter(style, lighting) : undefined;
    let primitivePositions: Float64Array;
    let primitiveTilePositions: Float64Array | undefined;
    let primitiveTriangles: Uint32Array;
    let primitiveColors: Uint8Array | undefined;
    let primitiveNormals: Float32Array | undefined;
    let primitiveTopWeights: Float32Array | undefined;
    if (subdivision > 1) {
      const localPoints: Array<[number, number]> = [];
      const sourceColors = writeColor ? new Uint8Array(vertexCount * 4) : undefined;
      for (let i = 0; i < vertexCount; i++) {
        const sourceOffset = (range.start + i) * 6;
        localPoints.push([int16[sourceOffset], int16[sourceOffset + 1]]);
        if (sourceColors) {
          writeColor!(sourceColors, i * 4, int16[sourceOffset + 2], int16[sourceOffset + 3], int16[sourceOffset + 4]);
        }
        if ((i & 4095) === 4095) {
          yield;
        }
      }
      const subdivided = subdivideTriangles(localPoints, triangleValues, subdivision, {
        // A wall and a roof may share x/y but have different heights; retain
        // those vertices independently while keeping all grid cuts exact.
        shareVertices: false,
        dropOutsideTileX: canonical.z === 0,
        northPole: canonical.y === 0,
        southPole: canonical.y === (2 ** canonical.z) - 1,
      });
      const subdividedVertexCount = subdivided.vertices.length;
      primitivePositions = new Float64Array(subdividedVertexCount * 3);
      primitiveTilePositions = output === 'surface' ? new Float64Array(subdividedVertexCount * 2) : undefined;
      primitiveColors = writeColor ? new Uint8Array(subdividedVertexCount * 4) : undefined;
      primitiveNormals = output === 'solid' ? new Float32Array(subdividedVertexCount * 3) : undefined;
      primitiveTopWeights = output === 'solid' ? new Float32Array(subdividedVertexCount) : undefined;
      primitiveTriangles = new Uint32Array(subdivided.indices);
      for (let i = 0; i < subdividedVertexCount; i++) {
        const vertex = subdivided.vertices[i];
        const firstHeight = (int16[(range.start + vertex.sourceIndices[0]) * 6 + 2] & 1) === 1 ? heightValue : baseValue;
        const secondHeight = (int16[(range.start + vertex.sourceIndices[1]) * 6 + 2] & 1) === 1 ? heightValue : baseValue;
        const thirdHeight = (int16[(range.start + vertex.sourceIndices[2]) * 6 + 2] & 1) === 1 ? heightValue : baseValue;
        const z = firstHeight * vertex.weights[0]
          + secondHeight * vertex.weights[1]
          + thirdHeight * vertex.weights[2];
        writeEcef(primitivePositions, i * 3, vertex.x, vertex.y, z);
        if (primitiveNormals && primitiveTopWeights) {
          // Roof triangles and each wall quad have one normal. Grid/pole
          // cuts retain that face and interpolate only its top/bottom weight.
          const sourceOffset = (range.start + vertex.sourceIndices[0]) * 6;
          primitiveNormals[i * 3] = Math.floor(int16[sourceOffset + 2] / 2);
          primitiveNormals[i * 3 + 1] = int16[sourceOffset + 3];
          primitiveNormals[i * 3 + 2] = int16[sourceOffset + 4];
          let top = 0;
          for (let source = 0; source < 3; source++) {
            top += (int16[(range.start + vertex.sourceIndices[source]) * 6 + 2] & 1) * vertex.weights[source];
          }
          primitiveTopWeights[i] = top;
        }
        if (primitiveTilePositions) {
          primitiveTilePositions[i * 2] = vertex.x;
          primitiveTilePositions[i * 2 + 1] = vertex.y;
        }
        if (sourceColors && primitiveColors) {
          for (let channel = 0; channel < 4; channel++) {
            let value = 0;
            for (let source = 0; source < 3; source++) {
              value += sourceColors[vertex.sourceIndices[source] * 4 + channel] * vertex.weights[source];
            }
            // Preserve the original final Uint8Array conversion: interpolated
            // source bytes truncate rather than round a second time.
            primitiveColors[i * 4 + channel] = value;
          }
        }
        if ((i & 4095) === 4095) {
          yield;
        }
      }
    }
    else {
      primitivePositions = new Float64Array(vertexCount * 3);
      primitiveTilePositions = output === 'surface' ? new Float64Array(vertexCount * 2) : undefined;
      primitiveColors = writeColor ? new Uint8Array(vertexCount * 4) : undefined;
      primitiveNormals = output === 'solid' ? new Float32Array(vertexCount * 3) : undefined;
      primitiveTopWeights = output === 'solid' ? new Float32Array(vertexCount) : undefined;
      primitiveTriangles = new Uint32Array(triangleValues);
      for (let i = 0; i < vertexCount; i++) {
        const sourceOffset = (range.start + i) * 6;
        const x = int16[sourceOffset];
        const y = int16[sourceOffset + 1];
        const a0 = int16[sourceOffset + 2];
        writeEcef(primitivePositions, i * 3, x, y, (a0 & 1) === 1 ? heightValue : baseValue);
        if (primitiveNormals && primitiveTopWeights) {
          primitiveNormals[i * 3] = Math.floor(a0 / 2);
          primitiveNormals[i * 3 + 1] = int16[sourceOffset + 3];
          primitiveNormals[i * 3 + 2] = int16[sourceOffset + 4];
          primitiveTopWeights[i] = a0 & 1;
        }
        if (primitiveTilePositions) {
          primitiveTilePositions[i * 2] = x;
          primitiveTilePositions[i * 2 + 1] = y;
        }
        if (primitiveColors) {
          writeColor!(primitiveColors, i * 4, a0, int16[sourceOffset + 3], int16[sourceOffset + 4]);
        }
        if ((i & 4095) === 4095) {
          yield;
        }
      }
    }

    if (output === 'solid') {
      yield {
        positions: primitivePositions,
        triangles: primitiveTriangles,
        normals: primitiveNormals!,
        topWeights: primitiveTopWeights!,
        style,
        vertexCount: primitivePositions.length / 3,
        featureIndex: range.featureIndex,
      };
    }
    else {
      yield {
        positions: primitivePositions,
        tilePositions: primitiveTilePositions!,
        triangles: primitiveTriangles,
        vertexColors: primitiveColors,
        vertexCount: primitivePositions.length / 3,
        featureIndex: range.featureIndex,
      };
    }
  }
}
