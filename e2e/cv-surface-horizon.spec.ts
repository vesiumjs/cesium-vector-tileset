import type { SurfaceCase } from './fixtures/cv-surface-horizon-fixture';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1 });
test('finite CV water and road retain framebuffer coverage through the horizon', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Actual framebuffer isolation requires hardware');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/cv-surface-horizon-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon?.ready()), { timeout: 90_000 }).toBe(true);
  const results: Awaited<ReturnType<Window['cvSurfaceHorizon']['capture']>>[] = [];
  const path = testInfo.outputPath('cv-surface-horizon.json');
  const persist = (qualificationFailure?: unknown) => writeFile(path, JSON.stringify({ baseline: process.env.E2E_BASELINE_DIR, pageErrors, geometry: { height: 120, water: [-800, 800, 500, 18000], road: [150, 800, 12000] }, qualificationFailure, results }, null, 2));
  const run = async (configuration: SurfaceCase, label: string) => {
    await page.evaluate(value => window.cvSurfaceHorizon.setCase(value), configuration);
    try {
      await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon.ready()), { timeout: 30_000 }).toBe(true);
    }
    catch (error) {
      await persist({ label, error: String(error), capture: await page.evaluate(() => window.cvSurfaceHorizon.capture()) });
      throw error;
    }
    await page.evaluate(() => window.cvSurfaceHorizon.start());
    await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon.done()), { timeout: 30_000 }).toBe(true);
    const result = await page.evaluate(() => window.cvSurfaceHorizon.capture());
    results.push(result);
    await persist();
    const screenshot = testInfo.outputPath(`${label}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(label, { path: screenshot, contentType: 'image/png' });
    return result;
  };
  // Capture road controls before combined water/road pixels. Keep the
  // production Globe draw at all horizon pitches without depth isolation runs.
  for (const pitch of [89, 89.9, 90]) {
    await run({ layers: 'road', globeDraw: true, pitch }, `road-${pitch}`);
    await run({ layers: 'combined', globeDraw: true, pitch }, `combined-${pitch}`);
  }
  const failures = results.filter(result => result.frames.some(frame => frame.totals.water.missing || frame.totals.road.missing));
  await persist();
  await testInfo.attach('cv-surface-horizon', { path, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  for (const result of results) {
    assert.deepEqual(result.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(result.gpu), result.gpu);
    assert.ok(Number.isInteger(result.subpixelBits) && result.subpixelBits >= 0, 'Actual GL rasterizer subpixel precision');
    assert.equal(result.frames.length, 20);
    for (const frame of result.frames) {
      assert.equal(frame.tilesLoaded, true, 'Actual source and Native owners must be loaded');
      assert.equal(frame.sourceGlobeShow, true, 'Source tile authorization must remain live');
      assert.ok(frame.globeDrawAttempts > 0, 'Actual Globe draws must exist before the execution-only isolation');
      assert.equal(frame.globeDrawEnabled, result.configuration.globeDraw);
      assert.equal(frame.globeDraws, result.configuration.globeDraw ? frame.globeDrawAttempts : 0);
      if (result.configuration.layers === 'combined')
        assert.equal(frame.overlayPaired, true, 'Actual road-only framebuffer must match this exact pitch offset, camera, surface height and paint scale');
      assert.equal(frame.surfaceHeights.water, 1, 'Water rays use the actual first-layer radial surface height');
      if (result.configuration.layers !== 'water')
        assert.equal(frame.surfaceHeights.road, 1.01, 'Both road-only and combined draws retain the same second-layer radial surface height');
      assert.equal(frame.viewport[0], frame.viewport[2]);
      assert.equal(frame.viewport[1], frame.viewport[3]);
      assert.ok(Math.abs(frame.pitch - result.configuration.pitch - frame.offset) < 1e-8, 'Actual Native pitch must match the sampled pose');
      assert.ok(Math.abs(frame.camera.position.x - 120) < 1e-8 && Math.abs(frame.camera.position.y) < 1e-8 && Math.abs(frame.camera.position.z) < 1e-8, 'Fixed actual CV projected position');
      assert.ok(Math.abs(Math.atan2(Math.sin(frame.camera.heading), Math.cos(frame.camera.heading))) < 1e-8 && Math.abs(Math.atan2(Math.sin(frame.camera.roll), Math.cos(frame.camera.roll))) < 1e-8);
      assert.ok(frame.frusta.length > 0 && frame.frusta.every(frustum => Number.isFinite(frustum.near) && Number.isFinite(frustum.far) && frustum.far > frustum.near));
      assert.ok(frame.draws.length > 0 && frame.draws.every(draw => draw.bounds && draw.far > draw.near));
      for (const kind of ['water', 'road'] as const) {
        if (result.configuration.layers !== 'combined' && result.configuration.layers !== kind)
          continue;
        assert.ok(frame.controls[kind] > 100, `${kind}: actual framebuffer positive control`);
        assert.ok(frame.totals[kind].expected > 100 && frame.totals[kind].rows > 10, `${kind}: finite interior rays must be within actually executed tile/frustum coverage`);
      }
    }
  }
  assert.deepEqual(failures.map(result => ({ configuration: result.configuration, missing: result.frames.reduce((sum, frame) => sum + frame.totals.water.missing + frame.totals.road.missing, 0), first: result.frames.find(frame => frame.totals.water.missing || frame.totals.road.missing)?.index })), [], 'Qualified finite water/road interiors contain actual framebuffer holes; see JSON for exact runs and RGBA');
});
