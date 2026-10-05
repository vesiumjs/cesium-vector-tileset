import type { ActiveTiles } from './active-tiles';
import type { OverscaledTileID } from './tile-id';
import { FadingDirections, FadingRoles } from './tile';

/**
 * The raster crossfade driver, ported from MapLibre's tile_manager_raster:
 * when the ideal zoom set changes, every ideal tile is paired with a loaded
 * ancestor (zooming in), loaded descendents (zooming out) or an edge self-
 * fade (panning) so the outgoing tiles fade out while the incoming tile
 * fades in instead of popping. The animated opacity itself is a pure
 * function of time — see TilePyramid#getRasterFadeOpacity.
 */

/**
 * Pair each loaded ideal tile with a loaded ancestor to crossfade against
 * (many-to-one: the ancestor fades out while the ideal tiles fade in).
 */
function updateFadingAncestor(
  activeTiles: ActiveTiles,
  idealTile: ReturnType<ActiveTiles['getTileById']> & object,
  retain: Record<string, OverscaledTileID>,
  currentTime: number,
  maxFadingAncestorLevels: number,
  sourceMinZoom: number,
  rasterFadeDuration: number,
): boolean {
  if (!idealTile.hasData())
    return false;

  const { tileID: idealID, fadingRole, fadingDirection, fadingParentID } = idealTile;
  // The ideal tile already has a fading parent — keep it retained.
  if (fadingRole === FadingRoles.Base && fadingDirection === FadingDirections.Incoming && fadingParentID) {
    retain[fadingParentID.key] = fadingParentID;
    return true;
  }

  const minAncestorZ = Math.max(idealID.overscaledZ - maxFadingAncestorLevels, sourceMinZoom);
  for (let ancestorZ = idealID.overscaledZ - 1; ancestorZ >= minAncestorZ; ancestorZ--) {
    const ancestorID = idealID.scaledTo(ancestorZ);
    const ancestorTile = activeTiles.getLoadedTile(ancestorID);
    if (!ancestorTile)
      continue;

    idealTile.setCrossFadeLogic({
      fadingRole: FadingRoles.Base,
      fadingDirection: FadingDirections.Incoming,
      fadingParentID: ancestorTile.tileID,
      fadeEndTime: currentTime + rasterFadeDuration,
    });
    ancestorTile.setCrossFadeLogic({
      fadingRole: FadingRoles.Parent,
      fadingDirection: FadingDirections.Departing,
      fadeEndTime: currentTime + rasterFadeDuration,
    });

    retain[ancestorID.key] = ancestorID;
    return true;
  }
  return false;
}

/**
 * Search loaded descendents of an ideal tile (children first, then
 * grandchildren): the descendents fade out while the ideal tile fades in
 * (one-to-many, when zooming out).
 */
function updateFadingDescendents(
  activeTiles: ActiveTiles,
  idealTile: ReturnType<ActiveTiles['getTileById']> & object,
  retain: Record<string, OverscaledTileID>,
  currentTime: number,
  sourceMaxZoom: number,
  rasterFadeDuration: number,
): boolean {
  if (!idealTile.hasData())
    return false;

  const idealChildren = idealTile.tileID.children(sourceMaxZoom);
  if (updateFadingChildren(activeTiles, idealTile, idealChildren, retain, currentTime, sourceMaxZoom, rasterFadeDuration)) {
    return true;
  }

  for (const childID of idealChildren) {
    const grandChildIDs = childID.children(sourceMaxZoom);
    if (updateFadingChildren(activeTiles, idealTile, grandChildIDs, retain, currentTime, sourceMaxZoom, rasterFadeDuration)) {
      return true;
    }
  }

  return false;
}

function updateFadingChildren(
  activeTiles: ActiveTiles,
  idealTile: ReturnType<ActiveTiles['getTileById']> & object,
  childIDs: OverscaledTileID[],
  retain: Record<string, OverscaledTileID>,
  currentTime: number,
  sourceMaxZoom: number,
  rasterFadeDuration: number,
): boolean {
  if (childIDs.length === 0 || childIDs[0].overscaledZ >= sourceMaxZoom)
    return false;
  let foundFader = false;

  for (const childID of childIDs) {
    const childTile = activeTiles.getLoadedTile(childID);
    if (!childTile)
      continue;

    const { fadingRole, fadingDirection, fadingParentID } = childTile;
    if (fadingRole !== FadingRoles.Base || fadingDirection !== FadingDirections.Departing || !fadingParentID) {
      childTile.setCrossFadeLogic({
        fadingRole: FadingRoles.Base,
        fadingDirection: FadingDirections.Departing,
        fadingParentID: idealTile.tileID,
        fadeEndTime: currentTime + rasterFadeDuration,
      });
      idealTile.setCrossFadeLogic({
        fadingRole: FadingRoles.Parent,
        fadingDirection: FadingDirections.Incoming,
        fadeEndTime: currentTime + rasterFadeDuration,
      });
    }

    retain[childID.key] = childID;
    foundFader = true;
  }

  return foundFader;
}

/**
 * Self-fade for tiles entering at the view edge while panning: a loading
 * edge tile fades in instead of popping.
 */
function updateFadingEdge(
  idealTile: ReturnType<ActiveTiles['getTileById']> & object,
  edgeTileIDs: Set<OverscaledTileID>,
  currentTime: number,
  rasterFadeDuration: number,
): boolean {
  if (idealTile.selfFading) {
    return true;
  }
  if (idealTile.hasData()) {
    return false;
  }
  if (edgeTileIDs.has(idealTile.tileID)) {
    idealTile.setSelfFadeLogic(currentTime + rasterFadeDuration);
    return true;
  }
  return false;
}

/**
 * Called from TilePyramid#update for raster-like sources: assign the fading
 * roles for the new ideal set and retain the fading counterparts.
 */
export function updateFadingTiles(
  activeTiles: ActiveTiles,
  idealTileIDs: OverscaledTileID[],
  retain: Record<string, OverscaledTileID>,
  maxFadingAncestorLevels: number,
  sourceMinZoom: number,
  sourceMaxZoom: number,
  rasterFadeDuration: number,
): void {
  const currentTime = performance.now();
  const edgeTileIDs = getEdgeTiles(idealTileIDs);

  for (const idealID of idealTileIDs) {
    const idealTile = activeTiles.getTileById(idealID.key);
    if (!idealTile)
      continue;

    // A tile that was departing is now ideal again: it stops fading out.
    if (idealTile.fadingDirection === FadingDirections.Departing || idealTile.fadeOpacity === 0) {
      idealTile.resetFadeLogic();
    }

    const parentIsFader = updateFadingAncestor(activeTiles, idealTile, retain, currentTime, maxFadingAncestorLevels, sourceMinZoom, rasterFadeDuration);
    if (parentIsFader)
      continue;

    const childIsFader = updateFadingDescendents(activeTiles, idealTile, retain, currentTime, sourceMaxZoom, rasterFadeDuration);
    if (childIsFader)
      continue;

    const edgeIsFader = updateFadingEdge(idealTile, edgeTileIDs, currentTime, rasterFadeDuration);
    if (edgeIsFader)
      continue;

    idealTile.resetFadeLogic();
  }
}

/**
 * Whether any active tile is mid-fade: the tileset must keep requesting frames
 * until every fade completes.
 */
export function hasRasterTransition(activeTiles: ActiveTiles, rasterFadeDuration: number): boolean {
  if (rasterFadeDuration <= 0) {
    return false;
  }
  const currentTime = performance.now();
  for (const tile of activeTiles.getAllTiles()) {
    if (tile.fadeEndTime >= currentTime) {
      return true;
    }
  }
  return false;
}

/**
 * For a given set of tile ids, returns the edge tile ids for the bounding box.
 */
function getEdgeTiles(tileIDs: OverscaledTileID[]): Set<OverscaledTileID> {
  if (!tileIDs.length)
    return new Set<OverscaledTileID>();

  // set a common zoom for calculation (highest zoom) to reproject all tiles to this same zoom
  const targetZ = Math.max(...tileIDs.map(id => id.canonical.z));

  // vars to store the min and max tile x/y coordinates for edge finding
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  // project all tiles to targetZ while maintaining the reference to the original tile
  const projected: Array<{ id: OverscaledTileID; x: number; y: number }> = [];
  for (const id of tileIDs) {
    const { x, y, z } = id.canonical;
    const scale = 2 ** (targetZ - z);
    const px = x * scale;
    const py = y * scale;

    projected.push({ id, x: px, y: py });

    if (px < minX)
      minX = px;
    if (px > maxX)
      maxX = px;
    if (py < minY)
      minY = py;
    if (py > maxY)
      maxY = py;
  }

  // find edge tiles using the reprojected tile ids
  const edgeTiles: Set<OverscaledTileID> = new Set<OverscaledTileID>();
  for (const p of projected) {
    if (p.x === minX || p.x === maxX || p.y === minY || p.y === maxY) {
      edgeTiles.add(p.id);
    }
  }

  return edgeTiles;
}
