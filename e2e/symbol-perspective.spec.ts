import type { Page, TestInfo } from 'playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1 });
type Capture = ReturnType<Window['symbolPerspective']['capture']>;
function qualify(capture: Capture) {
  assert.deepEqual(capture.errors, []);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.native), capture.gpu.native);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.reference), capture.gpu.reference);
  assert.deepEqual(capture.viewport.native, capture.viewport.reference);
  assert.equal(capture.viewport.native[0], capture.viewport.native[2]);
  assert.ok(Math.abs(capture.camera.pitch - capture.pitch) < 1e-8 && Math.abs(capture.camera.nativePitch - capture.pitch) < 1e-8);
  assert.ok(Math.abs(capture.camera.fov - capture.camera.nativeFov) < 1e-8);
  assert.ok(Math.abs(Math.atan2(Math.sin(capture.camera.nativeHeading), Math.cos(capture.camera.nativeHeading))) < 1e-8 && Math.abs(Math.atan2(Math.sin(capture.camera.nativeRoll), Math.cos(capture.camera.nativeRoll))) < 1e-8 && Math.abs(capture.camera.bearing) < 1e-8 && Math.abs(capture.camera.roll) < 1e-8);
  const delta = Math.hypot(capture.camera.nativePosition.x - capture.camera.referencePosition.x, capture.camera.nativePosition.y - capture.camera.referencePosition.y, capture.camera.nativePosition.z - capture.camera.referencePosition.z) * 2 * Math.PI * 6378137;
  assert.ok(delta < 0.005, `actual normalized camera differs by ${delta} projected meters`);
  assert.ok(capture.draws > 0 && capture.nativeGeometries.length > 0, 'Native real symbol geometries must be drawn');
  for (const point of capture.points)
    assert.ok(Math.hypot(point.center.x - point.expected.x, point.center.y - point.expected.y) < 0.2, `${point.id}: actual same-view ground coordinates`);
}
async function save(testInfo: TestInfo, page: Page, captures: Capture[], name: string) {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(captures, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
  const png = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: png });
  await testInfo.attach(name, { path: png, contentType: 'image/png' });
}

test('actual point icon pixels match MapLibre perspective size and horizon cutoff', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Actual symbol comparison requires hardware');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/symbol-perspective-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.symbolPerspective?.ready()), { timeout: 90_000 }).toBe(true);
  const captures: Capture[] = [];
  for (const pitch of [0, 75, 85, 89, 89.9, 90]) {
    await page.evaluate(pitch => window.symbolPerspective.setView(pitch), pitch);
    await expect.poll(() => page.evaluate(() => window.symbolPerspective.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(() => window.symbolPerspective.capture()));
  }
  // At the identical final pose, force overlap through MapLibre's public API.
  // This proves the ultra-far source/icon can actually draw; viewport symbols
  // use their own clip depth, so ground-anchor far-Z is not a valid oracle.
  await page.evaluate(() => window.symbolPerspective.setReferenceOverlap(true));
  await expect.poll(() => page.evaluate(() => window.symbolPerspective.ready()), { timeout: 60_000 }).toBe(true);
  const cutoffControl = await page.evaluate(() => window.symbolPerspective.capture());
  captures.push(cutoffControl);
  await save(testInfo, page, captures, 'symbol-perspective');
  assert.deepEqual(errors, []);
  captures.forEach(qualify);
  const top = captures[0].points[0];
  assert.ok(top.native.bounded && top.reference.bounded);
  assert.ok(Math.abs(top.native.alphaWidth - 16) < 0.35 && Math.abs(top.reference.alphaWidth - 16) < 0.35, `16px public addImage top control: ${top.native.alphaWidth}/${top.reference.alphaWidth}`);
  const perspectives = captures.slice(1, -1);
  for (const capture of perspectives) {
    const near = capture.points[0];
    assert.ok(near.native.bounded && near.reference.bounded && near.native.area > 50 && near.reference.area > 50);
    assert.ok(near.sourceLoaded, 'actual MapLibre near source must load');
    assert.ok(Math.abs(near.reference.alphaWidth - 16 * near.shaderRatio) < 0.5, `actual MapLibre shader ratio: ${near.reference.alphaWidth}/${near.shaderRatio}`);
  }
  for (const capture of perspectives.filter(capture => capture.pitch >= 89)) {
    assert.equal(capture.points[0].shaderRatio, 4);
    assert.ok(Math.abs(capture.points[0].reference.alphaWidth - 64) < 0.5, 'actual MapLibre must draw its fourfold near icon');
  }
  const cutoff = perspectives.filter(capture => capture.pitch === 90).flatMap(capture => capture.points.filter(point => point.id.startsWith('ultra') && point.rawRatio < 0.6 && point.reference.bounded && point.sourceLoaded).map(point => ({ pitch: capture.pitch, ...point })));
  assert.ok(cutoff.length > 0, 'cutoff needs actual loaded source in the viewport');
  assert.equal(cutoffControl.referenceOverlap, true);
  for (const point of cutoff) {
    const control = cutoffControl.points.find(control => control.id === point.id)!;
    assert.ok(control.sourceLoaded && control.reference.area > 50, 'the same ultra-far icon must actually draw when always-show bypasses cutoff');
  }
  for (const point of cutoff)
    assert.equal(point.reference.area, 0, `actual MapLibre horizon cutoff: ${point.pitch}/${point.id}`);
  const widthFailures = perspectives.flatMap(capture => capture.points.filter(point => point.rawRatio >= 0.6 && point.reference.area > 50 && point.native.bounded && point.reference.bounded && Math.abs(point.native.alphaWidth - point.reference.alphaWidth) >= 0.5).map(point => ({ pitch: capture.pitch, id: point.id, native: point.native.alphaWidth, reference: point.reference.alphaWidth })));
  const cutoffFailures = cutoff.filter(point => point.native.area > 0).map(point => ({ pitch: point.pitch, id: point.id, nativeArea: point.native.area }));
  assert.deepEqual({ widthFailures, cutoffFailures }, { widthFailures: [], cutoffFailures: [] });
});

test('near icon collision matches actual MapLibre raw perspective boxes', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Actual symbol comparison requires hardware');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/symbol-perspective-fixture.html?case=collision`);
  await expect.poll(() => page.evaluate(() => window.symbolPerspective?.ready()), { timeout: 90_000 }).toBe(true);
  await page.evaluate(() => window.symbolPerspective.setView(89));
  await expect.poll(() => page.evaluate(() => window.symbolPerspective.ready()), { timeout: 60_000 }).toBe(true);
  const capture = await page.evaluate(() => window.symbolPerspective.capture());
  await save(testInfo, page, [capture], 'symbol-collision');
  assert.deepEqual(errors, []);
  qualify(capture);
  for (const point of capture.points.slice(0, 2)) {
    assert.ok(point.sourceLoaded && point.rawRatio > 4 && point.shaderRatio === 4, 'collision must exercise the unclamped raw ratio beyond the GPU cap');
  }
  const control = capture.points[2];
  assert.ok(control.native.area > 50 && control.reference.area > 50, 'independent icon must really draw in both renderers');
  assert.ok(capture.pair!.native.bounded && capture.pair!.reference.bounded);
  assert.equal(capture.pair!.reference.components, 1, 'actual MapLibre must place one of the colliding point icons');
  assert.ok(Math.abs(capture.pair!.reference.alphaWidth - 64) < 0.5, 'reference area must contain one icon, rather than two icons merging into one component');
  assert.equal(capture.pair!.native.components, capture.pair!.reference.components, `real point collision differs: ${JSON.stringify({ native: capture.pair!.native, reference: capture.pair!.reference })}`);
});
