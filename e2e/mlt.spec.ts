import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { expect } from 'playwright/test';
import { test } from './fixtures';

// Official @maplibre/mlt encodeTile fixture: extent 64, layer1, point [13, 42], UINT64 id 9007199254740993.
const tile = Buffer.from('JAEGbGF5ZXIxQAICBBACAQiBgICAgICAEAIwAgEBABMCAgIaVA==', 'base64');

test('published MLT UINT64 ID survives decoding, picking and feature-state paint', async ({ page, renderUrl }, testInfo) => {
  const errors = [];
  const tileRequests = [];
  const moduleRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => moduleRequests.push(request.url()));
  await page.route('**/mlt-fixture/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('.mlt')) {
      tileRequests.push(url);
      return route.fulfill({ body: tile, contentType: 'application/octet-stream' });
    }
    return route.fulfill({ json: {
      version: 8,
      sources: { points: {
        type: 'vector',
        encoding: 'mlt',
        tiles: [`${renderUrl}/mlt-fixture/{z}/{x}/{y}.mlt`],
        maxzoom: 22,
      } },
      layers: [{
        'id': 'points',
        'type': 'circle',
        'source': 'points',
        'source-layer': 'layer1',
        'paint': {
          'circle-radius': 24,
          'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#00ff00', ['case', ['==', ['id'], '9007199254740993'], '#0000ff', '#ff0000']],
        },
      }],
    } });
  });
  const query = new URLSearchParams({
    style: `${renderUrl}/mlt-fixture/style.json`,
    published: '1',
    scale: '0.25',
    // Center the camera on this sparse fixture's point in tile 14/8186/5448.
    center: '-0.12737274169921875,51.49976691240594',
  });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.stats().bucket.tiles ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded ?? false)).toBe(true);
  assert.ok(tileRequests.length > 0, 'the worker did not request MLT data');
  assert.ok(moduleRequests.some(url => url.includes('/dist/index.mjs')));
  assert.ok(moduleRequests.some(url => url.includes('/dist/worker.mjs')));

  const tiles = await page.evaluate(() => {
    const pyramid = window.renderValidation.tileset._style.tilePyramids.points;
    return pyramid.getRenderableIds().map(id => pyramid.getTileByID(id).tileID.canonical);
  });
  const coordinates = tiles.map(({ z, x, y }) => {
    const size = 2 ** z;
    return [
      (x + 13 / 64) / size * 360 - 180,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 42 / 64) / size))) * 180 / Math.PI,
    ];
  });
  const point = await page.evaluate((coordinates) => {
    const validation = window.renderValidation;
    const { clientWidth: width, clientHeight: height } = validation.viewer.canvas;
    return coordinates
      .map(([longitude, latitude]) => validation.projectPosition(longitude, latitude, 1))
      .filter(point => point && point.x > 32 && point.y > 32 && point.x < width - 32 && point.y < height - 32)
      .sort((a, b) => Math.hypot(a.x - width / 2, a.y - height / 2) - Math.hypot(b.x - width / 2, b.y - height / 2))[0];
  }, coordinates);
  assert.ok(point, 'no decoded point projected into the viewport');
  await testInfo.attach('mlt-projection', { body: JSON.stringify({ tiles, coordinates, point }), contentType: 'application/json' });

  const pixel = () => page.evaluate(point => new Promise<number[]>((resolve) => {
    const { viewer } = window.renderValidation;
    const remove = viewer.scene.postRender.addEventListener(() => {
      remove();
      const { canvas } = viewer;
      resolve([...viewer.scene.context.readPixels({
        x: Math.floor(point.x * canvas.width / canvas.clientWidth),
        y: canvas.height - 1 - Math.floor(point.y * canvas.height / canvas.clientHeight),
        width: 1,
        height: 1,
      })]);
    });
    viewer.scene.requestRender();
  }), point);
  await expect.poll(async () => (await pixel()).slice(0, 3)).toEqual([0, 0, 255]);
  const picked = await page.evaluate((point) => {
    const validation = window.renderValidation;
    const picked = validation.viewer.scene.pick(point);
    if (!picked)
      return;
    const object = picked.id ?? picked;
    const feature = validation.tileset.pick(object);
    const index = validation.tileset._tileResidency.featureIndex(object.tileId, object.generationId);
    return { feature, hasRawData: 'rawTileData' in index, id: index.features.getFeature('layer1', object.featureIndex).id };
  }, point);
  assert.deepEqual(picked, { feature: { layerId: 'points', properties: {} }, hasRawData: false, id: '9007199254740993' });

  const requestsBeforeState = tileRequests.length;
  await page.evaluate(() => {
    const validation = window.renderValidation;
    validation.tileset._style.setFeatureState({ source: 'points', sourceLayer: 'layer1', id: '9007199254740993' }, { selected: true });
    validation.viewer.scene.requestRender();
  });
  await expect.poll(async () => (await pixel()).slice(0, 3)).toEqual([0, 255, 0]);
  assert.equal(tileRequests.length, requestsBeforeState, 'feature-state refetched MLT data');
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.renderValidation.viewer.scene.debugShowFramesPerSecond), true);
});
