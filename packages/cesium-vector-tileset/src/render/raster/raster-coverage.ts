import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { RasterTextureSource } from './raster-textures';
import { Cartesian2, PixelFormat } from 'cesium';

type TileID = CanonicalTileID | OverscaledTileID;

/** Parent UV subrect in Native's bottom-up texture coordinates. */
export function rasterParentTransform(child: TileID, parent: TileID): { scale: number; offset: Cartesian2 } | undefined {
  const c = 'canonical' in child ? child.canonical : child;
  const p = 'canonical' in parent ? parent.canonical : parent;
  if (('wrap' in child ? child.wrap : 0) !== ('wrap' in parent ? parent.wrap : 0) || c.z <= p.z)
    return undefined;
  const scale = 2 ** (p.z - c.z);
  const x = c.x * scale - p.x;
  const y = c.y * scale - p.y;
  if (x < 0 || y < 0 || x + scale > 1 || y + scale > 1)
    return undefined;
  return { scale, offset: new Cartesian2(x, 1 - y - scale) };
}

/** Exact dyadic footprints of scene-ready fading bases; independent of image alpha. */
export class RasterCoverage {
  source?: Extract<RasterTextureSource, { type: 'bytes' }>;
  private _key = '';

  update(parent: TileID, children: readonly TileID[]): boolean {
    const key = `${parent.key}:${children.map(child => child.key).sort().join(',')}`;
    if (key === this._key)
      return false;
    this._key = key;
    if (children.length === 0) {
      this.source = undefined;
      return true;
    }
    const transforms = children.map(child => rasterParentTransform(child, parent));
    if (transforms.some(transform => !transform))
      throw new Error('Raster coverage requires descendant tiles in the same world copy');
    const size = Math.max(...transforms.map(transform => 1 / transform!.scale));
    const data = new Uint8Array(size * size);
    for (const transform of transforms) {
      // Typed-image uploads flip rows like decoded images. Store top-down
      // rows so texelFetch using Native bottom-up ST reaches the same cell.
      const x = transform!.offset.x * size;
      const y = (1 - transform!.offset.y - transform!.scale) * size;
      const length = transform!.scale * size;
      for (let row = y; row < y + length; row++)
        data.fill(255, row * size + x, row * size + x + length);
    }
    this.source = { type: 'bytes', data, width: size, height: size, pixelFormat: PixelFormat.RED };
    return true;
  }
}
