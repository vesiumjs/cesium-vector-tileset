import type { Page, TestInfo } from 'playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
type Capture = ReturnType<Window['globeRenderComparison']['capture']>;

async function waitForReady(page: Page) {
  try {
    await expect.poll(() => page.evaluate(() => window.globeRenderComparison?.ready()), { timeout: 90_000 }).toBe(true);
  }
  catch (error) {
    const status = await page.evaluate(() => window.globeRenderComparison?.status());
    throw new Error(`Actual globe render qualification failed: ${JSON.stringify(status)}`, { cause: error });
  }
}

function qualify(capture: Capture) {
  assert.deepEqual(capture.errors, []);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.native), capture.gpu.native);
  assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu.reference), capture.gpu.reference);
  assert.deepEqual(capture.viewport.native, [640, 720, 640, 720]);
  assert.deepEqual(capture.viewport.native, capture.viewport.reference);
  assert.equal(capture.tilesLoaded, true);
  assert.equal(capture.terrain.reference, null);
  assert.equal(capture.terrain.native, 'EllipsoidTerrainProvider');
  assert.ok(Math.abs(capture.camera.fov - capture.camera.nativeFov) < 1e-8);
  assert.ok(capture.camera.positionError < 0.005, `Actual calibrated camera position differs by ${capture.camera.positionError}m`);
  assert.ok(capture.camera.directionError < 1e-9 && capture.camera.upError < 1e-9, 'Actual camera direction/up must match the reference matrix basis');
  assert.equal(capture.camera.zoom, capture.requestedZoom);
  for (const draw of [...capture.geometry.native, ...capture.geometry.reference])
    assert.deepEqual(draw.errors, [], `${draw.kind}: reading actual geometry must preserve valid GL state`);
  if (capture.pureGlobe) {
    assert.ok(capture.camera.scaleDiagnostic.focusZoom !== undefined && Math.abs(capture.camera.scaleDiagnostic.focusZoom - capture.camera.zoom) < 1e-6, 'Actual ellipsoid focus distance and FOV must independently reconstruct the reference globe zoom');
  }
  for (const kind of ['line', 'circle', 'extrusion', 'symbol']) {
    assert.ok(capture.nativeKinds.includes(kind), `${kind}: Native must issue a real draw`);
    const draws = capture.projection.draws.filter(draw => draw.kind === kind);
    assert.ok(draws.length > 0, `${kind}: actual MapLibre linked-program draws are required`);
    assert.ok(draws.every(draw => draw.globeShader === capture.pureGlobe), `${kind}: actual GLOBE shader define must agree with the tested mode`);
    if (capture.pureGlobe)
      assert.ok(draws.every(draw => draw.transition === 1), `${kind}: real GPU projection transition must equal 1`);
  }
  for (const point of capture.points) {
    assert.ok(point.projectionError < 0.2, `${point.id}: equivalent spherical/ECEF ground projection differs by ${point.projectionError}px`);
    assert.ok(point.native.bounded && point.reference.bounded, `${point.id}: complete actual color masks must fit their common isolated ROI`);
    assert.deepEqual(point.native.grid, point.reference.grid);
    assert.ok(point.native.area > 1 && point.reference.area > 1, `${point.id}: both workers must publish nonzero actual GPU pixels`);
    if (point.id === 'circle' || point.id === 'symbol')
      assert.ok(point.workerAnchorError !== undefined && point.workerAnchorError < 0.2, `${point.id}: actual finite worker anchors differ by ${point.workerAnchorError}px`);
  }
}

function differences(capture: Capture) {
  return capture.points.flatMap((point) => {
    if (point.id === 'extrusion' && capture.building) {
      // Opaque no-MSAA coverage is sampled at pixel centers. A 0.057px
      // WGS84/sphere edge difference can legitimately include two extra rows.
      // Test each model's actual vertex inputs against its own coverage, then
      // compare continuous shape dimensions with the unchanged 0.5px bound.
      const building = capture.building;
      const coverageDimensions = (alpha: number[]) => {
        const columns = new Float64Array(point.native.grid[2]);
        const rows = new Float64Array(point.native.grid[3]);
        for (const [index, value] of alpha.entries()) {
          columns[index % columns.length] = Math.max(columns[index % columns.length], value);
          rows[Math.floor(index / columns.length)] = Math.max(rows[Math.floor(index / columns.length)], value);
        }
        return { width: columns.reduce((sum, value) => sum + value, 0), height: rows.reduce((sum, value) => sum + value, 0), left: columns.findIndex(value => value > 0), right: columns.length - 1 - [...columns].reverse().findIndex(value => value > 0), top: rows.findIndex(value => value > 0), bottom: rows.length - 1 - [...rows].reverse().findIndex(value => value > 0) };
      };
      const nativeExpected = coverageDimensions(building.native.coverage);
      const referenceExpected = coverageDimensions(building.reference.coverage);
      const width = Math.max(Math.abs(building.native.bounds.width - building.reference.bounds.width), Math.abs(point.native.width - nativeExpected.width), Math.abs(point.reference.width - referenceExpected.width));
      const height = Math.max(Math.abs(building.native.bounds.height - building.reference.bounds.height), Math.abs(point.native.height - nativeExpected.height), Math.abs(point.reference.height - referenceExpected.height));
      const nativeActual = coverageDimensions(point.native.alpha);
      const referenceActual = coverageDimensions(point.reference.alpha);
      const position = Math.max(...(['left', 'right', 'top', 'bottom'] as const).flatMap(edge => [Math.abs(nativeActual[edge] - nativeExpected[edge]), Math.abs(referenceActual[edge] - referenceExpected[edge])]));
      const nativeCoverage = point.native.alpha.reduce((sum, value, index) => sum + Math.abs(value - building.native.coverage[index]), 0) / (2 * (point.native.width + point.native.height));
      const referenceCoverage = point.reference.alpha.reduce((sum, value, index) => sum + Math.abs(value - building.reference.coverage[index]), 0) / (2 * (point.reference.width + point.reference.height));
      return width >= 0.5 || height >= 0.5 || position >= 0.5 || nativeCoverage >= 0.5 || referenceCoverage >= 0.5
        ? [{ id: point.id, pitch: capture.camera.pitch, widthError: width, heightError: height, shapeError: Math.max(nativeCoverage, referenceCoverage), positionError: position, native: { area: point.native.area, width: point.native.width, height: point.native.height }, reference: { area: point.reference.area, width: point.reference.width, height: point.reference.height } }]
        : [];
    }
    const shape = point.native.alpha.reduce((sum, value, index) => sum + Math.abs(value - point.reference.alpha[index]), 0) / Math.max(2 * (point.reference.width + point.reference.height), 1);
    const width = Math.abs(point.native.width - point.reference.width);
    const height = Math.abs(point.native.height - point.reference.height);
    return width >= 0.5 || height >= 0.5 || shape >= 0.5
      ? [{ id: point.id, pitch: capture.camera.pitch, widthError: width, heightError: height, shapeError: shape, native: { area: point.native.area, width: point.native.width, height: point.native.height }, reference: { area: point.reference.area, width: point.reference.width, height: point.reference.height } }]
      : [];
  });
}
async function save(page: Page, testInfo: TestInfo, captures: Capture[], errors: string[]) {
  const path = testInfo.outputPath('globe-render-comparison.json');
  await writeFile(path, JSON.stringify({ errors, captures, differences: captures.flatMap(differences) }, null, 2));
  await testInfo.attach('globe-render-comparison', { path, contentType: 'application/json' });
  const png = testInfo.outputPath('globe-render-comparison.png');
  await page.screenshot({ path: png });
  await testInfo.attach('globe-render-comparison', { path: png, contentType: 'image/png' });
}

test('default globe at city zoom actually uses Mercator GPU projection', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Independent actual GPU comparison requires hardware');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/globe-render-comparison-fixture.html?projection=globe`);
  await waitForReady(page);
  const capture = await page.evaluate(() => window.globeRenderComparison.capture());
  await save(page, testInfo, [capture], errors);
  assert.deepEqual(errors, []);
  qualify(capture);
  assert.equal(capture.projection.transformGlobe, false);
  assert.equal(capture.camera.nativeMode, 1);
});

test('actual globe compares extrusion depth against a later style line', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Independent actual GPU comparison requires hardware');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/globe-render-comparison-fixture.html?projection=vertical-perspective&occlusion=1`);
  await waitForReady(page);
  await page.evaluate(() => window.globeRenderComparison.setView(65));
  await waitForReady(page);
  const capture = await page.evaluate(() => window.globeRenderComparison.capture());
  await save(page, testInfo, [capture], errors);
  assert.deepEqual(errors, []);
  qualify(capture);
  assert.equal(capture.occlusion.enabled, true);
  const maximum = Math.max(...capture.occlusion.native.map((value, index) => Math.abs(value - capture.occlusion.reference[index])));
  assert.ok(maximum < 20, `Qualified actual globe depth sample differs by ${maximum}/255: Native ${capture.occlusion.native}, MapLibre ${capture.occlusion.reference}`);
  let requested = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => release = resolve);
  const url = `${renderUrl}/globe-source-replacement.geojson`;
  const data = await page.evaluate(() => window.globeRenderComparison.sourceData);
  await page.route(url, async (route) => {
    requested = true;
    await held;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.evaluate(url => window.globeRenderComparison.beginSourceReplacement(url), url);
  await expect.poll(() => requested).toBe(true);
  try {
    await expect.poll(() => page.evaluate(() => window.globeRenderComparison.nativeDepthSample().frames)).toBeGreaterThan(5);
    const waiting = await page.evaluate(() => window.globeRenderComparison.nativeDepthSample());
    await writeFile(testInfo.outputPath('globe-source-handoff-waiting.json'), JSON.stringify(waiting, null, 2));
    await page.screenshot({ path: testInfo.outputPath('globe-source-handoff-waiting.png') });
    assert.equal(waiting.tilesLoaded, false);
    assert.ok(waiting.kinds.includes('extrusion') && waiting.kinds.includes('line'), 'Actual old retained geometry must still draw during the source handoff');
    assert.ok(waiting.color && waiting.color[0] > 200 && waiting.color[1] < 20 && waiting.color[2] < 20, `Retained old source style/depth must remain red while replacement waits: ${waiting.color}`);
  }
  finally { release!(); }
  await waitForReady(page);
  const replaced = await page.evaluate(() => window.globeRenderComparison.nativeDepthSample());
  assert.ok(replaced.kinds.includes('extrusion') && replaced.kinds.includes('line'));
  assert.ok(replaced.color && replaced.color[0] > 200 && replaced.color[1] < 20 && replaced.color[2] < 20, `Replacement source must preserve the actual style depth: ${replaced.color}`);
  await page.evaluate(() => window.globeRenderComparison.removeNative());
  await expect.poll(() => page.evaluate(() => window.globeRenderComparison.nativeDepthSample().frames)).toBeGreaterThan(5);
  const removed = await page.evaluate(() => window.globeRenderComparison.nativeDepthSample());
  assert.deepEqual(removed.kinds, []);
  assert.deepEqual(removed.color, [0, 0, 0]);
  assert.ok(removed.deletedBuffers > replaced.deletedBuffers, 'Removing the completed handoff must release actual Native GPU buffers');
});

test('automatic globe compares calibrated shapes before its Mercator transition', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Independent actual GPU comparison requires hardware');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${renderUrl}/e2e/fixtures/globe-render-comparison-fixture.html?projection=globe&zoom=11`);
  await waitForReady(page);
  const captures: Capture[] = [];
  for (const pitch of [0, 65]) {
    await page.evaluate(pitch => window.globeRenderComparison.setView(pitch), pitch);
    await waitForReady(page);
    captures.push(await page.evaluate(() => window.globeRenderComparison.capture()));
  }
  await save(page, testInfo, captures, errors);
  assert.deepEqual(errors, []);
  captures.forEach(qualify);
  assert.deepEqual(captures.flatMap(differences), [], 'Qualified automatic globe shapes differ before transition');
});

test('actual globe raster covers both visible polar caps beyond the Mercator limit', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Polar coverage requires actual hardware GPU rendering');
  assert.equal(process.env.E2E_CESIUM_BUILD, 'production', 'Polar coverage requires the production Cesium build');
  test.setTimeout(210_000);
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const image = createCanvas(16, 16);
  const context = image.getContext('2d');
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, 16, 16);
  const png = image.toBuffer('image/png');
  await page.route('**/polar-tiles/**', async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ body: png, contentType: 'image/png' });
  });
  type PolarCapture = ReturnType<Window['polarRaster']['capture']>;
  for (const latitude of [90, -90]) {
    const hemisphere = latitude > 0 ? 'north' : 'south';
    const requestStart = requests.length;
    let capture: PolarCapture | undefined;
    try {
      await page.goto(`${renderUrl}/e2e/fixtures/polar-raster-fixture.html?latitude=${latitude}`);
      await page.waitForFunction(() => window.polarRaster?.ready() || window.polarRaster?.status().errors.length, undefined, { timeout: 90_000 });
      capture = await page.evaluate(() => window.polarRaster.capture());
    }
    finally {
      const status = await page.evaluate(() => window.polarRaster?.status());
      const json = testInfo.outputPath(`polar-raster-${hemisphere}.json`);
      await writeFile(json, JSON.stringify({ latitude, errors, requests: requests.slice(requestStart), status, capture }, null, 2));
      await testInfo.attach(`polar-raster-${hemisphere}`, { path: json, contentType: 'application/json' });
      const screenshot = testInfo.outputPath(`polar-raster-${hemisphere}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`polar-raster-${hemisphere}`, { path: screenshot, contentType: 'image/png' });
    }
    assert.ok(capture, 'Actual post-render capture must exist');
    assert.deepEqual(errors, []);
    assert.deepEqual(capture.errors, []);
    assert.ok(requests.length > requestStart, 'The hemisphere must request the known green raster PNG');
    for (const renderer of ['native', 'reference'] as const)
      assert.ok(!/swiftshader|llvmpipe|lavapipe|software/i.test(capture.gpu[renderer]), capture.gpu[renderer]);
    assert.equal(capture.mode, 3);
    assert.deepEqual(capture.viewport.native, [640, 720, 640, 720]);
    assert.deepEqual(capture.viewport.native, capture.viewport.reference);
    assert.equal(capture.tilesLoaded && capture.sourceLoaded && capture.terrainLoaded && capture.referenceLoaded, true);
    assert.ok(capture.nativeFrames >= 20 && capture.referenceFrames >= 20);
    assert.equal(capture.requestedLatitude, latitude);
    assert.ok(Math.abs(capture.center.lat - Math.sign(latitude) * 85.051129) < 1e-6, 'Record the actual public Map center clamp');
    assert.equal(capture.center.lng, 0);
    assert.equal(capture.camera.referenceZoom, 4);
    assert.ok(Number.isFinite(capture.camera.nativeStyleZoom) && Number.isFinite(capture.camera.styleZoomDifference));
    assert.ok(capture.camera.positionError < 0.005, `Actual camera position differs by ${capture.camera.positionError}m`);
    assert.ok(capture.camera.directionError < 1e-9 && capture.camera.upError < 1e-9);
    assert.ok(Math.abs(capture.camera.nativeFov - capture.camera.referenceFov) < 1e-8);
    assert.equal(capture.camera.referenceFov, 45);
    assert.equal(capture.projection.declared?.type, 'vertical-perspective');
    assert.ok(capture.projection.draws.length > 0, 'Actual linked raster draws must qualify the reference globe branch');
    for (const draw of capture.projection.draws) {
      assert.equal(draw.globe, true);
      assert.equal(draw.transition, 1);
    }
    assert.equal(capture.terrain.nativeEllipsoid, true, 'Native must use an actual EllipsoidTerrainProvider instance');
    assert.equal(capture.terrain.reference, null);
    assert.ok(capture.terrain.rectangles.some(rectangle => latitude > 0
      ? rectangle.south > 85.051129
      : rectangle.north < -85.051129), 'Actual rendered terrain must include a whole rectangle beyond this hemisphere’s Mercator limit');
    assert.ok(capture.rasterTiles.length > 0, 'Native must publish raster owners for the visible cap');
    assert.deepEqual(capture.green, { native: 10_000, reference: 10_000 }, 'The entire central 100×100 ROI must remain green on both actual GPUs');
  }
});

test('actual globe extrusion walls preserve the complete roof and wall color profile across the subdivision grid', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Wall continuity requires actual hardware GPU rendering');
  assert.equal(process.env.E2E_CESIUM_BUILD, 'production', 'Wall continuity requires the production Cesium build');
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  type WallCapture = ReturnType<Window['extrusionWall']['capture']>;
  let capture: WallCapture | undefined;
  try {
    await page.goto(`${renderUrl}/e2e/fixtures/extrusion-wall-fixture.html`);
    await page.waitForFunction(() => window.extrusionWall?.ready() || window.extrusionWall?.status().errors.length, undefined, { timeout: 90_000 });
    capture = await page.evaluate(() => window.extrusionWall.capture());
  }
  finally {
    const status = await page.evaluate(() => window.extrusionWall?.status());
    const json = testInfo.outputPath('extrusion-wall.json');
    await writeFile(json, JSON.stringify({ errors, status, capture }, null, 2));
    await testInfo.attach('extrusion-wall', { path: json, contentType: 'application/json' });
    const screenshot = testInfo.outputPath('extrusion-wall.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('extrusion-wall', { path: screenshot, contentType: 'image/png' });
  }
  assert.ok(capture, 'Actual post-render capture must exist');
  assert.deepEqual(errors, []);
  assert.deepEqual(capture.errors, []);
  for (const renderer of ['native', 'reference'] as const)
    assert.ok(!/swiftshader|llvmpipe|lavapipe|software/i.test(capture.gpu[renderer]), capture.gpu[renderer]);
  assert.equal(capture.mode, 3);
  assert.deepEqual(capture.viewport.native, [640, 720, 640, 720]);
  assert.deepEqual(capture.viewport.native, capture.viewport.reference);
  assert.equal(capture.tilesLoaded && capture.sourceLoaded && capture.terrainLoaded && capture.referenceLoaded, true);
  assert.ok(capture.nativeFrames >= 20 && capture.referenceFrames >= 20);
  assert.deepEqual([capture.center.lng, capture.center.lat], [2.8125, 0]);
  assert.equal(capture.camera.referencePitch, 65);
  assert.equal(capture.camera.referenceBearing, 180);
  assert.equal(capture.camera.referenceZoom, 12.25);
  assert.ok(Math.abs(capture.camera.nativeStyleZoom - capture.camera.referenceZoom) < 1e-6);
  assert.ok(capture.camera.positionError < 0.005, `Actual camera position differs by ${capture.camera.positionError}m`);
  assert.ok(capture.camera.directionError < 1e-9 && capture.camera.upError < 1e-9);
  assert.ok(Math.abs(capture.camera.nativeFov - capture.camera.referenceFov) < 1e-8);
  assert.equal(capture.camera.referenceFov, 45);
  assert.equal(capture.projection.declared?.type, 'vertical-perspective');
  assert.ok(capture.projection.draws.length > 0, 'Actual linked extrusion draws must qualify the reference globe branch');
  for (const draw of capture.projection.draws) {
    assert.equal(draw.globe, true);
    assert.equal(draw.transition, 1);
    assert.ok(draw.tileMercator?.length === 4, 'Actual extrusion tile coordinates must be read from its bound projection uniforms');
  }
  const target = (tile: { z: number; x: number; y: number }) => tile.z === 6 && tile.x === 32 && tile.y === 32;
  assert.ok(capture.source.nativeCanonical.some(tile => target(tile) && tile.buckets.length > 0), 'Native worker must publish the actual source canonical tile 6/32/32');
  assert.ok(capture.source.referenceCanonical.some(target), 'Actual reference extrusion draw must consume source canonical tile 6/32/32');
  assert.equal(capture.terrain.nativeEllipsoid, true);
  assert.equal(capture.terrain.reference, null);
  assert.equal(capture.base, 3000);
  assert.equal(capture.height, 3080);
  assert.ok(capture.silhouette.native > 10_000 && capture.silhouette.reference > 10_000, 'Both actual renderers must produce substantial nonzero extrusion coverage');
  assert.equal(capture.profile.length, 720, 'The acceptance covers every center-column row, including roof, wall and background');
  for (const face of ['roof', 'wall'] as const) {
    assert.ok(capture.faces.rows[face].length > 0, `The actual projected ${face} must include interior pixel rows`);
    for (const y of capture.faces.rows[face]) {
      const sample: WallCapture['profile'][number] = capture.profile.find(value => value.y === y)!;
      assert.ok(sample.reference[1] > 127 && sample.native[1] > 127, `Actual ${face} row ${y} must remain green on both GPUs`);
    }
  }
  const different = capture.profile.filter(row => row.native.some((value, index) => Math.abs(value - row.reference[index]) > 8));
  assert.deepEqual(different, [], 'Every actual center-column RGB sample must differ by at most 8/255; no wall grid crack may be hidden by a whole-frame mask tolerance');
});
