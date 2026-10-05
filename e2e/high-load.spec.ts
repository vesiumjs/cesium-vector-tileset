import type { LineLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { CesiumVectorTileset } from '../packages/cesium-vector-tileset/src/cesium-vector-tileset';
import type { OverscaledTileID } from '../packages/cesium-vector-tileset/src/tile/tile-id';
import type { TestScene } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

type TilesetStats = ReturnType<CesiumVectorTileset['stats']>;
interface CameraVector { x: number; y: number; z: number }
interface ColdFrame {
  time: number;
  coverage: number[];
  stats: TilesetStats;
  globeLoaded: boolean;
  tilesLoaded: boolean;
  cameraObserved: boolean;
  camera: { position: CameraVector; direction: CameraVector; right: CameraVector; fovY: number; aspectRatio: number };
  globe: string[];
  sources: Array<{ id: string; ideal: string[]; renderable: string[]; supplemented: boolean }>;
  jobs: Array<{ tileId: string; phase: string; generationId: number }>;
}
interface ColdObliqueReport {
  loadMs: number;
  frames: ColdFrame[];
  coverage: number[];
  stats: TilesetStats;
  globeLoaded: boolean;
  tilesLoaded: boolean;
  cameraObserved: boolean;
  warmedSources: Array<{ id: string; ideal: string[]; renderable: string[] }>;
  warmedMemory: Array<{ key: string; bytes: number; pinned?: boolean }>;
  held: Array<{ id: string; tiles: string[] }>;
  jobs: Array<{ tileId: string; phase: string; generationId: number }>;
  firstUpdates: Array<{ show: boolean; ready: boolean; index: number }>;
  measurements: Window['renderValidation']['measurements'];
  renderErrors: string[];
}

declare global {
  interface Window {
    highLoadColdFrames: ColdFrame[];
    highLoadColdStarted: number;
    stopHighLoadColdFrames: () => void;
  }
}

const extent = 4096;
const square = (x: number, y: number, size: number) => [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
const tile = fromGeojsonVt({
  ground: { features: [{ type: 3, geometry: square(0, 0, extent), tags: {} }] },
  parcels: { features: Array.from({ length: 1024 }, (_, index) => ({
    type: 3,
    geometry: square(index % 32 * 128 + 2, Math.floor(index / 32) * 128 + 2, 124),
    tags: { index },
  })) },
  roads: { features: Array.from({ length: 128 }, (_, index) => ({
    type: 2,
    geometry: [Array.from({ length: 33 }, (_, segment) => {
      const position = (index % 64 + 0.5) * 64;
      const bend = Math.sin(segment * Math.PI / 4) * 4;
      return index < 64 ? [segment * 128, position + bend] : [position + bend, segment * 128];
    })],
    tags: { index },
  })) },
}, { version: 2, extent });

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 };
}

test('dense local MVT stays drawn through delayed loads, rapid zoom, pan and an oblique view', async ({ page, renderUrl }, testInfo) => {
  test.setTimeout(180_000);
  const started = Date.now();
  const errors: string[] = [];
  let tileRequests = 0;
  const style = {
    version: 8,
    sources: { dense: { type: 'vector', tiles: [`${renderUrl}/high-load/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'dense', 'source-layer': 'ground', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } },
      { 'id': 'parcels', 'type': 'fill', 'source': 'dense', 'source-layer': 'parcels', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } },
      { 'id': 'roads', 'type': 'line', 'source': 'dense', 'source-layer': 'roads', 'paint': { 'line-color': '#ffffff', 'line-width': 3 } },
    ],
  } satisfies StyleSpecification;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/high-load/**', async (route) => {
    if (route.request().url().endsWith('.pbf')) {
      tileRequests++;
      await new Promise(resolve => setTimeout(resolve, 150));
      return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
    }
    return route.fulfill({ json: style });
  });
  const query = new URLSearchParams({ style: `${renderUrl}/high-load/style.json`, synthetic: String(extent), view: 'london' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation && Math.max(...window.renderValidation.readCoverage([255, 255, 255]))), { timeout: 60_000 }).toBeGreaterThan(0.01);
  await page.locator('#cesium').screenshot({ path: testInfo.outputPath('dense-roads-initial.png') });
  // Prove that the line renderer produced visible white roads first, then
  // paint them the ground color so their antialiased edges cannot be mistaken
  // for tile gaps during the coverage stress sequence.
  const stressStyle = structuredClone(style);
  (stressStyle.layers[2] as LineLayerSpecification).paint!['line-color'] = '#3366aa';
  await page.evaluate(next => window.renderValidation.tileset.setStyle(next), stressStyle);
  await expect.poll(() => page.evaluate(() => Math.min(...window.renderValidation.readCoverage())), { timeout: 60_000 }).toBeGreaterThanOrEqual(0.98);
  const initialLoadMs = Date.now() - started;
  const zoomOnly = process.env.E2E_ZOOM_ONLY === '1';
  let coldOblique: ColdObliqueReport | undefined;
  if (!zoomOnly) {
    const beforeOblique = await page.evaluate(() => {
      const validation = window.renderValidation;
      window.highLoadColdFrames = [];
      window.highLoadColdStarted = performance.now();
      window.stopHighLoadColdFrames = validation.viewer.scene.postRender.addEventListener(() => {
        const tileset = validation.tileset;
        const covering = tileset._sceneCovering;
        const camera = validation.viewer.camera;
        window.highLoadColdFrames.push({
          time: performance.now(),
          coverage: validation.readCoverage(),
          stats: tileset.stats(),
          globeLoaded: validation.viewer.scene.globe.tilesLoaded,
          tilesLoaded: tileset.tilesLoaded,
          cameraObserved: covering._cameraPose === covering._observedCamera,
          camera: { position: { ...camera.positionWC }, direction: { ...camera.directionWC }, right: { ...camera.rightWC }, fovY: camera.frustum.fovy, aspectRatio: camera.frustum.aspectRatio },
          globe: validation.viewer.scene.globe._surface._tilesToRender.map(tile => `${tile.level}/${tile.x}/${tile.y}`),
          sources: Object.entries(tileset._style.tilePyramids).map(([id, pyramid]) => ({ id, ideal: pyramid._covering.idealTileIDs.map(tile => tile.toString()), renderable: pyramid.getRenderableIds(), supplemented: !!covering._globeCoverings.get(pyramid).supplementalPose })),
          jobs: [...tileset._tilePublishQueue._jobs.values()].map(job => ({ tileId: job.tileId, phase: job.phase, generationId: job.generationId })),
        });
      });
      validation.setObliqueView();
      return validation.renderedFrames;
    });
    try {
      await expect.poll(() => page.evaluate(async (before) => {
        const validation = window.renderValidation;
        const frames = validation.renderedFrames;
        await new Promise(resolve => setTimeout(resolve, 400));
        return frames > before && validation.renderedFrames === frames
          && validation.viewer.scene.globe.tilesLoaded && validation.tileset.tilesLoaded
          && validation.readCoverage().every(ratio => ratio >= 0.98);
      }, beforeOblique), { timeout: 60_000 }).toBe(true);
    }
    finally {
      coldOblique = await page.evaluate(() => {
        window.stopHighLoadColdFrames();
        const validation = window.renderValidation;
        const tileset = validation.tileset;
        const warmedMemory: ColdObliqueReport['warmedMemory'] = [];
        tileset._vectorRenderer.visitMemoryEntries((key, bytes, pinned) => {
          warmedMemory.push(pinned === undefined ? { key, bytes } : { key, bytes, pinned });
        });
        return {
          loadMs: performance.now() - window.highLoadColdStarted,
          frames: window.highLoadColdFrames,
          coverage: validation.readCoverage(),
          stats: tileset.stats(),
          globeLoaded: validation.viewer.scene.globe.tilesLoaded,
          tilesLoaded: tileset.tilesLoaded,
          cameraObserved: tileset._sceneCovering._cameraPose === tileset._sceneCovering._observedCamera,
          warmedSources: Object.entries(tileset._style.tilePyramids).map(([id, pyramid]) => ({ id, ideal: pyramid._covering.idealTileIDs.map(tile => tile.toString()), renderable: pyramid.getRenderableIds() })),
          warmedMemory,
          held: [...tileset._tileResidency._sources].map(([id, source]) => ({ id, tiles: [...source.held] })),
          jobs: [...tileset._tilePublishQueue._jobs.values()].map(job => ({ tileId: job.tileId, phase: job.phase, generationId: job.generationId })),
          firstUpdates: tileset._sceneCollections._firstUpdates.flatMap(queue => [...queue].map(([collection, update]) => ({ show: collection.show, ready: collection.ready, index: update.index }))),
          measurements: validation.measurements,
          renderErrors: validation.renderErrors,
        };
      });
      const coldOutput = testInfo.outputPath('cold-oblique-diagnostic.json');
      await writeFile(coldOutput, JSON.stringify(coldOblique, null, 2));
      await testInfo.attach('cold-oblique-diagnostic', { path: coldOutput, contentType: 'application/json' });
    }
    // Newly exposed cold ground needs its data first. The regression below
    // revisits the already drawn oblique footprint to test resource continuity.
    const beforeTop = await page.evaluate(() => {
      const validation = window.renderValidation;
      validation.setTopView();
      return validation.renderedFrames;
    });
    await expect.poll(() => page.evaluate(async (before) => {
      const validation = window.renderValidation;
      const frames = validation.renderedFrames;
      await new Promise(resolve => setTimeout(resolve, 400));
      return frames > before && validation.renderedFrames === frames
        && validation.viewer.scene.globe.tilesLoaded && validation.tileset.tilesLoaded
        && validation.readCoverage().every(ratio => ratio >= 0.98);
    }, beforeTop), { timeout: 60_000 }).toBe(true);
  }
  if (zoomOnly) {
    await expect.poll(() => page.evaluate(async () => {
      const validation = window.renderValidation;
      const frames = validation.renderedFrames;
      await new Promise(resolve => setTimeout(resolve, 400));
      return validation.renderedFrames === frames && validation.viewer.scene.globe.tilesLoaded
        && validation.tileset.tilesLoaded && validation.readCoverage().every(ratio => ratio >= 0.98);
    }), { timeout: 60_000 }).toBe(true);
  }
  const requestsBeforeMovement = tileRequests;
  const cameraOnly = process.env.E2E_CAMERA_ONLY === '1';
  const frames = await page.evaluate(async ({ cameraOnly, zoomOnly }) => {
    const validation = window.renderValidation;
    validation.reset();
    interface MovementFrame { phase: string; step: number; time: number; coverage: number[]; stats: TilesetStats; diagnostic?: ReturnType<typeof diagnose> }
    const frames: MovementFrame[] = [];
    let phase = 'zoom-in';
    let step = 0;
    const rectangles = (globe: TestScene['globe']) => globe._surface._tilesToRender.map(tile => ({ level: tile.level, x: tile.x, y: tile.y, rectangle: { ...tile.rectangle } }));
    let previousGlobe: ReturnType<typeof rectangles> | undefined;
    const removePreRender = validation.viewer.scene.preRender.addEventListener(() => {
      previousGlobe = rectangles(validation.viewer.scene.globe);
    });
    const diagnose = () => {
      const tileset = validation.tileset;
      const camera = validation.viewer.camera;
      const sources = Object.entries(tileset._style.tilePyramids);
      const tileInfo = (tile: OverscaledTileID) => ({ key: tile.key, coordinate: tile.toString(), canonical: { ...tile.canonical }, wrap: tile.wrap });
      const owns = (tile: OverscaledTileID, ground: ReturnType<Window['renderValidation']['readMismatchRanges']>[number]['samples'][number]['ground']) => ground && Math.floor((ground.mercatorX - tile.wrap) * 2 ** tile.canonical.z) === tile.canonical.x
        && Math.floor(ground.mercatorY * 2 ** tile.canonical.z) === tile.canonical.y;
      const memory: ColdObliqueReport['warmedMemory'] = [];
      tileset._vectorRenderer.visitMemoryEntries((key, bytes, pinned) => {
        memory.push(pinned === undefined ? { key, bytes } : { key, bytes, pinned });
      });
      return {
        camera: { position: { ...camera.positionWC }, direction: { ...camera.directionWC }, right: { ...camera.rightWC }, up: { ...camera.upWC }, fovY: camera.frustum.fovy, aspectRatio: camera.frustum.aspectRatio },
        mismatches: validation.readMismatchRanges().map(range => ({
          ...range,
          samples: range.samples.map(sample => ({
            ...sample,
            sources: sources.map(([id, pyramid]) => ({
              id,
              ideal: pyramid._covering.idealTileIDs.filter(tile => owns(tile, sample.ground)).map(tileInfo),
              renderable: pyramid.getVisibleCoordinates().filter(tile => owns(tile, sample.ground)).map(tileInfo),
            })),
          })),
        })),
        previousGlobe,
        currentGlobe: rectangles(validation.viewer.scene.globe),
        sources: Object.entries(tileset._style.tilePyramids).map(([id, pyramid]) => ({ id, ideal: pyramid._covering?.idealTileIDs.map(tile => tile.toString()), renderable: pyramid.getRenderableIds() })),
        live: [...tileset._vectorRenderer.collections].map(([id, collection]) => ({ id, show: collection.show, length: (collection as { show: boolean; length?: number }).length })),
        retired: tileset._vectorRenderer.retiredCollections.map(collection => ({ show: collection.show, length: (collection as { show: boolean; length?: number }).length })),
        held: [...tileset._tileResidency._sources].map(([id, source]) => ({ id, tiles: [...source.held] })),
        memory,
        hiddenSurfaceLayers: [...tileset._tileResidency.hiddenSurfaceLayers].map(([tileId, layers]) => ({ tileId, layers: [...layers] })),
        jobs: [...tileset._tilePublishQueue._jobs.values()].map(job => ({ tileId: job.tileId, phase: job.phase })),
        firstUpdates: tileset._sceneCollections._firstUpdates.flatMap(queue => [...queue].map(([collection, update]) => ({ show: collection.show, ready: collection.ready, length: collection.length, index: update.index, owners: [...tileset._vectorRenderer.collections].filter(([, candidate]) => candidate === collection).map(([id]) => id) }))),
      };
    };
    const remove = validation.viewer.scene.postRender.addEventListener(() => {
      const coverage = validation.readCoverage();
      const frame: MovementFrame = { phase, step, time: performance.now(), coverage, stats: validation.tileset.stats() };
      if (coverage.some(ratio => ratio < 0.98))
        frame.diagnostic = diagnose();
      frames.push(frame);
    });
    const pause = () => new Promise(resolve => setTimeout(resolve, 60));
    try {
      for (phase of cameraOnly ? [] : zoomOnly ? ['zoom-in'] : ['zoom-in', 'zoom-out', 'pan-right', 'pan-left']) {
        for (step = 0; step < 8; step++) {
          const camera = validation.viewer.camera;
          const height = camera.positionCartographic.height;
          if (phase === 'zoom-in')
            camera.zoomIn(height * 0.15);
          else if (phase === 'zoom-out')
            camera.zoomOut(height * 0.15);
          else if (phase === 'pan-right')
            camera.moveRight(height * 0.025);
          else camera.moveLeft(height * 0.025);
          validation.viewer.scene.requestRender();
          await pause();
        }
      }
      phase = zoomOnly ? 'settle' : 'oblique';
      step = 0;
      if (!zoomOnly)
        validation.restoreObliqueView();
      // Keep recording after movement stops while slow tiles and uploads
      // finish; missing coverage often occurs at the final publication handoff.
      for (step = 0; step < 30; step++)
        await pause();
      return frames;
    }
    finally {
      remove();
      removePreRender();
    }
  }, { cameraOnly, zoomOnly });
  const metrics = await page.evaluate(() => ({ stats: window.renderValidation.tileset.stats(), measurements: window.renderValidation.measurements }));
  const report = {
    fixture: { polygons: 1025, roads: 128, tileBytes: tile.byteLength, tileDelayMs: 150 },
    initialLoadMs,
    coldOblique,
    requests: { initial: requestsBeforeMovement, total: tileRequests },
    builds: metrics.measurements.builds,
    updateMs: distribution(metrics.measurements.updateMs),
    uploadMs: distribution(metrics.measurements.uploadMs),
    gpu: metrics.stats.gpuMemory,
    frames,
  };
  const output = testInfo.outputPath('high-load-metrics.json');
  await writeFile(output, JSON.stringify(report, null, 2));
  await testInfo.attach('high-load-metrics', { path: output, contentType: 'application/json' });
  if (!cameraOnly) {
    assert.ok(tileRequests > requestsBeforeMovement, 'camera movement did not exercise new tile requests');
    assert.ok(metrics.measurements.builds > 0, 'camera movement did not exercise tile geometry builds');
    assert.ok(frames.length >= (zoomOnly ? 8 : 32), `only ${frames.length} frames during ${zoomOnly ? 8 : 32} camera steps`);
  }
  assert.ok(frames.length > 0, 'camera changes produced no rendered frames');
  const gaps = frames.filter(frame => frame.coverage.some(ratio => ratio < 0.98));
  assert.equal(gaps.length, 0, `dense tile framebuffer coverage disappeared: ${JSON.stringify(gaps.map(({ phase, step, coverage }) => ({ phase, step, coverage })))}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});
