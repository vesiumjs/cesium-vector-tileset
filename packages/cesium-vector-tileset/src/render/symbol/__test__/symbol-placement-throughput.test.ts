import type { SymbolPrimitiveGeometry, SymbolTileGeometry } from '../symbol-geometry';
import type { PlacementView } from '../symbol-placement';
import { Color, Event, PrimitiveCollection } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollisionBoxArray } from '../../../data/array-types.g';
import { SymbolStyleLayer } from '../../../style/style-layer/symbol-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { acquireSceneFrameBudget } from '../../scene/scene-frame-budget';
import { beginSymbolBuild, buildSymbolHalves, mergeSymbolHalves, SymbolTileRenderer } from '../symbol-renderer';

const VIEW: PlacementView = {
  viewProjection: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  width: 1000,
  height: 1000,
  pixelRatio: 1,
  cameraZoom: 10,
  mercatorProjection: true,
  orthographic: true,
  cameraToCenterDistance: undefined,
};

function pointGeometry(count: number): SymbolPrimitiveGeometry {
  const vertexCount = count * 4;
  const icon: SymbolPrimitiveGeometry = {
    positions: new Float64Array(vertexCount * 3),
    offsets: new Float32Array(vertexCount * 2),
    pxoffsets: new Float32Array(vertexCount * 2),
    minfontscales: new Float32Array(vertexCount * 2),
    tex: new Float32Array(vertexCount * 2),
    sizes: new Float32Array(vertexCount).fill(128 * 4),
    sizesMax: new Float32Array(vertexCount).fill(128),
    sizeZooms: new Float32Array(vertexCount * 2),
    colors: new Float32Array(vertexCount * 4),
    halos: new Float32Array(vertexCount * 4),
    dynamics: new Float32Array(vertexCount * 3),
    opacities: new Float32Array(vertexCount),
    opacityDirty: false,
    mapPitch: false,
    sizePerspective: true,
    viewportPerspective: true,
    indices: new Uint32Array(count * 6),
    instances: [],
    sdf: false,
    overlapMode: 'never',
    ignorePlacement: false,
  };
  for (let instance = 0; instance < count; instance++) {
    for (let corner = 0; corner < 4; corner++) {
      const vertex = instance * 4 + corner;
      icon.positions[vertex * 3] = (instance % 30 + 0.5) / 15 - 1;
      icon.positions[vertex * 3 + 1] = (Math.floor(instance / 30) + 0.5) / 15 - 1;
      icon.offsets[vertex * 2] = corner === 0 || corner === 3 ? -2 : 2;
      icon.offsets[vertex * 2 + 1] = corner < 2 ? -2 : 2;
    }
    icon.instances.push({ vertexStart: instance * 4, vertexCount: 4, minX: -2, minY: -2, maxX: 2, maxY: 2 });
  }
  return icon;
}

/** Prepared point quads, handed through the renderer's normal build commit. */
function addPointTile(renderer: SymbolTileRenderer, tileId: string, count: number, layer?: SymbolStyleLayer, text?: SymbolPrimitiveGeometry, drawable = false, layerOrder?: number, preparedIcon?: SymbolPrimitiveGeometry): SymbolPrimitiveGeometry {
  if (drawable)
    vi.stubGlobal('OffscreenCanvas', class {});
  const icon = preparedIcon ?? pointGeometry(count);
  const batch: SymbolTileGeometry = { text, icon, pairs: icon.instances.map((_, icon) => ({ text: text ? icon : -1, icon })) };
  const state = beginSymbolBuild({
    tileId,
    tileKey: tileId,
    tileID: new CanonicalTileID(0, 0, 0),
    buckets: {},
    collisionBoxArray: new CollisionBoxArray(),
    layers: layer ? [layer] : [],
    layerOrder: layer && layerOrder !== undefined ? new Map([[layer.id, layerOrder]]) : undefined,
    pixelRatio: 1,
  }, undefined, undefined);
  const halves = drawable
    ? buildSymbolHalves({
        tileId,
        layerId: layer!.id,
        geometry: batch,
        iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'test-icon' },
        textAtlas: text ? { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'test-text' } : undefined,
        textColor: Color.WHITE,
        iconColor: Color.WHITE,
        pixelRatio: 1,
      })
    : [];
  const merged = mergeSymbolHalves(tileId, halves);
  state.entry = {
    input: state.input,
    batches: [batch],
    layerIds: [layer?.id ?? 'points'],
    halves,
    collections: merged ? [merged.collection] : [new PrimitiveCollection()],
    primitives: merged?.primitives ?? [],
    key: tileId,
    materials: new Set(halves.map(half => half.material)),
    atlasKeys: [],
    placed: false,
    bytes: 0,
  };
  renderer.commitBuild(state);
  return icon;
}

function twoWidePoints(icon: SymbolPrimitiveGeometry): void {
  for (let vertex = 0; vertex < 8; vertex++) {
    icon.positions[vertex * 3] = vertex < 4 ? -0.04 : 0.04;
    icon.positions[vertex * 3 + 1] = 0;
    icon.offsets[vertex * 2] *= 5;
    icon.offsets[vertex * 2 + 1] *= 5;
  }
  for (const instance of icon.instances) {
    instance.minX = instance.minY = -10;
    instance.maxX = instance.maxY = 10;
  }
}

function preparedPointBuild(tileId: string, material?: ReturnType<typeof buildSymbolHalves>[number]['material']) {
  vi.stubGlobal('OffscreenCanvas', class {});
  const icon = pointGeometry(1);
  const state = beginSymbolBuild({
    tileId,
    tileKey: tileId,
    tileID: new CanonicalTileID(0, 0, 0),
    buckets: {},
    collisionBoxArray: new CollisionBoxArray(),
    layers: [],
    pixelRatio: 1,
  }, undefined, undefined);
  state.halves.push(...buildSymbolHalves({
    tileId,
    layerId: 'labels',
    geometry: { icon, pairs: [{ icon: 0, text: -1 }] },
    iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'cancel-atlas' },
    iconMaterial: material,
    textColor: Color.WHITE,
    iconColor: Color.WHITE,
    pixelRatio: 1,
  }));
  return state;
}

describe('uncommitted symbol resource ownership', () => {
  it('releases partially extracted material holds before a Native collection exists', () => {
    const renderer = new SymbolTileRenderer();
    const state = preparedPointBuild('partial');
    state.input.layers = ['first', 'second'].map(id => new SymbolStyleLayer({ id, type: 'symbol', source: 'source' }, {}));
    const material = state.halves[0].material;
    const destroy = vi.spyOn(material, 'destroy');
    try {
      expect(renderer.stepBuild(state, { exhausted: true })).toBe(false);
      expect(state.entry).toBeUndefined();
      renderer.releaseBuild(state);
      renderer.releaseBuild(state);
      expect(material.isDestroyed()).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
    }
    finally {
      renderer.removeAll();
      if (!material.isDestroyed())
        material.destroy();
    }
  });

  it('destroys a cancelled prepared Native collection and its material exactly once', () => {
    const renderer = new SymbolTileRenderer();
    const state = preparedPointBuild('cancelled');
    renderer.stepBuild(state, UNBOUNDED_BUDGET);
    const collection = state.entry!.collections[0];
    const primitive = collection.get(0);
    const material = state.halves[0].material;
    const destroy = vi.spyOn(material, 'destroy');
    try {
      renderer.releaseBuild(state);
      renderer.releaseBuild(state);
      expect(collection.isDestroyed()).toBe(true);
      expect(primitive.isDestroyed()).toBe(true);
      expect(material.isDestroyed()).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
      expect(renderer.stats.tiles).toBe(0);
    }
    finally {
      renderer.removeAll();
      if (!collection.isDestroyed())
        collection.destroy();
      if (!material.isDestroyed())
        material.destroy();
    }
  });

  it('keeps a prepared build alive when a cancelled build and a live entry release their shared material', () => {
    const renderer = new SymbolTileRenderer();
    const cancelled = preparedPointBuild('cancelled');
    const material = cancelled.halves[0].material;
    const survivor = preparedPointBuild('survivor', material);
    const live = preparedPointBuild('live', material);
    renderer.stepBuild(cancelled, UNBOUNDED_BUDGET);
    renderer.stepBuild(survivor, UNBOUNDED_BUDGET);
    renderer.stepBuild(live, UNBOUNDED_BUDGET);
    renderer.commitBuild(live);
    const destroy = vi.spyOn(material, 'destroy');
    try {
      renderer.releaseBuild(cancelled);
      expect(material.isDestroyed()).toBe(false);
      renderer.removeTile('live');
      expect(material.isDestroyed()).toBe(false);
      renderer.commitBuild(survivor);
      renderer.releaseBuild(survivor);
      expect(material.isDestroyed()).toBe(false);
      expect(survivor.entry!.collections[0].isDestroyed()).toBe(false);
      renderer.removeTile('survivor');
      expect(material.isDestroyed()).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
    }
    finally {
      renderer.removeAll();
      for (const state of [cancelled, survivor, live]) {
        for (const collection of state.entry!.collections) {
          if (!collection.isDestroyed())
            collection.destroy();
        }
      }
      if (!material.isDestroyed())
        material.destroy();
    }
  });
});

function movePoint(icon: SymbolPrimitiveGeometry, x: number): void {
  for (let vertex = 0; vertex < icon.positions.length / 3; vertex++) {
    icon.positions[vertex * 3] = x;
    icon.positions[vertex * 3 + 1] = 0;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('symbol placement throughput through renderer updates', () => {
  it('preserves current visible candidates when an unfinished offscreen target completes after the camera returns', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const icon = addPointTile(renderer, 'returning', 3, layer, undefined, true);
    twoWidePoints(icon);
    for (let vertex = 8; vertex < 12; vertex++) {
      icon.positions[vertex * 3] = 0.02;
      icon.positions[vertex * 3 + 1] = 0;
      icon.offsets[vertex * 2] *= 5;
      icon.offsets[vertex * 2 + 1] *= 5;
    }
    const visible = () => icon.instances.map(instance => icon.opacities[instance.vertexStart]);
    let gpuOpacity: number[] = [];
    const upload = vi.fn((values: Float32Array) => {
      gpuOpacity = Array.from(values);
    });
    const gpuVisible = () => icon.instances.map(instance => gpuOpacity[instance.vertexStart]);
    const onePair = { exhausted: true, takeMinimumProgress: () => true };
    try {
      renderer.update(VIEW, false);
      expect(visible()).toEqual([1, 1, 0]);
      const primitive = renderer.getTileCollections('returning')[0].get(0);
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      renderer.update(VIEW, false);
      expect(gpuVisible()).toEqual([1, 1, 0]);
      const offscreen = new Float64Array(VIEW.viewProjection);
      offscreen[12] = 3;
      now = 300;
      renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: offscreen }, true, undefined, operation => operation(onePair));
      expect(renderer.hasRunnableWork).toBe(true);
      expect(visible()).toEqual([0, 0, 0]);
      expect(gpuVisible()).toEqual([0, 0, 0]);
      renderer.update(VIEW, true, undefined, operation => operation(onePair));
      expect(renderer.hasRunnableWork).toBe(true);
      expect(visible()).toEqual([1, 1, 0]);
      expect(gpuVisible()).toEqual([1, 1, 0]);
      // The third offscreen pair completes the old frozen target now. The
      // current-view target is still pending and cannot select the hidden point.
      renderer.update(VIEW, false, undefined, operation => operation(onePair));
      expect(renderer.hasPendingWork).toBe(true);
      expect(renderer.hasRunnableWork).toBe(false);
      expect(renderer.nextPlacementTime).toBe(600);
      expect(visible()).toEqual([1, 1, 0]);
      expect(gpuVisible()).toEqual([1, 1, 0]);
      now = 600;
      renderer.update(VIEW, false, undefined, operation => operation(UNBOUNDED_BUDGET));
      expect(renderer.hasPendingWork).toBe(false);
      expect(visible()).toEqual([1, 1, 0]);
      expect(gpuVisible()).toEqual([1, 1, 0]);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('filters the completed selection in the current view while an exhausted target remains unfinished, then restores that selection', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const icon = addPointTile(renderer, 'selected', 3, layer, undefined, true);
    twoWidePoints(icon);
    for (let vertex = 8; vertex < 12; vertex++) {
      icon.positions[vertex * 3] = 0.02;
      icon.positions[vertex * 3 + 1] = 0;
      icon.offsets[vertex * 2] *= 5;
      icon.offsets[vertex * 2 + 1] *= 5;
    }
    const visible = () => icon.instances.map(instance => icon.opacities[instance.vertexStart]);
    const upload = vi.fn();
    try {
      renderer.update(VIEW, false);
      expect(visible()).toEqual([1, 1, 0]);
      const primitive = renderer.getTileCollections('selected')[0].get(0);
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      renderer.update(VIEW, false);
      upload.mockClear();
      const projection = new Float64Array(VIEW.viewProjection);
      projection[0] = projection[5] = 0.25;
      let minimumProgress = true;
      const spent = { exhausted: true, takeMinimumProgress: () => {
        const admitted = minimumProgress;
        minimumProgress = false;
        return admitted;
      } };
      renderer.cameraZoom = 8;
      now = 300;
      renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: projection }, true, undefined, operation => operation(spent));
      expect(renderer.hasRunnableWork).toBe(true);
      expect(visible()).toEqual([1, 0, 0]);
      expect(upload).toHaveBeenCalledWith(icon.opacities, 0);
      upload.mockClear();
      renderer.cameraZoom = 10;
      renderer.update(VIEW, true, undefined, operation => operation(spent));
      expect(renderer.hasRunnableWork).toBe(true);
      expect(visible()).toEqual([1, 1, 0]);
      expect(upload).toHaveBeenCalledWith(icon.opacities, 0);
      projection[0] = projection[5] = 4;
      renderer.cameraZoom = 12;
      renderer.update({ ...VIEW, cameraZoom: 12, viewProjection: projection }, true, undefined, operation => operation(spent));
      // The third point now fits, but only a completed target may promote it.
      expect(visible()).toEqual([1, 1, 0]);
      const expanded = { ...VIEW, cameraZoom: 12, viewProjection: projection };
      renderer.update(expanded, false, undefined, operation => operation({ exhausted: false }));
      // The unfinished zoom-eight target kept its frozen view through both
      // reversals. Its stale result cannot replace the visible baseline.
      expect(visible()).toEqual([1, 1, 0]);
      expect(renderer.hasPendingWork).toBe(true);
      expect(renderer.hasRunnableWork).toBe(false);
      expect(renderer.nextPlacementTime).toBe(600);
      now = 599;
      renderer.update(expanded, false, undefined, operation => operation({ exhausted: false }));
      expect(visible()).toEqual([1, 1, 0]);
      now = 600;
      renderer.update(expanded, false, undefined, operation => operation({ exhausted: false }));
      expect(visible()).toEqual([1, 1, 1]);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('uses style priority before tile ordering when filtering completed candidates', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const low = addPointTile(renderer, 'a-low', 1, new SymbolStyleLayer({ id: 'low', type: 'symbol', source: 'source' }, {}), undefined, false, 0);
    const high = addPointTile(renderer, 'z-high', 1, new SymbolStyleLayer({ id: 'high', type: 'symbol', source: 'source' }, {}), undefined, false, 8);
    for (const [icon, x] of [[low, -0.04], [high, 0.04]] as const) {
      movePoint(icon, x);
      icon.instances[0].minX = icon.instances[0].minY = -10;
      icon.instances[0].maxX = icon.instances[0].maxY = 10;
      for (let i = 0; i < icon.offsets.length; i++)
        icon.offsets[i] *= 5;
    }
    renderer.update(VIEW, false);
    expect([low.opacities[0], high.opacities[0]]).toEqual([1, 1]);
    const projection = new Float64Array(VIEW.viewProjection);
    projection[0] = 0.25;
    renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: projection }, true, undefined, operation => operation({ exhausted: true }));
    expect([low.opacities[0], high.opacities[0]]).toEqual([0, 1]);
    renderer.removeAll();
  });

  it('advances both tilesets by bounded collision pairs during shared Scene overload', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const renderers = [new SymbolTileRenderer(), new SymbolTileRenderer()];
    const leases = renderers.map(renderer => acquireSceneFrameBudget(scene, renderer));
    const checks = renderers.map(() => vi.fn(() => {
      now += 0.1;
      return true;
    }));
    const geometries = renderers.map(renderer => addPointTile(renderer, 'tile', 100));
    const runnable = { upload: false, build: true, paint: false, placement: true };
    try {
      for (let frame = 0; frame < 24; frame++) {
        now = frame * 100;
        scene.preUpdate.raiseEvent();
        const work = leases.map(lease => lease.frame(frame));
        now += 50;
        const before = checks.map(check => check.mock.calls.length);
        renderers.forEach((renderer, index) => {
          renderer.update(
            { ...VIEW, isPointVisible: checks[index] },
            false,
            undefined,
            operation => work[index].run('placement', runnable, operation),
          );
        });
        const pairs = checks.reduce((sum, check, index) => sum + check.mock.calls.length - before[index], 0);
        expect(pairs).toBeLessThanOrEqual(26);
        expect(checks.filter((check, index) => check.mock.calls.length !== before[index])).toHaveLength(pairs ? 1 : 0);
        scene.postRender.raiseEvent();
      }
      expect(checks.map(check => check.mock.calls.length)).toEqual([100, 100]);
      expect(renderers.every(renderer => renderer.isTilePlaced('tile'))).toBe(true);
      expect(geometries.every(geometry => geometry.opacities.every(opacity => opacity === 1))).toBe(true);
    }
    finally {
      leases.forEach(lease => lease.release());
      renderers.forEach(renderer => renderer.removeAll());
    }
  });

  it('yields on elapsed time and publishes a complete layout together', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const icon = addPointTile(renderer, 'tile', 32);
    const isPointVisible = vi.fn(() => {
      now += 0.25;
      return true;
    });
    const view = { ...VIEW, isPointVisible };

    for (let frame = 0; frame < 3; frame++) {
      renderer.update(view, false);
      expect(isPointVisible).toHaveBeenCalledTimes((frame + 1) * 8);
      expect(renderer.isTilePlaced('tile')).toBe(false);
      expect(icon.opacities.every(opacity => opacity === 0)).toBe(true);
    }
    renderer.update(view, false);

    expect(renderer.isTilePlaced('tile')).toBe(true);
    expect(icon.opacities.every(opacity => opacity === 1)).toBe(true);
    expect(renderer.hasPendingWork).toBe(false);
  });

  function heldAndPreparedTarget(): {
    renderer: SymbolTileRenderer;
    held: SymbolPrimitiveGeometry;
    unaffected: SymbolPrimitiveGeometry;
    target: SymbolPrimitiveGeometry;
  } {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const held = addPointTile(renderer, 'a-held', 2);
    twoWidePoints(held);
    const unaffected = addPointTile(renderer, 'z-unaffected', 1);
    movePoint(unaffected, 0.04);
    renderer.update(VIEW, false);
    renderer.setTilePlacementEligible('a-held', false);
    const target = addPointTile(renderer, 'b-target', 1);
    movePoint(target, -0.04);
    renderer.setTilePlacementVisible('b-target', false);
    const zoomedOut = new Float64Array(VIEW.viewProjection);
    zoomedOut[0] = 0.25;
    renderer.update({ ...VIEW, viewProjection: zoomedOut, cameraZoom: 8 }, true);
    return { renderer, held, unaffected, target };
  }

  it('atomically activates target and unaffected tile decisions at the owner handoff', () => {
    const { renderer, unaffected, target } = heldAndPreparedTarget();

    renderer.setTilePlacementVisible('a-held', false);
    renderer.setTilePlacementVisible('b-target', true);

    expect(renderer.activatePreparedPlacement()).toBe(true);
    expect(unaffected.opacities[0]).toBe(1);
    expect(target.opacities[0]).toBe(1);
    expect(renderer.activatePreparedPlacement()).toBe(false);
  });

  it('rejects a superseded tile in a prepared partial handoff', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    addPointTile(renderer, 'held', 1);
    addPointTile(renderer, 'other-held', 1);
    renderer.update(VIEW, false);
    renderer.setTilePlacementEligible('held', false);
    renderer.setTilePlacementEligible('other-held', false);
    addPointTile(renderer, 'target', 1);
    renderer.setTilePlacementVisible('target', false);
    renderer.update(VIEW, false);
    const owners = new Set(['target', 'other-held']);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(false);
    renderer.update(VIEW, false);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(true);

    addPointTile(renderer, 'target', 1);

    expect(renderer.prepareVisiblePlacement(owners)).toBe(false);
    renderer.setTilePlacementVisible('held', false);
    renderer.setTilePlacementVisible('target', true);
    expect(renderer.activatePreparedPlacement()).toBe(false);
  });
});
