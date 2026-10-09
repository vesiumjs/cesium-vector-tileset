import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from 'canvas';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    backgroundLoadTimeline: Array<{ time: number; key: string; initialized: boolean; globeLoaded?: boolean; tiles?: number; pending?: number }>;
  }
}

const tile = fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] } }, { version: 2, extent: 4096 });

async function pixels(page, testInfo, name) {
  const view = new URL(page.url()).searchParams.get('view');
  const buffer = await page.locator('#cesium').screenshot({ path: testInfo.outputPath(`${name}-${view}.png`) });
  await testInfo.attach(`${name}-${view}`, { body: buffer, contentType: 'image/png' });
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  const colorAt = (x, y) => Array.from(data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  const changes = [];
  const y = Math.floor(image.height / 2);
  for (let x = 100; x < image.width - 100; x++) {
    const before = colorAt(x - 1, y)[0] > 128;
    const after = colorAt(x, y)[0] > 128;
    if (before !== after)
      changes.push(x);
  }
  const periods = changes.slice(2).map((x, index) => x - changes[index]).sort((a, b) => a - b);
  return { center: colorAt(Math.floor(image.width / 2), y), left: colorAt(Math.floor(image.width / 4), y), right: colorAt(Math.floor(image.width * 3 / 4), y), topLeft: colorAt(10, 10), period: periods[Math.floor(periods.length / 2)], periodRange: [periods[0], periods.at(-1)] };
}

for (const scenario of [{ mode: '3d', ratio: 1 }, { mode: '2d', ratio: 1 }, { mode: 'cv', ratio: 1 }, { mode: '2d', ratio: 2 }, { mode: '2d', ratio: 1, view: 'antimeridian' }]) {
  const { mode, ratio } = scenario;
  const view = scenario.view ?? 'london';
  test.describe(`background/${mode}/${view}/DPR${ratio}`, () => {
    // Keep the physical framebuffer area fixed on the software GPU while
    // exercising native DPR2 rendering rather than upscaled DPR1 pixels.
    test.use({ viewport: { width: 1000 / ratio, height: 700 / ratio }, deviceScaleFactor: ratio });
    test('background color, pattern and globe masking', async ({ page, renderUrl }, testInfo) => {
      test.setTimeout(90_000);
      const baseUrl = renderUrl;
      const measurements = [];
      try {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error')
            errors.push(message.text());
        });
        const style = {
          version: 8,
          sprite: `${baseUrl}/background-test/sprite`,
          sources: { test: { type: 'vector', tiles: [`${baseUrl}/background-test/tile/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
          layers: [
            { id: 'red', type: 'background', paint: { 'background-color': '#ff0000' } },
            { 'id': 'land', 'type': 'fill', 'source': 'test', 'source-layer': 'land', 'paint': { 'fill-color': '#00ff00', 'fill-antialias': false } },
            { id: 'blue', type: 'background', paint: { 'background-color': '#0000ff', 'background-opacity': 0.5 } },
          ],
        };
        const sprite = createCanvas(56, 8);
        const spriteContext = sprite.getContext('2d');
        spriteContext.fillStyle = 'rgba(0,0,255,0.5)';
        spriteContext.fillRect(0, 0, 8, 8);
        spriteContext.fillStyle = '#000';
        spriteContext.fillRect(8, 0, 24, 8);
        spriteContext.fillStyle = '#fff';
        spriteContext.fillRect(32, 0, 24, 8);
        await page.route('**/background-test/**', (route) => {
          const url = route.request().url();
          if (url.endsWith('.pbf'))
            return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
          if (url.endsWith('.png'))
            return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
          if (url.includes('sprite') && url.endsWith('.json'))
            return route.fulfill({ json: { alpha: { x: 0, y: 0, width: 8, height: 8, pixelRatio: 1 }, stripe: { x: 8, y: 0, width: 48, height: 8, pixelRatio: 2 } } });
          return route.fulfill({ json: style });
        });
        const query = new URLSearchParams({ mode, view: scenario.view ?? 'london', style: `${baseUrl}/background-test/style.json` });
        await page.goto(`${baseUrl}/e2e/fixtures/render-fixture.html?${query}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
          const validation = window.renderValidation;
          const stats = validation?.tileset.stats();
          const state = { initialized: !!validation, globeLoaded: validation?.viewer.scene.globe.tilesLoaded, tiles: stats?.bucket.tiles, pending: stats?.pendingPublishes };
          const key = JSON.stringify(state);
          window.backgroundLoadTimeline ??= [];
          if (window.backgroundLoadTimeline.at(-1)?.key !== key)
            window.backgroundLoadTimeline.push({ time: performance.now(), key, ...state });
          return validation && (validation.renderErrors.length || (state.globeLoaded && state.tiles > 0 && state.pending === 0));
        }, undefined, { timeout: 60000 });
        await page.waitForTimeout(300);
        const diagnostics = await page.evaluate(() => ({ errors: window.renderValidation.renderErrors, depthTexture: window.renderValidation.viewer.scene.context.depthTexture, depthTest: window.renderValidation.viewer.scene.globe.depthTestAgainstTerrain, requestRenderMode: window.renderValidation.viewer.scene.requestRenderMode }));
        assert.deepEqual(diagnostics.errors, [], `${mode}: Cesium render errors`);
        assert.deepEqual(errors, [], `${mode}: browser errors`);
        for (const depthTest of [false, true]) {
          await page.evaluate((value) => {
            window.renderValidation.viewer.scene.globe.depthTestAgainstTerrain = value;
            window.renderValidation.viewer.scene.requestRender();
          }, depthTest);
          await page.waitForTimeout(200);
          const actualDepthTest = await page.evaluate(() => window.renderValidation.viewer.scene.globe.depthTestAgainstTerrain);
          assert.equal(actualDepthTest, depthTest);
          const actual = await pixels(page, testInfo, `${mode}-${ratio}-late-${depthTest}`);
          assert.ok(actual.center.every((value, index) => Math.abs(value - [0, 128, 128][index]) <= 2), `${mode}: late background color ${actual.center}`);
          measurements.push({ mode, ratio, view, depthTest, diagnostics: { ...diagnostics, depthTest: actualDepthTest }, ...actual });
        }
        await page.evaluate(() => {
          window.renderValidation.tileset._style.setLayoutProperty('land', 'visibility', 'none');
          window.renderValidation.viewer.scene.requestRender();
        });
        await page.waitForTimeout(300);
        const backgroundOnly = await pixels(page, testInfo, `${mode}-${ratio}-multiple`);
        assert.ok(backgroundOnly.center.every((value, index) => Math.abs(value - [128, 0, 128][index]) <= 2), `${mode}: multiple backgrounds ${backgroundOnly.center}`);
        for (const color of [backgroundOnly.left, backgroundOnly.right])
          assert.ok(color.every((value, index) => Math.abs(value - [128, 0, 128][index]) <= 2), `${mode}: viewport background ${color}`);
        await page.evaluate(() => {
          window.renderValidation.tileset._style.setPaintProperty('blue', 'background-pattern', 'alpha');
          window.renderValidation.viewer.scene.requestRender();
        });
        await page.waitForTimeout(500);
        const transparentSprite = await pixels(page, testInfo, `${mode}-${ratio}-sprite-alpha`);
        assert.ok(transparentSprite.center.every((value, index) => Math.abs(value - [191, 0, 64][index]) <= 2), `${mode}: transparent sprite ${transparentSprite.center}`);
        await page.evaluate(() => {
          const { tileset, viewer } = window.renderValidation;
          const image = tileset._style.getImage('alpha');
          for (let offset = 0; offset < image.data.data.length; offset += 4) {
            image.data.data[offset] = 255;
            image.data.data[offset + 1] = 255;
            image.data.data[offset + 2] = 0;
          }
          image.version = (image.version ?? 0) + 1;
          viewer.scene.requestRender();
        });
        await page.waitForTimeout(300);
        const updatedSprite = await pixels(page, testInfo, `${mode}-${ratio}-sprite-version`);
        assert.ok(updatedSprite.center.every((value, index) => Math.abs(value - [255, 64, 0][index]) <= 2), `${mode}: updated sprite ${updatedSprite.center}`);
        await page.evaluate(() => {
          const { tileset, viewer } = window.renderValidation;
          tileset._style.setPaintProperty('blue', 'background-pattern', 'stripe');
          tileset._style.setPaintProperty('blue', 'background-opacity', 1);
          viewer.scene.requestRender();
        });
        await page.waitForTimeout(700);
        const stripe = await pixels(page, testInfo, `${mode}-${ratio}-stripe`);
        const zoom = await page.evaluate(() => window.renderValidation.zoom);
        const expectedPeriod = 24 * 2 ** (zoom - Math.floor(zoom)) * ratio;
        assert.ok(Math.abs(stripe.period - expectedPeriod) < 2, `${mode}/${ratio}: sprite period ${stripe.period} vs ${expectedPeriod} at zoom ${zoom}`);
        for (const period of stripe.periodRange)
          assert.ok(Math.abs(period - expectedPeriod) < 2, `${mode}/${ratio}: pattern seam period ${period} vs ${expectedPeriod}`);
        await page.evaluate(() => {
          const { viewer } = window.renderValidation;
          viewer.camera.zoomIn(viewer.camera.positionCartographic.height * 0.08);
          viewer.scene.requestRender();
        });
        await page.waitForTimeout(700);
        const zoomedStripe = await pixels(page, testInfo, `${mode}-${ratio}-stripe-zoomed`);
        const zoomed = await page.evaluate(() => window.renderValidation.zoom);
        const expectedZoomedPeriod = 24 * 2 ** (zoomed - Math.floor(zoomed)) * ratio;
        assert.ok(Math.abs(zoomedStripe.period - expectedZoomedPeriod) < 2, `${mode}/${ratio}: zoomed sprite period ${zoomedStripe.period} vs ${expectedZoomedPeriod}`);
        measurements.push({ mode, ratio, view, transparentSprite, updatedSprite, stripe: { ...stripe, zoom, expectedPeriod }, zoomedStripe: { ...zoomedStripe, zoom: zoomed, expectedPeriod: expectedZoomedPeriod } });
        if (ratio === 1 && !scenario.view && mode !== 'cv') {
          await page.evaluate(() => {
            const { viewer } = window.renderValidation;
            viewer.camera.zoomIn(viewer.camera.positionCartographic.height * (1 - 1 / 512));
            viewer.scene.requestRender();
          });
          await page.waitForTimeout(1500);
          const highZoomStripe = await pixels(page, testInfo, `${mode}-stripe-high-zoom`);
          const highZoom = await page.evaluate(() => window.renderValidation.zoom);
          const highZoomPeriod = 24 * 2 ** (highZoom - Math.floor(highZoom));
          assert.ok(highZoom > 21, `${mode}: high-zoom probe remained at ${highZoom}`);
          for (const period of highZoomStripe.periodRange)
            assert.ok(Math.abs(period - highZoomPeriod) < 2, `${mode}: detailed pattern phase/period ${period} vs ${highZoomPeriod}`);
          measurements.push({ mode, view, highZoom, highZoomPeriod, highZoomStripe });
        }
        if (mode === '3d') {
          await page.evaluate(() => {
            window.renderValidation.tileset._style.setPaintProperty('blue', 'background-pattern', undefined);
            window.renderValidation.tileset._style.setPaintProperty('blue', 'background-opacity', 0.5);
            window.renderValidation.viewer.scene.requestRender();
          });
          await page.evaluate(() => {
            const camera = window.renderValidation.viewer.camera;
            camera.setView({ destination: (camera.position.constructor as typeof import('cesium').Cartesian3).fromDegrees(0, 0, 24_000_000) });
            window.renderValidation.viewer.scene.requestRender();
          });
          await page.waitForTimeout(500);
          const far = await pixels(page, testInfo, `${mode}-sky`);
          assert.ok(far.topLeft.some((value, index) => Math.abs(value - [128, 0, 128][index]) > 32), `background painted sky: ${far.topLeft}`);
          assert.ok(far.center.every((value, index) => Math.abs(value - [128, 0, 128][index]) <= 2), `far/multiple-frustum background ${far.center}`);
          measurements.push({ mode, view, sky: far });
          await page.evaluate(() => {
            const { viewer } = window.renderValidation;
            viewer.camera.setView({ orientation: { heading: 0, pitch: Math.PI / 2, roll: 0 } });
            viewer.scene.requestRender();
          });
          await page.waitForTimeout(300);
          const skyOnly = await pixels(page, testInfo, '3d-sky-only');
          assert.ok(skyOnly.center.some((value, index) => Math.abs(value - [128, 0, 128][index]) > 32), `all-sky background ${skyOnly.center}`);
          await page.evaluate(() => {
            const { viewer } = window.renderValidation;
            viewer.camera.setView({ orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
            viewer.scene.globe.show = false;
            viewer.scene.requestRender();
          });
          await page.waitForTimeout(300);
          const noGlobe = await pixels(page, testInfo, '3d-no-globe');
          assert.ok(noGlobe.center.some((value, index) => Math.abs(value - [128, 0, 128][index]) > 32), `hidden-globe background ${noGlobe.center}`);
          assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), [], 'sky/globe.show=false render errors');
          measurements.push({ mode, view, skyOnly, noGlobe });
        }
        assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), [], `${mode}: final Cesium errors`);
        assert.deepEqual(errors, [], `${mode}: final browser errors`);
      }
      finally {
        const readiness = await page.evaluate(() => {
          const validation = window.renderValidation;
          if (!validation)
            return { initialized: false };
          const tileset = validation.tileset;
          return {
            initialized: true,
            mode: validation.viewer.scene.mode,
            renderedFrames: validation.renderedFrames,
            stats: tileset.stats(),
            tilesLoaded: tileset.tilesLoaded,
            globeLoaded: validation.viewer.scene.globe.tilesLoaded,
            renderErrors: validation.renderErrors,
            time: performance.now(),
            timeline: window.backgroundLoadTimeline,
            sources: Object.entries(tileset._style.tilePyramids).map(([id, pyramid]) => ({
              id,
              ideal: pyramid._covering?.idealTileIDs.map(tile => tile.toString()),
              renderable: pyramid.getRenderableIds().map(key => ({ key, state: pyramid.getTileByID(key).state })),
            })),
            jobs: [...tileset._tilePublishQueue._jobs.values()].map(job => ({ tileId: job.tileId, surfaces: job.surfaces, symbols: job.symbols })),
            patternRefreshes: [...tileset._tilePublishQueue._patternRefreshes.keys()],
            firstUpdates: tileset._sceneCollections._firstUpdates.flatMap(queue => [...queue].map(([collection, update]) => ({ show: collection.show, ready: collection.ready, index: update.index }))),
          };
        });
        const readinessOutput = testInfo.outputPath('readiness.json');
        await writeFile(readinessOutput, JSON.stringify(readiness, null, 2));
        await testInfo.attach('readiness', { path: readinessOutput, contentType: 'application/json' });
        const output = testInfo.outputPath('measurements.json');
        await writeFile(output, `${JSON.stringify(measurements, null, 2)}\n`);
        await testInfo.attach('measurements', { path: output, contentType: 'application/json' });
      }
    });
  });
}
