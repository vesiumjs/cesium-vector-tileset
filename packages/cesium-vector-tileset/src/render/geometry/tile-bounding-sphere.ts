import type { Rectangle } from 'cesium';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { BoundingSphere, Cartesian3, Ellipsoid, WebMercatorTilingScheme } from 'cesium';

type TileID = CanonicalTileID | OverscaledTileID;

const tilingScheme = new WebMercatorTilingScheme({ ellipsoid: Ellipsoid.WGS84 });

/** Canonical Mercator tile footprint, shared by ECEF and projected bounds. */
export function tileRectangle(tileID: TileID): Rectangle {
  // ECEF positions are wrap-invariant (tileLocalToMercatorFraction shifts
  // longitude by whole world widths, which sin/cos fold away), so the
  // canonical rectangle contains every world copy by construction.
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  return tilingScheme.tileXYToRectangle(canonical.x, canonical.y, canonical.z);
}

/**
 * Bounding sphere for a tile rectangle on the WGS84 ellipsoid surface.
 *
 * Passing this as the Buffer*Collection `boundingVolume` constructor option
 * disables Cesium's per-update `BoundingSphere.fromVertices` scan over every
 * vertex (see `_updateBoundingVolume`). This bounds the canonical rectangle
 * on the ellipsoid, rather than arbitrary content or screen-space expansion.
 *
 * The 0.1% + 1m padding provides a small numerical margin. Callers must
 * separately account for heights, buffered geometry and pixel-sized symbols.
 */
export function tileBoundingSphere(tileID: TileID): BoundingSphere {
  const sphere = BoundingSphere.fromRectangle3D(tileRectangle(tileID), Ellipsoid.WGS84, 0);
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  // Globe tile meshes include their polar cap. Keep tileRectangle finite
  // because projected CV bounds use its Mercator footprint independently.
  if (canonical.y === 0)
    BoundingSphere.expand(sphere, new Cartesian3(0, 0, Ellipsoid.WGS84.radii.z), sphere);
  if (canonical.y === 2 ** canonical.z - 1)
    BoundingSphere.expand(sphere, new Cartesian3(0, 0, -Ellipsoid.WGS84.radii.z), sphere);
  sphere.radius = sphere.radius * 1.001 + 1;
  return sphere;
}
