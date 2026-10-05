import type { SymbolPrimitiveGeometry } from '../symbol-geometry';
import type { PlacementView } from '../symbol-placement';
import { Cartesian3, Ellipsoid, EllipsoidalOccluder } from 'cesium';
import { describe, expect, it } from 'vitest';
import { projectGlyphsAlongLine } from '../symbol-geometry';
import { INVALID_LINE_ANGLE, placeSymbolTile, projectToScreen, SymbolCollisionIndex, updateLineSymbolGeometry } from '../symbol-placement';

const VIEW = {
  viewProjection: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  width: 100,
  height: 100,
  pixelRatio: 1,
  cameraZoom: 10,
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
    expect(updateLineSymbolGeometry(line, globeView())).toBe(true);
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
    const placed = projectGlyphsAlongLine(index => xs[index], index => ys[index], 0, xs.length, 5, 0, 0, [0, 5, 10], 0);
    expect(placed?.points.map(point => point.x)).toEqual([5, 10, 15]);
    expect(placed?.angles.every(angle => angle === 0)).toBe(true);
  });

  it('maps a split 2D frustum into its active Cesium viewport', () => {
    const viewport = { x: 300, y: 0, width: 200, height: 500 };
    expect(projectToScreen(VIEW.viewProjection, 1000, 500, 0, 0, 0, undefined, viewport))
      .toEqual({ sx: 400, sy: 250 });
    expect(projectToScreen(VIEW.viewProjection, 1000, 500, -1, 1, 0, undefined, viewport))
      .toEqual({ sx: 300, sy: 0 });
  });

  it('reprojects each line glyph at the current screen-space size', () => {
    const road = geometry([[30, 70]], true);
    road.instances[0].line = {
      anchorECEF: { x: 0, y: 0, z: 0 },
      pathECEF: new Float64Array([-0.8, 0, 0, 0.8, 0, 0]),
      segment: 0,
      glyphOffsets: new Float32Array([-10, 10]),
      lineOffsetX: 0,
      writingMode: 0,
    };
    expect(updateLineSymbolGeometry(road, VIEW)).toBe(true);
    expect(road.dynamics[0]).toBeCloseTo(10);
    expect(road.dynamics[12]).toBeCloseTo(-10);
    expect(road.dynamics[2]).toBeCloseTo(0);
    expect(road.dynamics[2]).toBeCloseTo(0);

    const reversed = new Float64Array(VIEW.viewProjection);
    reversed[0] = -1;
    expect(updateLineSymbolGeometry(road, { ...VIEW, viewProjection: reversed })).toBe(true);
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
