import type { Cartesian2, Ellipsoid } from 'cesium';
import { SceneMode } from 'cesium';

/** MapLibre ground pixels use live style zoom, independently of source LOD. */
export function mercatorTranslation(pixels: Cartesian2, viewport: boolean, zoom: number, bearing: number | undefined, result: Cartesian2): void {
  if (viewport && bearing === undefined)
    return;
  const angle = viewport ? bearing! : 0;
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const scale = 1 / (512 * 2 ** zoom);
  result.x = (pixels.x * cosine - pixels.y * sine) * scale;
  result.y = (pixels.x * sine + pixels.y * cosine) * scale;
}

/** Inverse Mercator has angular derivative <= 1; bounds cover every anchor. */
export function mercatorTranslationPadding(translate: Cartesian2, ellipsoid: Ellipsoid, mode: SceneMode, height = 0): number {
  const angle = 2 * Math.PI * Math.hypot(translate.x, translate.y);
  const planar = ellipsoid.maximumRadius * angle;
  if (mode === SceneMode.SCENE2D || mode === SceneMode.COLUMBUS_VIEW)
    return planar;
  const radius = ellipsoid.maximumRadius + height;
  const globe = Math.min(2 * radius, radius * angle * (ellipsoid.maximumRadius / ellipsoid.minimumRadius) ** 2);
  return mode === SceneMode.MORPHING ? Math.max(planar, globe) : globe;
}

/** Difference identities retain offsets smaller than float32 ECEF spacing. */
export const MERCATOR_TRANSLATION_SHADER = `
vec3 cvt_ellipsoidDelta(vec3 normal, vec3 deltaNormal, float height) {
    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 oldK = radiiSquared * normal;
    float oldDenominator = sqrt(dot(normal, oldK));
    vec3 newNormal = normal + deltaNormal;
    float newDenominator = sqrt(dot(newNormal, radiiSquared * newNormal));
    float difference = 2.0 * dot(normal, radiiSquared * deltaNormal)
        + dot(deltaNormal, radiiSquared * deltaNormal);
    float reciprocalDifference = -difference
        / (oldDenominator * newDenominator * (oldDenominator + newDenominator));
    return radiiSquared * deltaNormal / newDenominator + oldK * reciprocalDifference + height * deltaNormal;
}
// Small-angle GPU sine approximations can introduce metre-scale ECEF errors.
float cvt_sin(float angle) {
    float square = angle * angle;
    return abs(angle) < 0.01 ? angle * (1.0 - square * (1.0 / 6.0 - square / 120.0))
        : sin(angle);
}
float cvt_sinh(float angle) {
    float square = angle * angle;
    return abs(angle) < 0.01 ? angle * (1.0 + square * (1.0 / 6.0 + square / 120.0))
        : (exp(angle) - exp(-angle)) * 0.5;
}
vec3 cvt_mercatorDelta(inout vec3 normal, vec2 translate, float height, bool mercator, out vec3 deltaWorld) {
    vec2 angle = translate * czm_twoPi;
    float sinhY = cvt_sinh(angle.y);
    float sinhHalfY = cvt_sinh(angle.y * 0.5);
    float coshMinusOne = 2.0 * sinhHalfY * sinhHalfY;
    float denominator = 1.0 + coshMinusOne - normal.z * sinhY;
    float sinHalfX = cvt_sin(angle.x * 0.5);
    float radialDifference = normal.z * sinhY - coshMinusOne;
    vec3 deltaNormal = vec3(
        (normal.xy * (radialDifference - 2.0 * sinHalfX * sinHalfX)
            + vec2(-normal.y, normal.x) * cvt_sin(angle.x)) / denominator,
        -dot(normal.xy, normal.xy) * sinhY / denominator);
    deltaWorld = cvt_ellipsoidDelta(normal, deltaNormal, height);
    float cosLatitude = length(normal.xy);
    float deltaCosLatitude = cosLatitude * radialDifference / denominator;
    float deltaLatitude = atan(deltaNormal.z * cosLatitude - deltaCosLatitude * normal.z,
        dot(normal.xy, normal.xy) + normal.z * normal.z
            + cosLatitude * deltaCosLatitude + normal.z * deltaNormal.z);
    vec3 delta2D = vec3(0.0, angle.x, mercator ? -angle.y : deltaLatitude) * czm_ellipsoidRadii.x;
    normal += deltaNormal;
    return mix(delta2D, deltaWorld, czm_morphTime);
}
`;
