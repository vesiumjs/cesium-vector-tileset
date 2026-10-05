import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { BoundingSphere, Ellipsoid, Rectangle } from 'cesium';
import { latFromMercatorY, lngFromMercatorX } from '../../geo/mercator-coordinate';

type TileID = CanonicalTileID | OverscaledTileID;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Bounding sphere for a tile rectangle on the WGS84 ellipsoid surface.
 *
 * Passing this as the Buffer*Collection `boundingVolume` constructor option
 * disables Cesium's per-update `BoundingSphere.fromVertices` scan over every
 * vertex (see `_updateBoundingVolume`). Tile geometry always sits on the
 * ellipsoid surface inside its own rectangle (circle radii and baked offsets
 * included), so the rectangle sphere contains it by construction.
 *
 * The 0.1% + 1m padding covers float error and screen-space line widths,
 * which are negligible in world units but must never cause edge pop-out.
 */
export function tileBoundingSphere(tileID: TileID): BoundingSphere {
  // ECEF positions are wrap-invariant (tileLocalToMercatorFraction shifts
  // longitude by whole world widths, which sin/cos fold away), so the
  // canonical rectangle contains every world copy by construction.
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const worldSize = 2 ** canonical.z;
  const west = (lngFromMercatorX(canonical.x / worldSize)) * DEG_TO_RAD;
  const east = (lngFromMercatorX((canonical.x + 1) / worldSize)) * DEG_TO_RAD;
  const north = (latFromMercatorY(canonical.y / worldSize)) * DEG_TO_RAD;
  const south = (latFromMercatorY((canonical.y + 1) / worldSize)) * DEG_TO_RAD;
  const sphere = BoundingSphere.fromRectangle3D(
    Rectangle.fromRadians(west, south, east, north),
    Ellipsoid.WGS84,
    0,
  );
  sphere.radius = sphere.radius * 1.001 + 1;
  return sphere;
}
