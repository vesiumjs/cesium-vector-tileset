import type { PresetAuditStage } from './fixtures/demo-preset-audit';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { demoPresets } from '../src/demo/preset-catalog';
import { test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';
import { createDemoPresetAudit } from './fixtures/demo-preset-audit';

type PresetAudit = Awaited<ReturnType<typeof createDemoPresetAudit>>;
type Snapshot = Awaited<ReturnType<PresetAudit['snapshot']>>;

// Keep real dense-city motion and date-line return as the live acceptance paths.
for (const preset of demoPresets.filter(preset => ['shinjuku', 'dateline'].includes(preset.id))) {
  test(`real ${preset.id} preset loads through zoom, orbit, tilt and return`, { tag: '@live' }, async ({ page, renderUrl }, testInfo) => {
    test.setTimeout(360_000);
    const errors: string[] = [];
    const cleanupErrors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on('pageerror', onError);
    let audit: PresetAudit | undefined;
    const stages: Array<{ name: string; snapshot: Snapshot }> = [];
    const movement: Array<{ name: PresetAuditStage; steps: Snapshot[] }> = [];
    let finalSnapshot: Snapshot | undefined;

    function assertDrawing(snapshot: Snapshot): void {
      assert.ok(snapshot.stats.renderableTiles > 0, `${preset.id}: no renderable tiles`);
      assert.ok(snapshot.stats.submittedCommands > 0, `${preset.id}: no submitted commands`);
      assert.deepEqual(snapshot.alerts, []);
      assert.deepEqual(snapshot.renderErrors, []);
      assert.deepEqual(snapshot.tileErrors, []);
    }

    async function captureStage(name: string): Promise<Snapshot> {
      const screenshot = testInfo.outputPath(`${name}.png`);
      await page.locator('.cesium-widget canvas').screenshot({ path: screenshot });
      await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
      const snapshot = await audit!.snapshot();
      stages.push({ name, snapshot });
      return snapshot;
    }

    try {
      // Captured public responses retain real style, source, glyph and tile
      // content; uncaptured resources are fetched from their real services.
      await routeCityReplay(page.context(), 'capture');
      await page.goto(`${renderUrl}/?${new URLSearchParams({ preset: preset.id })}`);
      await expect(page.getByTestId('preset-select')).toHaveValue(preset.id);
      await expect(page.getByTestId('source-select')).toHaveValue(preset.styleId);
      audit = await createDemoPresetAudit(page);
      await audit.waitLoaded();
      const initial = await captureStage('initial');
      assert.equal(initial.loaded, true);
      assertDrawing(initial);
      assert.ok(Math.abs(initial.camera.longitude - preset.longitude) < 1e-7 && Math.abs(initial.camera.latitude - preset.latitude) < 1e-7, 'demo did not apply the preset location');
      assert.ok(Math.abs(initial.camera.height - preset.height) < 1e-4, 'demo did not apply the preset height');
      assert.ok(Math.abs(initial.camera.pitch - preset.pitch) < 1e-7, 'demo did not apply the preset pitch');
      const angleDistance = (actual: number, expected: number) => Math.abs((actual - expected + 540) % 360 - 180);
      assert.ok(angleDistance(initial.camera.heading, preset.heading) < 1e-7 && angleDistance(initial.camera.roll, preset.roll) < 1e-7, 'demo did not apply the preset heading and roll');
      assert.ok([initial.target.longitude, initial.target.latitude, initial.target.height, initial.target.range].every(Number.isFinite));
      assert.ok(Math.abs(initial.target.longitude) <= 180 && Math.abs(initial.target.latitude) <= 90 && initial.target.range > 0);
      assert.ok(Math.abs(initial.target.height) < 0.01, 'centre target must lie on the ellipsoid');

      let previousFrame = initial.frames;
      let previousPosition = initial.camera.position;
      for (const name of ['zoom-in', 'orbit', 'tilt', 'return'] as const) {
        const steps = await audit.move(name);
        movement.push({ name, steps });
        assert.equal(steps.length, 8);
        for (const snapshot of steps) {
          assert.ok(snapshot.frames > previousFrame, `${preset.id}/${name}: camera step did not render`);
          previousFrame = snapshot.frames;
          const position = snapshot.camera.position;
          assert.ok(Math.hypot(position.x - previousPosition.x, position.y - previousPosition.y, position.z - previousPosition.z) > 1e-3, `${preset.id}/${name}: camera step did not move`);
          previousPosition = position;
          assertDrawing(snapshot);
        }
        // Dynamic frames may still be loading. Only the restored original
        // pose must finish its complete real data workload again.
        if (name === 'return')
          await audit.waitLoaded();
        assertDrawing(await captureStage(name));
      }

      const returned = stages.at(-1)!.snapshot;
      assert.equal(returned.loaded, true);
      assert.ok(returned.frames - initial.frames >= 32, 'all 32 camera steps must produce actual rendered frames');
      assert.ok(returned.returned.positionMeters < 1e-4, 'camera did not return to its original world position');
      assert.ok(returned.returned.direction < 1e-8 && returned.returned.up < 1e-8, 'camera did not return to its original orientation');
      assert.deepEqual(errors, []);
    }
    finally {
      // Drain capture requests before Playwright disposes API responses.
      await page.context().unrouteAll({ behavior: 'wait' });
      if (audit) {
        finalSnapshot = await audit.snapshot().catch((error) => {
          cleanupErrors.push(`Final snapshot: ${String(error)}`);
          return undefined;
        });
      }
      await audit?.dispose().catch(error => cleanupErrors.push(String(error)));
      page.off('pageerror', onError);
      const artifact = testInfo.outputPath('preset-audit.json');
      await writeFile(artifact, JSON.stringify({ preset, stages, movement, finalSnapshot, errors, cleanupErrors }, null, 2));
      await testInfo.attach('preset-audit', { path: artifact, contentType: 'application/json' });
    }
    assert.deepEqual(cleanupErrors, []);
  });
}
