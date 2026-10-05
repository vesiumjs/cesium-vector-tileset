import type { BufferPointCollection, PrimitiveCollection } from 'cesium';
import type { NativeCommand, NativePrimitive } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';
import { Cartesian3 } from 'cesium';
import { expect } from 'playwright/test';
import buildingsStyle from '../src/styles/buildings.json' with { type: 'json' };
import { fromGeojsonVt, test } from './fixtures';
import fixture from './fixtures/building-seams-fixture.json' with { type: 'json' };

const tileId = `${fixture.tile.z}/${fixture.tile.x}/${fixture.tile.y}`;
const buildingTile = Buffer.from(fromGeojsonVt({
  building: { features: fixture.features },
  // Keep the point in the building's overzoomed child, rather than a remote
  // corner of the parent tile that the street-height camera never loads.
  points: { features: [{ id: 1, type: 1, geometry: [[2688, 1530]], tags: {} }] },
}, fixture.tile));
const emptyTile = Buffer.from(fromGeojsonVt({}));

async function wallPixels(page) {
  const image = await loadImage(await page.locator('.cesium-widget canvas').screenshot());
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { x, y, width, height } = fixture.roi;
  const pixels = context.getImageData(x, y, width, height).data;
  const neutral = [];
  const mean = [0, 0, 0];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const rgb = pixels.subarray(offset, offset + 3);
    for (let channel = 0; channel < 3; channel++)
      mean[channel] += rgb[channel] / (width * height);
    if (Math.max(...rgb) - Math.min(...rgb) < 3)
      neutral.push(pixels[offset]);
  }
  neutral.sort((a, b) => a - b);
  const median = neutral[Math.floor(neutral.length / 2)] ?? 0;
  return { median, neutral: neutral.length, bright: neutral.filter(value => value > median + 20).length, mean };
}

test('15 metre building walls update color, light and opacity without rebuilding Native geometry', async ({ page, renderUrl }, testInfo) => {
  const errors = [];
  const requested = new Set();
  let requestCount = 0;
  page.on('pageerror', error => errors.push(error.message));
  // Keep the real demo layers, expressions and filters. Only the external
  // vector source is replaced with the captured buildings and a nearby point.
  const style = {
    ...buildingsStyle,
    sources: { basemap: { type: 'vector', tiles: [`${renderUrl}/building-seams/{z}/{x}/{y}.pbf`], ...fixture.source } },
    layers: [...buildingsStyle.layers, {
      'id': 'points',
      'type': 'circle',
      'source': 'basemap',
      'source-layer': 'points',
      'paint': { 'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#00ff00', '#ff0000'] },
    }],
  };
  await page.route('**/building-seams/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('.pbf')) {
      requestCount++;
      const requestedId = pathname.match(/(\d+\/\d+\/\d+)\.pbf$/)[1];
      requested.add(requestedId);
      return route.fulfill({ body: requestedId === tileId ? buildingTile : emptyTile, contentType: 'application/x-protobuf' });
    }
    return route.fulfill({ json: style });
  });
  // Cesium resources load locally through Vite. No live tile request can
  // supply geometry or satisfy the wall assertion.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => route.abort());
  const query = new URLSearchParams({ view: 'newYork', mode: '3d', atlas: '1', style: `${renderUrl}/building-seams/style.json` });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderValidation);
  const camera = fixture.camera;
  await page.evaluate(({ destination, heading, pitch }) => {
    const { viewer } = window.renderValidation;
    viewer.camera.setView({ destination, orientation: { heading, pitch, roll: 0 } });
    viewer.scene.requestRender();
  }, {
    destination: Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
    heading: camera.heading * Math.PI / 180,
    pitch: camera.pitch * Math.PI / 180,
  });
  await page.waitForFunction(() => window.renderValidation.renderErrors.length
    || (window.renderValidation.tileset.tilesLoaded && window.renderValidation.viewer.scene.globe.tilesLoaded), undefined, { timeout: 90_000 });
  await expect.poll(async () => (await wallPixels(page)).neutral, { timeout: 90_000 }).toBeGreaterThan(3500);
  await expect.poll(async () => (await wallPixels(page)).median, { timeout: 90_000 }).toBeGreaterThan(70);
  const pixels = await wallPixels(page);
  const state = await page.evaluate(() => {
    const { viewer, renderErrors } = window.renderValidation;
    return { renderErrors, canvas: { width: viewer.canvas.width, height: viewer.canvas.height } };
  });
  await page.locator('.cesium-widget canvas').screenshot({ path: testInfo.outputPath('building-wall.png') });
  await testInfo.attach('wall-pixels', { body: JSON.stringify(pixels), contentType: 'application/json' });
  assert.ok(requested.has(tileId), 'the captured Manhattan tile was not requested');
  assert.deepEqual(state.canvas, { width: 1280, height: 720 }, 'wall ROI requires the captured viewport');
  assert.ok(pixels.neutral > 3500 && pixels.median > 70 && pixels.median < 160, `wall ROI is not the captured shaded facade: ${JSON.stringify(pixels)}`);
  assert.deepEqual(state.renderErrors, [], 'Cesium render errors');
  assert.deepEqual(errors, [], 'browser errors');
  assert.ok(pixels.bright <= 2, `wall contains ${pixels.bright} bright interior pixels: ${JSON.stringify(pixels)}`);

  const sourceRequests = requestCount;
  const owners = await page.evaluateHandle(({ x, y, width, height }) => {
    const { tileset, drawBatch, viewer } = window.renderValidation;
    const collections = [...tileset._vectorRenderer.collections.values()].filter((collection): collection is PrimitiveCollection => 'length' in collection && collection.length > 0
      && drawBatch(collection.get(0))?.kind === 'extrusion');
    const position = { x: x + width / 2, y: y + height / 2 };
    return {
      position,
      picked: viewer.scene.pick(position, 1, 1)?.id,
      owners: collections.map(collection => ({
        collection,
        primitives: Array.from({ length: collection.length }, (_, index) => {
          const primitive = collection.get(index) as NativePrimitive;
          return { primitive, arrays: [...primitive._va] };
        }),
      })),
    };
  }, fixture.roi);
  const geometryStable = () => owners.evaluate(({ owners }) => {
    const current = new Set(window.renderValidation.tileset._vectorRenderer.collections.values());
    return owners.every(({ collection, primitives }) => current.has(collection) && !collection.isDestroyed()
      && primitives.every(({ primitive, arrays }, index) => collection.get(index) === primitive && !primitive.isDestroyed()
        && primitive._va.length === arrays.length && arrays.every((array, index) => primitive._va[index] === array && !array.isDestroyed())));
  });
  try {
    assert.ok(await owners.evaluate(({ owners }) => owners.length > 0 && owners.every(({ primitives }) => primitives.every(({ arrays }) => arrays.length > 0))), 'captured buildings have no Native vertex arrays');
    assert.equal(await owners.evaluate(({ picked }) => picked?.layerId), 'white-buildings', 'wall ROI does not pick the captured facade');
    await page.evaluate(() => {
      const { tileset, viewer } = window.renderValidation;
      tileset._style.setFeatureState({ source: 'basemap', sourceLayer: 'points', id: 1 }, { selected: true });
      viewer.scene.requestRender();
    });
    await expect.poll(() => page.evaluate(() => {
      const { tileset, atlas, drawBatch } = window.renderValidation;
      const { BufferPoint, BufferPointMaterial } = atlas.cesium;
      const collections = [...tileset._vectorRenderer.collections.values()];
      const points = collections.find(collection => drawBatch(collection)?.layerId === 'points') as BufferPointCollection | undefined;
      if (!points)
        return undefined;
      const color = points.get(0, new BufferPoint()).getMaterial(new BufferPointMaterial()).color;
      return { red: color.red, green: color.green };
    })).toMatchObject({ red: 0, green: 1 });
    assert.ok(await geometryStable(), 'unrelated circle paint replaced the building geometry');
    const repainted = await wallPixels(page);
    assert.ok(repainted.neutral > 3500 && repainted.bright <= 2, `feature-state paint changed the wall: ${JSON.stringify(repainted)}`);

    await page.evaluate(() => {
      const { tileset, viewer } = window.renderValidation;
      tileset._style.setPaintProperty('points', 'circle-opacity', 0.5);
      viewer.scene.requestRender();
    });
    await expect.poll(() => page.evaluate(() => {
      const { tileset, atlas, drawBatch } = window.renderValidation;
      const { BufferPoint, BufferPointMaterial } = atlas.cesium;
      const points = [...tileset._vectorRenderer.collections.values()].find(collection => drawBatch(collection)?.layerId === 'points') as BufferPointCollection | undefined;
      return points?.get(0, new BufferPoint()).getMaterial(new BufferPointMaterial()).color.alpha;
    })).toBeCloseTo(0.5, 2);
    assert.ok(await geometryStable(), 'unrelated constant paint replaced the building geometry');
    const unchanged = await wallPixels(page);
    assert.ok(unchanged.neutral > 3500 && unchanged.bright <= 2, `constant circle paint changed the wall: ${JSON.stringify(unchanged)}`);

    await page.evaluate(() => {
      const { tileset, viewer } = window.renderValidation;
      tileset._style.setPaintProperty('white-buildings', 'fill-extrusion-color', '#4466aa');
      viewer.scene.requestRender();
    });
    await expect.poll(async () => (await wallPixels(page)).neutral).toBeLessThan(1000);
    assert.ok(await geometryStable(), 'building color replaced Native geometry or vertex arrays');
    const colored = await wallPixels(page);
    assert.ok(colored.mean[2] > colored.mean[0] + 20, 'the facade did not display its blue paint');

    await page.evaluate(() => {
      const { tileset, viewer } = window.renderValidation;
      tileset._style.setLight({ intensity: 0 });
      viewer.scene.requestRender();
    });
    await expect.poll(async () => (await wallPixels(page)).mean[2]).toBeGreaterThan(colored.mean[2] + 20);
    assert.ok(await geometryStable(), 'building light replaced Native geometry or vertex arrays');

    await page.evaluate(() => {
      const { tileset, viewer } = window.renderValidation;
      tileset._style.setPaintProperty('white-buildings', 'fill-extrusion-opacity', 0.5);
      viewer.scene.requestRender();
    });
    await expect.poll(() => owners.evaluate(({ owners }) => owners.every(({ primitives }) => primitives.every(({ primitive }) => {
      const native = primitive as NativePrimitive & { _colorCommands: NativeCommand[] };
      return native.appearance.isTranslucent() && native._colorCommands.length === native._va.length
        && native._colorCommands.every(command => command.renderState.blending.enabled && !command.renderState.depthMask);
    })))).toBe(true);
    const translucent = await wallPixels(page);
    assert.ok(translucent.mean[0] > colored.mean[0] + 20, 'half-opacity paint did not reveal the background');
    assert.ok(await geometryStable(), 'building opacity replaced Native geometry or vertex arrays');
    assert.ok(await owners.evaluate(({ position, picked }) => window.renderValidation.viewer.scene.pick(position, 1, 1)?.id === picked), 'building paint changed the Native pick identity');

    for (const opacity of [0, 1]) {
      await page.evaluate((opacity) => {
        const { tileset, viewer } = window.renderValidation;
        tileset._style.setPaintProperty('white-buildings', 'fill-extrusion-opacity', opacity);
        viewer.scene.requestRender();
      }, opacity);
      await expect.poll(() => owners.evaluate(({ owners }, visible) => owners.every(({ primitives }) => primitives.every(({ primitive }) => primitive.show === visible)), opacity > 0)).toBe(true);
      assert.ok(await geometryStable(), 'opacity visibility crossing replaced Native geometry or vertex arrays');
    }
    await expect.poll(() => owners.evaluate(({ owners }) => owners.every(({ primitives }) => primitives.every(({ primitive }) => {
      const native = primitive as NativePrimitive & { _colorCommands: NativeCommand[] };
      return !native.appearance.isTranslucent() && native._colorCommands.length === native._va.length
        && native._colorCommands.every(command => !command.renderState.blending.enabled && command.renderState.depthMask);
    })))).toBe(true);
    assert.ok(await owners.evaluate(({ position, picked }) => window.renderValidation.viewer.scene.pick(position, 1, 1)?.id === picked), 'showing the facade again changed its Native pick identity');
    assert.equal(requestCount, sourceRequests, 'paint changes fetched source tiles again');
    await testInfo.attach('paint-wall-pixels', { body: JSON.stringify({ colored, translucent, restored: await wallPixels(page) }), contentType: 'application/json' });
    assert.ok(await page.evaluate(() => window.renderValidation.viewer.scene.debugShowFramesPerSecond), 'Cesium FPS display was disabled');
    assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
    assert.deepEqual(errors, [], 'browser errors after paint changes');
  }
  finally {
    await owners.dispose();
  }
});
