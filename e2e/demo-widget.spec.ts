import type { PerspectiveFrustum } from 'cesium';
import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    completedWidgetFlight: boolean;
    cancelledWidgetFlight: boolean;
    completedCancelledFlight: boolean;
    widgetMorphTimes: number[];
    stopWidgetMorph: () => void;
  }
}

const tile = Buffer.from(fromGeojsonVt({
  land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
}, { version: 2, extent: 4096 }));

async function openWidget(page: Page, renderUrl: string, query = '') {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/widget-fixture/**', route => route.request().url().endsWith('.pbf')
    ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
    : route.fulfill({ json: {
        version: 8,
        sources: { fixture: { type: 'vector', tiles: [`${renderUrl}/widget-fixture/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
        layers: [{ 'id': 'land', 'type': 'fill', 'source': 'fixture', 'source-layer': 'land', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } }],
      } }));
  await page.goto(`${renderUrl}/e2e/fixtures/demo-widget.html${query}`);
  await expect.poll(() => page.evaluate(() => window.widgetValidation?.tileset.tilesLoaded
    && window.widgetValidation.scene.globe.tilesLoaded
    && window.widgetValidation.coverage() > 0.95), { timeout: 60_000 }).toBe(true);
  await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
  return errors;
}

test('Cesium map scene advances controls and tweens while skipping idle draws, and resizes without rebuilding', async ({ page, renderUrl }, testInfo) => {
  const errors = await openWidget(page, renderUrl);
  const idle = await page.evaluate(async () => {
    const validation = window.widgetValidation;
    const before = validation.counts();
    const loaded = { globe: validation.scene.globe.tilesLoaded, mvt: validation.tileset.tilesLoaded };
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    return { before, after: validation.counts(), fps: validation.scene.debugShowFramesPerSecond, loaded };
  });
  assert.deepEqual(idle.loaded, { globe: true, mvt: true });
  assert.ok(idle.after.renderCalls - idle.before.renderCalls >= 3, 'idle RAF stopped advancing the Native Scene');
  assert.ok(idle.after.renderedFrames - idle.before.renderedFrames <= 2, `idle Scene kept drawing: ${JSON.stringify(idle)}`);
  assert.ok(idle.fps);

  const pose = () => page.evaluate(() => Array.from({ length: 3 }, (_, index) =>
    window.widgetValidation.scene.camera.positionWC[(['x', 'y', 'z'] as const)[index]]));
  const initialPose = await pose();
  await page.mouse.move(900, 350);
  await page.mouse.down();
  await page.mouse.move(980, 400, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await pose()).some((value, index) => Math.abs(value - initialPose[index]) > 10)).toBe(true);
  const beforeWheel = await pose();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await pose()).some((value, index) => Math.abs(value - beforeWheel[index]) > 10)).toBe(true);

  await page.evaluate(() => {
    const { scene, Cartesian3 } = window.widgetValidation;
    scene.camera.cancelFlight();
    scene.screenSpaceCameraController.enableInputs = false;
    window.completedWidgetFlight = false;
    scene.camera.flyTo({
      destination: Cartesian3.fromDegrees(139.69, 35.69, 10_000),
      duration: 0.5,
      complete: () => { window.completedWidgetFlight = true; },
    });
  });
  await expect.poll(() => page.evaluate(() => window.completedWidgetFlight)).toBe(true);
  await page.evaluate(() => {
    const { scene, Cartesian3 } = window.widgetValidation;
    window.cancelledWidgetFlight = false;
    window.completedCancelledFlight = false;
    scene.camera.flyTo({
      destination: Cartesian3.fromDegrees(-74, 40.71, 10_000),
      duration: 2,
      cancel: () => { window.cancelledWidgetFlight = true; },
      complete: () => { window.completedCancelledFlight = true; },
    });
    scene.camera.cancelFlight();
  });
  assert.equal(await page.evaluate(() => window.cancelledWidgetFlight && !window.completedCancelledFlight), true);

  for (const [method, mode] of [['morphTo2D', 2], ['morphToColumbusView', 1], ['morphTo3D', 3]] as const) {
    await page.evaluate((method) => {
      const { scene } = window.widgetValidation;
      window.widgetMorphTimes = [];
      window.stopWidgetMorph = scene.postRender.addEventListener(() => {
        if (scene.mode === 0)
          window.widgetMorphTimes.push(scene.morphTime);
      });
      scene[method](0.6);
    }, method);
    await expect.poll(() => page.evaluate(mode => window.widgetValidation.scene.mode === mode, mode)).toBe(true);
    assert.ok(await page.evaluate((method) => {
      window.stopWidgetMorph();
      return window.widgetMorphTimes.length > 0
        && (method === 'morphToColumbusView' || window.widgetMorphTimes.some(time => time > 0 && time < 1));
    }, method), `${method} did not render an intermediate Native morph frame`);
  }

  const resized = await page.evaluate(() => {
    const { widget, scene } = window.widgetValidation;
    const map = document.getElementById('map');
    map.style.width = '640px';
    map.style.height = '360px';
    widget.resize();
    return { width: scene.canvas.width, height: scene.canvas.height, aspect: (scene.camera.frustum as PerspectiveFrustum).aspectRatio };
  });
  assert.deepEqual(resized, { width: 640, height: 360, aspect: 640 / 360 });
  const zeroSize = await page.evaluate(async () => {
    const validation = window.widgetValidation;
    const map = document.getElementById('map');
    map.style.width = '0px';
    map.style.height = '0px';
    validation.widget.resize();
    const before = validation.counts();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    const after = validation.counts();
    map.style.width = '640px';
    map.style.height = '360px';
    validation.widget.resize();
    return { before, after };
  });
  assert.equal(zeroSize.after.renderCalls, zeroSize.before.renderCalls, 'zero-sized map scene rendered into a zero-sized buffer');
  await expect.poll(() => page.evaluate(baseline => window.widgetValidation.counts().renderCalls > baseline.renderCalls
    && window.widgetValidation.counts().renderedFrames > baseline.renderedFrames
    && window.widgetValidation.scene.canvas.width === 640, zeroSize.after)).toBe(true);
  const final = await page.evaluate(async () => {
    const validation = window.widgetValidation;
    validation.widget.destroy();
    const before = validation.counts();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    return {
      before,
      after: validation.counts(),
      destroyed: validation.scene.isDestroyed(),
      canvases: document.querySelectorAll('canvas').length,
      errors: validation.errors,
    };
  });
  assert.deepEqual(final.before, final.after);
  assert.ok(final.destroyed);
  assert.equal(final.canvases, 0);
  assert.deepEqual(final.errors, []);
  assert.deepEqual(errors, []);
  const output = testInfo.outputPath('native-widget.json');
  await writeFile(output, JSON.stringify({ idle, resized, zeroSize, final }, null, 2));
  await testInfo.attach('native-widget', { path: output, contentType: 'application/json' });
});

test('Cesium map scene uses the requested pixel ratio and stops once on a real Primitive render error', async ({ page, renderUrl }) => {
  const errors = await openWidget(page, renderUrl, '?resolutionRatio=2');
  assert.deepEqual(await page.evaluate(() => {
    const { scene } = window.widgetValidation;
    return { width: scene.canvas.width, height: scene.canvas.height, ratio: (scene as typeof scene & { pixelRatio: number }).pixelRatio };
  }), { width: 2560, height: 1440, ratio: 2 });
  await page.evaluate(() => {
    const { scene, Primitive } = window.widgetValidation;
    const primitive = new Primitive();
    primitive.update = () => {
      throw new Error('intentional Primitive failure');
    };
    scene.primitives.add(primitive);
    scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.widgetValidation.errors)).toEqual(['Error: intentional Primitive failure']);
  assert.equal(await page.evaluate(() => window.widgetValidation.widget.useDefaultRenderLoop), false);
  assert.equal(await page.evaluate(() => window.widgetValidation.scene.isDestroyed()), false);
  await page.evaluate(() => window.widgetValidation.widget.destroy());
  await expect(page.locator('canvas')).toHaveCount(0);
  assert.deepEqual(errors, []);
});
