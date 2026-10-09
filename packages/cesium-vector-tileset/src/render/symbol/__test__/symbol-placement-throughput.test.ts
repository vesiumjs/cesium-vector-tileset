import type { RenderFrameState } from '../../scene/render-frame';
import type { TilesetRenderer } from '../../scene/tileset-renderer';
import type { SymbolPrimitiveGeometry, SymbolTileGeometry } from '../symbol-geometry';
import type { PlacementView } from '../symbol-placement';
import { Cartesian3, Color, Event, Primitive, PrimitiveCollection, PrimitiveType } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../../cesium-vector-tileset';
import { CollisionBoxArray } from '../../../data/array-types.g';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { SymbolStyleLayer } from '../../../style/style-layer/symbol-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { cameraFrame } from '../../scene/__test__/camera-helper';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { captureCameraForFrame } from '../../scene/render-frame';
import { SceneCollections } from '../../scene/scene-collections';
import { acquireSceneFrameBudget } from '../../scene/scene-frame-budget';
import { symbolGroundPosition } from '../symbol-perspective';
import { INVALID_LINE_ANGLE, SymbolProjectionContext, updateLineSymbolGeometry } from '../symbol-placement';
import { copyPlacementView, SymbolPlacementPass } from '../symbol-placement-pass';
import { beginSymbolBuild, buildSymbolHalves, mergeSymbolHalves, SymbolTileRenderer, syncHalfDynamic, syncHalfOpacity } from '../symbol-renderer';

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

function updateSymbolCollection(collection: PrimitiveCollection, frameState: unknown): void {
  (collection as PrimitiveCollection & { update: (state: unknown) => void }).update(frameState);
}

function lineGeometry(anchors: readonly number[], glyphOffset = 0): SymbolPrimitiveGeometry {
  const icon = pointGeometry(anchors.length);
  for (let index = 0; index < anchors.length; index++) {
    const x = anchors[index];
    const instance = icon.instances[index];
    instance.minX = instance.minY = -10;
    instance.maxX = instance.maxY = 10;
    instance.line = { anchorECEF: { x, y: 0, z: 0 }, pathECEF: new Float64Array([x - 0.1, 0, 0, x + 0.1, 0, 0]), segment: 0, glyphOffsets: new Float32Array([glyphOffset]), lineOffsetX: 0, lineOffsetY: 0, keepUpright: true, rotateToLine: true, writingMode: 0 };
    for (let corner = 0; corner < 4; corner++) {
      const vertex = instance.vertexStart + corner;
      icon.positions[vertex * 3] = x;
      icon.positions[vertex * 3 + 1] = 0;
      icon.offsets[vertex * 2] *= 5;
      icon.offsets[vertex * 2 + 1] *= 5;
    }
  }
  return icon;
}

function addLineTile(renderer: SymbolTileRenderer, tileId: string, geometry: SymbolPrimitiveGeometry): void {
  const layer = new SymbolStyleLayer({ id: 'lines', type: 'symbol', source: 'source' }, {});
  addPointTile(renderer, tileId, geometry.instances.length, layer, undefined, true, undefined, geometry);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('symbol placement throughput through renderer updates', () => {
  it('projects only the two baseline lines in a dense batch and streams their current rotation without visiting hidden instances', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const icon = lineGeometry(Array.from({ length: 1000 }, (_, index) => index === 0 ? -0.04 : index === 1 ? 0.04 : 0.02), 10);
    addLineTile(renderer, 'dense-lines', icon);
    let gpuDynamic: number[] = [];
    try {
      renderer.update(VIEW, false);
      expect(icon.instances.filter(instance => icon.opacities[instance.vertexStart]).length).toBe(2);
      const primitive = renderer.getTileCollections('dense-lines')[0].get(0);
      const upload = (values: Float32Array): void => {
        gpuDynamic = Array.from(values);
      };
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0, a_dynamic: 1 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: vi.fn() } }, { index: 1, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      renderer.update(VIEW, false);
      let hiddenReads = 0;
      icon.instances = new Proxy(icon.instances, { get: (target, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= 2)
          hiddenReads++;
        return Reflect.get(target, key, receiver);
      } });
      const isPointVisible = vi.fn(() => true);
      const rotation = new Float64Array(VIEW.viewProjection);
      rotation[0] = rotation[5] = 0;
      rotation[1] = 1;
      rotation[4] = -1;
      renderer.cameraZoom = 8;
      renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: rotation, isPointVisible }, true, undefined, operation => operation({ exhausted: true }));
      // Each live path is shared with its selected collision box; the box's
      // baked anchor check remains. The unfinished target admits no pair.
      expect.soft(isPointVisible).toHaveBeenCalledTimes(4);
      expect(hiddenReads).toBe(0);
      expect(gpuDynamic[0]).toBeCloseTo(0);
      expect(gpuDynamic[1]).toBeCloseTo(-0.41666667);
      expect(gpuDynamic[2]).toBeCloseTo(-Math.PI / 2);
      expect(icon.opacities[0]).toBe(1);
      expect(icon.opacities[4]).toBe(1);
      expect(icon.opacities.subarray(8).every(opacity => opacity === 0)).toBe(true);
      renderer.cameraZoom = 7;
      renderer.update({ ...VIEW, cameraZoom: 7, viewProjection: rotation, isPointVisible: () => false }, true, undefined, operation => operation({ exhausted: true }));
      expect(gpuDynamic[2]).toBe(INVALID_LINE_ANGLE);
      expect(gpuDynamic[14]).toBe(INVALID_LINE_ANGLE);
      expect(icon.opacities.every(opacity => opacity === 0)).toBe(true);
      renderer.cameraZoom = 10;
      renderer.update(VIEW, true, undefined, operation => operation({ exhausted: true }));
      expect(gpuDynamic[0]).toBeCloseTo(0.41666667);
      expect(gpuDynamic[1]).toBeCloseTo(0);
      expect(gpuDynamic[2]).toBe(0);
      expect(icon.opacities[0]).toBe(1);
      expect(icon.opacities[4]).toBe(1);
      for (let vertex = 0; vertex < 8; vertex++) {
        icon.sizeZooms[vertex * 2] = 10;
        icon.sizeZooms[vertex * 2 + 1] = 12;
        icon.sizesMax[vertex] = 2 * 128;
      }
      renderer.cameraZoom = 12;
      renderer.update({ ...VIEW, cameraZoom: 12 }, true, undefined, operation => operation({ exhausted: true }));
      expect(gpuDynamic[0]).toBeCloseTo(0.83333333);
      expect(hiddenReads).toBe(0);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('reprojects in-place line and size changes on the next update with the same view object', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const geometry = lineGeometry([0], 10);
    const isPointVisible = vi.fn(() => true);
    const view = { ...VIEW, isPointVisible };
    addLineTile(renderer, 'moving-line', geometry);
    let uploaded: number[] = [];
    const vertexArray = { _attributes: [
      { index: 0, vertexBuffer: { copyFromArrayView: vi.fn() } },
      { index: 1, vertexBuffer: { copyFromArrayView: (values: Float32Array) => { uploaded = Array.from(values); } } },
    ], destroy: vi.fn() };
    try {
      renderer.update(view, false);
      const primitive = renderer.getTileCollections('moving-line')[0].get(0);
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0, a_dynamic: 1 }, _va: [vertexArray] });
      renderer.update(view, false);
      expect(uploaded[0]).toBeCloseTo(10 / 24);
      geometry.instances[0].line!.pathECEF.set([0, -0.1, 0, 0, 0.1, 0]);
      geometry.sizes.fill(2 * 128 * 4);
      view.cameraZoom = 11;
      isPointVisible.mockClear();
      renderer.update(view, true, undefined, operation => operation({ exhausted: true }));
      expect(isPointVisible).toHaveBeenCalledTimes(2);
      expect(uploaded[0]).toBeCloseTo(0);
      expect(uploaded[1]).toBeCloseTo(-20 / 24);
      expect(uploaded[2]).toBeCloseTo(-Math.PI / 2);
      expect(geometry.opacities[0]).toBe(1);

      geometry.instances[0].line!.glyphOffsets[0] = 20;
      view.cameraZoom = 12;
      isPointVisible.mockClear();
      renderer.update(view, true, undefined, operation => operation({ exhausted: true }));
      expect(isPointVisible).toHaveBeenCalledTimes(2);
      expect(uploaded[1]).toBeCloseTo(-40 / 24);
      expect((primitive as unknown as { _va: unknown[] })._va[0]).toBe(vertexArray);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('keeps a frozen pass view separate from live line projection even when its values match', () => {
    const geometry = lineGeometry([0], 10);
    const isPointVisible = vi.fn(() => true);
    const view = { ...VIEW, isPointVisible };
    const projections = new SymbolProjectionContext();
    updateLineSymbolGeometry(geometry, view, geometry.instances.keys(), projections);
    expect(isPointVisible).toHaveBeenCalledOnce();
    const pairs = [{ text: -1, icon: 0 }];
    const batch = { geometry: { icon: geometry, pairs }, options: { pairs } };
    const frozen = copyPlacementView(view);
    const pass = new SymbolPlacementPass([batch], frozen);
    expect(pass.advance(UNBOUNDED_BUDGET, projections)).toBe(true);
    // A different view object needs its own path, plus the baked anchor gate.
    expect(isPointVisible).toHaveBeenCalledTimes(3);
    pass.commit(() => true, () => {});
    expect(geometry.opacities[0]).toBe(1);
    expect(geometry.dynamics[0]).toBeCloseTo(10 / 24);
  });

  it('fills current GPU dynamics when a stable-view complete selection promotes a formerly hidden line', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const icon = lineGeometry([-0.04, 0.04, 0.02], 10);
    addLineTile(renderer, 'promoted-line', icon);
    let gpuDynamic: number[] = [];
    try {
      renderer.update(VIEW, false);
      expect([icon.opacities[0], icon.opacities[4], icon.opacities[8]]).toEqual([1, 1, 0]);
      expect(icon.dynamics[24]).toBe(0);
      const primitive = renderer.getTileCollections('promoted-line')[0].get(0);
      const upload = (values: Float32Array): void => {
        gpuDynamic = Array.from(values);
      };
      const vertexArrays = [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: vi.fn() } }, { index: 1, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }];
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0, a_dynamic: 1 }, _va: vertexArrays });
      renderer.update(VIEW, false);
      const expanded = new Float64Array(VIEW.viewProjection);
      expanded[0] = 4;
      const view = { ...VIEW, cameraZoom: 12, viewProjection: expanded };
      renderer.cameraZoom = 12;
      // Start the frozen catch-up once the preceding placement is no longer recent.
      now = 300;
      renderer.update(view, true, undefined, operation => operation({ exhausted: true }));
      expect(icon.opacities[8]).toBe(0);
      expect(gpuDynamic[24]).toBe(0);
      renderer.update(view, false, undefined, operation => operation({ exhausted: false }));
      expect([icon.opacities[0], icon.opacities[4], icon.opacities[8]]).toEqual([1, 1, 1]);
      expect(gpuDynamic[24]).toBeCloseTo(0.41666667);
      expect((primitive as Primitive & { _va: unknown })._va).toBe(vertexArrays);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('fills selected line dynamics before the first Native upload and finishes pending copies after ready', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const icon = lineGeometry([0], 10);
    addLineTile(renderer, 'cold-line', icon);
    let gpuDynamic: number[] = [];
    try {
      renderer.update(VIEW, false);
      expect(icon.opacities[0]).toBe(1);
      expect(icon.dynamics[0]).toBeCloseTo(0.41666667);
      expect(renderer.hasPendingWork).toBe(true);
      const primitive = renderer.getTileCollections('cold-line')[0].get(0);
      const upload = (values: Float32Array): void => {
        gpuDynamic = Array.from(values);
      };
      Object.assign(primitive, { _attributeLocations: { a_opacity: 0, a_dynamic: 1 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: vi.fn() } }, { index: 1, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      renderer.update(VIEW, false);
      expect(primitive.ready).toBe(false);
      expect(gpuDynamic[0]).toBeCloseTo(0.41666667);
      expect(renderer.hasPendingWork).toBe(true);
      Object.assign(primitive, { _ready: true });
      renderer.update(VIEW, false);
      expect(gpuDynamic[0]).toBeCloseTo(0.41666667);
      expect(renderer.hasPendingWork).toBe(false);
      expect(renderer.isTilePlacementActive('cold-line')).toBe(true);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('updates held and fading line generations while an unselected replacement only drains its pending VBO', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const held = lineGeometry([-0.5], 10);
    const fading = lineGeometry([0.5], 10);
    addLineTile(renderer, 'held-line', held);
    addLineTile(renderer, 'fading-line', fading);
    const gpuDynamic = new Map<string, number[]>();
    const expose = (tileId: string, ready: boolean): Primitive => {
      const primitive = renderer.getTileCollections(tileId)[0].get(0);
      const upload = (values: Float32Array): void => {
        gpuDynamic.set(tileId, Array.from(values));
      };
      Object.assign(primitive, { _ready: ready, _attributeLocations: { a_opacity: 0, a_dynamic: 1 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: vi.fn() } }, { index: 1, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      return primitive;
    };
    try {
      renderer.update(VIEW, false);
      expose('held-line', true);
      const fadingPrimitive = expose('fading-line', true);
      Object.assign(fadingPrimitive, { getGeometryInstanceAttributes: () => ({}) });
      renderer.update(VIEW, false);
      expect(renderer.retireTile('fading-line').fading).toHaveLength(1);
      const replacement = lineGeometry([0.8], 10);
      addLineTile(renderer, 'held-line', replacement);
      const rotation = new Float64Array(VIEW.viewProjection);
      rotation[0] = rotation[5] = 0;
      rotation[1] = 1;
      rotation[4] = -1;
      const view = { ...VIEW, cameraZoom: 8, viewProjection: rotation };
      renderer.update(view, true, undefined, operation => operation({ exhausted: true }));
      expect(gpuDynamic.get('held-line')![1]).toBeCloseTo(-0.41666667);
      expect(gpuDynamic.get('held-line')![2]).toBeCloseTo(-Math.PI / 2);
      expect(gpuDynamic.get('fading-line')![1]).toBeCloseTo(-0.41666667);
      expect(gpuDynamic.get('fading-line')![2]).toBeCloseTo(-Math.PI / 2);
      expect(replacement.opacities.every(opacity => opacity === 0)).toBe(true);
      expect(replacement.dynamics.every(value => value === 0)).toBe(true);
      expect(renderer.isTilePlacementActive('held-line')).toBe(false);
      const newPrimitive = expose('held-line', true);
      renderer.update(view, false, undefined, operation => operation({ exhausted: true }));
      expect(gpuDynamic.get('held-line')!.every(value => value === 0)).toBe(true);
      const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
      newPrimitive.update();
      // Its pending zero streams completed: no stuck dynamic dirty flag can
      // force an empty ready owner through Native while placement is pending.
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(held.opacities[0]).toBe(1);
      expect(fading.opacities[0]).toBe(1);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('projects only the eligible half of a selected optional text/icon pair', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const blocker = addPointTile(renderer, 'a-blocker', 1);
    movePoint(blocker, 0);
    const text = lineGeometry([0.2], 10);
    const icon = lineGeometry([0], 10);
    const layer = new SymbolStyleLayer({ id: 'paired', type: 'symbol', source: 'source', layout: { 'icon-optional': true } }, {});
    layer.recalculate(new EvaluationParameters(10), []);
    addPointTile(renderer, 'z-paired', 1, layer, text, true, undefined, icon);
    try {
      renderer.update(VIEW, false);
      expect([text.opacities[0], icon.opacities[0]]).toEqual([1, 0]);
      expect(text.dynamics[0]).toBeCloseTo(0.41666667);
      expect(icon.dynamics.every(value => value === 0)).toBe(true);
      let hiddenReads = 0;
      icon.instances = new Proxy(icon.instances, { get: (target, key, receiver) => {
        if (key === '0')
          hiddenReads++;
        return Reflect.get(target, key, receiver);
      } });
      const rotation = new Float64Array(VIEW.viewProjection);
      rotation[0] = rotation[5] = 0;
      rotation[1] = 1;
      rotation[4] = -1;
      renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: rotation }, true, undefined, operation => operation({ exhausted: true }));
      expect(text.dynamics[1]).toBeCloseTo(-0.41666667);
      expect(icon.dynamics.every(value => value === 0)).toBe(true);
      expect(hiddenReads).toBe(0);
      expect([text.opacities[0], icon.opacities[0]]).toEqual([1, 0]);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('does not rescan visibility while Native opacity uploads remain pending, then caches the final GPU values', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    const icon = pointGeometry(100);
    icon.opacityDirty = true;
    const halves = buildSymbolHalves({ tileId: 'pending', layerId: 'labels', geometry: { icon, pairs: icon.instances.map((_, icon) => ({ icon, text: -1 })) }, iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'pending-atlas' }, textColor: Color.WHITE, iconColor: Color.WHITE, pixelRatio: 1 });
    const merged = mergeSymbolHalves('pending', halves)!;
    const primitive = merged.primitives[0].primitive;
    const scan = vi.spyOn(icon.opacities, 'some');
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const frame = { commandList: [] };
    let gpuOpacity: number[] = [];
    try {
      for (let index = 0; index < 4; index++) {
        syncHalfOpacity(halves[0]);
        updateSymbolCollection(merged.collection, frame);
      }
      expect(icon.opacityDirty).toBe(true);
      expect(primitive.ready).toBe(false);
      expect(nativeUpdate).toHaveBeenCalledTimes(4);
      expect(scan).not.toHaveBeenCalled();
      const upload = vi.fn((values: Float32Array) => {
        gpuOpacity = Array.from(values);
      });
      Object.assign(primitive, { _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      icon.opacities.fill(1);
      for (let index = 0; index < 4; index++) {
        syncHalfOpacity(halves[0]);
        updateSymbolCollection(merged.collection, frame);
      }
      expect(icon.opacityDirty).toBe(true);
      expect(gpuOpacity.every(opacity => opacity === 1)).toBe(true);
      expect(nativeUpdate).toHaveBeenCalledTimes(8);
      expect(scan).not.toHaveBeenCalled();
      Object.assign(primitive, { _ready: true });
      syncHalfOpacity(halves[0]);
      expect(scan).toHaveBeenCalledOnce();
      expect(icon.opacityDirty).toBe(false);
      expect(upload).toHaveBeenLastCalledWith(icon.opacities, 0);
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledTimes(9);
      icon.opacities.fill(0);
      icon.opacityDirty = true;
      syncHalfOpacity(halves[0]);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(gpuOpacity.every(opacity => opacity === 0)).toBe(true);
      expect(icon.opacityDirty).toBe(false);
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledTimes(9);
    }
    finally {
      merged.collection.destroy();
      halves[0].material.destroy();
    }
  });

  it('skips ready empty Native owners across all merged halves and restores the same owner resources', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    const icon = pointGeometry(1);
    icon.instances[0].line = { anchorECEF: { x: 0, y: 0, z: 0 }, pathECEF: new Float64Array([0, 0, 0, 0.1, 0, 0]), segment: 0, glyphOffsets: new Float32Array([0]), lineOffsetX: 0, lineOffsetY: 0, keepUpright: true, rotateToLine: true, writingMode: 0 };
    const sibling = pointGeometry(1);
    const text = pointGeometry(1);
    for (const geometry of [icon, sibling, text])
      geometry.opacityDirty = true;
    const atlas = { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'owner-atlas' };
    const options = { tileId: 'owners', layerId: 'labels', textColor: Color.WHITE, iconColor: Color.WHITE, pixelRatio: 1, iconAtlas: atlas, textAtlas: atlas };
    const halves = buildSymbolHalves({ ...options, geometry: { icon, text, pairs: [{ icon: 0, text: 0 }] } });
    halves.push(...buildSymbolHalves({ ...options, iconMaterial: halves[0].material, geometry: { icon: sibling, pairs: [{ icon: 0, text: -1 }] } }));
    const merged = mergeSymbolHalves('owners', halves)!;
    expect(merged.primitives).toHaveLength(2);
    const owners = merged.primitives.map(entry => entry.primitive);
    expect((owners[0].geometryInstances as unknown[]).length).toBe(2);
    const resources = owners.map(owner => ({ instances: owner.geometryInstances, appearance: owner.appearance }));
    const vertexArrays: unknown[] = [];
    const materials = halves.map(half => ({ material: half.material, texture: half.material.uniforms.u_texture }));
    const frame = { commandList: [] as Array<{ owner: Primitive; primitiveType: number }> };
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (this: Primitive) {
      frame.commandList.push({ owner: this, primitiveType: PrimitiveType.POINTS });
    });
    const uploads = owners.map(() => vi.fn());
    try {
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      expect(frame.commandList.map(command => command.primitiveType)).toEqual([PrimitiveType.TRIANGLES, PrimitiveType.TRIANGLES]);
      for (let index = 0; index < owners.length; index++) {
        Object.assign(owners[index], { _attributeLocations: { a_opacity: 0, a_dynamic: 1 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: uploads[index] } }, { index: 1, vertexBuffer: { copyFromArrayView: uploads[index] } }], destroy: vi.fn() }] });
        vertexArrays.push((owners[index] as Primitive & { _va: unknown })._va);
      }
      for (const half of halves)
        syncHalfOpacity(half);
      syncHalfDynamic(halves[0]);
      expect(halves.every(half => half.opacity!.geometry.opacityDirty)).toBe(true);
      expect(halves[0].dynamic!.dirty).toBe(true);
      nativeUpdate.mockClear();
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      for (const owner of owners)
        Object.assign(owner, { _ready: true });
      for (const half of halves)
        syncHalfOpacity(half);
      syncHalfDynamic(halves[0]);
      expect(halves.every(half => !half.opacity!.geometry.opacityDirty)).toBe(true);
      expect(halves[0].dynamic!.dirty).toBe(false);
      const reads = [icon, sibling, text].map((geometry) => {
        const values = geometry.opacities;
        const read = vi.fn(() => values);
        Object.defineProperty(geometry, 'opacities', { get: read, configurable: true });
        return read;
      });
      nativeUpdate.mockClear();
      frame.commandList.length = 0;
      for (let index = 0; index < 5; index++)
        updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(frame.commandList).toHaveLength(0);
      expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
      sibling.opacities.fill(1);
      sibling.opacityDirty = true;
      syncHalfOpacity(halves[2]);
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(frame.commandList.map(command => command.owner)).toEqual([owners[0]]);
      expect(uploads[0]).toHaveBeenLastCalledWith(sibling.opacities, icon.opacities.byteLength);
      sibling.opacities.fill(0);
      sibling.opacityDirty = true;
      syncHalfOpacity(halves[2]);
      nativeUpdate.mockClear();
      frame.commandList.length = 0;
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).not.toHaveBeenCalled();
      icon.opacityDirty = true;
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      syncHalfOpacity(halves[0]);
      nativeUpdate.mockClear();
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).not.toHaveBeenCalled();
      halves[0].dynamic!.dirty = true;
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      syncHalfDynamic(halves[0]);
      expect(halves[0].dynamic!.dirty).toBe(false);
      nativeUpdate.mockClear();
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).not.toHaveBeenCalled();
      const batchTable = { _batchValuesDirty: true, destroy: vi.fn() };
      Object.assign(owners[0], { _batchTable: batchTable });
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      batchTable._batchValuesDirty = false;
      nativeUpdate.mockClear();
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).not.toHaveBeenCalled();
      for (let index = 0; index < owners.length; index++) {
        expect(owners[index].geometryInstances).toBe(resources[index].instances);
        expect(owners[index].appearance).toBe(resources[index].appearance);
        expect((owners[index] as Primitive & { _va: unknown })._va).toBe(vertexArrays[index]);
        expect(owners[index].ready).toBe(true);
      }
      for (let index = 0; index < halves.length; index++) {
        expect(halves[index].material).toBe(materials[index].material);
        expect(halves[index].material.uniforms.u_texture).toBe(materials[index].texture);
      }
    }
    finally {
      merged.collection.destroy();
      for (const material of new Set(halves.map(half => half.material)))
        material.destroy();
    }
  });

  it('settles an empty cold symbol through SceneCollections first updates and keeps it drawable for readiness queries', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    const icon = pointGeometry(1);
    icon.opacityDirty = true;
    const halves = buildSymbolHalves({ tileId: 'empty', layerId: 'labels', geometry: { icon, pairs: [{ icon: 0, text: -1 }] }, iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'empty-atlas' }, textColor: Color.WHITE, iconColor: Color.WHITE, pixelRatio: 1 });
    const merged = mergeSymbolHalves('empty', halves)!;
    const primitive = merged.primitives[0].primitive;
    const root = new PrimitiveCollection();
    const collections = new SceneCollections(root, vi.fn(), () => true);
    collections.add(merged.collection);
    collections.queueFirstUpdate([merged.collection], false);
    const frame = { commandList: [] as Array<{ owner: Primitive; primitiveType: number }>, afterRender: [] as Array<() => void> };
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (this: Primitive) {
      const attribute = { index: 0, vertexBuffer: { copyFromArrayView: vi.fn(), sizeInBytes: icon.opacities.byteLength } };
      Object.assign(this, { _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [attribute], numberOfAttributes: 1, getAttribute: () => attribute, destroy: vi.fn() }] });
      frame.commandList.push({ owner: this, primitiveType: PrimitiveType.POINTS });
      frame.afterRender.push(() => Object.assign(this, { _ready: true }));
    });
    const drawable = () => collections.someDrawableCollection('empty', 'symbol', predicate => predicate(merged.collection), collection => collection === primitive || collection === merged.collection);
    try {
      expect(drawable()).toBe(false);
      collections.pumpFirstUpdates(frame as never, { exhausted: false });
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(primitive.ready).toBe(false);
      expect(drawable()).toBe(true);
      syncHalfOpacity(halves[0]);
      expect(icon.opacityDirty).toBe(true);
      for (const finish of frame.afterRender)
        finish();
      syncHalfOpacity(halves[0]);
      expect(primitive.ready).toBe(true);
      expect(icon.opacityDirty).toBe(false);
      collections.pumpFirstUpdates(frame as never, { exhausted: false });
      expect(collections.hasPendingFirstUpdate(merged.collection)).toBe(false);
      expect(drawable()).toBe(true);
      frame.commandList.length = 0;
      updateSymbolCollection(merged.collection, frame);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(frame.commandList).toHaveLength(0);
    }
    finally {
      root.destroy();
      halves[0].material.destroy();
    }
  });

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

  it('holds a displayed generation when its same-tile successor finishes stale and empty', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const old = addPointTile(renderer, 'tile', 1);
    movePoint(old, 0);
    const onePair = { exhausted: true, takeMinimumProgress: () => true };
    try {
      renderer.update(VIEW, false);
      expect(old.opacities[0]).toBe(1);
      const replacement = addPointTile(renderer, 'tile', 3);
      renderer.update({ ...VIEW, cameraZoom: 8, isPointVisible: x => x >= -0.5 }, true, undefined, operation => operation(onePair));
      for (let frame = 0; frame < 12 && !renderer.isTilePlaced('tile'); frame++)
        renderer.update(VIEW, frame === 0, undefined, operation => operation(onePair));
      expect(renderer.isTilePlaced('tile')).toBe(true);
      expect(replacement.instances.map(instance => replacement.opacities[instance.vertexStart])).toEqual([0, 0, 0]);
      expect(renderer.prepareVisiblePlacement(new Set(['tile']))).toBe(false);
      expect(old.opacities[0]).toBe(1);
      renderer.update(VIEW, false);
      expect(renderer.prepareVisiblePlacement(new Set(['tile']))).toBe(true);
      expect(renderer.activatePreparedPlacement()).toBe(true);
      expect(replacement.instances.map(instance => replacement.opacities[instance.vertexStart])).toEqual([1, 1, 1]);
    }
    finally { renderer.removeAll(); }
  });

  it('allows a stale empty first owner when there is no displayed cover to retire', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const points = addPointTile(renderer, 'first', 3);
    renderer.setTilePlacementVisible('first', false);
    const onePair = { exhausted: true, takeMinimumProgress: () => true };
    try {
      renderer.update({ ...VIEW, cameraZoom: 8, isPointVisible: () => false }, true, undefined, operation => operation(onePair));
      for (let frame = 0; frame < 12 && !renderer.isTilePlaced('first'); frame++)
        renderer.update(VIEW, frame === 0, undefined, operation => operation(onePair));
      expect(renderer.isTilePlaced('first')).toBe(true);
      expect(points.instances.map(instance => points.opacities[instance.vertexStart])).toEqual([0, 0, 0]);
      expect(renderer.prepareVisiblePlacement(new Set(['first']))).toBe(true);
      renderer.setTilePlacementVisible('first', true);
      expect(renderer.activatePreparedPlacement()).toBe(true);
      expect(renderer.hasRunnableWork).toBe(true);
      renderer.update(VIEW, false);
      expect(points.instances.map(instance => points.opacities[instance.vertexStart])).toEqual([1, 1, 1]);
    }
    finally { renderer.removeAll(); }
  });

  it('does not let an unaffected nonempty owner mask a stale empty successor', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const old = addPointTile(renderer, 'old', 1);
    movePoint(old, 0);
    const unaffected = addPointTile(renderer, 'z-unaffected', 1);
    movePoint(unaffected, 0.5);
    const onePair = { exhausted: true, takeMinimumProgress: () => true };
    try {
      renderer.update(VIEW, false);
      expect([old.opacities[0], unaffected.opacities[0]]).toEqual([1, 1]);
      renderer.setTilePlacementEligible('old', false);
      const successor = addPointTile(renderer, 'a-successor', 3);
      renderer.setTilePlacementVisible('a-successor', false);
      renderer.update({ ...VIEW, cameraZoom: 8, isPointVisible: x => x >= -0.5 }, true, undefined, operation => operation(onePair));
      for (let frame = 0; frame < 16 && !renderer.isTilePlaced('a-successor'); frame++)
        renderer.update(VIEW, frame === 0, undefined, operation => operation(onePair));
      expect(renderer.isTilePlaced('a-successor')).toBe(true);
      expect(successor.instances.map(instance => successor.opacities[instance.vertexStart])).toEqual([0, 0, 0]);
      expect(unaffected.opacities[0]).toBe(1);
      expect(renderer.prepareVisiblePlacement(new Set(['a-successor', 'z-unaffected']))).toBe(false);
      expect(old.opacities[0]).toBe(1);
      renderer.update(VIEW, false);
      expect(renderer.prepareVisiblePlacement(new Set(['a-successor', 'z-unaffected']))).toBe(true);
      renderer.setTilePlacementVisible('old', false);
      renderer.setTilePlacementVisible('a-successor', true);
      expect(renderer.activatePreparedPlacement()).toBe(true);
      expect(successor.instances.map(instance => successor.opacities[instance.vertexStart])).toEqual([1, 1, 1]);
    }
    finally { renderer.removeAll(); }
  });

  it('preserves unaffected visible candidates through a stale mixed handoff and filters them jointly with the new owner', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const unaffected = addPointTile(renderer, 'z-unaffected', 3, layer, undefined, true);
    twoWidePoints(unaffected);
    for (let vertex = 8; vertex < 12; vertex++) {
      unaffected.positions[vertex * 3] = 0.02;
      unaffected.positions[vertex * 3 + 1] = 0;
      unaffected.offsets[vertex * 2] *= 5;
      unaffected.offsets[vertex * 2 + 1] *= 5;
    }
    const visible = () => unaffected.instances.map(instance => unaffected.opacities[instance.vertexStart]);
    let gpuOpacity: number[] = [];
    try {
      renderer.update(VIEW, false);
      const primitive = renderer.getTileCollections('z-unaffected')[0].get(0);
      const upload = (values: Float32Array): void => {
        gpuOpacity = Array.from(values);
      };
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
      renderer.update(VIEW, false);
      const added = addPointTile(renderer, 'a-new', 1);
      movePoint(added, 0.06);
      for (let i = 0; i < added.offsets.length; i++)
        added.offsets[i] *= 5;
      added.instances[0].minX = added.instances[0].minY = -10;
      added.instances[0].maxX = added.instances[0].maxY = 10;
      renderer.setTilePlacementVisible('a-new', false);
      const onePair = { exhausted: true, takeMinimumProgress: () => true };
      renderer.update({ ...VIEW, cameraZoom: 8, isPointVisible: x => x > 0.05 }, true, undefined, operation => operation(onePair));
      expect(visible()).toEqual([0, 0, 0]);
      for (let frame = 0; frame < 8 && !renderer.isTilePlaced('a-new'); frame++)
        renderer.update(VIEW, frame === 0, undefined, operation => operation(onePair));
      expect(renderer.isTilePlaced('a-new')).toBe(true);
      expect(visible()).toEqual([1, 1, 0]);
      expect(added.opacities[0]).toBe(1);
      expect(renderer.prepareVisiblePlacement(new Set(['z-unaffected', 'a-new']))).toBe(true);
      renderer.setTilePlacementVisible('a-new', true);
      expect(renderer.activatePreparedPlacement()).toBe(true);
      expect(renderer.isTilePlacementActive('a-new')).toBe(true);
      // The new, earlier owner blocks only the second unaffected candidate.
      // Its stale pass cannot erase both candidates or promote the hidden third.
      expect([added.opacities[0], ...visible()]).toEqual([1, 1, 0, 0]);
      expect(unaffected.instances.map(instance => gpuOpacity[instance.vertexStart])).toEqual([1, 0, 0]);
      // After the stale nonempty handoff, one current-view pass catches up.
      // Reusing the prepared owner set cannot reopen placement indefinitely.
      renderer.update(VIEW, false);
      expect(renderer.hasRunnableWork).toBe(false);
      for (let frame = 0; frame < 3; frame++) {
        expect(renderer.prepareVisiblePlacement(new Set(['z-unaffected', 'a-new']))).toBe(true);
        expect(renderer.activatePreparedPlacement()).toBe(false);
        renderer.update(VIEW, false);
        expect(renderer.hasRunnableWork).toBe(false);
      }
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

  it('reprojects only completed candidates from a dense batch when no target pair is admitted', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const icon = addPointTile(renderer, 'dense', 1000);
    twoWidePoints(icon);
    for (let vertex = 8; vertex < icon.positions.length / 3; vertex++) {
      icon.positions[vertex * 3] = 0.02;
      icon.positions[vertex * 3 + 1] = 0;
      icon.offsets[vertex * 2] *= 5;
      icon.offsets[vertex * 2 + 1] *= 5;
    }
    renderer.update(VIEW, false);
    expect(icon.instances.filter(instance => icon.opacities[instance.vertexStart]).length).toBe(2);
    const isPointVisible = vi.fn(() => true);
    const projection = new Float64Array(VIEW.viewProjection);
    projection[0] = 0.25;
    renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: projection, isPointVisible }, true, undefined, operation => operation({ exhausted: true }));
    expect(isPointVisible).toHaveBeenCalledTimes(2);
    expect(icon.opacities[0]).toBe(1);
    expect(icon.opacities[4]).toBe(0);
    expect(icon.opacities.subarray(8).every(opacity => opacity === 0)).toBe(true);
    expect(renderer.hasRunnableWork).toBe(true);
    renderer.removeAll();
  });

  it('filters held generations jointly with unaffected owners without exposing their unplaced replacement', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const held = addPointTile(renderer, 'a-held', 2);
    twoWidePoints(held);
    const unaffected = addPointTile(renderer, 'z-unaffected', 1);
    movePoint(unaffected, 0.08);
    for (let vertex = 0; vertex < 4; vertex++) {
      unaffected.offsets[vertex * 2] *= 5;
      unaffected.offsets[vertex * 2 + 1] *= 5;
    }
    unaffected.instances[0].minX = unaffected.instances[0].minY = -10;
    unaffected.instances[0].maxX = unaffected.instances[0].maxY = 10;
    renderer.update(VIEW, false);
    expect([held.opacities[0], held.opacities[4], unaffected.opacities[0]]).toEqual([1, 1, 1]);
    const replacement = addPointTile(renderer, 'a-held', 1);
    movePoint(replacement, -0.5);
    const projection = new Float64Array(VIEW.viewProjection);
    projection[0] = 0.25;
    renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: projection }, true, undefined, operation => operation({ exhausted: true }));
    expect([held.opacities[0], held.opacities[4], unaffected.opacities[0], replacement.opacities[0]]).toEqual([1, 0, 0, 0]);
    expect(renderer.isTilePlacementActive('a-held')).toBe(false);
    expect(renderer.activatePreparedPlacement()).toBe(false);
    renderer.update(VIEW, true, undefined, operation => operation({ exhausted: true }));
    expect([held.opacities[0], held.opacities[4], unaffected.opacities[0], replacement.opacities[0]]).toEqual([1, 1, 1, 0]);
    expect(renderer.isTilePlacementActive('a-held')).toBe(false);
    expect(renderer.isTilePlaced('a-held')).toBe(false);
    renderer.removeAll();
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

  it('keeps fading resources out of the current candidate collision index', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const fading = addPointTile(renderer, 'a-fading', 1, layer, undefined, true);
    const active = addPointTile(renderer, 'b-active', 1);
    movePoint(fading, 0);
    movePoint(active, 0.04);
    renderer.update(VIEW, false);
    const primitive = renderer.getTileCollections('a-fading')[0].get(0);
    Object.assign(primitive, { _ready: true, getGeometryInstanceAttributes: () => ({}) });
    expect(renderer.retireTile('a-fading').fading).toHaveLength(1);
    const projection = new Float64Array(VIEW.viewProjection);
    projection[0] = 0.1;
    renderer.update({ ...VIEW, cameraZoom: 8, viewProjection: projection }, true, undefined, operation => operation({ exhausted: true }));
    expect(active.opacities[0]).toBe(1);
    expect(fading.opacities[0]).toBe(1);
    renderer.removeAll();
  });

  it('starts the owned collision quota after mandatory Native opacity upload and keeps that upload in reserve', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const renderer = new SymbolTileRenderer();
    const lease = acquireSceneFrameBudget(scene, renderer);
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const uploaded = addPointTile(renderer, 'uploaded', 1, layer, undefined, true);
    renderer.update(VIEW, false);
    expect(renderer.isTilePlaced('uploaded')).toBe(true);
    expect(uploaded.opacityDirty).toBe(true);
    const primitive = renderer.getTileCollections('uploaded')[0].get(0);
    const upload = vi.fn(() => {
      now += 3;
    });
    Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() }] });
    addPointTile(renderer, 'dense', 100);
    const isPointVisible = vi.fn(() => {
      now += 0.1;
      return true;
    });
    const runnable = { upload: false, build: false, paint: false, placement: true };
    try {
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      renderer.update({ ...VIEW, isPointVisible }, false, undefined, operation => work.run('placement', runnable, operation));
      expect(upload).toHaveBeenCalledOnce();
      expect(upload).toHaveBeenCalledWith(uploaded.opacities, 0);
      expect(isPointVisible.mock.calls.length).toBeGreaterThanOrEqual(19);
      expect(isPointVisible.mock.calls.length).toBeLessThanOrEqual(21);
      expect(now - 50).toBeGreaterThanOrEqual(4.9);
      expect(now - 50).toBeCloseTo(5.1, 8);
      scene.postRender.raiseEvent();
      now = 100;
      scene.preUpdate.raiseEvent();
      const next = lease.frame(2);
      // Fifty prior mandatory milliseconds plus three for this real Native
      // upload remain in the reserve; only collision CPU was measured out.
      now = 150;
      const following = next.continuation('placement', runnable)!;
      now = 152.64;
      expect(following.exhausted).toBe(false);
      now = 152.66;
      expect(following.exhausted).toBe(true);
    }
    finally {
      lease.release();
      renderer.removeAll();
    }
  });

  it('spends the Scene-owned overload allowance on collision pairs after the original deadline expires', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const renderer = new SymbolTileRenderer();
    const lease = acquireSceneFrameBudget(scene, renderer);
    addPointTile(renderer, 'dense', 100);
    const isPointVisible = vi.fn(() => {
      now += 0.1;
      return true;
    });
    const runnable = { upload: false, build: false, paint: false, placement: true };
    try {
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      expect(work.placementBudget.exhausted).toBe(true);
      renderer.update({ ...VIEW, isPointVisible }, false, undefined, operation => work.run('placement', runnable, operation));
      expect(isPointVisible.mock.calls.length).toBeGreaterThanOrEqual(19);
      expect(isPointVisible.mock.calls.length).toBeLessThanOrEqual(21);
      expect(now - 50).toBeGreaterThanOrEqual(1.9);
      expect(now - 50).toBeLessThanOrEqual(2.1);
      expect(renderer.isTilePlaced('dense')).toBe(false);
      expect(work.continuation('placement', runnable)).toBeUndefined();
    }
    finally {
      lease.release();
      renderer.removeAll();
    }
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

  it('rotates visible, prospective and target scopes within one Scene continuation without granting a second viewport', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, renderer);
    const held = addPointTile(renderer, 'held', 64);
    movePoint(held, -0.5);
    renderer.update(VIEW, false);
    renderer.setTilePlacementEligible('held', false);
    const target = addPointTile(renderer, 'target', 64);
    movePoint(target, 0.5);
    renderer.setTilePlacementVisible('target', false);
    const owners = new Set(['held', 'target']);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(false);
    const isPointVisible = vi.fn(() => {
      now += 0.1;
      return true;
    });
    const view = { ...VIEW, isPointVisible };
    const runnable = { upload: false, build: false, paint: false, placement: true };
    try {
      for (let frame = 0; frame < 16; frame++) {
        now = frame * 100;
        scene.preUpdate.raiseEvent();
        const work = lease.frame(frame);
        now += 50;
        const before = isPointVisible.mock.calls.length;
        renderer.update(view, false, undefined, operation => work.run('placement', runnable, operation));
        const processed = isPointVisible.mock.calls.length - before;
        expect(processed).toBeLessThanOrEqual(21);
        if (frame < 3)
          expect(processed).toBeGreaterThanOrEqual(19);
        expect(lease.frame(frame).continuation('placement', runnable)).toBeUndefined();
        renderer.update(view, false, undefined, operation => work.run('placement', runnable, operation));
        expect(isPointVisible).toHaveBeenCalledTimes(before + processed);
      }
      expect(renderer.isTilePlaced('target')).toBe(true);
      expect(renderer.prepareVisiblePlacement(owners)).toBe(true);
    }
    finally {
      lease.release();
      renderer.removeAll();
    }
  });

  it('leaves the root idle while symbol attributes wait for Native upload', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state: RenderFrameState = { ...cameraFrame(), frameNumber: 1, commandList: [], afterRender: [] };
    const { symbol: renderer, covering } = (tileset as unknown as { _renderer: TilesetRenderer })._renderer;
    vi.spyOn(covering, 'cameraFrame', 'get').mockImplementation(() => captureCameraForFrame(state, new WeakMap(), state.mode!));
    try {
      await tileset.whenReady();
      tileset.update(state);
      state.afterRender!.splice(0).forEach(callback => callback());
      const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
      const geometry = addPointTile(renderer, 'tile', 1, layer, undefined, true);
      const anchor = Cartesian3.fromDegrees(0, 0);
      for (let vertex = 0; vertex < 4; vertex++) {
        geometry.positions[vertex * 3] = anchor.x;
        geometry.positions[vertex * 3 + 1] = anchor.y;
        geometry.positions[vertex * 3 + 2] = anchor.z;
      }
      state.frameNumber = 2;
      tileset.update(state);
      expect(renderer.hasPendingWork).toBe(true);
      expect(tileset.tilesLoaded).toBe(false);
      expect(state.afterRender).toHaveLength(0);
    }
    finally {
      tileset.destroy();
    }
  });

  it('keeps pending opacity writes without runnable work until Native exposes their VBO', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const geometry = addPointTile(renderer, 'tile', 1, layer, undefined, true);
    renderer.update(VIEW, false);
    expect(renderer.isTilePlaced('tile')).toBe(true);
    expect(renderer.hasPendingWork).toBe(true);
    expect(renderer.hasRunnableWork).toBe(false);
    expect(renderer.nextPlacementTime).toBeUndefined();

    const primitive = renderer.getTileCollections('tile')[0].get(0);
    const upload = vi.fn();
    Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0 }, _va: [{ _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }] }] });
    expect(renderer.hasRunnableWork).toBe(true);
    expect(renderer.nextPlacementTime).toBeUndefined();
    renderer.update(VIEW, false);
    expect(upload).toHaveBeenCalledWith(geometry.opacities, 0);
    expect(renderer.hasPendingWork).toBe(false);
    expect(renderer.hasRunnableWork).toBe(false);
  });

  it('waits without runnable work between a live point camera filter and its recency catch-up', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    const geometry = addPointTile(renderer, 'tile', 1, layer, undefined, true);
    movePoint(geometry, 0);
    const visible = vi.fn(() => true);
    const initial = { ...VIEW, isPointVisible: visible };
    const upload = vi.fn();
    try {
      renderer.update(initial, false);
      expect(renderer.isTilePlaced('tile')).toBe(true);
      expect(geometry.opacities[0]).toBe(1);
      const primitive = renderer.getTileCollections('tile')[0].get(0);
      const vertexArray = { _attributes: [{ index: 0, vertexBuffer: { copyFromArrayView: upload } }], destroy: vi.fn() };
      Object.assign(primitive, { _ready: true, _attributeLocations: { a_opacity: 0 }, _va: [vertexArray] });
      renderer.update(initial, false);
      expect(upload).toHaveBeenCalledWith(geometry.opacities, 0);
      expect(renderer.hasPendingWork).toBe(false);
      expect(renderer.hasRunnableWork).toBe(false);
      visible.mockClear();
      upload.mockClear();

      const projection = new Float64Array(VIEW.viewProjection);
      projection[12] = 0.001;
      const panned = { ...initial, viewProjection: projection };
      now = 10;
      renderer.update(panned, true);
      // Current-view filtering is immediate even though a full new layout
      // waits for recency. The uploaded point remains a valid candidate.
      expect(visible).toHaveBeenCalledOnce();
      expect(geometry.opacities[0]).toBe(1);
      visible.mockClear();
      upload.mockClear();
      now = 20;
      renderer.update(panned, false);
      expect(visible).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(renderer.hasPendingWork).toBe(true);
      expect(renderer.hasRunnableWork).toBe(false);
      expect(renderer.nextPlacementTime).toBe(300);

      now = 300;
      expect(renderer.hasRunnableWork).toBe(true);
      expect(renderer.nextPlacementTime).toBeUndefined();
      renderer.update(panned, false);
      expect(visible).toHaveBeenCalledOnce();
      expect(renderer.hasPendingWork).toBe(false);
      expect(renderer.hasRunnableWork).toBe(false);
      expect(renderer.nextPlacementTime).toBeUndefined();
      expect((primitive as Primitive & { _va: unknown[] })._va[0]).toBe(vertexArray);

      visible.mockClear();
      now = 310;
      renderer.cameraZoom = 11;
      renderer.update({ ...panned, cameraZoom: 11 }, true);
      expect(visible).toHaveBeenCalled();
      expect(geometry.opacities[0]).toBe(1);
      expect(renderer.hasPendingWork).toBe(true);
      expect(renderer.hasRunnableWork).toBe(false);
      expect(renderer.nextPlacementTime).toBe(600);
      expect((primitive as Primitive & { _va: unknown[] })._va[0]).toBe(vertexArray);
      now = 600;
      renderer.update({ ...panned, cameraZoom: 11 }, false);
      expect(renderer.hasPendingWork).toBe(false);
      expect(renderer.hasRunnableWork).toBe(false);
      expect(renderer.nextPlacementTime).toBeUndefined();
      expect((primitive as Primitive & { _va: unknown[] })._va[0]).toBe(vertexArray);
    }
    finally {
      renderer.removeAll();
    }
  });

  it('distinguishes cached hidden symbol layers from visible drawable coverage', () => {
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source', minzoom: 13 }, {});
    addPointTile(renderer, 'parent', 1, layer, undefined, true);
    renderer.cameraZoom = 12;
    expect(renderer.getTileCollections('parent')).toHaveLength(1);
    expect(renderer.hasTileVisibleSymbols('parent')).toBe(false);
    renderer.cameraZoom = 14;
    expect(renderer.hasTileVisibleSymbols('parent')).toBe(true);
    layer.setLayoutProperty('visibility', 'none');
    expect(renderer.hasTileVisibleSymbols('parent')).toBe(false);
  });

  it('queries the held drawable generation until a same-key replacement activates', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    renderer.cameraZoom = VIEW.cameraZoom;
    const currentLayer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    addPointTile(renderer, 'tile', 1, currentLayer, undefined, true);
    renderer.update(VIEW, false);
    const hiddenLayer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source', minzoom: 13 }, {});
    addPointTile(renderer, 'tile', 1, hiddenLayer, undefined, true);
    expect(renderer.hasTileVisibleSymbols('tile')).toBe(true);
    renderer.update(VIEW, false);
    expect(renderer.prepareVisiblePlacement(new Set(['tile']))).toBe(true);
    renderer.activatePreparedPlacement();
    expect(renderer.hasTileVisibleSymbols('tile')).toBe(false);
  });

  it('requires styled drawable geometry before providing symbol coverage', () => {
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
    addPointTile(renderer, 'no-draw-half', 1, layer);
    addPointTile(renderer, 'empty-batch', 0);
    addPointTile(renderer, 'synthetic', 1);
    expect(renderer.hasTileVisibleSymbols('missing')).toBe(false);
    expect(renderer.hasTileVisibleSymbols('no-draw-half')).toBe(false);
    expect(renderer.hasTileVisibleSymbols('empty-batch')).toBe(false);
    expect(renderer.hasTileVisibleSymbols('synthetic')).toBe(false);
  });

  it('uses available wall-clock budget across twelve dense point tiles', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const tiles = Array.from({ length: 12 }, (_, index) => `tile-${index}`);
    for (const tileId of tiles)
      addPointTile(renderer, tileId, 900);
    const isPointVisible = vi.fn(() => true);

    renderer.update({ ...VIEW, isPointVisible }, false);

    expect(isPointVisible).toHaveBeenCalledTimes(12 * 900);
    expect(tiles.every(tileId => renderer.isTilePlaced(tileId))).toBe(true);
    expect(renderer.hasPendingWork).toBe(false);
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

  it('still advances one pair when the first clock check is already exhausted', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now += 3);
    const renderer = new SymbolTileRenderer();
    addPointTile(renderer, 'tile', 5);
    const isPointVisible = vi.fn(() => true);

    for (let frame = 0; frame < 5; frame++) {
      renderer.update({ ...VIEW, isPointVisible }, false);
      expect(isPointVisible).toHaveBeenCalledTimes(frame + 1);
    }

    expect(renderer.isTilePlaced('tile')).toBe(true);
    expect(renderer.hasPendingWork).toBe(false);
  });

  it('finishes its frozen layout during continuous camera movement', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    addPointTile(renderer, 'tile', 24);
    const checks = Array.from({ length: 6 }, () => vi.fn(() => {
      now += 0.5;
      return true;
    }));

    for (let frame = 0; frame < 6; frame++) {
      renderer.update({ ...VIEW, cameraZoom: 10 + frame * 0.1, isPointVisible: checks[frame] }, true);
      expect(renderer.hasRunnableWork).toBe(frame < 5);
      expect(renderer.nextPlacementTime).toBe(frame < 5 ? undefined : 312);
      // The frozen target keeps its original projection and four-pair quota.
      expect(checks[0]).toHaveBeenCalledTimes((frame + 1) * 4);
      if (frame > 0)
        expect(checks[frame]).toHaveBeenCalledTimes(frame === 5 ? 24 : 0);
    }

    expect(renderer.isTilePlaced('tile')).toBe(true);
    expect(renderer.hasPendingWork).toBe(true);
  });

  it('reflows visible held coverage while its replacement is preparing', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    const held = addPointTile(renderer, 'held', 2);
    twoWidePoints(held);
    renderer.update(VIEW, false);
    expect([held.opacities[0], held.opacities[4]]).toEqual([1, 1]);

    renderer.setTilePlacementEligible('held', false);
    const zoomedOut = new Float64Array(VIEW.viewProjection);
    zoomedOut[0] = 0.25;
    for (let frame = 0; frame < 3; frame++) {
      now += 350;
      renderer.update({ ...VIEW, viewProjection: zoomedOut, cameraZoom: 8 }, true);
    }

    expect([held.opacities[0], held.opacities[4]]).toEqual([1, 0]);
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

  it('collides held owners with unaffected visible tiles while preparing hidden targets independently', () => {
    const { renderer, held, unaffected, target } = heldAndPreparedTarget();

    expect([held.opacities[0], held.opacities[4]]).toEqual([1, 0]);
    expect(unaffected.opacities[0]).toBe(0);
    expect(target.opacities[0]).toBe(1);
    expect(renderer.isTilePlaced('b-target')).toBe(true);
    expect(renderer.activatePreparedPlacement()).toBe(false);
    expect(unaffected.opacities[0]).toBe(0);
  });

  it('atomically activates target and unaffected tile decisions at the owner handoff', () => {
    const { renderer, unaffected, target } = heldAndPreparedTarget();

    renderer.setTilePlacementVisible('a-held', false);
    renderer.setTilePlacementVisible('b-target', true);

    expect(renderer.activatePreparedPlacement()).toBe(true);
    expect(unaffected.opacities[0]).toBe(1);
    expect(target.opacities[0]).toBe(1);
    expect(renderer.activatePreparedPlacement()).toBe(false);
  });

  it('rejects a prepared layout whose tile generation was superseded', () => {
    const { renderer, unaffected } = heldAndPreparedTarget();
    const replacement = addPointTile(renderer, 'b-target', 1);
    renderer.setTilePlacementVisible('a-held', false);
    renderer.setTilePlacementVisible('b-target', true);

    expect(renderer.activatePreparedPlacement()).toBe(false);
    expect(unaffected.opacities[0]).toBe(0);
    expect(replacement.opacities[0]).toBe(0);
    expect(renderer.hasPendingWork).toBe(true);
  });

  it('never activates only a subset of the prepared owners', () => {
    const { renderer, unaffected } = heldAndPreparedTarget();
    renderer.setTilePlacementVisible('a-held', false);
    renderer.setTilePlacementVisible('b-target', true);
    renderer.setTilePlacementVisible('z-unaffected', false);

    expect(renderer.activatePreparedPlacement()).toBe(false);
    expect(unaffected.opacities[0]).toBe(0);
    expect(renderer.hasPendingWork).toBe(true);
  });

  it('shares the frame clock fairly between current owners and a hidden replacement', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    addPointTile(renderer, 'held', 32);
    renderer.update(VIEW, false);
    renderer.setTilePlacementEligible('held', false);
    addPointTile(renderer, 'target', 32);
    renderer.setTilePlacementVisible('target', false);
    const isPointVisible = vi.fn(() => {
      now += 0.25;
      return true;
    });

    for (let frame = 0; frame < 8; frame++) {
      const started = now;
      renderer.update({ ...VIEW, cameraZoom: 10 - frame * 0.1, isPointVisible }, true);
      // Current-view filtering spends eight mandatory milliseconds on the 32
      // selected points; the two async scopes still share only eight pairs.
      // A stale completion preserves the already filtered visible baseline.
      expect(now - started).toBe(10);
      expect(isPointVisible).toHaveBeenCalledTimes((frame + 1) * 40);
    }

    expect(renderer.isTilePlaced('target')).toBe(true);
  });

  it('settles two independent replacement groups that become ready in different frames', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const firstHeld = addPointTile(renderer, 'a-first-held', 1);
    const secondHeld = addPointTile(renderer, 'c-second-held', 1);
    const firstUnaffected = addPointTile(renderer, 'y-first-unaffected', 1);
    const secondUnaffected = addPointTile(renderer, 'z-second-unaffected', 1);
    movePoint(firstHeld, -0.5);
    movePoint(firstUnaffected, -0.5);
    movePoint(secondHeld, 0.5);
    movePoint(secondUnaffected, 0.5);
    renderer.update(VIEW, false);
    expect([firstUnaffected.opacities[0], secondUnaffected.opacities[0]]).toEqual([0, 0]);
    renderer.setTilePlacementEligible('a-first-held', false);
    renderer.setTilePlacementEligible('c-second-held', false);
    const firstTarget = addPointTile(renderer, 'b-first-target', 1);
    movePoint(firstTarget, -0.2);
    renderer.setTilePlacementVisible('b-first-target', false);
    renderer.update(VIEW, false);
    expect(renderer.isTilePlaced('b-first-target')).toBe(true);

    const firstOwners = new Set(['b-first-target', 'c-second-held', 'y-first-unaffected', 'z-second-unaffected']);
    expect(renderer.prepareVisiblePlacement(firstOwners)).toBe(false);
    expect([firstUnaffected.opacities[0], secondUnaffected.opacities[0]]).toEqual([0, 0]);
    renderer.update(VIEW, false);
    // Preparing Q/R/U must not publish its opacity while P/R/U still draws.
    expect([firstUnaffected.opacities[0], secondUnaffected.opacities[0]]).toEqual([0, 0]);
    expect(renderer.prepareVisiblePlacement(firstOwners)).toBe(true);
    renderer.setTilePlacementVisible('a-first-held', false);
    renderer.setTilePlacementVisible('b-first-target', true);
    expect(renderer.activatePreparedPlacement()).toBe(true);
    expect([firstTarget.opacities[0], firstUnaffected.opacities[0], secondHeld.opacities[0], secondUnaffected.opacities[0]])
      .toEqual([1, 1, 1, 0]);
    expect(renderer.isTilePlaced('b-first-target')).toBe(true);
    expect(renderer.prepareVisiblePlacement(firstOwners)).toBe(true);
    expect(renderer.activatePreparedPlacement()).toBe(false);
    renderer.update(VIEW, false);
    expect(renderer.hasPendingWork).toBe(false);

    const secondTarget = addPointTile(renderer, 'd-second-target', 1);
    movePoint(secondTarget, 0.2);
    renderer.setTilePlacementVisible('d-second-target', false);
    renderer.update(VIEW, false);
    expect(renderer.isTilePlaced('d-second-target')).toBe(true);
    expect(secondUnaffected.opacities[0]).toBe(0);
    expect(renderer.prepareVisiblePlacement(new Set(['b-first-target', 'd-second-target', 'y-first-unaffected', 'z-second-unaffected']))).toBe(true);
    renderer.setTilePlacementVisible('c-second-held', false);
    renderer.setTilePlacementVisible('d-second-target', true);

    expect(renderer.activatePreparedPlacement()).toBe(true);
    expect([firstTarget.opacities[0], firstUnaffected.opacities[0], secondTarget.opacities[0], secondUnaffected.opacities[0]])
      .toEqual([1, 1, 1, 1]);
  });

  it('retains hidden layer geometry while excluding it from live collision placement', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'zoom-labels', type: 'symbol', source: 'source', minzoom: 9 }, {});
    const blocker = addPointTile(renderer, 'a-blocker', 1, layer);
    const unaffected = addPointTile(renderer, 'z-unaffected', 1);
    movePoint(blocker, 0);
    movePoint(unaffected, 0);
    renderer.update(VIEW, false);
    expect([blocker.opacities[0], unaffected.opacities[0]]).toEqual([1, 0]);
    const owners = new Set(['a-blocker', 'z-unaffected']);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(true);

    renderer.update({ ...VIEW, cameraZoom: 8 }, true);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(true);
    expect(renderer.hasTileLayer('a-blocker', 'zoom-labels')).toBe(true);
    expect(unaffected.opacities[0]).toBe(1);

    renderer.update(VIEW, true);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(true);
    expect(renderer.hasTileLayer('a-blocker', 'zoom-labels')).toBe(true);
    expect([blocker.opacities[0], unaffected.opacities[0]]).toEqual([1, 0]);
  });

  it('prepares and activates an empty owner set without a render frame', () => {
    const renderer = new SymbolTileRenderer();
    expect(renderer.prepareVisiblePlacement(new Set())).toBe(true);
    expect(renderer.activatePreparedPlacement()).toBe(true);
    expect(renderer.hasPendingWork).toBe(false);
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

  it('stays idle when residency repeatedly prepares the unchanged owners', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    addPointTile(renderer, 'tile', 1);
    renderer.update(VIEW, false);

    for (let frame = 0; frame < 3; frame++) {
      expect(renderer.prepareVisiblePlacement(new Set(['tile']))).toBe(true);
      expect(renderer.activatePreparedPlacement()).toBe(false);
      renderer.update(VIEW, false);
      expect(renderer.hasPendingWork).toBe(false);
    }
  });

  it('keeps reflowing the visible generation while the same tile prepares a replacement', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const previous = addPointTile(renderer, 'tile', 2);
    twoWidePoints(previous);
    const unaffected = addPointTile(renderer, 'z-visible', 1);
    movePoint(unaffected, 0.04);
    renderer.update(VIEW, false);
    expect([previous.opacities[0], previous.opacities[4]]).toEqual([1, 1]);
    expect(unaffected.opacities[0]).toBe(0);
    const replacement = addPointTile(renderer, 'tile', 2);
    twoWidePoints(replacement);
    for (let vertex = 0; vertex < 8; vertex++)
      replacement.positions[vertex * 3] = vertex < 4 ? 0.4 : 0.6;
    const zoomedOut = new Float64Array(VIEW.viewProjection);
    zoomedOut[0] = 0.25;

    renderer.update({ ...VIEW, viewProjection: zoomedOut, cameraZoom: 8 }, true);

    expect([previous.opacities[0], previous.opacities[4]]).toEqual([1, 0]);
    expect([replacement.opacities[0], replacement.opacities[4]]).toEqual([1, 1]);
    expect(unaffected.opacities[0]).toBe(0);
    expect(renderer.isTilePlaced('tile')).toBe(true);
    expect(renderer.isTilePlacementActive('tile')).toBe(false);
    expect(renderer.prepareVisiblePlacement(new Set(['tile', 'z-visible']))).toBe(true);

    expect(renderer.activatePreparedPlacement()).toBe(true);
    expect(renderer.isTilePlacementActive('tile')).toBe(true);
    expect(unaffected.opacities[0]).toBe(1);
    expect([previous.opacities[0], previous.opacities[4]]).toEqual([1, 0]);
  });

  it('drops an unfinished dense handoff immediately when its prospective owners become empty', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = new SymbolTileRenderer();
    addPointTile(renderer, 'held', 64);
    addPointTile(renderer, 'other-held', 64);
    renderer.update(VIEW, false);
    renderer.setTilePlacementEligible('held', false);
    renderer.setTilePlacementEligible('other-held', false);
    addPointTile(renderer, 'target', 64);
    renderer.setTilePlacementVisible('target', false);
    const isPointVisible = vi.fn(() => {
      now += 0.25;
      return true;
    });
    const view = { ...VIEW, isPointVisible };
    renderer.update(view, false);
    expect(renderer.prepareVisiblePlacement(new Set(['target', 'other-held']))).toBe(false);
    renderer.update(view, false);
    const projected = isPointVisible.mock.calls.length;

    expect(renderer.prepareVisiblePlacement(new Set())).toBe(true);

    expect(isPointVisible).toHaveBeenCalledTimes(projected);
    renderer.setTilePlacementVisible('held', false);
    renderer.setTilePlacementVisible('other-held', false);
    expect(renderer.activatePreparedPlacement()).toBe(true);
  });

  it('does not repeatedly activate an unchanged empty owner set', () => {
    const renderer = new SymbolTileRenderer();
    expect(renderer.prepareVisiblePlacement(new Set())).toBe(true);
    expect(renderer.activatePreparedPlacement()).toBe(true);

    for (let frame = 0; frame < 3; frame++) {
      expect(renderer.prepareVisiblePlacement(new Set())).toBe(true);
      expect(renderer.activatePreparedPlacement()).toBe(false);
      expect(renderer.hasPendingWork).toBe(false);
    }
  });

  it('reuses the owner plan across stable preparation and camera zoom without a visibility change', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source', minzoom: 9 }, {});
    addPointTile(renderer, 'tile', 1, layer);
    renderer.update(VIEW, false);
    const owners = new Set(['tile']);
    expect(renderer.prepareVisiblePlacement(owners)).toBe(true);
    renderer.activatePreparedPlacement();
    const sort = vi.spyOn(Array.prototype, 'sort');
    const isHidden = vi.spyOn(layer, 'isHidden');

    for (let frame = 0; frame < 3; frame++) {
      expect(renderer.prepareVisiblePlacement(owners)).toBe(true);
      expect(renderer.activatePreparedPlacement()).toBe(false);
    }

    expect(sort).not.toHaveBeenCalled();
    expect(isHidden).not.toHaveBeenCalled();

    for (let frame = 0; frame < 3; frame++) {
      renderer.update({ ...VIEW, cameraZoom: 10 + frame * 0.1 }, true);
      expect(renderer.prepareVisiblePlacement(owners)).toBe(true);
      expect(renderer.activatePreparedPlacement()).toBe(false);
    }

    expect(sort).not.toHaveBeenCalled();
    // Only the three normal visibility observations, with no candidate rebuild.
    expect(isHidden).toHaveBeenCalledTimes(3);
  });

  it.each(['text-optional', 'icon-optional'] as const)('invalidates evaluated %s when a zoom expression crosses its stop', (property) => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const layer = new SymbolStyleLayer({
      id: 'paired',
      type: 'symbol',
      source: 'source',
      layout: { [property]: ['step', ['zoom'], false, 11, true] },
    }, {});
    layer.recalculate(new EvaluationParameters(10), []);
    const blocker = addPointTile(renderer, 'a-blocker', 1);
    movePoint(blocker, 0);
    const text = pointGeometry(1);
    text.sizes.fill(24 * 128 * 4 + 1);
    text.sizesMax.fill(24 * 128);
    const icon = addPointTile(renderer, 'z-paired', 1, layer, text);
    movePoint(text, property === 'text-optional' ? 0 : 0.2);
    movePoint(icon, property === 'icon-optional' ? 0 : 0.2);
    renderer.update(VIEW, false);
    expect([text.opacities[0], icon.opacities[0]]).toEqual([0, 0]);

    layer.recalculate(new EvaluationParameters(11), []);
    renderer.update({ ...VIEW, cameraZoom: 11 }, true);

    expect([text.opacities[0], icon.opacities[0]])
      .toEqual(property === 'text-optional' ? [0, 1] : [1, 0]);
  });

  it.each(['current', 'future'] as const)('observes optional inputs of the %s generation during a same-tile replacement', (generation) => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const renderer = new SymbolTileRenderer();
    const expressionLayer = new SymbolStyleLayer({
      id: 'paired',
      type: 'symbol',
      source: 'source',
      layout: { 'text-optional': ['step', ['zoom'], false, 11, true] },
    }, {});
    const constantLayer = new SymbolStyleLayer({ id: 'paired', type: 'symbol', source: 'source' }, {});
    const currentLayer = generation === 'current' ? expressionLayer : constantLayer;
    const futureLayer = generation === 'future' ? expressionLayer : constantLayer;
    currentLayer.recalculate(new EvaluationParameters(10), []);
    futureLayer.recalculate(new EvaluationParameters(10), []);
    const blocker = addPointTile(renderer, 'a-blocker', 1);
    movePoint(blocker, 0);
    const currentText = pointGeometry(1);
    currentText.sizes.fill(24 * 128 * 4 + 1);
    currentText.sizesMax.fill(24 * 128);
    const currentIcon = addPointTile(renderer, 'z-paired', 1, currentLayer, currentText);
    movePoint(currentText, 0);
    movePoint(currentIcon, 0.2);
    renderer.update(VIEW, false);
    const futureText = pointGeometry(1);
    futureText.sizes.fill(24 * 128 * 4 + 1);
    futureText.sizesMax.fill(24 * 128);
    const futureIcon = addPointTile(renderer, 'z-paired', 1, futureLayer, futureText);
    movePoint(futureText, 0);
    movePoint(futureIcon, 0.2);
    renderer.update(VIEW, false);

    currentLayer.recalculate(new EvaluationParameters(11), []);
    futureLayer.recalculate(new EvaluationParameters(11), []);
    renderer.update({ ...VIEW, cameraZoom: 11 }, true);

    expect([currentIcon.opacities[0], futureIcon.opacities[0]])
      .toEqual(generation === 'current' ? [1, 0] : [0, 1]);
    expect(renderer.isTilePlacementActive('z-paired')).toBe(false);
  });
});

it('initializes a late material from the current camera before its first Native paint', () => {
  const renderer = new SymbolTileRenderer();
  const view = { ...VIEW, cameraZoom: 18.42590593246132, orthographic: false, cameraToCenterDistance: 240 };
  renderer.cameraZoom = view.cameraZoom;
  renderer.update(view, true);
  const state = preparedPointBuild('late');
  const material = state.halves[0].material;
  try {
    expect(renderer.stepBuild(state, UNBOUNDED_BUDGET)).toBe(true);
    renderer.commitBuild(state);
    expect(material.uniforms.u_camera_zoom).toBe(view.cameraZoom);
    expect(material.uniforms.u_symbol_camera_distance).toBe(view.cameraToCenterDistance);
    expect(material.uniforms.u_symbol_orthographic).toBe(0);
    expect(material.uniforms.u_symbol_mercator_projection).toBe(1);
    renderer.update(view, false);
    expect(material.uniforms.u_camera_zoom).toBe(view.cameraZoom);
  }
  finally {
    renderer.removeAll();
  }
});

it('keeps replacement-held and restored material camera units current without replacing them', () => {
  const renderer = new SymbolTileRenderer();
  const view = { ...VIEW, cameraZoom: 18.42590593246132, orthographic: false, cameraToCenterDistance: 240 };
  renderer.cameraZoom = view.cameraZoom;
  const original = preparedPointBuild('tile');
  renderer.stepBuild(original, UNBOUNDED_BUDGET);
  renderer.commitBuild(original);
  renderer.update(view, true);
  const replacement = preparedPointBuild('tile');
  renderer.stepBuild(replacement, UNBOUNDED_BUDGET);
  const handoff = renderer.commitBuild(replacement);
  const originalMaterial = original.halves[0].material;
  const replacementMaterial = replacement.halves[0].material;
  try {
    const current = { ...view, cameraZoom: 19.42590593246132, cameraToCenterDistance: 120 };
    renderer.cameraZoom = current.cameraZoom;
    renderer.update(current, true);
    for (const material of [originalMaterial, replacementMaterial]) {
      expect(material.uniforms.u_camera_zoom).toBe(current.cameraZoom);
      expect(material.uniforms.u_symbol_camera_distance).toBe(120);
      expect(material.isDestroyed()).toBe(false);
    }
    renderer.retireTile('tile', 0);
    renderer.cameraZoom = view.cameraZoom;
    renderer.update(view, true);
    expect(renderer.restoreTile('tile')).toBeDefined();
    expect(replacement.halves[0].material).toBe(replacementMaterial);
    expect(replacementMaterial.uniforms.u_camera_zoom).toBe(view.cameraZoom);
    expect(replacementMaterial.uniforms.u_symbol_camera_distance).toBe(240);
  }
  finally {
    handoff.retained?.release();
    renderer.removeAll();
  }
});

it('updates retained point perspective uniforms without rebuilding Native geometry or material', () => {
  const renderer = new SymbolTileRenderer();
  const state = preparedPointBuild('perspective');
  const half = state.halves[0];
  const icon = half.opacity!.geometry;
  const material = half.material;
  const geometry = half.geometry;
  const arrays = [icon.positions, icon.offsets, icon.sizes];
  expect(renderer.stepBuild(state, UNBOUNDED_BUDGET)).toBe(true);
  renderer.commitBuild(state);
  const collections = renderer.getTileCollections('perspective');
  renderer.update({ ...VIEW, orthographic: false, cameraToCenterDistance: 9 }, true);
  expect(material.uniforms.u_symbol_camera_distance).toBe(9);
  expect(material.uniforms.u_symbol_orthographic).toBe(0);
  expect(renderer.getTileCollections('perspective')[0]).toBe(collections[0]);
  expect(half.geometry).toBe(geometry);
  expect(half.material).toBe(material);
  expect(icon.positions).toBe(arrays[0]);
  expect(icon.offsets).toBe(arrays[1]);
  expect(icon.sizes).toBe(arrays[2]);
  expect(Object.keys(geometry.attributes)).toHaveLength(12);
  expect(geometry.attributes.a_size_zoom.componentsPerAttribute).toBe(3);
  const packedZooms = geometry.attributes.a_size_zoom.values as Float32Array;
  for (let index = 0; index < icon.positions.length / 3; index++) {
    expect(Array.from(packedZooms.slice(index * 3, index * 3 + 3)))
      .toEqual([icon.sizeZooms[index * 2], icon.sizeZooms[index * 2 + 1], 1]);
  }
  renderer.update(VIEW, true);
  expect(material.uniforms.u_symbol_orthographic).toBe(1);
  expect(material.uniforms.u_symbol_camera_distance).toBe(0);
  renderer.removeAll();
});

it('packs map-line mode and the worker anchor into existing Native attribute slots', () => {
  vi.stubGlobal('OffscreenCanvas', class {});
  const icon = pointGeometry(1);
  icon.viewportPerspective = false;
  icon.mapPitch = true;
  const worker = symbolGroundPosition(0, -800);
  const glyph = symbolGroundPosition(50, -800);
  const first = symbolGroundPosition(-1000, -800);
  const last = symbolGroundPosition(1000, -800);
  for (let vertex = 0; vertex < 4; vertex++)
    icon.positions.set([glyph.x, glyph.y, glyph.z], vertex * 3);
  icon.instances[0].line = { anchorECEF: worker, pathECEF: new Float64Array([first.x, first.y, first.z, last.x, last.y, last.z]), segment: 0, glyphOffsets: new Float32Array([0]), lineOffsetX: 0, lineOffsetY: 0, keepUpright: true, rotateToLine: true, writingMode: 0 };
  const half = buildSymbolHalves({
    tileId: 'map-line',
    layerId: 'line-icons',
    geometry: { icon, pairs: [{ text: -1, icon: 0 }] },
    iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'line' },
    textColor: Color.WHITE,
    iconColor: Color.WHITE,
    pixelRatio: 1,
  })[0];
  expect(Object.keys(half.geometry.attributes)).toHaveLength(12);
  expect(half.geometry.attributes.a_size_zoom.componentsPerAttribute).toBe(3);
  expect(half.geometry.attributes.a_size_max.componentsPerAttribute).toBe(4);
  const modes = half.geometry.attributes.a_size_zoom.values as Float32Array;
  const anchors = half.geometry.attributes.a_size_max.values as Float32Array;
  for (let vertex = 0; vertex < 4; vertex++) {
    expect(modes[vertex * 3 + 2]).toBe(2);
    expect(anchors[vertex * 4]).toBe(icon.sizesMax[vertex]);
    expect(anchors[vertex * 4 + 1]).toBeCloseTo(-50, 5);
    expect(anchors[vertex * 4 + 2]).toBeCloseTo(0, 5);
  }
});
