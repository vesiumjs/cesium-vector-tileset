import type { ImageAtlas, ImagePosition } from '../../assets/image-atlas';
import type { StyleImages } from '../../assets/style-images';
import type { CollisionBoxArray } from '../../data/array-types.g';
import type { Bucket } from '../../data/bucket';
import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { Budget } from '../scene/frame-budget';
import type { MemoryBudgetVisitor } from '../scene/gpu-memory-budget';
import type { SymbolPrimitiveGeometry, SymbolTileGeometry } from './symbol-geometry';
import type { PlacementView, SymbolTileSelection } from './symbol-placement';
import type { SymbolPlacementBatch, SymbolPlacementGeneration, SymbolPlacementPass } from './symbol-placement-pass';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian4,
  Color,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  GeometryInstanceAttribute,
  Material,
  MaterialAppearance,
  PixelFormat,
  Primitive,
  PrimitiveCollection,
  PrimitiveType,
} from 'cesium';
import {
  atlasLayoutHash,
  SharedAtlasTextures,
} from '../../assets/shared-atlas-textures';
import { SymbolBucket } from '../../data/bucket-runtime';
import { geometryBytes } from '../geometry/geometry-bytes';
import { registerDrawBatch } from '../scene/draw-batch';
import { RetiredPool } from '../scene/retired-pool';
import { MinimumProgressBudget } from '../scene/scene-frame-budget';
import { constantValue, straightAlphaColor } from '../vector/feature-attributes';
import { symbolBucketGeometry } from './symbol-geometry';
import { symbolMercatorDelta, symbolMercatorPosition } from './symbol-perspective';
import { INVALID_LINE_ANGLE, SymbolCollisionIndex, SymbolProjectionContext, updateLineSymbolGeometry } from './symbol-placement';
import { copyPlacementView, samePlacementView, SymbolPlacementScope } from './symbol-placement-pass';

type TileID = CanonicalTileID | OverscaledTileID;

/** Run deferred collision work after the renderer's mandatory camera and Native work. */
export type SymbolPlacementWork = (operation: (budget: Budget) => void) => void;

/** The evaluated value of a constant symbol paint colour. */
function symbolColor(layer: SymbolStyleLayer, property: string): Color {
  const value = constantValue(layer as unknown as { paint: { get: (property: string) => unknown } }, property) as { r: number; g: number; b: number; a: number } | undefined;
  if (!value) {
    return Color.WHITE.clone();
  }
  return straightAlphaColor(value.r, value.g, value.b, value.a);
}

/**
 * The evaluated text halo paint of a layer. MapLibre draws the halo as an
 * annulus behind the glyph fill; a zero or absent width disables it.
 */
function symbolHalo(layer: SymbolStyleLayer, part: 'text' | 'icon' = 'text'): TextHalo | undefined {
  const prefix = part === 'text' ? 'text-halo' : 'icon-halo';
  const widthValue = constantValue(layer as unknown as { paint: { get: (property: string) => unknown } }, `${prefix}-width`);
  const width = typeof widthValue === 'number' && Number.isFinite(widthValue) ? widthValue : 0;
  if (width <= 0) {
    return undefined;
  }
  const blurValue = constantValue(layer as unknown as { paint: { get: (property: string) => unknown } }, `${prefix}-blur`);
  const blur = typeof blurValue === 'number' && Number.isFinite(blurValue) ? blurValue : 0;
  return {
    color: symbolColor(layer, `${prefix}-color`),
    width,
    blur,
  };
}

/** Project symbol corners in their actual viewport or Mercator label plane. */
export const SYMBOL_VERTEX_SHADER = `
uniform float u_camera_zoom;
uniform float u_symbol_camera_distance;
uniform float u_symbol_orthographic;
uniform float u_symbol_mercator_projection;
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 a_offset;
in vec2 a_pxoffset;
in vec2 a_minfontscale;
in vec2 a_tex;
in float a_size;
in vec4 a_size_max;
in vec3 a_size_zoom;
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
// Cesium's MaterialAppearance fragment shader reads these; the symbol shader
// colours from v_tex, so only the names have to line up.
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;

// Exact WGS84 displacement of a ground point by east/south Mercator metres.
// Difference formulas retain small corner offsets beside a 6-million-metre
// ECEF anchor, and work with scene3DOnly without projected attributes.
vec3 symbolGroundDeltaEC(vec2 metres)
{
    vec3 world = position3DHigh + position3DLow;
    vec3 normal = czm_geodeticSurfaceNormal(world, vec3(0.0),
        vec3(2.458172257647332e-14, 2.458172257647332e-14, 2.4747391015697002e-14));
    float cosine = length(normal.xy);
    vec3 radial = vec3(normal.xy / max(cosine, 1.0e-12), 0.0);
    vec3 east = vec3(-radial.y, radial.x, 0.0);
    float t = tanh(-metres.y / 6378137.0);
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
    float halfSin = sin(longitudeDelta * 0.5);
    vec3 delta = radial * (deltaRadius - radius * 2.0 * halfSin * halfSin)
        + east * radius * sin(longitudeDelta)
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
    // Batch bounds can span both sides of the horizon. Test each ECEF anchor
    // against the ellipsoid even when depth testing is disabled for symbols.
    // Use the live camera so an older collision generation cannot show a
    // far-side symbol while the next placement is still being computed.
    if (czm_sceneMode == czm_sceneMode3D)
    {
        vec3 camera = czm_viewerPositionWC * czm_ellipsoidInverseRadii;
        vec3 anchor = (position3DHigh + position3DLow) * czm_ellipsoidInverseRadii;
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
    vec4 clip = czm_projection * positionEC;

    // a_size packs (size * 128) << 2 | isSdf << 1 | isText. MapLibre's
    // symbol_icon.vertex scales text offsets by size / 24 (they are expressed
    // in the 24px glyph em) and icon offsets by size directly (they are
    // already in sprite pixels); dividing icons by 24 rendered every icon at
    // 1/24th of its size. The kind flag rides in the vertex because Cesium's
    // material uniform map only reaches the fragment stage.
    float packed = a_size;
    float sizeMin = floor(packed / 4.0);
    float rest = packed - 4.0 * sizeMin;
    float isSdf = rest >= 2.0 ? 1.0 : 0.0;
    float isText = rest - 2.0 * isSdf;
    // A composite size packs both zoom stops (a_data.z/a_data.w) and this
    // tile's stop range; interpolate to the live camera zoom instead of
    // freezing at the stop the tile was baked at. Every other size kind
    // stores one value twice, so the mix leaves it untouched.
    float zoomT = a_size_zoom.y > a_size_zoom.x
        ? clamp((u_camera_zoom - a_size_zoom.x) / (a_size_zoom.y - a_size_zoom.x), 0.0, 1.0)
        : 0.0;
    float size = mix(sizeMin, max(a_size_max.x, sizeMin), zoomT) / 128.0;
    bool mapPitch = a_size_zoom.z == 2.0 || a_size_zoom.z == 4.0;
    vec4 workerClip = clip;
    if (any(notEqual(a_size_max.yz, vec2(0.0)))) {
        workerClip += czm_projection * vec4(symbolGroundDeltaEC(a_size_max.yz), 0.0);
    }
    if (a_size_zoom.z > 0.5 && a_size_zoom.z < 2.5 && u_symbol_orthographic < 0.5) {
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
    float effectiveOpacity = a_opacity * czm_batchTable_fade(batchId);
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
    vec2 effectiveScale = max(a_minfontscale, vec2(fontScale));
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
            vec3 eastEC = symbolGroundDeltaEC(vec2(1.0, 0.0));
            vec3 southEC = symbolGroundDeltaEC(vec2(0.0, 1.0));
            vec2 east = vec2(-southEC.y, eastEC.y);
            vec2 south = vec2(-southEC.x, eastEC.x);
            float eastLength = length(east);
            float southLength = length(south);
            east = eastLength < 1.0e-9 ? vec2(0.0) : east / eastLength;
            south = southLength < 1.0e-9 ? vec2(0.0) : south / southLength;
            metres = east * metres.x + south * metres.y;
        }
        gl_Position += czm_projection * vec4(symbolGroundDeltaEC(metres), 0.0);
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
    v_color = a_color;
    v_halo_color = a_halo_color;
    v_positionEC = positionEC.xyz;
    v_normalEC = vec3(0.0, 0.0, 1.0);
    v_st = vec2(0.0);
}
`;

/**
 * The symbol fragment shader as a Cesium material: it samples the glyph/icon
 * atlas and turns the signed distance field into coverage the same way
 * MapLibre's symbol_sdf fragment shader does. Text halos are a second draw
 * pass upstream; they are not wired yet.
 */
export const SYMBOL_MATERIAL_SOURCE = `
in vec2 v_tex;
in vec3 v_data;
in float v_is_sdf;
in vec4 v_color;
in vec4 v_halo_color;

uniform sampler2D u_texture;
uniform sampler2D u_texture_icon;
uniform vec2 u_texsize;
uniform vec2 u_texsize_icon;
uniform float u_device_pixel_ratio;
uniform bool u_is_text;
uniform vec4 u_color;
uniform vec4 u_halo_color;
uniform float u_halo_width;
uniform float u_halo_blur;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);

    float gammaScale = v_data.x;
    float size = v_data.y;
    float opacity = v_data.z;
    // Cesium uploads canvas uniforms with flipY, so the top-down atlas rows
    // land upside down on the GPU: mirror the row back on sample. The SDF
    // channel depends on the batch (u_is_text): glyph quads sample the glyph
    // atlas, uploaded as single-channel R8 (the canvas fallback replicates
    // the byte into R too); SDF icon quads sample the RGBA sprite atlas and
    // need .a.
    vec2 tex = vec2(v_tex.x, u_texsize.y - v_tex.y) / u_texsize;

    // Per-vertex paint: white for constant colors, the feature's value for
    // data-driven ones (MapLibre's a_fill_color / a_halo_color). Multiplying
    // keeps one fragment path for both kinds.
    vec4 fillColor = u_color * v_color;
    vec4 haloColor = u_halo_color * v_halo_color;

    vec4 sdfTexel = texture(u_texture, tex);
    float sampled = u_is_text ? sdfTexel.r : sdfTexel.a;
    float alpha;
    if (v_is_sdf > 0.5)
    {
        float EDGE_GAMMA = 0.105 / u_device_pixel_ratio;
        float fontScale = u_is_text ? size / 24.0 : size;
        float gamma = EDGE_GAMMA / fontScale;
        float innerEdge = (256.0 - 64.0) / 256.0;
        float gammaScaled = gamma * gammaScale;
        alpha = gammaScale < 0.0 ? 0.5 : smoothstep(innerEdge - gammaScaled, innerEdge + gammaScaled, sampled);

        // MapLibre's symbol_sdf halo: an annulus reaching halo_width pixels
        // beyond the glyph edge, composited under the fill in one pass
        // (text + (1 - text.a) * halo).
        if (u_halo_width > 0.0)
        {
            float SDF_PX = 8.0;
            float gammaHalo = (u_halo_blur * 1.19 / SDF_PX + EDGE_GAMMA) / fontScale;
            float innerEdgeHalo = innerEdge + gammaHalo * gammaScale;
            float gammaScaledHalo = gammaHalo * gammaScale;
            float alphaHalo = smoothstep(innerEdgeHalo - gammaScaledHalo, innerEdgeHalo + gammaScaledHalo, sampled);
            float haloEdge = (6.0 - u_halo_width / fontScale) / SDF_PX;
            alphaHalo = gammaScale < 0.0 ? 0.5 : min(smoothstep(haloEdge - gammaScaledHalo, haloEdge + gammaScaledHalo, sampled), 1.0 - alphaHalo);

            vec3 fillRgb = fillColor.rgb * (alpha * opacity * fillColor.a);
            float fillA = alpha * opacity * fillColor.a;
            vec3 haloRgb = haloColor.rgb * (alphaHalo * opacity * haloColor.a);
            float haloA = alphaHalo * opacity * haloColor.a;
            vec3 rgb = fillRgb + (1.0 - fillA) * haloRgb;
            float outA = fillA + (1.0 - fillA) * haloA;
            material.diffuse = rgb / max(outA, 0.001);
            material.alpha = outA;
            return material;
        }
    }
    else
    {
        // Non-SDF quads are sprite images. Icon batches sample their own
        // atlas; text batches with icons-in-text sample the sprite atlas
        // (glyph quads are always SDF, image quads never are, so v_is_sdf
        // routes without extra per-vertex state; SDF sprite images inside
        // text remain a known limitation and sample the glyph atlas).
        vec2 texIcon = v_tex;
        vec4 icon;
        if (u_is_text)
        {
            texIcon = vec2(v_tex.x, u_texsize_icon.y - v_tex.y) / u_texsize_icon;
            icon = texture(u_texture_icon, texIcon);
        }
        else
        {
            icon = texture(u_texture, tex);
        }
        // Atlas filtering operates on premultiplied pixels, as in MapLibre.
        // Native material blending expects straight RGB and applies alpha.
        material.diffuse = icon.a > 0.0 ? icon.rgb / icon.a : vec3(0.0);
        material.alpha = icon.a * opacity * fillColor.a;
        return material;
    }

    material.diffuse = fillColor.rgb;
    material.alpha = alpha * opacity * fillColor.a;
    return material;
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

interface AtlasSource {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /**
   * Content key in the renderer's SharedAtlasTextures. Icon atlases share
   * the key across tiles with byte-identical sprite sets (one GPU texture);
   * glyph atlases are per-tile by nature and keyed by payload identity.
   */
  shareKey: string;
}

// Atlas canvases are expensive (a full putImageData of a 1024x1024 atlas) and
// their pixel data is immutable once a tile's worker result has arrived, so
// tiles whose atlas payload object is reused — republished tiles and tiles
// sharing one style-level atlas — reuse the same canvas.
const glyphAtlasCache = new WeakMap<Uint8Array | Uint8ClampedArray, AtlasSource>();
const iconAtlasCache = new WeakMap<Uint8Array | Uint8ClampedArray, AtlasSource>();

/**
 * Upload a single-channel SDF atlas (the glyph atlas) into a canvas. The
 * shader samples .a, so every channel receives the same byte.
 */
export function glyphAtlasSource(data: Uint8Array | Uint8ClampedArray, width: number, height: number, shareKey: string): AtlasSource {
  const cached = glyphAtlasCache.get(data);
  // Same payload object always resolves to the same key (callers derive it
  // from object identity), so a mismatch means aliasing: build fresh rather
  // than retargeting the shared canvas.
  if (cached && cached.shareKey === shareKey) {
    return cached;
  }
  const source = writeAtlasCanvas(data, width, height, true, shareKey);
  glyphAtlasCache.set(data, source);
  return source;
}

/** Upload an RGBA sprite atlas into a canvas. */
export function iconAtlasSource(data: Uint8Array | Uint8ClampedArray, width: number, height: number, shareKey: string): AtlasSource {
  const cached = iconAtlasCache.get(data);
  if (cached && cached.shareKey === shareKey) {
    return cached;
  }
  const source = writeAtlasCanvas(data, width, height, false, shareKey);
  iconAtlasCache.set(data, source);
  return source;
}

/**
 * Share icons with the same packed layout and sprite revisions. Vertices use
 * pixel coordinates, so canvas padding outside those icon rectangles does
 * not affect sampling. Image updates must advance the sprite revision.
 */
export function iconAtlasShareKey(positions: Record<string, ImagePosition>): string {
  return `icon/${atlasLayoutHash(positions)}`;
}

function writeAtlasCanvas(data: Uint8Array | Uint8ClampedArray, width: number, height: number, gray: boolean, shareKey: string): AtlasSource {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('A 2D canvas context is required to upload the glyph atlas');
  }
  const rgba = gray
    ? expandGrayToRgba(data, width, height)
    : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  context.putImageData(new ImageData(rgba as unknown as ImageDataArray, width, height), 0, 0);
  // Debug tag for e2e probes (kind + dims stay readable after sharing; the
  // GPU texture adopted later carries width/height instead).
  (canvas as unknown as { __dbgTag?: string }).__dbgTag = `${shareKey.split('/')[0]}:${width}x${height}`;
  return { canvas, width, height, shareKey };
}

function expandGrayToRgba(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = data[i];
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = value;
  }
  return rgba;
}

interface TextHalo {
  color: Color;
  width: number;
  blur: number;
}

function symbolMaterial(
  atlas: AtlasSource,
  color: Color,
  isText: boolean,
  pixelRatio: number,
  halo?: TextHalo,
  iconAtlas?: AtlasSource,
): Material {
  const material = new Material({
    translucent: true,
    fabric: {
      uniforms: {
        u_texture: atlas.canvas,
        // Text batches may carry sprite-image quads (icons-in-text); they
        // sample the sprite atlas selected by v_is_sdf. Icon batches reuse
        // their own atlas for both samplers.
        u_texture_icon: iconAtlas?.canvas ?? atlas.canvas,
        u_texsize: new Cartesian2(atlas.width, atlas.height),
        u_texsize_icon: new Cartesian2(iconAtlas?.width ?? atlas.width, iconAtlas?.height ?? atlas.height),
        u_device_pixel_ratio: pixelRatio,
        u_is_text: isText,
        // Size rides the vertex (constant/zoom stops packed per part), so the
        // material needs no size uniform and never churns on a zoom change.
        u_halo_color: new Cartesian4(
          halo?.color.red ?? 0,
          halo?.color.green ?? 0,
          halo?.color.blue ?? 0,
          halo?.color.alpha ?? 0,
        ),
        u_halo_width: halo && halo.width > 0 ? halo.width : 0,
        u_halo_blur: halo?.blur ?? 0,
        // A Cartesian4, not a Color: Cesium only binds .red/.green/.blue for a
        // vec4 uniform when the value is a Color-compatible vec4, and a plain
        // Color leaves the uniform undefined.
        u_color: new Cartesian4(color.red, color.green, color.blue, color.alpha),
      },
      source: SYMBOL_MATERIAL_SOURCE,
    },
  });
  // Cesium's fabric uniforms are renamed for its fragment material source.
  // The camera zoom is used only by our vertex shader, so give Primitive's
  // command uniform map the exact vertex uniform name instead.
  material.uniforms.u_camera_zoom = 0;
  material.uniforms.u_symbol_camera_distance = 0;
  material.uniforms.u_symbol_orthographic = 0;
  material.uniforms.u_symbol_mercator_projection = 0;
  const liveUniforms = (material as Material & { _uniforms: Record<string, () => unknown> })._uniforms;
  liveUniforms.u_symbol_camera_distance = () => material.uniforms.u_symbol_camera_distance;
  liveUniforms.u_symbol_orthographic = () => material.uniforms.u_symbol_orthographic;
  liveUniforms.u_symbol_mercator_projection = () => material.uniforms.u_symbol_mercator_projection;
  (material as Material & { _uniforms: Record<string, () => unknown> })._uniforms.u_camera_zoom
    = () => material.uniforms.u_camera_zoom;
  return material;
}

/** Worst-case metres a screen-space label quad can reach per pixel of offset. */
const SYMBOL_BOUNDS_PADDING_M_PER_PX = 40;

/**
 * Label quads are expanded in window space, so their world-space bounds are
 * just the anchors - but a label is still drawn while its anchor is off screen
 * by up to the quad's on-screen reach. Pad the sphere by the largest quad so
 * tiles near the viewport edge are not culled while their labels are visible.
 */
function paddedBounds(geometry: SymbolPrimitiveGeometry): BoundingSphere | undefined {
  const sphere = BoundingSphere.fromVertices(geometry.positions);
  if (!sphere) {
    return undefined;
  }
  // Dynamic line glyphs can move to another segment of the worker path as
  // zoom and pitch change; the baked glyph anchors alone are not their bounds.
  for (const instance of geometry.instances) {
    if (instance.line) {
      BoundingSphere.union(sphere, BoundingSphere.fromVertices(instance.line.pathECEF), sphere);
    }
  }
  let reach = 0;
  for (let i = 0; i < geometry.offsets.length; i += 2) {
    // Stretchable icons shift quads by a_pxoffset; include it so edge tiles
    // are not culled while their shifted labels are still visible.
    const px = geometry.pxoffsets ? Math.abs(geometry.pxoffsets[i]) + Math.abs(geometry.pxoffsets[i + 1]) : 0;
    reach = Math.max(reach, Math.abs(geometry.offsets[i]), Math.abs(geometry.offsets[i + 1]), px);
  }
  sphere.radius += reach * SYMBOL_BOUNDS_PADDING_M_PER_PX;
  return sphere;
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

function symbolGeometry(geometry: SymbolPrimitiveGeometry, indices: Uint32Array): Geometry | undefined {
  if (!batchIsValid(geometry)) {
    return undefined;
  }
  const sphere = paddedBounds(geometry);
  // Native adds four position attributes and batchId. Keep the complete
  // shader within WebGL's 16 slots by sharing the zoom attribute's free lane.
  const sizeZooms = new Float32Array(geometry.positions.length);
  for (let index = 0; index < geometry.positions.length / 3; index++) {
    sizeZooms[index * 3] = geometry.sizeZooms[index * 2];
    sizeZooms[index * 3 + 1] = geometry.sizeZooms[index * 2 + 1];
    sizeZooms[index * 3 + 2] = geometry.mapPitch ? (geometry.sizePerspective ? 2 : 4) : geometry.viewportPerspective ? (geometry.sizePerspective ? 1 : 3) : 0;
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
  return new Geometry({
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
        componentsPerAttribute: 2,
        values: geometry.minfontscales,
      }),
      a_tex: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: geometry.tex,
      }),
      a_size: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 1,
        values: geometry.sizes,
      }),
      a_size_max: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        values: sizeAnchors,
      }),
      a_size_zoom: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: sizeZooms,
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
    boundingSphere: sphere,
  } as never);
}

export interface SymbolCollectionOptions {
  tileId: string;
  layerId: string;
  geometry: SymbolTileGeometry;
  textAtlas?: AtlasSource;
  iconAtlas?: AtlasSource;
  textColor: Color;
  iconColor: Color;
  pixelRatio: number;
  textHalo?: TextHalo;
  /**
   * Prebuilt materials (e.g. reused across collision flips). Visibility lives
   * in the per-vertex a_opacity channel, so a flip never needs a new
   * material: reusing avoids re-uploading the whole atlas texture and stops
   * the replaced Material (whose GPU texture Primitive.destroy never frees)
   * from leaking.
   */
  textMaterial?: Material;
  iconMaterial?: Material;
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
  geometry: Geometry;
  material: Material;
  opacity?: {
    geometry: SymbolPrimitiveGeometry;
    /** Vertex offset after Cesium combines all halves sharing a material. */
    target?: { primitive: Primitive; vertexStart: number };
  };
  dynamic?: {
    geometry: SymbolPrimitiveGeometry;
    dirty: boolean;
    target?: { primitive: Primitive; vertexStart: number };
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

/** One merged Primitive plus the instance ids its fade ticks address. */
export interface MergedSymbolPrimitive {
  primitive: Primitive;
  /** The exact id objects handed to Cesium (looked up by identity). */
  instanceIds: unknown[];
}

/** Merge result: the scene collection plus the fade-addressable primitives. */
export interface MergedSymbolCollections {
  collection: PrimitiveCollection;
  primitives: MergedSymbolPrimitive[];
}

/** Keep Cesium's point-anchor pipeline and draw the shader-expanded quads. */
class SymbolPrimitive extends Primitive {
  private readonly _halves: SymbolHalf[] = [];

  private readonly _halfVisibility = new Map<SymbolHalf, boolean>();

  private _visibleHalves = 0;

  addHalf(half: SymbolHalf): void {
    this._halves.push(half);
    this.syncHalfVisibility(half);
  }

  /** Only dirty opacity synchronization observes instance-sized CPU arrays. */
  syncHalfVisibility(half: SymbolHalf): void {
    const visible = !half.opacity || half.opacity.geometry.opacities.some(opacity => opacity > 0);
    const previous = this._halfVisibility.get(half) ?? false;
    if (visible !== previous) {
      this._visibleHalves += visible ? 1 : -1;
    }
    this._halfVisibility.set(half, visible);
  }

  update(frameState?: { commandList: Array<{ owner?: object; primitiveType: number }> }): void {
    // Empty owners still prepare their VA and settle Native ready/afterRender.
    // Dirty streams and fade setters retain the ordinary Native update path.
    const batchTable = (this as Primitive & { _batchTable?: { _batchValuesDirty: boolean } })._batchTable;
    if (this.ready && this._visibleHalves === 0 && !batchTable?._batchValuesDirty
      && !this._halves.some(half => half.opacity?.geometry.opacityDirty || half.dynamic?.dirty)) {
      return;
    }
    const first = frameState.commandList.length;
    Reflect.apply(Primitive.prototype.update, this, [frameState]);
    for (let i = first; i < frameState.commandList.length; i++) {
      const command = frameState.commandList[i];
      if (command.owner === this) {
        command.primitiveType = PrimitiveType.TRIANGLES;
      }
    }
  }
}

/**
 * Merge halves by style layer and material. Material/appearance and atlas
 * textures are still shared, while every Primitive remains a reorderable
 * unit in painter order. Each instance keeps its per-layer pick identity.
 */
export function mergeSymbolHalves(tileId: string, halves: readonly SymbolHalf[]): MergedSymbolCollections | undefined {
  interface Group {
    instances: GeometryInstance[];
    halves: Array<{ half: SymbolHalf; vertexStart: number }>;
    vertexCount: number;
  }
  const byLayer = new Map<string, Map<Material, Group>>();
  for (const half of halves) {
    if (half.material.isDestroyed()) {
      continue;
    }
    let byMaterial = byLayer.get(half.layerId);
    if (!byMaterial) {
      byMaterial = new Map();
      byLayer.set(half.layerId, byMaterial);
    }
    let group = byMaterial.get(half.material);
    if (!group) {
      group = { instances: [], halves: [], vertexCount: 0 };
      byMaterial.set(half.material, group);
    }
    const instanceAttribute = (value: number | number[], components: number): GeometryInstanceAttribute => new GeometryInstanceAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: components,
      value: Array.isArray(value) ? value : [value],
    });
    const instance = new GeometryInstance({
      geometry: half.geometry,
      id: { type: 'symbol', tileId, layerId: half.layerId, part: half.part },
      attributes: {
        [SYMBOL_FADE_ATTRIBUTE]: instanceAttribute(1, 1),
      },
    });
    group.instances.push(instance);
    group.halves.push({ half, vertexStart: group.vertexCount });
    group.vertexCount += half.opacity?.geometry.opacities.length ?? 0;
  }
  if (byLayer.size === 0) {
    return undefined;
  }
  const collection = new PrimitiveCollection();
  const primitives: MergedSymbolPrimitive[] = [];
  for (const [layerId, byMaterial] of byLayer) {
    for (const [material, group] of byMaterial) {
      const primitive = new SymbolPrimitive({
        // An array, not a single instance: Cesium only adds the batchId
        // attribute (which its injected pick code references) when it combines
        // a list of instances.
        geometryInstances: group.instances,
        appearance: appearanceFor(material),
        allowPicking: false,
        asynchronous: false,
        releaseGeometryInstances: true,
      });
      registerDrawBatch(primitive, { layerId, tileId, kind: 'symbol' });
      collection.add(primitive);
      primitives.push({ primitive, instanceIds: group.instances.map(instance => instance.id) });
      for (const { half, vertexStart } of group.halves) {
        primitive.addHalf(half);
        if (half.opacity) {
          half.opacity.target = { primitive, vertexStart };
        }
        if (half.dynamic) {
          half.dynamic.target = { primitive, vertexStart };
        }
      }
    }
  }
  return { collection, primitives };
}

/** Cesium's combined geometry keeps non-interleaved float attributes in the first VA. */
function uploadSymbolAttribute(
  primitive: Primitive,
  name: 'a_opacity' | 'a_dynamic',
  values: Float32Array,
  vertexStart: number,
  components: number,
): boolean {
  const gpu = primitive as Primitive & {
    _va: Array<{ _attributes: Array<{
      index: number;
      vertexBuffer?: {
        copyFromArrayView: (values: Float32Array, offsetInBytes: number) => void;
      };
    }>; }>;
    _attributeLocations: Record<string, number>;
  };
  // Cesium creates the VA before setting Primitive.ready in afterRender.
  // During that interval the CPU Geometry has already been copied, so a
  // collision flip must update the live VBO even though `ready` is false.
  if (!gpu._va?.length) {
    return false;
  }
  const attribute = gpu._va[0]?._attributes.find(item => item.index === gpu._attributeLocations[name]);
  if (gpu._va.length !== 1 || !attribute?.vertexBuffer) {
    throw new Error(`Cesium symbol ${name} buffer has an unsupported vertex layout`);
  }
  attribute.vertexBuffer.copyFromArrayView(values, vertexStart * components * Float32Array.BYTES_PER_ELEMENT);
  // A pre-ready Primitive can still recreate/fill its VA during the next
  // update. Keep one final upload pending until Cesium marks it ready.
  return primitive.ready;
}

/** Copy changed collision opacity into Cesium's persistent VBO. */
export function syncHalfOpacity(half: SymbolHalf): void {
  const opacity = half.opacity;
  if (!opacity) {
    return;
  }
  const geometry = opacity.geometry;
  if (geometry.opacityDirty && opacity.target) {
    const uploaded = uploadSymbolAttribute(opacity.target.primitive, 'a_opacity', geometry.opacities, opacity.target.vertexStart, 1);
    if (uploaded && opacity.target.primitive instanceof SymbolPrimitive) {
      opacity.target.primitive.syncHalfVisibility(half);
    }
    geometry.opacityDirty = !uploaded;
  }
}

/** Stream one layer part's camera-space glyph positions and rotations. */
export function syncHalfDynamic(half: SymbolHalf): void {
  const dynamic = half.dynamic;
  if (!dynamic?.dirty) {
    return;
  }
  if (dynamic.target) {
    dynamic.dirty = !uploadSymbolAttribute(dynamic.target.primitive, 'a_dynamic', dynamic.geometry.dynamics, dynamic.target.vertexStart, 3);
  }
}

/**
 * Bake one layer's halves (text and icon geometries with their shared
 * materials). The two halves sample different atlases, so they never share
 * a material with each other - but they merge with other layers' halves at
 * commit.
 */
export function buildSymbolHalves(options: SymbolCollectionOptions): SymbolHalf[] {
  const halves: SymbolHalf[] = [];

  const textMaterial = options.geometry.text && options.textAtlas
    // Text batches may also carry sprite-image quads (icons-in-text), so the
    // material receives both atlases and routes by v_is_sdf in the fragment.
    ? options.textMaterial
    ?? symbolMaterial(options.textAtlas, options.textColor, true, options.pixelRatio, options.textHalo, options.iconAtlas)
    : undefined;
  const iconMaterial = options.geometry.icon && options.iconAtlas
    ? options.iconMaterial
    ?? symbolMaterial(options.iconAtlas, options.iconColor, false, options.pixelRatio)
    : undefined;

  const buildPart = (
    batch: SymbolPrimitiveGeometry | undefined,
    part: 'text' | 'icon',
    material: Material | undefined,
  ): void => {
    if (!batch || !material) {
      return;
    }
    const geometry = symbolGeometry(batch, batch.indices);
    if (!geometry) {
      return;
    }
    halves.push({
      layerId: options.layerId,
      part,
      geometry,
      material,
      opacity: { geometry: batch },
      dynamic: batch.instances.some(instance => !!instance.line)
        ? { geometry: batch, dirty: true }
        : undefined,
    });
  };
  buildPart(options.geometry.icon, 'icon', iconMaterial);
  buildPart(options.geometry.text, 'text', textMaterial);

  return halves;
}

/**
 * The evaluated value of a constant symbol opacity paint.
 */
function symbolOpacity(layer: SymbolStyleLayer, property: string): number {
  const value = constantValue(layer as unknown as { paint: { get: (property: string) => unknown } }, property);
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}
/**
 * The material colors for one symbol layer with its constant opacity paints
 * folded in. text-opacity / icon-opacity are constant-only here
 * (data-driven opacity would need a per-vertex channel); folding into the
 * material color keeps the per-vertex collision opacity as the single dynamic
 * channel. Exported for unit tests.
 */
export function symbolLayerColors(layer: SymbolStyleLayer): { textColor: Color; iconColor: Color } {
  const textColor = symbolColor(layer, 'text-color');
  textColor.alpha *= symbolOpacity(layer, 'text-opacity');
  const iconColor = symbolColor(layer, 'icon-color');
  iconColor.alpha *= symbolOpacity(layer, 'icon-opacity');
  return { textColor, iconColor };
}
/** Main-thread inputs for one tile's symbol batches. */
export interface SymbolTileInput {
  tileId: string;
  /** Cache key for the geometry extraction (stable per tile bucket instance). */
  tileKey: string;
  tileID: TileID;
  buckets: Record<string, Bucket>;
  collisionBoxArray: CollisionBoxArray;
  layers: SymbolStyleLayer[];
  glyphAtlasImage?: { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
  /**
   * Sprite atlas for icon batches. Carries the packed layout and revision
   * alongside the pixels so tiles with byte-identical atlases share one GPU
   * texture (see SymbolTileRenderer.iconSourceFor).
   */
  iconAtlas?: ImageAtlas;
  pixelRatio: number;
  /**
   * Style draw order, so placement prioritizes layers like MapLibre instead
   * of whichever tile arrived first. Optional for tests.
   */
  layerOrder?: ReadonlyMap<string, number>;
  /** Layer ids the tileset has excluded (hidden, or drawn by another track). */
  skipLayerIds?: ReadonlySet<string>;
}

interface SymbolTileEntry {
  input: SymbolTileInput;
  /**
   * One batch per symbol layer: the collision pass must place every layer,
   * not just the last one built (an earlier `geometry.text = batch.text`
   * overwrite left all but the final layer unculled).
   */
  batches: SymbolTileGeometry[];
  /**
   * Halves baked per layer (geometries + shared materials). Render
   * collections merge halves by layer and material (see mergeSymbolHalves),
   * so collections are not parallel to batches.
   */
  halves: SymbolHalf[];
  /** Merged render collections (one Primitive per layer and material). */
  collections: PrimitiveCollection[];
  /**
   * Fade-addressable merged primitives, parallel to collections: the exact
   * instance ids handed to Cesium plus their Primitives, so the tile fade
   * ticks instance attributes without rebuilding (see tickFades).
   */
  primitives: MergedSymbolPrimitive[];
  /** Parallel to batches: the style layer each batch was built from. */
  layerIds: string[];
  key: string;
  /**
   * Materials referenced by the live collections (shared across tiles and
   * layers by paint/atlas key) and the shared atlas texture keys sampled.
   * Both are entry-counted: _retainEntry before the entry goes live,
   * _releaseEntry when it leaves.
   */
  materials: Set<Material>;
  atlasKeys: string[];
  /**
   * Whether this tile content has participated in a completed collision
   * layout. New generations wait for that commit before replacement handoff.
   */
  placed: boolean;
  /**
   * CPU-retained byte estimate, computed once when the entry is built.
   * Collision updates change values without changing array sizes, so the
   * per-frame memory walk reads this instead of re-summing every half.
   */
  bytes: number;
}

/** One retiring tile's fade state: per-instance write targets plus the clock. */
interface FadingSymbolEntry {
  entry: SymbolTileEntry;
  startedMs: number;
  durationMs: number;
  targets: Array<{ set: (value: number) => void }>;
}

/** The live (non-destroyed) collections of an entry, for tileset handoff. */
function liveCollectionsOf(entry: SymbolTileEntry): PrimitiveCollection[] {
  return entry.collections.filter((collection): collection is PrimitiveCollection => !!collection);
}

/** What retiring a tile produced: pooled, still-fading, or evicted collections. */
export interface SymbolTileRetire {
  retired: PrimitiveCollection[];
  fading: PrimitiveCollection[];
  evicted: PrimitiveCollection[];
}

/** A cancelled fade: live entries stay attached, stale ones go out for destruction. */
export interface SymbolFadeCancel {
  collections: PrimitiveCollection[];
  live: boolean;
}

/**
 * CPU-retained geometry bytes of an entry: the halves survive merging so
 * their opacity channels can be updated in place. Shared materials and
 * atlas textures are owned once and excluded.
 */
export function symbolEntryBytes(entry: Pick<SymbolTileEntry, 'halves'>): number {
  let bytes = 0;
  for (const half of entry.halves ?? []) {
    bytes += geometryBytes(half.geometry);
  }
  return bytes;
}

/** Style draw order of one pending batch; unordered tests sort after. */
function layerOrderOf(entry: SymbolTileEntry, index: number): number {
  return entry.input.layerOrder?.get(entry.layerIds[index]) ?? Number.POSITIVE_INFINITY;
}

interface OrderedSymbolBatch extends SymbolPlacementBatch {
  tileId: string;
  entry: SymbolTileEntry;
  index: number;
  order: number;
  halves: SymbolHalf[];
}

type SymbolPlacementPlanKind = 'target' | 'visible' | 'prospective';
interface SymbolPlacementPlan {
  revision: number;
  entries: ReadonlyMap<string, SymbolTileEntry>;
  owners: ReadonlySet<string>;
  batches: readonly OrderedSymbolBatch[];
}

interface SymbolPlacementEntryIndex {
  layers: ReadonlyMap<string, SymbolStyleLayer>;
  halves: ReadonlyMap<string, SymbolHalf[]>;
}

function sameTileSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const tileId of a) {
    if (!b.has(tileId)) {
      return false;
    }
  }
  return true;
}

function sameSymbolBatch(a: OrderedSymbolBatch, b: OrderedSymbolBatch): boolean {
  return a.entry === b.entry && a.index === b.index
    && a.options.textOptional === b.options.textOptional && a.options.iconOptional === b.options.iconOptional;
}

/** Resumable per-layer symbol extraction state (see stepBuild). */
export interface SymbolBuildState {
  input: SymbolTileInput;
  glyphSource: AtlasSource | undefined;
  iconSource: AtlasSource | undefined;
  batches: SymbolTileGeometry[];
  layerIds: string[];
  halves: SymbolHalf[];
  key: string;
  layerIndex: number;
  entry?: SymbolTileEntry;
  retainedMaterials: Set<Material>;
  resourceOwner: 'build' | 'entry' | 'released';
}

export function beginSymbolBuild(
  input: SymbolTileInput,
  glyphSource: AtlasSource | undefined,
  iconSource: AtlasSource | undefined,
): SymbolBuildState {
  return {
    input,
    glyphSource,
    iconSource,
    batches: [],
    layerIds: [],
    halves: [],
    key: '',
    layerIndex: 0,
    retainedMaterials: new Set(),
    resourceOwner: 'build',
  };
}

const EMPTY_SYMBOL_COLLECTIONS: readonly PrimitiveCollection[] = [];

/**
 * Per-tile symbol collections.
 *
 * Symbols need an atlas texture per unique atlas content (one shared glyph
 * texture per tile, one shared sprite texture per sprite set) and a dedicated
 * SDF shader, so they live outside the Buffer*Collection track: one Primitive
 * per tile and shared material. Collision changes update its opacity VBO.
 */
export class SymbolTileRenderer {
  private _tiles: Map<string, SymbolTileEntry> = new Map();
  /**
   * The currently drawn generation may precede the tile's latest prepared entry.
   */
  private _visibleEntries: Map<string, SymbolTileEntry> = new Map();

  private _imageUpdateRevision = -1;

  private _pendingImageEntries = new Set<SymbolTileEntry>();

  private _held = new Map<number, SymbolTileEntry>();

  private _nextHeldId = 0;

  private _excludedPlacementTiles = new Set<string>();

  private _lineView: PlacementView | undefined;

  private _liveSelectionView: PlacementView | undefined;

  private readonly _liveCollision = new SymbolCollisionIndex();

  private _liveSelections = new WeakMap<SymbolTileGeometry, { selection: SymbolTileSelection; origin: object; order: number; fresh: boolean }>();

  private _liveSelectionRevision = 0;

  private _appliedLiveSelectionRevision = -1;

  private _liveSelectionPlanRevision = -1;
  /**
   * Scene visibility and replacement readiness are different collision scopes.
   */
  private _hiddenPlacementTiles = new Set<string>();

  private _visibleInputsDirty = false;

  private _placementLayerInputs = new WeakMap<SymbolTileEntry, readonly boolean[]>();

  private _placementPlanRevision = 0;

  private _placementPlans = new Map<SymbolPlacementPlanKind, SymbolPlacementPlan>();

  private _placementEntryIndexes = new WeakMap<SymbolTileEntry, SymbolPlacementEntryIndex>();
  /** MapLibre keeps a completed placement recent for its 300ms fade interval. */
  static readonly PLACEMENT_RECENCY_MS = 300;
  static readonly PLACEMENT_BUDGET_MS = 2;

  private _placementScopeTurn = 0;

  private readonly _targetPlacement = new SymbolPlacementScope<OrderedSymbolBatch>(sameSymbolBatch, SymbolTileRenderer.PLACEMENT_RECENCY_MS);

  private readonly _visiblePlacement = new SymbolPlacementScope<OrderedSymbolBatch>(sameSymbolBatch, SymbolTileRenderer.PLACEMENT_RECENCY_MS);

  private readonly _handoffPlacement = new SymbolPlacementScope<OrderedSymbolBatch>(sameSymbolBatch, SymbolTileRenderer.PLACEMENT_RECENCY_MS);

  private _prospectiveVisibleTiles: ReadonlySet<string> | undefined;
  /**
   * A removal leaves ghost boxes in an active generation, so the next
   * generation must rebuild its occupancy from the latest tile content.
   */
  private _fullReplaceNeeded = false;
  /**
   * Material factory by paint/atlas key (see _materialKey): tiles and layers
   * with identical paint over identical atlas content share one Material and
   * therefore one GPU texture, instead of uploading the atlas per
   * tile/layer. Collision flips mutate only the per-vertex opacity channel,
   * so the material and Primitive stay alive. Without sharing each layer
   * minted a Material whose GPU texture outlived its Primitive
   * (Primitive.destroy never frees appearances) - a full-atlas re-upload
   * plus a texture leak per tile per layer. Ownership is entry-counted in
   * _materialRefs; a zero-ref material is destroyed eagerly, factory entry
   * included. Atlas canvases/textures live in _shared under the source's
   * shareKey with the same entry-counted lifetime.
   */
  private _materials = new Map<string, Material>();

  private _materialRefs = new Map<Material, number>();
  /**
   * Live style zoom, set by the tileset every frame. Composite symbol sizes
   * carry their two zoom stops in the vertex, so this uniform interpolates
   * them: a zoom animation resizes labels continuously instead of stepping
   * at tile boundaries.
   */
  cameraZoom = 0;

  private _shared = new SharedAtlasTextures({ premultiplyAlpha: true });

  private _payloadIds = new WeakMap<object, number>();

  private _payloadNextId = 1;

  get tileIds(): string[] {
    return [...this._tiles.keys()];
  }

  /** Live, replacement-held or fading resources still need current line projection. */
  get hasDrawableSymbols(): boolean {
    return this._tiles.size > 0 || this._held.size > 0 || this._fading.size > 0;
  }

  /** Live collections for one tile; the tileset may toggle their `show` flags. */
  getTileCollections(tileId: string): readonly PrimitiveCollection[] {
    return this._tiles.get(tileId)?.collections ?? EMPTY_SYMBOL_COLLECTIONS;
  }

  /** Current committed tile content has participated in a complete layout. */
  isTilePlaced(tileId: string): boolean {
    return this._tiles.get(tileId)?.placed === true;
  }

  /** Scene handoff may switch collections only after their layout became active. */
  isTilePlacementActive(tileId: string): boolean {
    const entry = this._tiles.get(tileId);
    return !!entry && entry.placed && this._visibleEntries.get(tileId) === entry;
  }

  /** Geometry already extracted for a layer, including currently hidden layers. */
  hasTileLayer(tileId: string, layerId: string): boolean {
    return this._tiles.get(tileId)?.layerIds.includes(layerId) === true;
  }

  /** Whether this tile can supply symbol coverage at the current style zoom. */
  hasTileVisibleSymbols(tileId: string): boolean {
    const entry = this._visibleEntries.get(tileId) ?? this._tiles.get(tileId);
    if (!entry || !entry.collections.some(collection => !collection.isDestroyed())) {
      return false;
    }
    const metadata = this._placementEntryIndexFor(entry);
    return entry.batches.some((batch, index) => {
      const layerId = entry.layerIds[index];
      const layer = metadata.layers.get(layerId);
      if (layer?.isHidden(this.cameraZoom)) {
        return false;
      }
      const drawableParts = (['text', 'icon'] as const).filter(part => (batch[part]?.instances.length ?? 0) > 0);
      return !!layer && metadata.halves.get(layerId)?.some(half =>
        drawableParts.includes(half.part) && !half.material.isDestroyed()) === true;
    });
  }

  /** The scene's current symbol owner, independent of future replacement input. */
  setTilePlacementVisible(tileId: string, visible: boolean): void {
    if (this._hiddenPlacementTiles.has(tileId) === !visible) {
      return;
    }
    if (visible) {
      this._hiddenPlacementTiles.delete(tileId);
    }
    else {
      this._hiddenPlacementTiles.add(tileId);
    }
    this._visibleInputsDirty = true;
    this._liveSelectionView = undefined;
  }

  /** Prepare a whole prospective owner set before the scene changes its draw cover. */
  prepareVisiblePlacement(tileIds: ReadonlySet<string>): boolean {
    this._prospectiveVisibleTiles = new Set(tileIds);
    const prospective = this._placementPlanFor('prospective', this._lineView?.cameraZoom ?? this.cameraZoom, tileIds);
    const prepared = this._preparedForOwners(prospective);
    if (prepared) {
      this._prospectiveVisibleTiles = undefined;
      if (prepared !== this._handoffPlacement.complete) {
        this._handoffPlacement.clear();
      }
      return true;
    }
    if (prospective.length === 0) {
      this._handoffPlacement.completeEmpty(this._lineView ?? {
        viewProjection: new Float64Array(16),
        width: 0,
        height: 0,
        pixelRatio: 1,
        cameraZoom: this.cameraZoom,
        cameraToCenterDistance: undefined,
        orthographic: false,
        mercatorProjection: false,
      });
      this._prospectiveVisibleTiles = undefined;
      return true;
    }
    this._handoffPlacement.prepare(prospective);
    return false;
  }

  /** Atomically apply a complete layout to exactly the scene's new owners. */
  activatePreparedPlacement(): boolean {
    const owners = new Set([...this._tiles.keys()].filter(tileId => !this._hiddenPlacementTiles.has(tileId)));
    const visible = this._placementPlanFor('prospective', this._lineView?.cameraZoom ?? this.cameraZoom, owners);
    const prepared = this._preparedForOwners(visible);
    if (!prepared || (this._visiblePlacement.complete?.pass === prepared.pass && !this._visibleInputsDirty)) {
      return false;
    }
    const projections = new SymbolProjectionContext();
    this._commitPlacement(prepared.pass, prepared.batches, () => true, projections, this._lineView);
    let generationsChanged = false;
    for (const [tileId, entry] of this._tiles) {
      generationsChanged ||= this._visibleEntries.get(tileId) !== entry;
      this._visibleEntries.set(tileId, entry);
    }
    if (generationsChanged) {
      this._placementPlanRevision++;
    }
    this._visiblePlacement.prepare(visible);
    this._visiblePlacement.activate(prepared, this._lineView ?? prepared.view);
    this._visibleInputsDirty = false;
    this._prospectiveVisibleTiles = undefined;
    this._handoffPlacement.clear();
    if (this._lineView) {
      this._filterVisibleSelection(this._lineView, projections);
    }
    return true;
  }

  /**
   * @internal
   */
  private _preparedForOwners(batches: readonly OrderedSymbolBatch[]): SymbolPlacementGeneration<OrderedSymbolBatch> | undefined {
    for (const scope of [this._targetPlacement, this._handoffPlacement, this._visiblePlacement]) {
      const prepared = scope.complete;
      if (prepared && prepared.batches.length === batches.length
        && prepared.batches.every((batch, index) => sameSymbolBatch(batch, batches[index]) && this._tiles.get(batch.tileId) === batch.entry)
        && this._canActivatePlacement(prepared)) {
        return prepared;
      }
    }
    return undefined;
  }

  /**
   * @internal
   */
  private _canActivatePlacement(prepared: SymbolPlacementGeneration<OrderedSymbolBatch>): boolean {
    if (!this._lineView || samePlacementView(prepared.view, this._lineView)) {
      return true;
    }
    // An unaffected nonempty entry cannot make an empty successor safe. Its
    // selected-only live filter has no candidates to recover in the new view.
    const selected = new Map<SymbolTileEntry, boolean>();
    for (const [index, batch] of prepared.batches.entries()) {
      selected.set(batch.entry, selected.get(batch.entry) === true || prepared.pass.hasSelectedCandidates(index));
    }
    const emptySuccessor = prepared.batches.some(batch => (this._hiddenPlacementTiles.has(batch.tileId) || this._visibleEntries.get(batch.tileId) !== batch.entry) && !selected.get(batch.entry));
    if (!emptySuccessor) {
      return true;
    }
    // Keep the old complete cover until a current-view pass can confirm the
    // successor's empty result. A first load has no prior cover to preserve.
    return ![...this._visibleEntries].some(([tileId, entry]) => !this._hiddenPlacementTiles.has(tileId)
      && !selected.has(entry) && entry.batches.some(batch => this._liveSelections.get(batch)?.selection.hasCandidates));
  }

  /** Future replacement input, independently of the scene's current owners. */
  setTilePlacementEligible(tileId: string, eligible: boolean): void {
    if (this._excludedPlacementTiles.has(tileId) === !eligible) {
      return;
    }
    if (eligible) {
      this._excludedPlacementTiles.delete(tileId);
    }
    else {
      this._excludedPlacementTiles.add(tileId);
    }
    this._invalidatePlacementInputs();
  }

  /**
   * Live/fading/retired tile and Primitive counts for diagnostics. Cesium may
   * emit multiple DrawCommands from one Primitive; the tileset counts commands.
   */
  get stats(): { tiles: number; fadingTiles: number; retiredTiles: number; primitives: number } {
    let primitives = 0;
    for (const entry of this._tiles.values()) {
      primitives += entry.primitives.length;
    }
    return {
      tiles: this._tiles.size,
      fadingTiles: this._fading.size,
      retiredTiles: this._retired.size,
      primitives,
    };
  }

  /**
   * Per-tile byte estimates for the memory budget, live then retired
   * oldest-first (the budget's LRU order). Fading entries are pinned:
   * attached but out of view, never evict mid-fade.
   */
  visitMemoryEntries(visit: MemoryBudgetVisitor): void {
    for (const [tileId, entry] of this._tiles) {
      // Live entries are attached to the scene: pinned, never evictable.
      visit(tileId, entry.bytes, true);
    }
    for (const [id, entry] of this._held) {
      visit(`held:${id}`, entry.bytes, true);
    }
    for (const [tileId, fading] of this._fading) {
      visit(tileId, fading.entry.bytes, true);
    }
    for (const [tileId, entry] of this._retired.entries()) {
      visit(tileId, entry.bytes);
    }
  }

  /**
   * Register a finished {@link SymbolBuildState}. The publish path extracts
   * across frames, then swaps the tile's collections at commit.
   * Returns the new collections alongside the retired ones for the tileset to
   * swap in the scene.
   */
  commitBuild(state: SymbolBuildState): {
    added: PrimitiveCollection[];
    removed: PrimitiveCollection[];
    retained?: { collections: PrimitiveCollection[]; release: () => void };
  } {
    if (state.resourceOwner !== 'build') {
      throw new Error('commitBuild called after symbol build ownership ended');
    }
    if (!state.entry) {
      throw new Error('commitBuild called on an unfinished symbol build');
    }
    if (state.entry.collections.length === 0) {
      // A tile can carry atlas payloads but no drawable symbols. Do not keep
      // their textures resident or put an empty entry into placement.
      this.releaseBuild(state);
      return { added: [], removed: this.removeTile(state.input.tileId) };
    }
    this._retainBuildMaterials(state, state.entry.materials);
    state.resourceOwner = 'entry';
    const previous = this._tiles.get(state.input.tileId);
    const current = this._visibleEntries.get(state.input.tileId);
    const heldId = previous ? ++this._nextHeldId : undefined;
    if (previous) {
      // SceneCollections keeps these primitives visible until the replacement
      // uploads. Keep the resources they sample alive for the same interval.
      this._retainEntryMaterials(previous);
      for (const key of previous.atlasKeys) {
        this._shared.retain(key);
      }
      this._held.set(heldId!, previous);
    }
    // Eligibility belongs to the logical tile's current cover, so a content
    // replacement preserves it while explicit removal clears it.
    const excluded = this._excludedPlacementTiles.has(state.input.tileId);
    const hidden = this._hiddenPlacementTiles.has(state.input.tileId);
    const removed = this.removeTile(state.input.tileId);
    if (excluded) {
      this._excludedPlacementTiles.add(state.input.tileId);
    }
    if (hidden) {
      this._hiddenPlacementTiles.add(state.input.tileId);
    }
    this._tiles.set(state.input.tileId, state.entry);
    this._visibleEntries.set(state.input.tileId, current ?? state.entry);
    if (state.entry.input.iconAtlas) {
      this._pendingImageEntries.add(state.entry);
    }
    // A newly published generation stays hidden until its joint collision
    // layout commits. The previous generation can remain visible during the
    // tileset's GPU-ready AND placement-ready replacement handoff.
    for (const batch of state.entry.batches) {
      for (const part of [batch.text, batch.icon]) {
        if (part) {
          part.opacities.fill(0);
          part.opacityDirty = true;
        }
      }
    }
    for (const half of state.entry.halves) {
      this._syncOpacity(half);
    }
    this._invalidatePlacementInputs();
    return {
      added: state.entry.collections.filter((collection): collection is PrimitiveCollection => !!collection),
      removed,
      retained: previous && {
        collections: liveCollectionsOf(previous),
        release: () => {
          if (this._held.delete(heldId!)) {
            this._releaseEntry(previous);
          }
        },
      },
    };
  }

  /**
   * Bake one layer's halves during tile publication. Halves merge by shared
   * material at commit; collision changes only update their opacity VBOs.
   * @internal
   */
  private _buildLayer(
    input: SymbolTileInput,
    layer: SymbolStyleLayer,
    batch: SymbolTileGeometry,
    glyphSource: AtlasSource | undefined,
    iconSource: AtlasSource | undefined,
  ): SymbolHalf[] {
    // text-opacity / icon-opacity are constant-only here (data-driven opacity
    // would need a per-vertex channel); folding into the material color keeps
    // the per-vertex collision opacity as the single dynamic channel.
    const { textColor, iconColor } = symbolLayerColors(layer);
    const halo = symbolHalo(layer);
    const textMaterial = batch.text && glyphSource
      ? this._cachedMaterial(this._materialKey(textColor, true, input.pixelRatio, halo, glyphSource, iconSource), () => symbolMaterial(glyphSource, textColor, true, input.pixelRatio, halo, iconSource))
      : undefined;
    const iconHalo = symbolHalo(layer, 'icon');
    const iconMaterial = batch.icon && iconSource
      ? this._cachedMaterial(this._materialKey(iconColor, false, input.pixelRatio, iconHalo, iconSource, undefined), () => symbolMaterial(iconSource, iconColor, false, input.pixelRatio, iconHalo))
      : undefined;
    // Point shared materials at the shared atlas textures: one GPU texture
    // per atlas content instead of one per material. Adoption happens in
    // update() with the frame context, before first render.
    if (textMaterial && glyphSource) {
      this._shared.track(glyphSource.shareKey, textMaterial, 'u_texture');
      this._shared.track(iconSource?.shareKey ?? glyphSource.shareKey, textMaterial, 'u_texture_icon');
    }
    if (iconMaterial && iconSource) {
      this._shared.track(iconSource.shareKey, iconMaterial, 'u_texture');
      this._shared.track(iconSource.shareKey, iconMaterial, 'u_texture_icon');
    }
    return buildSymbolHalves({
      tileId: input.tileId,
      layerId: layer.id,
      geometry: batch,
      textAtlas: glyphSource,
      iconAtlas: iconSource,
      textColor,
      iconColor,
      textHalo: halo,
      pixelRatio: input.pixelRatio,
      textMaterial,
      iconMaterial,
    });
  }

  /**
   * @internal
   */
  private _payloadId(data: object): number {
    let id = this._payloadIds.get(data);
    if (id === undefined) {
      id = this._payloadNextId++;
      this._payloadIds.set(data, id);
    }
    return id;
  }

  /**
   * Resolve the glyph source for one tile's payload. Glyph sets differ per
   * tile, so the canvas stays per tile - but it is registered under a stable
   * shareKey, collapsing the per-layer uploads of the tile into one shared
   * texture on adopt.
   */
  glyphSourceFor(image: NonNullable<SymbolTileInput['glyphAtlasImage']>): AtlasSource {
    const shareKey = `glyph/payload${this._payloadId(image.data)}/${image.width}x${image.height}`;
    const source = glyphAtlasSource(image.data, image.width, image.height, shareKey);
    this._shared.canvas(shareKey, image.width, image.height, () => source.canvas);
    // Upload the raw SDF bytes as R8 (no RGBA expansion, quarter the bytes).
    // The shader samples .r, which matches the replicated canvas channels,
    // so canvas and texture paths render identically.
    this._shared.setDirectUpload(shareKey, image.data, PixelFormat.RED, image.width, image.height);
    return source;
  }

  /**
   * Reuse one canvas for tiles with the same sprite layout and revisions.
   * The shared registry releases it when the last tile leaves.
   */
  iconSourceFor(iconAtlas: NonNullable<SymbolTileInput['iconAtlas']>): AtlasSource {
    const { image } = iconAtlas;
    const shareKey = iconAtlasShareKey(iconAtlas.iconPositions);
    const canvas = this._shared.canvas(shareKey, image.width, image.height, () => iconAtlasSource(image.data, image.width, image.height, shareKey).canvas);
    return { canvas: canvas as HTMLCanvasElement, width: canvas.width, height: canvas.height, shareKey };
  }

  /**
   * @internal
   */
  private _materialKey(
    color: Color,
    isText: boolean,
    pixelRatio: number,
    halo: TextHalo | undefined,
    atlas: AtlasSource,
    iconAtlas: AtlasSource | undefined,
  ): string {
    const atlasKey = (source: AtlasSource): string => `${source.shareKey}:${source.width}x${source.height}`;
    return [
      isText ? 't' : 'i',
      color.red,
      color.green,
      color.blue,
      color.alpha,
      pixelRatio,
      halo ? `${halo.color.red},${halo.color.green},${halo.color.blue},${halo.color.alpha},${halo.width},${halo.blur}` : '-',
      atlasKey(atlas),
      iconAtlas ? atlasKey(iconAtlas) : '-',
    ].join('|');
  }

  /**
   * Return the shared material for a paint/atlas key, creating it on miss.
   * No tile/layer identity in the key: identical paint over identical atlas
   * content is one Material (one GPU texture) no matter how many tiles or
   * layers use it. Lifecycle is entry-counted (_retainEntry/_releaseEntry),
   * so a key change here never destroys - it just stops sharing.
   * @internal
   */
  private _cachedMaterial(key: string, create: () => Material): Material {
    let material = this._materials.get(key);
    if (!material || material.isDestroyed()) {
      material = create();
      this._materials.set(key, material);
    }
    return material;
  }

  /**
   * @internal
   */
  private _retainMaterial(material: Material): void {
    // Tile extraction can finish after this frame's camera update. A new
    // atlas material must already use the current units on its first paint.
    material.uniforms.u_camera_zoom = this.cameraZoom;
    if (this._lineView) {
      material.uniforms.u_symbol_camera_distance = this._lineView.cameraToCenterDistance ?? 0;
      material.uniforms.u_symbol_orthographic = this._lineView.orthographic ? 1 : 0;
      material.uniforms.u_symbol_mercator_projection = this._lineView.mercatorProjection ? 1 : 0;
    }
    this._materialRefs.set(material, (this._materialRefs.get(material) ?? 0) + 1);
  }

  /**
   * @internal
   */
  private _retainBuildMaterials(state: SymbolBuildState, materials: Iterable<Material>): void {
    for (const material of materials) {
      if (!state.retainedMaterials.has(material)) {
        state.retainedMaterials.add(material);
        this._retainMaterial(material);
      }
    }
  }

  /**
   * @internal
   */
  private _releaseMaterial(material: Material): void {
    const refs = (this._materialRefs.get(material) ?? 0) - 1;
    if (refs > 0) {
      this._materialRefs.set(material, refs);
      return;
    }
    this._materialRefs.delete(material);
    for (const [key, cached] of this._materials) {
      if (cached === material) {
        this._materials.delete(key);
      }
    }
    if (!material.isDestroyed()) {
      material.destroy();
    }
  }

  /**
   * Retain an entry's materials (call before releasing the entry it replaces).
   * @internal
   */
  private _retainEntryMaterials(entry: SymbolTileEntry): void {
    for (const material of entry.materials) {
      this._retainMaterial(material);
    }
  }

  /**
   * Release an entry's materials and its transferred atlas holds, destroying
   * zeros. Atlas holds arrive with the build (beginBuild retains) and
   * transfer to the committed entry, so addTile/commitBuild must retain
   * materials only - never re-retain the holds.
   * @internal
   */
  private _releaseEntry(entry: SymbolTileEntry): void {
    const tileId = entry.input.tileId;
    if (this._visibleEntries.get(tileId) === entry && this._tiles.get(tileId) !== entry) {
      this._visibleEntries.delete(tileId);
      this._placementPlanRevision++;
      this._visibleInputsDirty = true;
    }
    this._pendingImageEntries.delete(entry);
    for (const half of entry.halves) {
      this._pendingDynamicHalves.delete(half);
      this._pendingOpacityHalves.delete(half);
    }
    for (const material of entry.materials) {
      this._releaseMaterial(material);
    }
    for (const key of entry.atlasKeys) {
      this._shared.release(key);
    }
  }

  /**
   * Destroy every material and atlas texture (style swap / destroy).
   * @internal
   */
  private _destroyAllMaterials(): void {
    for (const material of new Set([...this._materials.values(), ...this._materialRefs.keys()])) {
      if (!material.isDestroyed()) {
        material.destroy();
      }
    }
    this._materials.clear();
    this._materialRefs.clear();
    this._shared.clear();
  }

  /**
   * Every Material referenced by an entry's live collections.
   * @internal
   */
  private static _entryMaterials(entry: SymbolTileEntry): Set<Material> {
    const materials = new Set<Material>();
    for (const collection of entry.collections) {
      if (!collection) {
        continue;
      }
      for (let i = 0; i < collection.length; i++) {
        const material = (collection.get(i) as unknown as { appearance?: { material?: Material } }).appearance?.material;
        if (material) {
          materials.add(material);
        }
      }
    }
    return materials;
  }

  /**
   * Resumable per-layer symbol build. Extraction dominates (per-instance quad
   * projection for every label of the layer), so slicing by layer bounds the
   * publish path; the detached entry commits to the tile map whole.
   * Resolving the sources retains their shared atlas holds, which transfer
   * to the committed entry (released by removeTile) or are released by
   * releaseBuild when the build is abandoned.
   */
  beginBuild(input: SymbolTileInput): SymbolBuildState {
    const glyphSource = input.glyphAtlasImage ? this.glyphSourceFor(input.glyphAtlasImage) : undefined;
    const iconSource = input.iconAtlas ? this.iconSourceFor(input.iconAtlas) : undefined;
    if (glyphSource) {
      this._shared.retain(glyphSource.shareKey);
    }
    if (iconSource && iconSource.shareKey !== glyphSource?.shareKey) {
      this._shared.retain(iconSource.shareKey);
    }
    return beginSymbolBuild(input, glyphSource, iconSource);
  }

  /**
   * Release a cancelled build's detached collections, materials and atlas
   * holds. Committed entries own these resources instead.
   */
  releaseBuild(state: SymbolBuildState): void {
    if (state.resourceOwner !== 'build')
      return;
    state.resourceOwner = 'released';
    for (const collection of state.entry?.collections ?? []) {
      if (!collection.isDestroyed())
        collection.destroy();
    }
    for (const material of state.retainedMaterials)
      this._releaseMaterial(material);
    state.retainedMaterials.clear();
    if (state.glyphSource) {
      this._shared.release(state.glyphSource.shareKey);
    }
    if (state.iconSource && state.iconSource.shareKey !== state.glyphSource?.shareKey) {
      this._shared.release(state.iconSource.shareKey);
    }
  }

  stepBuild(state: SymbolBuildState, budget: Budget): boolean {
    const { input } = state;
    if (state.layerIndex === 0)
      this._retainBuildMaterials(state, state.halves.map(half => half.material));
    // Always finish at least one layer per call to prevent livelock.
    let first = true;
    while (state.layerIndex < input.layers.length) {
      if (!first && budget.exhausted) {
        return false;
      }
      first = false;
      const layer = input.layers[state.layerIndex++];
      if (input.skipLayerIds?.has(layer.id)) {
        continue;
      }
      const bucket = input.buckets[layer.id];
      if (!(bucket instanceof SymbolBucket)) {
        continue;
      }
      const batch = symbolBucketGeometry(bucket, input.tileID, input.tileKey, input.collisionBoxArray);
      if (!batch.text && !batch.icon) {
        continue;
      }
      state.batches.push(batch);
      state.layerIds.push(layer.id);
      const halves = this._buildLayer(input, layer, batch, state.glyphSource, state.iconSource);
      this._retainBuildMaterials(state, halves.map(half => half.material));
      if (halves.length > 0) {
        state.key += `${layer.id}/${input.tileKey}/${input.pixelRatio};`;
        state.halves.push(...halves);
      }
    }
    const merged = mergeSymbolHalves(input.tileId, state.halves);
    state.entry = {
      input,
      batches: state.batches,
      halves: state.halves,
      collections: merged ? [merged.collection] : [],
      primitives: merged ? merged.primitives : [],
      layerIds: state.layerIds,
      key: state.key,
      placed: false,
      materials: new Set(),
      atlasKeys: [
        ...(state.glyphSource ? [state.glyphSource.shareKey] : []),
        ...(state.iconSource && state.iconSource.shareKey !== state.glyphSource?.shareKey ? [state.iconSource.shareKey] : []),
      ],
      bytes: 0,
    };
    state.entry.materials = SymbolTileRenderer._entryMaterials(state.entry);
    state.entry.bytes = symbolEntryBytes(state.entry);
    return true;
  }

  private _pendingOpacityHalves = new Set<SymbolHalf>();

  private _pendingDynamicHalves = new Set<SymbolHalf>();

  /**
   * @internal
   */
  private _syncOpacity(half: SymbolHalf): void {
    syncHalfOpacity(half);
    if (half.opacity?.geometry.opacityDirty) {
      this._pendingOpacityHalves.add(half);
    }
    else {
      this._pendingOpacityHalves.delete(half);
    }
  }

  /**
   * @internal
   */
  private _syncDynamic(half: SymbolHalf): void {
    syncHalfDynamic(half);
    if (half.dynamic?.dirty) {
      this._pendingDynamicHalves.add(half);
    }
    else {
      this._pendingDynamicHalves.delete(half);
    }
  }

  /**
   * @internal
   */
  private _drainPendingAttributes(): void {
    for (const half of [...this._pendingOpacityHalves]) {
      this._syncOpacity(half);
    }
    for (const half of [...this._pendingDynamicHalves]) {
      this._syncDynamic(half);
    }
  }

  /**
   * Reproject recoverable candidates, preserving each held/fading generation.
   * @internal
   */
  private _updateLineLabels(view: PlacementView, entries: Iterable<SymbolTileEntry>, projections: SymbolProjectionContext): void {
    for (const entry of entries) {
      const metadata = this._placementEntryIndexFor(entry);
      for (let index = 0; index < entry.batches.length; index++) {
        const geometry = entry.batches[index];
        const baseline = this._liveSelections.get(geometry);
        this._updateSelectedLineBatch(view, geometry, metadata.halves.get(entry.layerIds[index]) ?? [], baseline?.selection, projections);
      }
    }
  }

  /**
   * Camera movement and new selections publish through the same current view.
   * @internal
   */
  private _updateSelectedLineBatch(view: PlacementView, geometry: SymbolTileGeometry, halves: readonly SymbolHalf[], selection: SymbolTileSelection | undefined, projections: SymbolProjectionContext): void {
    for (const half of halves) {
      const dynamic = half.dynamic;
      if (!dynamic || dynamic.geometry !== geometry[half.part]) {
        continue;
      }
      if (selection && updateLineSymbolGeometry(dynamic.geometry, view, selection.instanceIndices(half.part), projections)) {
        dynamic.dirty = true;
      }
      this._syncDynamic(half);
    }
  }

  /**
   * @internal
   */
  private* _drawableLineEntries(): IterableIterator<SymbolTileEntry> {
    yield* this._tiles.values();
    yield* this._held.values();
    for (const { entry } of this._fading.values()) {
      yield entry;
    }
  }

  /** Patch bitmap samplers without rebuilding quads or collision placement. */
  refreshImages(images: StyleImages): boolean {
    if (this._imageUpdateRevision !== images.imageUpdateRevision) {
      for (const entry of this._drawableLineEntries()) {
        if (entry.input.iconAtlas) {
          this._pendingImageEntries.add(entry);
        }
      }
    }
    let changed = false;
    for (const entry of this._pendingImageEntries) {
      changed = this._refreshEntryImages(entry, images) || changed;
    }
    this._pendingImageEntries.clear();
    this._imageUpdateRevision = images.imageUpdateRevision;
    return changed;
  }

  /**
   * @internal
   */
  private _refreshEntryImages(entry: SymbolTileEntry, images: StyleImages): boolean {
    const atlas = entry.input.iconAtlas;
    if (!atlas) {
      return false;
    }
    atlas.patchUpdatedImages(images);
    const iconKey = iconAtlasShareKey(atlas.iconPositions);
    if (entry.atlasKeys.includes(iconKey)) {
      return false;
    }
    const iconSource = this.iconSourceFor(atlas);
    this._shared.retain(iconKey);
    const replacements = new Map<Material, Material>();
    for (const previous of entry.materials) {
      const uniforms = previous.uniforms;
      const color = uniforms.u_color as Cartesian4;
      const haloColor = uniforms.u_halo_color as Cartesian4;
      const isText = uniforms.u_is_text as boolean;
      const source = isText ? this.glyphSourceFor(entry.input.glyphAtlasImage!) : iconSource;
      const paint = new Color(color.x, color.y, color.z, color.w);
      const halo = uniforms.u_halo_width > 0
        ? { color: new Color(haloColor.x, haloColor.y, haloColor.z, haloColor.w), width: uniforms.u_halo_width as number, blur: uniforms.u_halo_blur as number }
        : undefined;
      const icon = isText ? iconSource : undefined;
      const material = this._cachedMaterial(
        this._materialKey(paint, isText, uniforms.u_device_pixel_ratio as number, halo, source, icon),
        () => symbolMaterial(source, paint, isText, uniforms.u_device_pixel_ratio as number, halo, icon),
      );
      material.uniforms.u_camera_zoom = uniforms.u_camera_zoom;
      material.uniforms.u_symbol_camera_distance = uniforms.u_symbol_camera_distance;
      material.uniforms.u_symbol_orthographic = uniforms.u_symbol_orthographic;
      material.uniforms.u_symbol_mercator_projection = uniforms.u_symbol_mercator_projection;
      this._shared.track(source.shareKey, material, 'u_texture');
      this._shared.track(iconKey, material, 'u_texture_icon');
      this._retainMaterial(material);
      replacements.set(previous, material);
    }
    for (const half of entry.halves) {
      half.material = replacements.get(half.material)!;
    }
    for (const { primitive } of entry.primitives) {
      // Appearances are shared by material. Replace the public appearance
      // rather than mutating a template still used by another generation.
      primitive.appearance = appearanceFor(replacements.get(primitive.appearance.material)!);
    }
    const previousMaterials = entry.materials;
    entry.materials = new Set(replacements.values());
    for (const material of previousMaterials) {
      this._releaseMaterial(material);
    }
    entry.atlasKeys = entry.atlasKeys.map((key) => {
      if (!key.startsWith('icon/')) {
        return key;
      }
      this._shared.release(key);
      return iconKey;
    });
    return true;
  }

  /**
   * @internal
   */
  private _invalidatePlacementInputs(): void {
    this._placementPlanRevision++;
    this._fullReplaceNeeded = true;
  }

  /**
   * @internal
   */
  private _placementEntryIndexFor(entry: SymbolTileEntry): SymbolPlacementEntryIndex {
    let metadata = this._placementEntryIndexes.get(entry);
    if (!metadata) {
      const halves = new Map<string, SymbolHalf[]>();
      for (const half of entry.halves) {
        let group = halves.get(half.layerId);
        if (!group) {
          group = [];
          halves.set(half.layerId, group);
        }
        group.push(half);
      }
      metadata = { layers: new Map(entry.input.layers.map(layer => [layer.id, layer])), halves };
      this._placementEntryIndexes.set(entry, metadata);
    }
    return metadata;
  }

  /**
   * Cache ordering and metadata independently from the moving collision view.
   * @internal
   */
  private _placementPlanFor(kind: SymbolPlacementPlanKind, cameraZoom: number, owners: ReadonlySet<string>, entries: ReadonlyMap<string, SymbolTileEntry> = this._tiles): readonly OrderedSymbolBatch[] {
    const cached = this._placementPlans.get(kind);
    if (cached && cached.revision === this._placementPlanRevision && cached.entries === entries && sameTileSet(cached.owners, owners)) {
      return cached.batches;
    }
    const ordered: OrderedSymbolBatch[] = [];
    for (const [tileId, entry] of entries) {
      if (!owners.has(tileId)) {
        continue;
      }
      const metadata = this._placementEntryIndexFor(entry);
      for (let index = 0; index < entry.batches.length; index++) {
        const layerId = entry.layerIds[index];
        const layer = metadata.layers.get(layerId);
        if (layer?.isHidden(cameraZoom)) {
          continue;
        }
        const layout = layer?.layout as unknown as { get?: (name: string) => unknown } | undefined;
        ordered.push({
          tileId,
          entry,
          index,
          order: layerOrderOf(entry, index),
          geometry: entry.batches[index],
          options: {
            pairs: entry.batches[index].pairs,
            textOptional: layout?.get?.('text-optional') === true,
            iconOptional: layout?.get?.('icon-optional') === true,
          },
          halves: metadata.halves.get(layerId) ?? [],
        });
      }
    }
    ordered.sort((a, b) => b.order - a.order
      || (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0)
      || a.index - b.index);
    this._placementPlans.set(kind, { revision: this._placementPlanRevision, entries, owners: new Set(owners), batches: ordered });
    return ordered;
  }

  /**
   * @internal
   */
  private _commitPlacement(pass: SymbolPlacementPass, batches: readonly OrderedSymbolBatch[], include: (batchIndex: number) => boolean, projections: SymbolProjectionContext, view: PlacementView | undefined): void {
    const origin = {};
    pass.commit((batchIndex, selection) => {
      if (!include(batchIndex)) {
        return false;
      }
      const batch = batches[batchIndex];
      // Finished old-view work must not erase a current owner's recoverable
      // selection. New and hidden prepared owners still finish their handoff.
      return !this._lineView || samePlacementView(selection.view, this._lineView)
        || !this._liveSelections.has(batch.geometry)
        || this._visibleEntries.get(batch.tileId) !== batch.entry
        || this._hiddenPlacementTiles.has(batch.tileId);
    }, (batchIndex) => {
      for (const half of batches[batchIndex].halves) {
        this._syncOpacity(half);
      }
    }, (batchIndex, selection) => {
      const batch = batches[batchIndex];
      this._liveSelections.set(batch.geometry, { selection, origin, order: batch.order, fresh: true });
      if (view) {
        this._updateSelectedLineBatch(view, batch.geometry, batch.halves, selection, projections);
      }
      if (this._visibleEntries.get(batch.tileId) === batch.entry && !this._hiddenPlacementTiles.has(batch.tileId)) {
        this._liveSelectionRevision++;
      }
    });
  }

  /**
   * Keep the completed candidates collision-safe in the current visible view.
   * @internal
   */
  private _filterVisibleSelection(view: PlacementView, projections: SymbolProjectionContext): void {
    if (this._appliedLiveSelectionRevision === this._liveSelectionRevision
      && this._liveSelectionPlanRevision === this._placementPlanRevision
      && samePlacementView(this._liveSelectionView, view)) {
      return;
    }
    const owners = new Set([...this._visibleEntries.keys()].filter(tileId => !this._hiddenPlacementTiles.has(tileId)));
    const batches = this._placementPlanFor('visible', view.cameraZoom, owners, this._visibleEntries);
    const selected = batches.flatMap((batch) => {
      const baseline = this._liveSelections.get(batch.geometry);
      return baseline ? [{ batch, baseline }] : [];
    });
    // A just-published complete pass already made these exact-view decisions.
    const origin = selected[0]?.baseline.origin;
    if (!selected.every(({ batch, baseline }) => baseline.fresh && baseline.origin === origin && baseline.order === batch.order
      && baseline.selection.matchesOptions(batch.options) && samePlacementView(baseline.selection.view, view))) {
      this._liveCollision.clear();
      for (const { batch, baseline } of selected) {
        if (baseline.selection.filter(view, this._liveCollision, batch.options, projections)) {
          for (const half of batch.halves) {
            this._syncOpacity(half);
          }
        }
        baseline.fresh = false;
      }
    }
    this._liveSelectionView = copyPlacementView(view);
    this._appliedLiveSelectionRevision = this._liveSelectionRevision;
    this._liveSelectionPlanRevision = this._placementPlanRevision;
  }

  /**
   * Update live line projection independently from collision placement. A
   * completed visibility generation remains drawable while a frozen-view
   * collision job advances under a cooperative clock budget. Camera movement
   * marks that job stale without throwing away its progress; a subsequent
   * layout catches up after MapLibre's placement-recency interval. Tile/style
   * content changes prepare the next ordered input without discarding
   * progress. Held coverage participates in the separate visible-owner scope.
   */
  update(
    view: PlacementView,
    viewChanged: boolean,
    context?: unknown,
    placementWork: SymbolPlacementWork = operation => operation(new MinimumProgressBudget(SymbolTileRenderer.PLACEMENT_BUDGET_MS)),
  ): void {
    const projections = new SymbolProjectionContext();
    this._shared.adopt(context as { [key: string]: unknown } | undefined);
    for (const material of this._materialRefs.keys()) {
      material.uniforms.u_camera_zoom = this.cameraZoom;
      material.uniforms.u_symbol_camera_distance = view.cameraToCenterDistance ?? 0;
      material.uniforms.u_symbol_orthographic = view.orthographic ? 1 : 0;
      material.uniforms.u_symbol_mercator_projection = view.mercatorProjection ? 1 : 0;
    }
    this._drainPendingAttributes();
    let placementInputsChanged = false;
    for (const entry of new Set([...this._tiles.values(), ...this._visibleEntries.values()])) {
      const previous = this._placementLayerInputs.get(entry);
      const evaluated = entry.input.layers.flatMap(layer => [
        !layer.isHidden(view.cameraZoom),
        layer.layout?.get('text-optional') === true,
        layer.layout?.get('icon-optional') === true,
      ]);
      placementInputsChanged ||= !previous || previous.length !== evaluated.length || evaluated.some((value, index) => value !== previous[index]);
      this._placementLayerInputs.set(entry, evaluated);
    }
    if (placementInputsChanged) {
      this._invalidatePlacementInputs();
    }
    if (this._fullReplaceNeeded || !samePlacementView(this._lineView, view)) {
      this._updateLineLabels(view, this._drawableLineEntries(), projections);
      this._lineView = copyPlacementView(view);
    }
    if (this._fullReplaceNeeded) {
      const owners = new Set([...this._tiles.keys()].filter(tileId => !this._excludedPlacementTiles.has(tileId)));
      this._targetPlacement.prepare(this._placementPlanFor('target', view.cameraZoom, owners));
      this._fullReplaceNeeded = false;
      this._visibleInputsDirty = true;
    }
    if (this._visibleInputsDirty) {
      const owners = new Set([...this._visibleEntries.keys()].filter(tileId => !this._hiddenPlacementTiles.has(tileId)));
      this._visiblePlacement.prepare(this._placementPlanFor('visible', view.cameraZoom, owners, this._visibleEntries));
      this._visibleInputsDirty = false;
    }
    if (this._prospectiveVisibleTiles) {
      this._handoffPlacement.prepare(this._placementPlanFor('prospective', view.cameraZoom, this._prospectiveVisibleTiles));
    }
    const separateVisibleScope = !this._visiblePlacement.matches(this._targetPlacement.batches);
    const separateHandoffScope = this._hasSeparateHandoffScope;
    const advancePlacement = (frameBudget: Budget): void => {
      const minimumProgress = frameBudget.takeMinimumProgress?.() ?? false;
      let target: ReturnType<SymbolPlacementScope<OrderedSymbolBatch>['advance']>;
      const scopes: Array<(minimum: boolean) => void> = [];
      if (separateVisibleScope) {
        scopes.push((minimum) => {
          const visible = this._visiblePlacement.advance(view, frameBudget, projections, viewChanged, minimum);
          if (visible && this._visiblePlacement.isCurrent(visible)
            && visible.batches.every(batch => this._visibleEntries.get(batch.tileId) === batch.entry && !this._hiddenPlacementTiles.has(batch.tileId))) {
            this._commitPlacement(visible.pass, visible.batches, () => true, projections, view);
          }
        });
      }
      if (separateHandoffScope) {
        scopes.push((minimum) => {
          // Prospective results stay unpublished until the scene owner switch.
          this._handoffPlacement.advance(view, frameBudget, projections, viewChanged, minimum);
        });
      }
      scopes.push((minimum) => {
        target = this._targetPlacement.advance(view, frameBudget, projections, viewChanged, minimum);
      });
      // One exhausted-budget pair per participant turn, rotating visible,
      // prospective and target scopes so an expensive scope cannot starve others.
      const first = this._placementScopeTurn % scopes.length;
      if (minimumProgress || !frameBudget.exhausted)
        this._placementScopeTurn++;
      for (let index = 0; index < scopes.length; index++) {
        scopes[(first + index) % scopes.length](minimumProgress && index === 0);
      }
      const currentBatches = new Map<SymbolTileEntry, Map<number, OrderedSymbolBatch>>();
      if (target) {
        for (const batch of this._targetPlacement.batches) {
          let indexes = currentBatches.get(batch.entry);
          if (!indexes) {
            indexes = new Map();
            currentBatches.set(batch.entry, indexes);
          }
          indexes.set(batch.index, batch);
        }
      }
      if (target && target.batches.every((batch) => {
        const current = currentBatches.get(batch.entry)?.get(batch.index);
        return this._tiles.get(batch.tileId) === batch.entry && !!current && sameSymbolBatch(batch, current);
      })) {
        this._commitPlacement(target.pass, target.batches, index =>
          !separateVisibleScope || this._hiddenPlacementTiles.has(target.batches[index].tileId)
          || this._visibleEntries.get(target.batches[index].tileId) !== target.batches[index].entry, projections, view);
        for (const batch of target.batches) {
          batch.entry.placed = true;
        }
        if (!separateVisibleScope && this._targetPlacement.isCurrent(target)) {
          this._visiblePlacement.activate(target, view);
        }
        if (this._targetPlacement.isCurrent(target)) {
          for (const [tileId, entry] of this._tiles) {
            if (!this._excludedPlacementTiles.has(tileId) && !currentBatches.has(entry)) {
              entry.placed = true;
            }
          }
        }
      }
    };
    this._filterVisibleSelection(view, projections);
    placementWork(advancePlacement);
    this._filterVisibleSelection(view, projections);
  }

  /** Completion includes recency waits and writes awaiting their Native VBO. */
  get hasPendingWork(): boolean {
    return this._pendingDynamicHalves.size > 0 || this._pendingOpacityHalves.size > 0
      || this._targetPlacement.pending || this._visiblePlacement.pending
      || (this._hasSeparateHandoffScope && this._handoffPlacement.pending)
      || this.hasRunnableWork;
  }

  /**
   * @internal
   */
  private get _hasSeparateHandoffScope(): boolean {
    return this._prospectiveVisibleTiles !== undefined
      && !this._targetPlacement.matches(this._handoffPlacement.batches)
      && !this._visiblePlacement.matches(this._handoffPlacement.batches);
  }

  /** Observe stopped zoom between demand renders without projecting symbols. */
  observeIdlePlacement(): boolean {
    let changed = this._targetPlacement.observeIdle();
    changed = this._visiblePlacement.observeIdle() || changed;
    if (this._hasSeparateHandoffScope)
      changed = this._handoffPlacement.observeIdle() || changed;
    return changed;
  }

  /** Recency-only work needs one deadline wake instead of continuous draws. */
  get nextPlacementTime(): number | undefined {
    const time = Math.min(
      this._targetPlacement.nextPlacementTime ?? Number.POSITIVE_INFINITY,
      this._visiblePlacement.nextPlacementTime ?? Number.POSITIVE_INFINITY,
      (this._hasSeparateHandoffScope ? this._handoffPlacement.nextPlacementTime : undefined) ?? Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(time) ? time : undefined;
  }

  /** Recency and Native-only waits do not continue request-render frames. */
  get hasRunnableWork(): boolean {
    if (this._targetPlacement.runnable || this._visiblePlacement.runnable
      || (this._hasSeparateHandoffScope && this._handoffPlacement.runnable) || this._visibleInputsDirty
      || (this._fullReplaceNeeded && this._tiles.size > 0)
      || this._pendingImageEntries.size > 0) {
      return true;
    }
    for (const half of this._pendingOpacityHalves) {
      const primitive = half.opacity?.target?.primitive;
      if (primitive && (primitive as Primitive & { _va: unknown[] })._va?.length > 0)
        return true;
    }
    for (const half of this._pendingDynamicHalves) {
      const primitive = half.dynamic?.target?.primitive;
      if (primitive && (primitive as Primitive & { _va: unknown[] })._va?.length > 0)
        return true;
    }
    return false;
  }

  removeTile(tileId: string): PrimitiveCollection[] {
    this._excludedPlacementTiles.delete(tileId);
    this._hiddenPlacementTiles.delete(tileId);
    this._visibleEntries.delete(tileId);
    const entry = this._tiles.get(tileId);
    if (entry) {
      for (const half of entry.halves) {
        this._pendingDynamicHalves.delete(half);
        this._pendingOpacityHalves.delete(half);
      }
    }
    // A fading tile dropped by direct removal never reaches the pool: it
    // releases like a live entry and its collections go out for destruction.
    const fading = this._takeFading(tileId);
    const retired = this._retired.take(tileId);
    // A retired tile dropped by direct removal releases like an eviction.
    const evicted = retired ? this._evictRetired(retired) : [];
    const gone = [...evicted];
    if (fading) {
      this._releaseEntry(fading.entry);
      gone.push(...liveCollectionsOf(fading.entry));
    }
    if (!entry) {
      return gone;
    }
    this._releaseEntry(entry);
    this._tiles.delete(tileId);
    this._invalidatePlacementInputs();
    return [...entry.collections.filter((collection): collection is PrimitiveCollection => !!collection), ...gone];
  }

  /**
   * Tile fade-out duration, mirroring MapLibre's symbol hold
   * (`map._fadeDuration`, surfaced as `Style.fadeDuration`): a tile leaving
   * the view keeps its symbols ramping out instead of vanishing.
   */
  static readonly SYMBOL_FADE_MS = 300;

  /**
   * Tiles fading out: retired from placement but still attached, ticking
   * their per-instance fade attribute to zero before landing in the pool.
   */
  private _fading = new Map<string, FadingSymbolEntry>();

  /**
   * @internal
   */
  private _takeFading(tileId: string): FadingSymbolEntry | undefined {
    const fading = this._fading.get(tileId);
    if (fading) {
      this._fading.delete(tileId);
    }
    return fading;
  }

  /**
   * Resolve the fade write targets of an entry, or undefined when the entry
   * never rendered (no batch table yet, so nothing visible to fade and
   * `getGeometryInstanceAttributes` would throw).
   * @internal
   */
  private _fadeTargets(entry: SymbolTileEntry): Array<{ set: (value: number) => void }> | undefined {
    const targets: Array<{ set: (value: number) => void }> = [];
    for (const { primitive, instanceIds } of entry.primitives ?? []) {
      const addressable = primitive as unknown as {
        ready?: boolean;
        getGeometryInstanceAttributes?: (id: unknown) => Record<string, unknown> | undefined;
      };
      if (!addressable.ready || typeof addressable.getGeometryInstanceAttributes !== 'function') {
        return undefined;
      }
      for (const id of instanceIds) {
        const attributes = addressable.getGeometryInstanceAttributes(id) as Record<string, unknown> | undefined;
        if (!attributes) {
          return undefined;
        }
        targets.push({
          // Cesium's instance setter takes an array (length 1-4), not a
          // scalar: a bare number falls through getAttributeValue and throws
          // inside setBatchedAttribute on every tick.
          set: (value: number) => {
            attributes[SYMBOL_FADE_ATTRIBUTE] = [value];
          },
        });
      }
    }
    return targets;
  }

  /**
   * Insert an entry into the retired pool, evicting the oldest past the cap.
   * @internal
   */
  private _poolEntry(tileId: string, entry: SymbolTileEntry): PrimitiveCollection[] {
    this._pendingImageEntries.delete(entry);
    return this._retired.retire(tileId, entry).flatMap(gone => this._evictRetired(gone.value));
  }

  /**
   * Rescale the retired pool from the renderable footprint (see
   * retiredPoolCapacity); shrinking past the new capacity evicts
   * oldest-first for destruction.
   */
  setRetiredCapacity(capacity: number): PrimitiveCollection[] {
    return this._retired.setCapacity(capacity).flatMap(gone => this._evictRetired(gone.value));
  }

  /**
   * Maximum retired (out-of-view, GPU-resident) tiles, mirroring
   * VectorTileRenderer.MAX_RETIRED_TILES. Retired entries keep their collections
   * (hidden, out of the scene: zero per-frame tax), batches (for placement),
   * materials and atlas holds, so a pan-back restores without rebuilding.
   * The default capacity; the tileset rescales it from the renderable
   * footprint (see setRetiredCapacity).
   */
  static readonly MAX_RETIRED_TILES = 64;

  private _retired = new RetiredPool<SymbolTileEntry>(SymbolTileRenderer.MAX_RETIRED_TILES);

  /**
   * Cache a live tile out of the scene for a cheap pan-back restore.
   * A rendered tile fades out in place instead (MapLibre's symbol hold):
   * its collections stay attached while the fade ticks, then land in the
   * pool; an entry that never rendered retires instantly. Returns the
   * retired collections (hidden, kept alive), the still-fading ones (left
   * attached, shown) and LRU-evicted ones (for destruction); the retired
   * and fading entries keep their refs.
   */
  retireTile(tileId: string, fadeMs: number = SymbolTileRenderer.SYMBOL_FADE_MS): SymbolTileRetire {
    this._excludedPlacementTiles.delete(tileId);
    this._hiddenPlacementTiles.delete(tileId);
    this._visibleEntries.delete(tileId);
    const entry = this._tiles.get(tileId);
    if (!entry) {
      // No live entry: a leftover retired entry is gone for good - release
      // it like an eviction instead of leaking its refs.
      const retired = this._retired.take(tileId);
      return { retired: [], fading: [], evicted: retired ? this._evictRetired(retired) : [] };
    }
    for (const half of entry.halves) {
      this._pendingDynamicHalves.delete(half);
      this._pendingOpacityHalves.delete(half);
    }
    this._tiles.delete(tileId);
    this._invalidatePlacementInputs();
    const targets = fadeMs > 0 ? this._fadeTargets(entry) : undefined;
    if (targets && targets.length > 0) {
      this._fading.set(tileId, { entry, startedMs: performance.now(), durationMs: fadeMs, targets });
      return { retired: [], fading: liveCollectionsOf(entry), evicted: [] };
    }
    // A replaced same-key entry is gone for good: release it like an
    // eviction instead of leaking its refs (a tile rebuilt while retired
    // re-retires under the same key).
    const evicted = this._retired.retire(tileId, entry).flatMap(gone => this._evictRetired(gone.value));
    this._pendingImageEntries.delete(entry);
    return { retired: liveCollectionsOf(entry), fading: [], evicted };
  }

  /**
   * Tick fading tiles: ramp their fade attributes toward zero, pool the
   * finished ones. Runs every frame from the tileset next to placement; usually
   * empty (one map lookup). Returns the completed collections for tileset
   * detach (hide + remove, pooled inside) alongside pool-overflow evictions
   * (for destruction), plus whether any fade is still in flight (the tileset
   * keeps frames coming while true, like the raster crossfade).
   */
  tickFades(nowMs: number): { detach: PrimitiveCollection[]; destroy: PrimitiveCollection[]; active: boolean } {
    const detach: PrimitiveCollection[] = [];
    const destroy: PrimitiveCollection[] = [];
    for (const [tileId, fading] of [...this._fading]) {
      const elapsed = nowMs - fading.startedMs;
      if (elapsed >= fading.durationMs) {
        for (const target of fading.targets) {
          target.set(0);
        }
        this._fading.delete(tileId);
        destroy.push(...this._poolEntry(tileId, fading.entry));
        detach.push(...liveCollectionsOf(fading.entry));
      }
      else {
        const value = 1 - elapsed / fading.durationMs;
        for (const target of fading.targets) {
          target.set(value);
        }
      }
    }
    return { detach, destroy, active: this._fading.size > 0 };
  }

  /**
   * Cancel a fade: the tile is visible again, so its entry goes live with
   * full opacity (placement re-walks it like a pool restore). The
   * collections never left the scene, so the tileset re-attaches nothing.
   * Buckets identity gates staleness exactly like the pool restore: a stale
   * fading entry must not go live, its collections go out for destruction
   * and undefined-equivalent (live: false) tells the tileset to rebuild.
   */
  cancelFade(tileId: string, buckets?: Record<string, Bucket>): SymbolFadeCancel | undefined {
    const fading = this._takeFading(tileId);
    if (!fading) {
      return undefined;
    }
    const { entry } = fading;
    if (buckets && entry.input.buckets !== buckets) {
      this._releaseEntry(entry);
      return { collections: liveCollectionsOf(entry), live: false };
    }
    for (const target of fading.targets) {
      target.set(1);
    }
    entry.placed = false;
    this._tiles.set(tileId, entry);
    this._visibleEntries.set(tileId, entry);
    if (entry.input.iconAtlas) {
      this._pendingImageEntries.add(entry);
    }
    this._invalidatePlacementInputs();
    return { collections: liveCollectionsOf(entry), live: true };
  }

  /** Inspect retired data without moving it into the live renderer. */
  canRestoreTile(tileId: string, buckets: Record<string, Bucket>): boolean {
    return this._retired.get(tileId)?.input.buckets === buckets;
  }

  /** Reattach a retired tile and make placement include it again. */
  restoreTile(tileId: string, buckets?: Record<string, Bucket>): PrimitiveCollection[] | undefined {
    const entry = this._retired.take(tileId);
    if (!entry) {
      return undefined;
    }
    if (buckets && entry.input.buckets !== buckets) {
      this._releaseEntry(entry);
      for (const collection of entry.collections) {
        if (!collection.isDestroyed()) {
          collection.destroy();
        }
      }
      return undefined;
    }
    for (const target of this._fadeTargets(entry) ?? []) {
      target.set(1);
    }
    entry.placed = false;
    this._tiles.set(tileId, entry);
    this._visibleEntries.set(tileId, entry);
    if (entry.input.iconAtlas) {
      this._pendingImageEntries.add(entry);
    }
    this._invalidatePlacementInputs();
    return entry.collections;
  }

  /**
   * Release a retired entry and return its collections for destruction.
   * @internal
   */
  private _evictRetired(entry: SymbolTileEntry): PrimitiveCollection[] {
    this._releaseEntry(entry);
    return entry.collections;
  }

  /** Drop retired entries (style change invalidates pooled paints). */
  clearRetired(): PrimitiveCollection[] {
    const evicted: PrimitiveCollection[] = [];
    for (const entry of this._retired.values()) {
      this._releaseEntry(entry);
      evicted.push(...entry.collections);
    }
    this._retired.clear();
    // Fading entries hold refs like retired ones; a style change must not
    // let them complete into the (just cleared) pool as stale entries.
    for (const fading of this._fading.values()) {
      this._releaseEntry(fading.entry);
      evicted.push(...fading.entry.collections);
    }
    this._fading.clear();
    return evicted;
  }

  removeAll(): PrimitiveCollection[] {
    const all = [...this._tiles.values()].flatMap(entry => entry.collections.filter((collection): collection is PrimitiveCollection => !!collection));
    this._tiles.clear();
    this._visibleEntries.clear();
    this._excludedPlacementTiles.clear();
    this._lineView = undefined;
    this._liveSelectionView = undefined;
    this._liveSelections = new WeakMap();
    this._liveCollision.clear();
    this._hiddenPlacementTiles.clear();
    this._targetPlacement.clear();
    this._visiblePlacement.clear();
    this._handoffPlacement.clear();
    this._visibleInputsDirty = false;
    this._prospectiveVisibleTiles = undefined;
    this._placementLayerInputs = new WeakMap();
    this._placementPlans.clear();
    this._placementEntryIndexes = new WeakMap();
    this._held.clear();
    for (const fading of this._fading.values()) {
      all.push(...fading.entry.collections);
    }
    this._fading.clear();
    for (const entry of this._retired.values()) {
      this._releaseEntry(entry);
      all.push(...entry.collections);
    }
    this._retired.clear();
    this._pendingDynamicHalves.clear();
    this._pendingOpacityHalves.clear();
    this._pendingImageEntries.clear();
    this._invalidatePlacementInputs();
    this._destroyAllMaterials();
    return all;
  }
}
