import type { vec3 } from 'gl-matrix';

/**
 * Given a value `t` that varies between 0 and 1, return
 * an interpolation function that eases between 0 and 1 in a pleasing
 * cubic in-out fashion.
 */
export function easeCubicInOut(t: number): number {
  if (t <= 0)
    return 0;
  if (t >= 1)
    return 1;
  const t2 = t * t;
  const t3 = t2 * t;
  return 4 * (t < 0.5 ? t3 : 3 * (t - t2) + t3 - 0.75);
}

/**
 * constrain n to the given range via min + max
 *
 * @param n - value
 * @param min - the minimum value to be returned
 * @param max - the maximum value to be returned
 * @returns the clamped value
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * constrain n to the given range, excluding the minimum, via modular arithmetic
 *
 * @param n - value
 * @param min - the minimum value to be returned, exclusive
 * @param max - the maximum value to be returned, inclusive
 * @returns constrained number
 */
export function wrap(n: number, min: number, max: number): number {
  const d = max - min;
  const w = ((n - min) % d + d) % d + min;
  return (w === min) ? max : w;
}

/**
 * Converts spherical coordinates to cartesian coordinates.
 *
 * @param spherical - Spherical coordinates, in [radial, azimuthal, polar]
 * @param spherical."0" - The radial distance.
 * @param spherical."1" - The azimuthal angle.
 * @param spherical."2" - The polar angle.
 * @returns cartesian coordinates in [x, y, z]
 */
export function sphericalToCartesian([r, azimuthal, polar]: [number, number, number]): vec3 {
  // We abstract "north"/"up" (compass-wise) to be 0° when really this is 90° (π/2):
  // correct for that here
  azimuthal += 90;

  // Convert azimuthal and polar angles to radians
  azimuthal *= Math.PI / 180;
  polar *= Math.PI / 180;

  return [
    r * Math.cos(azimuthal) * Math.sin(polar),
    r * Math.sin(azimuthal) * Math.sin(polar),
    r * Math.cos(polar),
  ];
}
