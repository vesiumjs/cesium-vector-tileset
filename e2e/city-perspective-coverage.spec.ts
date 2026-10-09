import type { CityPose } from './fixtures/city-motion-adapter';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';

test('Shanghai distant source tiles follow the actual MapLibre perspective during camera motion @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_CITY_PERSPECTIVE !== '1', 'Opt-in frozen real-city perspective regression');
  test.setTimeout(180_000);
  expect(process.env.E2E_GPU).toBe('hardware');
  expect(process.env.E2E_CITY_LIBRARY_DIR).toBeTruthy();
  let initial: CityPose | undefined;
  let poses: CityPose[] = [];
  const results = [];
  for (const renderer of ['cesium', 'maplibre']) {
    const context = await browser.newContext({ viewport: { width: 1569, height: 906 }, deviceScaleFactor: 1 });
    try {
      await routeCityReplay(context, process.env.E2E_CITY_RESOURCES === 'capture' ? 'capture' : 'replay');
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const query = new URLSearchParams({ cityPerf: '1', motionBaseline: '1', cityProjection: '1', readback: '0', center: '121.483,31.226', cameraHeight: '1800', cameraHeading: '45', cameraPitch: '-25', antialias: '0', published: '1', publishedUrl: `${renderUrl}/@fs/${path.resolve(process.env.E2E_CITY_LIBRARY_DIR!)}/index.mjs` });
      if (renderer === 'maplibre') {
        query.set('renderer', renderer);
        query.set('initial', JSON.stringify(initial));
      }
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 90_000 }).toBe(true);
      const before = await page.evaluate(() => window.cityMotion.sourceCoverage());
      await page.screenshot({ path: testInfo.outputPath(`${renderer}-before.png`) });
      if (renderer === 'cesium') {
        initial = await page.evaluate(() => window.cityMotion.initial);
        poses = await page.evaluate(() => {
          const Cartesian3 = window.renderValidation.viewer.camera.positionWC.constructor as typeof import('cesium').Cartesian3;
          const values = [];
          for (const [height, pitch] of [[1800, -45], [1800, -35], [1800, -25], [1800, -15], [3600, -25], [1800, -25], [900, -25], [1800, -25]]) {
            window.renderValidation.viewer.camera.setView({ destination: Cartesian3.fromDegrees(121.483, 31.226, height), orientation: { heading: Math.PI / 4, pitch: pitch * Math.PI / 180, roll: 0 } });
            values.push(window.cityMotion.capturePose(`height-${height}-pitch-${pitch}`));
          }
          return values;
        });
      }
      const motion = await page.evaluate(values => window.cityMotion.run(values), poses);
      await expect.poll(() => page.evaluate(() => window.cityMotion.ready()), { timeout: 90_000 }).toBe(true);
      const after = await page.evaluate(() => window.cityMotion.sourceCoverage());
      errors.push(...await page.evaluate(() => window.cityMotion.errors));
      await page.screenshot({ path: testInfo.outputPath(`${renderer}-after.png`) });
      results.push({ renderer, before, after, motion, errors });
    }
    finally {
      await context.close();
    }
  }
  await writeFile(testInfo.outputPath('shanghai-perspective-coverage.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, initial, poses, results }, null, 2));
  for (const result of results)
    expect(result.errors).toEqual([]);
  const native = results[0];
  const reference = results[1];
  expect(reference.motion.projectionErrors).toHaveLength(8);
  expect(Math.max(...reference.motion.projectionErrors.map(error => error.maximum))).toBeLessThan(0.25);
  // This far footprint is in the recorded view. Qualify its actual MapLibre
  // level first, then check both cold and the settled continuous return.
  const far = { z: 12, x: 3431, y: 1672 };
  for (const phase of ['before', 'after'] as const) {
    const mapTiles = reference[phase].find(source => source.sourceId === 'openmaptiles')!.tiles;
    const nativeTiles = native[phase].find(source => source.sourceId === 'openmaptiles')!.tiles;
    expect(mapTiles).toContainEqual(far);
    expect(nativeTiles, `Native ${phase} must use the same distant source footprint`).toContainEqual(far);
    expect(nativeTiles.some(tile => tile.z > far.z && (tile.x >> (tile.z - far.z)) === far.x && (tile.y >> (tile.z - far.z)) === far.y), `Native ${phase} must not refine that distant footprint`).toBe(false);
  }
  expect(native.motion.presentations).toHaveLength(9);
});
