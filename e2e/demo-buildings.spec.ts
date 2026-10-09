import type { PrimitiveCollection } from 'cesium';
import type { Page, TestInfo } from 'playwright/test';
import type { TestScene, TestTileset } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';
import { Cartesian3 } from 'cesium';
import { expect } from 'playwright/test';
import { demoPresets } from '../src/demo/preset-catalog';
import buildingsStyle from '../src/styles/buildings.json' with { type: 'json' };
import { fromGeojsonVt, GeoJSONVT, test } from './fixtures';

const manhattan = demoPresets.find(scenario => scenario.id === 'manhattan');
// Keep the low street regression independent of the gallery's overview pose.
const longitude = -74.01192337274551;
const latitude = 40.70752701473173;
const extent = 4096;
const buildings = [];
// Align fixture streets with the low street regression camera.
// The camera looks down a street corridor at both heights, outside footprints.
const heading = manhattan.heading * Math.PI / 180;
for (let north = -25; north <= 25; north++) {
  for (let east = -25; east <= 25; east++) {
    const west = east * 40 + 8;
    const south = north * 40 + 8;
    const coordinates = [[west, south], [west, south + 24], [west + 24, south + 24], [west + 24, south], [west, south]].map(([east, north]) => [
      longitude + (Math.cos(heading) * east + Math.sin(heading) * north) / (111320 * Math.cos(latitude * Math.PI / 180)),
      latitude + (-Math.sin(heading) * east + Math.cos(heading) * north) / 111320,
    ]);
    buildings.push({ coordinates, height: 40 + Math.abs(east * 13 + north * 17) % 100 });
  }
}

const buildingIndex = new GeoJSONVT({
  type: 'FeatureCollection',
  features: buildings.map(building => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [building.coordinates] },
    properties: { render_height: building.height, render_min_height: 0 },
  })),
}, { extent, maxZoom: 18 });

function buildingTile(z, x, y) {
  return fromGeojsonVt({ building: buildingIndex.getTile(z, x, y) ?? { features: [] } }, { version: 2, extent });
}

async function flyToHeight(page: Page, height: number): Promise<void> {
  await page.evaluate(({ destination, heading, pitch }) => {
    const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
    scene.camera.cancelFlight();
    scene.camera.flyTo({ destination, orientation: { heading, pitch, roll: 0 }, duration: 0.8 });
  }, { destination: Cartesian3.fromDegrees(longitude, latitude, height), heading, pitch: -12 * Math.PI / 180 });
  await expect.poll(() => page.getByTestId('camera-height').getAttribute('data-value').then(Number)).toBeCloseTo(height, 3);
}

async function buildingPixels(page: Page, excludedColors: number[][] = []) {
  const image = await loadImage(await page.locator('.cesium-widget canvas').screenshot());
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let neutral = 0;
  let street = 0;
  let sampled = 0;
  // Exclude controls; count lit white roofs and shaded neutral side walls.
  for (let y = Math.floor(image.height * 0.2); y < image.height * 0.85; y++) {
    for (let x = Math.floor(image.width * 0.4); x < image.width * 0.95; x++) {
      const offset = (y * image.width + x) * 4;
      const [red, green, blue] = pixels.subarray(offset, offset + 3);
      sampled++;
      if (Math.min(red, green, blue) > 70 && Math.max(red, green, blue) - Math.min(red, green, blue) < 12
        && !excludedColors.some(color => color.every((channel, index) => Math.abs(pixels[offset + index] - channel) < 5))) {
        neutral++;
      }
      if ([red, green, blue].every((channel, index) => Math.abs(channel - [24, 48, 64][index]) < 5))
        street++;
    }
  }
  return { neutral: neutral / sampled, street: street / sampled };
}

async function attachBuildingState(page: Page, testInfo: TestInfo, height: string) {
  const state = await page.evaluate(() => {
    const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
    const tileset = Array.from({ length: scene.primitives.length }, (_, index) => scene.primitives.get(index))
      .find(primitive => typeof primitive.stats === 'function') as TestTileset;
    return {
      zoom: tileset._style.z,
      styleZoom: tileset._styleEvaluation.zoom,
      hidden: tileset._style.getLayer('white-buildings').isHidden(tileset._style.z),
      stats: tileset.stats(),
      jobs: [...tileset._tilePublishQueue._jobs].map(([id, job]) => ({ id, surfaces: job.surfaces, symbols: job.symbols, tile: job.data.tileID.canonical, buildPhase: job.vectorBuild?.phase })),
      firstUploads: tileset._sceneCollections._firstUpdates.map(queue => [...queue].map(([collection, upload]) => ({ show: collection.show, length: (collection as PrimitiveCollection).length, index: upload.index }))),
      camera: { longitude: scene.camera.positionCartographic.longitude, latitude: scene.camera.positionCartographic.latitude, height: scene.camera.positionCartographic.height, pitch: scene.camera.pitch },
      loaded: tileset.tilesLoaded,
      globeLoaded: scene.globe.tilesLoaded,
      renderable: Object.entries(tileset._style.tilePyramids).map(([source, pyramid]) => ({ source, tiles: pyramid.getRenderableIds().map(id => pyramid.getTileByID(id).tileID.canonical) })),
      records: [...tileset._vectorRenderer._records].map(([id, record]) => ({
        id,
        buckets: Object.entries(record.buckets).map(([id, bucket]) => ({ id, vertices: (bucket as typeof bucket & { layoutVertexArray?: { length: number } }).layoutVertexArray?.length, triangles: (bucket as typeof bucket & { indexArray?: { length: number } }).indexArray?.length })),
        collections: [...record.collections].map(([kind, collection]) => ({
          kind,
          show: collection.show,
          length: (collection as PrimitiveCollection).length,
          children: Array.from({ length: (collection as PrimitiveCollection).length }, (_, index) => ({ show: (collection as PrimitiveCollection).get(index).show, ready: (collection as PrimitiveCollection).get(index).ready })),
        })),
      })),
      hiddenSurfaceLayers: [...tileset._tileResidency.hiddenSurfaceLayers].map(([tileId, layers]) => ({ tileId, layers: [...layers] })),
    };
  });
  await testInfo.attach(`real-building-state-${height}m`, { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
}

test('Manhattan white buildings remain visible at 60 and 15 metre camera heights', async ({ page, renderUrl }, testInfo) => {
  const errors = [];
  const requested = new Set();
  page.on('pageerror', error => errors.push(error.message));
  const style = {
    version: 8,
    sources: { buildings: { type: 'vector', tiles: [`${renderUrl}/building-fixture/{z}/{x}/{y}.pbf`], maxzoom: 18 } },
    layers: [
      { id: 'ground', type: 'background', paint: { 'background-color': '#183040' } },
      { 'id': 'white-buildings', 'type': 'fill-extrusion', 'source': 'buildings', 'source-layer': 'building', 'paint': { 'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': ['get', 'render_height'], 'fill-extrusion-base': ['get', 'render_min_height'], 'fill-extrusion-opacity': 1 } },
    ],
  };
  await page.route('**/building-fixture/**/*.pbf', (route) => {
    const [z, x, y] = new URL(route.request().url()).pathname.match(/(\d+)\/(\d+)\/(\d+)\.pbf$/).slice(1).map(Number);
    requested.add(`${z}/${x}/${y}`);
    return route.fulfill({ body: Buffer.from(buildingTile(z, x, y)), contentType: 'application/x-protobuf' });
  });
  await page.route('**/src/styles/buildings.json', route => route.fulfill({ json: style }));
  await page.route('**/building-fixture/no-buildings.json', route => route.fulfill({ json: {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#183040' } }],
  } }));
  // A deterministic starting style avoids any live service dependency.
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#183040' } }] } }));
  await page.goto(`${renderUrl}/?preset=london&source=liberty`);
  await page.getByTestId('preset-select').selectOption('manhattan');
  await expect(page.getByTestId('preset-select')).toHaveValue('manhattan');
  await expect(page.getByTestId('source-select')).toHaveValue('buildings');
  await expect(page.getByTestId('scene-select')).toHaveValue('3d');
  await expect.poll(() => page.getByTestId('camera-heading').getAttribute('data-value').then(Number)).toBeCloseTo(32, 5);
  await expect.poll(() => page.getByTestId('camera-pitch').getAttribute('data-value').then(Number)).toBeCloseTo(manhattan.pitch, 5);
  for (const height of ['60', '15']) {
    await flyToHeight(page, Number(height));
    // Camera.flyTo lasts 0.8 seconds; old-view pixels must not satisfy the
    // assertion for the newly selected height while that flight is running.
    await page.waitForTimeout(1000);
    await expect.poll(async () => (await buildingPixels(page)).neutral, { timeout: 30_000 }).toBeGreaterThan(0.03);
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
    const pixels = await buildingPixels(page);
    assert.ok(pixels.neutral < 0.95 && pixels.street > 0.05, `${height}m camera lost the street corridor: ${JSON.stringify(pixels)}`);
    await testInfo.attach(`white-building-pixels-${height}m`, { body: JSON.stringify(pixels), contentType: 'application/json' });
    await page.locator('.cesium-widget canvas').screenshot({ path: testInfo.outputPath(`white-buildings-${height}m.png`) });
  }
  assert.ok(requested.size > 0, 'no building tiles were requested');
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  for (const mode of ['cv', '2d', '3d']) {
    await page.getByTestId('scene-select').selectOption(mode);
    await expect(page.getByTestId('preset-select')).toHaveValue('manhattan');
    await expect.poll(() => page.evaluate(() => {
      const camera = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene.camera;
      return { longitude: camera.positionCartographic.longitude, latitude: camera.positionCartographic.latitude };
    })).toEqual({ longitude: expect.closeTo(manhattan.longitude * Math.PI / 180, 6), latitude: expect.closeTo(manhattan.latitude * Math.PI / 180, 6) });
  }
  await flyToHeight(page, 60);
  await expect.poll(async () => (await buildingPixels(page)).neutral, { timeout: 30_000 }).toBeGreaterThan(0.03);
  // Removing building geometry leaves the same background at the same
  // height. This proves the neutral pixels came from actual extrusion walls.
  await page.getByText('自定义 Style JSON 地址', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Style JSON 地址' }).fill(`${renderUrl}/building-fixture/no-buildings.json`);
  await page.getByRole('button', { name: '加载', exact: true }).click();
  await expect.poll(async () => (await buildingPixels(page)).neutral).toBeLessThan(0.01);
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test('real OpenFreeMap Manhattan white buildings draw at 60 and 15 metres', { tag: '@live' }, async ({ page, renderUrl }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  const tiles = new Map();
  const excludedColors = buildingsStyle.layers.filter(layer => layer.type !== 'fill-extrusion')
    .flatMap(layer => Object.values(layer.paint).filter(value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)))
    .map(color => [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16)));
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().startsWith('https://tiles.openfreemap.org/') && /\/\d+\/\d+\/\d+(?:\.pbf)?(?:\?|$)/.test(response.url()))
      tiles.set(response.url(), response.status());
  });
  // Exercise the real preset and camera with its real TileJSON and MVT;
  // the deterministic fixture above supplies no routes to this separate page.
  await page.goto(`${renderUrl}/?source=buildings&preset=manhattan`);
  await expect(page.getByTestId('source-select')).toHaveValue('buildings');
  await expect(page.getByTestId('scene-select')).toHaveValue('3d');
  await expect.poll(() => page.getByTestId('camera-heading').getAttribute('data-value').then(Number)).toBeCloseTo(32, 5);
  await expect.poll(() => page.getByTestId('camera-pitch').getAttribute('data-value').then(Number)).toBeCloseTo(manhattan.pitch, 5);
  for (const height of ['60', '15']) {
    await flyToHeight(page, Number(height));
    await page.waitForTimeout(1000);
    await expect.poll(() => page.evaluate(() => (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene.camera.positionCartographic.height)).toBeCloseTo(Number(height), 1);
    // Real background/road colors are also neutral. Exclude those known
    // paints so a flat basemap cannot satisfy the building pixel assertion.
    try {
      // Measure first usable building paint within the live-source readiness
      // budget. The UI latches source activation, while tilesLoaded also waits
      // for distant horizon detail; neither describes this street-view frame.
      await expect.poll(async () => (await buildingPixels(page, excludedColors)).neutral, { timeout: 90_000 }).toBeGreaterThan(0.03);
    }
    finally {
      await attachBuildingState(page, testInfo, height);
    }
    const pixels = await buildingPixels(page, excludedColors);
    await testInfo.attach(`real-building-pixels-${height}m`, { body: JSON.stringify(pixels), contentType: 'application/json' });
    await page.locator('.cesium-widget canvas').screenshot({ path: testInfo.outputPath(`real-white-buildings-${height}m.png`) });
  }
  assert.ok([...tiles.values()].includes(200), 'no real OpenFreeMap MVT response succeeded');
  await testInfo.attach('real-building-tile-responses', { body: JSON.stringify([...tiles]), contentType: 'application/json' });
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(errors, []);
});
