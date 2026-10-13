import type { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import type { RenderFrameState } from '../render-frame';
import type { TilesetRenderer } from '../tileset-renderer';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BufferPolygonCollection, Cartesian3, Event, GeographicTilingScheme, Intersect, Rectangle, WebMercatorProjection, WebMercatorTilingScheme } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../../cesium-vector-tileset';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { tileBoundingSphere } from '../../geometry/tile-bounding-sphere';
import { buildVectorTile } from '../../vector/__test__/vector-tile-helper';
import { drawBatchForOwner } from '../draw-batch';
import { sourceTileLodForFrame, zoomForFrame } from '../render-frame';
import { SceneTileCovering } from '../scene-tile-covering';
import { TileGeneration } from '../tile-generation';
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
    generation: new TileGeneration(data, style.styleRevision, frame.mode!, vector.tileBuildLayers(tileId)!.generationId, { vector: 'complete', pattern: true, symbol: true }),
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
  it.each([89.9, 90])('retains distance LOD over the actual finite CV horizon at pitch %s', (pitch) => {
    const frame: RenderFrameState = cameraFrame({
      mode: Cesium.SceneMode.COLUMBUS_VIEW,
      projection: new WebMercatorProjection(),
      width: 1280,
      heightPixels: 720,
      fovY: 36.875112943 * Math.PI / 180,
    });
    frame.camera.setView({ destination: new Cartesian3(0, 0, 120), convert: false, orientation: { heading: 0, pitch: (pitch - 90) * Math.PI / 180, roll: 0 } });
    frame.camera.frustum.near = 139;
    frame.camera.frustum.far = 20662993;
    const volume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
    frame.cullingVolume = volume;
    const source = { type: 'geojson', minzoom: 0, maxzoom: 18, tileSize: 512, reparseOverscaled: true };
    const pyramid = { getSource: () => source, getLoadedTileIDs: () => [] };
    const cache = new WeakMap();
    const lod = sourceTileLodForFrame(pyramid, frame, cache, 0)!;
    const near = new OverscaledTileID(18, 0, 18, 2 ** 17, 2 ** 17 - 6);
    const far = new OverscaledTileID(18, 0, 18, 2 ** 17, 2 ** 17 - 6541);
    expect(lod.select(near)!.canonical.z).toBeGreaterThan(13);
    expect(lod.select(far)!.canonical.z).toBeLessThan(8);

    const globe = { _surface: { _tilesToRender: [terrain(new OverscaledTileID(0, 0, 0, 0, 0))] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const covering = new SceneTileCovering(() => {});
    // A stalled recursive covering blocks every browser task. Bound this test's
    // real Native visibility calls so a regression fails without hanging Vitest.
    const computeVisibility = volume.computeVisibility.bind(volume);
    let visits = 0;
    vi.spyOn(volume, 'computeVisibility').mockImplementation((sphere) => {
      if (++visits > 20000)
        throw new Error('Finite CV covering failed to coarsen distant tiles');
      return computeVisibility(sphere);
    });
    covering.observe(scene);
    try {
      const ids = covering.covering(pyramid, frame, 0)!.idealTileIDs;
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThan(1000);
      expect(visits).toBeLessThan(20000);
      expect(ids.some(id => id.canonical.z > 13)).toBe(true);
      expect(ids.some(id => id.canonical.z < 8)).toBe(true);
    }
    finally { covering.destroy(); }
  });

  it('culls Columbus View tiles in the projected camera coordinates', () => {
    const center = Rectangle.center(terrain(parentID).rectangle);
    const frame: RenderFrameState = cameraFrame({
      mode: Cesium.SceneMode.COLUMBUS_VIEW,
      projection: new WebMercatorProjection(),
      longitude: Cesium.Math.toDegrees(center.longitude),
      latitude: Cesium.Math.toDegrees(center.latitude),
      height: 3000,
    });
    frame.cullingVolume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
    const globe = { _surface: { _tilesToRender: [terrain(parentID)] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const covering = new SceneTileCovering(() => {});
    const pyramid = { getSource: () => ({ type: 'vector', minzoom: 0, maxzoom: 13, tileSize: 512 }), getLoadedTileIDs: () => [] };
    covering.observe(scene);
    try {
      expect(covering.covering(pyramid, frame, 0)!.idealTileIDs).toEqual([parentID]);
    }
    finally { covering.destroy(); }
  });

  it('bounds an ordinary London CV covering by the actual projected ground footprint', () => {
    const frame: RenderFrameState = cameraFrame({
      mode: Cesium.SceneMode.COLUMBUS_VIEW,
      longitude: -0.0863,
      latitude: 51.5078,
      height: 900,
      heading: 110 * Math.PI / 180,
      pitch: -35 * Math.PI / 180,
      heightPixels: 720,
    });
    const volume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
    frame.cullingVolume = volume;
    const globe = { _surface: { _tilesToRender: [terrain(new OverscaledTileID(0, 0, 0, 0, 0))] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const source = { type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 };
    const pyramid = { getSource: () => source, getLoadedTileIDs: () => [] };
    const covering = new SceneTileCovering(() => {});
    const computeVisibility = volume.computeVisibility.bind(volume);
    let visits = 0;
    vi.spyOn(volume, 'computeVisibility').mockImplementation((sphere) => {
      if (++visits > 20000)
        throw new Error('Projected CV ground bounds admitted distant empty volume');
      return computeVisibility(sphere);
    });
    covering.observe(scene);
    try {
      const ids = covering.covering(pyramid, frame, 0)!.idealTileIDs;
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThan(1000);
      expect(visits).toBeLessThan(20000);
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

  it('resolves a coarse rendered rectangle only where the frame can see it', () => {
    // A rendered rectangle stands for its whole ground extent, however little of
    // it is on screen: this z10 rectangle is far wider than the 3000 m view and
    // would resolve to all 64 of its z13 tiles. The frame's frustum test, wired
    // here through the real SceneTileCovering, is what holds the covering to the
    // visible part.
    const frame = cameraFrame({
      projection: new WebMercatorProjection(),
      longitude: 121.483,
      latitude: 31.226,
      height: 3000,
      heading: 0,
      pitch: -Math.PI / 2,
      width: 1569,
      heightPixels: 906,
      fovY: 36.87511294314776 * Math.PI / 180,
    });
    frame.cullingVolume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
    // The z10 ancestor of the tile the camera is over.
    const ancestor = new OverscaledTileID(10, 0, 10, 13721 >> 4, 6694 >> 4);
    const globe = { _surface: { _tilesToRender: [terrain(ancestor)] } };
    const scene = Object.assign(frame.camera._scene!, { mode: frame.mode, globe, preRender: new Event(), postRender: new Event(), _frameState: frame });
    const source = { type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 };
    const pyramid = { getSource: () => source, getLoadedTileIDs: () => [] };
    const covering = new SceneTileCovering(() => {});
    covering.observe(scene);
    try {
      const selected = covering.covering(pyramid, frame, 0)!;
      expect(selected.idealTileIDs.length).toBeGreaterThan(0);
      expect(selected.idealTileIDs.length).toBeLessThan(32);
      const offScreen = selected.idealTileIDs.filter(id => frame.cullingVolume!.computeVisibility(tileBoundingSphere(id)) === Intersect.OUTSIDE);
      expect(offScreen).toEqual([]);
      // An entirely off-screen rectangle authorizes nothing at all.
      globe._surface._tilesToRender = [terrain(awayID)];
      scene.postRender.raiseEvent();
      expect(covering.covering(pyramid, frame, 0)!.idealTileIDs).toEqual([]);
    }
    finally { covering.destroy(); }
  });

  it('restores four uploaded cached children on the first return frame while Globe still selects their uploaded ancestor', async () => {
    const owner = await coverageOwner();
    const children = parentID.children(14);
    const tileIds = children.map(id => `world/${id.key}`);
    try {
      await loadCoverageTiles(owner, children);
      expect(owner.render()).toEqual([owner.tileId]);
      owner.globe._surface._tilesToRender = children.map(terrain);
      owner.render();
      owner.render();
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
      // The first frame keeps the last confirmed view's own tiles; the next
      // one samples the coarser level the new pose needs.
      owner.render();
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
      await loadCoverageTiles(owner, children);
      owner.render();
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

  it('leaves a genuinely unloaded new view empty until completed globe coverage requests its data', async () => {
    const owner = await coverageOwner();
    const unloaded = new OverscaledTileID(13, 0, 13, 4193, 2724);
    try {
      owner.render();
      owner.position(awayID);
      owner.globe._surface._tilesToRender = [terrain(awayID)];
      owner.render();
      owner.render();
      // Both settled views legitimately refine their rectangle to the level the
      // camera needs; what this case pins starts at the unconfirmed view below.
      owner.load.mockClear();
      owner.position(unloaded);
      expect(owner.render()).toEqual([]);
      expect(owner.load).not.toHaveBeenCalled();
      owner.globe._surface._tilesToRender = [terrain(unloaded)];
      owner.scene.postRender.raiseEvent();
      expect(owner.render()).toEqual([]);
      // The completed Globe authorizes the area; its level still comes from the
      // camera, so the view requests the four tiles the LOD wants, not the
      // rectangle's own coarser tile.
      expect(owner.load.mock.calls.map(([tile]) => tile.tileID.key).sort())
        .toEqual(unloaded.children(14).map(id => id.key).sort());
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
      owner.load.mockClear();
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
