import type { Camera, MapProjection, Material, SceneMode } from 'cesium';
import type { ProgramConfiguration } from '../../data/program-configuration';
import type { EvaluatedZoomSize, SizeData } from '../../symbol/symbol-size';
import type { SymbolPrimitiveGeometry } from './symbol-geometry';
import type { SymbolTranslation } from './symbol-translation';
import { BoundingSphere, Cartesian2, ComponentDatatype, Geometry, GeometryAttribute, GeometryInstance, GeometryInstanceAttribute, MaterialAppearance, Primitive, PrimitiveCollection, PrimitiveType } from 'cesium';
import { evaluateSizeForZoom } from '../../symbol/symbol-size';
import { MERCATOR_TRANSLATION_SHADER, mercatorTranslationPadding } from '../geometry/mercator-translation';
import { registerDrawBatch } from '../scene/draw-batch';
import { symbolMercatorDelta, symbolMercatorPosition, symbolMetersPerPixel } from './symbol-perspective';
import { INVALID_LINE_ANGLE } from './symbol-placement';

/** Project symbol corners in their actual viewport or Mercator label plane. */
export const SYMBOL_VERTEX_SHADER = `
uniform float u_camera_zoom;
uniform vec2 u_symbol_translation;
uniform float u_symbol_size;
uniform float u_symbol_size_t;
uniform float u_symbol_size_kind;
uniform float u_symbol_camera_distance;
uniform float u_symbol_orthographic;
uniform float u_symbol_mercator_projection;
uniform float u_symbol_opacity;
uniform float u_symbol_color_t;
uniform float u_symbol_halo_color_t;
uniform float u_symbol_opacity_t;
uniform float u_symbol_halo_width_t;
uniform float u_symbol_halo_blur_t;
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 a_offset;
in vec2 a_pxoffset;
in vec4 a_minfontscale;
in vec2 a_tex;
in vec4 a_size;
in vec4 a_size_max;
in vec2 a_symbol_modes;
in vec4 a_color;
in vec4 a_halo_color;
in float a_opacity;
in vec3 a_dynamic;
// Per-instance tile fade (see SYMBOL_FADE_ATTRIBUTE): Cesium injects the
// batch-table lookup for every custom instance attribute, so a whole tile
// fades without touching vertex buffers, materials, or the shared atlas
// textures. batchId is already declared below for the injected pick code.
in float batchId;

out vec2 v_tex;
out vec3 v_data;
out float v_is_sdf;
out vec4 v_color;
out vec4 v_halo_color;
out vec2 v_halo_size;
// Cesium's MaterialAppearance fragment shader reads these; the symbol shader
// colours from v_tex, so only the names have to line up.
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;

vec4 symbolColor(vec2 packed)
{
    vec2 high = floor(packed / 256.0);
    return vec4(high.x, packed.x - high.x * 256.0,
        high.y, packed.y - high.y * 256.0) / 255.0;
}

vec4 symbolPaintColor(vec4 packed, float factor)
{
    vec4 color = mix(symbolColor(packed.xy), symbolColor(packed.zw), factor);
    return color.a > 0.0 ? vec4(min(color.rgb / color.a, vec3(1.0)), color.a) : vec4(0.0);
}

// Small ground offsets produce angles near zero, where GPU transcendental
// built-ins can lose sub-metre displacements. These fifth-order series retain
// relative precision; their truncation error below 0.01 is below float rounding.
float symbolSin(float value)
{
    float square = value * value;
    return abs(value) < 0.01
        ? value * (1.0 + square * (-1.0 / 6.0 + square / 120.0))
        : sin(value);
}

float symbolTanh(float value)
{
    float square = value * value;
    return abs(value) < 0.01
        ? value * (1.0 + square * (-1.0 / 3.0 + square * 2.0 / 15.0))
        : tanh(value);
}

${MERCATOR_TRANSLATION_SHADER}

// Exact WGS84 displacement of a ground point by east/south Mercator metres.
// Difference formulas retain small corner offsets beside a 6-million-metre
// ECEF anchor, and work with scene3DOnly without projected attributes.
vec3 symbolGroundDeltaEC(vec2 metres, vec3 normal)
{
    float cosine = length(normal.xy);
    vec3 radial = vec3(normal.xy / max(cosine, 1.0e-12), 0.0);
    vec3 east = vec3(-radial.y, radial.x, 0.0);
    float t = symbolTanh(-metres.y / 6378137.0);
    float root = sqrt(max(0.0, 1.0 - t * t));
    float denominator = 1.0 + normal.z * t;
    float deltaSin = cosine * cosine * t / denominator;
    float deltaCos = cosine * (-t * t / (root + 1.0) - normal.z * t) / denominator;
    float newSin = normal.z + deltaSin;
    float newCos = cosine + deltaCos;
    float eccentricitySquared = 0.0066943799901413165;
    float oldDenominator = 1.0 - eccentricitySquared * normal.z * normal.z;
    float newDenominator = 1.0 - eccentricitySquared * newSin * newSin;
    float oldRoot = sqrt(oldDenominator);
    float newRoot = sqrt(newDenominator);
    float primeVertical = 6378137.0 / newRoot;
    float deltaPrimeVertical = 6378137.0 * eccentricitySquared
        * (2.0 * normal.z * deltaSin + deltaSin * deltaSin)
        / (oldRoot * newRoot * (oldRoot + newRoot));
    float radius = primeVertical * newCos;
    float deltaRadius = deltaPrimeVertical * cosine + primeVertical * deltaCos;
    float longitudeDelta = metres.x / 6378137.0;
    float halfSin = symbolSin(longitudeDelta * 0.5);
    vec3 delta = radial * (deltaRadius - radius * 2.0 * halfSin * halfSin)
        + east * radius * symbolSin(longitudeDelta)
        + vec3(0.0, 0.0, (1.0 - eccentricitySquared)
            * (deltaPrimeVertical * normal.z + primeVertical * deltaSin));
    vec3 delta3DEC = (czm_modelViewRelativeToEye * vec4(delta, 0.0)).xyz;
    float latitudeDelta = atan(deltaSin * cosine - deltaCos * normal.z,
        newSin * normal.z + newCos * cosine);
    float north = u_symbol_mercator_projection > 0.5 ? -metres.y : latitudeDelta * 6378137.0;
    vec3 delta2DEC = (czm_modelViewRelativeToEye * vec4(0.0, metres.x, north, 0.0)).xyz;
    return mix(delta2DEC, delta3DEC, czm_morphTime);
}

void main()
{
    vec3 world = position3DHigh + position3DLow;
    bool mapPitch = a_symbol_modes.x == 2.0 || a_symbol_modes.x == 4.0;
    bool translated = any(notEqual(u_symbol_translation, vec2(0.0)));
    vec3 normal = vec3(0.0);
    if (translated || mapPitch || any(notEqual(a_size_max.yz, vec2(0.0)))) {
        normal = czm_geodeticSurfaceNormal(world, vec3(0.0),
            vec3(2.458172257647332e-14, 2.458172257647332e-14, 2.4747391015697002e-14));
    }
    vec3 translationWorld = vec3(0.0);
    vec3 translationEC = vec3(0.0);
    if (translated) {
        vec3 translation = cvt_mercatorDelta(normal, u_symbol_translation, 0.0,
            u_symbol_mercator_projection > 0.5, translationWorld);
        translationEC = (czm_modelViewRelativeToEye * vec4(translation, 0.0)).xyz;
    }
    // Batch bounds can span both sides of the horizon. Test each ECEF anchor
    // against the ellipsoid even when depth testing is disabled for symbols.
    // Use the live camera so an older collision generation cannot show a
    // far-side symbol while the next placement is still being computed.
    if (czm_sceneMode == czm_sceneMode3D)
    {
        vec3 camera = czm_viewerPositionWC * czm_ellipsoidInverseRadii;
        vec3 anchor = (world + translationWorld) * czm_ellipsoidInverseRadii;
        vec3 toAnchor = anchor - camera;
        float limbSquared = dot(camera, camera) - 1.0;
        float towardCamera = -dot(toAnchor, camera);
        bool occluded = limbSquared < 0.0
            ? towardCamera > 0.0
            : towardCamera > limbSquared
                && towardCamera * towardCamera > limbSquared * dot(toAnchor, toAnchor);
        if (occluded)
        {
            gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
            return;
        }
    }
    // Cesium injects projected position2DHigh/Low only when the appearance
    // calls czm_computePosition. Reading the ECEF attributes directly makes
    // symbols disappear in 2D and Columbus View.
    vec4 eyeRelative = czm_computePosition();
    vec4 positionEC = czm_modelViewRelativeToEye * eyeRelative;
    positionEC.xyz += translationEC;
    vec4 clip = czm_projection * positionEC;

    // a_size packs (size * 128) << 2 | isSdf << 1 | isText. MapLibre's
    // symbol_icon.vertex scales text offsets by size / 24 (they are expressed
    // in the 24px glyph em) and icon offsets by size directly (they are
    // already in sprite pixels); dividing icons by 24 rendered every icon at
    // 1/24th of its size. The kind flag rides in the vertex because Cesium's
    // material uniform map only reaches the fragment stage.
    float packed = a_size.x;
    float sizeMin = floor(packed / 4.0);
    float rest = packed - 4.0 * sizeMin;
    float isSdf = rest >= 2.0 ? 1.0 : 0.0;
    float isText = rest - 2.0 * isSdf;
    float size = u_symbol_size_kind < 0.5 ? u_symbol_size
        : mix(sizeMin, a_size_max.x, u_symbol_size_t) / 128.0;
    vec4 workerClip = clip;
    if (any(notEqual(a_size_max.yz, vec2(0.0)))) {
        workerClip += czm_projection * vec4(symbolGroundDeltaEC(a_size_max.yz, normal), 0.0);
    }
    if (a_symbol_modes.x > 0.5 && a_symbol_modes.x < 2.5 && u_symbol_orthographic < 0.5) {
        if (!(u_symbol_camera_distance > 0.0) || !(workerClip.w > 0.0)) {
            gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
            return;
        }
        float distanceRatio = mapPitch ? workerClip.w / u_symbol_camera_distance
            : u_symbol_camera_distance / workerClip.w;
        size *= clamp(0.5 + 0.5 * distanceRatio, 0.0, 4.0);
    }

    // Collision writes per-vertex visibility into a_opacity; the tile fade
    // scales it per instance, so a leaving tile's symbols ramp out together
    // while hidden ones stay culled (MapLibre's symbol hold semantics).
    float effectiveOpacity = a_opacity * czm_batchTable_fade(batchId)
        * u_symbol_opacity * mix(a_size.y, a_size.z, u_symbol_opacity_t);
    // Failed live line projection uses a reserved angle independently of the
    // last complete collision layout, so a glyph cannot detach from its road.
    if (effectiveOpacity < 0.1 || a_dynamic.z == ${INVALID_LINE_ANGLE.toFixed(1)})
    {
        gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
        return;
    }

    float fontScale = isText > 0.5 ? size / 24.0 : size;
    // MapLibre offsets are y-down (tile pixels grow south, matching screen
    // pixels from the top). NDC y grows up, so the combined offset is flipped
    // to y-up first; the matrix below is then MapLibre's R_down form, which
    // composes with the flip (F * R_down * F = R_ydown) so the on-screen
    // rotation equals MapLibre's effective rotation R_ydown(phi) applied to
    // the tile-space segment angle phi: glyph-east lands on the line
    // direction without mirroring (the previous R_up form mirrored every
    // rotated glyph across its baseline). Stretchable icons (icon-text-fit)
    // contribute a_pixeloffset and a per-vertex minimum scale the same way
    // symbol_icon.vertex does (max per component).
    vec2 effectiveScale = max(a_minfontscale.xy, vec2(fontScale));
    vec2 combined = a_offset * effectiveScale + a_pxoffset;
    combined.y = -combined.y;
    vec2 offsetPx = combined * czm_pixelRatio;
    // The dynamic channel places each line glyph on its projected path each
    // frame; point symbols leave it at zero.
    float totalAngle = a_dynamic.z;
    float angleCos = cos(totalAngle);
    float angleSin = sin(totalAngle);
    offsetPx = mat2(angleCos, -angleSin, angleSin, angleCos) * offsetPx;

    gl_Position = clip;
    if (mapPitch) {
        float metresPerPixel = 40075016.68557849 / (512.0 * exp2(u_camera_zoom));
        vec2 metres = a_dynamic.xy + vec2(offsetPx.x, -offsetPx.y) / czm_pixelRatio * metresPerPixel;
        if (a_size_max.w == 1.0) {
            // Inverse ground-to-eye XY columns, independently normalized as
            // MapLibre's viewport-rotated, map-pitched label plane requires.
            vec3 eastEC = symbolGroundDeltaEC(vec2(1.0, 0.0), normal);
            vec3 southEC = symbolGroundDeltaEC(vec2(0.0, 1.0), normal);
            vec2 east = vec2(-southEC.y, eastEC.y);
            vec2 south = vec2(-southEC.x, eastEC.x);
            float eastLength = length(east);
            float southLength = length(south);
            east = eastLength < 1.0e-9 ? vec2(0.0) : east / eastLength;
            south = southLength < 1.0e-9 ? vec2(0.0) : south / southLength;
            metres = east * metres.x + south * metres.y;
        }
        gl_Position += czm_projection * vec4(symbolGroundDeltaEC(metres, normal), 0.0);
    } else {
        gl_Position.xy += ((offsetPx + vec2(a_dynamic.x, -a_dynamic.y)) / czm_viewport.zw) * clip.w * 2.0;
    }

    v_tex = a_tex;
    // MapLibre's SDF gamma is final clip W divided by cos(pitch)*D.
    // The ordinary viewport coordinate matrix has W=1. Native's clip units
    // differ, so normalize only the map label plane in matching world units.
    float gammaScale = 1.0;
    if (mapPitch && u_symbol_orthographic < 0.5) {
        vec3 cameraNormal = czm_geodeticSurfaceNormal(czm_viewerPositionWC, vec3(0.0),
            vec3(2.458172257647332e-14, 2.458172257647332e-14, 2.4747391015697002e-14));
        float cosine3D = abs((czm_viewRotation * cameraNormal).z);
        float cosine2D = abs((czm_modelViewRelativeToEye * vec4(1.0, 0.0, 0.0, 0.0)).z);
        float gammaDistance = mix(cosine2D, cosine3D, czm_morphTime) * u_symbol_camera_distance;
        // At an exactly horizontal direction the mathematical gamma limit
        // is infinite. Encode that limit rather than generate NaN coverage.
        gammaScale = gammaDistance > 0.0 ? gl_Position.w / gammaDistance : -1.0;
    }
    v_data = vec3(gammaScale, size, effectiveOpacity);
    v_is_sdf = isSdf;
    v_color = symbolPaintColor(a_color, u_symbol_color_t);
    v_halo_color = symbolPaintColor(a_halo_color, u_symbol_halo_color_t);
    v_halo_size = vec2(mix(a_minfontscale.z, a_minfontscale.w, u_symbol_halo_width_t),
        mix(a_size.w, a_symbol_modes.y, u_symbol_halo_blur_t));
    v_positionEC = positionEC.xyz;
    v_normalEC = vec3(0.0, 0.0, 1.0);
    v_st = vec2(0.0);
}
`;

export class SymbolAppearance extends MaterialAppearance {
  constructor(options: { translucent: boolean; material: Material }) {
    super({
      flat: true,
      translucent: options.translucent,
      material: options.material,
      vertexShaderSource: SYMBOL_VERTEX_SHADER,
      renderState: {
        cull: { enabled: false },
        depthTest: { enabled: false },
        depthMask: false,
      },
    });
  }
}

interface SymbolBounds {
  sphere: BoundingSphere;
  mapPitch: boolean;
  viewportPerspective: boolean;
  sizePerspective: boolean;
  viewportGroundAxes: boolean;
  text: boolean;
  offset: number;
  sourceOffset: number;
  minimum: number;
  pixels: number;
  lineOffset: number;
  sourceLineOffset: number;
  variable?: SymbolPrimitiveGeometry['variableBounds'];
}

// The worker's immutable quad arrays survive placement generations. Cache
// endpoint extents at build time; camera updates never walk glyph vertices.
const boundsCache = new WeakMap<Float32Array, SymbolBounds>();
const geometryBounds = new WeakMap<Geometry, SymbolBounds>();

function staticBounds(geometry: SymbolPrimitiveGeometry): SymbolBounds {
  const cached = boundsCache.get(geometry.offsets);
  if (cached)
    return cached;
  const sphere = BoundingSphere.fromVertices(geometry.positions);
  // Dynamic line glyphs can move to another segment of the worker path as
  // zoom and pitch change; the baked glyph anchors alone are not their bounds.
  for (const instance of geometry.instances) {
    if (instance.line) {
      BoundingSphere.union(sphere, BoundingSphere.fromVertices(instance.line.pathECEF), sphere);
    }
  }
  const text = Math.floor(geometry.sizes[0]) % 2 === 1;
  const divisor = text ? 24 : 1;
  let offset = 0;
  let sourceOffset = 0;
  let minimum = 0;
  let pixels = 0;
  for (let vertex = 0; vertex < geometry.sizes.length; vertex++) {
    const index = vertex * 2;
    const x = geometry.offsets[index];
    const y = geometry.offsets[index + 1];
    const radius = Math.hypot(x, y);
    const size = Math.max(Math.floor(geometry.sizes[vertex] / 4), geometry.sizesMax[vertex]) / 128;
    offset = Math.max(offset, radius);
    sourceOffset = Math.max(sourceOffset, radius * size / divisor);
    minimum = Math.max(minimum, Math.hypot(x * geometry.minfontscales[index], y * geometry.minfontscales[index + 1]));
    pixels = Math.max(pixels, Math.hypot(geometry.pxoffsets[index], geometry.pxoffsets[index + 1]));
  }
  let lineOffset = 0;
  let sourceLineOffset = 0;
  for (const instance of geometry.instances) {
    if (!instance.line)
      continue;
    const vertex = instance.vertexStart;
    const size = Math.max(Math.floor(geometry.sizes[vertex] / 4), geometry.sizesMax[vertex]) / 128;
    lineOffset = Math.max(lineOffset, Math.abs(instance.line.lineOffsetY) / 24);
    sourceLineOffset = Math.max(sourceLineOffset, Math.abs(instance.line.lineOffsetY) * size / 24);
  }
  const bounds = { sphere, mapPitch: geometry.mapPitch, viewportPerspective: geometry.viewportPerspective, sizePerspective: geometry.sizePerspective, viewportGroundAxes: geometry.pointMapRotation === 'viewport', text, offset, sourceOffset, minimum, pixels, lineOffset, sourceLineOffset, variable: geometry.variableBounds };
  boundsCache.set(geometry.offsets, bounds);
  return bounds;
}

/**
 * A batch whose attributes disagree on the vertex count would make Cesium's
 * Geometry fail (and stop the whole scene render), so such a batch is dropped
 * instead of submitted.
 */
function batchIsValid(geometry: SymbolPrimitiveGeometry): boolean {
  const n = geometry.positions.length / 3;
  return Math.floor(n) === n
    && n > 0
    && geometry.offsets.length === n * 2
    && geometry.pxoffsets.length === n * 2
    && geometry.minfontscales.length === n * 2
    && geometry.tex.length === n * 2
    && geometry.sizes.length === n
    && geometry.dynamics.length === n * 3
    && geometry.opacities.length === n;
}

export function symbolGeometry(geometry: SymbolPrimitiveGeometry, indices: Uint32Array): Geometry | undefined {
  if (!batchIsValid(geometry)) {
    return undefined;
  }
  const bounds = staticBounds(geometry);
  const minfontscales = new Float32Array(geometry.positions.length / 3 * 4);
  for (let index = 0; index < geometry.positions.length / 3; index++) {
    minfontscales[index * 4] = geometry.minfontscales[index * 2];
    minfontscales[index * 4 + 1] = geometry.minfontscales[index * 2 + 1];
    minfontscales[index * 4 + 2] = minfontscales[index * 4 + 3] = -1;
  }
  // Native adds four position attributes and batchId. Paint scalar endpoints
  // use free size/zoom lanes, retaining the existing 16 attribute slots.
  const symbolModes = new Float32Array(geometry.positions.length / 3 * 2);
  const sizes = new Float32Array(geometry.sizes.length * 4);
  for (let index = 0; index < geometry.positions.length / 3; index++) {
    symbolModes[index * 2] = geometry.mapPitch ? (geometry.sizePerspective ? 2 : 4) : geometry.viewportPerspective ? (geometry.sizePerspective ? 1 : 3) : 0;
    symbolModes[index * 2 + 1] = -1;
    sizes[index * 4] = geometry.sizes[index];
    sizes[index * 4 + 1] = sizes[index * 4 + 2] = 1;
    sizes[index * 4 + 3] = -1;
  }
  // The ratio belongs to the worker label anchor, not each baked glyph.
  // Store its label-plane delta in the size attribute's unused lanes.
  const sizeAnchors = new Float32Array(geometry.sizesMax.length * 4);
  for (let index = 0; index < geometry.sizesMax.length; index++) {
    sizeAnchors[index * 4] = geometry.sizesMax[index];
    sizeAnchors[index * 4 + 3] = geometry.pointMapRotation === 'viewport' ? 1 : 0;
  }
  for (const instance of geometry.instances) {
    if (!instance.line || (!geometry.viewportPerspective && !geometry.mapPitch))
      continue;
    const worker = symbolMercatorPosition(instance.line.anchorECEF.x, instance.line.anchorECEF.y, instance.line.anchorECEF.z);
    if (!worker)
      continue;
    for (let index = instance.vertexStart; index < instance.vertexStart + instance.vertexCount; index++) {
      const position = index * 3;
      const glyph = symbolMercatorPosition(geometry.positions[position], geometry.positions[position + 1], geometry.positions[position + 2]);
      if (glyph) {
        sizeAnchors[index * 4 + 1] = symbolMercatorDelta(worker.x, glyph.x);
        sizeAnchors[index * 4 + 2] = worker.y - glyph.y;
      }
    }
  }
  const result = new Geometry({
    attributes: {
      // Emitted DOUBLE on purpose: Cesium's pipeline encodes it into the
      // position3DHigh/position3DLow pair the vertex shader reads.
      position: new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: geometry.positions,
      }),
      a_offset: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: geometry.offsets,
      }),
      a_pxoffset: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: geometry.pxoffsets,
      }),
      a_minfontscale: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        values: minfontscales,
      }),
      a_tex: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: geometry.tex,
      }),
      a_size: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        values: sizes,
      }),
      a_size_max: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        values: sizeAnchors,
      }),
      a_symbol_modes: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: symbolModes,
      }),
      a_color: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        values: geometry.colors,
      }),
      a_halo_color: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        values: geometry.halos,
      }),
      a_opacity: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 1,
        values: geometry.opacities,
      }),
      a_dynamic: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: geometry.dynamics,
      }),
    },
    indices,
    // Point anchors become quads in the vertex shader. Cesium's physical
    // triangle date-line splitter would interpolate their coincident ECEF
    // vertices and collapse the distinct pixel corners.
    primitiveType: PrimitiveType.POINTS,
    boundingSphere: bounds.sphere,
  } as never);
  geometryBounds.set(result, bounds);
  return result;
}

/**
 * One drawable half of a symbol layer: baked geometry plus the shared
 * material sampling its atlas. Halves merge within a style layer at commit
 * (see mergeSymbolHalves), retaining a reorderable draw batch per layer.
 * Each layer part stays one Geometry; line glyphs move through a dynamic
 * vertex channel, so they do not create a Primitive per label.
 */
export interface SymbolHalf {
  layerId: string;
  part: 'text' | 'icon';
  sizeData: SizeData;
  translation: SymbolTranslation;
  translationOffset: Cartesian2;
  /** Fitted icons follow their generation's text paint, including its bound. */
  boundsTranslation?: Cartesian2;
  geometry: Geometry;
  material: Material;
  opacity?: {
    geometry: SymbolPrimitiveGeometry;
    /** Vertex offset after Cesium combines all halves sharing a material. */
    target?: { primitive: SymbolGpuResources; vertexStart: number };
  };
  dynamic?: {
    geometry: SymbolPrimitiveGeometry;
    dirty: boolean;
    target?: { primitive: SymbolGpuResources; vertexStart: number };
  };
  paint?: {
    geometry: SymbolPrimitiveGeometry;
    minfontscales: Float32Array;
    sizes: Float32Array;
    symbolModes: Float32Array;
    /** One exact binder factor per color, halo color, opacity, width and blur. */
    factors: Float32Array;
    /** Dirty stream mask: fill endpoints=1, halo endpoints=2, scalar endpoints=4. */
    dirty: number;
    revision?: number;
    target?: { primitive: SymbolGpuResources; vertexStart: number };
  };
}

/** One SymbolAppearance per shared material (stateless template, safe to share across primitives). */
const symbolAppearances = new WeakMap<Material, SymbolAppearance>();

function appearanceFor(material: Material): SymbolAppearance {
  let appearance = symbolAppearances.get(material);
  if (!appearance) {
    appearance = new SymbolAppearance({ translucent: true, material });
    symbolAppearances.set(material, appearance);
  }
  return appearance;
}

/**
 * Per-instance fade attribute name. Every merged instance carries it (Cesium
 * only wires attributes common to all instances of a Primitive), so the
 * vertex shader's `czm_batchTable_fade(batchId)` lookup always compiles and
 * the tile fade ticks through `Primitive.getGeometryInstanceAttributes`
 * without rebuilding geometry, cloning materials, or re-uploading atlases.
 */
export const SYMBOL_FADE_ATTRIBUTE = 'fade';

/** Merge result: the scene collection plus the fade-addressable primitives. */
export interface MergedSymbolCollections {
  collection: PrimitiveCollection;
  primitives: SymbolGpuResources[];
}

interface SymbolFrame {
  commandList: Array<{ owner?: object; primitiveType: number; uniformMap?: Record<string, () => unknown>; boundingVolume: BoundingSphere }>;
  camera: Pick<Camera, 'positionWC' | 'directionWC' | 'frustum'>;
  context: { drawingBufferWidth: number; drawingBufferHeight: number };
  pixelRatio: number;
  mode: SceneMode;
  mapProjection: MapProjection;
}

interface SymbolVertexBuffer {
  copyFromArrayView: (values: Float32Array, offsetInBytes: number) => void;
}

interface SymbolVertexArray {
  readonly numberOfAttributes: number;
  getAttribute: (index: number) => { index: number; vertexBuffer?: SymbolVertexBuffer };
}

// The physical resource owner is the only consumer of Native's symbol VAs.
declare class _NativeSymbolPrimitive extends Primitive {
  _va: SymbolVertexArray[];
  _attributeLocations: Record<string, number>;
  _batchTable?: { _batchValuesDirty: boolean };
  update(frameState?: SymbolFrame): void;
}
const RuntimePrimitive = Primitive as typeof _NativeSymbolPrimitive;

/**
 * Own one Native mesh, mutable collision/line streams and fade addresses.
 * Native owns VA allocation and destruction; this owner retains the live
 * half ranges until destruction and retries copies through Native's ready turn.
 */
export class SymbolGpuResources extends RuntimePrimitive {
  private readonly _halves: SymbolHalf[];

  private readonly _fadeInstanceIds: unknown[];

  private readonly _halfVisibility = new Map<SymbolHalf, boolean>();

  private _visibleHalves = 0;

  // Programs/materials are shared across tiles. Interpolation belongs to this
  // resource's binder interval, so decorate its Native map once per map build.
  private readonly _paintUniformMaps = new WeakMap<object, Record<string, () => unknown>>();

  private readonly _paintUniforms: Record<string, () => number | Cartesian2>;

  private readonly _sizeData: SizeData;

  private _sizeZoom?: number;

  private _evaluatedSize: EvaluatedZoomSize = { uSize: 0, uSizeT: 0 };

  private readonly _bounds: SymbolBounds[];

  private readonly _commandBounds = new WeakMap<BoundingSphere, BoundingSphere>();

  private readonly _pixelDimensions = new Cartesian2();

  constructor(instances: GeometryInstance[], halves: readonly { half: SymbolHalf; vertexStart: number }[], appearance: SymbolAppearance) {
    super({
      // Native adds batchId only when combining a list of instances.
      geometryInstances: instances,
      appearance,
      allowPicking: false,
      asynchronous: false,
      releaseGeometryInstances: true,
      // The generation's vertex ranges address non-interleaved float streams.
      interleave: false,
      vertexCacheOptimize: false,
    });
    this._halves = halves.map(({ half }) => half);
    this._sizeData = this._halves[0].sizeData;
    this._bounds = this._halves.map(half => geometryBounds.get(half.geometry)!);
    const factors = this._halves[0].paint?.factors;
    this._paintUniforms = {
      u_symbol_translation: () => this._halves[0].translationOffset,
      u_symbol_size: () => this._evaluatedSize.uSize,
      u_symbol_size_t: () => this._evaluatedSize.uSizeT,
      u_symbol_size_kind: () => this._sizeData.kind === 'constant' || this._sizeData.kind === 'camera' ? 0 : 1,
    };
    for (const [index, property] of ['color', 'halo_color', 'opacity', 'halo_width', 'halo_blur'].entries())
      this._paintUniforms[`u_symbol_${property}_t`] = () => factors?.[index] ?? 0;
    this._fadeInstanceIds = instances.map(instance => instance.id);
    for (const { half, vertexStart } of halves) {
      const target = { primitive: this, vertexStart };
      if (half.opacity)
        half.opacity.target = target;
      if (half.dynamic)
        half.dynamic.target = target;
      if (half.paint)
        half.paint.target = target;
      this._syncVisibility(half);
    }
  }

  /** VAs become writable before Native's afterRender marks the owner ready. */
  get canUpload(): boolean {
    return !this.isDestroyed() && this._va.length > 0;
  }

  /** Keep every owned half and its shared appearance on the replacement atlas. */
  replaceMaterials(replacements: ReadonlyMap<Material, Material>): void {
    const material = replacements.get(this.appearance.material)!;
    for (const half of this._halves)
      half.material = replacements.get(half.material)!;
    // Templates are shared by material; a generation never mutates another
    // generation's appearance while Native adopts the new shader/material.
    this.appearance = appearanceFor(material);
  }

  /** Collision opacity only changes draw visibility after its final GPU copy. */
  syncOpacity(half: SymbolHalf): void {
    const opacity = half.opacity;
    if (!opacity?.geometry.opacityDirty || opacity.target?.primitive !== this)
      return;
    const uploaded = this._upload('a_opacity', opacity.geometry.opacities, opacity.target.vertexStart, 1);
    if (uploaded)
      this._syncVisibility(half);
    opacity.geometry.opacityDirty = !uploaded;
  }

  /** Stream the generation's current camera-space glyph positions and angles. */
  syncDynamic(half: SymbolHalf): void {
    const dynamic = half.dynamic;
    if (dynamic?.dirty && dynamic.target?.primitive === this)
      dynamic.dirty = !this._upload('a_dynamic', dynamic.geometry.dynamics, dynamic.target.vertexStart, 3);
  }

  /** Upload changed worker paint endpoints; zoom only changes owner uniforms. */
  syncPaint(half: SymbolHalf): void {
    const paint = half.paint;
    if (!paint?.dirty || paint.target?.primitive !== this)
      return;
    const { vertexStart } = paint.target;
    if ((paint.dirty & 1) && this._upload('a_color', paint.geometry.colors, vertexStart, 4))
      paint.dirty &= ~1;
    if ((paint.dirty & 2) && this._upload('a_halo_color', paint.geometry.halos, vertexStart, 4))
      paint.dirty &= ~2;
    if (paint.dirty & 4) {
      const widthUploaded = this._upload('a_minfontscale', paint.minfontscales, vertexStart, 4);
      const opacityUploaded = this._upload('a_size', paint.sizes, vertexStart, 4);
      const blurUploaded = this._upload('a_symbol_modes', paint.symbolModes, vertexStart, 2);
      if (widthUploaded && opacityUploaded && blurUploaded)
        paint.dirty &= ~4;
    }
  }

  /** An unrendered owner has no live batch table and cannot participate in fade. */
  fadeTargets(): Array<{ set: (value: number) => void }> | undefined {
    if (this.isDestroyed() || !this.ready)
      return undefined;
    const targets: Array<{ set: (value: number) => void }> = [];
    for (const id of this._fadeInstanceIds) {
      const attributes = this.getGeometryInstanceAttributes(id) as Record<string, unknown> | undefined;
      if (!attributes)
        return undefined;
      targets.push({ set: (value) => {
        if (!this.isDestroyed())
          attributes[SYMBOL_FADE_ATTRIBUTE] = [value];
      } });
    }
    return targets;
  }

  private _syncVisibility(half: SymbolHalf): void {
    const visible = !half.opacity || half.opacity.geometry.opacities.some(opacity => opacity > 0);
    const previous = this._halfVisibility.get(half) ?? false;
    if (visible !== previous)
      this._visibleHalves += visible ? 1 : -1;
    this._halfVisibility.set(half, visible);
  }

  private _upload(name: 'a_opacity' | 'a_dynamic' | 'a_color' | 'a_halo_color' | 'a_minfontscale' | 'a_size' | 'a_symbol_modes', values: Float32Array, vertexStart: number, components: number): boolean {
    if (!this.canUpload)
      return false;
    if (this._va.length !== 1)
      throw new Error(`Cesium symbol ${name} buffer has an unsupported vertex layout`);
    const vertexArray = this._va[0];
    const location = this._attributeLocations[name];
    let buffer: SymbolVertexBuffer | undefined;
    for (let index = 0; index < vertexArray.numberOfAttributes; index++) {
      const attribute = vertexArray.getAttribute(index);
      if (attribute.index === location) {
        buffer = attribute.vertexBuffer;
        break;
      }
    }
    if (!buffer)
      throw new Error(`Cesium symbol ${name} buffer has an unsupported vertex layout`);
    buffer.copyFromArrayView(values, vertexStart * components * Float32Array.BYTES_PER_ELEMENT);
    // Native can refill/recreate a pre-ready VA. Repeat the latest CPU state
    // after ready instead of acknowledging a copy that Native can overwrite.
    return this.ready;
  }

  update(frameState?: SymbolFrame): void {
    if (!frameState)
      throw new TypeError('Symbol GPU update requires a Native frame state');
    // Invisible owners must finish their first upload and afterRender ready.
    if (this.ready && this._visibleHalves === 0 && !this._batchTable?._batchValuesDirty
      && !this._halves.some(half => half.opacity?.geometry.opacityDirty || half.dynamic?.dirty || half.paint?.dirty)) {
      return;
    }
    const zoom = this.appearance.material.uniforms.u_camera_zoom as number;
    if (this._sizeZoom !== zoom) {
      this._evaluatedSize = evaluateSizeForZoom(this._sizeData, zoom);
      this._sizeZoom = zoom;
    }
    const first = frameState.commandList.length;
    super.update(frameState);
    for (let index = first; index < frameState.commandList.length; index++) {
      const command = frameState.commandList[index];
      if (command.owner === this) {
        command.primitiveType = PrimitiveType.TRIANGLES;
        const base = command.boundingVolume;
        let padded = this._commandBounds.get(base);
        if (!padded) {
          padded = new BoundingSphere();
          this._commandBounds.set(base, padded);
        }
        // Native reassigns the unexpanded anchor/path sphere each update.
        // Keep it intact: commands in another pass can share this same sphere.
        BoundingSphere.clone(base, padded);
        const translate = this._halves[0].translationOffset;
        let translationPadding = translate.x || translate.y
          ? mercatorTranslationPadding(translate, frameState.mapProjection.ellipsoid, frameState.mode)
          : 0;
        for (const half of this._halves) {
          const follower = half.boundsTranslation;
          if (follower && (follower.x || follower.y))
            translationPadding = Math.max(translationPadding, mercatorTranslationPadding(follower, frameState.mapProjection.ellipsoid, frameState.mode));
        }
        const camera = frameState.camera;
        const distance = Math.max(camera.frustum.near, (base.center.x - camera.positionWC.x) * camera.directionWC.x
          + (base.center.y - camera.positionWC.y) * camera.directionWC.y
          + (base.center.z - camera.positionWC.z) * camera.directionWC.z + base.radius + translationPadding);
        camera.frustum.getPixelDimensions(frameState.context.drawingBufferWidth, frameState.context.drawingBufferHeight, distance, frameState.pixelRatio, this._pixelDimensions);
        const pixelSize = Math.max(this._pixelDimensions.x, this._pixelDimensions.y);
        const material = this.appearance.material.uniforms;
        const orthographic = material.u_symbol_orthographic === 1;
        const centerDistance = material.u_symbol_camera_distance as number;
        const viewportRatio = orthographic ? 1 : 0.5 + 0.5 * centerDistance / distance;
        const mapRatio = orthographic ? 1 : Math.min(4, 0.5 + 0.5 * distance / centerDistance);
        let padding = 0;
        const uniformSize = this._sizeData.kind === 'constant' || this._sizeData.kind === 'camera';
        for (const bounds of this._bounds) {
          const sizeOffset = uniformSize ? bounds.offset * this._evaluatedSize.uSize / (bounds.text ? 24 : 1) : bounds.sourceOffset;
          const lineOffset = uniformSize ? bounds.lineOffset * this._evaluatedSize.uSize : bounds.sourceLineOffset;
          const ratio = bounds.sizePerspective ? bounds.mapPitch ? mapRatio : bounds.viewportPerspective ? Math.min(4, viewportRatio) : 1 : 1;
          const reach = sizeOffset * ratio + bounds.minimum + bounds.pixels;
          const variable = bounds.variable;
          const variableOffset = variable
            ? variable.sizeData.kind === 'constant' || variable.sizeData.kind === 'camera'
              ? variable.offset * evaluateSizeForZoom(variable.sizeData, zoom).uSize / 24
              : variable.sourceOffset
            : 0;
          // Variable-anchor displacement uses the uncapped original-anchor
          // ratio. For ground labels the nearest anchor bounds the ratio;
          // viewport pixels use the far distance above, whose pixel size
          // cancels the denominator and grows the physical reach.
          const variableDistance = bounds.mapPitch
            ? Math.max(camera.frustum.near, distance - 2 * (base.radius + translationPadding))
            : distance;
          const variableRatio = orthographic ? 1 : 0.5 + 0.5 * centerDistance / variableDistance;
          const variableReach = variableOffset * variableRatio;
          const metres = bounds.mapPitch
            // Independently normalized inverse label axes can add, rather
            // than preserve Euclidean length, at steep viewport rotations.
            ? ((reach + variableReach) * (bounds.viewportGroundAxes ? Math.SQRT2 : 1) + lineOffset * 2) * symbolMetersPerPixel(zoom)
            : (reach + variableReach + lineOffset * (bounds.viewportPerspective ? viewportRatio : 1)) * pixelSize;
          padding = Math.max(padding, metres);
        }
        padded.radius += padding + translationPadding;
        command.boundingVolume = padded;
        const original = command.uniformMap!;
        let uniforms = this._paintUniformMaps.get(original);
        if (!uniforms) {
          uniforms = { ...original, ...this._paintUniforms };
          this._paintUniformMaps.set(original, uniforms);
          this._paintUniformMaps.set(uniforms, uniforms);
        }
        command.uniformMap = uniforms;
      }
    }
  }

  destroy(): void {
    for (const half of this._halves) {
      if (half.opacity?.target?.primitive === this) {
        half.opacity.target = undefined;
        half.opacity.geometry.opacityDirty = false;
      }
      if (half.dynamic?.target?.primitive === this) {
        half.dynamic.target = undefined;
        half.dynamic.dirty = false;
      }
      if (half.paint?.target?.primitive === this) {
        half.paint.target = undefined;
        half.paint.dirty = 0;
      }
    }
    this._halfVisibility.clear();
    this._halves.length = 0;
    this._fadeInstanceIds.length = 0;
    super.destroy();
  }
}

/**
 * Merge halves by style layer, material, size semantics and composite paint interval. Material/appearance and atlas
 * textures are still shared, while every Primitive remains a reorderable
 * unit in painter order. Each instance keeps its per-layer pick identity.
 */
export function mergeSymbolHalves(tileId: string, halves: readonly SymbolHalf[]): MergedSymbolCollections | undefined {
  interface Group {
    instances: GeometryInstance[];
    halves: Array<{ half: SymbolHalf; vertexStart: number }>;
    vertexCount: number;
    paintConfig?: ProgramConfiguration;
    sizeData: SizeData;
    translation: SymbolTranslation;
  }
  const byLayer = new Map<string, Map<Material, Group[]>>();
  for (const half of halves) {
    if (half.material.isDestroyed()) {
      continue;
    }
    let byMaterial = byLayer.get(half.layerId);
    if (!byMaterial) {
      byMaterial = new Map();
      byLayer.set(half.layerId, byMaterial);
    }
    let groups = byMaterial.get(half.material);
    if (!groups) {
      groups = [];
      byMaterial.set(half.material, groups);
    }
    const config = half.paint?.geometry.paint?.config;
    const paintConfig = config?.hasCompositeProperties() ? config : undefined;
    const sizeData = half.sizeData;
    let group = groups.find(candidate => candidate.paintConfig === paintConfig && candidate.sizeData === sizeData
      && candidate.translation.anchor === half.translation.anchor
      && Cartesian2.equals(candidate.translation.pixels, half.translation.pixels));
    if (!group) {
      group = { instances: [], halves: [], vertexCount: 0, paintConfig, sizeData, translation: half.translation };
      groups.push(group);
    }
    const instance = new GeometryInstance({
      geometry: half.geometry,
      id: { type: 'symbol', tileId, layerId: half.layerId, part: half.part },
      attributes: {
        [SYMBOL_FADE_ATTRIBUTE]: new GeometryInstanceAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 1,
          value: [1],
        }),
      },
    });
    group.instances.push(instance);
    group.halves.push({ half, vertexStart: group.vertexCount });
    group.vertexCount += Geometry.computeNumberOfVertices(half.geometry);
  }
  if (byLayer.size === 0) {
    return undefined;
  }
  const collection = new PrimitiveCollection();
  const primitives: SymbolGpuResources[] = [];
  for (const [layerId, byMaterial] of byLayer) {
    for (const [material, groups] of byMaterial) {
      for (const group of groups) {
        const primitive = new SymbolGpuResources(group.instances, group.halves, appearanceFor(material));
        registerDrawBatch(primitive, { layerId, tileId, kind: 'symbol' });
        collection.add(primitive);
        primitives.push(primitive);
      }
    }
  }
  return { collection, primitives };
}
