import type { SymbolLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { SymbolBucket } from '../../../data/bucket/symbol-bucket';
import type { WorkerMessageSender } from '../../../worker/worker-channel';
import type { SymbolPrimitiveGeometry } from '../symbol-geometry';
import type { PlacementView } from '../symbol-placement';
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, EllipsoidalOccluder, GeometryPipeline, Intersect, Matrix4, Primitive, SceneMode, WebMercatorProjection } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Official variable-anchor foreground selection oracle.
import { SymbolBucket as MapSymbolBucket } from '../../../../../../node_modules/maplibre-gl/src/data/bucket/symbol_bucket';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Real pinned MapLibre public coordinate contract.
import { LngLat } from '../../../../../../node_modules/maplibre-gl/src/geo/lng_lat';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Independent official GLOBE surface projection.
import { projectTileCoordinatesToSphere } from '../../../../../../node_modules/maplibre-gl/src/geo/projection/globe_utils';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Real pinned MapLibre projection oracle.
import { createMercatorTransform } from '../../../../../../node_modules/maplibre-gl/src/geo/projection/mercator_transform';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Independent pinned MapLibre oracle; this source API is not exported.
import { CollisionIndex as MapCollisionIndex } from '../../../../../../node_modules/maplibre-gl/src/symbol/collision_index';

// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Official symbol identity assignment.
import { CrossTileSymbolIndex as MapCrossTileSymbolIndex } from '../../../../../../node_modules/maplibre-gl/src/symbol/cross_tile_symbol_index';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Official placement owns candidate trials and justification selection.
import { Placement as MapPlacement } from '../../../../../../node_modules/maplibre-gl/src/symbol/placement';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Official map-pitched viewport label axes.
import { getTileSkewVectors } from '../../../../../../node_modules/maplibre-gl/src/symbol/projection';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Real pinned MapLibre tile projection identity.
import { OverscaledTileID as MapTileID } from '../../../../../../node_modules/maplibre-gl/src/tile/tile_id';
// eslint-disable-next-line antfu/no-import-node-modules-by-path -- Independent MapLibre paint-to-tile conversion.
import { translatePosition } from '../../../../../../node_modules/maplibre-gl/src/util/util';
import { GeoJSONWorkerSource } from '../../../source/geojson-worker-source';
import { StyleLayerIndex } from '../../../style/style-layer-index';
import { OverscaledTileID } from '../../../tile/tile-id';
import { AlphaImage, RGBAImage } from '../../../util/image';
import { cameraFrame } from '../../scene/__test__/camera-helper';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { captureCameraForFrame, zoomForFrame } from '../../scene/render-frame';
import { symbolFrame } from '../symbol-frame';
import { projectGlyphsAlongLine, symbolBucketGeometry } from '../symbol-geometry';
import { symbolGeometry } from '../symbol-gpu-resources';
import { symbolGroundPosition, symbolMetersPerPixel } from '../symbol-perspective';
import { placeSymbolTile, projectToScreen, SymbolCollisionIndex, SymbolProjectionContext, SymbolTilePlacement, updateLineSymbolGeometry, updateVariableSymbolGeometry } from '../symbol-placement';
import { copyPlacementView } from '../symbol-placement-pass';
import { beginSymbolBuild, buildSymbolHalves, mergeSymbolHalves, SymbolTileRenderer } from '../symbol-renderer';
import { readSymbolTranslation } from '../symbol-translation';

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
    sizeData: { kind: 'source' },
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

async function workerIcons(size: NonNullable<SymbolLayerSpecification['layout']>['icon-size'], spriteSize = { width: 20, height: 10 }, allowOverlap = false, coordinates = [[0, 0], [0.001, 0]], tileID = new OverscaledTileID(15, 0, 15, 16384, 16384), pitchAlignment: 'map' | 'viewport' = 'viewport') {
  const worker = new GeoJSONWorkerSource({
    sendAsync: async () => ({ square: { data: new RGBAImage(spriteSize), pixelRatio: 1, sdf: false } }),
  } as WorkerMessageSender, new StyleLayerIndex([{
    id: 'icons',
    type: 'symbol',
    source: 'points',
    layout: { 'icon-image': 'square', 'icon-padding': 0, 'icon-size': size, 'icon-allow-overlap': allowOverlap, 'icon-pitch-alignment': pitchAlignment, ...(pitchAlignment === 'map' ? { 'icon-rotation-alignment': 'map' as const } : {}) },
  }]), ['square']);
  await worker.loadData({ type: 'geojson', source: 'points', geojsonVtOptions: { maxZoom: tileID.canonical.z, extent: 8192 }, data: {
    type: 'FeatureCollection',
    features: coordinates.map(coordinates => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates } })),
  } });
  const result = await worker.loadTile({ uid: 'layout-box', type: 'geojson', source: 'points', tileID, zoom: tileID.overscaledZ, pixelRatio: 1 });
  if (!result || result.etagUnmodified)
    throw new Error('Expected real worker symbol layout');
  const icon = symbolBucketGeometry(result.buckets[0] as SymbolBucket, tileID, tileID.key, result.collisionBoxArray, 'icons').icon!;
  return { result, icon, tileID };
}

describe('symbol collision', () => {
  it.each([
    ['date line viewport quad', 179.999, 0, 80, 0, 1, 'viewport'],
    ['date line ground corners', 179.999, 0, 80, 0, 1, 'map'],
    ['north clamp ground corners', 0, 85.0511, 0, -80, 50, 'map'],
  ] as const)('keeps a translated worker icon on its continuous CV plane: %s', async (_name, longitude, latitude, dx, dy, size, pitchAlignment) => {
    const zoom = 14;
    const tileID = new OverscaledTileID(zoom, 0, zoom, longitude ? 2 ** zoom - 1 : 2 ** (zoom - 1), latitude ? 0 : 2 ** (zoom - 1));
    const { icon, result } = await workerIcons(size, { width: 20, height: 10 }, false, [[longitude, latitude]], tileID, pitchAlignment);
    expect(icon.instances).toHaveLength(1);
    const map = createMercatorTransform({ maxZoom: 25, maxPitch: 85, renderWorldCopies: true });
    map.resize(640, 720);
    map.setFov(45);
    map.setZoom(zoom);
    map.setCenter(new LngLat(longitude, latitude));
    const frame = { ...cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), longitude: map.center.lng, latitude: map.center.lat, height: map.cameraToCenterDistance * symbolMetersPerPixel(zoom), width: 640, heightPixels: 720, fovY: Math.PI / 4 }), frameNumber: 1 };
    const cameraCache = new WeakMap();
    const snapshot = captureCameraForFrame(frame, cameraCache, SceneMode.COLUMBUS_VIEW)!;
    const actualZoom = zoomForFrame({ getSource: () => ({ type: 'geojson', maxzoom: zoom }) }, frame, cameraCache)!.styleZoom;
    expect(Math.abs(actualZoom - map.zoom)).toBeLessThan(1e-6);
    const view = symbolFrame(snapshot, actualZoom);
    const mapID = new MapTileID(zoom, 0, zoom, tileID.canonical.x, tileID.canonical.y);
    const instance = (result.buckets[0] as SymbolBucket).symbolInstances.get(0);
    const workerBox = result.collisionBoxArray.get(instance.iconBoxStartIndex);
    const translation = { pixels: new Cartesian2(dx, dy), anchor: 'map' as const };
    const offset = translatePosition(map, { tileID: mapID, tileSize: 512 }, [dx, dy], 'map');
    const oracle = new MapCollisionIndex(map);
    const expected = oracle.placeCollisionBox(workerBox, 'never', 512 / 8192, mapID, mapID.toUnwrapped(), pitchAlignment === 'map', pitchAlignment === 'map', offset);
    expect(expected.placeable).toBe(true);
    const mapPoint = map.projectTileCoordinates(instance.anchorX + offset[0], instance.anchorY + offset[1], mapID.toUnwrapped());
    const screen = { x: (mapPoint.point.x * 0.5 + 0.5) * 640, y: (-mapPoint.point.y * 0.5 + 0.5) * 720 };
    if (longitude) {
      expect(screen.x).toBeGreaterThan(390);
      expect(screen.x).toBeLessThan(410);
    }
    else {
      expect(screen.y).toBeLessThan(0);
      expect(screen.y).toBeGreaterThan(-100);
    }
    const native = symbolGeometry(icon, icon.indices)!;
    GeometryPipeline.projectTo2D(native, 'position', 'position3D', 'position2D', frame.mapProjection);
    const original = native.attributes.position2D.values;
    const gpuPosition = new Cartesian3(original[2], original[0] + dx * symbolMetersPerPixel(actualZoom), original[1] - dy * symbolMetersPerPixel(actualZoom));
    const gpuPixel = projectToScreen(view.viewProjection, 640, 720, gpuPosition.x, gpuPosition.y, gpuPosition.z)!;
    expect(gpuPixel.sx).toBeCloseTo(screen.x, 5);
    expect(gpuPixel.sy).toBeCloseTo(screen.y, 5);
    const options = { pairs: [{ text: -1, icon: 0 }], iconTranslation: translation };
    const index = new SymbolCollisionIndex();
    placeSymbolTile(undefined, icon, view, index, options);
    expect(icon.opacities[0]).toBe(Number(expected.placeable));
    expect(index.collides({ x1: screen.x - 1, x2: screen.x + 1, y1: screen.y - 1, y2: screen.y + 1 }, 'never')).toBe(true);
    index.clear();
    index.reserve({ x1: screen.x - 1, x2: screen.x + 1, y1: screen.y - 1, y2: screen.y + 1 }, 'never');
    placeSymbolTile(undefined, icon, view, index, options);
    expect(icon.opacities[0]).toBe(0);
  });

  it('publishes a translated worker line moved in front of the real ellipsoid horizon', async () => {
    const tileID = new OverscaledTileID(7, 0, 7, 85, 64);
    const worker = new GeoJSONWorkerSource({
      sendAsync: async () => ({ square: { data: new RGBAImage({ width: 2, height: 2 }), pixelRatio: 1, sdf: false } }),
    } as WorkerMessageSender, new StyleLayerIndex([{
      id: 'icons',
      type: 'symbol',
      source: 'line',
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 10, 'icon-image': 'square', 'icon-size': 1, 'icon-padding': 0, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' },
    }]), ['square']);
    await worker.loadData({ type: 'geojson', source: 'line', geojsonVtOptions: { maxZoom: 7, extent: 8192 }, data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[60.06, 0], [60.14, 0]] },
    } });
    const result = await worker.loadTile({ uid: 'horizon-line', type: 'geojson', source: 'line', tileID, zoom: 7, pixelRatio: 1 });
    if (!result || result.etagUnmodified)
      throw new Error('Expected actual worker line layout');
    const icon = symbolBucketGeometry(result.buckets[0] as SymbolBucket, tileID, tileID.key, result.collisionBoxArray, 'icons').icon!;
    expect(icon.instances).toHaveLength(1);
    const line = icon.instances[0].line!;
    expect(line.pathECEF.length).toBeGreaterThanOrEqual(6);
    const translation = { pixels: new Cartesian2(-40, 0), anchor: 'map' as const };
    const frame = { ...cameraFrame({ mode: SceneMode.SCENE3D, projection: new WebMercatorProjection(), height: Ellipsoid.WGS84.maximumRadius, width: 640, heightPixels: 720, fovY: Math.PI / 4 }), frameNumber: 1 };
    const movedLongitude = 60.1 - 40 * 360 / (512 * 2 ** 7);
    const destination = Cartesian3.fromDegrees(movedLongitude, 0);
    frame.camera.setView({ destination: frame.camera.positionWC, orientation: {
      direction: Cartesian3.normalize(Cartesian3.subtract(destination, frame.camera.positionWC, new Cartesian3()), new Cartesian3()),
      up: Cartesian3.UNIT_Z,
    } });
    const cameraCache = new WeakMap();
    const snapshot = captureCameraForFrame(frame, cameraCache, SceneMode.SCENE3D)!;
    const zoom = zoomForFrame({ getSource: () => ({ type: 'geojson', maxzoom: 7 }) }, frame, cameraCache)!.styleZoom;
    // A retained worker generation keeps its source canonical zoom while
    // projection and translation follow the real current Native camera zoom.
    const view = symbolFrame(snapshot, zoom);
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, frame.camera.positionWC);
    expect(occluder.isPointVisible(line.anchorECEF)).toBe(false);
    const row = (result.buckets[0] as SymbolBucket).symbolInstances.get(0);
    const sphere = projectTileCoordinatesToSphere(row.anchorX, row.anchorY, 85, 64, 7);
    const movedTileX = row.anchorX - 40 * 8192 / 512 * 2 ** (7 - zoom);
    const movedSphere = projectTileCoordinatesToSphere(movedTileX, row.anchorY, 85, 64, 7);
    const movedAnchor = Cartesian3.fromDegrees(((85 + movedTileX / 8192) / 2 ** 7 - 0.5) * 360, 0);
    // For this actual camera (2 radii from the center), the official GLOBE
    // horizon plane is z=1/2. Both engines independently qualify the crossing.
    expect(sphere[2]).toBeLessThan(0.5);
    expect(movedSphere[2]).toBeGreaterThan(0.5);
    expect(occluder.isPointVisible(movedAnchor)).toBe(true);
    const original = projectToScreen(view.viewProjection, 640, 720, line.anchorECEF.x, line.anchorECEF.y, line.anchorECEF.z)!;
    const expectedRatio = 0.5 + 0.5 * view.cameraToCenterDistance! / original.clipW;
    const moved = projectToScreen(view.viewProjection, 640, 720, movedAnchor.x, movedAnchor.y, movedAnchor.z)!;
    expect(expectedRatio).not.toBe(0.5 + 0.5 * view.cameraToCenterDistance! / moved.clipW);
    const projections = new SymbolProjectionContext();
    const placement = new SymbolTilePlacement(undefined, icon, view, new SymbolCollisionIndex(), { pairs: [{ text: -1, icon: 0 }], iconTranslation: translation });
    placement.advance(1, projections);
    placement.commit();
    expect(icon.opacities[0]).toBe(1);
    updateLineSymbolGeometry(icon, view, placement.selection.instanceIndices('icon'), projections, translation);
    const projected = projections.line(icon, 0, view, translation)!;
    expect(projected.perspective).toBe(expectedRatio);
    expect(icon.dynamics[2]).not.toBe(16);
  });

  it('moves a real worker point box into an independent blocker before projection', async () => {
    const { icon } = await workerIcons(1);
    const pitch = Math.PI / 3;
    const projection = Matrix4.computePerspectiveFieldOfView(Math.PI / 4, 640 / 720, 0.1, 100000, new Matrix4());
    const camera = Matrix4.computeView(new Cartesian3(120, 0, -120 * Math.tan(pitch)), new Cartesian3(-Math.cos(pitch), 0, Math.sin(pitch)), new Cartesian3(Math.sin(pitch), 0, Math.cos(pitch)), new Cartesian3(0, 1, 0), new Matrix4());
    const ground = new WebMercatorProjection();
    const view = {
      ...VIEW,
      width: 640,
      height: 720,
      cameraZoom: 16,
      orthographic: false,
      cameraToCenterDistance: 240,
      bearing: 0,
      viewProjection: Matrix4.multiply(projection, camera, new Matrix4()),
      projectPosition: (x: number, y: number, z: number): [number, number, number] => {
        const p = ground.project(Ellipsoid.WGS84.cartesianToCartographic(new Cartesian3(x, y, z))!);
        return [p.z, p.x, p.y];
      },
    };
    // Independent ground oracle: Map tile pixels at live zoom, before the
    // public Cesium camera projection. The worker anchor is longitude/latitude 0.
    const destination = symbolGroundPosition(30 * symbolMetersPerPixel(view.cameraZoom), 20 * symbolMetersPerPixel(view.cameraZoom));
    const pixel = projectToScreen(view.viewProjection, view.width, view.height, destination.x, destination.y, destination.z, view.projectPosition)!;
    const index = new SymbolCollisionIndex();
    index.reserve({ x1: pixel.sx - 1, x2: pixel.sx + 1, y1: pixel.sy - 1, y2: pixel.sy + 1 }, 'never');
    const options = { pairs: [{ text: -1, icon: 0 }], iconTranslation: { pixels: new Cartesian2(30, 20), anchor: 'map' as const } };
    placeSymbolTile(undefined, icon, view, index, { pairs: options.pairs });
    expect(icon.opacities[0]).toBe(1);
    index.clear();
    index.reserve({ x1: pixel.sx - 1, x2: pixel.sx + 1, y1: pixel.sy - 1, y2: pixel.sy + 1 }, 'never');
    placeSymbolTile(undefined, icon, view, index, options);
    expect(icon.opacities[0]).toBe(0);
  });

  it('reserves the real worker layout box while a camera-sized icon is drawn smaller', async () => {
    const { result, icon, tileID } = await workerIcons(['interpolate', ['linear'], ['zoom'], 15, 0.5, 16, 1]);
    expect(icon.instances).toHaveLength(2);
    expect(icon.instances[0].collisionBox).toMatchObject({ x1: -10, y1: -5, x2: 10, y2: 5, layoutSize: 1 });
    const firstY = icon.positions[1];
    const secondY = icon.positions[icon.instances[1].vertexStart * 3 + 1];
    const view = { ...VIEW, cameraZoom: 15, projectPosition: (_x: number, y: number) => [(y - firstY) / (secondY - firstY) * 0.3, 0, 0] as [number, number, number] };
    // Both engines receive the worker's actual tile-unit box. Only projection
    // is replaced by this orthographic 50px/65px pair; the MapLibre collision
    // algorithm is the independent oracle, including its real grid insertion.
    const oracle = new MapCollisionIndex({ width: 100, height: 100, pitch: 0, cameraToCenterDistance: 100 } as ConstructorParameters<typeof MapCollisionIndex>[0]);
    vi.spyOn(oracle, 'projectAndGetPerspectiveRatio').mockImplementation(x => ({ x: x === 0 ? 150 : 165, y: 150, perspectiveRatio: 1, isOccluded: false }));
    const expected: number[] = [];
    for (let index = 0; index < 2; index++) {
      const instance = (result.buckets[0] as SymbolBucket).symbolInstances.get(index);
      const box = result.collisionBoxArray.get(instance.iconBoxStartIndex);
      const placed = oracle.placeCollisionBox(box, 'never', 512 / 8192, tileID as never, { wrap: 0, canonical: tileID.canonical } as never, false, false, [0, 0]);
      expected.push(Number(placed.placeable));
      if (placed.placeable)
        oracle.insertCollisionBox(placed.box, 'never', false, 0, index, 0);
    }
    expect(expected).toEqual([1, 0]);
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect(icon.instances.map(instance => icon.opacities[instance.vertexStart])).toEqual(expected);
  });

  it('places a real worker large icon when its offscreen anchor is beyond collision padding', async () => {
    const { icon } = await workerIcons(300, { width: 8, height: 8 });
    // Anchor x=800 is beyond the 100px view plus 256px collision padding;
    // the real 8px sprite at size=300 still spans x=-400..2000.
    const view = { ...VIEW, cameraZoom: 15, projectPosition: () => [15, 0, 0] as [number, number, number] };
    placeIcons(icon, view, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(1);
  });

  it('honors allow-overlap when a real worker large icon cannot occupy the collision grid', async () => {
    const { icon } = await workerIcons(300, { width: 16, height: 16 }, true);
    // Match the actual GPU regression: its wide sprite exceeds the worker
    // int16 collision-box range. MapLibre still draws an allow-overlap icon
    // when its collision box is unplaceable; raster coverage is authoritative.
    placeIcons(icon, { ...VIEW, cameraZoom: 15, projectPosition: () => [15, 0, 0] }, new SymbolCollisionIndex());
    expect(icon.opacities[0]).toBe(1);
  });

  it('filters a completed symbol safely near the camera plane without exceeding Map capacity', () => {
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
    matrix[15] = 1e-18;
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

  it('does not let a far-side symbol block a visible front-side symbol', () => {
    const index = new SymbolCollisionIndex();
    const back = onGlobe(false);
    const front = onGlobe(true);
    placeIcons(back, globeView(), index);
    placeIcons(front, globeView(), index);
    expect(back.opacities[0]).toBe(0);
    expect(front.opacities[0]).toBe(1);
  });

  it('places a line glyph at a corner across a zero-length path segment', () => {
    const xs = [0, 10, 10, 20];
    const ys = [0, 0, 0, 0];
    const placed = projectGlyphsAlongLine(index => xs[index], index => ys[index], 0, xs.length, 5, 0, 0, [0, 5, 10], 0, { flip: false, lineOffsetY: 0, rotateToLine: true });
    expect(placed?.points.map(point => point.x)).toEqual([5, 10, 15]);
    expect(placed?.angles.every(angle => angle === 0)).toBe(true);
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

it('walks map glyphs in the Mercator label plane before actual CV projection', () => {
  let projectionCalls = 0;
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
      projectionCalls++;
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

  const shared = new SymbolProjectionContext();
  const current = shared.line(label, 0, view)!;
  const translation = { pixels: new Cartesian2(30, 20), anchor: 'map' as const };
  const shifted = shared.line(label, 0, view, translation)!;
  const moved = symbolGroundPosition(-expected + 30 * symbolMetersPerPixel(view.cameraZoom), -800 + 20 * symbolMetersPerPixel(view.cameraZoom));
  const movedPixel = projectToScreen(matrix, 640, 720, moved.x, moved.y, moved.z, view.projectPosition)!;
  expect(shifted.points[0].x).toBeCloseTo(movedPixel.sx, 6);
  expect(shifted.points[0].y).toBeCloseTo(movedPixel.sy, 6);
  // MapLibre deliberately retains the original worker-anchor CPU ratio while
  // translating the line path; moving that ratio changes glyph spacing.
  expect(shifted.perspective).toBe(current.perspective);
  const projectedOnce = projectionCalls;
  const frozen = copyPlacementView(view);
  expect(shared.line(label, 0, frozen)!.points).toEqual(current.points);
  expect(shared.line(label, 0, copyPlacementView(view))!.angles).toEqual(current.angles);
  expect(projectionCalls).toBe(projectedOnce);
  expect(shared.line(label, 0, copyPlacementView({ ...view }))!.points).toEqual(current.points);
  expect(projectionCalls).toBeGreaterThan(projectedOnce);

  const projectPosition = view.projectPosition!;
  view.projectPosition = (x, y, z) => {
    const point = projectPosition(x, y, z)!;
    return [point[0], point[1] + 100, point[2]];
  };
  expect(shared.line(label, 0, copyPlacementView(view))!.points).not.toEqual(current.points);
  view.projectPosition = projectPosition;
  matrix[12] += 1e-7;
  expect(shared.line(label, 0, copyPlacementView(view))!.points).not.toEqual(current.points);
  matrix[12] -= 1e-7;
  view.cameraZoom++;
  expect(shared.line(label, 0, copyPlacementView(view))!.points).not.toEqual(current.points);
  view.cameraZoom--;
  view.viewport = { x: 40, y: 0, width: 320, height: 720 };
  expect(shared.line(label, 0, copyPlacementView(view))!.points).not.toEqual(current.points);
  view.viewport = undefined;
  view.isPointVisible = () => false;
  expect(shared.line(label, 0, copyPlacementView(view))).toBeUndefined();

  const successor = { ...label, instances: [{ ...label.instances[0], line: { ...label.instances[0].line!, glyphOffsets: new Float32Array([-48, 48]) } }] };
  expect(shared.line(successor, 0, frozen)!.points).not.toEqual(current.points);
  expect(shared.line(label, 0, frozen)!.points).toEqual(current.points);
});

it('switches the CJK glyph candidate in the current view and returns to horizontal writing', () => {
  const label = geometry([[30, 70], [30, 70]], true);
  for (let index = 0; index < 2; index++) {
    Object.assign(label.instances[index].line!, {
      pathECEF: new Float64Array([-0.8, 0, 0, 0.8, 0, 0]),
      glyphOffsets: new Float32Array(index === 0 ? [-12, 12] : [-18, 18]),
      writingMode: index === 0 ? 1 : 2,
      alternate: 1 - index,
    });
    label.instances[index].collisionCircles = { diameter: 4, padding: 0 };
  }
  const options = { pairs: [{ text: 0, textAlternative: 1, icon: -1 }] };
  const vertical = new Float64Array(VIEW.viewProjection);
  vertical[0] = vertical[5] = 0;
  vertical[1] = 1;
  vertical[4] = -1;
  const verticalView = { ...VIEW, viewProjection: vertical };
  const projections = new SymbolProjectionContext();
  const index = new SymbolCollisionIndex();
  const blocker = geometry([[50]]);
  for (let vertex = 0; vertex < 4; vertex++)
    blocker.positions[vertex * 3 + 1] = 0.38;
  // The blocker intersects the wider vertical shaping, but not the
  // horizontal collision proxy used by MapLibre for either writing mode.
  placeIcons(blocker, VIEW, index);
  const placement = new SymbolTilePlacement(label, undefined, verticalView, index, options);
  placement.advance(1, projections);
  placement.commit();
  expect(label.opacities[8]).toBe(1);
  expect(projections.line(label, 0, verticalView)).toBeUndefined();
  expect(projections.line(label, 1, verticalView)?.points[0].y).toBeCloseTo(32);
  updateLineSymbolGeometry(label, verticalView, placement.selection.instanceIndices('text'), projections);
  // Return through the same complete logical candidate: a current-view
  // filter must retain the other writing mode for a later camera pose.
  index.clear();
  placement.selection.filter(VIEW, index, options, projections);
  expect(projections.line(label, 0, VIEW)?.points[0].x).toBeCloseTo(38);
  expect(projections.line(label, 1, VIEW)).toBeUndefined();
  updateLineSymbolGeometry(label, VIEW, placement.selection.instanceIndices('text'), projections);
  expect(updateLineSymbolGeometry(label, VIEW, placement.selection.instanceIndices('text'), projections)).toBe(false);
});

it('keeps upright glyphs without flipping their horizontal collision proxy', () => {
  const label = geometry([[30, 70]], true);
  Object.assign(label.instances[0].line!, {
    pathECEF: new Float64Array([0.8, 0, 0, -0.8, 0, 0]),
    glyphOffsets: new Float32Array([-16, 8]),
    writingMode: 1,
  });
  label.instances[0].collisionCircles = { diameter: 4, padding: 0 };
  const index = new SymbolCollisionIndex();
  placeIcons(geometry([[32]]), VIEW, index);
  const projections = new SymbolProjectionContext();
  const placement = new SymbolTilePlacement(label, undefined, VIEW, index, { pairs: [{ text: 0, icon: -1 }] });
  placement.advance(1, projections);
  placement.commit();
  // The unflipped glyph span is 42..66, clear of the blocker's 27..37.
  // Flipping asymmetric glyph offsets incorrectly moves it to 34..58.
  expect(Array.from(label.opacities)).toEqual(Array.from({ length: 8 }).fill(1));
  updateLineSymbolGeometry(label, VIEW, placement.selection.instanceIndices('text'), projections);
  const visible = projections.line(label, 0, VIEW)!;
  expect(visible.points[0].x).toBeCloseTo(34);
  expect(visible.points[1].x).toBeCloseTo(58);
  expect(projections.line(label, 0, VIEW)?.angles).toEqual([0, 0]);
});

it.each([
  ['map', false, 0, 0],
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

it('updates real collision visibility when a zero composite lower stop grows at the live zoom', () => {
  const icon = geometry([[50]]);
  icon.sizes.fill(0);
  icon.sizesMax.fill(2 * 128);
  icon.sizeData = { kind: 'composite', minZoom: 15, maxZoom: 16, interpolationType: { name: 'exponential', base: 2 } };
  const index = new SymbolCollisionIndex();
  placeIcons(geometry([[60]]), VIEW, index);
  placeIcons(icon, { ...VIEW, cameraZoom: 15.5 }, index);
  expect(icon.opacities[0]).toBe(1);
  index.clear();
  placeIcons(geometry([[60]]), VIEW, index);
  placeIcons(icon, { ...VIEW, cameraZoom: 16 }, index);
  expect(icon.opacities[0]).toBe(0);
});

// Dense labels must try worker candidates; multiline candidates must draw once.
async function variableLabels(variable: boolean, multiline = false, count = 2, options: { layerId?: string; layout?: SymbolLayerSpecification['layout']; paint?: SymbolLayerSpecification['paint']; bearing?: number; pitch?: number; cameraZoom?: number; sourceZoom?: number; coordinates?: [number, number]; focusOffset?: number } = {}) {
  const zoom = options.cameraZoom ?? 14;
  const sourceZoom = options.sourceZoom ?? zoom;
  const coordinates = options.coordinates ?? [0.001, -0.001];
  const sourceX = Math.floor((coordinates[0] / 360 + 0.5) * 2 ** sourceZoom);
  const sourceY = Math.floor((0.5 - Math.asinh(Math.tan(coordinates[1] * Math.PI / 180)) / (2 * Math.PI)) * 2 ** sourceZoom);
  const tileID = new OverscaledTileID(sourceZoom, 0, sourceZoom, sourceX, sourceY);
  const layer: SymbolLayerSpecification = { id: options.layerId ?? 'labels', type: 'symbol', source: 'points', layout: { 'text-field': ['get', 'label'], 'text-font': ['Test'], 'text-size': 24, 'text-padding': 0, 'text-justify': 'auto', 'symbol-z-order': 'source', ...(variable ? { 'text-variable-anchor': ['left', 'right'], 'text-radial-offset': 0.5 } : {}), ...options.layout }, paint: options.paint };
  const worker = new GeoJSONWorkerSource({ sendAsync: async (message: { type: string; data: { stacks: Record<string, string[]> } }) => {
    if (message.type === 'GI')
      return { square: { data: new RGBAImage({ width: 16, height: 12 }, new Uint8Array(16 * 12 * 4).fill(255)), pixelRatio: 1, sdf: false } };
    if (message.type !== 'GG')
      throw new Error('Unexpected network request');
    return Object.fromEntries(Object.entries(message.data.stacks).map(([stack, ids]) => [stack, Object.fromEntries(ids.map(id => [id, { id: id.codePointAt(0)!, bitmap: new AlphaImage({ width: 16, height: 24 }, new Uint8Array(16 * 24).fill(255)), metrics: { width: 10, height: 18, left: 0, top: 18, advance: 12 } }]))]));
  } } as unknown as WorkerMessageSender, new StyleLayerIndex([layer]), ['square']);
  await worker.loadData({ type: 'geojson', source: 'points', geojsonVtOptions: { maxZoom: sourceZoom, extent: 8192 }, data: { type: 'FeatureCollection', features: Array.from({ length: count }, (_, id) => ({ type: 'Feature', id, properties: { label: multiline ? 'ABC\nA' : id === 0 ? 'ABC' : 'DEF' }, geometry: { type: 'Point', coordinates } })) } });
  const result = await worker.loadTile({ uid: `${variable}-${multiline}`, type: 'geojson', source: 'points', tileID, zoom: sourceZoom, pixelRatio: 1 });
  if (!result || result.etagUnmodified)
    throw new Error('Expected real worker text layout');
  const bucket = result.buckets[0] as SymbolBucket;
  expect(bucket.symbolInstances.length).toBe(count);
  expect(result.glyphAtlasImage.data.some((value: number) => value > 0)).toBe(true);
  const extracted = symbolBucketGeometry(bucket, tileID, tileID.key, result.collisionBoxArray, layer.id);
  const text = extracted.text!;
  const map = createMercatorTransform({ maxZoom: 25, maxPitch: 85, renderWorldCopies: true });
  map.resize(640, 720);
  map.setFov(45);
  map.setZoom(zoom);
  const focus = bucket.symbolInstances.get(0);
  const focusX = (tileID.canonical.x + focus.anchorX / 8192) / 2 ** sourceZoom;
  const focusY = (tileID.canonical.y + focus.anchorY / 8192) / 2 ** sourceZoom;
  map.setCenter(new LngLat((focusX - 0.5) * 360 - (options.focusOffset ?? 0) * 360 / (512 * 2 ** zoom), Math.atan(Math.sinh(Math.PI * (1 - 2 * focusY))) * 180 / Math.PI));
  map.setBearing(options.bearing ?? 0);
  map.setPitch(options.pitch ?? 0);
  const frame = { ...cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), longitude: map.center.lng, latitude: map.center.lat, height: map.cameraToCenterDistance * symbolMetersPerPixel(zoom), width: 640, heightPixels: 720, fovY: Math.PI / 4 }), frameNumber: 1 };
  if (options.bearing || options.pitch) {
    // The actual normalized camera distance is in Mercator pixels, so all
    // three Native axes use projected metres rather than physical altitude.
    const focus = frame.mapProjection.project(Cartographic.fromDegrees(map.center.lng, map.center.lat));
    const distance = map.cameraToCenterDistance * symbolMetersPerPixel(zoom);
    const bearing = map.bearingInRadians;
    const pitch = map.pitchInRadians;
    const position = new Cartesian3(distance * Math.cos(pitch), focus.x - distance * Math.sin(pitch) * Math.sin(bearing), focus.y - distance * Math.sin(pitch) * Math.cos(bearing));
    const direction = new Cartesian3(-Math.cos(pitch), Math.sin(pitch) * Math.sin(bearing), Math.sin(pitch) * Math.cos(bearing));
    const up = new Cartesian3(Math.sin(pitch), Math.cos(pitch) * Math.sin(bearing), Math.cos(pitch) * Math.cos(bearing));
    const right = Cartesian3.cross(direction, up, new Cartesian3());
    frame.camera.position = frame.camera.worldToCameraCoordinatesPoint(position);
    frame.camera.direction = frame.camera.worldToCameraCoordinatesVector(direction);
    frame.camera.up = frame.camera.worldToCameraCoordinatesVector(up);
    frame.camera.right = frame.camera.worldToCameraCoordinatesVector(right);
  }
  const cache = new WeakMap();
  const snapshot = captureCameraForFrame(frame, cache, SceneMode.COLUMBUS_VIEW)!;
  const actualZoom = zoomForFrame({ getSource: () => ({ type: 'geojson', maxzoom: sourceZoom }) }, frame, cache)!.styleZoom;
  expect(Math.abs(actualZoom - map.zoom)).toBeLessThan(1e-6);
  const view = symbolFrame(snapshot, actualZoom);
  const anchor = bucket.symbolInstances.get(0);
  const nativePoint = projectToScreen(view.viewProjection, 640, 720, text.positions[0], text.positions[1], text.positions[2], view.projectPosition)!;
  const mapPoint = map.projectTileCoordinates(anchor.anchorX, anchor.anchorY, new MapTileID(sourceZoom, 0, sourceZoom, sourceX, sourceY).toUnwrapped());
  const mapScreen = { x: (mapPoint.point.x / 2 + 0.5) * 640, y: (0.5 - mapPoint.point.y / 2) * 720 };
  expect(nativePoint.sx).toBeCloseTo(mapScreen.x, 5);
  expect(nativePoint.sy).toBeCloseTo(mapScreen.y, 5);
  const nativeIndex = new SymbolCollisionIndex();
  const textTranslation = readSymbolTranslation(bucket.layers[0].paint, 'text');
  const iconTranslation = readSymbolTranslation(bucket.layers[0].paint, 'icon');
  const native = new SymbolTilePlacement(text, extracted.icon, view, nativeIndex, { pairs: extracted.pairs, textOptional: bucket.layers[0].layout.get('text-optional'), iconOptional: bucket.layers[0].layout.get('icon-optional'), textTranslation, iconTranslation });
  native.advance(Infinity, new SymbolProjectionContext());
  native.commit();
  const nativeVisible = text.instances.filter(instance => text.opacities.subarray(instance.vertexStart, instance.vertexStart + instance.vertexCount).some(value => value > 0));
  // Map foreground adapter uses original Worker arrays and official prototype,
  // not invented collision math. Our runtime intentionally omits Map GL methods.
  const mapBucket = Object.assign(Object.create(MapSymbolBucket.prototype), bucket) as MapSymbolBucket;
  const mapID = new MapTileID(sourceZoom, 0, sourceZoom, sourceX, sourceY);
  const mapTile = { getBucket: () => mapBucket, latestFeatureIndex: result.featureIndex, tileID: mapID, tileSize: 512, collisionBoxArray: result.collisionBoxArray, holdingForSymbolFade: () => false };
  new MapCrossTileSymbolIndex().addLayer(bucket.layers[0] as unknown as Parameters<MapCrossTileSymbolIndex['addLayer']>[0], [mapTile] as unknown as Parameters<MapCrossTileSymbolIndex['addLayer']>[1], map.center.lng);
  for (let i = 0; i < bucket.symbolInstances.length; i++) {
    const row = bucket.symbolInstances.get(i);
    expect(row.crossTileID).toBeGreaterThan(0);
    for (const index of [row.leftJustifiedTextSymbolIndex, row.centerJustifiedTextSymbolIndex, row.rightJustifiedTextSymbolIndex, row.verticalPlacedTextSymbolIndex]) {
      if (index >= 0)
        bucket.text.placedSymbolArray.get(index).crossTileID = row.crossTileID;
    }
  }
  const placement = new MapPlacement(map, undefined!, 0, true);
  const parts: Parameters<MapPlacement['getBucketParts']>[0] = [];
  placement.getBucketParts(parts, bucket.layers[0] as unknown as Parameters<MapPlacement['getBucketParts']>[1], mapTile as unknown as Parameters<MapPlacement['getBucketParts']>[2], false);
  expect(parts.length).toBe(1);
  placement.placeLayerBucketPart(parts[0], {}, true);
  const mapVisible = Object.values(placement.placements).filter(p => p.text).length;
  const mapGlyphs = Array.from({ length: mapBucket.text.placedSymbolArray.length }, (_, i) => mapBucket.text.placedSymbolArray.get(i)).filter(s => s.crossTileID > 0 && placement.placements[s.crossTileID]?.text).reduce((sum: number, s) => sum + s.numGlyphs, 0);
  const nativeGlyphs = nativeVisible.reduce((sum: number, s) => sum + s.vertexCount / 4, 0);
  const nativeVisibleTriangles = Array.from({ length: text.indices.length / 3 }, (_, i) => [text.indices[i * 3], text.indices[i * 3 + 1], text.indices[i * 3 + 2]]).filter(triangle => triangle.every(vertex => text.opacities[vertex] > 0)).length;
  const record = { nativeVisibleTriangles, mapVisibleTriangles: mapGlyphs * 2, nativeVisible: nativeVisible.length, mapVisible, nativeGlyphs, mapGlyphs };
  return { ...record, extracted, view, tileID, bucket, result, frame, map, placement, nativeIndex, textTranslation, iconTranslation, mapBucket, mapTile };
}

it('places both dense labels using real worker variable anchors as official Placement does', async () => {
  const control = await variableLabels(false);
  expect(control.nativeVisible).toBe(1);
  expect(control.mapVisible).toBe(1);
  const variable = await variableLabels(true);
  expect(variable.mapVisible).toBe(2);
  expect(variable.nativeVisible).toBe(variable.mapVisible);
});
it('draws one requested multiline label rather than all worker justification candidates', async () => {
  const control = await variableLabels(false, true, 1);
  expect(control.nativeGlyphs).toBe(4);
  expect(control.mapGlyphs).toBe(4);
  const variable = await variableLabels(true, true, 1);
  expect(variable.mapGlyphs).toBe(4);
  expect(variable.nativeVisibleTriangles).toBe(variable.mapVisibleTriangles);
});

function publishVariableTile(renderer: SymbolTileRenderer, data: Awaited<ReturnType<typeof variableLabels>>, tileId = 'variable') {
  const { extracted, tileID, bucket, result } = data;
  const state = beginSymbolBuild({ tileId, tileKey: tileId, tileID, buckets: {}, collisionBoxArray: result.collisionBoxArray, layers: bucket.layers, pixelRatio: 1 }, undefined, undefined);
  const halves = buildSymbolHalves({ tileId, layerId: bucket.layers[0].id, geometry: extracted, textAtlas: { image: document.createElement('canvas'), width: 1, height: 1, shareKey: 'variable-text' }, iconAtlas: extracted.icon ? { image: document.createElement('canvas'), width: 1, height: 1, shareKey: 'variable-icon' } : undefined, textColor: Color.WHITE, iconColor: Color.WHITE, pixelRatio: 1 });
  for (const half of halves)
    half.translation = readSymbolTranslation(bucket.layers[0].paint, half.part);
  const merged = mergeSymbolHalves(tileId, halves)!;
  state.entry = { input: state.input, batches: [extracted], layerIds: [bucket.layers[0].id], halves, collections: [merged.collection], primitives: merged.primitives, key: tileId, materials: new Set(halves.map(half => half.material)), atlasKeys: [], placed: false, bytes: 0 };
  return { halves, merged, change: renderer.commitBuild(state) };
}

it('publishes variable displacement with a complete renderer pass before the first owner upload', async () => {
  const data = await variableLabels(true);
  const { extracted, view } = data;
  vi.stubGlobal('OffscreenCanvas', class {});
  const renderer = new SymbolTileRenderer();
  try {
    const { halves } = publishVariableTile(renderer, data);
    renderer.update(view, true, undefined, operation => operation({ exhausted: true, takeMinimumProgress: () => true }));
    expect(extracted.text!.opacities.some(value => value > 0)).toBe(false);
    expect(extracted.text!.dynamics.some(value => value !== 0)).toBe(false);
    renderer.update(view, false, undefined, operation => operation(UNBOUNDED_BUDGET));
    // Each 36px label chooses a box edge plus the requested 12px radial gap.
    expect(extracted.text!.dynamics[0]).toBeCloseTo(30, 5);
    expect(extracted.text!.dynamics[12 * 3]).toBeCloseTo(-30, 5);
    expect(halves[0].geometry.attributes.a_dynamic.values).toBe(extracted.text!.dynamics);
  }
  finally {
    renderer.removeAll();
    vi.unstubAllGlobals();
  }
});

it.each([
  ['viewport', 'viewport'],
  ['viewport', 'map'],
  ['map', 'map'],
  ['map', 'viewport'],
] as const)('places shifted worker boxes in the actual %s-pitch/%s-rotation label plane', async (pitchAlignment, rotationAlignment) => {
  const { extracted, view, placement, nativeIndex, mapBucket, textTranslation, iconTranslation } = await variableLabels(true, false, 2, { bearing: 35, pitch: 45, layout: { 'text-pitch-alignment': pitchAlignment, 'text-rotation-alignment': rotationAlignment } });
  expect(Object.values(placement.placements).filter(value => value.text)).toHaveLength(2);
  expect(extracted.text!.opacities.filter(value => value > 0)).toHaveLength(24);
  for (const boxes of placement.collisionBoxArrays.get(mapBucket.bucketInstanceId)!.values()) {
    const [x1, y1, x2, y2] = boxes.text.map(value => value - 100);
    expect(nativeIndex.collides({ x1: (x1 + x2) / 2 - 0.1, x2: (x1 + x2) / 2 + 0.1, y1: (y1 + y2) / 2 - 0.1, y2: (y1 + y2) / 2 + 0.1 }, 'never')).toBe(true);
  }
  updateVariableSymbolGeometry(extracted, view, new SymbolProjectionContext(), textTranslation, iconTranslation);
  const dynamics = extracted.text!.dynamics;
  expect(dynamics.some(value => value !== 0)).toBe(true);
});

it('keeps source13 candidates on a translated continuous date-line plane at style zoom14', async () => {
  const { extracted, view, textTranslation, iconTranslation, tileID, nativeIndex, placement, mapBucket } = await variableLabels(true, false, 2, { sourceZoom: 13, coordinates: [179.999, -0.001], layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 18, 15, 42], 'text-variable-anchor-offset': ['left', [0.5, 0], 'right', [-0.5, 0]] }, paint: { 'text-translate': [80, 0], 'text-translate-anchor': 'map' } });
  expect(tileID.canonical.z).toBe(13);
  expect(view.cameraZoom).toBeCloseTo(14, 6);
  expect(Object.values(placement.placements).filter(value => value.text)).toHaveLength(2);
  expect(extracted.text!.opacities.filter(value => value > 0)).toHaveLength(24);
  updateVariableSymbolGeometry(extracted, view, new SymbolProjectionContext(), textTranslation, iconTranslation);
  // Independent style interpolation: 30px size, 45px text width and a 15px gap.
  expect(extracted.text!.dynamics[0]).toBeCloseTo(37.5, 5);
  expect(extracted.text!.dynamics[36]).toBeCloseTo(-37.5, 5);
  for (const boxes of placement.collisionBoxArrays.get(mapBucket.bucketInstanceId)!.values()) {
    const [x1, y1, x2, y2] = boxes.text.map(value => value - 100);
    expect(nativeIndex.collides({ x1: (x1 + x2) / 2 - 0.1, x2: (x1 + x2) / 2 + 0.1, y1: (y1 + y2) / 2 - 0.1, y2: (y1 + y2) / 2 + 0.1 }, 'never')).toBe(true);
  }
});

it('keeps fitted icons at their text anchor when both halves have independent paint translation', async () => {
  const { extracted, view, textTranslation, iconTranslation, placement } = await variableLabels(true, false, 1, { layout: { 'icon-image': 'square', 'icon-text-fit': 'both' }, paint: { 'text-translate': [20, 10], 'text-translate-anchor': 'viewport', 'icon-translate': [-5, 0], 'icon-translate-anchor': 'viewport' } });
  expect(Object.values(placement.placements).filter(value => value.text && value.icon)).toHaveLength(1);
  updateVariableSymbolGeometry(extracted, view, new SymbolProjectionContext(), textTranslation, iconTranslation);
  const text = extracted.text!;
  const icon = extracted.icon!;
  // The text's 30px candidate shift follows its +20/+10 paint offset;
  // the icon's own -5px base translation must be compensated in its stream.
  expect(text.dynamics[0]).toBeCloseTo(30, 5);
  expect(icon.dynamics[0]).toBeCloseTo(55, 5);
  expect(icon.dynamics[1]).toBeCloseTo(10, 5);
  expect(icon.opacities.filter(value => value > 0)).toHaveLength(4);
});

it('expands the real owner command for a variable label shifted back from outside the frustum', async () => {
  const data = await variableLabels(true, false, 1, { focusOffset: 400, layout: { 'text-variable-anchor-offset': ['right', [-17, 0]] } });
  const { extracted, view, frame } = data;
  const text = extracted.text!;
  const nativeGeometry = symbolGeometry(text, text.indices)!;
  GeometryPipeline.projectTo2D(nativeGeometry, 'position', 'position3D', 'position2D', frame.mapProjection);
  const values = nativeGeometry.attributes.position2D.values;
  const points = Array.from({ length: values.length / 3 }, (_, vertex) => [values[vertex * 3 + 2], values[vertex * 3], values[vertex * 3 + 1]]).flat();
  const base = BoundingSphere.fromVertices(points);
  const volume = frame.camera.frustum.computeCullingVolume(frame.camera.positionWC, frame.camera.directionWC, frame.camera.upWC);
  expect(volume.computeVisibility(base)).toBe(Intersect.OUTSIDE);
  vi.stubGlobal('OffscreenCanvas', class {});
  const renderer = new SymbolTileRenderer();
  const commands: Array<{ owner: Primitive; primitiveType: number; boundingVolume: BoundingSphere; uniformMap: Record<string, () => unknown> }> = [];
  const update = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (this: Primitive) {
    commands.push({ owner: this, primitiveType: 0, boundingVolume: base, uniformMap: {} });
  });
  try {
    const { merged } = publishVariableTile(renderer, data);
    renderer.cameraZoom = view.cameraZoom;
    renderer.update(view, true, undefined, operation => operation(UNBOUNDED_BUDGET));
    expect(text.opacities.filter(value => value > 0)).toHaveLength(12);
    const owner = merged.primitives[0];
    const actualFrame = { ...frame, commandList: commands, pixelRatio: 1 };
    owner.update(actualFrame);
    expect(commands).toHaveLength(1);
    expect(volume.computeVisibility(commands[0].boundingVolume)).not.toBe(Intersect.OUTSIDE);
    const radius = commands[0].boundingVolume.radius;
    commands.length = 0;
    owner.update(actualFrame);
    expect(commands[0].boundingVolume.radius).toBe(radius);
    expect(base.radius).toBe(0);
  }
  finally {
    update.mockRestore();
    renderer.removeAll();
    vi.unstubAllGlobals();
  }
});

it('keeps held variable choices and frozen paint on the live camera, then restores without rebuilding', async () => {
  const layout = { 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map' } as const;
  const old = await variableLabels(true, false, 1, { sourceZoom: 14, layout, paint: { 'text-translate': [20, 0] } });
  const next = await variableLabels(true, false, 1, { sourceZoom: 14, cameraZoom: 15, layout: { ...layout, 'text-variable-anchor': ['right'] }, paint: { 'text-translate': [80, 0] } });
  vi.stubGlobal('OffscreenCanvas', class {});
  const renderer = new SymbolTileRenderer();
  try {
    const original = publishVariableTile(renderer, old);
    renderer.cameraZoom = old.view.cameraZoom;
    renderer.update(old.view, true, undefined, operation => operation(UNBOUNDED_BUDGET));
    const oldDynamics = old.extracted.text!.dynamics;
    const oldMask = old.extracted.text!.opacities.slice();
    const oldDisplacement = oldDynamics[0];
    const replacement = publishVariableTile(renderer, next);
    expect(replacement.change.retained?.collections).toContain(original.merged.collection);
    renderer.cameraZoom = next.view.cameraZoom;
    renderer.update(next.view, true, undefined, operation => operation(UNBOUNDED_BUDGET));
    expect(oldDynamics[0]).toBeCloseTo(oldDisplacement / 2, 4);
    expect(old.extracted.text!.opacities).toEqual(oldMask);
    expect(next.extracted.text!.dynamics[0]).toBeLessThan(0);
    expect(original.halves[0].translationOffset.x).toBeCloseTo(20 / (512 * 2 ** 15), 12);
    expect(replacement.halves[0].translationOffset.x).toBeCloseTo(80 / (512 * 2 ** 15), 12);
    expect(original.halves[0].geometry.attributes.a_dynamic.values).toBe(oldDynamics);
    replacement.change.retained!.release();
    const retired = renderer.retireTile('variable', 0);
    expect(retired.retired).toContain(replacement.merged.collection);
    expect(renderer.restoreTile('variable')).toContain(replacement.merged.collection);
    renderer.update(next.view, true, undefined, operation => operation(UNBOUNDED_BUDGET));
    expect(next.extracted.text!.dynamics[0]).toBeLessThan(0);
    expect(next.extracted.text!.opacities.filter(value => value > 0)).toHaveLength(12);
    expect(replacement.halves[0].geometry.attributes.a_dynamic.values).toBe(next.extracted.text!.dynamics);
  }
  finally {
    renderer.removeAll();
    vi.unstubAllGlobals();
  }
});

it('uses original-anchor perspective for the map-pitched render shift at a different source LOD', async () => {
  const { extracted, view, map, bucket, tileID, textTranslation, iconTranslation, placement } = await variableLabels(true, false, 1, { sourceZoom: 13, bearing: 35, pitch: 60, focusOffset: 150, layout: { 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map' } });
  const instance = bucket.symbolInstances.get(0);
  const mapID = new MapTileID(13, 0, 13, tileID.canonical.x, tileID.canonical.y);
  const original = map.projectTileCoordinates(instance.anchorX, instance.anchorY, mapID.toUnwrapped());
  const expectedRatio = 0.5 + 0.5 * map.cameraToCenterDistance / original.signedDistanceFromCamera;
  expect(Math.abs(expectedRatio - 1)).toBeGreaterThan(0.01);
  expect(Object.values(placement.placements).filter(value => value.text)).toHaveLength(1);
  updateVariableSymbolGeometry(extracted, view, new SymbolProjectionContext(), textTranslation, iconTranslation);
  expect(extracted.text!.dynamics[0]).toBeCloseTo(30 * expectedRatio * symbolMetersPerPixel(14), 4);
});

it('compensates fitted map-pitched icon paint in the actual viewport-rotated ground axes', async () => {
  const { extracted, view, map, placement, textTranslation, iconTranslation } = await variableLabels(true, false, 1, { pitch: 45, bearing: 35, layout: { 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'viewport', 'icon-pitch-alignment': 'map', 'icon-rotation-alignment': 'viewport', 'icon-image': 'square', 'icon-text-fit': 'both' }, paint: { 'text-translate': [20, 10], 'text-translate-anchor': 'map', 'icon-translate': [-5, 0], 'icon-translate-anchor': 'map' } });
  expect(Object.values(placement.placements).filter(value => value.text && value.icon)).toHaveLength(1);
  updateVariableSymbolGeometry(extracted, view, new SymbolProjectionContext(), textTranslation, iconTranslation);
  const { vecEast, vecSouth } = getTileSkewVectors(map);
  const determinant = vecEast[0] * vecSouth[1] - vecSouth[0] * vecEast[1];
  const expectedX = (25 * vecSouth[1] - 10 * vecSouth[0]) / determinant * symbolMetersPerPixel(14);
  const expectedY = (10 * vecEast[0] - 25 * vecEast[1]) / determinant * symbolMetersPerPixel(14);
  expect(extracted.icon!.dynamics[0] - extracted.text!.dynamics[0]).toBeCloseTo(expectedX, 4);
  expect(extracted.icon!.dynamics[1] - extracted.text!.dynamics[1]).toBeCloseTo(expectedY, 4);
});

it('publishes a refiltered fixed-justify anchor while the new full pass is still budgeted', async () => {
  const layout = { 'text-justify': 'center' } as const;
  const target = await variableLabels(true, false, 1, { layout });
  const moved = await variableLabels(true, false, 1, { layout, sourceZoom: 14, cameraZoom: 13 });
  const blocker = await variableLabels(false, false, 1, { layerId: 'blockers', coordinates: [0.001 + 70 * 360 / (512 * 2 ** 14), -0.001] });
  const oracle = new MapPlacement(moved.map, undefined!, 0, true);
  const seen = {};
  const crossTile = new MapCrossTileSymbolIndex();
  for (const data of [blocker, target]) {
    crossTile.addLayer(data.bucket.layers[0] as unknown as Parameters<MapCrossTileSymbolIndex['addLayer']>[0], [data.mapTile] as unknown as Parameters<MapCrossTileSymbolIndex['addLayer']>[1], moved.map.center.lng);
    const parts: Parameters<MapPlacement['getBucketParts']>[0] = [];
    oracle.getBucketParts(parts, data.bucket.layers[0] as unknown as Parameters<MapPlacement['getBucketParts']>[1], data.mapTile as unknown as Parameters<MapPlacement['getBucketParts']>[2], false);
    oracle.placeLayerBucketPart(parts[0], seen, true);
  }
  expect(oracle.variableOffsets[target.bucket.symbolInstances.get(0).crossTileID].anchor).toBe('right');
  vi.stubGlobal('OffscreenCanvas', class {});
  const renderer = new SymbolTileRenderer();
  try {
    publishVariableTile(renderer, blocker, 'a-blocker');
    const published = publishVariableTile(renderer, target);
    renderer.cameraZoom = target.view.cameraZoom;
    renderer.update(target.view, true, undefined, operation => operation(UNBOUNDED_BUDGET));
    const text = target.extracted.text!;
    expect(text.dynamics[0]).toBeCloseTo(30, 5);
    const mask = text.opacities.slice();
    published.halves[0].dynamic!.dirty = false;
    renderer.cameraZoom = moved.view.cameraZoom;
    renderer.update(moved.view, true, undefined, operation => operation({ exhausted: true, takeMinimumProgress: () => true }));
    expect(renderer.hasPendingWork).toBe(true);
    expect(text.opacities).toEqual(mask);
    expect(text.dynamics[0]).toBeCloseTo(-30, 5);
    expect(published.halves[0].geometry.attributes.a_dynamic.values).toBe(text.dynamics);
    expect(published.halves[0].dynamic!.dirty).toBe(true);
  }
  finally {
    renderer.removeAll();
    vi.unstubAllGlobals();
  }
});

it('keeps overlapping variable text when its optional fitted icon collides under its own mode', async () => {
  const blocker = await variableLabels(false, false, 1);
  const target = await variableLabels(true, false, 1, { layout: { 'text-allow-overlap': true, 'icon-image': 'square', 'icon-text-fit': 'both', 'icon-padding': 60, 'icon-optional': true } });
  const parts: Parameters<MapPlacement['getBucketParts']>[0] = [];
  blocker.placement.getBucketParts(parts, target.bucket.layers[0] as unknown as Parameters<MapPlacement['getBucketParts']>[1], target.mapTile as unknown as Parameters<MapPlacement['getBucketParts']>[2], false);
  blocker.placement.placeLayerBucketPart(parts[0], {}, true);
  const expected = blocker.placement.placements[target.bucket.symbolInstances.get(0).crossTileID];
  expect(expected.text).toBe(true);
  expect(expected.icon).toBe(false);
  const extracted = symbolBucketGeometry(target.bucket, target.tileID, target.tileID.key, target.result.collisionBoxArray, 'labels');
  const placement = new SymbolTilePlacement(extracted.text, extracted.icon, target.view, blocker.nativeIndex, { pairs: extracted.pairs, iconOptional: true });
  placement.advance(Infinity, new SymbolProjectionContext());
  placement.commit();
  expect(extracted.text!.opacities.some(value => value > 0)).toBe(expected.text);
  expect(extracted.icon!.opacities.some(value => value > 0)).toBe(expected.icon);
});
