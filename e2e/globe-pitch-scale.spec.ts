import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });

test('3D camera pitch preserves nearby building visibility and road and text scale', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Near-horizon framebuffer regression requires hardware');
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http') && new URL(url).origin !== new URL(renderUrl).origin) {
      remoteRequests.push(url);
      await route.abort();
    }
    else {
      await route.continue();
    }
  });
  await page.goto(`${renderUrl}/e2e/fixtures/globe-pitch-scale-fixture.html`);
  await expect.poll(() => page.evaluate(() => !!window.globePitchScale)).toBe(true);
  const captures: ReturnType<Window['globePitchScale']['capture']>[] = [];
  for (const pitch of [-6.9, -0.3, -6.9]) {
    await page.evaluate(pitch => window.globePitchScale.setPitch(pitch), pitch);
    await expect.poll(() => page.evaluate(() => window.globePitchScale.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(() => window.globePitchScale.capture()));
    await page.screenshot({ path: testInfo.outputPath(`pitch-${pitch}-${captures.length}.png`) });
  }
  await writeFile(testInfo.outputPath('globe-pitch-scale.json'), JSON.stringify(captures, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, [], 'The regression must use only local GeoJSON and CJK glyphs');
  for (const capture of captures) {
    assert.deepEqual(capture.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu), capture.gpu);
    assert.ok(capture.tilesLoaded);
    assert.ok(Math.abs(capture.height - 263.38) < 1e-6);
    assert.ok(capture.text.count > 8 && capture.road.width > 2, `Positive text and road controls: ${JSON.stringify(capture)}`);
    for (const center of Object.values(capture.centers))
      assert.ok(center.x > 120 && center.x < 1160 && center.y > 120 && center.y < 650, 'Each ground probe must remain isolated inside the viewport');
  }
  const [before, horizon, after] = captures;
  for (const capture of [before, after])
    assert.ok(capture.extrusionDraws > 0 && capture.building.count > 200, 'The downward-pitch positive control must draw the actual blue building');
  assert.ok(horizon.extrusionDraws > 0 && horizon.building.count > 200, 'A nearby building disappeared when only camera pitch approached the horizon');
  for (const control of [before, after]) {
    assert.ok(horizon.road.width / control.road.width < 1.2, `Constant road width enlarged: ${control.road.width}px -> ${horizon.road.width}px`);
    assert.ok(horizon.text.width / control.text.width < 1.2 && horizon.text.height / control.text.height < 1.2, `14px viewport text enlarged: ${JSON.stringify(control.text)} -> ${JSON.stringify(horizon.text)}`);
  }
});
