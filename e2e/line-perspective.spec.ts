import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1 });

// Distinct public paint branches change the actual cross-road profile:
// a hollow center, a shifted centerline, and a wider alpha falloff.
test('line gap, offset and blur reach the actual framebuffer', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Line paint profiles require hardware');
  await page.goto(`${renderUrl}/e2e/fixtures/line-perspective-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.linePerspective?.ready()), { timeout: 90_000 }).toBe(true);
  const captures = [];
  for (const paint of [{ gap: 8, offset: 0, blur: 0 }, { gap: 0, offset: 12, blur: 0 }, { gap: 0, offset: 0, blur: 4 }]) {
    await page.evaluate(paint => window.linePerspective.setLinePaint(paint), paint);
    await expect.poll(() => page.evaluate(() => window.linePerspective.ready()), { timeout: 60_000 }).toBe(true);
    captures.push({ paint, capture: await page.evaluate(() => window.linePerspective.capture()) });
  }
  await writeFile(testInfo.outputPath('line-paint-profiles.json'), JSON.stringify(captures, null, 2));
  const differences = [];
  for (const { paint, capture } of captures) {
    assert.deepEqual(capture.errors, []);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    const line = capture.lines.find(line => line.id === 'east-1')!;
    assert.ok(Math.hypot(line.center.x - line.expected.x, line.center.y - line.expected.y) < 0.2, 'Actual same-view ground position must qualify');
    const native = line.native.profiles[2].rows;
    const reference = line.reference.profiles[2].rows;
    if (paint.gap || paint.offset)
      assert.ok(reference[120].alpha < 0.05, 'The reference must remove centerline coverage');
    const error = native.reduce((sum, row, index) => sum + Math.abs(row.alpha - reference[index].alpha) * 0.25, 0);
    if (error > 0.3)
      differences.push({ paint, integratedAlphaDifference: error });
  }
  assert.deepEqual(differences, [], 'Line paint is accepted but its independent GPU profile differs');
});

test('ground line width matches actual MapLibre through near and far perspective', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'This pixel comparison requires the actual hardware backend');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/line-perspective-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.linePerspective?.ready()), { timeout: 90_000 }).toBe(true);
  const captures = [];
  for (const pitch of [0, 60, 70]) {
    if (pitch)
      await page.evaluate(pitch => window.linePerspective.setPitch(pitch), pitch);
    await expect.poll(() => page.evaluate(() => window.linePerspective.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(() => window.linePerspective.capture()));
    const screenshot = testInfo.outputPath(`line-perspective-pitch-${pitch}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`line-perspective-pitch-${pitch}`, { path: screenshot, contentType: 'image/png' });
  }
  const output = testInfo.outputPath('line-perspective-widths.json');
  await writeFile(output, JSON.stringify({ pageErrors, captures }, null, 2));
  await testInfo.attach('line-perspective-widths', { path: output, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  // Qualification failures do not establish the projection bug. Both actual
  // hardware renderers must draw visible lines with matching camera geometry.
  for (const capture of captures) {
    assert.deepEqual(capture.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.native), capture.gpu.native);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.reference), capture.gpu.reference);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    assert.equal(capture.viewport.native[0], capture.viewport.native[2]);
    assert.ok(Math.abs(capture.camera.fov - capture.camera.nativeFov) < 1e-6);
    assert.ok(Math.abs(capture.camera.pitch - capture.camera.nativePitch) < 1e-6);
    for (const line of capture.lines) {
      for (const [native, reference] of [[line.center, line.expected], [line.start, line.referenceStart], [line.end, line.referenceEnd]])
        assert.ok(Math.hypot(native.x - reference.x, native.y - reference.y) < 0.2, `${line.id}: same-view projection mismatch`);
      assert.ok(line.native.maximum > 0.7 && line.reference.maximum > 0.7, `${line.id}: line must actually draw`);
      assert.ok(line.center.x > 35 && line.center.x < capture.viewport.native[2] - 35 && line.center.y > 35 && line.center.y < capture.viewport.native[3] - 35, `${line.id}: profile must remain in viewport`);
    }
  }
  const top = captures[0];
  for (const line of top.lines) {
    assert.ok(Math.abs(line.native.alphaWidth - 10) < 0.3, `${line.id}: Native top-view positive control`);
    assert.ok(Math.abs(line.reference.alphaWidth - 10) < 0.3, `${line.id}: MapLibre top-view positive control`);
    assert.ok(Math.abs(line.native.alphaWidth - line.reference.alphaWidth) < 0.3, `${line.id}: top-view parity`);
  }
  const comparisons = captures.slice(1).flatMap(capture => ['east', 'north'].map((direction) => {
    const near = capture.lines.find(line => line.direction === direction && line.depth === 0)!;
    const far = capture.lines.find(line => line.direction === direction && line.depth === 2)!;
    return { pitch: capture.camera.pitch, direction, nativeRatio: far.native.alphaWidth / near.native.alphaWidth, referenceRatio: far.reference.alphaWidth / near.reference.alphaWidth, widths: { native: [near.native.alphaWidth, far.native.alphaWidth], reference: [near.reference.alphaWidth, far.reference.alphaWidth] } };
  }));
  for (const comparison of comparisons)
    assert.ok(comparison.referenceRatio < 0.75, `reference must exhibit actual perspective: ${JSON.stringify(comparison)}`);
  assert.ok(comparisons.every(item => Math.abs(item.nativeRatio - item.referenceRatio) < 0.08), `perspective width differs from MapLibre: ${JSON.stringify(comparisons)}`);
  for (const capture of captures.slice(1)) {
    for (const line of capture.lines)
      assert.ok(Math.abs(line.native.alphaWidth - line.reference.alphaWidth) < 0.35, `${capture.camera.pitch}/${line.id}: absolute projected alpha width must match MapLibre`);
  }
});

// A buffered polygon can have no in-tile fill triangles while its one-pixel
// outline still owns visible pixels. The equatorial edge exercises that case.
test('fill outlines retain tile boundary pixels and match MapLibre under tilt', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'This pixel comparison requires the actual hardware backend');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/line-perspective-fixture.html?outline=1`);
  await expect.poll(() => page.evaluate(() => window.linePerspective?.ready()), { timeout: 90_000 }).toBe(true);
  const captures = [];
  for (const pitch of [0, 60, 70]) {
    await page.evaluate(pitch => window.linePerspective.setPitch(pitch), pitch);
    await expect.poll(() => page.evaluate(() => window.linePerspective.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(() => window.linePerspective.capture()));
    await page.screenshot({ path: testInfo.outputPath(`fill-outline-pitch-${pitch}.png`) });
  }
  await writeFile(testInfo.outputPath('fill-outline-profiles.json'), JSON.stringify({ pageErrors, captures }, null, 2));
  assert.deepEqual(pageErrors, []);
  for (const capture of captures) {
    assert.deepEqual(capture.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.native), capture.gpu.native);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.reference), capture.gpu.reference);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    assert.ok(Math.abs(capture.camera.fov - capture.camera.nativeFov) < 1e-6);
    assert.ok(Math.abs(capture.camera.pitch - capture.camera.nativePitch) < 1e-6);
    for (const line of capture.lines) {
      assert.ok(Math.hypot(line.center.x - line.expected.x, line.center.y - line.expected.y) < 0.2, `${line.id}: same-view projection`);
      assert.ok(line.native.maximum > 0.1 && line.reference.maximum > 0.1, `${capture.camera.pitch}/${line.id}: the source outline must remain visible`);
      assert.ok(Math.abs(line.native.alphaWidth - line.reference.alphaWidth) < 0.05, `${capture.camera.pitch}/${line.id}: composited outline coverage differs from MapLibre`);
    }
  }
});
