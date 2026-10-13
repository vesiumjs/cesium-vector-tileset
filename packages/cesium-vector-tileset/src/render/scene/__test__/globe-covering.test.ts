import { WebMercatorTilingScheme } from 'cesium';
import { describe, expect, it } from 'vitest';
import { OverscaledTileID } from '../../../tile/tile-id';
import { globeVisibleTileIDs } from '../globe-covering';
import { SourceTileLod } from '../source-tile-lod';

const scheme = new WebMercatorTilingScheme();
const parent = new OverscaledTileID(13, 0, 13, 4093, 2724);
const children = parent.children(14);

function rendered(id: OverscaledTileID) {
  const { z, x, y } = id.canonical;
  return { level: z, x, y, rectangle: scheme.tileXYToRectangle(x, y, z) };
}

describe('globe source covering', () => {
  it('resolves the same tiles whether Cesium rendered one rectangle or its children', () => {
    // Cesium re-selects terrain tiles by screen space error, so a sub-pixel
    // pose change on a flat globe can replace this rectangle with its four
    // children and back. Were the source level read off the rendered
    // rectangle, each swap would retire the whole set at once and every
    // surface on it would blink out and back.
    const keys = (ids: readonly OverscaledTileID[]) => ids.map(id => id.key).sort();
    const coverings = (lod: SourceTileLod, targetZoom: number) => ({
      coarse: keys(globeVisibleTileIDs({ _surface: { _tilesToRender: [rendered(parent)] } }, 0, targetZoom, lod)),
      fine: keys(globeVisibleTileIDs({ _surface: { _tilesToRender: children.map(rendered) } }, 0, targetZoom, lod)),
      // Cesium publishes mixed levels while a refinement is in flight. The
      // overlapping rectangles must still collapse to one set of tiles.
      mixed: keys(globeVisibleTileIDs({ _surface: { _tilesToRender: [rendered(parent), rendered(children[0]), rendered(children[1])] } }, 0, targetZoom, lod)),
    });
    const within = coverings(new SourceTileLod(undefined, 14, 0, 14, false), 14);
    expect(within).toEqual({ coarse: keys(children), fine: keys(children), mixed: keys(children) });
    // Past a reparse source's ceiling the two paths must still name the same
    // generation, or the swap changes the requests even though the level is
    // the same.
    const past = coverings(new SourceTileLod(undefined, 16, 0, 14, false, true), 16);
    expect(past.coarse).toEqual(past.fine);
    expect(past.mixed).toEqual(past.fine);
  });

  it('coarsens a rendered rectangle to the level the camera actually needs', () => {
    const lod = new SourceTileLod(undefined, 13, 0, 14, false);
    expect(globeVisibleTileIDs({ _surface: { _tilesToRender: children.map(rendered) } }, 0, 14, lod))
      .toEqual([parent]);
  });

  it('resolves a coarse rectangle only where the frame can see it', () => {
    // A level-0 rectangle stands for the whole world, and resolving that whole
    // extent at the LOD's level is 4^z tiles. MapLibre culls every node against
    // the frustum before it splits, which is what holds a globe rectangle to
    // the part of it that is on screen.
    const lod = new SourceTileLod(undefined, 6, 0, 6, false);
    const world = new OverscaledTileID(0, 0, 0, 0, 0);
    const quadrant = new OverscaledTileID(1, 0, 1, 0, 0);
    // A sphere test admits every node that overlaps the view, ancestors of it
    // included, so that the traversal can reach the visible part.
    const visible = (id: OverscaledTileID) =>
      id.canonical.equals(quadrant.canonical)
      || id.canonical.isChildOf(quadrant.canonical)
      || quadrant.canonical.isChildOf(id.canonical);
    const covered = globeVisibleTileIDs({ _surface: { _tilesToRender: [rendered(world)] } }, 0, 6, lod, visible);
    expect(covered.every(id => id.canonical.isChildOf(quadrant.canonical))).toBe(true);
    expect(covered).toHaveLength(4 ** 5);
  });
});
