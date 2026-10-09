import type { Page, TestInfo } from 'playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
type Capture = ReturnType<Window['symbolLinePerspective']['capture']>;
const qualifiedPoints = (capture: Capture) => capture.pitch === 0 ? capture.points.slice(0, 1) : capture.points;
function qualify(capture: Capture) {
  assert.deepEqual(capture.errors, []);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.native), capture.gpu.native);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.reference), capture.gpu.reference);
  assert.deepEqual(capture.viewport.native, [640, 720, 640, 720]);
  assert.deepEqual(capture.viewport.native, capture.viewport.reference);
  assert.ok(Math.abs(capture.camera.pitch - capture.pitch) < 1e-8 && Math.abs(capture.camera.nativePitch - capture.pitch) < 1e-8);
  assert.ok(Math.abs(capture.camera.fov - capture.camera.nativeFov) < 1e-8);
  assert.ok(Math.abs(Math.atan2(Math.sin(capture.camera.nativeHeading), Math.cos(capture.camera.nativeHeading))) < 1e-8 && Math.abs(Math.atan2(Math.sin(capture.camera.nativeRoll), Math.cos(capture.camera.nativeRoll))) < 1e-8 && Math.abs(capture.camera.bearing) < 1e-8 && Math.abs(capture.camera.roll) < 1e-8);
  const delta = Math.hypot(capture.camera.nativePosition.x - capture.camera.referencePosition.x, capture.camera.nativePosition.y - capture.camera.referencePosition.y, capture.camera.nativePosition.z - capture.camera.referencePosition.z) * 2 * Math.PI * 6378137;
  assert.ok(delta < 0.005, `actual normalized camera differs by ${delta} projected meters`);
  assert.ok(capture.camera.nativeDistance! > 0 && capture.camera.referenceDistance > 0);
  assert.equal(capture.resolvedAlignment, capture.alignment === 'viewport' ? 'viewport' : 'map');
  assert.equal(capture.resolvedRotation, 'map');
  assert.equal(capture.referenceOverlap, true);
  assert.ok(capture.referenceDraws.some(draw => draw.alongLine && draw.pitchWithMap === (capture.resolvedAlignment === 'map')), 'actual MapLibre draw must use the along-line and requested pitch shader uniforms');
  assert.ok(capture.draws > 0 && capture.drawnTiles.length > 0, 'Native must submit actual line icon draw commands');
  const points = qualifiedPoints(capture);
  for (const point of points) {
    assert.ok(point.sourceLoaded && point.native && point.reference, `${point.id}: real worker anchors must load in both renderers`);
    const native = point.native!;
    const reference = point.reference!;
    assert.equal(native.sdf, capture.sdf);
    assert.equal(native.vertexSdf, capture.sdf);
    assert.equal(reference.sdf, capture.sdf);
    assert.equal(capture.referenceImageSdf, capture.sdf);
    assert.ok(native.alongLine && native.glyphs === 1 && native.lineLength >= 6 && native.opacity > 0, `${point.id}: actual Native line icon path and visibility`);
    assert.ok(reference.glyphs === 1 && reference.lineLength >= 2 && reference.lineVertexCount >= 2 && reference.hasVisibleVertices, `${point.id}: actual MapLibre along-line icon draw inputs`);
    assert.ok(native.dynamic.length === 3 && native.dynamic.every(Number.isFinite) && native.dynamic[2] !== 16);
    assert.ok(reference.dynamic.length === 3 && reference.dynamic.every(Number.isFinite));
    assert.ok(native.w > 0 && reference.w > 0 && native.pixels.bounded && reference.pixels.bounded);
    assert.ok(native.corners.length === 4 && reference.corners?.length === 4, `${point.id}: actual drawn quad corners must be available`);
    for (const renderer of [native, reference]) {
      assert.ok(renderer.corners!.every(corner => corner.every(Number.isFinite) && corner[3] > 0 && Math.abs(corner[2]) < corner[3]), `${point.id}: all actual quad corners must lie inside both near and far clipping planes`);
    }
    assert.equal(reference.glyphOffset, 0);
    assert.deepEqual(reference.lineOffset, [0, 0]);
    if (capture.resolvedAlignment === 'viewport')
      assert.ok(Math.hypot(reference.dynamic[0] - reference.expected.x, reference.dynamic[1] - reference.expected.y) < 0.2, `${point.id}: MapLibre's real projected glyph must coincide with its zero-offset anchor`);
    assert.ok(Math.hypot(native.center.x - reference.expected.x, native.center.y - reference.expected.y) < 0.2, `${point.id}: actual worker anchors and screen coordinates must match`);
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
  // Ground-aligned subpixel quads can legitimately rasterize no far pixels.
  // A loaded finite dynamic path and a near icon pixel positive qualify that
  // reference; the zero must remain an actual result, never a fake width.
  assert.ok(points[0].reference!.pixels.area > 0.25, 'the actual MapLibre line icon family must really draw');
}
async function save(testInfo: TestInfo, page: Page, captures: Capture[]) {
  const path = testInfo.outputPath('symbol-line-perspective.json');
  await writeFile(path, JSON.stringify(captures, null, 2));
  await testInfo.attach('symbol-line-perspective', { path, contentType: 'application/json' });
  const png = testInfo.outputPath('symbol-line-perspective.png');
  await page.screenshot({ path: png });
  await testInfo.attach('symbol-line-perspective', { path: png, contentType: 'image/png' });
}

for (const { alignment, sdf } of [{ alignment: 'map', sdf: true }] as const) {
  test(`actual ${sdf ? 'SDF' : 'opaque'} line icon ${alignment} pitch alignment matches MapLibre perspective pixels`, async ({ page, renderUrl }, testInfo) => {
    test.skip(process.env.E2E_GPU !== 'hardware', 'Actual line symbol comparison requires hardware');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${renderUrl}/e2e/fixtures/symbol-line-perspective-fixture.html?alignment=${alignment}&sdf=${sdf ? 1 : 0}`);
    await expect.poll(() => page.evaluate(() => window.symbolLinePerspective?.ready()), { timeout: 90_000 }).toBe(true);
    const captures: Capture[] = [];
    for (const pitch of [0, 75, 85, 89]) {
      await page.evaluate(pitch => window.symbolLinePerspective.setView(pitch), pitch);
      await expect.poll(() => page.evaluate(() => window.symbolLinePerspective.ready()), { timeout: 60_000 }).toBe(true);
      captures.push(await page.evaluate(() => window.symbolLinePerspective.capture()));
    }
    await save(testInfo, page, captures);
    assert.deepEqual(errors, []);
    captures.forEach(qualify);
    const top = captures[0].points[0];
    if (sdf) {
      assert.ok(top.native!.pixels.area > 16 && top.reference!.pixels.area > 16, 'both real SDF atlas families must draw the top circle');
      assert.ok(Math.abs(top.native!.pixels.alphaEquivalentSide - top.reference!.pixels.alphaEquivalentSide) < 0.5, 'the actual SDF top-view alpha control must agree');
    }
    else {
      assert.ok(Math.abs(top.native!.pixels.alphaEquivalentSide - 16) < 0.35 && Math.abs(top.reference!.pixels.alphaEquivalentSide - 16) < 0.35, `16px public image control ${top.native!.pixels.alphaEquivalentSide}/${top.reference!.pixels.alphaEquivalentSide}`);
    }
    const failures = (sdf ? captures : captures.slice(1)).flatMap(capture => qualifiedPoints(capture).filter(point => Math.abs(point.native!.pixels.alphaEquivalentSide - point.reference!.pixels.alphaEquivalentSide) >= 0.5 || Math.abs(point.native!.pixels.horizontalIntegral - point.reference!.pixels.horizontalIntegral) >= 0.5 || Math.abs(point.native!.pixels.verticalIntegral - point.reference!.pixels.verticalIntegral) >= 0.5).map(point => ({ pitch: capture.pitch, id: point.id, native: { area: point.native!.pixels.area, width: point.native!.pixels.horizontalIntegral, height: point.native!.pixels.verticalIntegral }, reference: { area: point.reference!.pixels.area, width: point.reference!.pixels.horizontalIntegral, height: point.reference!.pixels.verticalIntegral } })));
    assert.deepEqual(failures, [], 'actual line icon alpha area, width or height differs; the ground quad shape must match, not just one scale');
  });
}
