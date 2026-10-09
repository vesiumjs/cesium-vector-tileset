import type { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import type { RenderFrameState } from '../render-frame';
import type { TilesetRenderer } from '../tileset-renderer';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BoundingSphere, BufferPolygonCollection, Cartesian3, Ellipsoid, Event, GeographicTilingScheme, Intersect, Occluder, Rectangle, WebMercatorProjection, WebMercatorTilingScheme } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../../cesium-vector-tileset';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { GeoJSONSource } from '../../../source/geojson-source';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { Evented } from '../../../util/evented';
import { tileBoundingSphere } from '../../geometry/tile-bounding-sphere';
import { buildVectorTile } from '../../vector/__test__/vector-tile-helper';
import { drawBatchForOwner } from '../draw-batch';
import { zoomForFrame } from '../render-frame';
import { SceneTileCovering } from '../scene-tile-covering';
import { cameraFrame } from './camera-helper';

const scheme = new WebMercatorTilingScheme();
const parentID = new OverscaledTileID(13, 0, 13, 4093, 2724);
const awayID = new OverscaledTileID(13, 0, 13, 4493, 2724);

function terrain(id: OverscaledTileID) {
  const { z, x, y } = id.canonical;
  return { level: z, x, y, rectangle: scheme.tileXYToRectangle(x, y, z) };
}

async function coverageOwner(parent = parentID, cameraOptions?: Parameters<typeof cameraFrame>[0]) {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const tileset = new CesiumVectorTileset({
    style: {
      version: 8,
      sources: { world: { type: 'vector', tiles: ['http://example.invalid/{z}/{x}/{y}.pbf'] } },
      layers: [{ 'id': 'land', 'type': 'fill', 'source': 'world', 'source-layer': 'land', 'paint': { 'fill-antialias': false } }],
    },
  });
  await tileset.whenReady();
  const { style, vector, residency, evaluation } = (tileset as unknown as { _renderer: TilesetRenderer })._renderer;
  const pyramid = style.tilePyramids.world;
  pyramid._sourceLoaded = true;
  const load = vi.spyOn(pyramid.getSource(), 'loadTile').mockImplementation(() => new Promise(() => {}));
  const frame: RenderFrameState = { ...cameraFrame({ height: 3000, ...cameraOptions }), frameNumber: 1, commandList: [], afterRender: [], passes: { render: true, pick: false } };
  const globe = { _surface: { _tilesToRender: [terrain(parent)] } };
  const scene = Object.assign(frame.camera._scene!, {
    mode: frame.mode,
    globe,
    preRender: new Event(),
    postRender: new Event(),
    _frameState: frame,
  });
  const position = (id: OverscaledTileID) => {
    const center = Rectangle.center(terrain(id).rectangle);
    frame.camera.setView({ destination: Cartesian3.fromRadians(center.longitude, center.latitude, 3000), orientation: { pitch: -Math.PI / 2 } });
    frame.cullingVolume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
  };
  position(parent);
  evaluation.evaluate(zoomForFrame(pyramid, frame, new WeakMap())!.styleZoom);
  const layer = style.getLayer('land') as FillStyleLayer;
  layer.recalculate(new EvaluationParameters(14), []);
  const bucket = new FillBucket({ layers: [layer], zoom: 13 } as never);
  bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, parent, {});
  const data = new Tile(parent, 512);
  data.state = 'loaded';
  data.uses = 1;
  data.buckets.land = bucket;
  pyramid._activeTiles.setTile(parent.key, data);
  const away = new Tile(awayID, 512);
  away.state = 'loaded';
  away.uses = 1;
  pyramid._activeTiles.setTile(awayID.key, away);
  const tileId = `world/${parent.key}`;
  buildVectorTile(vector, { tileId, tileID: parent, buckets: data.buckets, styleZoom: 14, styleRevision: style.styleRevision });
  const [surface] = vector.getTileCollections(tileId) as BufferPolygonCollection[];
  tileset.add(surface);
  // Native GPU upload is the external boundary: the real built Buffer owner
  // submits its already uploaded command; selection, caching and retirement
  // all run through production owners, with no WebGL context in jsdom.
  const native = Cesium as unknown as { DrawCommand: new (options: object) => NonNullable<RenderFrameState['commandList']>[number]; Pass: { OPAQUE: number } };
  const commands = new WeakMap<BufferPolygonCollection, NonNullable<RenderFrameState['commandList']>[number]>();
  vi.spyOn(BufferPolygonCollection.prototype, 'update').mockImplementation(function (this: BufferPolygonCollection, state) {
    let command = commands.get(this);
    if (!command) {
      command = new native.DrawCommand({ owner: this, pass: native.Pass.OPAQUE });
      commands.set(this, command);
    }
    if (this.show)
      (state as RenderFrameState).commandList!.push(command);
  });
  residency.commit({
    sourceId: 'world',
    tileId,
    tileID: parent,
    generationId: vector.tileBuildLayers(tileId)!.generationId,
    stage: 'complete',
    progress: { vector: 'complete', pattern: true, symbol: true },
    buckets: data.buckets,
    styleRevision: style.styleRevision,
    mode: frame.mode!,
    featureIndex: data.latestFeatureIndex,
    retainPreviousGeneration: false,
    previousVector: [],
    retiredVector: [],
    addedVector: [],
    raster: { added: [], removed: [], removedMaterials: [] },
    addedSymbols: [],
    removedSymbols: [],
    firstUpdateSymbols: [],
  });
  const render = () => {
    frame.commandList!.length = 0;
    scene.preRender.raiseEvent();
    tileset.update(frame);
    scene.postRender.raiseEvent();
    frame.afterRender!.splice(0).forEach(callback => callback());
    frame.frameNumber!++;
    return frame.commandList!.flatMap((command) => {
      const batch = drawBatchForOwner(command.owner);
      return batch?.kind === 'fill' ? [batch.tileId] : [];
    });
  };
  return { tileset, frame, pyramid, load, position, render, globe, surface, tileId, scene, vector, style };
}

afterEach(() => vi.restoreAllMocks());

function changeHeight(owner: Awaited<ReturnType<typeof coverageOwner>>, height: number): void {
  const center = owner.frame.camera.positionCartographic;
  owner.frame.camera.setView({
    destination: Cartesian3.fromRadians(center.longitude, center.latitude, height),
    orientation: { pitch: -Math.PI / 2 },
  });
  owner.frame.cullingVolume = owner.frame.camera.frustum.computeCullingVolume(
    owner.frame.camera.positionWC,
    owner.frame.camera.directionWC,
    owner.frame.camera.upWC,
  );
}

async function loadCoverageTiles(owner: Awaited<ReturnType<typeof coverageOwner>>, ids: readonly OverscaledTileID[]): Promise<void> {
  const layer = owner.style.getLayer('land') as FillStyleLayer;
  owner.load.mockImplementation(async (tile) => {
    const bucket = new FillBucket({ layers: [layer], zoom: tile.tileID.canonical.z } as never);
    bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tile.tileID, {});
    tile.buckets.land = bucket;
    tile.state = 'loaded';
  });
  for (const id of ids)
    owner.pyramid.addTile(id);
  // Complete the actual source load so TilePyramid invalidates its loaded
  // snapshot and the normal publication queue receives the real buckets.
  await Promise.resolve();
  owner.load.mockImplementation(() => new Promise(() => {}));
}

describe('rendered globe and cached surface coverage', () => {
  it('reparses a terminal GeoJSON Globe footprint and invalidates selection when reparse changes', () => {
    const source = new GeoJSONSource('curve', { type: 'geojson', maxzoom: 13, data: { type: 'FeatureCollection', features: [] } }, {
      getChannel: () => new Promise(() => {}),
    } as unknown as ConstructorParameters<typeof GeoJSONSource>[2], new Evented());
    const frame = cameraFrame({ longitude: -0.1276, latitude: 51.5072, height: 20 });
    const globe = { _surface: { _tilesToRender: [terrain(parentID)] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const covering = new SceneTileCovering(() => {});
    covering.observe(scene);
    const pyramid = { getSource: () => source, getLoadedTileIDs: () => [parentID] };
    try {
      const selected = covering.covering(pyramid, frame, 4)!;
      expect(selected.zoom).toBeGreaterThan(13);
      expect(selected.idealTileIDs).toHaveLength(1);
      expect(selected.idealTileIDs[0].canonical).toEqual(parentID.canonical);
      expect(selected.idealTileIDs[0].overscaledZ).toBe(selected.zoom);
      expect(covering.covering(pyramid, frame, 4)).toBe(selected);
      source.reparseOverscaled = false;
      const capped = covering.covering(pyramid, frame, 4)!;
      expect(capped.idealTileIDs).toEqual([parentID]);
      source.reparseOverscaled = true;
      expect(covering.covering(pyramid, frame, 4)!.idealTileIDs[0].overscaledZ).toBe(selected.zoom);
    }
    finally { covering.destroy(); }
  });

  it.each([Cesium.SceneMode.SCENE3D, Cesium.SceneMode.COLUMBUS_VIEW])('uses the recorded Shanghai perspective source LOD for far rendered terrain in mode %s', (mode) => {
    const frame = cameraFrame({
      mode,
      projection: new WebMercatorProjection(),
      longitude: 121.483,
      latitude: 31.226,
      height: 1800,
      heading: Math.PI / 4,
      pitch: -25 * Math.PI / 180,
      width: 1569,
      heightPixels: 906,
      fovY: 36.87511294314776 * Math.PI / 180,
    });
    const geographic = new GeographicTilingScheme();
    // Actual Shanghai cold Globe tile. Its old mapping includes source
    // 14/13724/6690 at (676, 56); MapLibre 6.12 coveringTiles for the recorded
    // camera chooses 12/3431/1672 over that footprint instead.
    const globe = { _surface: { _tilesToRender: [{
      level: 13,
      x: 13724,
      y: 2670,
      rectangle: geographic.tileXYToRectangle(13724, 2670, 13),
    }] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const covering = new SceneTileCovering(() => {});
    covering.observe(scene);
    try {
      const pyramid = { getSource: () => ({ type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 }), getLoadedTileIDs: () => [] };
      const selected = covering.covering(pyramid, frame, 0)!;
      expect(selected.zoom).toBe(14);
      expect(selected.idealTileIDs.map(id => id.canonical.toString())).toEqual(['12/3431/1672']);
    }
    finally { covering.destroy(); }
  });

  it('keeps perspective sampling paired with the last confirmed Globe until the new pose completes', () => {
    const frame = cameraFrame({
      projection: new WebMercatorProjection(),
      longitude: 121.483,
      latitude: 31.226,
      height: 1800,
      heading: Math.PI / 4,
      pitch: -35 * Math.PI / 180,
      width: 1569,
      heightPixels: 906,
      fovY: 36.87511294314776 * Math.PI / 180,
    });
    const geographic = new GeographicTilingScheme();
    const globe = { _surface: { _tilesToRender: [{ level: 13, x: 13724, y: 2670, rectangle: geographic.tileXYToRectangle(13724, 2670, 13) }] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const covering = new SceneTileCovering(() => {});
    const source = { type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 };
    const pyramid = { getSource: () => source, getLoadedTileIDs: () => [] };
    covering.observe(scene);
    try {
      const initial = covering.covering(pyramid, frame, 0)!;
      expect(initial.idealTileIDs.map(id => id.canonical.toString())).toEqual(['14/13724/6690', '14/13724/6689']);
      scene.postRender.raiseEvent();
      frame.camera.setView({ orientation: { heading: Math.PI / 4, pitch: -25 * Math.PI / 180, roll: 0 } });
      scene.preRender.raiseEvent();
      const moving = covering.covering(pyramid, frame, 0)!;
      expect(moving.zoom).toBe(initial.zoom);
      expect(moving.idealTileIDs).toBe(initial.idealTileIDs);
      scene.postRender.raiseEvent();
      expect(covering.covering(pyramid, frame, 0)!.idealTileIDs.map(id => id.canonical.toString())).toEqual(['12/3431/1672']);
    }
    finally { covering.destroy(); }
  });

  it('keeps rendered near source z14 at high pitch even when the center source zoom is z13', () => {
    const frame = cameraFrame({
      projection: new WebMercatorProjection(),
      longitude: 121.483,
      latitude: 31.226,
      height: 1800,
      heading: Math.PI / 4,
      pitch: -15 * Math.PI / 180,
      width: 1569,
      heightPixels: 906,
      fovY: 36.87511294314776 * Math.PI / 180,
    });
    const near = new OverscaledTileID(14, 0, 14, 13721, 6694);
    const globe = { _surface: { _tilesToRender: [terrain(near)] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const source = { type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 };
    const pyramid = { getSource: () => source, getLoadedTileIDs: () => [] };
    const covering = new SceneTileCovering(() => {});
    covering.observe(scene);
    try {
      const selected = covering.covering(pyramid, frame, 0)!;
      expect(selected.zoom).toBe(13);
      expect(selected.idealTileIDs).toEqual([near]);
    }
    finally { covering.destroy(); }
  });

  it('does not supplement a new pose with a visible loaded far tile above its local source LOD', () => {
    const frame = cameraFrame({
      projection: new WebMercatorProjection(),
      longitude: 121.483,
      latitude: 31.226,
      height: 1800,
      heading: Math.PI / 4,
      pitch: -25 * Math.PI / 180,
      width: 1569,
      heightPixels: 906,
      fovY: 36.87511294314776 * Math.PI / 180,
    });
    const near = new OverscaledTileID(14, 0, 14, 13722, 6693);
    const far = new OverscaledTileID(14, 0, 14, 13724, 6690);
    const globe = { _surface: { _tilesToRender: [terrain(near)] } };
    const cullingVolume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
    expect(cullingVolume.computeVisibility(tileBoundingSphere(far))).not.toBe(Intersect.OUTSIDE);
    const state = { ...frame, cullingVolume };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: state });
    const covering = new SceneTileCovering(() => {});
    const pyramid = { getSource: () => ({ type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 }), getLoadedTileIDs: () => [far] };
    covering.observe(scene);
    try {
      // A new pose can reuse loaded data, but must neither add the overfine
      // far tile nor invent a request for its unloaded local z12 ancestor.
      expect(covering.covering(pyramid, state, 0)!.idealTileIDs).toEqual([near]);
    }
    finally { covering.destroy(); }
  });

  it('keeps the uploaded Shanghai far ancestor when all four cached children exceed its local perspective LOD', async () => {
    const far = new OverscaledTileID(13, 0, 13, 6861, 3344);
    const children = far.children(14);
    const owner = await coverageOwner(far, { projection: new WebMercatorProjection(), width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 });
    try {
      expect(owner.render()).toEqual([owner.tileId]);
      await loadCoverageTiles(owner, children);
      owner.globe._surface._tilesToRender = children.map(terrain);
      owner.render();
      owner.render();
      const tileIds = children.map(id => `world/${id.key}`);
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      const surfaces = tileIds.map(id => owner.vector.getTileCollections(id)[0]!);
      owner.frame.camera.setView({
        destination: Cartesian3.fromDegrees(121.483, 31.226, 1800),
        orientation: { heading: Math.PI / 4, pitch: -25 * Math.PI / 180, roll: 0 },
      });
      owner.frame.cullingVolume = owner.frame.camera.frustum.computeCullingVolume(owner.frame.camera.positionWC, owner.frame.camera.directionWC, owner.frame.camera.upWC);
      owner.globe._surface._tilesToRender = [terrain(far)];
      owner.load.mockClear();
      owner.render();
      // Current Globe now confirms this exact camera. Warm data must not
      // promote its far z13 footprint to the center's z14 source zoom.
      const confirmed = owner.render();
      expect(owner.pyramid._covering!.idealTileIDs).toEqual([far]);
      expect(confirmed).toEqual([owner.tileId]);
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.tileset.contains(owner.surface)).toBe(true);
      for (const surface of surfaces) {
        expect(owner.tileset.contains(surface)).toBe(false);
        expect(surface.isDestroyed()).toBe(false);
      }
      expect(owner.pyramid.getLoadedTileIDs(14, 14)).toEqual(expect.arrayContaining(children));
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('restores uploaded Shanghai near cached children above the high-pitch center source zoom', async () => {
    const near = new OverscaledTileID(13, 0, 13, 6860, 3347);
    const children = near.children(14);
    const owner = await coverageOwner(near, { projection: new WebMercatorProjection(), width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 });
    try {
      owner.render();
      await loadCoverageTiles(owner, children);
      owner.globe._surface._tilesToRender = children.map(terrain);
      owner.render();
      owner.render();
      const tileIds = children.map(id => `world/${id.key}`);
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      const surfaces = tileIds.map(id => owner.vector.getTileCollections(id)[0]!);
      owner.frame.camera.setView({ destination: Cartesian3.fromDegrees(121.483, 31.226, 1800), orientation: { heading: Math.PI / 4, pitch: -15 * Math.PI / 180, roll: 0 } });
      owner.frame.cullingVolume = owner.frame.camera.frustum.computeCullingVolume(owner.frame.camera.positionWC, owner.frame.camera.directionWC, owner.frame.camera.upWC);
      owner.globe._surface._tilesToRender = [terrain(near)];
      owner.load.mockClear();
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      expect(owner.pyramid._covering!.zoom).toBe(13);
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      expect(owner.tileset.contains(owner.surface)).toBe(false);
      for (const surface of surfaces)
        expect(owner.tileset.contains(surface)).toBe(true);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('does not request a new ancestor of previous globe coverage after a pan and zoom change', async () => {
    const owner = await coverageOwner();
    try {
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.load).not.toHaveBeenCalled();
      owner.position(awayID);
      changeHeight(owner, 12000);
      expect(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.zoom).toBe(12);
      const previousAncestor = parentID.scaledTo(12);
      expect(owner.frame.cullingVolume.computeVisibility(tileBoundingSphere(previousAncestor))).toBe(Intersect.OUTSIDE);
      expect(owner.pyramid.getLoadedTileIDs(12, 12)).toEqual([]);

      // Primitives see the new camera before Globe.render replaces this old
      // rectangle. Its unrelated ancestor must not become a fresh request.
      expect(owner.globe._surface._tilesToRender).toEqual([terrain(parentID)]);
      owner.render();
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.canonical.toString())).toEqual([]);

      // Completed current terrain still owns fresh requests, even when its
      // only loaded child cannot cover the whole new coarse source tile.
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.scene.postRender.raiseEvent();
      owner.render();
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.key)).toEqual([awayID.scaledTo(12).key]);
    }
    finally { owner.tileset.destroy(); }
  });

  it('starts uncached cold coverage normally at the current source zoom', async () => {
    const owner = await coverageOwner();
    try {
      changeHeight(owner, 12000);
      owner.render();
      expect(owner.pyramid._covering!.zoom).toBe(12);
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.key)).toEqual([parentID.scaledTo(12).key]);
    }
    finally { owner.tileset.destroy(); }
  });

  it('advances confirmed Globe coverage while every next frame has a new camera pose', async () => {
    const owner = await coverageOwner();
    try {
      owner.render();
      owner.position(awayID);
      changeHeight(owner, 12000);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.render();
      expect(owner.load).not.toHaveBeenCalled();

      // The preceding frame confirmed away at source z12. Another pan and
      // height change must not keep the initial source IDs indefinitely, or
      // reinterpret those confirmed rectangles at this frame's source z14.
      const nextID = new OverscaledTileID(13, 0, 13, 4693, 2724);
      owner.position(nextID);
      expect(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.zoom).toBe(14);
      owner.globe._surface._tilesToRender = [terrain(nextID)];
      owner.render();
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.canonical.toString())).toEqual([awayID.scaledTo(12).canonical.toString()]);
      expect(owner.pyramid._covering!.styleZoom).toBe(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.styleZoom);
      expect(owner.pyramid._covering!.idealTileIDs).toContainEqual(awayID.scaledTo(12));
    }
    finally { owner.tileset.destroy(); }
  });

  it('wakes once after confirming a deferred camera even when Globe rectangles do not change', async () => {
    const owner = await coverageOwner();
    const wake = vi.fn();
    const covering = new SceneTileCovering(wake);
    try {
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      const initial = covering.covering(owner.pyramid, owner.frame, 0)!;
      owner.scene.postRender.raiseEvent();
      wake.mockClear();
      changeHeight(owner, 12000);
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      const deferred = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(deferred.zoom).toBe(12);
      expect(deferred.styleZoom).toBe(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.styleZoom);
      expect(deferred.idealTileIDs).toEqual(initial.idealTileIDs);
      expect(wake).not.toHaveBeenCalled();
      owner.scene.postRender.raiseEvent();
      expect(wake).toHaveBeenCalledTimes(1);
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      const confirmed = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(confirmed.idealTileIDs).toEqual([parentID.scaledTo(12)]);
      owner.scene.postRender.raiseEvent();
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)).toBe(confirmed);
      owner.scene.postRender.raiseEvent();
      expect(wake).toHaveBeenCalledTimes(1);
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it('does not request another owner frame for unchanged Globe coverage at the same source zoom', async () => {
    const owner = await coverageOwner();
    try {
      expect(owner.render()).toEqual([owner.tileId]);
      const initial = owner.pyramid._covering!;
      changeHeight(owner, 3100);
      owner.frame.commandList!.length = 0;
      owner.scene.preRender.raiseEvent();
      owner.tileset.update(owner.frame);
      expect(owner.pyramid._covering!.zoom).toBe(initial.zoom);
      expect(owner.pyramid._covering!.styleZoom).not.toBe(initial.styleZoom);
      expect(owner.pyramid._covering!.idealTileIDs).toEqual(initial.idealTileIDs);
      expect(owner.frame.commandList!.flatMap((command) => {
        const batch = drawBatchForOwner(command.owner);
        return batch?.kind === 'fill' ? [batch.tileId] : [];
      })).toEqual([owner.tileId]);
      expect(owner.load).not.toHaveBeenCalled();

      // Isolate the real covering owner's postRender request from unrelated
      // staged work that may have requested a frame during tileset.update.
      const renderer = (owner.tileset as unknown as { _renderer: TilesetRenderer })._renderer;
      const wake = vi.spyOn(renderer.wake, 'request');
      owner.scene.postRender.raiseEvent();
      expect(wake).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('keeps primary sampling zoom through multiple unconfirmed poses in one frame', async () => {
    const owner = await coverageOwner();
    const wake = vi.fn();
    const covering = new SceneTileCovering(wake);
    try {
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      const initial = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(initial.zoom).toBe(14);
      owner.scene.postRender.raiseEvent();
      wake.mockClear();

      owner.frame.frameNumber!++;
      changeHeight(owner, 12000);
      owner.scene.preRender.raiseEvent();
      const first = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(first.zoom).toBe(12);
      expect(first.idealTileIDs).toEqual(initial.idealTileIDs);
      changeHeight(owner, 24000);
      owner.scene.preRender.raiseEvent();
      const second = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(second.zoom).toBe(11);
      expect(second.idealTileIDs).toEqual(initial.idealTileIDs);
      expect(wake).not.toHaveBeenCalled();
      owner.scene.postRender.raiseEvent();
      expect(wake).toHaveBeenCalledTimes(1);

      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID.scaledTo(11)]);
      owner.scene.postRender.raiseEvent();
      expect(wake).toHaveBeenCalledTimes(1);
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it('confirms retained primary IDs from an older Globe snapshot even at the same source zoom', async () => {
    const owner = await coverageOwner();
    const wake = vi.fn();
    const covering = new SceneTileCovering(wake);
    try {
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      const initial = covering.covering(owner.pyramid, owner.frame, 0)!;
      owner.scene.postRender.raiseEvent();

      // Globe can complete a camera before this participant asks for a
      // covering. Its old source IDs have not sampled this new snapshot.
      owner.position(awayID);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.scene.postRender.raiseEvent();
      wake.mockClear();
      owner.frame.frameNumber!++;
      owner.position(new OverscaledTileID(13, 0, 13, 4693, 2724));
      owner.scene.preRender.raiseEvent();
      const retained = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(retained.zoom).toBe(initial.zoom);
      expect(retained.idealTileIDs).toEqual(initial.idealTileIDs);
      owner.scene.postRender.raiseEvent();
      expect(wake).toHaveBeenCalledTimes(1);

      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([awayID]);
      owner.scene.postRender.raiseEvent();
      expect(wake).toHaveBeenCalledTimes(1);
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it.each(['source', 'minzoom', 'maxzoom', 'tileSize', 'type', 'overscale'] as const)('does not retain a covering after its %s input changes', async (input) => {
    const owner = await coverageOwner();
    const covering = new SceneTileCovering(vi.fn());
    try {
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      owner.scene.postRender.raiseEvent();
      changeHeight(owner, 12000);
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      const source = owner.pyramid.getSource();
      let overscale = 0;
      if (input === 'source')
        vi.spyOn(owner.pyramid, 'getSource').mockReturnValue({ ...source });
      else if (input === 'minzoom')
        source.minzoom = 8;
      else if (input === 'maxzoom')
        source.maxzoom = 16;
      else if (input === 'tileSize')
        source.tileSize = 1024;
      else if (input === 'type')
        source.type = 'raster';
      else overscale = 1;
      const current = covering.covering(owner.pyramid, owner.frame, overscale)!;
      expect(current.zoom).toBe(input === 'tileSize' ? 11 : 12);
      expect(current.idealTileIDs).toEqual([parentID.scaledTo(current.zoom)]);
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it('starts coverage normally after a surface mode switch', async () => {
    const owner = await coverageOwner();
    const covering = new SceneTileCovering(vi.fn());
    try {
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      owner.scene.postRender.raiseEvent();
      const center = Rectangle.center(terrain(parentID).rectangle);
      const next = cameraFrame({ mode: Cesium.SceneMode.COLUMBUS_VIEW, longitude: center.longitude * 180 / Math.PI, latitude: center.latitude * 180 / Math.PI, height: 12000 });
      owner.frame.camera = next.camera;
      owner.frame.mode = next.mode;
      owner.scene.mode = next.mode;
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)).toBeUndefined();
      owner.scene.postRender.raiseEvent();
      const current = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(current.zoom).toBe(12);
      expect(current.idealTileIDs).toEqual([parentID.scaledTo(12)]);
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it('restores an uploaded parent for the current camera before the previous globe selection catches up', async () => {
    const owner = await coverageOwner();
    try {
      expect(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.zoom).toBe(14);
      expect(owner.render()).toEqual([owner.tileId]);
      owner.position(awayID);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.render();
      owner.render();
      expect(owner.tileset.contains(owner.surface)).toBe(false);
      expect(owner.surface.isDestroyed()).toBe(false);
      expect(owner.pyramid.getLoadedTileIDs(13, 13)).toContainEqual(parentID);
      expect(owner.load).not.toHaveBeenCalled();
      owner.position(parentID);
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.tileset.contains(owner.surface)).toBe(true);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('restores four uploaded cached children on the first return frame while Globe still selects their uploaded ancestor', async () => {
    const owner = await coverageOwner();
    const children = parentID.children(14);
    try {
      expect(owner.render()).toEqual([owner.tileId]);
      await loadCoverageTiles(owner, children);
      owner.globe._surface._tilesToRender = children.map(terrain);
      owner.render();
      owner.render();
      const tileIds = children.map(id => `world/${id.key}`);
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      const surfaces = tileIds.map(id => owner.vector.getTileCollections(id)[0]!);
      changeHeight(owner, 6000);
      expect(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.zoom).toBe(13);
      owner.globe._surface._tilesToRender = [terrain(parentID)];
      owner.render();
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.tileset.contains(owner.surface)).toBe(true);
      expect(owner.pyramid._covering!.idealTileIDs).toEqual([parentID]);
      expect(owner.pyramid.getLoadedTileIDs(14, 14)).toEqual(expect.arrayContaining(children));
      for (const surface of surfaces) {
        expect(owner.tileset.contains(surface)).toBe(false);
        expect(surface.isDestroyed()).toBe(false);
      }
      owner.load.mockClear();
      owner.position(parentID);
      expect(zoomForFrame(owner.pyramid, owner.frame, new WeakMap())!.zoom).toBe(14);
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      expect(owner.tileset.contains(owner.surface)).toBe(false);
      for (const surface of surfaces)
        expect(owner.tileset.contains(surface)).toBe(true);
      expect(owner.load).not.toHaveBeenCalled();
      // Globe can keep the same coarse rectangle after confirming the new
      // camera. Its confirmation must not undo the complete loaded handoff.
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      expect(owner.tileset.contains(owner.surface)).toBe(false);
      for (const surface of surfaces)
        expect(owner.tileset.contains(surface)).toBe(true);
      changeHeight(owner, 6000);
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.pyramid._covering!.idealTileIDs).toEqual([parentID]);
      expect(owner.tileset.contains(owner.surface)).toBe(true);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('keeps the uploaded ancestor when only three cached children cover its footprint', async () => {
    const owner = await coverageOwner();
    const children = parentID.children(14).slice(0, 3);
    try {
      owner.render();
      await loadCoverageTiles(owner, children);
      owner.globe._surface._tilesToRender = children.map(terrain);
      owner.render();
      owner.render();
      const tileIds = children.map(id => `world/${id.key}`);
      expect(owner.render().sort()).toEqual([...tileIds].sort());
      const surfaces = tileIds.map(id => owner.vector.getTileCollections(id)[0]!);
      changeHeight(owner, 6000);
      owner.globe._surface._tilesToRender = [terrain(parentID)];
      owner.render();
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.pyramid.getLoadedTileIDs(14, 14)).toEqual(expect.arrayContaining(children));
      owner.load.mockClear();
      owner.position(parentID);
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.pyramid._covering!.idealTileIDs).toEqual([parentID]);
      expect(owner.tileset.contains(owner.surface)).toBe(true);
      for (const surface of surfaces)
        expect(owner.tileset.contains(surface)).toBe(false);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('rechecks confirmed coverage on loaded revisions and reuses a static covering without visibility scans', async () => {
    const owner = await coverageOwner();
    const wake = vi.fn();
    const covering = new SceneTileCovering(wake);
    const children = parentID.children(14);
    try {
      owner.render();
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      owner.scene.postRender.raiseEvent();
      await loadCoverageTiles(owner, children.slice(0, 3));
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      await loadCoverageTiles(owner, children.slice(3));
      owner.load.mockClear();
      const complete = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(complete.idealTileIDs.map(id => id.key).sort()).toEqual(children.map(id => id.key).sort());
      owner.scene.postRender.raiseEvent();
      wake.mockClear();
      const visibility = vi.spyOn(owner.frame.cullingVolume, 'computeVisibility');
      for (let frame = 0; frame < 3; frame++) {
        owner.frame.frameNumber!++;
        owner.scene.preRender.raiseEvent();
        expect(covering.covering(owner.pyramid, owner.frame, 0)).toBe(complete);
        owner.scene.postRender.raiseEvent();
      }
      expect(visibility).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      const removed = children[3];
      owner.pyramid.removeTile(removed.key);
      // Active-to-cache movement preserves loaded identity and the covering.
      expect(covering.covering(owner.pyramid, owner.frame, 0)).toBe(complete);
      owner.pyramid._tileCache.remove(removed);
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it('withdraws an unloaded cached refinement between unconfirmed poses without requesting its missing child', async () => {
    const owner = await coverageOwner();
    const covering = new SceneTileCovering(vi.fn());
    const children = parentID.children(14);
    try {
      owner.render();
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      covering.covering(owner.pyramid, owner.frame, 0);
      owner.scene.postRender.raiseEvent();
      await loadCoverageTiles(owner, children);
      owner.load.mockClear();
      changeHeight(owner, 3100);
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs.map(id => id.key).sort()).toEqual(children.map(id => id.key).sort());
      owner.pyramid.removeTile(children[3].key);
      owner.pyramid._tileCache.remove(children[3]);
      changeHeight(owner, 3200);
      owner.scene.preRender.raiseEvent();
      const current = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(current.idealTileIDs).toEqual([parentID]);
      owner.pyramid.update(current);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it.each([
    { name: 'uses complete mixed depth cached coverage once per canonical branch', complete: true, height: 1500, zoom: 15, refined: true },
    { name: 'does not count overlapping loaded descendants toward a missing branch', complete: false, height: 1500, zoom: 15, refined: false },
    { name: 'does not refine beyond the current desired source zoom', complete: true, height: 3100, zoom: 14, refined: false },
    { name: 'does not refine when the camera zooms out to the ancestor', complete: true, height: 6000, zoom: 13, refined: false },
  ])('$name', async ({ complete, height, zoom, refined }) => {
    const owner = await coverageOwner();
    const covering = new SceneTileCovering(vi.fn());
    const children = parentID.children(14);
    const grandchildren = children[3].children(15);
    const mixed = [...children.slice(0, 3), ...grandchildren.slice(0, complete ? 4 : 3)];
    // This overlaps the first already loaded child. In the incomplete case,
    // blindly summing all loaded footprints would falsely total one tile.
    const overlapping = children[0].children(15)[0];
    try {
      owner.render();
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      owner.scene.postRender.raiseEvent();
      await loadCoverageTiles(owner, [...mixed, overlapping]);
      for (const id of [...mixed, overlapping])
        owner.pyramid.removeTile(id.key);
      expect(owner.pyramid.getLoadedTileIDs(14, 15)).toEqual(expect.arrayContaining(mixed));
      owner.load.mockClear();
      changeHeight(owner, height);
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      const current = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(current.zoom).toBe(zoom);
      expect(current.idealTileIDs.map(id => id.key).sort()).toEqual((refined ? mixed : [parentID]).map(id => id.key).sort());
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it.each(['frustum', 'horizon'] as const)('does not refine complete loaded children hidden by the current %s', async (gate) => {
    const owner = await coverageOwner();
    const covering = new SceneTileCovering(vi.fn());
    const children = parentID.children(14);
    try {
      owner.render();
      covering.observe(owner.scene);
      owner.scene.preRender.raiseEvent();
      expect(covering.covering(owner.pyramid, owner.frame, 0)!.idealTileIDs).toEqual([parentID]);
      owner.scene.postRender.raiseEvent();
      await loadCoverageTiles(owner, children);
      if (gate === 'frustum') {
        owner.position(awayID);
        expect(owner.frame.cullingVolume.computeVisibility(tileBoundingSphere(parentID))).toBe(Intersect.OUTSIDE);
      }
      else {
        owner.position(new OverscaledTileID(13, 0, 13, (parentID.canonical.x + 4096) % 8192, 8191 - parentID.canonical.y));
        owner.frame.occluder = new Occluder(new BoundingSphere(Cartesian3.ZERO, Ellipsoid.WGS84.minimumRadius), owner.frame.camera.positionWC);
        const bounds = tileBoundingSphere(parentID);
        expect(owner.frame.cullingVolume.computeVisibility(bounds)).not.toBe(Intersect.OUTSIDE);
        expect(bounds.isOccluded(owner.frame.occluder as Occluder)).toBe(true);
      }
      owner.frame.frameNumber!++;
      owner.scene.preRender.raiseEvent();
      const current = covering.covering(owner.pyramid, owner.frame, 0)!;
      expect(current.zoom).toBe(14);
      expect(current.idealTileIDs).toContainEqual(parentID);
      for (const child of children)
        expect(current.idealTileIDs).not.toContainEqual(child);
    }
    finally {
      covering.destroy();
      owner.tileset.destroy();
    }
  });

  it('restores the same uploaded owner when the completed globe already covers the returning view', async () => {
    const owner = await coverageOwner();
    try {
      expect(owner.render()).toEqual([owner.tileId]);
      owner.position(awayID);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.render();
      owner.render();
      owner.position(parentID);
      owner.globe._surface._tilesToRender = [terrain(parentID)];
      owner.scene.postRender.raiseEvent();
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.tileset.contains(owner.surface)).toBe(true);
      expect(owner.load).not.toHaveBeenCalled();
    }
    finally { owner.tileset.destroy(); }
  });

  it('leaves a genuinely unloaded new view empty until completed globe coverage requests its data', async () => {
    const owner = await coverageOwner();
    const unloaded = new OverscaledTileID(13, 0, 13, 4193, 2724);
    try {
      owner.render();
      owner.position(awayID);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.render();
      owner.render();
      owner.position(unloaded);
      expect(owner.render()).toEqual([]);
      expect(owner.load).not.toHaveBeenCalled();
      owner.globe._surface._tilesToRender = [terrain(unloaded)];
      owner.scene.postRender.raiseEvent();
      expect(owner.render()).toEqual([]);
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.key)).toEqual([unloaded.key]);
    }
    finally { owner.tileset.destroy(); }
  });

  it('keeps rendered fine coverage authoritative and uses a cached ancestor only as its data fallback', async () => {
    const owner = await coverageOwner();
    const child = new OverscaledTileID(14, 0, 14, 8186, 5448);
    try {
      owner.render();
      owner.position(awayID);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.render();
      owner.render();
      owner.position(child);
      owner.globe._surface._tilesToRender = [terrain(child)];
      owner.scene.postRender.raiseEvent();
      expect(owner.render()).toEqual([owner.tileId]);
      expect(owner.pyramid._covering!.idealTileIDs).toEqual([child]);
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.key)).toEqual([child.key]);
    }
    finally { owner.tileset.destroy(); }
  });
});
