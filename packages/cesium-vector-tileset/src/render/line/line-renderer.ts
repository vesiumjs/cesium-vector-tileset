import type {
  Color,
  Material,
  Primitive,
} from 'cesium';
import type { Bucket } from '../../data/bucket';
import type { PreparedLineGeometry } from '../../data/projected-geometry';
import type { DashRow } from '../../source/worker-source';
import type { StyleLayer } from '../../style/style-layer';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { LinePaintUniforms } from '../scene/draw-batch';
import type { Budget } from '../scene/frame-budget';
import type { DashMaterial } from './dash-material';
import type { LineFamilyLayer } from './line-family';
import type { LineGeometryOptions } from './line-geometry';
import * as Cesium from 'cesium';
import {
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
import { geometryBoundingSphere } from '../geometry/geometry-bounds';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { lineInputs } from '../geometry/line-input';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { registerDrawBatch, registerLinePaint } from '../scene/draw-batch';
import { MAX_LINE_INSTANCES } from '../scene/frame-budget';
import { constantValue, fillStyleForFeature, layerFor, lineStyleForFeature } from '../vector/feature-attributes';
import { dashRowsForFeature } from './dash-material';
import { freezeLineCameraPaint } from './frozen-line-paint';
import { lineAppearanceForMode } from './line-appearance-mode';
import { LineFamilyChunk, updateLineUniforms } from './line-family';
import { LineGeometryCache, lineLayoutKey } from './line-geometry';
import { lineGroundScale } from './line-ground-scale';
import { LINE_TILE_CLIP_FRAGMENT, LineTileClip } from './line-tile-clip';
import { LINE_FAN_PARAMETER_SHADER } from './line-vertex-format';
import { restorePreparedLineGeometry } from './prepared-line-geometry';

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
  prepared?: PreparedLineGeometry;
  /** Geodetic height applied by each layer's draw commands. */
  offsetMeters?: number;
}

export type LinePrimitiveSourceList = LinePrimitiveSource[];

/**
 * Ground strips retain Native's positions and near-plane clipping, while
 * extruding their joins and caps in Web Mercator before camera projection.
 * The ECEF track uses the WGS84 ground Jacobian; planar tracks use the scene's
 * actual map projection. Both follow MapLibre's perspective width semantics:
 *
 * - a one-device-pixel antialiasing ramp, with a transparent geometry margin
 *   that keeps MSAA sample coverage from attenuating the ramp a second time;
 * - round caps: MapLibre's quad and fragment-distance clipping; round joins
 *   retain fan vertices expanded along the ground segment normals;
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
function lineHeightShader(): string {
  const inverseRadiiSquared = Ellipsoid.WGS84.oneOverRadiiSquared;
  return `
uniform float u_line_layer_offset;

vec3 lineHeightEC(vec3 positionMC)
{
    vec3 positionWC = (czm_model * vec4(positionMC, 1.0)).xyz;
    vec3 normalWC = czm_geodeticSurfaceNormal(positionWC, vec3(0.0),
        vec3(${inverseRadiiSquared.x}, ${inverseRadiiSquared.y}, ${inverseRadiiSquared.z}));
    return czm_viewRotation * normalWC * u_line_layer_offset;
}
`;
}

function lineStripShader(dash: boolean): string {
  return `
${LINE_COMMON_SHADER}
${lineHeightShader()}

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
uniform float u_line_meters_per_pixel;
uniform float u_line_mercator_projection;
${LINE_FAN_PARAMETER_SHADER}
${dash ? 'in float a_linesofar;\nin vec3 a_dashFrom;\nin vec3 a_dashTo;' : ''}
in vec4 color;
in float batchId;

out vec4 v_color;
out vec2 v_lineDistance;
out float v_gamma_scale;
out float v_width;
flat out vec3 v_capTangent;
flat out vec3 v_capDenominator;
flat out vec2 v_capExtent;
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
    // MapLibre extrudes in the ground plane before projection. The extra
    // transparent device pixel retains Native's multisample geometry margin.
    float outset = width * 0.5 + 1.5 / czm_pixelRatio;

    v_color = color * u_line_color;
    v_color.a *= step(0.001, width);
    v_width = width;
${dash ? '    v_linesofar = a_linesofar;\n    v_dashFrom = a_dashFrom;\n    v_dashTo = a_dashTo;\n' : ''}

    vec4 position3DEC = vec4(0.0, 0.0, 0.0, 1.0);
    vec4 prev3DEC = position3DEC;
    vec4 next3DEC = position3DEC;
    vec3 east3DEC = vec3(0.0);
    vec3 north3DEC = vec3(0.0);
    vec2 previousGround3D = vec2(0.0);
    vec2 nextGround3D = vec2(0.0);
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
        // Differential of WGS84 ECEF with respect to Web Mercator x/y.
        // Keeping the two axes separate preserves pitch and bearing shear;
        // a camera-distance scalar cannot represent this transformation.
        vec3 world = (czm_model * vec4(centerMC, 1.0)).xyz;
        vec3 normal = czm_geodeticSurfaceNormal(world, vec3(0.0),
            vec3(${Ellipsoid.WGS84.oneOverRadiiSquared.x}, ${Ellipsoid.WGS84.oneOverRadiiSquared.y}, ${Ellipsoid.WGS84.oneOverRadiiSquared.z}));
        vec3 east = normalize(vec3(-normal.y, normal.x, 0.0));
        vec3 north = cross(normal, east);
        float cosine = length(normal.xy);
        float eccentricitySquared = ${1 - (Ellipsoid.WGS84.minimumRadius / Ellipsoid.WGS84.maximumRadius) ** 2};
        float denominator = 1.0 - eccentricitySquared * normal.z * normal.z;
        float primeVertical = ${Ellipsoid.WGS84.maximumRadius.toFixed(1)} / sqrt(denominator);
        float meridional = primeVertical * (1.0 - eccentricitySquared) / denominator;
        vec3 radiiSquared = vec3(${Ellipsoid.WGS84.radiiSquared.x.toFixed(1)}, ${Ellipsoid.WGS84.radiiSquared.y.toFixed(1)}, ${Ellipsoid.WGS84.radiiSquared.z.toFixed(1)});
        vec3 surface = radiiSquared * normal / sqrt(dot(radiiSquared * normal, normal));
        float height = dot(world - surface, normal) + u_line_layer_offset;
        vec2 scale = vec2(primeVertical + height, meridional + height) * cosine / ${Ellipsoid.WGS84.maximumRadius.toFixed(1)};
        east3DEC = czm_viewRotation * east * scale.x;
        north3DEC = czm_viewRotation * north * scale.y;
        vec3 previousWorld = mat3(czm_model) * prevOffset3D;
        vec3 nextWorld = mat3(czm_model) * nextOffset3D;
        previousGround3D = vec2(dot(previousWorld, east), dot(previousWorld, north)) / scale;
        nextGround3D = vec2(dot(nextWorld, east), dot(nextWorld, north)) / scale;
    }
    vec4 position2DEC = vec4(0.0, 0.0, 0.0, 1.0);
    vec4 prev2DEC = position2DEC;
    vec4 next2DEC = position2DEC;
    vec3 east2DEC = vec3(0.0);
    vec3 north2DEC = vec3(0.0);
    vec2 previousGround2D = vec2(0.0);
    vec2 nextGround2D = vec2(0.0);
    if (czm_morphTime < 1.0)
    {
        vec4 p2D = czm_translateRelativeToEye(position2DHigh.zxy * 65536.0, position2DLow.zxy);
        p2D.x += u_line_layer_offset;
        position2DEC = czm_modelViewRelativeToEye * p2D;
        prev2DEC = czm_modelViewRelativeToEye * (p2D + vec4(prevOffset2D.zxy, 0.0));
        next2DEC = czm_modelViewRelativeToEye * (p2D + vec4(nextOffset2D.zxy, 0.0));
        // GeographicProjection uses R*latitude, while WebMercatorProjection
        // uses R*log(tan(pi/4+latitude/2)). Native records retain either one.
        float planarNorthScale = u_line_mercator_projection > 0.5 ? 1.0
            : cos((position2DHigh.y * 65536.0 + position2DLow.y) / ${Ellipsoid.WGS84.maximumRadius.toFixed(1)});
        east2DEC = (czm_modelViewRelativeToEye * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        north2DEC = (czm_modelViewRelativeToEye * vec4(0.0, 0.0, planarNorthScale, 0.0)).xyz;
        previousGround2D = prevOffset2D.xy / vec2(1.0, planarNorthScale);
        nextGround2D = nextOffset2D.xy / vec2(1.0, planarNorthScale);
    }
    vec4 positionEC = czm_columbusViewMorph(position2DEC, position3DEC, czm_morphTime);
    vec4 prevEC = czm_columbusViewMorph(prev2DEC, prev3DEC, czm_morphTime);
    vec4 nextEC = czm_columbusViewMorph(next2DEC, next3DEC, czm_morphTime);
    vec3 eastEC = mix(east2DEC, east3DEC, czm_morphTime);
    vec3 northEC = mix(north2DEC, north3DEC, czm_morphTime);
    vec2 previousGround = mix(previousGround2D, previousGround3D, czm_morphTime);
    vec2 nextGround = mix(nextGround2D, nextGround3D, czm_morphTime);

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

    vec2 directionToPrevGround = normalize(previousGround);
    vec2 directionToNextGround = normalize(nextGround);
    if (prevSegmentCulled)
    {
        directionToPrevGround = -directionToNextGround;
    }
    else if (nextSegmentCulled)
    {
        directionToNextGround = -directionToPrevGround;
    }

    // Ground normals use east/north axes, before the perspective transform.
    vec2 nPrev = vec2(-directionToPrevGround.y, directionToPrevGround.x);
    vec2 nNext = vec2(directionToNextGround.y, -directionToNextGround.x);

    vec2 thisSegmentForwardGround, otherSegmentForwardGround;
    if (usePrev)
    {
        thisSegmentForwardGround = -directionToPrevGround;
        otherSegmentForwardGround = directionToNextGround;
    }
    else
    {
        thisSegmentForwardGround = directionToNextGround;
        otherSegmentForwardGround = -directionToPrevGround;
    }

    vec2 offsetDir = vec2(0.0);
    vec2 squareTangent = vec2(0.0);
    float expandWidth = outset;

    if (a_corner == 1.0 || a_corner == 2.0)
    {
        // Butt vertex: half width along one segment's own normal, no miter.
        vec2 n = a_corner == 1.0 ? nPrev : nNext;
        offsetDir = n * expandDir;
    }
    else if (a_corner == 3.0)
    {
        // Round join fan: sweep the ground normals before projection.
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
        vec2 fwd = usePrev ? -directionToPrevGround : directionToNextGround;
        // Square caps have no fragment clipping along the tangent, so their
        // painted length must exclude the transparent MSAA geometry margin.
        float capScale = a_corner == 5.0 ? (outset - 1.0 / czm_pixelRatio) / outset : 1.0;
        offsetDir = left * expandDir + fwd * a_cornerParam * capScale;
        if (a_corner == 5.0)
            squareTangent = fwd * a_cornerParam;
    }
    else if (a_corner == 6.0)
    {
        // Centerline anchor of the round-join fan wedges.
        offsetDir = vec2(0.0);
    }
    else
    {
        // Regular vertex: bounded miter expansion in the ground plane.
        vec2 thisSegmentNormal = vec2(thisSegmentForwardGround.y, -thisSegmentForwardGround.x);
        vec2 groundNormal = thisSegmentNormal;
        if (!czm_equalsEpsilon(prevEC.xyz - positionEC.xyz, vec3(0.0), czm_epsilon1) && !czm_equalsEpsilon(nextEC.xyz - positionEC.xyz, vec3(0.0), czm_epsilon1))
        {
            vec2 otherSegmentNormal = vec2(otherSegmentForwardGround.y, -otherSegmentForwardGround.x);

            vec2 normalSum = thisSegmentNormal + otherSegmentNormal;
            float normalSumLength = length(normalSum);
            groundNormal = normalSumLength < czm_epsilon6 ? thisSegmentNormal : (normalSum / normalSumLength);

            vec2 u = -thisSegmentForwardGround;
            vec2 v = groundNormal;
            float sinAngle = abs(u.x * v.y - u.y * v.x);
            // Regular vertices read the feature's exact FLOAT miter limit
            // from Native's instance table.
            expandWidth = clamp(expandWidth / sinAngle, 0.0, outset * max(a_cornerParam, 1.0));
        }
        offsetDir = groundNormal * expandDir;
    }

    // MapLibre's gamma is measured from its painted AA envelope, rather than
    // our additional transparent multisample margin. unitsToPixels uses CSS
    // pixels, so DPR enters only the AA distance and the device viewport.
    vec2 direction = offsetDir * expandWidth / outset + squareTangent / (outset * czm_pixelRatio);
    vec2 gammaDirection = length(direction) > 0.0 ? direction : nNext;
    vec2 paintExtrusion = gammaDirection * (width * 0.5 + 0.5 / czm_pixelRatio);
    vec3 paintExpansionEC = (eastEC * paintExtrusion.x + northEC * paintExtrusion.y) * u_line_meters_per_pixel;
    vec4 projectedCenter = czm_projection * clippedPositionEC;
    v_capTangent = vec3(0.0);
    v_capDenominator = vec3(0.0, 0.0, 1.0);
    v_capExtent = vec2(0.0);
    if (role >= 30u || a_corner == 4.0)
    {
        // The endpoint pair provokes the cap and its adjacent strip. Both
        // triangles must evaluate the same ground semicircle at a pixel
        // centre, including MSAA pixels straddling their shared edge.
        // Invert the ground-plane homography instead of using a screen-space
        // circle: perspective may shear and foreshorten the two ground axes.
        vec4 projectedEast = czm_projection * vec4(eastEC * u_line_meters_per_pixel, 0.0);
        vec4 projectedNorth = czm_projection * vec4(northEC * u_line_meters_per_pixel, 0.0);
        mat3 groundFromClip = inverse(mat3(
            vec3(projectedEast.xy, projectedEast.w),
            vec3(projectedNorth.xy, projectedNorth.w),
            vec3(projectedCenter.xy, projectedCenter.w)));
        vec2 outward = -(usePrev ? directionToPrevGround : directionToNextGround);
        v_capTangent = outward.x * vec3(groundFromClip[0].x, groundFromClip[1].x, groundFromClip[2].x)
            + outward.y * vec3(groundFromClip[0].y, groundFromClip[1].y, groundFromClip[2].y);
        v_capDenominator = vec3(groundFromClip[0].z, groundFromClip[1].z, groundFromClip[2].z);
        v_capExtent = vec2(1.0, role == 31u
            ? length(usePrev ? previousGround : nextGround) / u_line_meters_per_pixel : -1.0);
    }
    vec4 projectedPaint = czm_projection * (clippedPositionEC + vec4(paintExpansionEC, 0.0));
    vec2 screenExtrusion = (projectedPaint.xy - projectedCenter.xy) / projectedPaint.w
        * czm_viewport.zw / (2.0 * czm_pixelRatio);
    v_gamma_scale = length(paintExtrusion) / max(length(screenExtrusion), czm_epsilon7);
    // One transparent device pixel must remain one projected device pixel,
    // even when perspective makes a ground pixel substantially narrower.
    float geometryOutset = width * 0.5 + (0.5 + v_gamma_scale) / czm_pixelRatio;
    vec2 extrusion = direction * geometryOutset - squareTangent * v_gamma_scale / czm_pixelRatio;
    vec3 expansionEC = (eastEC * extrusion.x + northEC * extrusion.y) * u_line_meters_per_pixel;
    vec4 expandedPositionEC = clippedPositionEC + vec4(expansionEC, 0.0);
    gl_Position = czm_projection * expandedPositionEC;
    v_lineDistance = vec2(expandDir, a_corner == 4.0 ? abs(a_cornerParam) : 0.0) * geometryOutset;
#ifdef LINE_TILE_CLIP
    // Native's inverseProjection is zero in 2D/orthographic views. Its
    // window helper also restores those views from the current frustum.
    vec3 pixelEC = expandedPositionEC.xyz;
    vec3 segmentEC = (usePrev ? prevEC : nextEC).xyz - positionEC.xyz;
    float clipFraction = segmentClipped ? dot(clippedPositionEC.xyz - positionEC.xyz, segmentEC) / dot(segmentEC, segmentEC) : 0.0;
    vec3 clipped3DEC = position3DEC.xyz + clipFraction * ((usePrev ? prev3DEC : next3DEC).xyz - position3DEC.xyz);
    vec3 clipped2DEC = position2DEC.xyz + clipFraction * ((usePrev ? prev2DEC : next2DEC).xyz - position2DEC.xyz);
    v_lineClip3DEye = czm_morphTime == 1.0 ? pixelEC : clipped3DEC + expansionEC;
    v_lineClip2DEye = czm_morphTime == 0.0 ? pixelEC : clipped2DEC + expansionEC;
#endif
    // Perspective interpolation retains ground distances for both coverage
    // and dash atlas coordinates, as in MapLibre's v_normal/v_linesofar.
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
    float halfWidth = v_width * 0.5;
    float tangent = max(v_lineDistance.y, 0.0);
    if (v_capExtent.x > 0.0)
    {
        vec3 clip = vec3((gl_FragCoord.xy - czm_viewport.xy) / czm_viewport.zw * 2.0 - 1.0, 1.0);
        float along = dot(v_capTangent, clip) / dot(v_capDenominator, clip);
        tangent = max(along, 0.0);
        if (v_capExtent.y >= 0.0)
            tangent = max(tangent, -along - v_capExtent.y);
    }
    float distance = length(vec2(v_lineDistance.x, tangent));
    float blur = v_gamma_scale / czm_pixelRatio;
    return clamp((halfWidth + 0.5 / czm_pixelRatio - distance) / blur, 0.0, 1.0);
}
`;

export const LINE_AA_FS = `
in vec4 v_color;
in vec2 v_lineDistance;
in float v_gamma_scale;
in float v_width;
flat in vec3 v_capTangent;
flat in vec3 v_capDenominator;
flat in vec2 v_capExtent;

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
 * shader retains Native's instance colors and picking while projecting the
 * ground extrusion and its antialiasing envelope.
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
${lineHeightShader()}
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
out vec4 v_color;
out vec2 v_position;
void main()
{
    vec4 position = czm_computePosition();
    vec4 positionEC = czm_modelViewRelativeToEye * position;
    vec3 height3DEC = lineHeightEC(position3DHigh + position3DLow);
    vec3 height2DEC = czm_modelViewRelativeToEye[0].xyz * u_line_layer_offset;
    positionEC.xyz += mix(height2DEC, height3DEC, czm_morphTime);
    gl_Position = czm_projection * positionEC;
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

function lineGeometryOptions(bucket: Bucket | undefined, layerId: string, featureIndex: number, dash: LineDashResources | undefined, dashed: boolean, resolveRows: typeof dashRowsForFeature): LineGeometryOptions | undefined {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket))
    return undefined;
  const joinCap = bucket instanceof LineBucket
    ? bucket.featureLineJoinCaps[featureIndex] ?? bucket.lineJoinCap
    : { join: 'miter', cap: 'butt', miterLimit: 2, roundLimit: 1.05 };
  if (bucket instanceof LineBucket && dashed) {
    if (!dash)
      throw new Error('A line atlas is required to render dash layers');
    const rows = resolveRows(bucket, featureIndex, layerId, dash.rows, dash.material.atlas);
    if (!rows)
      return undefined;
    return { ...joinCap, widthPx: 255, dashFrom: rows.from, dashTo: rows.to };
  }
  return { ...joinCap, widthPx: bucket instanceof LineBucket ? 255 : 1 };
}

function lineGeometryKey(bucket: Bucket | undefined, layerId: string, featureIndex: number, dash: LineDashResources | undefined, dashed: boolean, resolveRows: typeof dashRowsForFeature): string {
  const options = lineGeometryOptions(bucket, layerId, featureIndex, dash, dashed, resolveRows);
  return options ? lineLayoutKey(options) : 'omitted';
}

function lineLayout(bucket: Bucket | undefined, featureIndex: number): Pick<LineGeometryOptions, 'join' | 'cap' | 'miterLimit' | 'roundLimit'> | undefined {
  return bucket instanceof LineBucket ? bucket.featureLineJoinCaps[featureIndex] ?? bucket.lineJoinCap : undefined;
}

/**
 * Resumable point and instance line build. A layer keeps its own geometry instances
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
    instancePaint?: Map<number, LineFeatureStyle>;
    dash: boolean;
    geometryInputs: Array<{ positions: Float64Array; tilePositions: Float64Array; key: string; featureIndex: number; layout?: Pick<LineGeometryOptions, 'join' | 'cap' | 'miterLimit' | 'roundLimit'> }>;
    instances?: GeometryInstance[];
    maximumMiterLimit?: number;
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
  iterator?: Generator<void>;
  collection?: PrimitiveCollection;
  complete: boolean;
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
  const state: LineBuildState = {
    clip: new LineTileClip(tileID),
    geometryCache: new LineGeometryCache(tileID),
    byLayer: [],
    buckets,
    tileId,
    generationId,
    zoom,
    planar,
    dash,
    layerIndex: 0,
    sourceIndex: 0,
    complete: false,
  };
  state.iterator = compileLineBuild(state, sources);
  return state;
}

function* compileLineBuild(state: LineBuildState, sources: LinePrimitiveSourceList): Generator<void> {
  // Grouping and input snapshots are cheap; bound their work without reading
  // the frame clock per road. Geometry below keeps its own point quanta.
  const bookkeepingQuantum = 32;
  let pendingWork = 0;
  const byLayer = new Map<string, LinePrimitiveSource[]>();
  for (const source of sources) {
    const list = byLayer.get(source.layerId);
    if (list)
      list.push(source);
    else byLayer.set(source.layerId, [source]);
    if (++pendingWork === bookkeepingQuantum) {
      pendingWork = 0;
      yield;
    }
  }
  if (pendingWork) {
    pendingWork = 0;
    yield;
  }
  const families = new Map<LineBucket, string[]>();
  for (const layerId of byLayer.keys()) {
    const bucket = state.buckets[layerId];
    if (bucket instanceof LineBucket && !isDashStyleLayer(layerFor(bucket, layerId))) {
      const members = families.get(bucket);
      if (members)
        members.push(layerId);
      else families.set(bucket, [layerId]);
    }
    if (++pendingWork === bookkeepingQuantum) {
      pendingWork = 0;
      yield;
    }
  }
  if (pendingWork) {
    pendingWork = 0;
    yield;
  }
  for (const [layerId, layerSources] of byLayer) {
    const bucket = state.buckets[layerId];
    const dashed = bucket instanceof LineBucket && isDashStyleLayer(layerFor(bucket, layerId));
    const family = bucket instanceof LineBucket ? families.get(bucket) : undefined;
    const layer: LineBuildState['byLayer'][number] = {
      layerId,
      sources: layerSources,
      dash: dashed,
      geometryInputs: [],
      offsetMeters: layerSources[0].offsetMeters ?? 0,
      paintMode: linePaintMode(bucket, layerId),
      zoomDependent: linePaintUsesZoom(bucket, layerId),
      familyRoot: family && family.length > 1 ? family[0] : undefined,
    };
    state.byLayer.push(layer);
    for (const source of layerSources) {
      // Replay layers have no separate construction GeometryInstances. Keep
      // their committed paint within this budgeted, bounded build scan so a
      // frozen family can upload before any live style evaluation is allowed.
      if (layer.familyRoot && layer.paintMode === 'instance') {
        layer.instancePaint ??= new Map();
        if (!layer.instancePaint.has(source.featureIndex))
          layer.instancePaint.set(source.featureIndex, lineFeatureStyle(bucket, source.featureIndex, layerId, state.zoom));
      }
      const layout = lineLayout(bucket, source.featureIndex);
      layer.geometryInputs.push({
        positions: source.positions,
        tilePositions: source.tilePositions,
        featureIndex: source.featureIndex,
        layout: layout ? { ...layout } : undefined,
        key: lineGeometryKey(bucket, layerId, source.featureIndex, state.dash, dashed, dashRowsForFeature),
      });
      if (++pendingWork === bookkeepingQuantum) {
        pendingWork = 0;
        yield;
      }
    }
    if (pendingWork) {
      pendingWork = 0;
      yield;
    }
  }
  while (state.layerIndex < state.byLayer.length) {
    const layer = state.byLayer[state.layerIndex];
    if (!layer.familyRoot || layer.familyRoot === layer.layerId) {
      const { layerId } = layer;
      const bucket = state.buckets[layerId];
      for (; state.sourceIndex < layer.sources.length; state.sourceIndex++) {
        const source = layer.sources[state.sourceIndex];
        if (bucket instanceof FillBucket && !state.planar) {
          layer.outlineInstances ??= [];
          yield* appendFillOutlineInstances(layer.outlineInstances, source, bucket, state.tileId, state.generationId, layerId, state.zoom);
        }
        else {
          layer.instances ??= [];
          const miterLimit = yield* appendLineLayerInstances(layer.instances, source, bucket, state.tileId, state.generationId, layerId, state.zoom, state.planar, layer.paintMode, state.geometryCache!, state.dash, layer.dash);
          if (miterLimit !== undefined)
            layer.maximumMiterLimit = Math.max(layer.maximumMiterLimit ?? 0, miterLimit);
        }
        yield;
      }
    }
    state.layerIndex++;
    state.sourceIndex = 0;
    yield;
  }
  yield* assembleLineCollection(state);
}

/** Advance at least one small work unit even when the budget is already spent. */
export function stepLineBuild(state: LineBuildState, budget: Budget): boolean {
  if (state.complete)
    return true;
  if (!state.iterator)
    return false;
  do {
    if (state.iterator.next().done) {
      state.complete = true;
      state.iterator = undefined;
      return true;
    }
  } while (!budget.exhausted);
  return false;
}

/** Release unpublished primitives as well as the unfinished compiler arrays. */
export function discardLineBuild(state: LineBuildState): void {
  state.iterator?.return(undefined);
  state.iterator = undefined;
  state.collection?.destroy();
  state.collection = undefined;
  state.geometryCache = undefined;
  state.byLayer = [];
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

/** Representation limits, rather than cold work quanta, bound permanent pages. */
function* linePages(instances: GeometryInstance[]): Generator<GeometryInstance[]> {
  const maximumTextureSize = (Cesium as unknown as { ContextLimits: { maximumTextureSize: number } }).ContextLimits.maximumTextureSize;
  // Each centerline record occupies twelve uint32 values per track. Planar
  // scenes need both tracks; before a Native context exists, only the FLOAT
  // address limit is known. Do not assume a hardware texture size then.
  const maximumRecords = maximumTextureSize > 0
    ? Math.min(2 ** 24, Math.floor(maximumTextureSize ** 2 / 6))
    : 2 ** 24;
  for (let offset = 0; offset < instances.length;) {
    let end = offset;
    let records = 0;
    while (end < instances.length && end - offset < 65536) {
      const count = lineInputs.get(instances[end].geometry)!.positions.length / 3;
      if (count > maximumRecords)
        throw new RangeError('A line feature exceeds its geometry page record capacity');
      if (records + count > maximumRecords)
        break;
      records += count;
      end++;
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

function lineUniforms(clip: LineTileClip, width = 1, color: Color = CesiumColor.WHITE, offset = 0, zoom = 0): LinePaintUniforms {
  const uniforms = {
    clip,
    width,
    color: CesiumColor.clone(color),
    offset,
    metersPerPixel: lineGroundScale(zoom),
    widthUniform: () => uniforms.width,
    colorUniform: () => uniforms.color,
    offsetUniform: () => uniforms.offset,
    metersPerPixelUniform: () => uniforms.metersPerPixel,
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
  if (!state.complete)
    throw new Error('cannot commit unfinished line build');
  const collection = state.collection;
  state.collection = undefined;
  state.geometryCache = undefined;
  if (collection?.length)
    return collection;
  collection?.destroy();
  return undefined;
}

function* assembleLineCollection(state: LineBuildState): Generator<void> {
  const collection = new PrimitiveCollection();
  state.collection = collection;
  for (const layer of state.byLayer) {
    if (layer.familyRoot && layer.familyRoot !== layer.layerId) {
      continue;
    }
    for (const instances of lineChunks(layer.outlineInstances ?? [], state.planar)) {
      const primitive = new GeometryPrimitive({
        geometryInstances: instances,
        appearance: fillOutlineAppearance,
      }, 'native', layer.offsetMeters);
      registerLinePaint(primitive, lineUniforms(state.clip, 1, CesiumColor.WHITE, layer.offsetMeters));
      lineGroups.set(primitive, {
        kind: 'outline',
        instanceIds: instances.map(instance => instance.id as LineInstanceId),
        zoomDependent: layer.zoomDependent,
        layerId: layer.layerId,
      });
      registerDrawBatch(primitive, { layerId: layer.layerId, tileId: state.tileId, kind: 'fill-outline' });
      collection.add(primitive);
      yield;
    }
    for (const instances of state.buckets[layer.layerId] instanceof LineBucket ? linePages(layer.instances ?? []) : lineChunks(layer.instances ?? [], state.planar)) {
      if (layer.familyRoot) {
        const layers = state.byLayer
          .filter(candidate => candidate.familyRoot === layer.layerId)
          .map(candidate => ({
            layerId: candidate.layerId,
            bucket: state.buckets[candidate.layerId] as LineBucket,
            offsetMeters: candidate.offsetMeters,
            paintMode: candidate.paintMode,
            zoomDependent: candidate.zoomDependent,
            instancePaint: candidate.instancePaint,
          }));
        const chunk = new LineFamilyChunk(
          instances,
          layers,
          state.tileId,
          state.generationId,
          state.zoom,
          translucentLineAppearance,
          state.clip,
          layer.maximumMiterLimit,
        );
        lineFamilies.set(chunk, layers);
        collection.add(chunk as unknown as Primitive);
        yield;
        continue;
      }
      const primitive = new GeometryPrimitive({
        geometryInstances: instances,
        appearance: layer.dash
          ? new DashLineAppearance({ material: state.dash!.material.material, translucent: true })
          : translucentLineAppearance,
      }, 'line', layer.offsetMeters, lineAppearanceForMode);
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
        state.zoom,
      );
      registerLinePaint(primitive, uniforms, layer.paintMode === 'uniform' && layer.maximumMiterLimit !== undefined
        ? { widthFactor: 1, miterLimit: layer.maximumMiterLimit }
        : undefined);
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
      yield;
    }
    yield;
  }
  lineGeometryInputs.set(collection, state.byLayer.map(({ layerId, dash, sources, geometryInputs }) => ({ layerId, dash, sources, geometryInputs })));
  state.geometryCache = undefined;
}

function* appendFillOutlineInstances(
  instances: GeometryInstance[],
  source: LinePrimitiveSource,
  bucket: FillBucket,
  tileId: string,
  generationId: number,
  layerId: string,
  zoom: number,
): Generator<void> {
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
    yield;
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
    boundingSphere: yield* geometryBoundingSphere(strip),
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
function* appendLineLayerInstances(
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
): Generator<void, number | undefined> {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket)) {
    return;
  }
  const style = paintMode === 'instance' ? lineFeatureStyle(bucket, source.featureIndex, layerId, zoom) : undefined;
  // Keep zero paint: camera zoom and transitions can reveal the same strip.
  if (source.positions.length < 6) {
    return;
  }
  const options = lineGeometryOptions(bucket, layerId, source.featureIndex, dash, dashed, dashRowsForFeature);
  if (!options)
    return;
  const geometry = !planar && !dashed && source.prepared?.layoutKey === lineLayoutKey(options)
    && source.prepared.originalPositions === source.positions && source.prepared.originalTilePositions === source.tilePositions
    ? restorePreparedLineGeometry(source.prepared)
    : yield* geometryCache.compile(source, options, planar);
  if (geometry) {
    const miterLimit = Math.fround(options.join === 'bevel' ? 1.05 : options.miterLimit);
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
          value: [miterLimit],
        }),
      },
    }));
    return miterLimit;
  }
}

type LineGeometryInputs = LineBuildState['byLayer'][number]['geometryInputs'];
const validatedLineInputs = new WeakMap<LineGeometryInputs, { dependencies: unknown[]; count: number }>();

/** Revisions cover in-place feature paint; evaluated constants also change at zoom boundaries. */
function lineValidationDependencies(bucket: Bucket | undefined, layerId: string, dashed: boolean, dash?: LineDashResources): unknown[] {
  if (!(bucket instanceof LineBucket) && !(bucket instanceof FillBucket))
    return [bucket];
  const layer = layerFor(bucket, layerId);
  const configuration = bucket.programConfigurations.get(layerId);
  const dependencies: unknown[] = [bucket, layer, layer.paintRevision, bucket.programConfigurations, bucket.programConfigurations.paintRevision, configuration];
  if (dashed) {
    const array = configuration.getAttributeArray('line-dasharray');
    const constant = constantValue(layer, 'line-dasharray') as number[] | { from?: number[]; to?: number[] } | undefined;
    const from = Array.isArray(constant) ? constant : constant?.from;
    const to = Array.isArray(constant) ? constant : constant?.to;
    // Worker rows are normally replaced as one payload; their values remain
    // part of the proof so a row edited in place cannot reuse stale geometry.
    const rows = dash?.rows;
    const rowValues = rows ? Object.entries(rows).map(([key, row]) => `${key}:${row.dasharray.join(',')}`).join('|') : undefined;
    // Worker row keys and values do not read the atlas. Appending an unrelated
    // texture row only invalidates the constant branch that looks rows up there.
    const atlasRevision = array && rows ? undefined : dash?.material.atlas.revision;
    dependencies.push(array, array?.arrayBuffer, array?.length, array?.bytesPerElement, from?.join(','), to?.join(','), dash?.material, dash?.material.atlas, atlasRevision, rows, rowValues);
  }
  return dependencies;
}

/** One validation shares feature keys and constant rows; every path still checks its layout. */
function lineGeometryKeys(bucket: Bucket | undefined, layerId: string, dashed: boolean, dash: LineDashResources | undefined): (featureIndex: number) => string {
  const keys = new Map<number, string>();
  let resolveRows = dashRowsForFeature;
  if (dashed && bucket instanceof LineBucket
    && !(bucket.programConfigurations.get(layerId).getAttributeArray('line-dasharray') && dash?.rows)) {
    const rows = new Map<boolean, ReturnType<typeof dashRowsForFeature>>();
    resolveRows = (bucket, featureIndex, layerId, dashRows, atlas) => {
      const round = (bucket.featureLineJoinCaps[featureIndex] ?? bucket.lineJoinCap).cap === 'round';
      if (!rows.has(round))
        rows.set(round, dashRowsForFeature(bucket, featureIndex, layerId, dashRows, atlas));
      return rows.get(round);
    };
  }
  return (featureIndex) => {
    let key = keys.get(featureIndex);
    if (key === undefined) {
      key = lineGeometryKey(bucket, layerId, featureIndex, dash, dashed, resolveRows);
      keys.set(featureIndex, key);
    }
    return key;
  };
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
    const inputs = layer.geometryInputs;
    const dependencies = lineValidationDependencies(bucket, layer.layerId, dashed, dash);
    const validated = validatedLineInputs.get(inputs);
    const reusable = validated && dependencies.length === validated.dependencies.length
      && dependencies.every((value, index) => Object.is(value, validated.dependencies[index]));
    let keys: ReturnType<typeof lineGeometryKeys> | undefined;
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const source = layer.sources[index];
      const layout = source && lineLayout(bucket, source.featureIndex);
      // Source references and layout scalars are checked even when revision
      // evidence lets us skip feature-range and atlas lookups.
      if (!source || source.positions !== input.positions || source.tilePositions !== input.tilePositions
        || source.featureIndex !== input.featureIndex
        || layout?.join !== input.layout?.join || layout?.cap !== input.layout?.cap
        || layout?.miterLimit !== input.layout?.miterLimit || layout?.roundLimit !== input.layout?.roundLimit) {
        return false;
      }
      if (!reusable || index >= validated.count) {
        keys ??= lineGeometryKeys(bucket, layer.layerId, dashed, dash);
        if (keys(source.featureIndex) !== input.key)
          return false;
      }
    }
    validatedLineInputs.set(inputs, { dependencies, count: inputs.length });
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

/** Update only live uniforms; no geometry validation or per-instance writes. */
/** Capture the committed camera expressions of actual uploaded uniform owners. */
export function captureUniformLinePaint(collection: PrimitiveCollection, buckets: { [layerId: string]: Bucket }): (zoom: number) => void {
  const updates: Array<(zoom: number) => void> = [];
  for (let index = 0; index < collection.length; index++) {
    const child = collection.get(index);
    if (child instanceof LineFamilyChunk) {
      updates.push(child.captureCameraPaint());
      continue;
    }
    const group = lineGroups.get(child);
    const bucket = group ? buckets[group.layerId] : undefined;
    if (group?.kind !== 'line')
      continue;
    updates.push(zoom => group.uniforms.metersPerPixel = lineGroundScale(zoom));
    if (group.paintMode !== 'uniform' || !(bucket instanceof LineBucket))
      continue;
    const evaluate = freezeLineCameraPaint(bucket.layers.find(layer => layer.id === group.layerId)!);
    updates.push((zoom) => {
      const style = evaluate(zoom);
      group.uniforms.width = lineWidth(style.widthPx);
      CesiumColor.clone(style.color, group.uniforms.color);
    });
  }
  return (zoom) => {
    for (const update of updates) update(zoom);
  };
}

export function updateUniformLinePaint(collection: PrimitiveCollection, buckets: { [layerId: string]: Bucket }, zoom: number): void {
  for (let index = 0; index < collection.length; index++) {
    const child = collection.get(index);
    if (child instanceof LineFamilyChunk) {
      child.updateUniformPaint(zoom);
      continue;
    }
    const group = lineGroups.get(child as Primitive);
    if (group?.kind !== 'line') {
      continue;
    }
    group.uniforms.metersPerPixel = lineGroundScale(zoom);
    if (group.paintMode !== 'uniform')
      continue;
    const bucket = buckets[group.layerId];
    if (bucket instanceof LineBucket) {
      updateLineUniforms(group.uniforms, bucket, group.firstFeatureIndex, group.layerId, zoom);
    }
    else if (bucket) {
      const style = lineFeatureStyle(bucket, group.firstFeatureIndex, group.layerId, zoom);
      group.uniforms.width = lineWidth(style.widthPx);
      CesiumColor.clone(style.color, group.uniforms.color);
    }
  }
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
    if (group?.kind === 'line')
      group.uniforms.metersPerPixel = lineGroundScale(zoom);
    if (group && force) {
      group.zoomDependent = linePaintUsesZoom(buckets[group.layerId], group.layerId);
    }
    if (!group || (!group.zoomDependent && !(force && (!transitionLayerIds || transitionLayerIds.has(group.layerId))))) {
      continue;
    }
    if (group.kind === 'line' && group.paintMode === 'uniform') {
      const bucket = buckets[group.layerId];
      if (bucket instanceof LineBucket) {
        updateLineUniforms(group.uniforms, bucket, group.firstFeatureIndex, group.layerId, zoom);
      }
      else if (bucket) {
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
