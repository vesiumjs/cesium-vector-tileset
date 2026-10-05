import type {
  Color,
  Material,
  Primitive,
} from 'cesium';
import type { Bucket } from '../../data/bucket';
import type { DashRow } from '../../source/worker-source';
import type { StyleLayer } from '../../style/style-layer';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { LinePaintUniforms } from '../scene/draw-batch';
import type { Budget } from '../scene/frame-budget';
import type { DashMaterial } from './dash-material';
import type { LineFamilyLayer } from './line-family';
import type { LineGeometryOptions } from './line-geometry';
import {
  BoundingSphere,
  Color as CesiumColor,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Ellipsoid,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  GeometryInstanceAttribute,
  PolylineColorAppearance,
  PolylineMaterialAppearance,
  PrimitiveCollection,
  PrimitiveType,
} from 'cesium';
import { FillBucket, LineBucket } from '../../data/bucket-runtime';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { registerDrawBatch, registerLinePaint } from '../scene/draw-batch';
import { MAX_LINE_INSTANCES, UNBOUNDED_BUDGET } from '../scene/frame-budget';
import { fillStyleForFeature, layerFor, lineStyleForFeature } from '../vector/feature-attributes';
import { dashRowsForFeature } from './dash-material';
import { LineFamilyChunk } from './line-family';
import { LineGeometryCache, lineLayoutKey } from './line-geometry';
import { LINE_TILE_CLIP_FRAGMENT, LineTileClip } from './line-tile-clip';
import { LINE_FAN_PARAMETER_SHADER } from './line-vertex-format';

/** A line pattern takes precedence over its dash array. */
function isDashStyleLayer(layer: StyleLayer): layer is LineStyleLayer {
  if (layer.type !== 'line' || isPatternStyleLayer(layer)) {
    return false;
  }
  const paint = layer.serialize().paint as Record<string, unknown> | undefined;
  return paint?.['line-dasharray'] != null;
}

/**
 * One line (a line layer feature or a fill outline ring) to render.
 * The positions are the ECEF centerline. Width and color change without
 * rebuilding it in either scene mode.
 */
export interface LinePrimitiveSource {
  layerId: string;
  featureIndex: number;
  positions: Float64Array;
  /** Canonical tile coordinates, paired with each ECEF source point. */
  tilePositions: Float64Array;
  /** Geodetic height applied by each layer's draw commands. */
  offsetMeters?: number;
}

export type LinePrimitiveSourceList = LinePrimitiveSource[];

/**
 * Cesium's polyline shader (PolylineCommon) expands vertices in window space
 * by `width / 2 * czm_pixelRatio`, giving a constant on-screen width with
 * miter joins (clamped to a bevel at sharp corners) and flat caps. The strip
 * shaders below add MapLibre's missing visuals:
 *
 * - a one-device-pixel antialiasing ramp, with a transparent geometry margin
 *   that keeps MSAA sample coverage from attenuating the ramp a second time;
 * - round caps: MapLibre's quad and fragment-distance clipping; round joins
 *   retain fan vertices expanded along the window-space segment normals;
 * - dashed lines sample the SDF dash atlas in the fragment shader with the
 *   from/to row crossfade (u_mix), dash lengths in line-width units and a
 *   screen-space SDF edge blur - the MapLibre line_sdf pipeline.
 *
 * The vertex shader uses Cesium's near-plane clipping helper from
 * PolylineColorAppearanceVS (Apache-2.0) with the corner machinery below;
 * Cesium's Primitive machinery supplies the geometry attributes and color
 * batch table.
 */
export const LINE_COMMON_SHADER = `
void clipLineSegmentToNearPlane(
    vec3 p0,
    vec3 p1,
    out vec4 positionWC,
    out bool clipped,
    out bool culledByNearPlane,
    out vec4 clippedPositionEC)
{
    culledByNearPlane = false;
    clipped = false;

    vec3 p0ToP1 = p1 - p0;
    float magnitude = length(p0ToP1);
    vec3 direction = normalize(p0ToP1);

    // Distance that p0 is behind the near plane. Negative means p0 is
    // in front of the near plane.
    float endPoint0Distance =  czm_currentFrustum.x + p0.z;

    // Camera looks down -Z.
    // When moving a point along +Z: LESS VISIBLE
    //   * Points in front of the camera move closer to the camera.
    //   * Points behind the camrea move farther away from the camera.
    // When moving a point along -Z: MORE VISIBLE
    //   * Points in front of the camera move farther away from the camera.
    //   * Points behind the camera move closer to the camera.

    // Positive denominator: -Z, becoming more visible
    // Negative denominator: +Z, becoming less visible
    // Nearly zero: parallel to near plane
    float denominator = -direction.z;

    if (endPoint0Distance > 0.0 && abs(denominator) < czm_epsilon7)
    {
        // p0 is behind the near plane and the line to p1 is nearly parallel to
        // the near plane, so cull the segment completely.
        culledByNearPlane = true;
    }
    else if (endPoint0Distance > 0.0)
    {
        // p0 is behind the near plane, and the line to p1 is moving distinctly
        // toward or away from it.

        // t = (-plane distance - dot(plane normal, ray origin)) / dot(plane normal, ray direction)
        float t = endPoint0Distance / denominator;
        if (t < 0.0 || t > magnitude)
        {
            // Near plane intersection is not between the two points.
            // We already confirmed p0 is behind the naer plane, so now
            // we know the entire segment is behind it.
            culledByNearPlane = true;
        }
        else
        {
            // Segment crosses the near plane, update p0 to lie exactly on it.
            p0 = p0 + t * direction;

            // Numerical noise might put us a bit on the wrong side of the near plane.
            // Don't let that happen.
            p0.z = min(p0.z, -czm_currentFrustum.x);

            clipped = true;
        }
    }

    clippedPositionEC = vec4(p0, 1.0);
    positionWC = czm_eyeToWindowCoordinates(clippedPositionEC);
}

`;

/**
 * Build the line strip vertex shader. The dash variant declares the dash
 * row attributes; the solid variant does not, so the two appearances only
 * ever require attributes their geometry actually carries (Cesium's
 * validateShaderMatching checks the compiled shader's active attributes
 * against the combined geometry's).
 */
function lineStripShader(dash: boolean): string {
  const inverseRadiiSquared = Ellipsoid.WGS84.oneOverRadiiSquared;
  return `
${LINE_COMMON_SHADER}
uniform float u_line_layer_offset;

vec3 lineHeightEC(vec3 positionMC)
{
    vec3 positionWC = (czm_model * vec4(positionMC, 1.0)).xyz;
    vec3 normalWC = czm_geodeticSurfaceNormal(positionWC, vec3(0.0),
        vec3(${inverseRadiiSquared.x}, ${inverseRadiiSquared.y}, ${inverseRadiiSquared.z}));
    return czm_viewRotation * normalWC * u_line_layer_offset;
}

in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 prevOffset3D;
in vec3 nextOffset3D;
in vec3 position2DHigh;
in vec3 position2DLow;
in vec3 prevOffset2D;
in vec3 nextOffset2D;
in float a_lineFlags;
uniform float u_line_width;
uniform vec4 u_line_color;
${LINE_FAN_PARAMETER_SHADER}
${dash ? 'in float a_linesofar;\nin vec3 a_dashFrom;\nin vec3 a_dashTo;' : ''}
in vec4 color;
in float batchId;

out vec4 v_color;
out float v_expandDir;
flat out vec4 v_lineCap;
flat out vec3 v_otherCap;
out float v_width;
#ifdef LINE_TILE_CLIP
out vec3 v_lineClip3DEye;
out vec3 v_lineClip2DEye;
#endif
${dash ? 'out float v_linesofar;\nout vec3 v_dashFrom;\nout vec3 v_dashTo;' : ''}

void main()
{
    uint flags = uint(a_lineFlags);
    uint role = flags >> 3;
    float a_corner = role >= 7u && role < 30u ? 3.0 : float(role);
    float expandDir = float(flags & 3u) - 1.0;
    bool usePrev = (flags & 4u) != 0u;
    float a_cornerParam = role >= 7u && role < 30u ? lineFanParameters[int(role) - 7]
        : (a_corner == 0.0 || role >= 30u ? czm_batchTable_lineMiterLimit(batchId) : (usePrev ? 1.0 : -1.0));
    float width = czm_batchTable_lineWidth(batchId) * u_line_width;
    // The AA boundary is half a device pixel outside the painted width.
    // One more device pixel covers every sample in an intersecting pixel,
    // including diagonals, without changing the fragment coverage.
    float outset = width * 0.5 + 1.5 / czm_pixelRatio;

    v_color = color * u_line_color;
    v_color.a *= step(0.001, width);
    v_expandDir = expandDir;
    v_lineCap = vec4(0.0);
    v_otherCap = vec3(0.0);
    v_width = width;
${dash ? '    v_linesofar = a_linesofar;\n    v_dashFrom = a_dashFrom;\n    v_dashTo = a_dashTo;\n' : ''}

    vec4 position3DEC = vec4(0.0, 0.0, 0.0, 1.0);
    vec4 prev3DEC = position3DEC;
    vec4 next3DEC = position3DEC;
    if (czm_morphTime > 0.0)
    {
        vec4 p3D = czm_translateRelativeToEye(position3DHigh * 65536.0, position3DLow);
        position3DEC = czm_modelViewRelativeToEye * p3D;
        prev3DEC = czm_modelViewRelativeToEye * (p3D + vec4(prevOffset3D, 0.0));
        next3DEC = czm_modelViewRelativeToEye * (p3D + vec4(nextOffset3D, 0.0));
        vec3 centerMC = position3DHigh * 65536.0 + position3DLow;
        position3DEC.xyz += lineHeightEC(centerMC);
        prev3DEC.xyz += lineHeightEC(centerMC + prevOffset3D);
        next3DEC.xyz += lineHeightEC(centerMC + nextOffset3D);
    }
    vec4 position2DEC = vec4(0.0, 0.0, 0.0, 1.0);
    vec4 prev2DEC = position2DEC;
    vec4 next2DEC = position2DEC;
    if (czm_morphTime < 1.0)
    {
        vec4 p2D = czm_translateRelativeToEye(position2DHigh.zxy * 65536.0, position2DLow.zxy);
        p2D.x += u_line_layer_offset;
        position2DEC = czm_modelViewRelativeToEye * p2D;
        prev2DEC = czm_modelViewRelativeToEye * (p2D + vec4(prevOffset2D.zxy, 0.0));
        next2DEC = czm_modelViewRelativeToEye * (p2D + vec4(nextOffset2D.zxy, 0.0));
    }
    vec4 positionEC = czm_columbusViewMorph(position2DEC, position3DEC, czm_morphTime);
    vec4 prevEC = czm_columbusViewMorph(prev2DEC, prev3DEC, czm_morphTime);
    vec4 nextEC = czm_columbusViewMorph(next2DEC, next3DEC, czm_morphTime);

    vec4 clippedPrevWC, clippedPrevEC;
    bool prevSegmentClipped, prevSegmentCulled;
    clipLineSegmentToNearPlane(prevEC.xyz, positionEC.xyz, clippedPrevWC, prevSegmentClipped, prevSegmentCulled, clippedPrevEC);

    vec4 clippedNextWC, clippedNextEC;
    bool nextSegmentClipped, nextSegmentCulled;
    clipLineSegmentToNearPlane(nextEC.xyz, positionEC.xyz, clippedNextWC, nextSegmentClipped, nextSegmentCulled, clippedNextEC);

    bool segmentClipped, segmentCulled;
    vec4 clippedPositionWC, clippedPositionEC;
    clipLineSegmentToNearPlane(positionEC.xyz, usePrev ? prevEC.xyz : nextEC.xyz, clippedPositionWC, segmentClipped, segmentCulled, clippedPositionEC);

    if (segmentCulled)
    {
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec2 directionToPrevWC = normalize(clippedPrevWC.xy - clippedPositionWC.xy);
    vec2 directionToNextWC = normalize(clippedNextWC.xy - clippedPositionWC.xy);
    if (prevSegmentCulled)
    {
        directionToPrevWC = -directionToNextWC;
    }
    else if (nextSegmentCulled)
    {
        directionToNextWC = -directionToPrevWC;
    }

    // Left normals of the incoming (prev -> position) and outgoing
    // (position -> next) segments, in window space.
    vec2 nPrev = vec2(directionToPrevWC.y, -directionToPrevWC.x);
    vec2 nNext = vec2(-directionToNextWC.y, directionToNextWC.x);

    // The endpoint pair provokes both cap and adjacent strip triangles.
    // Flat window coordinates give every MSAA sample the same analytic cap
    // distance even when its pixel center lies across their shared edge.
    if (a_corner >= 30.0)
    {
        v_lineCap = vec4(clippedPositionWC.xy, -(usePrev ? directionToPrevWC : directionToNextWC));
        v_otherCap = vec3(usePrev ? clippedPrevWC.xy : clippedNextWC.xy, a_corner == 31.0 ? 1.0 : 0.0);
    }

    vec2 thisSegmentForwardWC, otherSegmentForwardWC;
    if (usePrev)
    {
        thisSegmentForwardWC = -directionToPrevWC;
        otherSegmentForwardWC = directionToNextWC;
    }
    else
    {
        thisSegmentForwardWC = directionToNextWC;
        otherSegmentForwardWC = -directionToPrevWC;
    }

    vec2 offsetDir = vec2(0.0);
    float expandWidth = outset;

    if (a_corner == 1.0 || a_corner == 2.0)
    {
        // Butt vertex: half width along one segment's own normal, no miter.
        vec2 n = a_corner == 1.0 ? nPrev : nNext;
        offsetDir = n * expandDir;
    }
    else if (a_corner == 3.0)
    {
        // Round join fan: sweep the outer side of the turn from nPrev to
        // nNext, mirroring MapLibre's fakeround pie slices.
        float crossN = nPrev.x * nNext.y - nPrev.y * nNext.x;
        float phi = atan(crossN, dot(nPrev, nNext));
        float theta = phi * a_cornerParam;
        float c = cos(theta);
        float s = sin(theta);
        offsetDir = expandDir * vec2(nPrev.x * c - nPrev.y * s, nPrev.x * s + nPrev.y * c);
    }
    else if (a_corner == 4.0 || a_corner == 5.0)
    {
        // Both caps extend a quad by half a width. Round caps use the endpoint
        // pair's flat coordinates for fragment-space semicircle clipping.
        vec2 left = usePrev ? nPrev : nNext;
        vec2 fwd = usePrev ? -directionToPrevWC : directionToNextWC;
        // Square caps have no fragment clipping along the tangent, so their
        // painted length must exclude the transparent MSAA geometry margin.
        float capScale = a_corner == 5.0 ? (outset - 1.0 / czm_pixelRatio) / outset : 1.0;
        offsetDir = left * expandDir + fwd * a_cornerParam * capScale;
    }
    else if (a_corner == 6.0)
    {
        // Centerline anchor of the round-join fan wedges.
        offsetDir = vec2(0.0);
    }
    else
    {
        // Regular vertex: Cesium's miter expansion.
        vec2 thisSegmentLeftWC = vec2(-thisSegmentForwardWC.y, thisSegmentForwardWC.x);
        vec2 leftWC = thisSegmentLeftWC;
        if (!czm_equalsEpsilon(prevEC.xyz - positionEC.xyz, vec3(0.0), czm_epsilon1) && !czm_equalsEpsilon(nextEC.xyz - positionEC.xyz, vec3(0.0), czm_epsilon1))
        {
            vec2 otherSegmentLeftWC = vec2(-otherSegmentForwardWC.y, otherSegmentForwardWC.x);

            vec2 leftSumWC = thisSegmentLeftWC + otherSegmentLeftWC;
            float leftSumLength = length(leftSumWC);
            leftWC = leftSumLength < czm_epsilon6 ? thisSegmentLeftWC : (leftSumWC / leftSumLength);

            vec2 u = -thisSegmentForwardWC;
            vec2 v = leftWC;
            float sinAngle = abs(u.x * v.y - u.y * v.x);
            // Regular vertices read the feature's exact FLOAT miter limit
            // from Native's instance table.
            expandWidth = clamp(expandWidth / sinAngle, 0.0, outset * max(a_cornerParam, 1.0));
        }
        offsetDir = leftWC * expandDir;
    }

    vec4 positionWC = vec4(clippedPositionWC.xy + offsetDir * expandWidth * czm_pixelRatio, -clippedPositionWC.z, 1.0) * (czm_projection * clippedPositionEC).w;
    gl_Position = czm_viewportOrthographic * positionWC;
#ifdef LINE_TILE_CLIP
    // Native's inverseProjection is zero in 2D/orthographic views. Its
    // window helper also restores those views from the current frustum.
    vec4 lineClipWindow = czm_viewportTransformation * vec4(gl_Position.xyz / gl_Position.w, 1.0);
    lineClipWindow.w = 1.0 / gl_Position.w;
    vec4 lineClipPositionEC = czm_windowToEyeCoordinates(lineClipWindow);
    vec3 pixelEC = lineClipPositionEC.xyz / lineClipPositionEC.w;
    vec3 segmentEC = (usePrev ? prevEC : nextEC).xyz - positionEC.xyz;
    float clipFraction = segmentClipped ? dot(clippedPositionEC.xyz - positionEC.xyz, segmentEC) / dot(segmentEC, segmentEC) : 0.0;
    vec3 expansionEC = pixelEC - clippedPositionEC.xyz;
    vec3 clipped3DEC = position3DEC.xyz + clipFraction * ((usePrev ? prev3DEC : next3DEC).xyz - position3DEC.xyz);
    vec3 clipped2DEC = position2DEC.xyz + clipFraction * ((usePrev ? prev2DEC : next2DEC).xyz - position2DEC.xyz);
    v_lineClip3DEye = czm_morphTime == 1.0 ? pixelEC : clipped3DEC + expansionEC;
    v_lineClip2DEye = czm_morphTime == 0.0 ? pixelEC : clipped2DEC + expansionEC;
#endif
    // Coverage is a window-space distance. Cancel perspective interpolation
    // in the fragment shader so different endpoint depths do not skew it.
    v_expandDir *= gl_Position.w;
}
`;
}

export const LINE_STRIP_VS = lineStripShader(true);
export const LINE_AA_VS = lineStripShader(false);

const LINE_COVERAGE_SHADER = `
${LINE_TILE_CLIP_FRAGMENT}
float lineCoverage()
{
#ifdef LINE_TILE_CLIP
    clipLineTile();
#endif
    float halfWidth = v_width * czm_pixelRatio * 0.5;
    float tangent = max(dot(gl_FragCoord.xy - v_lineCap.xy, v_lineCap.zw), 0.0);
    if (v_otherCap.z > 0.0)
        tangent = max(tangent, dot(gl_FragCoord.xy - v_otherCap.xy, -v_lineCap.zw));
    float normal = v_expandDir * gl_FragCoord.w * (halfWidth + 1.5);
    return clamp(halfWidth + 0.5 - length(vec2(normal, tangent)), 0.0, 1.0);
}
`;

export const LINE_AA_FS = `
in vec4 v_color;
in float v_expandDir;
flat in vec4 v_lineCap;
flat in vec3 v_otherCap;
in float v_width;

${LINE_COVERAGE_SHADER}

void main()
{
    float coverage = lineCoverage();
    out_FragColor = vec4(v_color.rgb, v_color.a * coverage);
}
`;

export const DASH_LINE_FS = `
${LINE_COVERAGE_SHADER}

void main()
{
    float coverage = lineCoverage();
    if (coverage == 0.0)
    {
        out_FragColor = vec4(0.0);
        return;
    }
    czm_materialInput materialInput;
    materialInput.positionToEyeEC = vec3(0.0, 0.0, 0.0);
    materialInput.normalEC = vec3(0.0, 0.0, 1.0);
    materialInput.st = vec2(0.0);
    czm_material material = czm_getMaterial(materialInput);
    out_FragColor = vec4(v_color.rgb, v_color.a * coverage * material.alpha);
}
`;

/**
 * PolylineColorAppearance with the antialiasing ramp from {@link LINE_AA_FS}
 * and the round cap/join geometry from {@link LINE_STRIP_VS}. The vertex
 * shader is the stock polyline shader plus the extra varyings, so
 * per-instance colors and picking work unchanged.
 *
 * The appearance enables alpha blending for edge coverage, including opaque
 * paint. The ground command plan retains that blend state while placing the
 * commands in the OPAQUE execution slot to preserve style order.
 */
export class LineAAAppearance extends PolylineColorAppearance {
  constructor() {
    super({
      translucent: true,
      vertexShaderSource: lineTileShader(LINE_AA_VS),
      fragmentShaderSource: lineTileShader(LINE_AA_FS),
      // Round cap/join fans mix windings with the strip; render double-sided.
      renderState: { cull: { enabled: false } },
    });
  }
}

/** MapLibre fill outlines are one-pixel line segments over the fill mesh. */
class FillOutlineAppearance extends PolylineColorAppearance {
  constructor() {
    super({
      translucent: true,
      vertexShaderSource: `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
out vec4 v_color;
out vec2 v_position;
void main()
{
    vec4 position = czm_computePosition();
    gl_Position = czm_modelViewProjectionRelativeToEye * position;
    v_position = (gl_Position.xy / gl_Position.w * 0.5 + 0.5) * czm_viewport.zw + czm_viewport.xy;
    v_color = color;
}
`,
      fragmentShaderSource: `
in vec4 v_color;
in vec2 v_position;
void main()
{
    float coverage = 1.0 - smoothstep(0.0, 1.0, length(v_position - gl_FragCoord.xy));
    out_FragColor = vec4(v_color.rgb, v_color.a * coverage);
}
`,
      renderState: { cull: { enabled: false } },
    });
  }
}

/**
 * PolylineMaterialAppearance with the dash SDF fragment shader: the line
 * antialiasing ramp plus the dash coverage from the material (see
 * the line atlas material), colored per instance like the solid
 * track. The dash row data and the on-screen distance along the line arrive
 * as varyings from {@link LINE_STRIP_VS}.
 */
export class DashLineAppearance extends PolylineMaterialAppearance {
  constructor(options: { translucent: boolean; material: Material }) {
    super({
      translucent: options.translucent,
      material: options.material,
      vertexShaderSource: lineTileShader(LINE_STRIP_VS),
      fragmentShaderSource: lineTileShader(DASH_LINE_FS),
      renderState: { cull: { enabled: false } },
    });
  }
}

function lineTileShader(source: string): string {
  return `#define LINE_TILE_CLIP\n${source}`;
}

export interface LineFeatureStyle {
  color: Color;
  widthPx: number;
}

function lineFeatureStyle(bucket: Bucket, featureIndex: number, layerId: string, zoom: number): LineFeatureStyle {
  if (bucket instanceof LineBucket) {
    const style = lineStyleForFeature(bucket, featureIndex, layerId, zoom);
    return { color: style.color, widthPx: style.widthPx };
  }
  if (bucket instanceof FillBucket) {
    const style = fillStyleForFeature(bucket, featureIndex, layerId, zoom);
    return { color: style.outlineColor, widthPx: style.outlineWidthPx };
  }
  throw new TypeError(`linePrimitives reference a non-line bucket for layer ${layerId}`);
}

export interface LineDashResources {
  material: DashMaterial;
  rows?: Record<string, DashRow>;
}

function lineGeometryOptions(bucket: Bucket | undefined, layerId: string, featureIndex: number, dash: LineDashResources | undefined, dashed: boolean): LineGeometryOptions | undefined {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket))
    return undefined;
  const joinCap = bucket instanceof LineBucket
    ? bucket.featureLineJoinCaps[featureIndex] ?? bucket.lineJoinCap
    : { join: 'miter', cap: 'butt', miterLimit: 2, roundLimit: 1.05 };
  if (bucket instanceof LineBucket && dashed) {
    if (!dash)
      throw new Error('A line atlas is required to render dash layers');
    const rows = dashRowsForFeature(bucket, featureIndex, layerId, dash.rows, dash.material.atlas);
    if (!rows)
      return undefined;
    return { ...joinCap, widthPx: 255, dashFrom: rows.from, dashTo: rows.to };
  }
  return { ...joinCap, widthPx: bucket instanceof LineBucket ? 255 : 1 };
}

function lineGeometryKey(bucket: Bucket | undefined, layerId: string, featureIndex: number, dash: LineDashResources | undefined, dashed: boolean): string {
  const options = lineGeometryOptions(bucket, layerId, featureIndex, dash, dashed);
  return options ? lineLayoutKey(options) : 'omitted';
}

/** Build lines at continuous style zoom; pixel ratio is a shader uniform. */
export function buildLineCollection(
  sources: LinePrimitiveSourceList,
  buckets: { [layerId: string]: Bucket },
  tileId: string,
  tileID: CanonicalTileID | OverscaledTileID,
  generationId: number,
  zoom: number,
  planar = false,
  dash?: LineDashResources,
): PrimitiveCollection | undefined {
  const state = beginLineBuild(sources, buckets, tileId, tileID, generationId, zoom, planar, dash);
  stepLineBuild(state, UNBOUNDED_BUDGET);
  return commitLineBuild(state);
}

/**
 * Resumable per-feature line build. A layer keeps its own geometry instances
 * through commit; merging different style layers would lose painter order.
 *
 * Instances always share the translucent appearance: the fragment shader's
 * edge-coverage ramp rides in the alpha channel, and Cesium's opaque pass
 * ignores alpha (blending disabled), so an opaque appearance would drop the
 * antialiasing and leave hard, jagged edges on every line.
 */
export interface LineBuildState {
  clip: LineTileClip;
  geometryCache?: LineGeometryCache;
  byLayer: Array<{
    layerId: string;
    sources: LinePrimitiveSource[];
    offsetMeters: number;
    paintMode: 'uniform' | 'instance';
    zoomDependent: boolean;
    familyRoot?: string;
    dash: boolean;
    geometryInputs: Array<{ positions: Float64Array; tilePositions: Float64Array; key: string }>;
    instances?: GeometryInstance[];
    outlineInstances?: GeometryInstance[];
  }>;
  buckets: { [layerId: string]: Bucket };
  tileId: string;
  generationId: number;
  zoom: number;
  planar: boolean;
  dash?: LineDashResources;
  layerIndex: number;
  sourceIndex: number;
}

export function beginLineBuild(
  sources: LinePrimitiveSourceList,
  buckets: { [layerId: string]: Bucket },
  tileId: string,
  tileID: CanonicalTileID | OverscaledTileID,
  generationId: number,
  zoom: number,
  planar = false,
  dash?: LineDashResources,
): LineBuildState {
  const byLayer = new Map<string, LinePrimitiveSource[]>();
  for (const source of sources) {
    const list = byLayer.get(source.layerId);
    if (list) {
      list.push(source);
    }
    else {
      byLayer.set(source.layerId, [source]);
    }
  }
  const families = new Map<LineBucket, string[]>();
  for (const layerId of byLayer.keys()) {
    const bucket = buckets[layerId];
    if (!(bucket instanceof LineBucket) || isDashStyleLayer(layerFor(bucket, layerId)))
      continue;
    const members = families.get(bucket);
    if (members)
      members.push(layerId);
    else
      families.set(bucket, [layerId]);
  }
  return {
    clip: new LineTileClip(tileID),
    geometryCache: new LineGeometryCache(tileID),
    byLayer: [...byLayer].map(([layerId, layerSources]) => {
      const bucket = buckets[layerId];
      const dashed = bucket instanceof LineBucket && isDashStyleLayer(layerFor(bucket, layerId));
      const family = bucket instanceof LineBucket ? families.get(bucket) : undefined;
      const familyRoot = family && family.length > 1 ? family[0] : undefined;
      return {
        layerId,
        sources: layerSources,
        dash: dashed,
        geometryInputs: layerSources.map(source => ({ positions: source.positions, tilePositions: source.tilePositions, key: lineGeometryKey(bucket, layerId, source.featureIndex, dash, dashed) })),
        offsetMeters: layerSources[0].offsetMeters ?? 0,
        paintMode: linePaintMode(bucket, layerId),
        zoomDependent: linePaintUsesZoom(bucket, layerId),
        familyRoot,
      };
    }),
    buckets,
    tileId,
    generationId,
    zoom,
    planar,
    dash,
    layerIndex: 0,
    sourceIndex: 0,
  };
}

/** Build features until the budget is spent; true when every layer is built. */
export function stepLineBuild(state: LineBuildState, budget: Budget): boolean {
  // Finish at least one feature per call so a spent budget cannot livelock.
  // A single large feature remains the indivisible unit of line baking.
  let first = true;
  while (state.layerIndex < state.byLayer.length) {
    if (!first && budget.exhausted) {
      return false;
    }
    first = false;
    const layer = state.byLayer[state.layerIndex];
    if (layer.familyRoot && layer.familyRoot !== layer.layerId) {
      state.layerIndex++;
      state.sourceIndex = 0;
      continue;
    }
    const { layerId } = layer;
    const source = layer.sources[state.sourceIndex++];
    const bucket = state.buckets[layerId];
    if (bucket instanceof FillBucket && !state.planar) {
      layer.outlineInstances ??= [];
      appendFillOutlineInstances(layer.outlineInstances, source, bucket, state.tileId, state.generationId, layerId, state.zoom);
    }
    else {
      layer.instances ??= [];
      appendLineLayerInstances(layer.instances, source, bucket, state.tileId, state.generationId, layerId, state.zoom, state.planar, layer.paintMode, state.geometryCache!, state.dash, layer.dash);
    }
    if (state.sourceIndex === layer.sources.length) {
      state.layerIndex++;
      state.sourceIndex = 0;
    }
  }
  return true;
}

/** Shared appearance: stateless across primitives, so one for all tiles. */
const translucentLineAppearance = new LineAAAppearance();
const fillOutlineAppearance = new FillOutlineAppearance();
// Dense outlines need a vertex bound as well as an instance bound. Planar
// chunks project repeated neighbours once and can amortize larger uploads.
const MAX_LINE_BATCH_VERTICES = 6000;
const MAX_PLANAR_LINE_BATCH_VERTICES = 24000;
// Native also counts ordinary fill-outline Geometry, which has no line flags.
const numberOfVertices = (Geometry as typeof Geometry & {
  computeNumberOfVertices: (geometry: Geometry) => number;
}).computeNumberOfVertices;

function* lineChunks(instances: GeometryInstance[], planar: boolean): Generator<GeometryInstance[]> {
  const maxVertices = planar ? MAX_PLANAR_LINE_BATCH_VERTICES : MAX_LINE_BATCH_VERTICES;
  for (let offset = 0; offset < instances.length;) {
    let end = Math.min(instances.length, offset + MAX_LINE_INSTANCES);
    let vertices = 0;
    for (let index = offset; index < end; index++) {
      const count = numberOfVertices(instances[index].geometry);
      // A single feature remains indivisible, preserving its joins and caps.
      if (index > offset && vertices + count > maxVertices) {
        end = index;
        break;
      }
      vertices += count;
    }
    yield offset === 0 && end === instances.length ? instances : instances.slice(offset, end);
    offset = end;
  }
}

interface LineInstanceId {
  layerId: string;
  featureIndex: number;
}
type LineGroup = {
  instanceIds: LineInstanceId[];
  zoomDependent: boolean;
  layerId: string;
} & ({ kind: 'outline' } | {
  kind: 'line';
  firstFeatureIndex: number;
  paintMode: 'uniform' | 'instance';
  uniforms: LinePaintUniforms;
});
const lineGroups = new WeakMap<Primitive, LineGroup>();
const lineFamilies = new WeakMap<LineFamilyChunk, LineFamilyLayer[]>();
const lineGeometryInputs = new WeakMap<PrimitiveCollection, Array<Pick<LineBuildState['byLayer'][number], 'layerId' | 'dash' | 'sources' | 'geometryInputs'>>>();

function linePaintKinds(bucket: Bucket | undefined, layerId: string): Array<string | undefined> {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket)) {
    return [];
  }
  const layer = bucket.layers.find(candidate => candidate.id === layerId);
  const values = (layer as {
    _transitionablePaint?: { _values?: Record<string, { value?: { expression?: { kind?: string } } }> };
  } | undefined)?._transitionablePaint?._values;
  const properties = bucket instanceof LineBucket
    ? ['line-width', 'line-color', 'line-opacity', 'line-layer-opacity']
    : ['fill-outline-color', 'fill-color', 'fill-opacity', 'fill-layer-opacity', 'fill-antialias'];
  return properties.map(property => values?.[property]?.value?.expression?.kind);
}

function linePaintUsesZoom(bucket: Bucket | undefined, layerId: string): boolean {
  return linePaintKinds(bucket, layerId).some(kind => kind === 'camera' || kind === 'composite');
}

function linePaintMode(bucket: Bucket | undefined, layerId: string): 'uniform' | 'instance' {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket)) {
    return 'uniform';
  }
  const properties = bucket instanceof LineBucket
    ? ['line-width', 'line-color', 'line-opacity']
    : ['fill-outline-color', 'fill-color', 'fill-opacity'];
  const configuration = bucket.programConfigurations.get(layerId);
  return properties.some(property => !!configuration.getAttributeArray(property)) ? 'instance' : 'uniform';
}

function lineUniforms(clip: LineTileClip, width = 1, color: Color = CesiumColor.WHITE, offset = 0): LinePaintUniforms {
  const uniforms = {
    clip,
    width,
    color: CesiumColor.clone(color),
    offset,
    widthUniform: () => uniforms.width,
    colorUniform: () => uniforms.color,
    offsetUniform: () => uniforms.offset,
  };
  return uniforms;
}

function lineWidth(width: number): number {
  return Math.max(0, width);
}

/**
 * Each upload chunk belongs to one style layer, preserving painter order
 * while bounding Native upload preparation.
 */
export function commitLineBuild(state: LineBuildState): PrimitiveCollection | undefined {
  const collection = new PrimitiveCollection();
  for (const layer of state.byLayer) {
    if (layer.familyRoot && layer.familyRoot !== layer.layerId) {
      continue;
    }
    for (const instances of lineChunks(layer.outlineInstances ?? [], state.planar)) {
      const primitive = new GeometryPrimitive({
        geometryInstances: instances,
        appearance: fillOutlineAppearance,
      }, 'native');
      lineGroups.set(primitive, {
        kind: 'outline',
        instanceIds: instances.map(instance => instance.id as LineInstanceId),
        zoomDependent: layer.zoomDependent,
        layerId: layer.layerId,
      });
      registerDrawBatch(primitive, { layerId: layer.layerId, tileId: state.tileId, kind: 'fill-outline' });
      collection.add(primitive);
    }
    for (const instances of lineChunks(layer.instances ?? [], state.planar)) {
      if (layer.familyRoot) {
        const layers = state.byLayer
          .filter(candidate => candidate.familyRoot === layer.layerId)
          .map(candidate => ({
            layerId: candidate.layerId,
            bucket: state.buckets[candidate.layerId] as LineBucket,
            offsetMeters: candidate.offsetMeters,
            paintMode: candidate.paintMode,
            zoomDependent: candidate.zoomDependent,
          }));
        const chunk = new LineFamilyChunk(
          instances,
          layers,
          state.tileId,
          state.generationId,
          state.zoom,
          translucentLineAppearance,
          state.clip,
        );
        lineFamilies.set(chunk, layers);
        collection.add(chunk as unknown as Primitive);
        continue;
      }
      const primitive = new GeometryPrimitive({
        geometryInstances: instances,
        appearance: layer.dash
          ? new DashLineAppearance({ material: state.dash!.material.material, translucent: true })
          : translucentLineAppearance,
      }, 'line', layer.offsetMeters);
      registerDrawBatch(primitive, { layerId: layer.layerId, tileId: state.tileId, kind: layer.dash ? 'dash' : 'line' });
      const first = instances[0].id as LineInstanceId;
      const bucket = state.buckets[layer.layerId];
      const style = layer.paintMode === 'uniform' && bucket
        ? lineFeatureStyle(bucket, first.featureIndex, layer.layerId, state.zoom)
        : undefined;
      const uniforms = lineUniforms(
        state.clip,
        style ? lineWidth(style.widthPx) : 1,
        style?.color,
        layer.offsetMeters,
      );
      registerLinePaint(primitive, uniforms);
      lineGroups.set(primitive, {
        kind: 'line',
        firstFeatureIndex: first.featureIndex,
        instanceIds: layer.paintMode === 'instance'
          ? instances.map(instance => instance.id as LineInstanceId)
          : [],
        paintMode: layer.paintMode,
        zoomDependent: layer.zoomDependent,
        layerId: layer.layerId,
        uniforms,
      });
      collection.add(primitive);
    }
  }
  lineGeometryInputs.set(collection, state.byLayer.map(({ layerId, dash, sources, geometryInputs }) => ({ layerId, dash, sources, geometryInputs })));
  state.geometryCache = undefined;
  return collection.length > 0 ? collection : undefined;
}

function appendFillOutlineInstances(
  instances: GeometryInstance[],
  source: LinePrimitiveSource,
  bucket: FillBucket,
  tileId: string,
  generationId: number,
  layerId: string,
  zoom: number,
): void {
  const style = fillStyleForFeature(bucket, source.featureIndex, layerId, zoom);
  // Existing outline sources survive hidden paint so opacity transitions can
  // update Native attributes without rebuilding the other layers' geometry.
  const strip = source.positions;
  const count = strip.length / 3;
  if (count < 2)
    return;
  const indices = count < 65536 ? new Uint16Array((count - 1) * 2) : new Uint32Array((count - 1) * 2);
  for (let i = 0; i < count - 1; i++) {
    indices[i * 2] = i;
    indices[i * 2 + 1] = i + 1;
  }
  const attributes: Record<string, GeometryAttribute> = {
    position: new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: strip,
    }),
  };
  const geometry = new Geometry({
    attributes: attributes as never,
    indices,
    primitiveType: PrimitiveType.LINES,
    boundingSphere: BoundingSphere.fromVertices(strip),
  });
  instances.push(new GeometryInstance({
    geometry,
    id: { type: 'line', tileId, layerId, featureIndex: source.featureIndex, generationId },
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(style.outlineColor) },
  }));
}

/**
 * Append one feature's strips to its layer. Colors ride per instance;
 * the layer id survives in the pick id.
 */
function appendLineLayerInstances(
  instances: GeometryInstance[],
  source: LinePrimitiveSource,
  bucket: Bucket | undefined,
  tileId: string,
  generationId: number,
  layerId: string,
  zoom: number,
  planar: boolean,
  paintMode: 'uniform' | 'instance',
  geometryCache: LineGeometryCache,
  dash: LineDashResources | undefined,
  dashed: boolean,
): void {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket)) {
    return;
  }
  const style = paintMode === 'instance' ? lineFeatureStyle(bucket, source.featureIndex, layerId, zoom) : undefined;
  // Keep zero paint: camera zoom and transitions can reveal the same strip.
  if (source.positions.length < 6) {
    return;
  }
  const options = lineGeometryOptions(bucket, layerId, source.featureIndex, dash, dashed);
  if (!options)
    return;
  const geometry = geometryCache.geometry(source, options, planar);
  if (geometry) {
    instances.push(new GeometryInstance({
      geometry,
      id: { type: 'line', tileId, layerId, featureIndex: source.featureIndex, generationId },
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(style ? style.color : CesiumColor.WHITE),
        lineWidth: new GeometryInstanceAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 1,
          value: [style ? lineWidth(style.widthPx) : 1],
        }),
        lineMiterLimit: new GeometryInstanceAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 1,
          value: [Math.fround(options.join === 'bevel' ? 1.05 : options.miterLimit)],
        }),
      },
    }));
  }
}

function sameLineGeometry(
  layers: Array<Pick<LineBuildState['byLayer'][number], 'layerId' | 'dash' | 'sources' | 'geometryInputs'>>,
  buckets: { [layerId: string]: Bucket },
  dash?: LineDashResources,
): boolean {
  for (const layer of layers) {
    const bucket = buckets[layer.layerId];
    const dashed = bucket instanceof LineBucket && isDashStyleLayer(layerFor(bucket, layer.layerId));
    if (layer.dash !== dashed)
      return false;
    if (layer.sources.some((source, index) => source.positions !== layer.geometryInputs[index].positions
      || source.tilePositions !== layer.geometryInputs[index].tilePositions
      || lineGeometryKey(bucket, layer.layerId, source.featureIndex, dash, dashed) !== layer.geometryInputs[index].key)) {
      return false;
    }
  }
  return true;
}

/** Paint and camera changes keep a pending build; layout or representation changes cancel it. */
export function canResumeLineBuild(state: LineBuildState): boolean {
  return sameLineGeometry(state.byLayer, state.buckets, state.dash)
    && state.byLayer.every(layer => layer.paintMode === linePaintMode(state.buckets[layer.layerId], layer.layerId));
}

/** Paint can reuse geometry when its rows, layout and attribute representation still match. */
export function canUpdateLinePaint(collection: PrimitiveCollection, buckets: { [layerId: string]: Bucket }, dash?: LineDashResources): boolean {
  if (!sameLineGeometry(lineGeometryInputs.get(collection) ?? [], buckets, dash)) {
    return false;
  }
  for (let index = 0; index < collection.length; index++) {
    const child = collection.get(index);
    const layers = child instanceof LineFamilyChunk
      ? lineFamilies.get(child)
      : [lineGroups.get(child as Primitive)];
    if (!layers) {
      return false;
    }
    for (const layer of layers) {
      if (!layer) {
        return false;
      }
      if ('kind' in layer && layer.kind === 'outline') {
        continue;
      }
      const kinds = linePaintKinds(buckets[layer.layerId], layer.layerId);
      const mode = kinds.some(kind => kind === 'source' || kind === 'composite') ? 'instance' : 'uniform';
      if (layer.paintMode !== mode) {
        return false;
      }
    }
  }
  return true;
}

/** Change line paint without rebuilding or reuploading its centerlines. */
export function updateLinePaint(
  collection: PrimitiveCollection,
  buckets: { [layerId: string]: Bucket },
  zoom: number,
  force: boolean,
  transitionLayerIds?: ReadonlySet<string>,
): void {
  const color = new Uint8Array(4);
  for (let i = 0; i < collection.length; i++) {
    const child = collection.get(i);
    if (child instanceof LineFamilyChunk) {
      if (force) {
        for (const layer of lineFamilies.get(child)!) {
          layer.zoomDependent = linePaintUsesZoom(buckets[layer.layerId], layer.layerId);
        }
      }
      child.updatePaint(zoom, force, transitionLayerIds);
      continue;
    }
    const primitive = child as Primitive;
    const group = lineGroups.get(primitive);
    if (group && force) {
      group.zoomDependent = linePaintUsesZoom(buckets[group.layerId], group.layerId);
    }
    if (!group || (!group.zoomDependent && !(force && (!transitionLayerIds || transitionLayerIds.has(group.layerId))))) {
      continue;
    }
    if (group.kind === 'line' && group.paintMode === 'uniform') {
      const bucket = buckets[group.layerId];
      if (bucket) {
        const style = lineFeatureStyle(bucket, group.firstFeatureIndex, group.layerId, zoom);
        group.uniforms.width = lineWidth(style.widthPx);
        CesiumColor.clone(style.color, group.uniforms.color);
      }
      continue;
    }
    const styles = new Map<number, LineFeatureStyle>();
    for (const id of group.instanceIds) {
      const bucket = buckets[id.layerId];
      if (!bucket) {
        continue;
      }
      let style = styles.get(id.featureIndex);
      if (!style) {
        style = lineFeatureStyle(bucket, id.featureIndex, id.layerId, zoom);
        styles.set(id.featureIndex, style);
      }
      const attributes = primitive.getGeometryInstanceAttributes(id);
      if (group.kind === 'line') {
        const width = Math.fround(lineWidth(style.widthPx));
        if (attributes.lineWidth[0] !== width) {
          attributes.lineWidth = [width];
        }
      }
      ColorGeometryInstanceAttribute.toValue(style.color, color);
      const current = attributes.color;
      if (current[0] !== color[0] || current[1] !== color[1]
        || current[2] !== color[2] || current[3] !== color[3]) {
        attributes.color = color;
      }
    }
  }
}
