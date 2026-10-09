import type { CityPose } from './fixtures/city-motion-adapter';
import type { CityReplaySnapshot } from './fixtures/city-replay';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { observeCityAdmissions } from './fixtures/city-admission-observation';
import { observeCityDraws, observeCityOwnerUpdates } from './fixtures/city-draw-observation';
import { routeCityReplay } from './fixtures/city-replay';
import { observeCityTaskWakes } from './fixtures/city-task-wake-observation';
import { observeCityTileRequests } from './fixtures/city-tile-request-observation';
import { observeCityUploads } from './fixtures/city-upload-observation';
import { observeCityWorkers } from './fixtures/city-worker-observation';

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0, over50: values.filter(value => value > 50).length };
}

test('independent real-city full frames and camera presentation @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_CITY_PERFORMANCE !== '1', 'Opt-in real-city performance measurement');
  test.setTimeout(240_000);
  const mode = process.env.E2E_CITY_RESOURCES === 'capture' ? 'capture' : 'replay';
  let initial: CityPose | undefined;
  let poses: CityPose[] = [];
  const results = [];
  const coverageEnabled = process.env.E2E_CITY_COVERAGE === '1';
  const coverage: Array<{ renderer: string; cold: CityReplaySnapshot; motion: CityReplaySnapshot }> = [];
  for (const renderer of ['cesium', 'maplibre']) {
    const admissionsEnabled = renderer === 'cesium' && process.env.E2E_CITY_ADMISSIONS === '1';
    const tileRequestsEnabled = renderer === 'cesium' && process.env.E2E_CITY_TILE_REQUESTS === '1';
    const geometryAttributesEnabled = renderer === 'cesium' && process.env.E2E_CITY_GEOMETRY_ATTRIBUTES === '1';
    const ownerUpdatesEnabled = renderer === 'cesium' && process.env.E2E_CITY_OWNER_UPDATES === '1';
    const taskWakesEnabled = renderer === 'cesium' && process.env.E2E_CITY_TASK_WAKES === '1';
    const workerPayloadEnabled = process.env.E2E_CITY_WORKERS === '1' || admissionsEnabled || geometryAttributesEnabled;
    const workersEnabled = workerPayloadEnabled || taskWakesEnabled;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const snapshotRequests = await routeCityReplay(context, mode, coverageEnabled);
    if (taskWakesEnabled)
      await observeCityTaskWakes(context);
    if (workersEnabled)
      await observeCityWorkers(context, geometryAttributesEnabled, taskWakesEnabled, workerPayloadEnabled);
    if (admissionsEnabled)
      await observeCityAdmissions(context);
    if (tileRequestsEnabled)
      await observeCityTileRequests(context);
    if (renderer === 'cesium' && process.env.E2E_CITY_UPLOADS === '1')
      await observeCityUploads(context);
    if (renderer === 'cesium' && process.env.E2E_CITY_DRAWS === '1')
      await observeCityDraws(context, process.env.E2E_CITY_OMIT_DRAWS?.split(',') ?? []);
    if (ownerUpdatesEnabled)
      await observeCityOwnerUpdates(context, process.env.E2E_CITY_DRAWS === '1' ? process.env.E2E_CITY_OMIT_DRAWS?.split(',') ?? [] : []);
    const page = await context.newPage();
    const session = process.env.E2E_PROFILE === '1' ? await context.newCDPSession(page) : undefined;
    if (session) {
      await session.send('Profiler.enable');
      await session.send('Profiler.start');
    }
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const query = new URLSearchParams({ cityPerf: '1', motionBaseline: '1', readback: '0', view: 'london', scale: '0.5', antialias: '0' });
    if (admissionsEnabled || ownerUpdatesEnabled || taskWakesEnabled || (renderer === 'cesium' && process.env.E2E_CITY_UPLOADS === '1'))
      query.set('atlas', '1');
    if (process.env.E2E_CITY_LIBRARY_DIR) {
      query.set('published', '1');
      query.set('publishedUrl', `${renderUrl}/@fs/${path.resolve(process.env.E2E_CITY_LIBRARY_DIR)}/index.mjs`);
    }
    if (process.env.E2E_CITY_STAGES === '1')
      query.set('cityStages', '1');
    if (renderer === 'maplibre') {
      query.set('renderer', renderer);
      query.set('initial', JSON.stringify(initial));
    }
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => window.cityMotion?.ready() ?? false), { timeout: 90_000 }).toBe(true);
    const fixtureInstrumentation = renderer === 'cesium'
      ? await page.evaluate(() => ({
          updates: window.renderValidation.measurements.updateMs.length,
          frames: window.renderValidation.measurements.frames.length,
          ownUpdate: Object.hasOwn(window.renderValidation.tileset, 'update'),
        }))
      : undefined;
    if (fixtureInstrumentation && process.env.E2E_CITY_STAGES !== '1') {
      expect(fixtureInstrumentation, 'fair city timing excludes internal stage and command census probes').toEqual({ updates: 0, frames: 0, ownUpdate: false });
    }
    const cold = await page.evaluate(() => window.cityMotion.snapshot());
    expect(cold.milestones.loaded, `${renderer}: renderer records first loaded update`).toBeGreaterThan(0);
    expect(cold.milestones.loaded).toBeLessThanOrEqual(cold.elapsed);
    const coldCoverage = snapshotRequests?.();
    const coldStats = renderer === 'cesium' ? await page.evaluate(() => window.renderValidation.tileset.stats()) : undefined;
    const coldWorkers = workersEnabled ? await page.evaluate(() => window.cityWorkers) : undefined;
    const coldAdmissions = admissionsEnabled ? await page.evaluate(() => window.cityAdmissions) : undefined;
    const coldTaskWakes = taskWakesEnabled
      ? await page.evaluate(() => ({ armed: window.cityTaskWakes.armed, throughTick: window.cityTaskWakes.ticks.at(-1)?.tick ?? 0, events: window.cityTaskWakes.events.length, callbacks: window.cityTaskWakes.callbacks.length }))
      : undefined;
    const coldTileRequests = tileRequestsEnabled ? await page.evaluate(() => window.cityTileRequests) : undefined;
    const coldOwnerUpdates = ownerUpdatesEnabled
      ? await page.evaluate(() => {
          const observation = (window as unknown as { cityOwnerUpdates?: { armed?: number; ticks: Array<{ tick: number }> } }).cityOwnerUpdates;
          return { armed: observation?.armed, throughTick: observation?.ticks.at(-1)?.tick ?? 0 };
        })
      : undefined;
    if (ownerUpdatesEnabled)
      expect(coldOwnerUpdates?.armed, 'Native Primitive owner update observer attached').toBeGreaterThan(0);
    if (tileRequestsEnabled)
      expect(coldTileRequests?.armed, 'Tile pyramid request observer attached').toBeGreaterThan(0);
    if (admissionsEnabled)
      expect(coldAdmissions?.armed, 'Native TaskProcessor admission observer attached').toBeGreaterThan(0);
    if (taskWakesEnabled)
      expect(coldTaskWakes?.armed, 'Native task wake observer attached').toBeGreaterThan(0);
    const commandKinds = renderer === 'cesium'
      ? await page.evaluate(() => {
          const validation = window.renderValidation;
          const kinds: Record<string, number> = {};
          for (const command of validation.viewer.scene._frameState.commandList) {
            const batch = validation.drawBatch(command) ?? validation.drawBatch(command.owner);
            const kind = batch?.kind ?? 'native';
            kinds[kind] = (kinds[kind] ?? 0) + 1;
          }
          return kinds;
        })
      : undefined;
    if (session) {
      const { profile } = await session.send('Profiler.stop');
      // Includes page setup; cold wall time itself starts after the bare globe settles.
      await writeFile(testInfo.outputPath(`${renderer}-cold-profile.json`), JSON.stringify(profile));
    }
    if (renderer === 'cesium') {
      initial = await page.evaluate(() => window.cityMotion.initial);
      poses = await page.evaluate(() => window.cityMotion.generate());
    }
    if (session) {
      await session.send('Profiler.start');
    }
    const motion = await page.evaluate(values => window.cityMotion.run(values), poses);
    const motionCoverage = snapshotRequests?.(coldCoverage);
    if (coldCoverage && motionCoverage)
      coverage.push({ renderer, cold: coldCoverage, motion: motionCoverage });
    const motionWorkers = workersEnabled ? await page.evaluate(() => window.cityWorkers) : undefined;
    const finalStats = renderer === 'cesium' ? await page.evaluate(() => window.renderValidation.tileset.stats()) : undefined;
    const finalCommandKinds = renderer === 'cesium'
      ? await page.evaluate(() => {
          const validation = window.renderValidation;
          const kinds: Record<string, number> = {};
          for (const command of validation.viewer.scene._frameState.commandList) {
            const batch = validation.drawBatch(command) ?? validation.drawBatch(command.owner);
            const kind = batch?.kind ?? 'native';
            kinds[kind] = (kinds[kind] ?? 0) + 1;
          }
          return kinds;
        })
      : undefined;
    const symbols = renderer === 'cesium' ? await page.evaluate(() => window.renderValidation.cityDiagnostics()) : undefined;
    if (renderer === 'cesium' && process.env.E2E_CITY_UPLOADS === '1') {
      const uploads = await page.evaluate(() => (window as unknown as { cityUploadFrames: object[] }).cityUploadFrames);
      await writeFile(testInfo.outputPath('city-upload-frames.json'), JSON.stringify(uploads, null, 2));
    }
    if (renderer === 'cesium' && process.env.E2E_CITY_DRAWS === '1') {
      const draws = await page.evaluate(() => (window as unknown as { cityDrawFrames: object[] }).cityDrawFrames);
      await writeFile(testInfo.outputPath('city-draw-frames.json'), JSON.stringify(draws, null, 2));
    }
    if (ownerUpdatesEnabled) {
      const ownerUpdates = await page.evaluate(() => {
        const target = window as unknown as { cityOwnerUpdateObserver?: { stop: () => void }; cityOwnerUpdates: object };
        target.cityOwnerUpdateObserver?.stop();
        return target.cityOwnerUpdates;
      });
      await writeFile(testInfo.outputPath('city-owner-updates.json'), JSON.stringify({ cold: coldOwnerUpdates, observation: ownerUpdates }, null, 2));
    }
    const motionAdmissions = admissionsEnabled
      ? await page.evaluate(() => {
          window.cityAdmissionObserver?.stop();
          return window.cityAdmissions;
        })
      : undefined;
    if (admissionsEnabled)
      await writeFile(testInfo.outputPath('city-admissions.json'), JSON.stringify({ cold: coldAdmissions, motion: motionAdmissions }, null, 2));
    if (taskWakesEnabled) {
      const observation = await page.evaluate(() => {
        window.cityTaskWakeObserver?.stop();
        return window.cityTaskWakes;
      });
      await writeFile(testInfo.outputPath('city-task-wakes.json'), JSON.stringify({ cold: coldTaskWakes, observation }, null, 2));
    }
    const motionTileRequests = tileRequestsEnabled
      ? await page.evaluate(() => {
          window.cityTileRequestObserver?.stop();
          return window.cityTileRequests;
        })
      : undefined;
    if (tileRequestsEnabled)
      await writeFile(testInfo.outputPath('city-tile-requests.json'), JSON.stringify({ cold: coldTileRequests, motion: motionTileRequests }, null, 2));
    if (session) {
      const { profile } = await session.send('Profiler.stop');
      await writeFile(testInfo.outputPath(`${renderer}-profile.json`), JSON.stringify(profile));
      await session.detach();
    }
    const phases = Object.fromEntries(['cold', 'stationary', 'zoom-out', 'zoom-in', 'pan', 'orbit', 'settle'].map((phase) => {
      const beforeLoaded = (value: { phase: string; at: number }) => value.phase === phase
        && (phase !== 'cold' || value.at <= cold.milestones.loaded);
      const frames = motion.frames.filter(beforeLoaded);
      return [phase, {
        cpu: distribution(frames.map(frame => frame.cpu)),
        ticks: distribution(motion.ticks.filter(beforeLoaded).map(tick => tick.cpu)),
        idleCpu: distribution(motion.ticks.filter(tick => beforeLoaded(tick) && !tick.rendered).map(tick => tick.cpu)),
        intervals: distribution(frames.slice(1).map((frame, index) => frame.at - frames[index].at)),
        presentation: distribution(motion.presentations.filter(value => value.phase === phase).map(value => value.latency)),
      }];
    }));
    await page.screenshot({ path: testInfo.outputPath(`${renderer}-settled.png`) });
    const bare = renderer === 'cesium' ? await page.evaluate(values => window.cityMotion.runBare(values), poses) : undefined;
    results.push({ renderer, coldElapsed: cold.milestones.loaded, coldObservedElapsed: cold.elapsed, phases, cold, motion, bare, coldStats, finalStats, commandKinds, finalCommandKinds, symbols, coldWorkers, motionWorkers, fixtureInstrumentation });
    errors.push(...await page.evaluate(() => window.cityMotion.errors));
    await context.close();
    expect(errors).toEqual([]);
    expect(motion.presentations.filter(value => value.cameraVersion > 0)).toHaveLength(poses.length);
  }
  const fairTiming = mode === 'replay' && ![
    'E2E_PROFILE',
    'E2E_CITY_STAGES',
    'E2E_CITY_ADMISSIONS',
    'E2E_CITY_COVERAGE',
    'E2E_CITY_TILE_REQUESTS',
    'E2E_CITY_GEOMETRY_ATTRIBUTES',
    'E2E_CITY_UPLOADS',
    'E2E_CITY_DRAWS',
    'E2E_CITY_OWNER_UPDATES',
    'E2E_CITY_TASK_WAKES',
    'E2E_CITY_WORKERS',
  ].some(flag => process.env[flag] === '1');
  const builds = { readinessMeasurement: 'first-loaded-renderer-update', coldFrames: 'through-first-loaded-update', fairTiming, diagnosticOnly: !fairTiming, profiling: process.env.E2E_PROFILE === '1', library: process.env.E2E_CITY_LIBRARY_DIR ?? 'source', cesium: process.env.E2E_CESIUM_BUILD ?? 'default-source', sourceBaseline: process.env.E2E_BASELINE_DIR, fixtureStageObservation: process.env.E2E_CITY_STAGES === '1', drawObservation: process.env.E2E_CITY_DRAWS === '1', omittedDraws: process.env.E2E_CITY_OMIT_DRAWS };
  if (coverageEnabled) {
    await writeFile(testInfo.outputPath('city-coverage.json'), JSON.stringify({
      diagnosticOnly: true,
      fairTiming: false,
      source: 'Node-side Playwright route requests to https://tiles.openfreemap.org/**',
      semantics: 'Actual browser resource requests, including repeats; not loaded tiles, completed responses, or upstream server fetches. Cold is cumulative through readiness; motion is the request-count difference through camera replay.',
      results: coverage,
    }, null, 2));
  }
  const diagnostic = process.env.E2E_CITY_ADMISSIONS === '1' ? { admissionObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  const coverageDiagnostic = coverageEnabled ? { coverageObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  const tileRequestDiagnostic = process.env.E2E_CITY_TILE_REQUESTS === '1' ? { tileRequestObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  const geometryAttributeDiagnostic = process.env.E2E_CITY_GEOMETRY_ATTRIBUTES === '1' ? { geometryAttributeObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  const uploadDiagnostic = process.env.E2E_CITY_UPLOADS === '1' ? { uploadObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  const ownerUpdateDiagnostic = process.env.E2E_CITY_OWNER_UPDATES === '1' ? { ownerUpdateObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  const taskWakeDiagnostic = process.env.E2E_CITY_TASK_WAKES === '1' ? { taskWakeObservation: true, diagnosticOnly: true, fairTiming: false } : undefined;
  await writeFile(testInfo.outputPath('city-performance.json'), JSON.stringify({ mode, builds: { ...builds, ...diagnostic, ...coverageDiagnostic, ...tileRequestDiagnostic, ...geometryAttributeDiagnostic, ...uploadDiagnostic, ...ownerUpdateDiagnostic, ...taskWakeDiagnostic }, initial, poses, results }, null, 2));
  console.warn(JSON.stringify(results.map(({ renderer, coldElapsed, phases }) => ({ renderer, coldElapsed, phases }))));
  if (process.env.E2E_VERIFY_CITY_BUDGET === '1') {
    for (const phase of ['zoom-out', 'zoom-in', 'pan', 'orbit'])
      expect(results[0].phases[phase].cpu.p95, `${phase}: complete Cesium Scene CPU`).toBeLessThanOrEqual(16.67);
  }
});
