import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';
import { observeCityTileRequests } from './fixtures/city-tile-request-observation';

test('cached city detail returns on the first camera frame @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_CITY_RETURN_COVERAGE !== '1', 'Opt-in real-city coverage regression; excludes timing claims');
  test.setTimeout(120_000);
  expect(process.env.E2E_GPU).toBe('hardware');
  expect(process.env.E2E_CITY_LIBRARY_DIR).toBeTruthy();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  try {
    await routeCityReplay(context, 'replay');
    await observeCityTileRequests(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const query = new URLSearchParams({ cityPerf: '1', motionBaseline: '1', readback: '0', view: 'london', scale: '0.5', antialias: '0', published: '1', publishedUrl: `${renderUrl}/@fs/${path.resolve(process.env.E2E_CITY_LIBRARY_DIR!)}/index.mjs` });
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 90_000 }).toBe(true);
    const poses = await page.evaluate(() => window.cityMotion.generate());
    expect(poses).toHaveLength(109);
    await page.evaluate(values => window.cityMotion.run(values), poses);
    const observation = await page.evaluate(() => {
      window.cityTileRequestObserver?.stop();
      return window.cityTileRequests;
    });
    errors.push(...await page.evaluate(() => window.cityMotion.errors));
    await writeFile(testInfo.outputPath('city-return-coverage.json'), JSON.stringify({ diagnosticOnly: true, fairTiming: false, builds: { library: process.env.E2E_CITY_LIBRARY_DIR, sourceBaseline: process.env.E2E_BASELINE_DIR }, poses, observation, errors }, null, 2));
    expect(errors).toEqual([]);
    const firstReturn = observation.returnFrames.find(frame => frame.cameraVersion === 101);
    expect(firstReturn, 'The actual first rendered return frame must be observed').toBeTruthy();
    const source = firstReturn!.sources.find(source => source.sourceId === 'openmaptiles')!;
    expect(source.zoom).toBe(14);
    // This fixed London footprint already has four loaded children before
    // return. Old Globe rectangles cannot defer those uploaded owners.
    const children = source.loaded.filter(tile => tile?.z === 14
      && (tile.x === 8184 || tile.x === 8185)
      && (tile.y === 5448 || tile.y === 5449));
    expect(children, 'All four child footprints must be cached before the assertion qualifies').toHaveLength(4);
    expect(source.ideals?.some(tile => tile?.z === 13 && tile.x === 4092 && tile.y === 2724), 'The stale ancestor must relinquish its completely cached footprint').toBe(false);
    for (const child of children) {
      expect(source.ideals?.some(tile => tile?.key === child!.key), `Cached child ${child!.x}/${child!.y} participates on the first return frame`).toBe(true);
      expect(source.renderable).toContain(child!.key);
    }
    const childOwners = new Set(children.map(child => `openmaptiles/${child!.key}`));
    // The complete footprint includes children outside the current frustum.
    // Selection restores all four, while actual Native command submission
    // must prove at least one visible cached road resumes immediately.
    expect(firstReturn!.kinds.line?.some(tileId => childOwners.has(tileId)), 'A previously uploaded child road owner submits on the first return frame').toBe(true);
    const confirmedReturn = observation.returnFrames.filter(frame => frame.cameraVersion === 101)[1];
    expect(confirmedReturn, 'Observe the following confirmation render at the same camera pose').toBeTruthy();
    const confirmedSource = confirmedReturn!.sources.find(source => source.sourceId === 'openmaptiles')!;
    expect(confirmedSource.ideals?.some(tile => tile?.z === 13 && tile.x === 4092 && tile.y === 2724), 'The confirmation frame must not restore the stale coarse footprint').toBe(false);
    for (const child of children)
      expect(confirmedSource.ideals?.some(tile => tile?.key === child!.key)).toBe(true);
    expect(confirmedReturn!.kinds.line?.some(tileId => childOwners.has(tileId))).toBe(true);
  }
  finally {
    await context.close();
  }
});
