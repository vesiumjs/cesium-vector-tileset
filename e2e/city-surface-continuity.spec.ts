import type { BrowserContext } from 'playwright/test';
import type { CityPose } from './fixtures/city-motion-adapter';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';

type SurfaceSnapshot = ReturnType<NonNullable<Window['citySurfaceContinuity']>['snapshot']>;
type SurfaceFrame = SurfaceSnapshot['frames'][number];

test('same-pose real-city water continuity @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_CITY_SURFACE_CONTINUITY !== '1', 'Opt-in water continuity diagnosis; excludes timing claims');
  test.setTimeout(180_000);
  expect(process.env.E2E_GPU, 'Run this diagnosis on the actual hardware backend').toBe('hardware');
  expect(process.env.E2E_CITY_LIBRARY_DIR, 'Use the published frozen library under investigation').toBeTruthy();
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  const builds = { library: process.env.E2E_CITY_LIBRARY_DIR, sourceBaseline: process.env.E2E_BASELINE_DIR, cesium: process.env.E2E_CESIUM_BUILD, gpu: process.env.E2E_GPU };
  let initial: CityPose | undefined;
  let poses: CityPose[] = [];
  const coordinate: [number, number] = [-0.12, 51.507];
  let nativeInitial: SurfaceSnapshot | undefined;
  let mapInitial: SurfaceSnapshot | undefined;
  let confirmation: ReturnType<NonNullable<Window['citySurfaceContinuity']>['riverPoint']>;
  let native: SurfaceSnapshot | undefined;
  let reference: SurfaceSnapshot | undefined;
  let comparison: Array<{ poseIndex: number; pose: CityPose; supported: boolean; riverProjectionError: number; nativeFrames: SurfaceFrame[]; mapFrames: SurfaceFrame[]; missing: boolean }> | undefined;
  try {
    const nativeContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    contexts.push(nativeContext);
    await routeCityReplay(nativeContext, 'replay');
    const nativePage = await nativeContext.newPage();
    nativePage.on('pageerror', error => errors.push(`cesium: ${error.message}`));
    const query = new URLSearchParams({ cityPerf: '1', citySurfaceContinuity: '1', motionBaseline: '1', readback: '0', cityProjection: '1', view: 'london', scale: '0.5', antialias: '0', published: '1', publishedUrl: `${renderUrl}/@fs/${path.resolve(process.env.E2E_CITY_LIBRARY_DIR!)}/index.mjs` });
    if (process.env.E2E_CITY_SURFACE_OWNERS === '1')
      query.set('citySurfaceOwners', '1');
    await nativePage.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => nativePage.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 90_000 }).toBe(true);
    initial = await nativePage.evaluate(() => window.cityMotion.initial);
    poses = await nativePage.evaluate(() => window.cityMotion.generate());
    expect(poses).toHaveLength(109);
    nativeInitial = await nativePage.evaluate(async (coordinate) => {
      const scene = window.renderValidation.viewer.scene;
      const rendered = new Promise<void>((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
      });
      window.citySurfaceContinuity!.setCoordinate(coordinate);
      await rendered;
      return window.citySurfaceContinuity!.snapshot();
    }, coordinate);
    await writeFile(testInfo.outputPath('city-surface-initial.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, builds, initial, poses, coordinate, native: nativeInitial }, null, 2));
    expect(nativeInitial.frames.filter(frame => frame.sampled)).toHaveLength(1);
    expect(nativeInitial.frames.some(frame => frame.sampled && frame.roi !== undefined && frame.roi.inViewport && frame.roi.waterPixels > 0), 'Native initial water pixels must be a real positive control').toBe(true);
    await nativePage.evaluate(values => window.cityMotion.run(values), poses);
    native = await nativePage.evaluate(() => window.citySurfaceContinuity!.snapshot());
    errors.push(...await nativePage.evaluate(() => window.cityMotion.errors));
    await writeFile(testInfo.outputPath('city-surface-native.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, builds, initial, poses, coordinate, nativeInitial, native, errors }, null, 2));
    // The reference starts only after Native replay and context destruction;
    // it cannot warm Native resources or change its camera replay timing.
    await nativeContext.close();
    contexts.pop();

    const mapContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    contexts.push(mapContext);
    await routeCityReplay(mapContext, 'replay');
    const mapPage = await mapContext.newPage();
    mapPage.on('pageerror', error => errors.push(`maplibre: ${error.message}`));
    query.set('renderer', 'maplibre');
    query.set('initial', JSON.stringify(initial));
    await mapPage.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => mapPage.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 90_000 }).toBe(true);
    await expect.poll(() => mapPage.evaluate(() => window.citySurfaceContinuity?.riverPoint()), { timeout: 15_000 }).toBeTruthy();
    confirmation = await mapPage.evaluate(() => window.citySurfaceContinuity!.riverPoint()!);
    expect(confirmation.coordinate, 'Map confirms the exact fixed coordinate already sampled by Native; automatic replacement points are invalid').toEqual(coordinate);
    expect(confirmation.features.some(feature => feature.id === 289343), 'Actual initial Map water feature 289343 confirms the fixed River coordinate').toBe(true);
    await mapPage.evaluate(coordinate => window.citySurfaceContinuity!.setCoordinate(coordinate), coordinate);
    await expect.poll(() => mapPage.evaluate(() => window.citySurfaceContinuity!.snapshot().frames.length)).toBeGreaterThan(0);
    mapInitial = await mapPage.evaluate(() => window.citySurfaceContinuity!.snapshot());
    // Persist the positive controls even when unsupported or already missing.
    await writeFile(testInfo.outputPath('city-surface-initial.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, builds, initial, poses, coordinate, confirmation, native: nativeInitial, maplibre: mapInitial }, null, 2));
    expect(mapInitial.frames.filter(frame => frame.sampled)).toHaveLength(1);
    expect(mapInitial.frames.some(frame => frame.sampled && frame.defaultFramebuffer && frame.waterFeatures !== undefined && frame.waterFeatures.length > 0 && frame.roi !== undefined && frame.roi.inViewport && frame.roi.waterPixels > 0), 'Map initial water pixels and feature must be a real positive control').toBe(true);

    await mapPage.evaluate(values => window.cityMotion.run(values), poses);
    reference = await mapPage.evaluate(() => window.citySurfaceContinuity!.snapshot());
    errors.push(...await mapPage.evaluate(() => window.cityMotion.errors));
    const projection = await mapPage.evaluate(() => window.cityMotion.snapshot().projectionErrors);
    expect(projection).toHaveLength(poses.length);
    expect(Math.max(...projection.map(value => value.maximum))).toBeLessThan(1);
    comparison = [19, 20].map((poseIndex) => {
      const nativeFrames = native!.frames.filter(frame => frame.poseIndex === poseIndex);
      const mapFrames = reference!.frames.filter(frame => frame.poseIndex === poseIndex);
      const supported = mapFrames.some(frame => frame.sampled && frame.defaultFramebuffer && frame.roi !== undefined && frame.roi.inViewport && frame.roi.waterPixels > 0 && frame.waterFeatures !== undefined && frame.waterFeatures.length > 0);
      const referencePoint = mapFrames[0]?.projected;
      const riverProjectionError = Math.max(0, ...nativeFrames.map(frame => frame.projected && referencePoint ? Math.hypot(frame.projected.x - referencePoint.x, frame.projected.y - referencePoint.y) : 1e9));
      return { poseIndex, pose: poses[poseIndex - 1], supported, riverProjectionError, nativeFrames, mapFrames, missing: supported && nativeFrames.some(frame => frame.sampled && frame.roi !== undefined && frame.roi.inViewport && frame.roi.waterPixels === 0) };
    });
    await writeFile(testInfo.outputPath('city-surface-continuity.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, protocol: 'Serial independent contexts: Native ready, generate, initial pixel control once, unchanged 30 stationary ticks and 109 two-RAF poses; only poses 19/20 read every actual rendered frame, all others record metadata without owner or Source scans; close Native before Map setup and exact-coordinate confirmation', builds, initial, poses, coordinate, confirmation, native, maplibre: reference, comparison, projection, errors }, null, 2));
    expect(errors).toEqual([]);
    for (const [renderer, snapshot] of [['Native', native], ['Map', reference]] as const) {
      expect(snapshot.frames.filter(frame => frame.sampled && frame.poseIndex === 0), `${renderer} initial readback occurs once`).toHaveLength(1);
      expect(Number.isFinite(snapshot.observerCpuMs), `${renderer} reports observer CPU`).toBe(true);
      for (const frame of snapshot.frames) {
        expect(Number.isFinite(frame.observerCpuMs), `${renderer} frame reports observer CPU`).toBe(true);
        if (!frame.sampled) {
          expect(frame.roi, `${renderer} unsampled frame has no pixel result`).toBeUndefined();
          expect(frame.zoom, `${renderer} unsampled frame has no zoom calculation`).toBeUndefined();
          expect(frame.projected, `${renderer} unsampled frame has no point projection`).toBeUndefined();
          expect(frame.waterFeatures, `${renderer} unsampled frame has no feature query`).toBeUndefined();
        }
        else {
          expect([0, 19, 20], `${renderer} readback belongs to initial or target poses`).toContain(frame.poseIndex);
        }
      }
    }
    for (let index = 0; index < poses.length; index++) {
      expect(native.frames.some(frame => frame.poseIndex === index + 1), `Native pose ${index + 1} has a real postRender sample`).toBe(true);
      expect(reference.frames.some(frame => frame.poseIndex === index + 1), `Map pose ${index + 1} has a real _render sample, including loading frames`).toBe(true);
    }
    for (const result of comparison) {
      expect(result.nativeFrames.length, `Native pose ${result.poseIndex} actually rendered`).toBeGreaterThan(0);
      expect(result.mapFrames.length, `Map pose ${result.poseIndex} actually rendered`).toBeGreaterThan(0);
      for (const frame of result.nativeFrames) {
        expect(frame.sampled, `Native pose ${result.poseIndex} every actual frame was sampled`).toBe(true);
        expect(frame.roi?.inViewport, `Native pose ${result.poseIndex} River ROI is in the viewport`).toBe(true);
        expect(frame.zoom, `Native pose ${result.poseIndex} actual camera zoom`).toBeCloseTo(result.pose.zoom, 7);
        expect(frame.camera!.destination, `Native pose ${result.poseIndex} actual camera position`).toEqual(result.pose.destination);
      }
      for (const frame of result.mapFrames) {
        expect(frame.sampled, `Map pose ${result.poseIndex} every actual frame was sampled`).toBe(true);
        expect(frame.roi?.inViewport, `Map pose ${result.poseIndex} River ROI is in the viewport`).toBe(true);
        expect(frame.zoom, `Map pose ${result.poseIndex} actual camera zoom`).toBeCloseTo(result.pose.zoom, 7);
        expect(frame.mapCamera!.center[0], `Map pose ${result.poseIndex} actual center longitude`).toBeCloseTo(result.pose.center[0], 7);
        expect(frame.mapCamera!.center[1], `Map pose ${result.poseIndex} actual center latitude`).toBeCloseTo(result.pose.center[1], 7);
      }
      expect(result.supported, `Map pose ${result.poseIndex} has actual water features and pixels; otherwise this point is not a valid continuity oracle`).toBe(true);
      expect(result.riverProjectionError, `Both renderers project the actual River point to the same pixel at pose ${result.poseIndex}`).toBeLessThan(1);
      expect(result.missing, `Native pose ${result.poseIndex} lost the confirmed water ROI in a real rendered frame`).toBe(false);
    }
  }
  finally {
    await writeFile(testInfo.outputPath('city-surface-status.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, builds, initial, poses, coordinate, confirmation, nativeInitial, mapInitial, native, maplibre: reference, comparison, errors }, null, 2));
    for (const context of contexts) await context.close();
  }
});
