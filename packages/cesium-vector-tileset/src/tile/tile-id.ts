import type { ICanonicalTileID, IMercatorCoordinate } from '@maplibre/maplibre-gl-style-spec';
import type { TransferRegistry } from '../worker/transfer-registry';
import Point from '@mapbox/point-geometry';
import { EXTENT } from '../data/extent';
import { isInBoundsForTileZoomXY, MAX_TILE_ZOOM, MIN_TILE_ZOOM } from '../geo/world-bounds';

/**
 * A canonical way to define a tile ID
 */
export class CanonicalTileID implements ICanonicalTileID {
  z: number;
  x: number;
  y: number;
  key: string;

  constructor(z: number, x: number, y: number) {
    if (!isInBoundsForTileZoomXY(z, x, y)) {
      throw new Error(`x=${x}, y=${y}, z=${z} outside of bounds. 0<=x<${2 ** z}, 0<=y<${2 ** z} ${MIN_TILE_ZOOM}<=z<=${MAX_TILE_ZOOM} `);
    }

    this.z = z;
    this.x = x;
    this.y = y;
    this.key = calculateTileKey(0, z, z, x, y);
  }

  equals(id: ICanonicalTileID): boolean {
    return this.z === id.z && this.x === id.x && this.y === id.y;
  }

  /**
   * given a list of urls, choose a url template and return a tile URL
   */
  url(urls: string[], pixelRatio: number, scheme?: string | null): string {
    const bbox = getTileBBox(this.x, this.y, this.z);
    const quadkey = getQuadkey(this.z, this.x, this.y);

    return urls[(this.x + this.y) % urls.length]
      .replace(/\{prefix\}/g, (this.x % 16).toString(16) + (this.y % 16).toString(16))
      .replace(/\{z\}/g, String(this.z))
      .replace(/\{x\}/g, String(this.x))
      .replace(/\{y\}/g, String(scheme === 'tms' ? (2 ** this.z - this.y - 1) : this.y))
      .replace(/\{ratio\}/g, pixelRatio > 1 ? '@2x' : '')
      .replace(/\{quadkey\}/g, quadkey)
      .replace(/\{bbox-epsg-3857\}/g, bbox);
  }

  isChildOf(parent: ICanonicalTileID): boolean {
    const dz = this.z - parent.z;
    return dz > 0 && parent.x === (this.x >> dz) && parent.y === (this.y >> dz);
  }

  getTilePoint(coord: Pick<IMercatorCoordinate, 'x' | 'y'>): Point {
    const tilesAtZoom = 2 ** this.z;
    return new Point(
      (coord.x * tilesAtZoom - this.x) * EXTENT,
      (coord.y * tilesAtZoom - this.y) * EXTENT,
    );
  }

  toString(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

/**
 * An overscaled tile identifier
 */
export class OverscaledTileID {
  overscaledZ: number;
  wrap: number;
  canonical: CanonicalTileID;
  key: string;
  /**
   * This matrix is used during terrain's render-to-texture stage only.
   * If the render-to-texture stage is active, this matrix will be present
   * and should be used, otherwise this matrix will be null.
   * The matrix should be float32 in order to avoid slow WebGL calls in Chrome.
   */

  constructor(overscaledZ: number, wrap: number, z: number, x: number, y: number) {
    if (overscaledZ < z)
      throw new Error(`overscaledZ should be >= z; overscaledZ = ${overscaledZ}; z = ${z}`);
    this.overscaledZ = overscaledZ;
    this.wrap = wrap;
    this.canonical = new CanonicalTileID(z, +x, +y);
    this.key = calculateTileKey(wrap, overscaledZ, z, x, y);
  }

  equals(id: OverscaledTileID): boolean {
    return this.overscaledZ === id.overscaledZ && this.wrap === id.wrap && this.canonical.equals(id.canonical);
  }

  /**
   * Returns a new `OverscaledTileID` representing the tile at the target zoom level.
   * When targetZ is greater than the current canonical z, the canonical coordinates are unchanged.
   * When targetZ is less than the current canonical z, the canonical coordinates are updated.
   * @param targetZ - the zoom level to scale to. Must be less than or equal to this.overscaledZ
   * @returns a new OverscaledTileID representing the tile at the target zoom level
   * @throws if targetZ is greater than this.overscaledZ
   */
  scaledTo(targetZ: number): OverscaledTileID {
    if (targetZ > this.overscaledZ)
      throw new Error(`targetZ > this.overscaledZ; targetZ = ${targetZ}; overscaledZ = ${this.overscaledZ}`);
    const zDifference = this.canonical.z - targetZ;
    if (targetZ > this.canonical.z) {
      return new OverscaledTileID(targetZ, this.wrap, this.canonical.z, this.canonical.x, this.canonical.y);
    }
    else {
      return new OverscaledTileID(targetZ, this.wrap, targetZ, this.canonical.x >> zDifference, this.canonical.y >> zDifference);
    }
  }

  /*
     * calculateScaledKey is an optimization:
     * when withWrap == true, implements the same as this.scaledTo(z).key,
     * when withWrap == false, implements the same as this.scaledTo(z).wrapped().key.
     */
  calculateScaledKey(targetZ: number, withWrap: boolean): string {
    if (targetZ > this.overscaledZ)
      throw new Error(`targetZ > this.overscaledZ; targetZ = ${targetZ}; overscaledZ = ${this.overscaledZ}`);
    const zDifference = this.canonical.z - targetZ;
    if (targetZ > this.canonical.z) {
      return calculateTileKey(this.wrap * +withWrap, targetZ, this.canonical.z, this.canonical.x, this.canonical.y);
    }
    else {
      return calculateTileKey(this.wrap * +withWrap, targetZ, targetZ, this.canonical.x >> zDifference, this.canonical.y >> zDifference);
    }
  }

  isChildOf(parent: OverscaledTileID): boolean {
    if (parent.wrap !== this.wrap)
      return false; // different world copy

    const zDifference = this.overscaledZ - parent.overscaledZ;
    if (zDifference <= 0)
      return false; // must be deeper zoom

    // special case for root tile (bitwise math doesn't work for root)
    if (parent.overscaledZ === 0)
      return this.overscaledZ > 0;

    const dz = this.canonical.z - parent.canonical.z;
    if (dz < 0)
      return false; // parent can't be deeper canonically

    return (
      parent.canonical.x === (this.canonical.x >> dz)
      && parent.canonical.y === (this.canonical.y >> dz)
    );
  }

  children(sourceMaxZoom: number): OverscaledTileID[] {
    if (this.overscaledZ >= sourceMaxZoom) {
      // return a single tile coord representing a an overscaled tile
      return [new OverscaledTileID(this.overscaledZ + 1, this.wrap, this.canonical.z, this.canonical.x, this.canonical.y)];
    }

    const z = this.canonical.z + 1;
    const x = this.canonical.x * 2;
    const y = this.canonical.y * 2;
    return [
      new OverscaledTileID(z, this.wrap, z, x, y),
      new OverscaledTileID(z, this.wrap, z, x + 1, y),
      new OverscaledTileID(z, this.wrap, z, x, y + 1),
      new OverscaledTileID(z, this.wrap, z, x + 1, y + 1),
    ];
  }

  wrapped(): OverscaledTileID {
    return new OverscaledTileID(this.overscaledZ, 0, this.canonical.z, this.canonical.x, this.canonical.y);
  }

  unwrapTo(wrap: number): OverscaledTileID {
    return new OverscaledTileID(this.overscaledZ, wrap, this.canonical.z, this.canonical.x, this.canonical.y);
  }

  overscaleFactor(): number {
    return 2 ** (this.overscaledZ - this.canonical.z);
  }

  toString(): string {
    return `${this.overscaledZ}/${this.canonical.x}/${this.canonical.y}`;
  }
}

export function calculateTileKey(wrap: number, overscaledZ: number, z: number, x: number, y: number): string {
  wrap *= 2;
  if (wrap < 0)
    wrap = wrap * -1 - 1;
  const dim = 1 << z;
  return (dim * dim * wrap + dim * y + x).toString(36) + z.toString(36) + overscaledZ.toString(36);
}

/** WGS84 spherical radius used by EPSG:3857, distinct from the mean earth radius MercatorCoordinate is built on. */
const EPSG3857_RADIUS = 6378137;
const EPSG3857_HALF_CIRCUMFERENCE = Math.PI * EPSG3857_RADIUS;

/**
 * Builds the `{bbox-epsg-3857}` token used in WMS tile URLs: the tile's bounding
 * box in EPSG:3857 meters as a `minX,minY,maxX,maxY` string.
 * XYZ tile edges divide the projected world uniformly, with Y increasing south.
 */
function getTileBBox(x: number, y: number, z: number): string {
  const span = 2 * EPSG3857_HALF_CIRCUMFERENCE / 2 ** z;
  const west = x * span - EPSG3857_HALF_CIRCUMFERENCE;
  const east = (x + 1) * span - EPSG3857_HALF_CIRCUMFERENCE;
  const north = EPSG3857_HALF_CIRCUMFERENCE - y * span;
  const south = EPSG3857_HALF_CIRCUMFERENCE - (y + 1) * span;
  return `${west},${south},${east},${north}`;
}

function getQuadkey(z: number, x: number, y: number): string {
  let quadkey = '';
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    quadkey += ((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return quadkey;
}

export function compareTileId(a: OverscaledTileID, b: OverscaledTileID): number {
  // Different copies of the world are sorted based on their distance to the center.
  // Wrap values are converted to unsigned distances by reserving odd number for copies
  // with negative wrap and even numbers for copies with positive wrap.
  const aWrap = Math.abs(a.wrap * 2) - +(a.wrap < 0);
  const bWrap = Math.abs(b.wrap * 2) - +(b.wrap < 0);
  return a.overscaledZ - b.overscaledZ || bWrap - aWrap || b.canonical.y - a.canonical.y || b.canonical.x - a.canonical.x;
}

export function registerTileIdTransfers(registry: TransferRegistry): void {
  registry.register('CanonicalTileID', CanonicalTileID);
  registry.register('OverscaledTileID', OverscaledTileID);
}
