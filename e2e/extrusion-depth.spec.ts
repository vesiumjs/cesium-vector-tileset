import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1 });
for (const mode of ['cv', 'cv-multiple-frustums', '3d']) {
  const name = mode === '3d' ? 'globe extrusions retain nearest-surface color under the shared physical camera replay' : `translucent extrusions retain only the nearest surface during camera angle and height replay (${mode})`;
  test(name, async ({ page, renderUrl }, testInfo) => {
    test.skip(process.env.E2E_GPU !== 'hardware', 'Nearest-surface proof requires real hardware framebuffers');
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${renderUrl}/e2e/fixtures/extrusion-depth-fixture.html?mode=${mode === '3d' ? '3d' : 'cv'}${mode === 'cv-multiple-frustums' ? '&frustumRatio=2' : ''}`);
    await expect.poll(() => page.evaluate(() => window.extrusionDepth?.ready()), { timeout: 90_000 }).toBe(true);
    const poses = [
      { pitch: 70, height: 180, bearing: 0 },
      { pitch: 71, height: 184, bearing: 1 },
      { pitch: 72, height: 188, bearing: 2 },
      { pitch: 73, height: 192, bearing: 3 },
      { pitch: 72, height: 188, bearing: 2 },
      { pitch: 71, height: 184, bearing: 1 },
      { pitch: 70, height: 180, bearing: 0 },
    ];
    const captures = [];
    const overlaps = [];
    const capture = async (id: string, pose: typeof poses[number], settled = true) => {
      await page.evaluate(pose => window.extrusionDepth.setView(pose), pose);
      await expect.poll(() => page.evaluate(settled => window.extrusionDepth.ready(settled), settled), { timeout: 60_000, intervals: [16, 32, 50] }).toBe(true);
      const result = await page.evaluate(id => window.extrusionDepth.capture(id), id);
      captures.push(result);
      return result;
    };
    // Independently visible buildings prove that the eventual overlap has
    // both actual projected silhouettes, not an absent source or black ROI.
    for (const visibility of ['near', 'far'] as const) {
      await page.evaluate(visibility => window.extrusionDepth.setVisibility(visibility), visibility);
      for (const [index, pose] of poses.entries())
        await capture(`${visibility}-${index}`, pose);
    }
    await page.evaluate(() => window.extrusionDepth.setVisibility('both'));
    await expect.poll(() => page.evaluate(() => window.extrusionDepth.ready()), { timeout: 60_000 }).toBe(true);
    // Read real frames after every changed pose, without waiting for a static
    // camera settle. The last pose returns to the initial physical camera.
    for (const [index, pose] of poses.entries()) {
      await capture(`both-${index}`, pose, false);
      overlaps.push({ index, pose, ...await page.evaluate(index => window.extrusionDepth.compare(`near-${index}`, `far-${index}`, `both-${index}`), index) });
    }
    const screenshot = testInfo.outputPath('nearest-surface-return.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('nearest-surface-return', { path: screenshot, contentType: 'image/png' });
    // Opacity zero is a disappearance control. Opaque rendering is recorded
    // as a diagnostic, not assumed to prove Native depth behavior.
    for (const opacity of [0, 1]) {
      await page.evaluate(opacity => window.extrusionDepth.setVisibility('both', opacity), opacity);
      await capture(`opacity-${opacity}`, poses[0]);
    }
    const path = testInfo.outputPath('extrusion-nearest-surface.json');
    await writeFile(path, JSON.stringify({ pageErrors, captures, overlaps }, null, 2));
    await testInfo.attach('extrusion-nearest-surface', { path, contentType: 'application/json' });
    assert.deepEqual(pageErrors, []);
    // Qualify the physical cameras and actual positive controls before the
    // symptom assertion. A camera mismatch must not count as a GPU RED.
    for (const item of captures) {
      assert.deepEqual(item.errors, [], item.id);
      for (const renderer of ['native', 'reference'] as const)
        assert.ok(!/swiftshader|llvmpipe|software/i.test(item.gpu[renderer]), item.gpu[renderer]);
      assert.deepEqual(item.viewport.native, item.viewport.reference, item.id);
      assert.equal(item.viewport.native[0], item.viewport.native[2]);
      assert.ok(item.frames.native >= 1 && item.frames.reference >= 1);
      const delta = Math.hypot(item.camera.nativePosition.x - item.camera.referencePosition.x, item.camera.nativePosition.y - item.camera.referencePosition.y, item.camera.nativePosition.z - item.camera.referencePosition.z) * 2 * Math.PI * 6378137;
      assert.ok(delta < 0.005, `${item.id}: camera differs by ${delta} projected meters`);
      assert.ok(Math.abs(item.camera.nativePitch - item.pose.pitch) < 1e-8 && Math.abs(item.camera.referencePitch - item.pose.pitch) < 1e-8, item.id);
      assert.ok(Math.abs(item.camera.nativeFov - item.camera.referenceFov) < 1e-8, item.id);
      const heading = Math.atan2(Math.sin((item.camera.nativeHeading - item.camera.referenceBearing) * Math.PI / 180), Math.cos((item.camera.nativeHeading - item.camera.referenceBearing) * Math.PI / 180));
      assert.ok(Math.abs(heading) < 1e-8, item.id);
      for (const ground of item.ground) {
        assert.ok(ground.native, `${item.id}: ground projection must exist`);
        if (mode === '3d') {
          // A WGS84 globe and the flat Mercator reference have different
          // ground geometry. Qualify Native against analytic ECEF projection;
          // the actual globe/flat delta remains recorded in the artifact.
          assert.ok(ground.analytic && Number.isFinite(ground.analytic.x) && Number.isFinite(ground.analytic.y));
          assert.ok(Math.hypot(ground.native.x - ground.analytic.x, ground.native.y - ground.analytic.y) < 1e-6, `${item.id}: actual globe ground differs from analytic ECEF view projection`);
        }
        else {
          assert.ok(Math.hypot(ground.native.x - ground.reference.x, ground.native.y - ground.reference.y) < 0.2, `${item.id}: real zero-ground projection mismatch`);
        }
      }
      if (mode === 'cv-multiple-frustums')
        assert.ok(item.diagnostics.frustums.length > 1, `${item.id}: actual Native depth bins must split`);
    }
    const zero = captures.find(item => item.id === 'opacity-0')!;
    assert.deepEqual(zero.pixels.native, { red: 0, blue: 0 }, 'Native opacity zero');
    assert.deepEqual(zero.pixels.reference, { red: 0, blue: 0 }, 'MapLibre opacity zero');
    for (const item of overlaps) {
      assert.ok(item.count > 100, `pose ${item.index}: both actual independent building silhouettes must overlap in an eroded ROI`);
      for (const renderer of ['native', 'reference'] as const)
        assert.ok(item[renderer].nearRed > 60 && item[renderer].farBlue > 60, `pose ${item.index}/${renderer}: independent visible positive controls`);
      assert.ok(Math.abs(item.reference.blueLeak) < 3, `pose ${item.index}: actual MapLibre nearest-surface reference is unqualified: ${JSON.stringify(item.reference)}`);
      assert.ok(Math.abs(item.reference.red - item.reference.nearRed) < 3, `pose ${item.index}: MapLibre must draw nearest red surface once`);
    }
    const failures = overlaps.filter(item => Math.abs(item.native.blueLeak - item.reference.blueLeak) > 5 || Math.abs(item.native.red - item.reference.red) > 3).map(item => ({ pose: item.pose, native: item.native, reference: item.reference, pixels: item.count }));
    assert.deepEqual(failures, [], `Nearest translucent surface must match actual MapLibre red and exclude hidden far-building blue: ${JSON.stringify(failures)}`);
  });
}

test('coincident translucent extrusion features color their shared nearest surface once', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Coincident-surface proof requires real hardware framebuffers');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/extrusion-depth-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.extrusionDepth?.ready()), { timeout: 90_000 }).toBe(true);
  await page.evaluate(() => window.extrusionDepth.setVisibility('near'));
  await expect.poll(() => page.evaluate(() => window.extrusionDepth.ready()), { timeout: 60_000 }).toBe(true);
  const single = await page.evaluate(() => window.extrusionDepth.capture('single'));
  await page.evaluate(() => window.extrusionDepth.setCoincident());
  await expect.poll(() => page.evaluate(() => window.extrusionDepth.ready()), { timeout: 60_000 }).toBe(true);
  const duplicate = await page.evaluate(() => window.extrusionDepth.capture('duplicate'));
  const pixels = await page.evaluate(() => window.extrusionDepth.compareCoincident('single', 'duplicate'));
  const path = testInfo.outputPath('extrusion-coincident-surface.json');
  await writeFile(path, JSON.stringify({ pageErrors, single, duplicate, pixels }, null, 2));
  await testInfo.attach('extrusion-coincident-surface', { path, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  for (const capture of [single, duplicate]) {
    assert.deepEqual(capture.errors, []);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    for (const renderer of ['native', 'reference'] as const)
      assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu[renderer]), capture.gpu[renderer]);
    const delta = Math.hypot(capture.camera.nativePosition.x - capture.camera.referencePosition.x, capture.camera.nativePosition.y - capture.camera.referencePosition.y, capture.camera.nativePosition.z - capture.camera.referencePosition.z) * 2 * Math.PI * 6378137;
    assert.ok(delta < 0.005, `Actual camera differs by ${delta} projected meters`);
    for (const ground of capture.ground) {
      assert.ok(ground.native);
      assert.ok(Math.hypot(ground.native.x - ground.reference.x, ground.native.y - ground.reference.y) < 0.2);
    }
  }
  assert.ok(pixels.count > 100, 'Actual independently visible nearest surface must fill an eroded ROI');
  assert.ok(pixels.native.single > 60 && pixels.reference.single > 60);
  assert.ok(Math.abs(pixels.reference.duplicate - pixels.reference.single) < 3, 'MapLibre duplicate control must retain single-surface color');
  assert.ok(Math.abs(pixels.native.duplicate - pixels.native.single) < 3, `Coincident features blend the nearest surface repeatedly: ${JSON.stringify(pixels)}`);
  assert.ok(Math.abs(pixels.native.single - pixels.reference.single) < 3 && Math.abs(pixels.native.duplicate - pixels.reference.duplicate) < 3, `Nearest-surface color differs from actual MapLibre: ${JSON.stringify(pixels)}`);
});

test('selected postprocessing includes nearest translucent extrusion Native IDs', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Selected-ID proof requires real hardware framebuffers');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/extrusion-depth-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.extrusionDepth?.ready()), { timeout: 90_000 }).toBe(true);
  const captures = [];
  const controls = [];
  for (const opacity of [1, 0.8]) {
    await page.evaluate(opacity => window.extrusionDepth.setVisibility('near', opacity), opacity);
    await expect.poll(() => page.evaluate(() => window.extrusionDepth.ready()), { timeout: 60_000 }).toBe(true);
    const baseId = `unselected-${opacity}`;
    const selectedId = `selected-${opacity}`;
    captures.push(await page.evaluate(id => window.extrusionDepth.capture(id), baseId));
    const selection = await page.evaluate(id => window.extrusionDepth.selectNear(id), baseId);
    await expect.poll(() => page.evaluate(() => window.extrusionDepth.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(id => window.extrusionDepth.capture(id), selectedId));
    controls.push({ opacity, selection, pixels: await page.evaluate(({ baseId, selectedId }) => window.extrusionDepth.compareSelected(baseId, selectedId), { baseId, selectedId }) });
  }
  const path = testInfo.outputPath('extrusion-selected-id.json');
  await writeFile(path, JSON.stringify({ pageErrors, captures, controls }, null, 2));
  await testInfo.attach('extrusion-selected-id', { path, contentType: 'application/json' });
  const screenshot = testInfo.outputPath('extrusion-selected-id.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('extrusion-selected-id', { path: screenshot, contentType: 'image/png' });
  assert.deepEqual(pageErrors, []);
  for (const capture of captures) {
    assert.deepEqual(capture.errors, [], capture.id);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    for (const renderer of ['native', 'reference'] as const)
      assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu[renderer]), capture.gpu[renderer]);
    const delta = Math.hypot(capture.camera.nativePosition.x - capture.camera.referencePosition.x, capture.camera.nativePosition.y - capture.camera.referencePosition.y, capture.camera.nativePosition.z - capture.camera.referencePosition.z) * 2 * Math.PI * 6378137;
    assert.ok(delta < 0.005, `${capture.id}: actual camera differs by ${delta} projected meters`);
    assert.ok(Math.abs(capture.camera.nativeFov - capture.camera.referenceFov) < 1e-8, capture.id);
    for (const ground of capture.ground) {
      assert.ok(ground.native);
      assert.ok(Math.hypot(ground.native.x - ground.reference.x, ground.native.y - ground.reference.y) < 0.2);
    }
  }
  for (const control of controls) {
    assert.equal(control.selection.picked?.layerId, 'buildings', 'Actual scene.pick must select the independently visible nearest building owner');
    assert.ok(control.selection.ownerSelected && control.selection.pickIdCount > 0);
    assert.ok(control.pixels.count > 100, 'Independently visible nearest building must supply an eroded selection ROI');
  }
  const opaque = controls.find(control => control.opacity === 1)!;
  const translucent = controls.find(control => control.opacity === 0.8)!;
  assert.ok(opaque.pixels.selectedFraction > 0.98, `Opaque actual Native selected-ID positive control failed: ${JSON.stringify(opaque)}`);
  assert.ok(translucent.pixels.selectedFraction > 0.98, `Nearest translucent extrusion is absent from actual Native selected postprocessing: ${JSON.stringify(translucent)}`);
});

test('extrusion color alpha matches actual MapLibre over a white background', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Extrusion color-alpha proof requires real hardware framebuffers');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/extrusion-depth-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.extrusionDepth?.ready()), { timeout: 90_000 }).toBe(true);
  const captures = [];
  for (const setting of [{ id: 'alpha-one', alpha: 1, opacity: 0.8 }, { id: 'alpha-half', alpha: 0.5, opacity: 0.8 }, { id: 'opacity-zero', alpha: 0.5, opacity: 0 }]) {
    await page.evaluate(({ alpha, opacity }) => window.extrusionDepth.setColorAlpha(alpha, opacity), setting);
    await expect.poll(() => page.evaluate(() => window.extrusionDepth.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(id => window.extrusionDepth.capture(id), setting.id));
  }
  const controls = await page.evaluate(() => ({
    opaqueColor: window.extrusionDepth.compareColorAlpha('alpha-one', 'alpha-one'),
    halfColor: window.extrusionDepth.compareColorAlpha('alpha-one', 'alpha-half'),
    zeroOpacity: window.extrusionDepth.compareColorAlpha('alpha-one', 'opacity-zero'),
  }));
  const path = testInfo.outputPath('extrusion-color-alpha.json');
  await writeFile(path, JSON.stringify({ pageErrors, captures, controls }, null, 2));
  await testInfo.attach('extrusion-color-alpha', { path, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  for (const capture of captures) {
    assert.deepEqual(capture.errors, [], capture.id);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    for (const renderer of ['native', 'reference'] as const)
      assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu[renderer]), capture.gpu[renderer]);
    const delta = Math.hypot(capture.camera.nativePosition.x - capture.camera.referencePosition.x, capture.camera.nativePosition.y - capture.camera.referencePosition.y, capture.camera.nativePosition.z - capture.camera.referencePosition.z) * 2 * Math.PI * 6378137;
    assert.ok(delta < 0.005, `${capture.id}: actual camera differs by ${delta} projected meters`);
    assert.ok(Math.abs(capture.camera.nativeFov - capture.camera.referenceFov) < 1e-8, capture.id);
    for (const ground of capture.ground) {
      assert.ok(ground.native);
      assert.ok(Math.hypot(ground.native.x - ground.reference.x, ground.native.y - ground.reference.y) < 0.2);
    }
  }
  for (const control of Object.values(controls)) {
    assert.ok(control.count > 100, 'Both actual red near-building silhouettes must fill the eroded ROI');
    assert.ok(control.backgroundCount > 100, 'An independently sampled real white background must exist');
    for (const renderer of ['native', 'reference'] as const)
      assert.ok(control[renderer].background > 254, `${renderer}: actual framebuffer background must be white`);
  }
  for (const channel of ['red', 'green', 'blue'] as const) {
    assert.ok(Math.abs(controls.opaqueColor.native[channel] - controls.opaqueColor.reference[channel]) < 3, `Alpha-one color positive control differs in ${channel}`);
    for (const renderer of ['native', 'reference'] as const)
      assert.ok(controls.zeroOpacity[renderer][channel] > 254, `${renderer}: layer opacity zero must reveal white background in the building ROI`);
  }
  assert.ok(controls.halfColor.reference.green < 120 && controls.halfColor.reference.green > 20, 'Actual MapLibre half-color control must visibly cover the white background');
  for (const channel of ['red', 'green', 'blue'] as const)
    assert.ok(Math.abs(controls.halfColor.native[channel] - controls.halfColor.reference[channel]) < 3, `Extrusion rgba alpha semantics differ from actual MapLibre over white in ${channel}: ${JSON.stringify(controls.halfColor)}`);
});
