import type { SurfaceCase } from './fixtures/cv-surface-horizon-fixture';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1 });
test('finite CV water and road horizon continuity isolates scene depth and frustum clipping', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Actual framebuffer isolation requires hardware');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/cv-surface-horizon-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon?.ready()), { timeout: 90_000 }).toBe(true);
  const results: Awaited<ReturnType<Window['cvSurfaceHorizon']['capture']>>[] = [];
  const path = testInfo.outputPath('cv-surface-horizon.json');
  const persist = (qualificationFailure?: unknown) => writeFile(path, JSON.stringify({ baseline: process.env.E2E_BASELINE_DIR, pageErrors, geometry: { height: 120, water: [-800, 800, 500, 18000], road: [150, 800, 12000] }, qualificationFailure, results }, null, 2));
  const run = async (configuration: SurfaceCase, label: string) => {
    await page.evaluate(value => window.cvSurfaceHorizon.setCase(value), configuration);
    try {
      await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon.ready()), { timeout: 30_000 }).toBe(true);
    }
    catch (error) {
      await persist({ label, error: String(error), capture: await page.evaluate(() => window.cvSurfaceHorizon.capture()) });
      throw error;
    }
    await page.evaluate(() => window.cvSurfaceHorizon.start());
    await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon.done()), { timeout: 30_000 }).toBe(true);
    const result = await page.evaluate(() => window.cvSurfaceHorizon.capture());
    results.push(result);
    await persist();
    const screenshot = testInfo.outputPath(`${label}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(label, { path: screenshot, contentType: 'image/png' });
    return result;
  };
  for (const pitch of [89, 89.9, 90]) {
    for (const globeDraw of [true, false]) {
      for (const layers of ['water', 'road', 'combined'] as const)
        await run({ layers, globeDraw, pitch }, `${layers}-${pitch}-globe-draw-${globeDraw}`);
    }
  }
  const failures = results.filter(result => result.frames.some(frame => frame.totals.water.missing || frame.totals.road.missing));
  // Depth/log-depth variants are diagnostic responses to actual pixel holes,
  // rather than extra scenarios run without evidence.
  const representatives = [...new Map(failures.map(result => [result.configuration.layers, result])).values()];
  for (const failure of representatives) {
    const original = failure.configuration;
    await run({ ...original, terrainDepth: true }, `terrain-${original.layers}-${original.pitch}-${original.globeDraw}`);
    await run({ ...original, depthTest: false }, `no-depth-${original.layers}-${original.pitch}-${original.globeDraw}`);
    await run({ ...original, depthTest: false, logDepth: false }, `no-log-${original.layers}-${original.pitch}-${original.globeDraw}`);
  }
  await persist();
  await testInfo.attach('cv-surface-horizon', { path, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  for (const result of results) {
    assert.deepEqual(result.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(result.gpu), result.gpu);
    assert.ok(Number.isInteger(result.subpixelBits) && result.subpixelBits >= 0, 'Actual GL rasterizer subpixel precision');
    assert.equal(result.frames.length, 20);
    for (const frame of result.frames) {
      assert.equal(frame.tilesLoaded, true, 'Actual source and Native owners must be loaded');
      assert.equal(frame.sourceGlobeShow, true, 'Source tile authorization must remain live');
      assert.ok(frame.globeDrawAttempts > 0, 'Actual Globe draws must exist before the execution-only isolation');
      assert.equal(frame.globeDrawEnabled, result.configuration.globeDraw);
      assert.equal(frame.globeDraws, result.configuration.globeDraw ? frame.globeDrawAttempts : 0);
      if (result.configuration.layers === 'combined')
        assert.equal(frame.overlayPaired, true, 'Actual road-only framebuffer must match this exact pitch offset, camera, surface height and paint scale');
      assert.equal(frame.surfaceHeights.water, 1, 'Water rays use the actual first-layer radial surface height');
      if (result.configuration.layers !== 'water')
        assert.equal(frame.surfaceHeights.road, 1.01, 'Both road-only and combined draws retain the same second-layer radial surface height');
      assert.equal(frame.viewport[0], frame.viewport[2]);
      assert.equal(frame.viewport[1], frame.viewport[3]);
      assert.ok(Math.abs(frame.pitch - result.configuration.pitch - frame.offset) < 1e-8, 'Actual Native pitch must match the sampled pose');
      assert.ok(Math.abs(frame.camera.position.x - 120) < 1e-8 && Math.abs(frame.camera.position.y) < 1e-8 && Math.abs(frame.camera.position.z) < 1e-8, 'Fixed actual CV projected position');
      assert.ok(Math.abs(Math.atan2(Math.sin(frame.camera.heading), Math.cos(frame.camera.heading))) < 1e-8 && Math.abs(Math.atan2(Math.sin(frame.camera.roll), Math.cos(frame.camera.roll))) < 1e-8);
      assert.ok(frame.frusta.length > 0 && frame.frusta.every(frustum => Number.isFinite(frustum.near) && Number.isFinite(frustum.far) && frustum.far > frustum.near));
      assert.ok(frame.draws.length > 0 && frame.draws.every(draw => draw.bounds && draw.far > draw.near));
      if (result.configuration.pitch === 89 && frame.index === 16 && result.configuration.layers !== 'road') {
        assert.deepEqual(frame.seamDraws.map(draw => draw.canonical.x).sort((a, b) => a - b), [65534, 65535], 'Both actual seam VAs execute at the known hole pose');
        assert.equal(frame.seamProbe?.surfaceHeight, frame.surfaceHeights.water, 'Known pixel ray uses the actual water plane');
        assert.ok(frame.seamProbe?.surface && [frame.seamProbe.surface.x, frame.seamProbe.surface.y, frame.seamProbe.surface.z].every(Number.isFinite));
        for (const { capture } of frame.seamDraws) {
          assert.ok(capture.vertices > 0 && capture.indices.length > 0 && capture.indices.length % 3 === 0);
          assert.ok(capture.indices.every(index => Number.isInteger(index) && index >= 0 && index < capture.vertices));
          assert.equal(capture.projected.length, capture.vertices);
          assert.ok(capture.projected.every(vertex => vertex.height === frame.surfaceHeights.water), 'Read actual packed VA heights without a guessed plane');
          assert.equal(capture.mvp?.length, 16, 'Actual executing FLOAT MVP uniform');
          assert.equal(capture.cameraHigh?.length, 3);
          assert.equal(capture.cameraLow?.length, 3);
          assert.ok(capture.vertexShader.includes('surface_word') && capture.fragmentShader.length > 0);
        }
      }
      for (const kind of ['water', 'road'] as const) {
        if (result.configuration.layers !== 'combined' && result.configuration.layers !== kind)
          continue;
        assert.ok(frame.controls[kind] > 100, `${kind}: actual framebuffer positive control`);
        assert.ok(frame.totals[kind].expected > 100 && frame.totals[kind].rows > 10, `${kind}: finite interior rays must be within actually executed tile/frustum coverage`);
      }
    }
  }
  assert.deepEqual(failures.map(result => ({ configuration: result.configuration, missing: result.frames.reduce((sum, frame) => sum + frame.totals.water.missing + frame.totals.road.missing, 0), first: result.frames.find(frame => frame.totals.water.missing || frame.totals.road.missing)?.index })), [], 'Qualified finite water/road interiors contain actual framebuffer holes; see JSON for exact runs, RGBA and isolated depth/log-depth variants');
});

test('actual CV seam original and paired subdivision controls preserve the production hole', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware' || process.env.E2E_CV_SEAM_CONTROL !== '1', 'Explicit hardware seam causality diagnostic');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/cv-surface-horizon-fixture.html`);
  await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon?.ready()), { timeout: 90_000 }).toBe(true);
  const results: Awaited<ReturnType<Window['cvSurfaceHorizon']['capture']>>[] = [];
  const path = testInfo.outputPath('cv-surface-seam-controls.json');
  const persist = (qualificationFailure?: unknown) => writeFile(path, JSON.stringify({ baseline: process.env.E2E_BASELINE_DIR, pageErrors, qualificationFailure, results }, null, 2));
  const run = async (configuration: SurfaceCase) => {
    await page.evaluate(value => window.cvSurfaceHorizon.setCase(value), configuration);
    try {
      await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon.ready()), { timeout: 30_000 }).toBe(true);
      await page.evaluate(() => window.cvSurfaceHorizon.start());
      await expect.poll(() => page.evaluate(() => window.cvSurfaceHorizon.done()), { timeout: 30_000 }).toBe(true);
    }
    catch (error) {
      await persist({ configuration, error: String(error), capture: await page.evaluate(() => window.cvSurfaceHorizon.capture()) });
      throw error;
    }
    const result = await page.evaluate(() => window.cvSurfaceHorizon.capture());
    results.push(result);
    await persist();
    return result;
  };
  const configuration = { layers: 'water' as const, globeDraw: false, pitch: 89 };
  const original = await run(configuration);
  const paired = await run({ ...configuration, seamSubdivision: true });
  await persist();
  await testInfo.attach('cv-surface-seam-controls', { path, contentType: 'application/json' });
  assert.deepEqual(pageErrors, []);
  for (const result of results) {
    assert.deepEqual(result.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(result.gpu), result.gpu);
    assert.equal(result.subpixelBits, 8, 'Actual rasterizer matches the measured eight-bit seam model');
    assert.equal(result.frames.length, 20);
    for (const frame of result.frames) {
      assert.equal(frame.tilesLoaded, true);
      assert.equal(frame.sourceGlobeShow, true);
      assert.ok(frame.globeDrawAttempts > 0);
      assert.equal(frame.globeDraws, 0);
      assert.equal(frame.useLogDepth, original.frames[frame.index].useLogDepth);
      assert.equal(frame.terrainDepth, original.frames[frame.index].terrainDepth);
      assert.deepEqual(frame.camera, original.frames[frame.index].camera);
      assert.deepEqual(frame.viewport, original.frames[frame.index].viewport);
      assert.deepEqual(frame.surfaceHeights, original.frames[frame.index].surfaceHeights);
      assert.ok(frame.controls.water > 100 && frame.totals.water.expected > 100 && frame.totals.water.rows > 10);
      assert.deepEqual(frame.draws.map(({ kind, tile, depthTest, depthMask, logShader, bounds }) => ({ kind, tile, depthTest, depthMask, logShader, bounds })), original.frames[frame.index].draws.map(({ kind, tile, depthTest, depthMask, logShader, bounds }) => ({ kind, tile, depthTest, depthMask, logShader, bounds })));
    }
  }
  // This diagnostic keeps the real production red visible in its own capture.
  assert.equal(original.frames.reduce((sum, frame) => sum + frame.totals.water.missing, 0), 1);
  assert.deepEqual(original.frames[16].holes.water.map(row => ({ y: row.y, runs: row.runs, colors: row.colors })), [{ y: 578, runs: [[29, 29]], colors: [[29, 0, 0, 0, 255]] }]);
  assert.equal(paired.frames.reduce((sum, frame) => sum + frame.totals.water.missing, 0), 0, 'Paired exact boundary subdivision contains no framebuffer holes');
  for (const frame of paired.frames) {
    assert.deepEqual(frame.totals.water.expected, original.frames[frame.index].totals.water.expected);
    if (frame.index !== 16) {
      assert.equal(frame.seamSubdivision, undefined, 'Only the known frame replaces a VA');
      assert.deepEqual(frame.totals, original.frames[frame.index].totals);
    }
  }
  const frame = paired.frames[16];
  const control = frame.seamSubdivision;
  assert.ok(control);
  assert.equal(control.splitTriangles, 1);
  assert.equal(control.pendingDescriptorsMatch, true, 'Pending right descriptors match its actual executing GL uniforms');
  assert.equal(control.shaderUnchanged, true);
  assert.equal(control.uniformsUnchanged, true);
  assert.equal(control.renderStateUnchanged, true);
  assert.equal(control.ownerUnchanged, true);
  const left = frame.seamDraws.find(draw => draw.canonical.x === 65534)!.capture;
  const right = frame.seamDraws.find(draw => draw.canonical.x === 65535)!.capture;
  const originalRight = original.frames[16].seamDraws.find(draw => draw.canonical.x === 65535)!.capture;
  assert.deepEqual(control.source, originalRight, 'Original source VA and executing uniforms match the independent production capture');
  assert.deepEqual(frame.seamDraws.find(draw => draw.canonical.x === 65534)!.capture, original.frames[16].seamDraws.find(draw => draw.canonical.x === 65534)!.capture, 'The left draw remains unchanged');
  assert.equal(right.vertices, originalRight.vertices + 1);
  assert.equal(right.indices.length, originalRight.indices.length + 3);
  assert.deepEqual(right.projected.slice(0, originalRight.vertices), originalRight.projected);
  const inserted = right.projected.at(-1)!;
  const sourceVertex = left.projected.find(vertex => vertex.vertex === control.inserted.vertex)!;
  assert.deepEqual(inserted.high, sourceVertex.high);
  assert.deepEqual(inserted.low, sourceVertex.low);
  const edge = control.edge.map(index => originalRight.projected[index]);
  assert.ok(edge.every(vertex => vertex.east === inserted.east && vertex.height === inserted.height));
  assert.ok(inserted.north > Math.min(...edge.map(vertex => vertex.north)) && inserted.north < Math.max(...edge.map(vertex => vertex.north)), 'Exact original straight edge is subdivided without shifting its support');
  assert.deepEqual(right.mvp, originalRight.mvp);
  assert.deepEqual(right.cameraHigh, originalRight.cameraHigh);
  assert.deepEqual(right.cameraLow, originalRight.cameraLow);
  assert.deepEqual(right.surfaceWords, originalRight.surfaceWords);
  assert.equal(right.vertexShader, originalRight.vertexShader);
  assert.equal(right.fragmentShader, originalRight.fragmentShader);
  for (const attribute of right.attributes) {
    const previous = originalRight.attributes.find(value => value.name === attribute.name)!;
    assert.deepEqual(attribute.values.slice(0, originalRight.vertices), previous.values);
    assert.equal(attribute.datatype, previous.datatype);
    assert.equal(attribute.normalize, previous.normalize);
    assert.equal(attribute.components, previous.components);
  }
  assert.deepEqual(original.frames[16].seamProbe?.rgba, [0, 0, 0, 255]);
  assert.deepEqual(frame.seamProbe?.rgba, [0, 0, 255, 255]);
});
