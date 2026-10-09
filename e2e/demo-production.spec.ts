import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';
import { expect } from 'playwright/test';
import { preview } from 'vite';
import { test as base, fromGeojsonVt } from './fixtures';

const test = base.extend<object, { productionUrl: string }>({
  productionUrl: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
      try {
        const address = server.httpServer.address();
        if (!address || typeof address === 'string')
          throw new Error('Production preview did not expose a TCP address');
        await use(`http://127.0.0.1:${address.port}`);
      }
      finally {
        await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
      }
    },
    { scope: 'worker' },
  ],
});

const basePath = '/cesium-vector-tileset/';

const tile = fromGeojsonVt({
  land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  roads: { features: [{ type: 2, geometry: [[[256, 1024], [512, 1024], [512, 1536]]], tags: {} }] },
}, { version: 2, extent: 4096 });

async function pixels(page: Page, color: number[]) {
  const image = await loadImage(await page.locator('.cesium-widget canvas').screenshot());
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  let matching = 0;
  let sampled = 0;
  for (const row of [0.3, 0.5, 0.7]) {
    const y = Math.floor(image.height * row);
    for (let x = Math.floor(image.width * 0.6); x < image.width * 0.85; x++) {
      const offset = (y * image.width + x) * 4;
      sampled++;
      if (color.every((channel, index) => Math.abs(data[offset + index] - channel) < 5))
        matching++;
    }
  }
  return matching / sampled;
}

test('built demo loads minified modules and worker with native FPS, paint and mode switches', async ({ page, productionUrl }) => {
  const errors = [];
  const unexpected = [];
  const resources = [];
  const workers = [];
  const failedAssets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => message.type() === 'error' && errors.push(message.text()));
  page.on('request', request => resources.push(request.url()));
  page.on('worker', worker => workers.push(worker.url()));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.includes('/cesiumStatic/') && response.status() >= 400)
      failedAssets.push({ url: response.url(), status: response.status() });
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === productionUrl) {
      if (url.pathname.endsWith('.pbf'))
        return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
      return route.continue();
    }
    if (url.origin === 'https://tiles.openfreemap.org' && ['/styles/liberty', '/styles/bright'].includes(url.pathname)) {
      return route.fulfill({ json: {
        version: 8,
        sources: { fixture: { type: 'vector', tiles: [`${productionUrl}${basePath}production-fixture/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#aa2222' } },
          { 'id': 'land', 'type': 'fill', 'source': 'fixture', 'source-layer': 'land', 'paint': { 'fill-color': url.pathname.endsWith('/bright') ? '#22aa55' : '#3366aa', 'fill-antialias': false } },
          { 'id': 'roads', 'type': 'line', 'source': 'fixture', 'source-layer': 'roads', 'layout': { 'line-cap': 'round', 'line-join': 'round' }, 'paint': { 'line-color': '#ffffff', 'line-width': 2 } },
        ],
      } });
    }
    unexpected.push(url.href);
    return route.abort();
  });

  await page.goto(`${productionUrl}${basePath}?preset=london&source=liberty`);
  await expect.poll(() => pixels(page, [51, 102, 170])).toBeGreaterThanOrEqual(0.95);
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  // Cesium reports N/A when requestRenderMode has no frame to draw.
  await expect(page.locator('.cesium-performanceDisplay-fps')).toHaveText(/(?:\d+|N\/A) FPS/);
  await expect.poll(() => page.locator('.cesium-credit-logoContainer img').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await page.getByTestId('source-select').selectOption('bright');
  await expect.poll(() => pixels(page, [34, 170, 85])).toBeGreaterThanOrEqual(0.95);
  for (const [mode, source, color] of [
    ['2d', 'liberty', [51, 102, 170]],
    ['cv', 'bright', [34, 170, 85]],
    ['3d', 'liberty', [51, 102, 170]],
  ] satisfies Array<[string, string, number[]]>) {
    await page.getByTestId('scene-select').selectOption(mode);
    await expect(page).toHaveURL(new RegExp(`mode=${mode}`));
    // A new color after each mode change must come from a new rendered frame.
    await page.getByTestId('source-select').selectOption(source);
    await expect.poll(() => pixels(page, color)).toBeGreaterThanOrEqual(0.95);
    await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  }
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.ok(resources.some(url => new URL(url).pathname.startsWith(`${basePath}assets/index-`) && url.endsWith('.js')), 'no production main module was loaded');
  assert.ok(workers.some(url => url.startsWith(`${productionUrl}${basePath}assets/`) && url.endsWith('.js')), 'the built demo did not execute its bundled worker');
  assert.ok(!resources.some(url => /\/(?:src\/|@vite\/|@id\/|@fs\/)/.test(new URL(url).pathname)), 'production requested development modules');
  assert.ok(resources.filter(url => /\/(?:assets|cesiumStatic)\//.test(new URL(url).pathname))
    .every(url => new URL(url).pathname.startsWith(basePath)), 'static assets escaped the deployment base path');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(failedAssets, []);
  assert.deepEqual(errors, []);
});
