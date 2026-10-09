import type { Page } from 'playwright/test';
import type { TestScene } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';
import { Cartesian3 } from 'cesium';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

const tile = fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] } }, { version: 2, extent: 4096 });
const blue = [51, 102, 170];
const green = [34, 170, 85];
const styleColors = {
  liberty: blue,
  bright: green,
  buildings: [119, 85, 187],
  osm: [204, 136, 34],
  versatiles: [34, 153, 170],
};

async function coverage(page: Page, color: number[], rows = [0.3, 0.5, 0.7]) {
  const image = await loadImage(await page.locator('.cesium-widget canvas').screenshot());
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let sampled = 0;
  let matching = 0;
  for (const row of rows) {
    const y = Math.floor(image.height * row);
    for (let x = Math.floor(image.width * 0.6); x < image.width * 0.85; x++) {
      const offset = (y * image.width + x) * 4;
      sampled++;
      if (color.every((channel, index) => Math.abs(pixels[offset + index] - channel) < 5))
        matching++;
    }
  }
  return matching / sampled;
}

async function interceptStyles(page: Page, baseUrl: string, failure = 'style') {
  const requests = [];
  const tileRequests: string[] = [];
  const errors = [];
  let activeTilesUnavailable = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/demo-fixture/**/*.pbf', (route) => {
    tileRequests.push(route.request().url());
    if (route.request().url().includes('/unavailable/') || activeTilesUnavailable)
      return route.fulfill({ status: 503, body: 'test tile service unavailable' });
    return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
  });
  await page.route(/https:\/\/(?:tiles\.openfreemap\.org|tiles\.versatiles\.org|demotiles\.maplibre\.org|vector\.openstreetmap\.org)\/|\/styles\/buildings\.json(?:\?|$)/, async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes('versatiles') && failure === 'style')
      return route.fulfill({ status: 503, body: 'test fixture unavailable' });
    const styleId = url.includes('versatiles') ? 'versatiles' : url.includes('vector.openstreetmap') ? 'osm' : url.includes('/buildings.json') ? 'buildings' : url.endsWith('/bright') ? 'bright' : 'liberty';
    const path = styleId === 'versatiles' && failure !== 'none' ? 'unavailable' : styleId === 'liberty' ? 'tile' : styleId;
    const color = `#${styleColors[styleId].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
    return route.fulfill({ json: {
      version: 8,
      sources: { fixture: { type: 'vector', tiles: [`${baseUrl}/demo-fixture/${path}/{z}/{x}/{y}.pbf`], maxzoom: failure === 'none' ? 18 : 12 } },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#aa2222' } },
        { 'id': 'land', 'type': 'fill', 'source': 'fixture', 'source-layer': 'land', 'paint': { 'fill-color': color, 'fill-antialias': false } },
      ],
    } });
  });
  return { requests, tileRequests, errors, failActiveTiles: () => {
    activeTilesUnavailable = true;
  } };
}

test('a retained active map still reports its tile errors after a candidate preset fails', async ({ page, renderUrl }) => {
  const { errors, failActiveTiles } = await interceptStyles(page, renderUrl);
  await page.goto(`${renderUrl}/?preset=london&source=liberty`);
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await page.getByTestId('source-select').selectOption('versatiles');
  await expect(page.getByRole('alert')).toContainText('503');
  assert.ok(await coverage(page, blue) >= 0.98, 'the failed candidate removed the active map');
  failActiveTiles();
  await page.evaluate((destination) => {
    const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
    scene.camera.flyTo({ destination, duration: 0 });
  }, Cartesian3.fromDegrees(139.6917, 35.6895, 18000));
  // The newly exposed region needs active-source data. Its failure must be
  // reported by the retained map, whose lifetime exceeds the failed candidate.
  await expect(page.getByRole('alert')).toContainText('/demo-fixture/tile/');
  assert.deepEqual(errors, []);
});

test('demo remove cancels a pending style and prevents a late response from adding it', async ({ page, renderUrl }) => {
  const { errors } = await interceptStyles(page, renderUrl, 'none');
  let release = () => {};
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('https://tiles.versatiles.org/assets/styles/colorful/style.json', async (route) => {
    requested = true;
    await response;
    await route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#22aa55' } }] } });
  });
  try {
    await page.goto(`${renderUrl}/?preset=london&source=liberty`);
    await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
    await page.getByTestId('source-select').selectOption('versatiles');
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'true');
    await page.getByTestId('remove-tileset').click();
    release();
    await expect(page.getByTestId('tileset-status')).toHaveText('地图已移除');
    expect(await page.evaluate(async () => {
      const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
      for (let frame = 0; frame < 12; frame++)
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return scene.primitives.length;
    })).toBe(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByTestId('source-select').selectOption('bright');
    await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
    expect(errors).toEqual([]);
  }
  finally { release(); }
});
