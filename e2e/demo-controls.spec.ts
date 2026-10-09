import type { Page } from 'playwright/test';
import type { TestScene, TestTileset } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';
import { Cartesian3 } from 'cesium';
import { expect } from 'playwright/test';
import { demoPresets } from '../src/demo/preset-catalog';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    demoLifecycle: { scene: TestScene; tileset: TestTileset; frames: number; stop: () => void };
  }
}

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

async function renderedView(page: Page) {
  return page.evaluate(async () => {
    const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
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

test('the camera readout follows real motion and projection switches', async ({ page, renderUrl }, testInfo) => {
  const { errors } = await interceptStyles(page, renderUrl, 'none');
  await page.goto(`${renderUrl}/?preset=manhattan`);
  await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.getByTestId('camera-height').getAttribute('data-value').then(Number)).toBeCloseTo(1000, 4);
  for (const mode of ['3d', 'cv', '2d']) {
    await page.getByTestId('scene-select').selectOption(mode);
    await expect(page).toHaveURL(new RegExp(`mode=${mode}`));
    const samples = await page.evaluate(async () => {
      const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
      const keys = ['longitude', 'latitude', 'height', 'heading', 'pitch', 'roll'] as const;
      const samples: Array<{ actual: number[]; displayed: number[] }> = [];
      const degrees = (radians: number) => radians * 180 / Math.PI;
      const sample = async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const camera = scene.camera;
        const position = camera.positionCartographic;
        samples.push({
          actual: [degrees(position.longitude), degrees(position.latitude), position.height, degrees(camera.heading), degrees(camera.pitch), degrees(camera.roll)],
          displayed: keys.map(key => Number(document.querySelector(`[data-testid="camera-${key}"]`)?.getAttribute('data-value'))),
        });
      };
      // Camera operations exercise the real requestRenderMode loop; the HUD
      // observes those frames without requesting its own continuation.
      for (let step = 0; step < 8; step++) {
        scene.camera.zoomOut(10);
        if (scene.mode !== 2)
          scene.camera.lookRight(0.01);
        await new Promise<void>((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });
        await sample();
      }
      return samples;
    });
    assert.equal(samples.length, 8);
    for (const { actual, displayed } of samples) {
      assert.ok(displayed.every(Number.isFinite), `${mode} displayed non-finite camera values`);
      actual.forEach((value, index) => assert.ok(Math.abs(value - displayed[index]) < (index === 2 ? 1e-5 : 1e-7), `${mode} ${index}: expected ${value}, displayed ${displayed[index]}`));
    }
    assert.ok(Math.abs(samples.at(-1).displayed[2] - samples[0].displayed[2]) > 1, `${mode} height did not follow zoom`);
    await testInfo.attach(`camera-readout-${mode}`, { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  }
  assert.deepEqual(errors, []);
});

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

test('demo style, unified preset, scene and add controls render deterministic MVT data', async ({ page, renderUrl }) => {
  const { requests, errors } = await interceptStyles(page, renderUrl, 'none');
  await page.goto(`${renderUrl}/?preset=london&source=liberty`);
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  await page.getByTestId('source-select').selectOption('bright');
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  assert.ok(requests.some(url => url.endsWith('/bright')));
  await page.getByTestId('preset-select').selectOption('shinjuku');
  await page.getByTestId('source-select').selectOption('bright');
  await expect(page.getByTestId('preset-select')).toHaveValue('shinjuku');
  await expect(page).toHaveURL(/preset=shinjuku/);
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  for (const mode of ['2d', 'cv', '3d']) {
    await page.getByTestId('scene-select').selectOption(mode);
    await expect(page).toHaveURL(new RegExp(`mode=${mode}`));
    await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);
  }
  await expect(page.getByText('预设说明', { exact: true })).toHaveCount(0);
  await expect(page.getByText('来源与使用条件', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('angle-select')).toHaveCount(0);
  await expect(page.getByTestId('scenario-select')).toHaveCount(0);
  await expect(page.getByTestId('city-select')).toHaveCount(0);
  const beforeReload = requests.length;
  await page.getByTestId('add-tileset').click();
  await expect.poll(() => requests.length).toBeGreaterThan(beforeReload);
  await expect.poll(() => coverage(page, green)).toBeGreaterThanOrEqual(0.98);

  await page.getByTestId('preset-select').selectOption('manhattan');
  await expect(page.getByTestId('source-select')).toHaveValue('buildings');
  await expect(page.getByTestId('height-select')).toHaveCount(0);
  await expect.poll(() => page.getByTestId('camera-height').getAttribute('data-value').then(Number)).toBeCloseTo(1000, 4);
  await expect.poll(() => renderedView(page)).toMatchObject({ height: expect.closeTo(1000, 2), mode: 3 });
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  assert.deepEqual(errors, []);
});

test('demo remove destroys its tileset and add restores paint without caller render requests', async ({ page, renderUrl }) => {
  const { errors } = await interceptStyles(page, renderUrl, 'none');
  await page.goto(`${renderUrl}/?preset=london&source=liberty`);
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
  const initial = await page.evaluate(() => {
    const scene = (document.querySelector('[data-testid="camera-readout"]') as Element & { __vueParentComponent: { props: { scene: TestScene } } }).__vueParentComponent.props.scene;
    window.demoLifecycle = { scene, tileset: scene.primitives.get(0), frames: 0, stop: () => {} };
    window.demoLifecycle.stop = scene.postRender.addEventListener(() => window.demoLifecycle.frames++);
    return { count: scene.primitives.length, destroyed: window.demoLifecycle.tileset.isDestroyed() };
  });
  expect(initial).toEqual({ count: 1, destroyed: false });
  await page.getByTestId('remove-tileset').click();
  await expect(page.getByTestId('tileset-status')).toHaveText('地图已移除');
  await expect(page.getByTestId('remove-tileset')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.demoLifecycle.frames)).toBeGreaterThan(0);
  expect(await page.evaluate(() => ({ count: window.demoLifecycle.scene.primitives.length, destroyed: window.demoLifecycle.tileset.isDestroyed() }))).toEqual({ count: 0, destroyed: true });
  await expect.poll(() => coverage(page, blue)).toBeLessThan(0.01);
  await page.getByTestId('add-tileset').click();
  await expect.poll(() => coverage(page, blue)).toBeGreaterThanOrEqual(0.98);
  await expect(page.getByTestId('tileset-status')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => {
    const { scene, tileset: removed } = window.demoLifecycle;
    return { count: scene.primitives.length, reused: scene.primitives.get(0) === removed };
  })).toEqual({ count: 1, reused: false });
  await page.evaluate(() => window.demoLifecycle.stop());
  expect(errors).toEqual([]);
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

for (const view of demoPresets) {
  test(`demo config applies the ${view.id} camera and source`, async ({ page, renderUrl }, testInfo) => {
    const { tileRequests, errors } = await interceptStyles(page, renderUrl, 'none');
    const requestStart = 0;
    await page.goto(`${renderUrl}/?preset=${view.id}`);
    await expect(page.getByTestId('source-select')).toHaveValue(view.styleId);
    await expect(page.getByTestId('scene-select')).toHaveValue('3d');
    await expect.poll(() => page.getByTestId('camera-height').getAttribute('data-value').then(Number)).toBeCloseTo(view.height, 3);
    await expect(page).toHaveURL(new RegExp(`preset=${view.id}`));
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
    await page.goto(`${renderUrl}/?preset=london&source=liberty`);
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
  await page.goto(`${renderUrl}/?preset=london&source=liberty`);
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

    await page.getByTestId('add-tileset').click();
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
