import type { Page, TestInfo } from 'playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
type Capture = ReturnType<Window['symbolMapPerspective']['capture']>;

function qualify(capture: Capture) {
  assert.deepEqual(capture.errors, []);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.native), capture.gpu.native);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.reference), capture.gpu.reference);
  assert.deepEqual(capture.viewport.native, [640, 720, 640, 720]);
  assert.deepEqual(capture.viewport.native, capture.viewport.reference);
  assert.equal(capture.tilesLoaded, true);
  assert.ok(capture.sourceGeometryTypes.length > 0 && capture.sourceGeometryTypes.every(type => type === 'Point'), 'Public reference source must contain actual finite GeoJSON POINT features');
  assert.ok(Math.abs(capture.camera.pitch - capture.pitch) < 1e-8 && Math.abs(capture.camera.nativePitch - capture.pitch) < 1e-8);
  assert.ok(Math.abs(capture.camera.fov - capture.camera.nativeFov) < 1e-8);
  const bearing = capture.pitch === 0 ? 0 : capture.requestedBearing;
  assert.ok(Math.abs(Math.atan2(Math.sin(capture.camera.nativeHeading - bearing * Math.PI / 180), Math.cos(capture.camera.nativeHeading - bearing * Math.PI / 180))) < 1e-8);
  assert.ok(Math.abs(Math.atan2(Math.sin(capture.camera.nativeRoll), Math.cos(capture.camera.nativeRoll))) < 1e-8);
  assert.ok(Math.abs(capture.camera.bearing - bearing) < 1e-8 && Math.abs(capture.camera.roll) < 1e-8);
  const delta = Math.hypot(capture.camera.nativePosition.x - capture.camera.referencePosition.x, capture.camera.nativePosition.y - capture.camera.referencePosition.y, capture.camera.nativePosition.z - capture.camera.referencePosition.z) * 2 * Math.PI * 6378137;
  assert.ok(delta < 0.005, `actual normalized camera differs by ${delta} projected meters`);
  assert.ok(capture.camera.nativeDistance! > 0 && capture.camera.referenceDistance > 0);
  assert.equal(capture.alignment, 'map');
  assert.equal(capture.resolvedAlignment, 'map');
  assert.equal(capture.resolvedRotation, capture.rotation);
  assert.equal(capture.referenceOverlap, true);
  assert.equal(capture.referenceImageSdf, false);
  assert.ok(capture.referenceDraws.length > 0 && capture.referenceDraws.every(draw => !draw.alongLine && draw.pitchWithMap && !draw.rotateSymbol), 'Actual MapLibre point-map draws must expose u_is_along_line=0, u_pitch_with_map=1 and u_rotate_symbol=0');
  assert.ok(capture.draws > 0 && capture.drawnTiles.length > 0, 'Native must submit actual point icon draw commands');
  const points = capture.pitch === 0 ? capture.points.slice(0, 1) : capture.points;
  for (const point of points) {
    assert.ok(point.sourceLoaded && point.native && point.reference, `${point.id}: real finite point worker anchors must load in both renderers`);
    const native = point.native!;
    const reference = point.reference!;
    assert.equal(native.alongLine, false);
    assert.equal(native.lineLength, 0);
    assert.ok(native.opacity > 0 && native.drawnTile);
    assert.equal(native.sdf, false);
    assert.equal(native.vertexSdf, false);
    assert.equal(reference.sdf, false);
    assert.ok(reference.glyphs === 1 && reference.lineLength <= 1 && reference.hasVisibleVertices && !reference.hidden, `${point.id}: actual MapLibre point icon worker and visible quad`);
    assert.ok(native.dynamic.length === 3 && native.dynamic.every(Number.isFinite));
    assert.ok(reference.dynamic.length === 3 && reference.dynamic.every(Number.isFinite));
    assert.equal(reference.glyphOffset, 0);
    assert.deepEqual(reference.lineOffset, [0, 0]);
    assert.ok(Number.isFinite(native.w) && native.w > 0 && Number.isFinite(reference.w) && reference.w > 0, `${point.id}: actual finite positive clipW`);
    for (const [renderer, corners] of [['native', native.clipCorners], ['reference', reference.clipCorners]] as const) {
      assert.ok(corners?.length === 4, `${point.id}/${renderer}: actual submitted four-corner draw inputs are required`);
      assert.ok(corners.every(clip => clip.every(Number.isFinite) && clip[3] > 0 && Math.abs(clip[0]) < clip[3] && Math.abs(clip[1]) < clip[3] && Math.abs(clip[2]) < clip[3]), `${point.id}/${renderer}: every actual corner must remain inside finite near/far and XY clip planes`);
    }
    assert.ok(Math.abs(native.w - reference.wMeters) < (native.precision + reference.precision) * 2 * Math.PI * 6378137, `${point.id}: physical clipW must match within actual worker anchor quantization`);
    assert.ok(native.pixels.bounded && reference.pixels.bounded, `${point.id}: both complete alpha masks must stay inside their isolated ROIs`);
    assert.ok(Math.hypot(native.center.x - reference.expected.x, native.center.y - reference.expected.y) < 0.2, `${point.id}: actual worker anchors and screen coordinates must match`);
    assert.deepEqual(native.pixels.grid, reference.pixels.grid);
    assert.ok(native.pixels.alpha.every(Number.isFinite) && reference.pixels.alpha.every(Number.isFinite));
  }
  for (let first = 0; first < points.length; first++) {
    for (let second = first + 1; second < points.length; second++) {
      for (const renderer of ['native', 'reference'] as const) {
        const a = points[first][renderer]!.pixels.bounds;
        const b = points[second][renderer]!.pixels.bounds;
        assert.ok(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0, `${renderer}: actual alpha ROIs must remain isolated`);
      }
    }
  }
  assert.ok(points[0].reference!.pixels.area > 0.25, 'Actual MapLibre near point-map icon must draw; subpixel far zero coverage remains an actual result');
}

async function save(testInfo: TestInfo, page: Page, captures: Capture[], pageErrors: string[]) {
  const path = testInfo.outputPath('symbol-map-perspective.json');
  await writeFile(path, JSON.stringify({ pageErrors, captures }, null, 2));
  await testInfo.attach('symbol-map-perspective', { path, contentType: 'application/json' });
  const png = testInfo.outputPath('symbol-map-perspective.png');
  await page.screenshot({ path: png });
  await testInfo.attach('symbol-map-perspective', { path: png, contentType: 'image/png' });
}

// The zero-pitch control already uses bearing zero; tilted views exercise rotation.
const bearing = 35;
for (const rotation of ['map'] as const) {
  test(`actual opaque point icon map pitch and ${rotation} rotation at bearing ${bearing} match MapLibre perspective shape`, async ({ page, renderUrl }, testInfo) => {
    test.skip(process.env.E2E_GPU !== 'hardware', 'Actual point-map symbol comparison requires hardware');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${renderUrl}/e2e/fixtures/symbol-map-perspective-fixture.html?rotation=${rotation}&bearing=${bearing}`);
    await expect.poll(() => page.evaluate(() => window.symbolMapPerspective?.ready()), { timeout: 90_000 }).toBe(true);
    const captures: Capture[] = [];
    for (const pitch of [0, 75, 85, 89]) {
      await page.evaluate(pitch => window.symbolMapPerspective.setView(pitch), pitch);
      await expect.poll(() => page.evaluate(() => window.symbolMapPerspective.ready()), { timeout: 60_000 }).toBe(true);
      captures.push(await page.evaluate(() => window.symbolMapPerspective.capture()));
    }
    await save(testInfo, page, captures, errors);
    assert.deepEqual(errors, []);
    captures.forEach(qualify);
    const top = captures[0].points[0];
    for (const renderer of ['native', 'reference'] as const) {
      const pixels = top[renderer]!.pixels;
      assert.ok(Math.abs(pixels.width - 16) < 0.35 && Math.abs(pixels.height - 16) < 0.35, `${renderer}: original 16px public addImage top-view width and height control ${pixels.width}/${pixels.height}`);
    }
    const failures = captures.slice(1).flatMap(capture => capture.points.flatMap((point) => {
      const native = point.native!.pixels;
      const reference = point.reference!.pixels;
      // The L1 difference uses the complete actual 2D alpha masks. Dividing
      // by the measured reference perimeter expresses shape error in pixels,
      // independently of projected width/height and without scale calibration.
      const shape = native.alpha.reduce((sum, alpha, index) => sum + Math.abs(alpha - reference.alpha[index]), 0) / Math.max(2 * (reference.width + reference.height), 1);
      const width = Math.abs(native.width - reference.width);
      const height = Math.abs(native.height - reference.height);
      return width >= 0.5 || height >= 0.5 || shape >= 0.5
        ? [{ pitch: capture.pitch, id: point.id, widthError: width, heightError: height, shapeError: shape, native: { width: native.width, height: native.height, area: native.area }, reference: { width: reference.width, height: reference.height, area: reference.area } }]
        : [];
    }));
    assert.deepEqual(failures, [], 'Actual point-map icon width, height or full alpha shape differs from the independent MapLibre reference');
  });
}
