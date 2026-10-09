import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1 });
test('fixed CV camera horizon widths match the public MapLibre camera API and ignore camera history', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Actual framebuffer comparison requires hardware');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/line-horizon-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.lineHorizon?.ready()), { timeout: 90_000 }).toBe(true);
  const captures = [];
  const capture = async (pitch: number, mode: 'official' | 'ground', label: string) => {
    await page.evaluate(({ pitch, mode }) => window.lineHorizon.setView(pitch, mode), { pitch, mode });
    await expect.poll(() => page.evaluate(() => window.lineHorizon.ready()), { timeout: 60_000 }).toBe(true);
    const result = { label, ...await page.evaluate(() => window.lineHorizon.capture()) };
    captures.push(result);
    const path = testInfo.outputPath(`${label}.png`);
    await page.screenshot({ path });
    await testInfo.attach(label, { path, contentType: 'image/png' });
    return result;
  };
  for (const pitch of [75, 85, 89, 89.9, 90, 89.9, 75])
    await capture(pitch, 'official', `official-${captures.length}-${pitch}`);
  for (const pitch of [75, 85, 89, 89.9])
    await capture(pitch, 'ground', `ground-${pitch}`);
  await capture(75, 'official', 'history-75');
  const from75 = await capture(90, 'official', 'history-75-to-90');
  await capture(89.9, 'official', 'history-89.9');
  const from899 = await capture(90, 'official', 'history-89.9-to-90');
  const path = testInfo.outputPath('line-horizon-widths.json');
  await writeFile(path, JSON.stringify({ pageErrors, captures }, null, 2));
  await testInfo.attach('line-horizon-widths', { path, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  // All qualifications precede behavior assertions: a missing framebuffer or
  // camera mismatch cannot establish this width/history regression.
  for (const item of captures) {
    assert.deepEqual(item.errors, [], item.label);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(item.gpu.native), item.gpu.native);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(item.gpu.reference), item.gpu.reference);
    assert.deepEqual(item.viewport.native, item.viewport.reference);
    assert.equal(item.viewport.native[0], item.viewport.native[2]);
    assert.ok(Math.abs(item.camera.pitch - item.requestedPitch) < 1e-8, `${item.label}: MapLibre must not clamp pitch`);
    assert.ok(Math.abs(item.camera.nativePitch - item.requestedPitch) < 1e-8, `${item.label}: actual Native pitch`);
    assert.ok(Math.abs(item.camera.fov - item.camera.nativeFov) < 1e-8, `${item.label}: actual vertical FOV`);
    assert.ok(Math.abs(Math.atan2(Math.sin(item.camera.nativeHeading), Math.cos(item.camera.nativeHeading))) < 1e-8 && Math.abs(Math.atan2(Math.sin(item.camera.nativeRoll), Math.cos(item.camera.nativeRoll))) < 1e-8 && Math.abs(item.camera.bearing) < 1e-8 && Math.abs(item.camera.roll) < 1e-8, `${item.label}: actual heading and roll`);
    const delta = Math.hypot(item.camera.nativePosition.x - item.camera.referencePosition.x, item.camera.nativePosition.y - item.camera.referencePosition.y, item.camera.nativePosition.z - item.camera.referencePosition.z) * 2 * Math.PI * 6378137;
    assert.ok(delta < 0.005, `${item.label}: actual normalized camera differs by ${delta} projected meters`);
    assert.equal(item.diagnostics.mercatorProjection, true);
    assert.ok(item.diagnostics.sceneRoot.show && item.diagnostics.sceneRoot.length > 0);
    assert.ok(item.diagnostics.lineDraws > 0 && item.pixels.native.count > 10 && item.pixels.reference.count > 10, `${item.label}: real finite GeoJSON lines must draw`);
    assert.ok(item.diagnostics.paint.length > 0 && item.diagnostics.paint.every(paint => paint.width === 10 && paint.surfaceOffset === 0 && Number.isFinite(paint.metersPerPixel) && paint.metersPerPixel > 0));
    const near = item.lines.find(line => line.id === 'north-0')!;
    assert.ok(near.native.bounded && near.reference.bounded && near.native.alphaWidth > 0.5 && near.reference.alphaWidth > 0.5, `${item.label}: near alpha profile must fit canvas ROI and draw`);
    for (const line of item.lines) {
      for (const [native, reference] of [[line.center, line.expected], [line.start, line.referenceStart], [line.end, line.referenceEnd]])
        assert.ok(Math.hypot(native.x - reference.x, native.y - reference.y) < 0.2, `${item.label}/${line.id}: actual same-view finite ground coordinates`);
    }
  }
  for (const item of captures.filter(item => item.requestedPitch <= 85)) {
    const near = item.lines.find(line => line.id === 'north-0')!;
    assert.ok(Math.abs(near.native.alphaWidth - near.reference.alphaWidth) < 0.35, `${item.label}: zero-ground positive control ${near.native.alphaWidth}/${near.reference.alphaWidth}`);
  }
  const failures = captures.filter(item => item.mode === 'official').flatMap((item) => {
    const near = item.lines.find(line => line.id === 'north-0')!;
    return Math.abs(near.native.alphaWidth - near.reference.alphaWidth) >= 0.35 ? [{ label: item.label, native: near.native.alphaWidth, reference: near.reference.alphaWidth, mpp: item.diagnostics.paint[0].metersPerPixel }] : [];
  });
  const mpp75 = from75.diagnostics.paint[0].metersPerPixel;
  const mpp899 = from899.diagnostics.paint[0].metersPerPixel;
  const width75 = from75.lines.find(line => line.id === 'north-0')!.native.alphaWidth;
  const width899 = from899.lines.find(line => line.id === 'north-0')!.native.alphaWidth;
  assert.ok(Math.abs(mpp75 - mpp899) < 1e-8 && Math.abs(width75 - width899) < 0.1 && from75.pixels.native.count === from899.pixels.native.count, `same final horizontal camera depends on history: ${JSON.stringify({ mpp75, mpp899, width75, width899, counts: [from75.pixels.native.count, from899.pixels.native.count] })}`);
  assert.deepEqual(failures, [], `public camera API ground width differs: ${JSON.stringify(failures)}`);
});
