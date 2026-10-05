import type { Page } from 'playwright/test';
import type { TestScene } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';
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

// Fixed intended views, independent of the catalog read by the application.
const pressureViews = [
  { id: 'manhattan', styleId: 'buildings', longitude: -74.01192337274551, latitude: 40.70752701473173, height: 60, heading: 32, pitch: -12 },
  { id: 'hong-kong', styleId: 'buildings', longitude: 114.1578, latitude: 22.2797, height: 120, heading: 70, pitch: -18 },
  { id: 'shinjuku', styleId: 'liberty', longitude: 139.7005, latitude: 35.6905, height: 1500, heading: 15, pitch: -45 },
  { id: 'london', styleId: 'osm', longitude: -0.0863, latitude: 51.5078, height: 900, heading: 110, pitch: -35 },
  { id: 'shanghai', styleId: 'buildings', longitude: 121.5013, latitude: 31.237, height: 120, heading: 220, pitch: -15 },
  { id: 'amsterdam', styleId: 'buildings', longitude: 4.8954, latitude: 52.3728, height: 350, heading: 60, pitch: -40 },
  { id: 'san-francisco', styleId: 'versatiles', longitude: -122.4098, latitude: 37.791, height: 700, heading: 75, pitch: -12 },
  { id: 'paris', styleId: 'osm', longitude: 2.2951, latitude: 48.8738, height: 900, heading: 135, pitch: -45 },
  { id: 'sao-paulo', styleId: 'liberty', longitude: -46.6559, latitude: -23.5614, height: 1500, heading: 50, pitch: -35 },
  { id: 'sydney', styleId: 'bright', longitude: 151.2108, latitude: -33.8588, height: 1500, heading: 75, pitch: -30 },
  { id: 'cape-town', styleId: 'versatiles', longitude: 18.4241, latitude: -33.9249, height: 1500, heading: 300, pitch: -30 },
  { id: 'dateline', styleId: 'bright', longitude: 179.99, latitude: -16.8, height: 45000, heading: 90, pitch: -70 },
] as const;

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

async function renderedView(page: Page) {
  return page.evaluate(async () => {
    const scene = (document.querySelector('[data-testid="tileset-status"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
    await new Promise<void>((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
      scene.requestRender();
    });
    const camera = scene.camera;
    const degrees = (radians: number) => radians * 180 / Math.PI;
    return {
      longitude: degrees(camera.positionCartographic.longitude),
      latitude: degrees(camera.positionCartographic.latitude),
      height: camera.positionCartographic.height,
      heading: degrees(camera.heading),
      pitch: degrees(camera.pitch),
      roll: Math.min(degrees(camera.roll), 360 - degrees(camera.roll)),
      mode: scene.mode,
      fps: scene.debugShowFramesPerSecond,
      globe: scene.globe.show,
    };
  });
}

test('a retained active map still reports its tile errors after a candidate preset fails', async ({ page, renderUrl }) => {
  const { errors, failActiveTiles } = await interceptStyles(page, renderUrl);
  await page.goto(`${renderUrl}/?view=london`);
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await page.getByTestId('source-select').selectOption('versatiles');
  await expect(page.getByRole('alert')).toContainText('503');
  assert.ok(await coverage(page, blue) >= 0.98, 'the failed candidate removed the active map');
  failActiveTiles();
  await page.getByTestId('city-tokyo').click();
  // The newly exposed region needs active-source data. Its failure must be
  // reported by the retained map, whose lifetime exceeds the failed candidate.
  await expect(page.getByRole('alert')).toContainText('/demo-fixture/tile/');
  assert.deepEqual(errors, []);
});

test('demo style, city, scene and reload controls render deterministic MVT data', async ({ page, renderUrl }) => {
  const { requests, errors } = await interceptStyles(page, renderUrl, 'none');
  await page.goto(`${renderUrl}/?view=london`);
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  await page.getByTestId('source-select').selectOption('bright');
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  assert.ok(requests.some(url => url.endsWith('/bright')));
  await page.getByTestId('city-tokyo').click();
  await expect(page.getByTestId('city-tokyo')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/view=tokyo/);
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  for (const mode of ['2d', 'cv', '3d']) {
    await page.getByTestId('scene-select').selectOption(mode);
    await expect(page).toHaveURL(new RegExp(`mode=${mode}`));
    if (mode === '2d')
      await expect(page.getByTestId('angle-select')).toBeDisabled();
    await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  }
  for (const angle of ['oblique', 'horizon']) {
    await page.getByTestId('angle-select').selectOption(angle);
    await expect(page).toHaveURL(new RegExp(`angle=${angle}`));
    // A low camera legitimately exposes sky. Verify the ground portion at
    // the bottom of the canvas rather than treating sky as missing coverage.
    await expect.poll(() => coverage(page, green, [0.8, 0.85])).toBeGreaterThan(0.8);
  }
  await page.getByTestId('angle-select').selectOption('top');
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  const beforeReload = requests.length;
  await page.getByTestId('reload-style').click();
  await expect.poll(() => requests.length).toBeGreaterThan(beforeReload);
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);

  await page.getByTestId('scenario-select').selectOption('manhattan');
  await expect(page.getByTestId('source-select')).toHaveValue('buildings');
  await expect(page.getByTestId('height-select')).toHaveValue('60');
  await expect.poll(() => renderedView(page)).toMatchObject({ height: expect.closeTo(60, 2), mode: 3 });
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  assert.deepEqual(errors, []);
});

for (const view of pressureViews) {
  test(`demo config renders the ${view.id} pressure view`, async ({ page, renderUrl }, testInfo) => {
    const { tileRequests, errors } = await interceptStyles(page, renderUrl, 'none');
    const requestStart = 0;
    await page.goto(`${renderUrl}/?scenario=${view.id}`);
    await expect(page.getByTestId('source-select')).toHaveValue(view.styleId);
    await expect(page.getByTestId('scene-select')).toHaveValue('3d');
    await expect(page.getByTestId('height-select')).toHaveValue(String(view.height));
    await expect(page).toHaveURL(new RegExp(`scenario=${view.id}`));
    await expect.poll(() => renderedView(page)).toEqual({ longitude: expect.closeTo(view.longitude, 5), latitude: expect.closeTo(view.latitude, 5), height: expect.closeTo(view.height, 2), heading: expect.closeTo(view.heading, 5), pitch: expect.closeTo(view.pitch, 5), roll: expect.closeTo(0, 5), mode: 3, fps: true, globe: true });
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect.poll(() => coverage(page, styleColors[view.styleId], [0.8, 0.85])).toBeGreaterThan(0.8);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
    const stylePath = view.styleId === 'liberty' ? 'tile' : view.styleId;
    const regionalRequests = tileRequests.slice(requestStart).filter((url) => {
      if (!url.includes(`/demo-fixture/${stylePath}/`))
        return false;
      const [zoom, x, y] = new URL(url).pathname.match(/(\d+)\/(\d+)\/(\d+)\.pbf$/).slice(1).map(Number);
      if (zoom < (view.id === 'dateline' ? 7 : 12))
        return false;
      const count = 2 ** zoom;
      const targetX = (view.longitude + 180) / 360 * count;
      const targetY = (1 - Math.asinh(Math.tan(view.latitude * Math.PI / 180)) / Math.PI) / 2 * count;
      return Math.min(Math.abs(x - targetX), count - Math.abs(x - targetX)) < 4 && Math.abs(y - targetY) < 4;
    });
    assert.ok(regionalRequests.length > 0, `${view.id} did not request the selected source in its region`);
    await testInfo.attach(`pressure-view-${view.id}`, { body: JSON.stringify({ view, frame: await renderedView(page), regionalRequests, coverage: await coverage(page, styleColors[view.styleId], [0.8, 0.85]) }, null, 2), contentType: 'application/json' });
    assert.deepEqual(errors, []);
  });
}

for (const failure of ['style', 'tiles']) {
  test(`demo reports an unavailable ${failure} service and recovers after another preset is selected`, async ({ page, renderUrl }) => {
    const { errors } = await interceptStyles(page, renderUrl, failure);
    await page.goto(`${renderUrl}/?view=london`);
    await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
    await page.getByTestId('source-select').selectOption('versatiles');
    await expect(page.getByRole('alert')).toContainText('503');
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
    if (failure === 'style')
      assert.ok(await coverage(page, blue) >= 0.98, 'a failed style request removed the previous map');
    await page.getByTestId('source-select').selectOption('bright');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
    assert.deepEqual(errors, []);
  });
}

test('native credits follow the active configuration, reloads and service failures', async ({ page, renderUrl }) => {
  const errors = [];
  let pendingTiles: Promise<void> | undefined;
  let releaseTiles = () => {};
  const fixtureStyle = (styleId: string, color: string) => ({
    version: 8,
    sources: { fixture: { type: 'vector', tiles: [`${renderUrl}/demo-credit/${styleId}/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#aa2222' } },
      { 'id': 'land', 'type': 'fill', 'source': 'fixture', 'source-layer': 'land', 'paint': { 'fill-color': color, 'fill-antialias': false } },
    ],
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/demo-credit/**/*.pbf', async (route) => {
    await pendingTiles;
    if (route.request().url().includes('/way/'))
      return route.fulfill({ status: 503, body: 'active tile failure' });
    return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
  });
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({ json: fixtureStyle('ofm', '#3366aa') }));
  await page.route('https://sgx.geodatenzentrum.de/gdz_basemapworld_vektor/styles/bm_web_wld_col.json', route => route.fulfill({ json: fixtureStyle('bkg', '#22aa55') }));
  await page.route('**/styles/waymorphic.json*', route => route.fulfill({ json: fixtureStyle('way', '#3366aa') }));
  await page.route('https://tiles.openfreemap.org/styles/bright', route => route.fulfill({ status: 503, body: 'style fixture unavailable' }));
  const credits = page.locator('.cesium-credit-textContainer');
  const ofm = credits.locator('a[href="https://openfreemap.org/"]');
  const bkg = credits.locator('a[href="https://www.bkg.bund.de/"]');
  const way = credits.locator('a[href="https://waymorphic.com/"]');
  await page.goto(`${renderUrl}/?view=london`);
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await expect(ofm).toBeVisible();
  try {
    pendingTiles = new Promise<void>((resolve) => {
      releaseTiles = resolve;
    });
    await page.getByTestId('source-select').selectOption('basemap-world');
    await expect(bkg).toBeVisible();
    await expect(ofm).toHaveCount(0);
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'true');
    releaseTiles();
    pendingTiles = undefined;
    await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);

    await page.getByTestId('reload-style').click();
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
    await expect(bkg).toHaveCount(1);
    await page.getByTestId('source-select').selectOption('bright');
    await expect(page.getByRole('alert')).toContainText('503');
    await expect(bkg).toHaveCount(1);
    assert.ok(await coverage(page, green) >= 0.98, 'a failed style request removed the current map');

    await page.getByTestId('source-select').selectOption('waymorphic');
    await expect(page.getByRole('alert')).toContainText('/demo-credit/way/');
    await expect(way).toHaveCount(1);
    await expect(bkg).toHaveCount(0);
    await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');

    await page.getByTestId('source-select').selectOption('liberty');
    await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
    await expect(ofm).toHaveCount(1);
    await expect(way).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    assert.deepEqual(errors, []);
  }
  finally {
    releaseTiles();
  }
});
