import type { OrthographicOffCenterFrustum } from 'cesium';
import type { WorkerDispatcher } from '../../../worker/dispatcher';
import { Ellipsoid, SceneMode, WebMercatorProjection, WebMercatorTilingScheme } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
/* eslint-disable antfu/no-import-node-modules-by-path -- Independent pinned primary-source oracle; MapLibre does not export these source APIs. */
import { LngLat } from '../../../../../../node_modules/maplibre-gl/src/geo/lng_lat';
import { MercatorCoordinate } from '../../../../../../node_modules/maplibre-gl/src/geo/mercator_coordinate';
import { coveringTiles } from '../../../../../../node_modules/maplibre-gl/src/geo/projection/covering_tiles';
import { MercatorTransform } from '../../../../../../node_modules/maplibre-gl/src/geo/projection/mercator_transform';
import { cameraMercatorCoordinate } from '../../../../../../node_modules/maplibre-gl/src/geo/projection/mercator_utils';
/* eslint-enable antfu/no-import-node-modules-by-path */
import { GeoJSONSource } from '../../../source/geojson-source';
import { OverscaledTileID } from '../../../tile/tile-id';
import { Evented } from '../../../util/evented';
import { globeVisibleTileIDs } from '../globe-covering';
import { planarCoveringForFrame, sourceTileLodForFrame, zoomForFrame } from '../render-frame';
import { sourceLodCamera, SourceTileLod } from '../source-tile-lod';
import { cameraFrame } from './camera-helper';

// Independent primary-source oracle: these are the recorded Shanghai poses,
// evaluated by the installed MapLibre coveringTiles, not a copy of its formula.
const poses = [
  { pitch: 45, zoom: 15.122108990364378, center: [121.49636217711333, 31.237480592020166] },
  { pitch: 55, zoom: 14.819880187824133, center: [121.50208695657702, 31.24239796625697] },
  { pitch: 65, zoom: 14.378602496575441, center: [121.51167383118805, 31.25063101727699] },
  { pitch: 75, zoom: 13.669004805773977, center: [121.53297629301522, 31.268917513243924] },
  { pitch: 65, zoom: 13.377288968142468, center: [121.54039991237444, 31.275287569615152] },
  { pitch: 65, zoom: 15.379258278980691, center: [121.49733039889827, 31.238312323069696] },
  { pitch: 55, roll: 90, zoom: 14.819880187824133, center: [121.50208695657702, 31.24239796625697] },
];

describe('source perspective LOD', () => {
  it('shares ancestor work across the rendered globe candidates while preserving the pinned MapLibre covering', () => {
    const { pitch, zoom, center } = poses[3];
    const transform = new MercatorTransform({ maxPitch: 85, maxZoom: 24, renderWorldCopies: true });
    transform.resize(1569, 906);
    transform.setZoom(zoom);
    transform.setBearing(45);
    transform.setPitch(pitch);
    transform.setFov(36.87511294314776);
    transform.setCenter(new LngLat(center[0], center[1]));
    const oracle = coveringTiles(transform, { minzoom: 0, maxzoom: 14, tileSize: 512 });
    const camera = cameraMercatorCoordinate(transform);
    const target = MercatorCoordinate.fromLngLat(transform.center);
    const lodCamera = {
      x: camera.x,
      y: camera.y,
      height: camera.z,
      centerDistance: Math.hypot(camera.x - target.x, camera.y - target.y, camera.z),
      fov: transform.fov * Math.PI / 180,
      variable: transform.getCoveringTilesDetailsProvider().allowVariableZoom(transform, { tileSize: 512 }),
    };
    expect(lodCamera.variable).toBe(true);
    const lod = new SourceTileLod(lodCamera, transform.zoom, 0, 14, false);
    const scheme = new WebMercatorTilingScheme();
    const candidates = new Map<string, { level: number; x: number; y: number; rectangle: ReturnType<WebMercatorTilingScheme['tileXYToRectangle']> }>();
    const ancestors = new Set<string>();
    for (const { canonical } of oracle) {
      const span = 2 ** (14 - canonical.z);
      for (const dx of [0, span - 1]) {
        for (const dy of [0, span - 1]) {
          const x = canonical.x * span + dx;
          const y = canonical.y * span + dy;
          candidates.set(`${x}/${y}`, { level: 14, x, y, rectangle: scheme.tileXYToRectangle(x, y, 14) });
          for (let level = 0; level <= 14; level++)
            ancestors.add(`${level}/${x >> (14 - level)}/${y >> (14 - level)}`);
        }
      }
    }
    const globe = { _surface: { _tilesToRender: [...candidates.values()] } };
    const keys = (ids: { overscaledZ: number; wrap: number; canonical: { toString: () => string } }[]) => ids.map(id => `${id.wrap}/${id.overscaledZ}/${id.canonical.toString()}`).sort();
    const expected = keys(oracle);
    expect(expected.length).toBeGreaterThan(1);
    // Observe the expensive formula and ID construction at the actual globe
    // consumer, without inspecting SourceTileLod's private cache.
    const costMath = vi.spyOn(Math, 'atan');
    const scaledTo = vi.spyOn(OverscaledTileID.prototype, 'scaledTo');
    try {
      expect(keys(globeVisibleTileIDs(globe, 0, 14, lod))).toEqual(expected);
      expect(costMath.mock.calls.length).toBeGreaterThan(0);
      expect(costMath.mock.calls.length).toBeLessThanOrEqual(ancestors.size);
      expect(scaledTo.mock.calls.length).toBeLessThanOrEqual(candidates.size);
      costMath.mockClear();
      scaledTo.mockClear();
      expect(keys(globeVisibleTileIDs(globe, 0, 14, lod))).toEqual(expected);
      expect(costMath).not.toHaveBeenCalled();
      expect(scaledTo.mock.calls.length).toBeLessThanOrEqual(candidates.size);
      // A new camera/source lifetime must perform its own formula work.
      const fresh = new SourceTileLod(lodCamera, transform.zoom, 0, 14, false);
      expect(keys(globeVisibleTileIDs(globe, 0, 14, fresh))).toEqual(expected);
      expect(costMath.mock.calls.length).toBeGreaterThan(0);
    }
    finally {
      costMath.mockRestore();
      scaledTo.mockRestore();
    }
  });

  it('reparses a real GeoJSON source at the MapLibre desired zoom without subdividing its terminal footprint', () => {
    const source = new GeoJSONSource('curve', { type: 'geojson', maxzoom: 13, data: { type: 'FeatureCollection', features: [] } }, {
      getChannel: () => new Promise(() => {}),
    } as unknown as WorkerDispatcher, new Evented());
    const zoom = 19.425905933;
    const span = 2 * Math.PI * Ellipsoid.WGS84.maximumRadius * 1280 / (512 * 2 ** zoom);
    const frame = cameraFrame({ mode: SceneMode.SCENE2D, projection: new WebMercatorProjection(), longitude: -0.1276, latitude: 51.5072, height: span });
    const frustum = frame.camera.frustum as OrthographicOffCenterFrustum;
    frustum.right = span / 2;
    frustum.left = -span / 2;
    frustum.top = span * 800 / 1280 / 2;
    frustum.bottom = -frustum.top;
    const pyramid = { getSource: () => source };
    const cache = new WeakMap();
    const transform = new MercatorTransform({ maxZoom: 24 });
    transform.resize(1280, 800);
    transform.setZoom(zoom);
    transform.setCenter(new LngLat(-0.1276, 51.5072));
    const oracle = coveringTiles(transform, { minzoom: source.minzoom, maxzoom: source.maxzoom, tileSize: source.tileSize, reparseOverscaled: source.reparseOverscaled });
    expect(oracle.length).toBeGreaterThan(0);
    expect(zoomForFrame(pyramid, frame, cache)!.zoom).toBe(oracle[0].overscaledZ);
    const lod = sourceTileLodForFrame(pyramid, frame, cache, 4)!;
    expect(lod.maxZoom).toBe(13);
    for (const id of oracle) {
      const selected = lod.select(new OverscaledTileID(id.canonical.z, id.wrap, id.canonical.z, id.canonical.x, id.canonical.y))!;
      expect(selected.canonical).toEqual(id.canonical);
      expect(selected.overscaledZ).toBe(id.overscaledZ);
    }
    const covering = planarCoveringForFrame(pyramid, frame, cache, 4)!;
    expect(covering.idealTileIDs.map(id => id.canonical.toString()).sort()).toEqual(oracle.map(id => id.canonical.toString()).sort());
    expect(covering.idealTileIDs.every(id => id.overscaledZ === 19)).toBe(true);
    const id = oracle[0];
    const scheme = new WebMercatorTilingScheme();
    const globe = { _surface: { _tilesToRender: [{ level: 13, x: id.canonical.x, y: id.canonical.y, rectangle: scheme.tileXYToRectangle(id.canonical.x, id.canonical.y, 13) }] } };
    const globeIDs = globeVisibleTileIDs(globe, source.minzoom, 19, lod);
    expect(globeIDs).toHaveLength(1);
    expect(globeIDs[0].canonical).toEqual(id.canonical);
    expect(globeIDs[0].overscaledZ).toBe(19);
    expect(lod.allows(globeIDs[0])).toBe(true);
    expect(lod.allows(globeIDs[0].scaledTo(13))).toBe(false);
    source.reparseOverscaled = false;
    const capped = sourceTileLodForFrame(pyramid, frame, cache, 4)!;
    expect(capped.sameSelection(lod)).toBe(false);
    expect(zoomForFrame(pyramid, frame, cache)!.zoom).toBe(13);
    expect(planarCoveringForFrame(pyramid, frame, cache, 4)!.idealTileIDs.every(id => id.canonical.z === 13 && id.overscaledZ === 13)).toBe(true);
    expect(globeVisibleTileIDs(globe, source.minzoom, 19, capped)[0].overscaledZ).toBe(13);
  });

  it('keeps nonterminal footprints at their canonical parse zoom while reparsing terminal tiles', () => {
    const lod = new SourceTileLod(undefined, 19.425905933, 0, 13, false, true);
    const partial = new OverscaledTileID(12, 0, 12, 2046, 1362);
    expect(lod.select(partial)).toEqual(partial);
    const terminal = new OverscaledTileID(13, 0, 13, 4093, 2724);
    expect(lod.select(terminal)!.overscaledZ).toBe(19);
    const far = new SourceTileLod(undefined, 12.8, 0, 13, false, true);
    expect(far.select(terminal)).toEqual(terminal.scaledTo(12));
  });

  it('caps a terminal overscaled generation at its actual local desired zoom', () => {
    const lod = new SourceTileLod(undefined, 14.378602496575441, 0, 16, false);
    const over = new OverscaledTileID(16, 0, 14, 13722, 6693);
    expect(lod.select(over)).toEqual(over.scaledTo(14));
    expect(lod.allows(over)).toBe(false);
    expect(lod.allows(over.scaledTo(14))).toBe(true);
  });

  it.each([51.5, 84.8])('uses projected world height for a real Columbus View camera at latitude %s', (latitude) => {
    const frame = cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), latitude, height: 1800, pitch: -25 * Math.PI / 180, width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 });
    const camera = sourceLodCamera(frame, frame.mapProjection, 1569, 906)!;
    // Native inverse projection of the center ray has sub-microdegree error.
    expect(Math.acos(camera.height / camera.centerDistance) * 180 / Math.PI).toBeCloseTo(65, 6);
    expect(camera.variable).toBe(true);
  });

  it('uses the actual rotated viewport for the variable perspective threshold', () => {
    const options = { mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), latitude: 51.5, height: 1800, pitch: -35 * Math.PI / 180, width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 };
    const upright = cameraFrame(options);
    const rotated = cameraFrame({ ...options, roll: Math.PI / 2 });
    expect(sourceLodCamera(upright, upright.mapProjection, 1569, 906)!.variable).toBe(false);
    expect(sourceLodCamera(rotated, rotated.mapProjection, 1569, 906)!.variable).toBe(true);
  });

  it('uses the current official sky focus cap without authorizing deeper tiles', () => {
    const frame = cameraFrame({ projection: new WebMercatorProjection(), longitude: 121.483, latitude: 31.226, height: 1800, heading: Math.PI / 4, pitch: -25 * Math.PI / 180, width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 });
    const source = { type: 'vector', minzoom: 0, maxzoom: 24, tileSize: 512 };
    const pyramid = { getSource: () => source };
    const cache = new WeakMap();
    const initial = zoomForFrame(pyramid, frame, cache)!;
    frame.camera.setView({ orientation: { heading: Math.PI / 4, pitch: 5 * Math.PI / 180, roll: 0 } });
    expect(sourceLodCamera(frame, frame.mapProjection, 1569, 906)).toBeUndefined();
    const sky = sourceTileLodForFrame(pyramid, frame, cache, 0)!;
    const location = frame.mapProjection.ellipsoid.cartesianToCartographic(frame.camera.positionWC)!;
    const official = new MercatorTransform({ maxPitch: 180, maxZoom: 24, renderWorldCopies: true });
    official.resize(1569, 906);
    official.setFov(36.87511294314776);
    const expected = official.calculateCenterFromCameraLngLatAlt({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI }, location.height, frame.camera.heading * 180 / Math.PI, 90 + frame.camera.pitch * 180 / Math.PI);
    const current = zoomForFrame(pyramid, frame, cache)!;
    expect(current.styleZoom).toBeCloseTo(expected.zoom, 10);
    expect(current.zoom).toBe(Math.floor(expected.zoom));
    expect(current.zoom).not.toBe(initial.zoom);
    const cold = cameraFrame({ projection: new WebMercatorProjection(), longitude: 121.483, latitude: 31.226, height: 1800, heading: Math.PI / 4, pitch: 5 * Math.PI / 180, width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 });
    expect(zoomForFrame(pyramid, cold, new WeakMap())!.styleZoom).toBeCloseTo(current.styleZoom, 10);
    const deep = new OverscaledTileID(25, 0, 25, 13722 * 2 ** 11, 6693 * 2 ** 11);
    expect(sky.select(deep)).toEqual(deep.scaledTo(current.zoom));
    expect(sky.allows(deep)).toBe(false);
    const rays = vi.spyOn(frame.camera, 'getPickRay');
    expect(sourceTileLodForFrame(pyramid, frame, cache, 0)).toBe(sky);
    expect(zoomForFrame(pyramid, frame, cache)).toBe(current);
    expect(rays).not.toHaveBeenCalled();
  });

  it('rechecks source limits without a pose or center zoom change', () => {
    const frame = cameraFrame({ projection: new WebMercatorProjection(), longitude: 121.483, latitude: 31.226, height: 1800, heading: Math.PI / 4, pitch: -15 * Math.PI / 180, width: 1569, heightPixels: 906, fovY: 36.87511294314776 * Math.PI / 180 });
    const source = { type: 'vector', minzoom: 0, maxzoom: 14, tileSize: 512 };
    const pyramid = { getSource: () => source };
    const cache = new WeakMap();
    const initialZoom = zoomForFrame(pyramid, frame, cache)!;
    const initial = sourceTileLodForFrame(pyramid, frame, cache, 0)!;
    const far = new OverscaledTileID(14, 0, 14, 13760, 6720);
    expect(initial.select(far)!.canonical.z).toBeLessThan(12);
    const rays = vi.spyOn(frame.camera, 'getPickRay');
    source.minzoom = 12;
    expect(zoomForFrame(pyramid, frame, cache)).toBe(initialZoom);
    expect(sourceTileLodForFrame(pyramid, frame, cache, 0)!.select(far)).toBeUndefined();
    source.maxzoom = 16;
    expect(sourceTileLodForFrame(pyramid, frame, cache, 0)!.maxZoom).toBe(16);
    expect(sourceTileLodForFrame(pyramid, frame, cache, 2)!.maxZoom).toBe(18);
    expect(rays).not.toHaveBeenCalled();
  });

  it.each(poses)('agrees with actual MapLibre coveringTiles at pitch $pitch and zoom $zoom', ({ pitch, zoom, center, roll }) => {
    const transform = new MercatorTransform({ maxPitch: 85, maxZoom: 24, renderWorldCopies: true });
    transform.resize(1569, 906);
    transform.setZoom(zoom);
    transform.setBearing(45);
    transform.setPitch(pitch);
    transform.setRoll(roll ?? 0);
    transform.setFov(36.87511294314776);
    transform.setCenter(new LngLat(center[0], center[1]));
    const camera = cameraMercatorCoordinate(transform);
    const target = MercatorCoordinate.fromLngLat(transform.center);
    const lod = new SourceTileLod({
      x: camera.x,
      y: camera.y,
      height: camera.z,
      centerDistance: Math.hypot(camera.x - target.x, camera.y - target.y, camera.z),
      fov: transform.fov * Math.PI / 180,
      variable: transform.getCoveringTilesDetailsProvider().allowVariableZoom(transform, { tileSize: 512 }),
    }, transform.zoom, 0, 14, false);
    const selected = coveringTiles(transform, { minzoom: 0, maxzoom: 14, tileSize: 512 });
    expect(selected.length).toBeGreaterThan(0);
    for (const { canonical } of selected) {
      const span = 2 ** (14 - canonical.z);
      // Every chosen footprint must stop at the oracle's ancestor, including
      // all four corners of its finest source cells and the far z10–13 tiles.
      for (const dx of [0, span - 1]) {
        for (const dy of [0, span - 1]) {
          const probe = new OverscaledTileID(14, 0, 14, canonical.x * span + dx, canonical.y * span + dy);
          expect(lod.select(probe)?.canonical.toString()).toBe(canonical.toString());
        }
      }
    }
  });

  it.each([
    { zoom: 14.7, minzoom: 12, maxzoom: 14, roundZoom: true, reparseOverscaled: false },
    { zoom: 16.7, minzoom: 0, maxzoom: 13, roundZoom: false, reparseOverscaled: true },
    { zoom: 25, minzoom: 0, maxzoom: 25, roundZoom: false, reparseOverscaled: false },
  ])('preserves wrapped MapLibre selections at source limits $minzoom–$maxzoom with zoom $zoom', ({ zoom, minzoom, maxzoom, roundZoom, reparseOverscaled }) => {
    const transform = new MercatorTransform({ maxPitch: 85, maxZoom: 25, renderWorldCopies: true });
    transform.resize(1569, 906);
    transform.setZoom(zoom);
    transform.setBearing(45);
    transform.setPitch(75);
    transform.setFov(36.87511294314776);
    transform.setCenter(new LngLat(179.999999, 31.268917513243924));
    const camera = cameraMercatorCoordinate(transform);
    const target = MercatorCoordinate.fromLngLat(transform.center);
    const lod = new SourceTileLod({
      x: camera.x,
      y: camera.y,
      height: camera.z,
      centerDistance: Math.hypot(camera.x - target.x, camera.y - target.y, camera.z),
      fov: transform.fov * Math.PI / 180,
      variable: transform.getCoveringTilesDetailsProvider().allowVariableZoom(transform, { tileSize: 512 }),
    }, transform.zoom, minzoom, maxzoom, roundZoom, reparseOverscaled);
    const oracle = coveringTiles(transform, { minzoom, maxzoom, tileSize: 512, roundZoom, reparseOverscaled });
    expect(oracle.length).toBeGreaterThan(0);
    expect(oracle.some(id => id.wrap !== 0)).toBe(true);
    for (const id of oracle) {
      const span = 2 ** (maxzoom - id.canonical.z);
      for (const dx of [0, span - 1]) {
        for (const dy of [0, span - 1]) {
          const probe = new OverscaledTileID(Math.max(maxzoom, id.overscaledZ), id.wrap, maxzoom, id.canonical.x * span + dx, id.canonical.y * span + dy);
          const selected = lod.select(probe)!;
          expect(selected.wrap).toBe(id.wrap);
          expect(selected.canonical.toString()).toBe(id.canonical.toString());
          expect(selected.overscaledZ).toBe(id.overscaledZ);
        }
      }
    }
  });
});
