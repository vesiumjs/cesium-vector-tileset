import type { TestTileset } from './fixtures/browser-types';
import type { CityPose } from './fixtures/city-motion-adapter';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';

test('real station symbol identities before and after camera motion @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_CITY_DIAGNOSTICS !== '1', 'Opt-in semantic city diagnosis, excludes timing claims');
  test.setTimeout(180_000);
  let initial: CityPose | undefined;
  let poses: CityPose[] = [];
  const results = [];
  for (const renderer of ['cesium', 'maplibre']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...(process.env.E2E_CITY_VIDEO === '1' ? { recordVideo: { dir: testInfo.outputPath('video'), size: { width: 1280, height: 720 } } } : {}) });
    await routeCityReplay(context, 'replay');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const query = new URLSearchParams({ cityPerf: '1', motionBaseline: '1', readback: '0', cityProjection: '1', view: 'london', scale: '0.5', antialias: '0' });
    if (process.env.E2E_CITY_LIBRARY_DIR) {
      query.set('published', '1');
      query.set('publishedUrl', `${renderUrl}/@fs/${path.resolve(process.env.E2E_CITY_LIBRARY_DIR)}/index.mjs`);
    }
    if (process.env.E2E_CITY_VIDEO === '1')
      query.set('cityVideo', '1');
    if (process.env.E2E_CITY_STAGES === '1')
      query.set('cityStages', '1');
    if (renderer === 'maplibre') {
      query.set('renderer', renderer);
      query.set('initial', JSON.stringify(initial));
    }
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 90_000 }).toBe(true);
    const cold = await page.evaluate(() => window.cityMotion.snapshot());
    const before = renderer === 'cesium'
      ? await page.evaluate(() => window.renderValidation.cityDiagnostics())
      : await page.evaluate(() => window.cityMotion.mapFeatures());
    const commandsBefore = renderer === 'cesium' ? await page.evaluate(() => window.renderValidation.cityCommands()) : undefined;
    await page.screenshot({ path: testInfo.outputPath(`${renderer}-before.png`) });
    if (renderer === 'cesium') {
      initial = await page.evaluate(() => window.cityMotion.initial);
      poses = await page.evaluate(() => window.cityMotion.generate());
    }
    const motion = await page.evaluate(values => window.cityMotion.run(values), poses);
    if (renderer === 'maplibre') {
      expect(motion.projectionErrors).toHaveLength(poses.length);
      expect(Math.max(...motion.projectionErrors.map(error => error.maximum))).toBeLessThan(1);
    }
    await writeFile(testInfo.outputPath(`${renderer}-motion-diagnostics.json`), JSON.stringify({ renderer, cold, motion, before, commandsBefore }, null, 2));
    const readiness = [];
    try {
      await expect.poll(async () => {
        const state = await page.evaluate((renderer) => {
          const ready = window.cityMotion.ready();
          if (renderer !== 'cesium')
            return { ready };
          const tileset = window.renderValidation.tileset as unknown as TestTileset;
          const symbols = tileset._renderer.symbol;
          const scope = (value: typeof symbols._targetPlacement) => ({
            pending: value.pending,
            dirty: value._dirty,
            urgent: value._urgent,
            revision: value._revision,
            batches: value.batches.length,
            viewZoom: value._view?.cameraZoom,
            job: value.job && { revision: value.job.revision, batches: value.job.batches.length, batchIndex: value.job.pass._batchIndex, zoom: value.job.view.cameraZoom },
            complete: value.complete && { revision: value.complete.revision, zoom: value.complete.view.cameraZoom },
          });
          return {
            ready,
            at: performance.now(),
            frames: window.renderValidation.renderedFrames,
            stats: tileset.stats(),
            styleLoaded: tileset._renderer.style.loaded(),
            firstUpdates: tileset._renderer.collections.pendingFirstUpdateCount,
            paint: tileset._renderer.vector.needsPaintUpdate,
            jobs: [...tileset._renderer.publishQueue._jobs].map(([id, job]) => ({ id, surfaces: job.surfaces, symbols: job.symbols })),
            patternRefreshes: tileset._renderer.publishQueue._patternRefreshes.size,
            visibility: window.renderValidation.cityReadiness(),
            symbols: { drawable: symbols.hasDrawableSymbols, pending: symbols.hasPendingWork, runnable: symbols.hasRunnableWork, zoom: symbols.cameraZoom, lineZoom: symbols._lineView?.cameraZoom, fullReplace: symbols._fullReplaceNeeded, visibleInputs: symbols._visibleInputsDirty, images: symbols._pendingImageEntries.size, opacity: symbols._pendingOpacityHalves.size, dynamic: symbols._pendingDynamicHalves.size, target: scope(symbols._targetPlacement), visible: scope(symbols._visiblePlacement), handoff: scope(symbols._handoffPlacement) },
          };
        }, renderer);
        readiness.push(state);
        return state.ready;
      }, { timeout: 60_000 }).toBe(true);
    }
    finally {
      await writeFile(testInfo.outputPath(`${renderer}-readiness.json`), JSON.stringify(readiness, null, 2));
    }
    const after = renderer === 'cesium'
      ? await page.evaluate(() => window.renderValidation.cityDiagnostics())
      : await page.evaluate(() => window.cityMotion.mapFeatures());
    const commandsAfter = renderer === 'cesium' ? await page.evaluate(() => window.renderValidation.cityCommands()) : undefined;
    await page.screenshot({ path: testInfo.outputPath(`${renderer}-after.png`) });
    results.push({ renderer, cold, motion, before, after, commandsBefore, commandsAfter });
    await writeFile(testInfo.outputPath('station-symbols.json'), JSON.stringify(results, null, 2));
    const video = page.video();
    errors.push(...await page.evaluate(() => window.cityMotion.errors));
    await context.close();
    if (video)
      await video.saveAs(testInfo.outputPath(`${renderer}-motion.webm`));
    expect(errors).toEqual([]);
    expect(before.length).toBeGreaterThan(0);
  }
  await writeFile(testInfo.outputPath('station-symbols.json'), JSON.stringify(results, null, 2));
});
