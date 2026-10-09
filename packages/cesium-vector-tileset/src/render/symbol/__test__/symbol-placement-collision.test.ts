import type { SymbolPrimitiveGeometry } from '../symbol-geometry';
import type { PlacementView } from '../symbol-placement';
import { Cartesian3, Ellipsoid, EllipsoidalOccluder, Matrix4, WebMercatorProjection } from 'cesium';
import { describe, expect, it } from 'vitest';
import { projectGlyphsAlongLine } from '../symbol-geometry';
import { symbolGroundPosition, symbolMetersPerPixel } from '../symbol-perspective';
import { INVALID_LINE_ANGLE, placeSymbolTile, projectToScreen, SymbolCollisionIndex, SymbolProjectionContext, SymbolTilePlacement, updateLineSymbolGeometry } from '../symbol-placement';

const VIEW = {
  viewProjection: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  width: 100,
  height: 100,
  pixelRatio: 1,
  cameraZoom: 10,
  mercatorProjection: true,
  orthographic: true,
  cameraToCenterDistance: undefined,
};

function geometry(centers: number[][], line = false): SymbolPrimitiveGeometry {
  const positions: number[] = [];
  const offsets: number[] = [];
  const indices: number[] = [];
  const instances: SymbolPrimitiveGeometry['instances'] = [];
  for (const glyphs of centers) {
    const vertexStart = positions.length / 3;
    for (const x of glyphs) {
      const start = positions.length / 3;
      for (const [ox, oy] of [[-5, -5], [5, -5], [5, 5], [-5, 5]]) {
        positions.push(x / 50 - 1, 0, 0);
        offsets.push(ox, oy);
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
    instances.push({
      vertexStart,
      vertexCount: glyphs.length * 4,
      minX: -5,
      minY: -5,
      maxX: 5,
      maxY: 5,
      ...(line
        ? {
            line: {
              anchorECEF: { x: 0, y: 0, z: 0 },
              pathECEF: new Float64Array(),
              segment: 0,
              glyphOffsets: new Float32Array(glyphs.length),
              lineOffsetX: 0,
              lineOffsetY: 0,
              keepUpright: true,
              rotateToLine: true,
              writingMode: 0,
            },
          }
        : {}),
    });
  }
  const count = positions.length / 3;
  return {
    positions: new Float64Array(positions),
    offsets: new Float32Array(offsets),
    pxoffsets: new Float32Array(count * 2),
    minfontscales: new Float32Array(count * 2),
    tex: new Float32Array(count * 2),
    sizes: new Float32Array(count).fill(24 * 128 * 4 + 1),
    sizesMax: new Float32Array(count).fill(24 * 128),
    sizeZooms: new Float32Array(count * 2),
    colors: new Float32Array(count * 4),
    halos: new Float32Array(count * 4),
    dynamics: new Float32Array(count * 3),
    opacities: new Float32Array(count).fill(1),
    opacityDirty: true,
    mapPitch: false,
    sizePerspective: true,
    viewportPerspective: !line,
    indices: new Uint32Array(indices),
    instances,
    sdf: true,
    overlapMode: 'never',
    ignorePlacement: false,
  };
}

function placeIcons(icon: SymbolPrimitiveGeometry, view: PlacementView, index: SymbolCollisionIndex): void {
  placeSymbolTile(undefined, icon, view, index, { pairs: icon.instances.map((_, icon) => ({ text: -1, icon })) });
}

describe('symbol collision', () => {
  it.each([1e-6, 1e-18])('filters a completed symbol safely when camera clip W reaches %s', (clipW) => {
    const icon = geometry([[50]]);
    icon.overlapMode = 'always';
    const options = { pairs: [{ text: -1, icon: 0 }] };
    const placement = new SymbolTilePlacement(undefined, icon, VIEW, new SymbolCollisionIndex(), options);
    placement.advance(1, new SymbolProjectionContext());
    placement.commit();
    // Model the native Map allocation limit at a small boundary so the old
    // camera-filter consumer fails without exhausting the test process heap.
    const cells = new class extends Map {
      visits = 0;
      get(key: unknown): unknown {
        if (++this.visits > 4096)
          throw new RangeError('Map maximum size exceeded');
        return super.get(key);
      }
    }();
    const index = new SymbolCollisionIndex();
    Reflect.set(index, '_cells', cells);
    const matrix = new Float64Array(VIEW.viewProjection);
    matrix[15] = clipW;
    const horizon = { ...VIEW, viewProjection: matrix, orthographic: false, cameraToCenterDistance: 100 };
    expect(() => placement.selection.filter(horizon, index, options, new SymbolProjectionContext())).not.toThrow();
    expect(icon.opacities[0]).toBe(1);
    expect(index.collides({ x1: 45, y1: 45, x2: 55, y2: 55 }, 'never')).toBe(true);
    expect(index.collides({ x1: 45, y1: 45, x2: 55, y2: 55 }, 'always')).toBe(false);
    index.clear();
    expect(index.collides({ x1: 45, y1: 45, x2: 55, y2: 55 }, 'never')).toBe(false);
    placement.selection.filter(VIEW, index, options, new SymbolProjectionContext());
    expect(icon.opacities[0]).toBe(1);
    expect(index.collides({ x1: 70, y1: 45, x2: 80, y2: 55 }, 'never')).toBe(false);
  });

  it('checks both query sizes and preserves large-circle precision and overlap modes', () => {
    const small = { x1: 45, y1: 45, x2: 55, y2: 55 };
    const large = { x1: -1e12, y1: -1e12, x2: 1e12, y2: 1e12 };
    const index = new SymbolCollisionIndex();
    index.reserve(small, 'never');
    expect(index.collides(large, 'never')).toBe(true);
    index.clear();
    index.reserve(large, 'cooperative');
    expect(index.collides(small, 'never')).toBe(true);
    expect(index.collides(small, 'cooperative')).toBe(false);
    expect(index.collides({ x1: 2e12, y1: 0, x2: 2e12 + 10, y2: 10 }, 'never')).toBe(false);
    index.clear();
    index.reserve({ ...large, circles: [{ x: 1e9, y: 1e9, radius: 10 }] }, 'never');
    expect(index.collides(small, 'never')).toBe(false);
    expect(index.collides({ x1: 1e9 - 1, y1: 1e9 - 1, x2: 1e9 + 1, y2: 1e9 + 1 }, 'never')).toBe(true);
  });

  it.each([
    [false, false, 0],
    [true, false, 1],
    [false, true, 0],
    [true, true, 1],
  ])('filters selected text/icon pairs with textOptional=%s iconOptional=%s', (textOptional, iconOptional, expectedIcon) => {
    const text = geometry([[30]]);
    const icon = geometry([[70]]);
    const options = { pairs: [{ text: 0, icon: 0 }], textOptional, iconOptional };
    const completed = new SymbolTilePlacement(text, icon, VIEW, new SymbolCollisionIndex(), options);
    completed.advance(1, new SymbolProjectionContext());
    completed.commit();
    expect([text.opacities[0], icon.opacities[0]]).toEqual([1, 1]);
    const index = new SymbolCollisionIndex();
    placeIcons(geometry([[30]]), VIEW, index);
    completed.selection.filter(VIEW, index, options, new SymbolProjectionContext());
    expect([text.opacities[0], icon.opacities[0]]).toEqual([0, expectedIcon]);
    completed.selection.filter(VIEW, new SymbolCollisionIndex(), options, new SymbolProjectionContext());
    expect([text.opacities[0], icon.opacities[0]]).toEqual([1, 1]);
  });

  it('never promotes a collision-hidden optional half when its selected peer is filtered', () => {
    const text = geometry([[50]]);
    const icon = geometry([[10]]);
    icon.overlapMode = 'always';
    const index = new SymbolCollisionIndex();
    placeIcons(geometry([[50]]), VIEW, index);
    const options = { pairs: [{ text: 0, icon: 0 }], textOptional: true };
    const completed = new SymbolTilePlacement(text, icon, VIEW, index, options);
    completed.advance(1, new SymbolProjectionContext());
    completed.commit();
    expect([text.opacities[0], icon.opacities[0]]).toEqual([0, 1]);
    index.clear();
    completed.selection.filter(VIEW, index, options, new SymbolProjectionContext());
    expect([text.opacities[0], icon.opacities[0]]).toEqual([0, 1]);
    const later = geometry([[10]]);
    placeIcons(later, VIEW, index);
    expect(later.opacities[0]).toBe(0);
  });

  function globeView(): PlacementView {
    const occluder = new EllipsoidalOccluder(Ellipsoid.UNIT_SPHERE, new Cartesian3(0, 0, 3));
    return {
      ...VIEW,
      isPointVisible: (x, y, z) => occluder.isPointVisible(new Cartesian3(x, y, z)),
    };
  }

  function onGlobe(front: boolean, line = false): SymbolPrimitiveGeometry {
    const symbol = geometry([[50]], line);
    for (let index = 2; index < symbol.positions.length; index += 3)
      symbol.positions[index] = front ? 1 : -1;
    if (symbol.instances[0].line) {
      symbol.instances[0].line.anchorECEF.z = front ? 1 : -1;
      symbol.instances[0].line.pathECEF = new Float64Array([-0.8, 0, -1, 0.8, 0, -1]);
    }
    return symbol;
  }

  it.each(['never', 'cooperative', 'always'] as const)('hides far-side symbols even with %s overlap', (mode) => {
    const symbol = onGlobe(false);
    symbol.overlapMode = mode;
    placeIcons(symbol, globeView(), new SymbolCollisionIndex());
    expect(Array.from(symbol.opacities)).toEqual([0, 0, 0, 0]);
  });

  it('does not let a far-side symbol block a visible front-side symbol', () => {
    const index = new SymbolCollisionIndex();
    const back = onGlobe(false);
    const front = onGlobe(true);
    placeIcons(back, globeView(), index);
    placeIcons(front, globeView(), index);
    expect(back.opacities[0]).toBe(0);
    expect(front.opacities[0]).toBe(1);
  });

  it('invalidates live line geometry whose anchor is behind the globe', () => {
    const line = onGlobe(false, true);
    expect(updateLineSymbolGeometry(line, globeView(), line.instances.keys(), new SymbolProjectionContext())).toBe(true);
    expect(line.dynamics[2]).toBe(INVALID_LINE_ANGLE);
    placeIcons(line, globeView(), new SymbolCollisionIndex());
    expect(line.opacities[0]).toBe(0);
  });

  it('shows the same symbol when its view has no globe occlusion', () => {
    const symbol = onGlobe(false);
    placeIcons(symbol, globeView(), new SymbolCollisionIndex());
    expect(symbol.opacities[0]).toBe(0);
    placeIcons(symbol, VIEW, new SymbolCollisionIndex());
    expect(symbol.opacities[0]).toBe(1);
  });

  it('places a line glyph at a corner across a zero-length path segment', () => {
    const xs = [0, 10, 10, 20];
    const ys = [0, 0, 0, 0];
    const placed = projectGlyphsAlongLine(index => xs[index], index => ys[index], 0, xs.length, 5, 0, 0, [0, 5, 10], 0, { flip: false, lineOffsetY: 0, rotateToLine: true });
    expect(placed?.points.map(point => point.x)).toEqual([5, 10, 15]);
    expect(placed?.angles.every(angle => angle === 0)).toBe(true);
  });

  it('maps a split 2D frustum into its active Cesium viewport', () => {
    const viewport = { x: 300, y: 0, width: 200, height: 500 };
    expect(projectToScreen(VIEW.viewProjection, 1000, 500, 0, 0, 0, undefined, viewport))
      .toEqual({ sx: 400, sy: 250, clipW: 1 });
    expect(projectToScreen(VIEW.viewProjection, 1000, 500, -1, 1, 0, undefined, viewport))
      .toEqual({ sx: 300, sy: 0, clipW: 1 });
  });

  it('reprojects each line glyph at the current screen-space size', () => {
    const road = geometry([[30, 70]], true);
    road.instances[0].line = {
      anchorECEF: { x: 0, y: 0, z: 0 },
      pathECEF: new Float64Array([-0.8, 0, 0, 0.8, 0, 0]),
      segment: 0,
      glyphOffsets: new Float32Array([-10, 10]),
      lineOffsetX: 0,
      lineOffsetY: 0,
      keepUpright: true,
      rotateToLine: true,
      writingMode: 0,
    };
    expect(updateLineSymbolGeometry(road, VIEW, road.instances.keys(), new SymbolProjectionContext())).toBe(true);
    expect(road.dynamics[0]).toBeCloseTo(10);
    expect(road.dynamics[12]).toBeCloseTo(-10);
    expect(road.dynamics[2]).toBeCloseTo(0);
    expect(road.dynamics[2]).toBeCloseTo(0);

    const reversed = new Float64Array(VIEW.viewProjection);
    reversed[0] = -1;
    expect(updateLineSymbolGeometry(road, { ...VIEW, viewProjection: reversed }, road.instances.keys(), new SymbolProjectionContext())).toBe(true);
    expect(road.dynamics[0]).toBeCloseTo(-30);
    expect(road.dynamics[12]).toBeCloseTo(30);
  });

  it('covers every glyph of a horizontal line label', () => {
    const index = new SymbolCollisionIndex();
    const road = geometry([[50, 70]], true);
    road.instances[0].line!.pathECEF = new Float64Array([-0.8, 0, 0, 0.8, 0, 0]);
    road.instances[0].line!.glyphOffsets = new Float32Array([0, 20]);
    const point = geometry([[70]]);
    placeIcons(road, VIEW, index);
    placeIcons(point, VIEW, index);
    expect(point.opacities[0]).toBe(0);
  });

  it('uses the worker point box including padding beyond the glyph quad', () => {
    const blocker = geometry([[50]]);
    const padded = geometry([[68]]);
    const index = new SymbolCollisionIndex();
    placeIcons(blocker, VIEW, index);
    placeIcons(padded, VIEW, index);
    expect(padded.opacities[0]).toBe(1);

    padded.instances[0].collisionBox = { x1: -15, y1: -8, x2: 15, y2: 8, layoutSize: 24 };
    placeIcons(padded, VIEW, index);
    expect(padded.opacities[0]).toBe(0);
  });

  it('scales a worker point box with the live symbol size', () => {
    const blocker = geometry([[50]]);
    const sized = geometry([[80]]);
    sized.instances[0].collisionBox = { x1: -20, y1: -8, x2: 20, y2: 8, layoutSize: 24 };
    sized.sizesMax.fill(48 * 128);
    for (let i = 0; i < sized.sizeZooms.length; i += 2) {
      sized.sizeZooms[i] = 10;
      sized.sizeZooms[i + 1] = 11;
    }
    const atZoom = (cameraZoom: number): number => {
      const index = new SymbolCollisionIndex();
      placeIcons(blocker, { ...VIEW, cameraZoom }, index);
      placeIcons(sized, { ...VIEW, cameraZoom }, index);
      return sized.opacities[0];
    };
    expect(atZoom(10)).toBe(1);
    expect(atZoom(11)).toBe(0);
  });

  it('checks later pairs against earlier text and icon together', () => {
    const text = geometry([[50], [90]]);
    const icon = geometry([[10], [50]]);
    placeSymbolTile(text, icon, VIEW, new SymbolCollisionIndex(), {
      pairs: [{ text: 0, icon: 0 }, { text: 1, icon: 1 }],
    });
    expect(text.opacities[0]).toBe(1);
    expect(icon.opacities[0]).toBe(1);
    expect(text.opacities[4]).toBe(0);
    expect(icon.opacities[4]).toBe(0);
  });

  it.each([
    ['never', 'never', 0],
    ['never', 'cooperative', 0],
    ['never', 'always', 0],
    ['cooperative', 'never', 0],
    ['cooperative', 'cooperative', 1],
    ['cooperative', 'always', 1],
    ['always', 'never', 1],
    ['always', 'cooperative', 1],
    ['always', 'always', 1],
  ] as const)('places %s after %s with visibility %i', (currentMode, previousMode, expected) => {
    const index = new SymbolCollisionIndex();
    const previous = geometry([[50]]);
    previous.overlapMode = previousMode;
    const current = geometry([[50]]);
    current.overlapMode = currentMode;
    placeIcons(previous, VIEW, index);
    placeIcons(current, VIEW, index);
    expect(previous.opacities[0]).toBe(1);
    expect(current.opacities[0]).toBe(expected);

    const separatedPrevious = geometry([[20]]);
    const separatedCurrent = geometry([[80]]);
    separatedPrevious.overlapMode = previousMode;
    separatedCurrent.overlapMode = currentMode;
    const options = { pairs: [{ text: -1, icon: 0 }] };
    const initial = new SymbolCollisionIndex();
    const completed = [separatedPrevious, separatedCurrent].map((icon) => {
      const placement = new SymbolTilePlacement(undefined, icon, VIEW, initial, options);
      placement.advance(1, new SymbolProjectionContext());
      placement.commit();
      return placement.selection;
    });
    expect([separatedPrevious.opacities[0], separatedCurrent.opacities[0]]).toEqual([1, 1]);
    const projection = new Float64Array(VIEW.viewProjection);
    projection[0] = 0.1;
    const compressed = { ...VIEW, cameraZoom: 8, viewProjection: projection };
    index.clear();
    for (const selection of completed)
      selection.filter(compressed, index, options);
    expect(separatedCurrent.opacities[0]).toBe(expected);
  });

  it('uses earlier cooperative modes within one batch and between paired symbols', () => {
    const sameBatch = geometry([[50], [50]]);
    sameBatch.overlapMode = 'cooperative';
    placeIcons(sameBatch, VIEW, new SymbolCollisionIndex());
    expect([...sameBatch.opacities.filter((_, index) => index % 4 === 0)]).toEqual([1, 1]);

    const text = geometry([[50], [50]]);
    const icon = geometry([[10], [10]]);
    text.overlapMode = 'cooperative';
    icon.overlapMode = 'cooperative';
    placeSymbolTile(text, icon, VIEW, new SymbolCollisionIndex(), {
      pairs: [{ text: 0, icon: 0 }, { text: 1, icon: 1 }],
    });
    expect(text.opacities[4]).toBe(1);
    expect(icon.opacities[4]).toBe(1);
  });

  it('combines a cooperative text verdict with its always-overlap icon', () => {
    const index = new SymbolCollisionIndex();
    const blocker = geometry([[50]]);
    placeIcons(blocker, VIEW, index);
    const text = geometry([[50]]);
    const icon = geometry([[50]]);
    text.overlapMode = 'cooperative';
    icon.overlapMode = 'always';
    placeSymbolTile(text, icon, VIEW, index, {
      pairs: [{ text: 0, icon: 0 }],
      textOptional: true,
    });
    expect(text.opacities[0]).toBe(0);
    expect(icon.opacities[0]).toBe(1);
  });

  it('keeps overlap mode and ignore-placement independent', () => {
    const index = new SymbolCollisionIndex();
    const first = geometry([[50]]);
    first.overlapMode = 'always';
    const second = geometry([[50]]);
    placeIcons(first, VIEW, index);
    placeIcons(second, VIEW, index);
    expect(second.opacities[0]).toBe(0);

    index.clear();
    first.ignorePlacement = true;
    placeIcons(first, VIEW, index);
    placeIcons(second, VIEW, index);
    expect(second.opacities[0]).toBe(1);

    index.clear();
    first.overlapMode = 'never';
    first.ignorePlacement = false;
    second.ignorePlacement = true;
    placeIcons(first, VIEW, index);
    placeIcons(second, VIEW, index);
    expect(second.opacities[0]).toBe(0);
  });
});

describe('viewport point perspective', () => {
  it('projects each unrotated viewport point once while preserving collision selection', () => {
    const icon = geometry([[25], [30], [70]]);
    let projections = 0;
    const view: PlacementView = {
      ...VIEW,
      projectPosition: (x, y, z) => {
        projections++;
        return [x, y, z];
      },
    };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect([icon.opacities[0], icon.opacities[4], icon.opacities[8]]).toEqual([1, 0, 1]);
    expect(projections).toBe(3);
  });

  it('projects a point without viewport perspective through the existing bounds path', () => {
    const icon = geometry([[50]]);
    icon.viewportPerspective = false;
    let projections = 0;
    const view: PlacementView = {
      ...VIEW,
      projectPosition: (x, y, z) => {
        projections++;
        return [x, y, z];
      },
    };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(1);
    expect(projections).toBe(1);
  });

  it('retains separate quad projection for rotated viewport points', () => {
    const icon = geometry([[25], [30], [70]]);
    for (let vertex = 0; vertex < icon.positions.length / 3; vertex++) {
      icon.dynamics[vertex * 3 + 2] = Math.PI / 4;
    }
    let projections = 0;
    const view: PlacementView = {
      ...VIEW,
      projectPosition: (x, y, z) => {
        projections++;
        return [x, y, z];
      },
    };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect([icon.opacities[0], icon.opacities[4], icon.opacities[8]]).toEqual([1, 0, 1]);
    expect(projections).toBe(6);
  });

  it.each(['far', 'behind', 'unprojectable'] as const)('rejects a %s point after its first projection', (reason) => {
    const icon = geometry([[50]]);
    const matrix = VIEW.viewProjection.slice();
    if (reason === 'behind') {
      matrix[15] = -1;
    }
    let projections = 0;
    const view: PlacementView = {
      ...VIEW,
      viewProjection: matrix,
      orthographic: false,
      cameraToCenterDistance: reason === 'far' ? 0.1 : 1,
      projectPosition: (x, y, z) => {
        projections++;
        return reason === 'unprojectable' ? undefined : [x, y, z];
      },
    };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(0);
    expect(projections).toBe(1);
  });

  it('preserves device-pixel collisions in an offset active viewport', () => {
    const icon = geometry([[25], [32], [70]]);
    let projections = 0;
    const view: PlacementView = {
      ...VIEW,
      width: 400,
      height: 200,
      pixelRatio: 2,
      viewport: { x: 100, y: 40, width: 200, height: 100 },
      projectPosition: (x, y, z) => {
        projections++;
        return [x, y, z];
      },
    };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect([icon.opacities[0], icon.opacities[4], icon.opacities[8]]).toEqual([1, 0, 1]);
    expect(projections).toBe(3);

    const index = new SymbolCollisionIndex();
    index.reserve({ x1: 140, y1: 100, x2: 160, y2: 120 }, 'never');
    placeIcons(icon, view, index);
    expect([icon.opacities[0], icon.opacities[4], icon.opacities[8]]).toEqual([0, 0, 1]);
  });

  it('uses the raw ratio beyond the GPU four-times limit for collision', () => {
    const icon = geometry([[25], [70]]);
    for (const instance of icon.instances) {
      instance.collisionBox = { x1: -5, y1: -5, x2: 5, y2: 5, layoutSize: 24 };
    }
    const view = { ...VIEW, orthographic: false, cameraToCenterDistance: 9 };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect([icon.opacities[0], icon.opacities[4]]).toEqual([1, 0]);
  });

  it('cuts off far normal symbols but preserves icon-only always-overlap', () => {
    const view = { ...VIEW, orthographic: false, cameraToCenterDistance: 0.1 };
    const icon = geometry([[50]]);
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(0);
    icon.overlapMode = 'always';
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(1);
  });

  it('requires the paired overlap or optional peer before bypassing cutoff', () => {
    const view = { ...VIEW, orthographic: false, cameraToCenterDistance: 0.1 };
    const text = geometry([[50]]);
    const icon = geometry([[50]]);
    icon.overlapMode = 'always';
    placeSymbolTile(text, icon, view, new SymbolCollisionIndex(), { pairs: [{ text: 0, icon: 0 }] });
    expect([text.opacities[0], icon.opacities[0]]).toEqual([0, 0]);
    placeSymbolTile(text, icon, view, new SymbolCollisionIndex(), { pairs: [{ text: 0, icon: 0 }], textOptional: true });
    expect([text.opacities[0], icon.opacities[0]]).toEqual([0, 1]);
  });

  it('leaves map-pitch point geometry outside viewport perspective', () => {
    const icon = geometry([[25], [70]]);
    icon.viewportPerspective = false;
    placeIcons(icon, { ...VIEW, orthographic: false, cameraToCenterDistance: 9 }, new SymbolCollisionIndex());
    expect([icon.opacities[0], icon.opacities[4]]).toEqual([1, 1]);
  });

  it('rejects unknown perspective distance while retaining the explicit orthographic control', () => {
    const icon = geometry([[50]]);
    placeIcons(icon, { ...VIEW, orthographic: false }, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(0);
    placeIcons(icon, VIEW, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(1);
  });
});

describe('live along-line perspective', () => {
  function road(): SymbolPrimitiveGeometry {
    const result = geometry([[30, 70]], true);
    result.viewportPerspective = true;
    result.instances[0].line = {
      anchorECEF: { x: 0, y: 0, z: 0 },
      pathECEF: new Float64Array([-0.8, 0, 0, 0.8, 0, 0]),
      segment: 0,
      glyphOffsets: new Float32Array([-10, 10]),
      lineOffsetX: 0,
      lineOffsetY: 0,
      keepUpright: true,
      rotateToLine: true,
      writingMode: 0,
    };
    return result;
  }

  it('walks viewport glyph centers with the worker anchor raw perspective ratio', () => {
    const label = road();
    const view = { ...VIEW, orthographic: false, cameraToCenterDistance: 3 };
    updateLineSymbolGeometry(label, view, label.instances.keys(), new SymbolProjectionContext());
    expect(label.dynamics[0]).toBeCloseTo(0);
    expect(label.dynamics[12]).toBeCloseTo(0);
  });

  it('uses the worker line offset already expressed in shaped em units', () => {
    const label = road();
    label.instances[0].line!.glyphOffsets.fill(0);
    label.instances[0].line!.lineOffsetX = 12;
    updateLineSymbolGeometry(label, VIEW, label.instances.keys(), new SymbolProjectionContext());
    expect(label.dynamics[2]).not.toBe(INVALID_LINE_ANGLE);
    expect(label.dynamics[0]).toBeCloseTo(32);
    expect(label.dynamics[12]).toBeCloseTo(-8);
  });

  it('cuts off normal far line symbols while respecting the actual always-overlap caller', () => {
    const label = road();
    const view = { ...VIEW, orthographic: false, cameraToCenterDistance: 0.1 };
    placeIcons(label, view, new SymbolCollisionIndex());
    expect(label.opacities[0]).toBe(0);
    label.overlapMode = 'always';
    placeIcons(label, view, new SymbolCollisionIndex());
    expect(label.opacities[0]).toBe(1);
  });
});

it('uses the padded worker line-icon box instead of its atlas quad bounds', () => {
  const label = geometry([[50]], true);
  label.viewportPerspective = true;
  const anchor = symbolGroundPosition(0, 0);
  const first = symbolGroundPosition(-40, 0);
  const last = symbolGroundPosition(40, 0);
  label.instances[0].line!.anchorECEF = anchor;
  label.instances[0].line!.pathECEF = new Float64Array([first.x, first.y, first.z, last.x, last.y, last.z]);
  for (let vertex = 0; vertex < 4; vertex++)
    label.positions.set([anchor.x, anchor.y, anchor.z], vertex * 3);
  label.instances[0].collisionBox = { x1: -40, y1: -5, x2: 40, y2: 5, layoutSize: 24 };
  const later = geometry([[85]]);
  const laterWorld = symbolGroundPosition(35, 0);
  for (let vertex = 0; vertex < 4; vertex++)
    later.positions.set([laterWorld.x, laterWorld.y, laterWorld.z], vertex * 3);
  const view: PlacementView = { ...VIEW, projectPosition: (_x, y) => [y / 50, 0, 0] };
  const index = new SymbolCollisionIndex();
  placeIcons(label, view, index);
  placeIcons(later, view, index);
  expect(later.opacities[0]).toBe(0);
});

it('walks map glyphs in the Mercator label plane before actual CV projection', () => {
  const pitch = 85 * Math.PI / 180;
  const projection = Matrix4.computePerspectiveFieldOfView(36.875112943 * Math.PI / 180, 640 / 720, 0.1, 100000, new Matrix4());
  const viewMatrix = Matrix4.computeView(new Cartesian3(120, 0, 0), new Cartesian3(-Math.cos(pitch), 0, Math.sin(pitch)), new Cartesian3(Math.sin(pitch), 0, Math.cos(pitch)), new Cartesian3(0, 1, 0), new Matrix4());
  const matrix = Matrix4.multiply(projection, viewMatrix, new Matrix4());
  const groundProjection = new WebMercatorProjection();
  const view: PlacementView = {
    ...VIEW,
    width: 640,
    height: 720,
    orthographic: false,
    cameraZoom: 15.905645471086315,
    cameraToCenterDistance: 120 / Math.cos(pitch),
    viewProjection: matrix,
    projectPosition: (x, y, z) => {
      const location = Ellipsoid.WGS84.cartesianToCartographic(new Cartesian3(x, y, z))!;
      const projected = groundProjection.project(location);
      return [projected.z, projected.x, projected.y];
    },
  };
  const world = symbolGroundPosition(0, -800);
  const label = geometry([[30, 70]], true);
  label.viewportPerspective = false;
  label.mapPitch = true;
  for (let vertex = 0; vertex < 8; vertex++)
    label.positions.set([world.x, world.y, world.z], vertex * 3);
  const start = symbolGroundPosition(-1000, -800);
  const end = symbolGroundPosition(1000, -800);
  label.instances[0].line = {
    anchorECEF: world,
    pathECEF: new Float64Array([start.x, start.y, start.z, end.x, end.y, end.z]),
    segment: 0,
    glyphOffsets: new Float32Array([-24, 24]),
    lineOffsetX: 0,
    lineOffsetY: 0,
    keepUpright: true,
    rotateToLine: true,
    writingMode: 0,
  };
  const projected = projectToScreen(matrix, 640, 720, world.x, world.y, world.z, view.projectPosition)!;
  const ratio = 0.5 + 0.5 * view.cameraToCenterDistance! / projected.clipW;
  const expected = 24 * symbolMetersPerPixel(view.cameraZoom) / ratio;
  updateLineSymbolGeometry(label, view, label.instances.keys(), new SymbolProjectionContext());
  expect(label.dynamics[0]).toBeCloseTo(-expected, 5);
  expect(label.dynamics[12]).toBeCloseTo(expected, 5);
  expect(label.dynamics[1]).toBeCloseTo(0, 5);
  const retained = Array.from(label.dynamics);
  expect(updateLineSymbolGeometry(label, view, label.instances.keys(), new SymbolProjectionContext())).toBe(false);
  expect(Array.from(label.dynamics)).toEqual(retained);
});

it.each([
  ['map', false, 0, 0],
  ['viewport', false, 35, 20],
  ['map', true, 35, 20],
  ['viewport', true, 35, 20],
] as const)('collides ground point icons against projected four corners with %s rotation, worker box=%s, bearing=%s, roll=%s', (rotation, workerBox, bearing, roll) => {
  const pitch = 75 * Math.PI / 180;
  const b = bearing * Math.PI / 180;
  const r = roll * Math.PI / 180;
  const projection = Matrix4.computePerspectiveFieldOfView(36.875112943 * Math.PI / 180, 640 / 720, 0.1, 100000, new Matrix4());
  const right = new Cartesian3(0, Math.cos(b), -Math.sin(b));
  const up = new Cartesian3(Math.sin(pitch), Math.cos(pitch) * Math.sin(b), Math.cos(pitch) * Math.cos(b));
  const rotatedRight = Cartesian3.add(Cartesian3.multiplyByScalar(right, Math.cos(r), new Cartesian3()), Cartesian3.multiplyByScalar(up, -Math.sin(r), new Cartesian3()), new Cartesian3());
  const rotatedUp = Cartesian3.add(Cartesian3.multiplyByScalar(up, Math.cos(r), new Cartesian3()), Cartesian3.multiplyByScalar(right, Math.sin(r), new Cartesian3()), new Cartesian3());
  const viewMatrix = Matrix4.computeView(new Cartesian3(120, 0, 0), new Cartesian3(-Math.cos(pitch), Math.sin(pitch) * Math.sin(b), Math.sin(pitch) * Math.cos(b)), rotatedUp, rotatedRight, new Matrix4());
  const matrix = Matrix4.multiply(projection, viewMatrix, new Matrix4());
  const groundProjection = new WebMercatorProjection();
  const view: PlacementView = {
    ...VIEW,
    width: 640,
    height: 720,
    orthographic: false,
    cameraZoom: 15.905645471086315,
    cameraToCenterDistance: 120 / Math.cos(pitch),
    viewProjection: matrix,
    projectPosition: (x, y, z) => {
      const location = Ellipsoid.WGS84.cartesianToCartographic(new Cartesian3(x, y, z))!;
      const projected = groundProjection.project(location);
      return [projected.z, projected.x, projected.y];
    },
  };
  const east = -144 * Math.cos(b) + 800 * Math.sin(b);
  const south = -(144 * Math.sin(b) + 800 * Math.cos(b));
  const world = symbolGroundPosition(east, south);
  const icon = geometry([[50]]);
  icon.viewportPerspective = false;
  icon.mapPitch = true;
  icon.pointMapRotation = rotation;
  if (workerBox)
    icon.instances[0].collisionBox = { x1: -8, y1: -8, x2: 8, y2: 8, layoutSize: 1 };
  icon.sizes.fill(128 * 4);
  icon.sizesMax.fill(128);
  icon.offsets.set([-8, -8, 8, -8, 8, 8, -8, 8]);
  for (let vertex = 0; vertex < 4; vertex++)
    icon.positions.set([world.x, world.y, world.z], vertex * 3);
  const anchor = projectToScreen(matrix, 640, 720, world.x, world.y, world.z, view.projectPosition)!;
  const scale = symbolMetersPerPixel(view.cameraZoom) * (0.5 + 0.5 * anchor.clipW / view.cameraToCenterDistance!);
  const expectedEast = rotation === 'map' ? [1, 0] : [Math.cos(b) * Math.cos(pitch) * Math.cos(r) - Math.sin(b) * Math.sin(r), Math.sin(b) * Math.cos(pitch) * Math.cos(r) + Math.cos(b) * Math.sin(r)];
  const expectedSouth = rotation === 'map' ? [0, 1] : [-Math.cos(b) * Math.cos(pitch) * Math.sin(r) - Math.sin(b) * Math.cos(r), -Math.sin(b) * Math.cos(pitch) * Math.sin(r) + Math.cos(b) * Math.cos(r)];
  const eastLength = Math.hypot(...expectedEast);
  const southLength = Math.hypot(...expectedSouth);
  const corners = [[-8, -8], [8, -8], [8, 8], [-8, 8]].map(([x, y]) => {
    const corner = symbolGroundPosition(east + (x * expectedEast[0] / eastLength + y * expectedSouth[0] / southLength) * scale, south + (x * expectedEast[1] / eastLength + y * expectedSouth[1] / southLength) * scale);
    return projectToScreen(matrix, 640, 720, corner.x, corner.y, corner.z, view.projectPosition)!;
  });
  const bounds = {
    x1: Math.min(...corners.map(point => point.sx)),
    y1: Math.min(...corners.map(point => point.sy)),
    x2: Math.max(...corners.map(point => point.sx)),
    y2: Math.max(...corners.map(point => point.sy)),
  };
  if (!bearing)
    expect(bounds.y2 - bounds.y1).toBeLessThan(6);
  const index = new SymbolCollisionIndex();
  placeIcons(icon, view, index);
  expect(icon.opacities[0]).toBe(1);
  const x = (bounds.x1 + bounds.x2) * 0.5;
  expect(index.collides({ x1: x, x2: x + 0.01, y1: bounds.y2 - 0.02, y2: bounds.y2 - 0.01 }, 'never')).toBe(true);
  expect(index.collides({ x1: x, x2: x + 0.01, y1: bounds.y2 + 0.01, y2: bounds.y2 + 0.02 }, 'never')).toBe(false);
  const y = (bounds.y1 + bounds.y2) * 0.5;
  expect(index.collides({ x1: bounds.x2 - 0.02, x2: bounds.x2 - 0.01, y1: y, y2: y + 0.01 }, 'never')).toBe(true);
  expect(index.collides({ x1: bounds.x2 + 0.01, x2: bounds.x2 + 0.02, y1: y, y2: y + 0.01 }, 'never')).toBe(false);
});

it('uses raw perspective circle radii for line text and keeps circular collision shape', () => {
  const make = () => {
    const label = geometry([[50]], true);
    label.viewportPerspective = true;
    label.instances[0].line!.pathECEF = new Float64Array([-0.8, 0, 0, 0.8, 0, 0]);
    Object.assign(label.instances[0], { collisionCircles: { diameter: 20, padding: 0 } });
    return label;
  };
  const view = { ...VIEW, orthographic: false, cameraToCenterDistance: 9 };
  const index = new SymbolCollisionIndex();
  const label = make();
  placeIcons(label, view, index);
  const horizontal = geometry([[90]]);
  horizontal.viewportPerspective = false;
  placeIcons(horizontal, view, index);
  expect(horizontal.opacities[0]).toBe(0);
  const diagonal = geometry([[95]]);
  diagonal.viewportPerspective = false;
  for (let vertex = 0; vertex < 4; vertex++)
    diagonal.positions[vertex * 3 + 1] = -0.9;
  placeIcons(diagonal, view, index);
  expect(diagonal.opacities[0]).toBe(1);
});

it('retains intermediate label-plane legs for collision and keeps offsets when flipped', () => {
  const xs = [0, 20, 20];
  const ys = [0, 0, 20];
  const result = projectGlyphsAlongLine(index => xs[index], index => ys[index], 0, 3, 10, 0, 0, [-5, 15], 0, { flip: false, lineOffsetY: 0, rotateToLine: true })!;
  expect(result.path.map(point => [point.x, point.y])).toEqual([[5, 0], [20, 0], [20, 5]]);
  const reversed = projectGlyphsAlongLine(index => [20, -20][index], () => 0, 0, 2, 0, 0, 0, [-5, 5], 3, { flip: true, lineOffsetY: 0, rotateToLine: true })!;
  expect(reversed.flipped).toBe(true);
  expect(reversed.points.map(point => point.x)).toEqual([-8, 2]);
});
