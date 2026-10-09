import type { Page, TestInfo } from 'playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
type Capture = ReturnType<Window['symbolLinePath']['capture']>;
// The one-dimensional alpha transport distance has pixel units, so it uses
// the same half-pixel tolerance as glyph positions. It also catches broken
// corners or a full-screen quad whose glyph centres happen to be correct.
function alphaDistance(actual: number[], expected: number[]) {
  const actualArea = actual.reduce((sum, value) => sum + value, 0);
  const expectedArea = expected.reduce((sum, value) => sum + value, 0);
  if (!(actualArea > 0 && expectedArea > 0))
    return Infinity;
  let actualCumulative = 0;
  let expectedCumulative = 0;
  let distance = 0;
  for (let index = 0; index < actual.length; index++) {
    actualCumulative += actual[index] / actualArea;
    expectedCumulative += expected[index] / expectedArea;
    distance += Math.abs(actualCumulative - expectedCumulative);
  }
  return distance;
}
function qualify(capture: Capture) {
  assert.deepEqual(capture.errors, []);
  assert.ok(!/software|swiftshader|llvmpipe/i.test(capture.gpu.native), capture.gpu.native);
  assert.ok(!/software|swiftshader|llvmpipe/i.test(capture.gpu.reference), capture.gpu.reference);
  const camera = capture.camera;
  assert.ok(Math.abs(camera.nativePitch - camera.pitch) < 1e-8 && Math.abs(camera.pitch - capture.pose.pitch) < 1e-8);
  assert.ok(Math.abs(camera.nativeFov - camera.fov) < 1e-8);
  const headingDelta = (camera.nativeHeading - camera.heading) * Math.PI / 180;
  assert.ok(Math.abs(Math.atan2(Math.sin(headingDelta), Math.cos(headingDelta))) < 1e-8);
  const positionError = Math.hypot(camera.nativePosition.x - camera.referencePosition.x, camera.nativePosition.y - camera.referencePosition.y, camera.nativePosition.z - camera.referencePosition.z) * 2 * Math.PI * 6378137;
  assert.ok(positionError < 0.005, `actual normalized camera error ${positionError}m`);
  assert.ok(camera.nativeDistance! > 0 && Math.abs(camera.nativeZoom - camera.referenceZoom) < 1e-7);
  assert.ok(capture.sourceLoaded && capture.native && capture.reference, 'both real text workers must load the same finite GeoJSON line');
  const native = capture.native!;
  const reference = capture.reference!;
  assert.ok(native.mapPitch && reference.draw?.pitchWithMap && reference.draw.alongLine, 'both actual renderers must use map-pitched along-line text');
  const anchorError = Math.hypot(native.anchor.x - reference.anchor.x, native.anchor.y - reference.anchor.y);
  assert.ok(anchorError < reference.precision, 'the actual worker anchors must coincide');
  assert.ok(native.glyphs.length >= 3 && native.glyphs.length === reference.glyphs.length && reference.gpuVisible, 'actual bound MapLibre VA must contain visible public-font multi-glyph layout');
  assert.equal(reference.lineOffset[1], capture.offsetY * 24);
  assert.ok(native.path.length >= 2 && reference.path.length >= 2);
  for (let glyph = 0; glyph < reference.glyphs.length; glyph++) {
    const target = reference.glyphs[glyph];
    assert.ok(target.screen && target.clip && target.dynamic.every(Number.isFinite), 'actual MapLibre dynamic glyph and clip transforms must exist');
    assert.ok(target.screen.w > 0 && Math.abs(target.screen.depth) < 1 && target.screen.x > 20 && target.screen.x < 620 && target.screen.y > 20 && target.screen.y < 700, 'the actual reference glyph must be visibly inside the viewport and clipping planes');
    assert.ok(target.corners.every(corner => corner.screen.w > 0 && Math.abs(corner.screen.depth) < 1 && corner.screen.x > 0 && corner.screen.x < 640 && corner.screen.y > 0 && corner.screen.y < 720), 'all four actual bound MapLibre glyph corners must remain inside the clipping planes and canvas');
    assert.ok(Math.abs(native.glyphs[glyph].offset - target.offset) < 1e-6, 'worker glyph ordering and offsets must agree before projection');
    assert.ok(native.glyphs[glyph].dynamic.every(Number.isFinite));
  }
  assert.ok(capture.referenceArea > 1, 'the actual downloaded public-font text must draw pixels');
  if (capture.pose.pitch === 0)
    assert.ok(capture.nativeDraws > 0 && capture.nativeArea > 1, 'Native top-view actual font draw is the positive control');
  if (capture.scenario === 'behind' && capture.pose.pitch > 0) {
    assert.ok(reference.path.some(point => point && point.w <= 0) && native.path.some(point => point.w <= 0), 'the unused real worker path must actually cross behind the camera');
  }
}
async function save(page: Page, testInfo: TestInfo, captures: Capture[]) {
  const path = testInfo.outputPath('symbol-line-path.json');
  await writeFile(path, JSON.stringify(captures, null, 2));
  await testInfo.attach('symbol-line-path', { path, contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('symbol-line-path.png') });
}
async function waitReady(page: Page, testInfo: TestInfo) {
  try {
    await expect.poll(() => page.evaluate(() => window.symbolLinePath?.ready()), { timeout: 30_000 }).toBe(true);
  }
  catch (error) {
    const diagnostic = await page.evaluate(() => window.symbolLinePath && { state: window.symbolLinePath.readyState(), snapshot: window.symbolLinePath.capture() });
    const path = testInfo.outputPath('symbol-line-path-readiness.json');
    await writeFile(path, JSON.stringify(diagnostic, null, 2));
    await testInfo.attach('symbol-line-path-readiness', { path, contentType: 'application/json' });
    throw error;
  }
}
for (const scenario of [
  { name: 'keep upright follows actual screen direction during continuous heading and tilt', query: 'scenario=curve&upright=1&offset=0', verticalVisibilityControl: false, poses: [[0, 0], [75, 0], [75, 180], [60, 45], [75, 0]] },
  { name: 'explicit keep upright false preserves reversed multi-glyph ordering', query: 'scenario=curve&upright=0&offset=0', verticalVisibilityControl: false, poses: [[0, 0], [75, 0], [75, 180]] },
  { name: 'Y offset follows the real curved line label plane', query: 'scenario=curve&upright=1&offset=1', verticalVisibilityControl: false, poses: [[0, 0], [75, 0], [60, 45]] },
  { name: 'a visible multi-glyph anchor survives an unused behind-camera endpoint', query: 'scenario=behind&upright=1&offset=0', verticalVisibilityControl: true, poses: [[0, 0], [75, 0], [75, -5], [75, 5], [0, 0]] },
]) {
  test(scenario.name, async ({ page, renderUrl }, testInfo) => {
    test.skip(process.env.E2E_GPU !== 'hardware', 'Actual multi-glyph line comparison requires hardware');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${renderUrl}/e2e/fixtures/symbol-line-path-fixture.html?${scenario.query}`);
    await waitReady(page, testInfo);
    const captures: Capture[] = [];
    for (const [pitch, heading] of scenario.poses) {
      await page.evaluate(([pitch, heading]) => window.symbolLinePath.setView(pitch, heading), [pitch, heading]);
      await waitReady(page, testInfo);
      captures.push(await page.evaluate(() => window.symbolLinePath.capture()));
    }
    await save(page, testInfo, captures);
    assert.deepEqual(errors, []);
    captures.forEach(qualify);
    // At precisely heading 0 this straight leg has only 2.48e-9px horizontal
    // separation. MapLibre's Float64 tile projection and Native's world
    // projection can choose opposite signs for first.x > last.x. Retain that
    // pose as a strict visible-span/alpha-area control, and test glyph
    // identity and reading orientation at both actual adjacent headings.
    // Interior centre sets are not an oracle across the two reading branches:
    // the five asymmetric glyph offsets produce different interior locations.
    const isVerticalControl = (capture: Capture) => scenario.verticalVisibilityControl && capture.pose.pitch === 75 && capture.pose.heading === 0;
    for (const capture of captures.filter(isVerticalControl)) {
      const actual = [...capture.native!.glyphs].sort((a, b) => a.screen.y - b.screen.y);
      const expected = [...capture.reference!.glyphs].sort((a, b) => a.screen.y - b.screen.y);
      for (let glyph = 0; glyph < expected.length; glyph++) {
        assert.notEqual(actual[glyph].dynamic[2], 16, 'the vertical visibility control must draw every glyph');
        const point = actual[glyph].screen;
        assert.ok(Object.values(point).every(Number.isFinite) && point.w > 0 && Math.abs(point.depth) < 1 && point.x > 20 && point.x < 620 && point.y > 20 && point.y < 700, 'all five Native glyphs must remain finite and visibly inside the clipping planes');
      }
      for (const endpoint of [0, expected.length - 1]) {
        assert.ok(Math.hypot(actual[endpoint].screen.x - expected[endpoint].screen.x, actual[endpoint].screen.y - expected[endpoint].screen.y) < 0.5, 'the whole visible centre span endpoints must still match within half a pixel');
      }
      const bounds = capture.nativeCoverage.bounds;
      assert.ok(capture.nativeDraws > 0 && capture.nativeArea > 1 && bounds && bounds.minX > 0 && bounds.maxX < 639 && bounds.minY > 0 && bounds.maxY < 719, 'the vertical control must draw actual bounded font pixels');
    }
    const differences = captures.filter(capture => !isVerticalControl(capture)).flatMap(capture => capture.reference!.glyphs.flatMap((glyph, index) => {
      const actual = capture.native!.glyphs[index];
      const positionError = Math.hypot(actual.screen.x - glyph.screen!.x, actual.screen.y - glyph.screen!.y);
      const angleError = Math.abs(Math.atan2(Math.sin(actual.dynamic[2] - glyph.dynamic[2]), Math.cos(actual.dynamic[2] - glyph.dynamic[2])));
      return actual.dynamic[2] === 16 || positionError >= 0.5 || angleError >= 0.02 ? [{ pose: capture.pose, glyph: index, positionError, angleError, native: actual.screen, reference: glyph.screen, nativeAngle: actual.dynamic[2], referenceAngle: glyph.dynamic[2] }] : [];
    }));
    assert.deepEqual(differences, [], 'actual multi-glyph positions, order, offset and reading orientation must match MapLibre');
    const coverageDifferences = captures.flatMap((capture) => {
      const profile = isVerticalControl(capture) ? undefined : { horizontalError: alphaDistance(capture.nativeCoverage.columns, capture.referenceCoverage.columns), verticalError: alphaDistance(capture.nativeCoverage.rows, capture.referenceCoverage.rows) };
      const bounds = capture.referenceCoverage.bounds!;
      const referenceSpan = Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1);
      const areaWidthError = Math.abs(capture.nativeArea - capture.referenceArea) / referenceSpan;
      return (profile && (profile.horizontalError >= 0.5 || profile.verticalError >= 0.5)) || areaWidthError >= 0.5 ? [{ pose: capture.pose, comparison: isVerticalControl(capture) ? 'vertical visibility and alpha area' : 'glyph identity and alpha shape', ...profile, areaWidthError, nativeArea: capture.nativeArea, referenceArea: capture.referenceArea, nativeBounds: capture.nativeCoverage.bounds, referenceBounds: bounds }] : [];
    });
    assert.deepEqual(coverageDifferences, [], 'actual alpha shape, position and equivalent width must match MapLibre within half a pixel');
  });
}
