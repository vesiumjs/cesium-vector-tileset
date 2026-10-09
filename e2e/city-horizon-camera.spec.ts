import type { CityPose } from './fixtures/city-motion-adapter';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';

const circumference = 2 * Math.PI * 6378137;
const maximumReferencePositionErrorMeters = 0.1;
type Motion = Awaited<ReturnType<Window['cityMotion']['run']>>;

function distance(left: number[], right: number[]) {
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

test('Lujiazui near-horizon city motion preserves the independently qualified physical camera @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_CITY_HORIZON !== '1', 'Opt-in frozen real-city physical camera regression');
  test.setTimeout(240_000);
  expect(process.env.E2E_GPU).toBe('hardware');
  expect(process.env.E2E_CITY_LIBRARY_DIR).toBeTruthy();
  expect(process.env.E2E_BASELINE_DIR, 'freeze source imports and workers with the published library').toBeTruthy();
  const legacy = process.env.E2E_CITY_HORIZON_LEGACY === '1';
  const resources = process.env.E2E_CITY_RESOURCES === 'capture' ? 'capture' : 'replay';
  let initial: CityPose | undefined;
  let poses: CityPose[] = [];
  const results: Array<{ renderer: string; motion: Motion; errors: string[] }> = [];
  // Complete and close one real renderer before constructing the other.
  for (const renderer of ['cesium', 'maplibre']) {
    const context = await browser.newContext({
      viewport: { width: 1569, height: 906 },
      deviceScaleFactor: 1,
      recordVideo: { dir: testInfo.outputPath(`${renderer}-video`), size: { width: 1569, height: 906 } },
    });
    const errors: string[] = [];
    try {
      await routeCityReplay(context, resources);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const query = new URLSearchParams({
        cityPerf: '1',
        cityCameraQualification: '1',
        cityProjection: '1',
        cityVideo: '1',
        motionBaseline: '1',
        readback: '0',
        center: '121.489,31.244',
        mode: 'cv',
        cameraHeight: '120',
        cameraHeading: '115',
        cameraPitch: '-15',
        antialias: '0',
        published: '1',
        publishedUrl: `${renderUrl}/@fs/${path.resolve(process.env.E2E_CITY_LIBRARY_DIR!)}/index.mjs`,
      });
      if (!legacy)
        query.set('cityPhysicalCamera', '1');
      if (renderer === 'maplibre') {
        query.set('renderer', renderer);
        query.set('initial', JSON.stringify(initial));
      }
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 120_000 }).toBe(true);
      if (renderer === 'cesium') {
        initial = await page.evaluate(() => window.cityMotion.initial);
        poses = await page.evaluate(() => {
          const camera = window.renderValidation.viewer.camera;
          const Cartesian3 = camera.positionWC.constructor as typeof import('cesium').Cartesian3;
          const values: CityPose[] = [];
          const sequence = [[120, -15], [120, -5], [120, -1], [120, -0.1], [240, -0.1], [120, -0.1], [120, -5], [120, -15], [120, -1]];
          for (let section = 0; section < sequence.length - 1; section++) {
            for (let step = 1; step <= 8; step++) {
              const fraction = step / 8;
              const height = sequence[section][0] * (1 - fraction) + sequence[section + 1][0] * fraction;
              const pitch = sequence[section][1] * (1 - fraction) + sequence[section + 1][1] * fraction;
              camera.setView({ destination: Cartesian3.fromDegrees(121.489, 31.244, height), orientation: { heading: 115 * Math.PI / 180, pitch: pitch * Math.PI / 180, roll: 0 } });
              values.push(window.cityMotion.capturePose(`height-${height}-pitch-${pitch}`));
            }
          }
          camera.setView({ destination: Cartesian3.fromDegrees(121.489, 31.244, 120), orientation: { heading: 115 * Math.PI / 180, pitch: -15 * Math.PI / 180, roll: 0 } });
          return values;
        });
      }
      const motion = await page.evaluate(values => window.cityMotion.run(values), poses);
      errors.push(...await page.evaluate(() => window.cityMotion.errors));
      await page.screenshot({ path: testInfo.outputPath(`${renderer}-return.png`) });
      await writeFile(testInfo.outputPath(`${renderer}-motion.json`), JSON.stringify({ renderer, legacy, initial, poses, motion, errors }, null, 2));
      results.push({ renderer, motion, errors });
    }
    finally {
      await context.unrouteAll({ behavior: 'wait' });
      await context.close();
    }
  }
  await writeFile(testInfo.outputPath('city-horizon-camera.json'), JSON.stringify({
    diagnosticOnly: true,
    fairTiming: false,
    legacyReference: legacy,
    library: process.env.E2E_CITY_LIBRARY_DIR,
    source: process.env.E2E_BASELINE_DIR,
    resources,
    initial,
    poses,
    results,
  }, null, 2));

  expect(results.map(result => result.renderer)).toEqual(['cesium', 'maplibre']);
  expect(poses).toHaveLength(64);
  const [native, reference] = results;
  for (const result of results) {
    expect(result.errors, `${result.renderer}: real rendering errors`).toEqual([]);
    expect(result.motion.presentations.filter(frame => frame.cameraVersion > 0), `${result.renderer}: every pose was presented`).toHaveLength(poses.length);
    const versions = new Set(result.motion.cameraFrames.filter(frame => frame.cameraVersion > 0).map(frame => frame.cameraVersion));
    expect(versions.size, `${result.renderer}: every pose has an actual render camera sample`).toBe(poses.length);
    for (const frame of result.motion.cameraFrames.filter(frame => frame.cameraVersion > 0)) {
      const pose = poses[frame.cameraVersion - 1];
      const expectedPosition = [0.5 + pose.destination[1] / circumference, 0.5 - pose.destination[2] / circumference, pose.destination[0] / circumference];
      const expectedDirection = [pose.direction[1], -pose.direction[2], pose.direction[0]];
      const label = `${result.renderer} actual rendered pose ${frame.cameraVersion} ${frame.phase}`;
      expect(frame.gpu, label).not.toMatch(/SwiftShader|llvmpipe|Software/i);
      expect(distance(frame.position.slice(0, 2), expectedPosition.slice(0, 2)) * circumference, `${label}: horizontal camera position (meters)`).toBeLessThan(0.001);
      // Map's public conversion accepts altitude at the camera latitude but
      // reconstructs Z at the focus latitude scale. The captured maximum is
      // 0.096473 m (pure Z); X/Y differ by less than 1e-8 m. Allow that public
      // camera definition while retaining tight ray and ground pixel checks.
      expect(distance(frame.position, expectedPosition) * circumference, `${label}: physical camera position (meters)`).toBeLessThan(result.renderer === 'maplibre' ? maximumReferencePositionErrorMeters : 0.02);
      expect(distance(frame.direction, expectedDirection), `${label}: actual center ray direction`).toBeLessThan(1e-7);
      expect(Math.abs(frame.fov - pose.fov), `${label}: vertical field of view`).toBeLessThan(1e-8);
      expect(frame.groundProjections, `${label}: actual ground projection probes`).toHaveLength(4);
      for (const [index, ground] of frame.groundProjections.entries()) {
        expect(ground.pixel.every(Number.isFinite), `${label}: finite ground clip projection`).toBe(true);
        expect(distance(ground.pixel, pose.groundProjections![index].pixel), `${label}: actual ground pixels`).toBeLessThan(0.05);
      }
    }
  }
  const issuedByPose = new Map(reference.motion.cameraFrames.map(frame => [frame.cameraVersion, frame.issued]));
  const referenceByPose = new Map(reference.motion.cameraFrames.map(frame => [frame.cameraVersion, frame]));
  for (const frame of reference.motion.cameraFrames.filter(frame => frame.cameraVersion > 0)) {
    expect(frame.maximumPitch).toBe(89.9);
    expect(frame.issued, `Map public physical camera conversion for rendered pose ${frame.cameraVersion}`).toBeDefined();
    expect(Math.abs(frame.zoom - frame.issued!.zoom!)).toBeLessThan(1e-8);
    expect(Math.abs(frame.elevation! - frame.issued!.elevation!)).toBeLessThan(1e-6);
  }
  for (const frame of native.motion.cameraFrames.filter(frame => frame.cameraVersion > 0)) {
    const issued = issuedByPose.get(frame.cameraVersion);
    expect(Number.isFinite(frame.styleZoom)).toBe(true);
    const difference = frame.styleZoom! - issued!.zoom!;
    const label = `Native styleZoom agrees with the independent Map public API at actual rendered pose ${frame.cameraVersion}`;
    if (issued!.elevation !== 0) {
      // The public finite focus defines its own distance independently of a
      // zero-ground ray; its zoom must agree without a height correction.
      expect(Math.abs(difference), label).toBeLessThan(1e-5);
    }
    else {
      // Zero-ground perspective distance scales with the actual camera Z.
      // Bound the zoom effect using the already-qualified physical position
      // error, then independently verify its signed actual-height prediction.
      const nativeHeight = frame.position[2] * circumference;
      const referenceHeight = referenceByPose.get(frame.cameraVersion)!.position[2] * circumference;
      expect(nativeHeight).toBeGreaterThan(maximumReferencePositionErrorMeters);
      const maximumZoomDifference = Math.log2(nativeHeight / (nativeHeight - maximumReferencePositionErrorMeters));
      expect(Math.abs(difference), `${label}: bounded physical height effect`).toBeLessThan(maximumZoomDifference + 1e-5);
      expect(Math.abs(difference - Math.log2(referenceHeight / nativeHeight)), `${label}: actual height-corrected zoom`).toBeLessThan(1e-5);
    }
  }
  const issuedZooms = Array.from(issuedByPose.values(), issued => issued!.zoom!);
  expect(Math.max(...issuedZooms) - Math.min(...issuedZooms), 'real motion exercises dynamic zoom').toBeGreaterThan(1);
  expect(Math.max(...reference.motion.cameraFrames.map(frame => frame.elevation ?? 0)), 'near-horizon public conversion uses a finite elevated focus').toBeGreaterThan(1);
  expect(Math.max(...native.motion.cameraFrames.filter(frame => frame.cameraVersion > 0).map(frame => Math.abs(frame.styleZoom! - poses[frame.cameraVersion - 1].zoom))), 'legacy zero-ground capture is independently shown to be ineligible').toBeGreaterThan(1);
});
