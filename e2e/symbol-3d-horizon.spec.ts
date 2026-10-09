import type { TestInfo } from 'playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 640, height: 720 } });
type Capture = ReturnType<Window['symbol3dHorizon']['capture']>;
function qualify(capture: Capture) {
  assert.deepEqual(capture.errors, []);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu), capture.gpu);
  assert.deepEqual(capture.viewport, [640, 720, 640, 720]);
  assert.equal(capture.camera.mode, 3);
  assert.ok(Math.abs(capture.camera.longitude) < 1e-12 && Math.abs(capture.camera.latitude) < 1e-12);
  assert.ok(Math.abs(capture.camera.height - 120) < 1e-6);
  assert.ok(Math.abs(capture.camera.pitch - capture.pitch) < 1e-8);
  assert.ok(Math.abs(capture.camera.fov - 36.875112943) < 1e-8);
  assert.ok(Math.abs(Math.atan2(Math.sin(capture.camera.heading), Math.cos(capture.camera.heading))) < 1e-8 && Math.abs(Math.atan2(Math.sin(capture.camera.roll), Math.cos(capture.camera.roll))) < 1e-8);
  assert.ok(capture.camera.rayOriginError < 1e-8 && capture.camera.rayDirectionError < 1e-8);
  assert.ok(capture.tilesLoaded);
  for (const point of capture.points) {
    assert.ok(point.sourceLoaded, `${point.id}: actual worker geometry must remain loaded`);
    assert.ok(point.nonoccluded && point.w > 0 && point.pixels.bounded, `${point.id}: actual ground anchor must be in front, unoccluded and isolated inside the viewport`);
  }
  assert.ok(Math.abs(capture.points[0].center.y - capture.points[1].center.y) > 80, 'point alpha ROIs must not overlap');
}
async function attach(testInfo: TestInfo, captures: Capture[]) {
  const path = testInfo.outputPath('symbol-3d-horizon.json');
  await writeFile(path, JSON.stringify(captures, null, 2));
  await testInfo.attach('symbol-3d-horizon', { path, contentType: 'application/json' });
}

test('visible 3D ground point icons survive a missing center ellipsoid ray', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Actual 3D symbol regression requires hardware');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/symbol-3d-horizon-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.symbol3dHorizon?.ready()), { timeout: 90_000 }).toBe(true);
  const captures: Capture[] = [];
  for (const pitch of [-1, -0.1, -1]) {
    await page.evaluate(pitch => window.symbol3dHorizon.setView(pitch), pitch);
    await expect.poll(() => page.evaluate(() => window.symbol3dHorizon.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(() => window.symbol3dHorizon.capture()));
    await page.screenshot({ path: testInfo.outputPath(`pitch-${pitch}-${captures.length}.png`) });
  }
  await attach(testInfo, captures);
  assert.deepEqual(errors, []);
  captures.forEach(qualify);
  for (const control of [captures[0], captures[2]]) {
    assert.ok(control.camera.centerIntersection && control.camera.centerIntersection.start > 0);
    assert.ok(control.camera.focusDistance! > 0 && control.draws > 0);
    for (const point of control.points)
      assert.ok(point.pixels.area > 50, `${point.id}: ground-hit positive control must really draw`);
  }
  const horizon = captures[1];
  assert.equal(horizon.camera.centerIntersection, undefined, 'actual center ray must miss the ellipsoid');
  for (const point of horizon.points)
    assert.ok(point.pixels.area > 50, `${point.id}: loaded, unoccluded ground icon disappeared when only the center ray missed: ${JSON.stringify(point)}`);
});
