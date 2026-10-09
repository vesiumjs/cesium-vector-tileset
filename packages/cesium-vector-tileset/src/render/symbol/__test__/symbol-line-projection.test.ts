import type { SymbolPrimitiveGeometry } from '../symbol-geometry';
import type { PlacementView } from '../symbol-placement';
import { Cartesian3, Ellipsoid, Matrix4, WebMercatorProjection } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { projectGlyphsAlongLine } from '../symbol-geometry';
import { symbolGroundPosition, symbolMetersPerPixel } from '../symbol-perspective';
import { INVALID_LINE_ANGLE, projectToScreen, SymbolCollisionIndex, SymbolProjectionContext, SymbolTilePlacement, updateLineSymbolGeometry } from '../symbol-placement';

function cameraView(): PlacementView {
  const pitch = 75 * Math.PI / 180;
  const projection = Matrix4.computePerspectiveFieldOfView(36.875112943 * Math.PI / 180, 640 / 720, 0.1, 100000, new Matrix4());
  const view = Matrix4.computeView(new Cartesian3(120, 0, 0), new Cartesian3(-Math.cos(pitch), 0, Math.sin(pitch)), new Cartesian3(Math.sin(pitch), 0, Math.cos(pitch)), new Cartesian3(0, 1, 0), new Matrix4());
  const mapProjection = new WebMercatorProjection();
  return {
    viewProjection: Matrix4.multiply(projection, view, new Matrix4()),
    width: 640,
    height: 720,
    pixelRatio: 1,
    cameraZoom: 17,
    cameraToCenterDistance: 120 / Math.cos(pitch),
    orthographic: false,
    mercatorProjection: true,
    projectPosition: (x, y, z) => {
      const location = Ellipsoid.WGS84.cartesianToCartographic(new Cartesian3(x, y, z))!;
      const projected = mapProjection.project(location);
      return [projected.z, projected.x, projected.y];
    },
  };
}

function textLine(points: readonly [number, number][]): SymbolPrimitiveGeometry {
  const anchor = symbolGroundPosition(0, -800);
  const glyphs = 3;
  const vertices = glyphs * 4;
  const positions = new Float64Array(vertices * 3);
  const offsets = new Float32Array(vertices * 2);
  for (let vertex = 0; vertex < vertices; vertex++) {
    positions.set([anchor.x, anchor.y, anchor.z], vertex * 3);
    offsets.set([vertex % 4 < 2 ? -4 : 4, vertex % 2 ? 4 : -4], vertex * 2);
  }
  return {
    positions,
    offsets,
    pxoffsets: new Float32Array(vertices * 2),
    minfontscales: new Float32Array(vertices * 2),
    tex: new Float32Array(vertices * 2),
    sizes: new Float32Array(vertices).fill(24 * 128 * 4 + 3),
    sizesMax: new Float32Array(vertices).fill(24 * 128),
    sizeZooms: new Float32Array(vertices * 2),
    colors: new Float32Array(vertices * 4).fill(1),
    halos: new Float32Array(vertices * 4),
    dynamics: new Float32Array(vertices * 3),
    opacities: new Float32Array(vertices).fill(1),
    opacityDirty: false,
    viewportPerspective: false,
    mapPitch: true,
    sizePerspective: true,
    sdf: true,
    overlapMode: 'always',
    ignorePlacement: true,
    indices: new Uint32Array(),
    instances: [{
      vertexStart: 0,
      vertexCount: vertices,
      minX: -4,
      minY: -4,
      maxX: 4,
      maxY: 4,
      line: {
        anchorECEF: anchor,
        pathECEF: new Float64Array(points.flatMap(([east, north]) => {
          const world = symbolGroundPosition(east, -north);
          return [world.x, world.y, world.z];
        })),
        segment: 0,
        glyphOffsets: new Float32Array([-10, 0, 10]),
        lineOffsetX: 0,
        lineOffsetY: 0,
        keepUpright: true,
        rotateToLine: true,
        writingMode: 0,
      },
    }],
  };
}

function distinctBakedLine() {
  const label = textLine([[-100, 800], [100, 800]]);
  const baked = [-3, 2, 7].map((east, glyph) => {
    const point = symbolGroundPosition(east, -790 - glyph * 5);
    const coordinates = [point.x, point.y, point.z] as const;
    for (let vertex = 0; vertex < 4; vertex++)
      label.positions.set(coordinates, (glyph * 4 + vertex) * 3);
    return coordinates;
  });
  return { label, baked };
}

describe('live line glyph projection', () => {
  it.each([
    ['viewport', 'quads'],
    ['viewport', 'box'],
    ['map', 'quads'],
    ['map', 'box'],
  ] as const)('shares the actual worker anchor and distinct baked glyph projections with %s pitch and %s collision', (pitch, collision) => {
    const view = cameraView();
    const project = vi.fn(view.projectPosition!);
    view.projectPosition = project;
    const { label, baked } = distinctBakedLine();
    label.mapPitch = pitch === 'map';
    label.viewportPerspective = pitch === 'viewport';
    label.ignorePlacement = false;
    if (collision === 'box')
      label.instances[0].collisionBox = { x1: -15, y1: -4, x2: 15, y2: 4, layoutSize: 24 };
    const context = new SymbolProjectionContext();
    expect(updateLineSymbolGeometry(label, view, [0], context)).toBe(true);
    const dynamics = label.dynamics.slice();
    const worker = label.instances[0].line!.anchorECEF;
    const coordinates = [[worker.x, worker.y, worker.z], ...baked];
    const countProjections = () => coordinates.map(position => project.mock.calls.filter(call => call.every((value, index) => value === position[index])).length);
    const liveCounts = countProjections();
    // Map pitch also projects its separately constructed Mercator center
    // glyph while walking the path. Collision must add no anchor or baked
    // projections to the completed live result in either pitch mode.
    expect(liveCounts).toEqual([pitch === 'map' ? 2 : 1, 1, 1, 1]);
    const index = new SymbolCollisionIndex();
    const reserve = vi.spyOn(index, 'reserve');
    const placement = new SymbolTilePlacement(label, undefined, view, index, { pairs: [{ text: 0, icon: -1 }] });
    placement.advance(1, context);
    placement.commit();
    expect(Array.from(label.opacities)).toEqual(Array.from({ length: 12 }).fill(1));
    expect(label.dynamics).toEqual(dynamics);
    expect(countProjections()).toEqual(liveCounts);
    // A separate projection operation must produce the exact same collision
    // bounds, not just the same scalar size or visibility verdict.
    const referenceIndex = new SymbolCollisionIndex();
    const referenceReserve = vi.spyOn(referenceIndex, 'reserve');
    const reference = new SymbolTilePlacement(label, undefined, view, referenceIndex, { pairs: [{ text: 0, icon: -1 }] });
    reference.advance(1, new SymbolProjectionContext());
    reference.commit();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls).toEqual(referenceReserve.mock.calls);
  });

  it('does not project baked glyphs for circle-only collision until live attributes need them', () => {
    const view = cameraView();
    const project = vi.fn(view.projectPosition!);
    view.projectPosition = project;
    const { label, baked } = distinctBakedLine();
    label.mapPitch = false;
    label.viewportPerspective = true;
    label.instances[0].collisionCircles = { diameter: 16, padding: 2 };
    const context = new SymbolProjectionContext();
    const placement = new SymbolTilePlacement(label, undefined, view, new SymbolCollisionIndex(), { pairs: [{ text: 0, icon: -1 }] });
    placement.advance(1, context);
    placement.commit();
    expect(label.opacities[0]).toBe(1);
    for (const coordinates of baked)
      expect(project.mock.calls.some(call => call.every((value, index) => value === coordinates[index]))).toBe(false);
    expect(updateLineSymbolGeometry(label, view, [0], context)).toBe(true);
    expect(updateLineSymbolGeometry(label, view, [0], context)).toBe(false);
    for (const coordinates of baked)
      expect(project.mock.calls.filter(call => call.every((value, index) => value === coordinates[index]))).toHaveLength(1);
  });

  it('reuses a missing baked projection without weakening live hiding or other glyph coordinates', () => {
    const view = cameraView();
    const { label, baked } = distinctBakedLine();
    label.mapPitch = false;
    label.viewportPerspective = true;
    const original = view.projectPosition!;
    const project = vi.fn((x: number, y: number, z: number) => x === baked[0][0] && y === baked[0][1] && z === baked[0][2] ? undefined : original(x, y, z));
    view.projectPosition = project;
    const context = new SymbolProjectionContext();
    expect(updateLineSymbolGeometry(label, view, [0], context)).toBe(true);
    expect(Array.from(label.dynamics).filter((_, index) => index % 3 === 2)).toEqual(Array.from({ length: 12 }).fill(INVALID_LINE_ANGLE));
    const placement = new SymbolTilePlacement(label, undefined, view, new SymbolCollisionIndex(), { pairs: [{ text: 0, icon: -1 }] });
    placement.advance(1, context);
    expect(updateLineSymbolGeometry(label, view, [0], context)).toBe(false);
    for (const coordinates of baked)
      expect(project.mock.calls.filter(call => call.every((value, index) => value === coordinates[index]))).toHaveLength(1);
    // A new view and a new operation each perform their own missing check.
    updateLineSymbolGeometry(label, { ...view }, [0], context);
    updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext());
    expect(project.mock.calls.filter(call => call.every((value, index) => value === baked[0][index]))).toHaveLength(3);
  });

  it('walks a Y-offset curve through the intersection of the offset legs', () => {
    const xs = [0, 10, 10];
    const ys = [0, 0, 10];
    const placement = projectGlyphsAlongLine(index => xs[index], index => ys[index], 0, 3, 5, 0, 0, [2, 8], 0, { flip: false, lineOffsetY: 2, rotateToLine: true })!;
    // East and south legs offset by +2 meet at (8,2), so the second
    // glyph walks 3 units east and another 5 units south, rather than
    // shifting the original corner's glyph only after its path walk.
    expect(placement.points[0].x).toBeCloseTo(7);
    expect(placement.points[0].y).toBeCloseTo(2);
    expect(placement.points[1].x).toBeCloseTo(8);
    expect(placement.points[1].y).toBeCloseTo(7);
    expect(placement.angles).toEqual([0, Math.PI / 2]);
    expect(placement.path.map(point => [point.x, point.y])).toEqual([[7, 2], [8, 2], [8, 7]]);
  });

  it('retains viewport glyphs when a required leg crosses the camera plane', () => {
    const view = cameraView();
    const label = textLine([[0, 1600], [0, -800]]);
    label.instances[0].line!.segment = 0;
    label.instances[0].line!.keepUpright = false;
    label.mapPitch = false;
    label.viewportPerspective = true;
    updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext());
    expect(label.dynamics[2]).not.toBe(INVALID_LINE_ANGLE);
    expect(Array.from(label.dynamics).every(Number.isFinite)).toBe(true);
    // The straight visible portion lies on the viewport vertical through
    // the anchor. A behind endpoint must not turn it into a detached line.
    expect(label.dynamics[0]).toBeCloseTo(0, 5);
    expect(label.dynamics[12]).toBeCloseTo(0, 5);
    expect(label.dynamics[24]).toBeCloseTo(0, 5);
    expect(label.dynamics[1]).toBeLessThan(label.dynamics[13]);
    expect(label.dynamics[13]).toBeLessThan(label.dynamics[25]);
  });

  it('preserves the requested reading direction when keep upright is false', () => {
    const view = cameraView();
    const label = textLine([[100, 800], [-100, 800]]);
    label.instances[0].line!.keepUpright = false;
    updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext());
    expect(label.dynamics[0]).toBeGreaterThan(0);
    expect(label.dynamics[24]).toBeLessThan(0);
    expect(Math.abs(label.dynamics[2])).toBeCloseTo(Math.PI);
  });

  it('uses current screen orientation to keep a map line upright after heading reversal', () => {
    const view = cameraView();
    const pitch = 75 * Math.PI / 180;
    const projection = Matrix4.computePerspectiveFieldOfView(36.875112943 * Math.PI / 180, 640 / 720, 0.1, 100000, new Matrix4());
    const reversed = Matrix4.computeView(new Cartesian3(120, 0, 1600), new Cartesian3(-Math.cos(pitch), 0, -Math.sin(pitch)), new Cartesian3(Math.sin(pitch), 0, -Math.cos(pitch)), new Cartesian3(0, -1, 0), new Matrix4());
    view.viewProjection = Matrix4.multiply(projection, reversed, new Matrix4());
    const label = textLine([[-100, 800], [100, 800]]);
    updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext());
    expect(label.dynamics[0]).toBeGreaterThan(0);
    expect(label.dynamics[24]).toBeLessThan(0);
  });

  it('applies the worker Y offset in the actual Mercator label plane', () => {
    const view = cameraView();
    const label = textLine([[-100, 800], [100, 800]]);
    label.instances[0].line!.lineOffsetY = 24;
    const anchor = label.instances[0].line!.anchorECEF;
    const projected = projectToScreen(view.viewProjection, view.width, view.height, anchor.x, anchor.y, anchor.z, view.projectPosition)!;
    const ratio = 0.5 + 0.5 * view.cameraToCenterDistance! / projected.clipW;
    updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext());
    expect(label.dynamics[1]).toBeCloseTo(24 * symbolMetersPerPixel(view.cameraZoom) / ratio, 5);
    expect(label.dynamics[13]).toBeCloseTo(label.dynamics[1], 5);
    expect(label.dynamics[25]).toBeCloseTo(label.dynamics[1], 5);
  });

  it('projects only glyph-required legs on a long cached road', () => {
    const view = cameraView();
    const project = vi.fn(view.projectPosition!);
    view.projectPosition = project;
    const label = textLine([[-100, 800], [100, 800], ...Array.from({ length: 2000 }, (_, index): [number, number] => [100 + index, 800])]);
    updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext());
    expect(project.mock.calls.length).toBeLessThanOrEqual(12);
    project.mockClear();
    expect(updateLineSymbolGeometry(label, view, [0], new SymbolProjectionContext())).toBe(false);
    expect(project.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('retains visible glyphs when an unused distant leg lies behind the camera', () => {
    const view = cameraView();
    const visible = textLine([[-100, 800], [100, 800]]);
    const extended = textLine([[-100, 800], [100, 800], [100, -800]]);
    const behind = symbolGroundPosition(100, 800);
    expect(projectToScreen(view.viewProjection, view.width, view.height, behind.x, behind.y, behind.z, view.projectPosition)).toBeUndefined();
    const anchor = visible.instances[0].line!.anchorECEF;
    const projected = projectToScreen(view.viewProjection, view.width, view.height, anchor.x, anchor.y, anchor.z, view.projectPosition)!;
    expect(projected.clipW).toBeGreaterThan(0);
    expect(projected.sx).toBeGreaterThan(0);
    expect(projected.sx).toBeLessThan(view.width);
    expect(projected.sy).toBeGreaterThan(0);
    expect(projected.sy).toBeLessThan(view.height);
    updateLineSymbolGeometry(visible, view, [0], new SymbolProjectionContext());
    expect(visible.dynamics[2]).not.toBe(INVALID_LINE_ANGLE);
    // No glyph reaches the extra leg, so extending the road cannot change
    // this label's current visible placement. MapLibre projection.ts walks
    // only the required glyph legs and truncates a camera-crossing segment.
    updateLineSymbolGeometry(extended, view, [0], new SymbolProjectionContext());
    expect(Array.from(extended.dynamics)).toEqual(Array.from(visible.dynamics));
    expect(updateLineSymbolGeometry(visible, view, [0], new SymbolProjectionContext())).toBe(false);
  });
});
