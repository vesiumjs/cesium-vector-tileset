import type { FillLayerSpecification, StyleSpecification, VectorSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    switchCoverage: number[][];
    stopSwitchCoverage: () => void;
    lifecycleTileset: import('../packages/cesium-vector-tileset/src/cesium-vector-tileset').CesiumVectorTileset;
    lifecycleParent: import('cesium').PrimitiveCollection;
  }
}
interface OpenOptions {
  extent?: number;
  mode?: string;
  published?: boolean;
  initialStyle?: StyleSpecification;
  tileDelayMs?: number;
  expected?: number[];
}

const tile = fromGeojsonVt({ land: { features: [{
  type: 3,
  geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
  tags: { shade: '#3366aa' },
}] } }, { version: 2, extent: 4096 });
const blue = [51, 102, 170];
const green = [34, 170, 85];

function style(baseUrl: string, color: NonNullable<FillLayerSpecification['paint']>['fill-color'] = '#3366aa', source = 'a'): StyleSpecification & { sources: { land: VectorSourceSpecification } } {
  return {
    version: 8,
    sources: { land: { type: 'vector', tiles: [`${baseUrl}/lifecycle/${source}/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
    layers: [{ 'id': 'land', 'type': 'fill', 'source': 'land', 'source-layer': 'land', 'paint': { 'fill-color': color, 'fill-antialias': false } }],
  };
}

function gradientStyle(baseUrl: string, reference = false): StyleSpecification {
  const next = style(baseUrl, '#22aa55');
  const candidate: StyleSpecification = {
    ...next,
    sources: {
      ...next.sources,
      route: {
        type: 'geojson',
        lineMetrics: true,
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-0.1676, 51.5072], [-0.1276, 51.5072], [-0.0876, 51.5072]] } },
      },
    },
    layers: [...next.layers, {
      id: 'route',
      type: 'line',
      source: 'route',
      paint: { 'line-width': 16, 'line-color': '#ff00ff', 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, '#0000ff'] },
    }],
  };
  if (reference) {
    // The upstream validator accepts legacy ref layers loaded from JSON even
    // though its current TypeScript layer union requires an explicit type.
    const layer = candidate.layers[1];
    Reflect.deleteProperty(layer, 'type');
    Reflect.deleteProperty(layer, 'source');
    Reflect.set(layer, 'ref', 'route-base');
    candidate.layers.splice(1, 0, { id: 'route-base', type: 'line', source: 'route' });
  }
  return candidate;
}

async function open(page: Page, baseUrl: string, { extent = 4096, mode = '3d', published = false, initialStyle, tileDelayMs = 0, expected = blue }: OpenOptions = {}) {
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/lifecycle/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.endsWith('/unavailable.json'))
      return route.fulfill({ status: 503, body: 'fixture unavailable' });
    if (url.endsWith('.pbf')) {
      const delay = tileDelayMs || (url.includes('/lifecycle/b/') ? 150 : 0);
      if (delay)
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      const body = extent === 4096 ? tile : fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [extent, 0], [extent, extent], [0, extent], [0, 0]]], tags: {} }] } }, { version: 2, extent });
      return route.fulfill({ body: Buffer.from(body), contentType: 'application/x-protobuf' });
    }
    return route.fulfill({ json: initialStyle ?? style(baseUrl) });
  });
  const query = new URLSearchParams({ style: `${baseUrl}/lifecycle/style.json`, synthetic: String(extent), mode });
  if (published)
    query.set('published', '1');
  await page.goto(`${baseUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.stats().bucket.tiles ?? 0)).toBeGreaterThan(0);
  if (expected)
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), expected)).toBeGreaterThanOrEqual(0.98);
  return { errors, requests };
}

test('zoom replacement keeps framebuffer coverage', async ({ page, renderUrl }, testInfo) => {
  // Match the Cesium half of the side-by-side reference fixture without
  // requiring MapLibre's renderer to be part of this regression loop.
  await page.setViewportSize({ width: 640, height: 720 });
  const { errors } = await open(page, renderUrl, { extent: 64 });
  // Preserve every rendered frame: checking after a zoom has settled misses a
  // one-frame hole while newly uploaded children replace the parent coverage.
  const samples = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const samples = [];
    let direction = 'in';
    let step = 0;
    const rectangles = globe => globe._surface._tilesToRender.map(tile => ({ level: tile.level, x: tile.x, y: tile.y, rectangle: { ...tile.rectangle } }));
    let previousGlobe;
    const removePreRender = validation.viewer.scene.preRender.addEventListener(() => {
      previousGlobe = rectangles(validation.viewer.scene.globe);
    });
    const remove = validation.viewer.scene.postRender.addEventListener(() => {
      const tileset = validation.tileset;
      const coverage = validation.readCoverage();
      const sample: { direction: string; step: number; time: number; zoom: number; coverage: number[]; stats: ReturnType<typeof tileset.stats>; diagnostic?: unknown } = { direction, step, time: performance.now(), zoom: validation.zoom, coverage, stats: tileset.stats() };
      if (coverage.some(ratio => ratio < 0.98)) {
        const collections = collection => ({ show: collection.show, length: collection.length, destroyed: collection.isDestroyed() });
        sample.diagnostic = {
          previousGlobe,
          currentGlobe: rectangles(validation.viewer.scene.globe),
          sources: Object.entries(tileset._renderer.style.tilePyramids).map(([id, pyramid]) => ({
            id,
            ideal: pyramid._covering?.idealTileIDs.map(tile => tile.toString()),
            renderable: pyramid.getRenderableIds(),
          })),
          live: [...tileset._renderer.vector.collections].map(([id, collection]) => ({ id, ...collections(collection) })),
          retired: tileset._renderer.vector.retiredCollections.map(collections),
          held: [...tileset._renderer.residency._sources].map(([id, source]) => ({ id, tiles: [...source.held] })),
          hiddenSurfaceLayers: [...tileset._renderer.residency.hiddenSurfaceLayers].map(([tileId, layers]) => ({ tileId, layers: [...layers] })),
          jobs: [...tileset._renderer.publishQueue._jobs.values()].map(job => ({ tileId: job.tileId, surfaces: job.surfaces, symbols: job.symbols })),
          firstUpdates: tileset._renderer.collections._firstUpdates.flatMap(queue => [...queue].map(([collection, update]) => ({ ...collections(collection), index: update.index }))),
        };
      }
      samples.push(sample);
    });
    try {
      for (direction of ['in', 'out']) {
        for (step = 0; step < 12; step++) {
          const camera = validation.viewer.camera;
          const distance = camera.positionCartographic.height * 0.1;
          if (direction === 'in')
            camera.zoomIn(distance);
          else camera.zoomOut(distance);
          validation.viewer.scene.requestRender();
          await new Promise<void>(resolve => setTimeout(resolve, 100));
        }
      }
      return samples;
    }
    finally {
      remove();
      removePreRender();
    }
  });
  const frameCoverage = testInfo.outputPath('frame-coverage.json');
  await writeFile(frameCoverage, JSON.stringify(samples, null, 2));
  await testInfo.attach('frame-coverage', { path: frameCoverage, contentType: 'application/json' });
  assert.ok(samples.length >= 24, `only ${samples.length} rendered frames during 24 camera steps`);
  const gaps = samples.filter(sample => sample.coverage.some(ratio => ratio < 0.98));
  assert.equal(gaps.length, 0, `framebuffer gaps: ${JSON.stringify(gaps.map(({ direction, step, zoom, coverage, stats }) => ({ direction, step, zoom, coverage, pending: stats.pendingPublishes })))}`);
  assert.deepEqual(errors, []);
});

test('published ESM entry loads its bundled worker and draws MVT pixels', async ({ page, renderUrl }) => {
  const moduleRequests = [];
  page.on('request', request => moduleRequests.push(request.url()));
  const { errors } = await open(page, renderUrl, { published: true });
  assert.ok(moduleRequests.some(url => url.includes('/dist/index.mjs')), 'the browser did not consume the published ESM entry');
  assert.ok(moduleRequests.some(url => url.includes('/dist/worker.mjs')), 'the published entry did not load its bundled worker');
  assert.deepEqual(errors, []);
});

test('public style and source switches draw the new pixels without empty frames', async ({ page, renderUrl }, testInfo) => {
  const { errors, requests } = await open(page, renderUrl);
  await expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const before = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.viewer.scene.globe.tilesLoaded && validation.renderedFrames === before;
  })).toBe(true);
  const initialTileRequests = requests.filter(url => url.endsWith('.pbf')).length;
  async function switchStyle(next, expected, name) {
    await page.evaluate(({ next, blue, green }) => {
      const validation = window.renderValidation;
      window.switchCoverage = [];
      window.stopSwitchCoverage = validation.viewer.scene.postRender.addEventListener(() => {
        const previous = validation.readCoverage(blue);
        const current = validation.readCoverage(green);
        window.switchCoverage.push(previous.map((ratio, index) => ratio + current[index]));
      });
      validation.tileset.setStyle(next);
    }, { next, blue, green });
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), expected)).toBeGreaterThanOrEqual(0.98);
    const samples = await page.evaluate(() => {
      window.stopSwitchCoverage();
      return window.switchCoverage;
    });
    await testInfo.attach(`${name}-coverage`, { body: JSON.stringify(samples), contentType: 'application/json' });
    assert.ok(samples.length > 0, `${name}: no rendered frames were sampled`);
    assert.ok(samples.every(rows => rows.every(ratio => ratio >= 0.98)), `${name}: pixels disappeared during style replacement: ${JSON.stringify(samples)}`);
  }
  await switchStyle(style(renderUrl, '#22aa55'), green, 'paint');
  assert.equal(requests.filter(url => url.endsWith('.pbf')).length, initialTileRequests, 'paint-only style changes reloaded tile data');
  // Switching between constant and feature-derived color changes the worker
  // binders. Retain the old surface until that rebuilt generation can draw.
  await switchStyle(style(renderUrl, ['get', 'shade']), blue, 'feature-color');
  await switchStyle(style(renderUrl, '#22aa55'), green, 'constant-color');
  await switchStyle(style(renderUrl, '#3366aa', 'b'), blue, 'source');
  await expect.poll(() => requests.filter(url => url.includes('/lifecycle/b/') && url.endsWith('.pbf')).length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await page.evaluate(() => window.renderValidation.tileset.setStyle({
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#22aa55' } }],
  }));
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), green)).toBeGreaterThanOrEqual(0.98);
  const removedSource = await page.evaluate(() => window.renderValidation.tileset.stats());
  assert.equal(removedSource.bucket.tiles, 0, 'a removed source retained vector tiles');
  assert.equal(removedSource.symbol.tiles, 0, 'a removed source retained symbol tiles');
  assert.equal(removedSource.featureIndexes, 0, 'a removed source retained feature indices');
  assert.equal(removedSource.gpuMemory.entries, 0, 'a removed source retained GPU residency');
  await page.evaluate((json) => {
    const style: StyleSpecification = JSON.parse(json);
    window.renderValidation.tileset.setStyle(style);
  }, JSON.stringify(style(renderUrl)));
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  for (const reference of [false, true]) {
    const unsupported = gradientStyle(renderUrl, reference);
    assert.deepEqual(validateStyleMin(unsupported), [], 'the capability check must use a valid MapLibre style');
    const rejected = await page.evaluate((json) => {
      const next: StyleSpecification = JSON.parse(json);
      const tileset = window.renderValidation.tileset;
      const previous = JSON.stringify(tileset.styleSpec);
      const failures: string[] = [];
      const remove = tileset.errorEvent.addEventListener(error => failures.push(error.message));
      try {
        tileset.setStyle(next);
        return { failures, previous, current: JSON.stringify(tileset.styleSpec) };
      }
      finally {
        remove();
      }
    }, JSON.stringify(unsupported));
    assert.equal(rejected.failures.length, 1, 'an unsupported gradient was silently accepted');
    assert.ok(rejected.failures[0].startsWith(`layers[${unsupported.layers.length - 1}].paint.line-gradient:`));
    assert.match(rejected.failures[0], /not supported/);
    assert.equal(rejected.current, rejected.previous, 'a rejected style mutated the public style');
    await page.evaluate(() => new Promise<void>((resolve) => {
      const scene = window.renderValidation.viewer.scene;
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
      scene.requestRender();
    }));
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  }
  assert.deepEqual(errors, []);
});

test('unsupported and unavailable styles reject without disrupting a loaded scene', async ({ page, renderUrl }) => {
  const { errors } = await open(page, renderUrl);
  for (const reference of [false, true]) {
    const unsupported = gradientStyle(renderUrl, reference);
    assert.deepEqual(validateStyleMin(unsupported), []);
    const unsupportedFailure = await page.evaluate(async (json) => {
      const next: StyleSpecification = JSON.parse(json);
      const Constructor = window.renderValidation.tileset.constructor as typeof import('../packages/cesium-vector-tileset/src/cesium-vector-tileset').CesiumVectorTileset;
      const candidate = new Constructor({ style: next });
      try {
        await candidate.whenReady();
        return null;
      }
      catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      finally {
        candidate.destroy();
      }
    }, JSON.stringify(unsupported));
    assert.match(unsupportedFailure, /paint\.line-gradient: .*not supported/);
  }
  const failure = await page.evaluate(async (url) => {
    try {
      const candidate = await (window.renderValidation.tileset.constructor as typeof import('../packages/cesium-vector-tileset/src/cesium-vector-tileset').CesiumVectorTileset).fromUrl(url);
      candidate.destroy();
      return null;
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, `${renderUrl}/lifecycle/unavailable.json`);
  assert.match(failure, /503/);
  const coverage = await page.evaluate(color => window.renderValidation.readCoverage(color), blue);
  assert.ok(coverage.every(ratio => ratio >= 0.98), 'a failed load disrupted the existing primitive');
  assert.deepEqual(errors, []);
});

test('settled demand rendering stops frames and destruction releases the primitive', async ({ page, renderUrl }) => {
  const { errors } = await open(page, renderUrl);
  await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.stats().pendingPublishes)).toBe(0);
  // Two consecutive quiet intervals distinguish a settled scene from a brief
  // gap between asynchronous tile uploads.
  await expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const before = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.renderedFrames - before;
  })).toBe(0);
  const quiet = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const before = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.renderedFrames - before;
  });
  assert.equal(quiet, 0, 'the idle scene continued to render');
  const destroyed = await page.evaluate(async () => {
    const { viewer, tileset } = window.renderValidation;
    viewer.scene.primitives.remove(tileset);
    viewer.scene.requestRender();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    return { destroyed: tileset.isDestroyed(), attached: viewer.scene.primitives.contains(tileset), coverage: window.renderValidation.readCoverage() };
  });
  assert.equal(destroyed.destroyed, true);
  assert.equal(destroyed.attached, false);
  assert.ok(destroyed.coverage.every(ratio => ratio < 0.01), 'destroyed primitive left rendered vector pixels');
  assert.deepEqual(errors, []);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.stats().bucket.tiles ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
});

test('adding, hiding, showing and removing a tileset wakes a settled demand scene', async ({ page, renderUrl }) => {
  const { errors } = await open(page, renderUrl);
  const idle = async () => expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const before = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.viewer.scene.globe.tilesLoaded && validation.renderedFrames === before;
  })).toBe(true);
  // Establish an empty, idle scene before creating the next primitive. This
  // explicit setup frame must not help that primitive render after insertion.
  await page.evaluate(() => {
    const { viewer, tileset } = window.renderValidation;
    viewer.scene.primitives.remove(tileset);
    viewer.scene.requestRender();
  });
  await idle();
  await page.evaluate(async (url) => {
    const Constructor = window.renderValidation.tileset.constructor as typeof import('../packages/cesium-vector-tileset/src/cesium-vector-tileset').CesiumVectorTileset;
    const candidate = await Constructor.fromUrl(url);
    window.lifecycleTileset = candidate;
    window.renderValidation.viewer.scene.primitives.add(candidate);
  }, `${renderUrl}/lifecycle/style.json`);
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await idle();
  await page.evaluate(() => {
    window.lifecycleTileset.show = false;
  });
  await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeLessThan(0.01);
  await idle();
  await page.evaluate(() => {
    window.lifecycleTileset.show = true;
  });
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await idle();
  await page.evaluate(() => {
    window.renderValidation.viewer.scene.primitives.remove(window.lifecycleTileset);
  });
  await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeLessThan(0.01);
  assert.equal(await page.evaluate(() => window.lifecycleTileset.isDestroyed()), true);
  await idle();
  const initiallyHidden = await page.evaluate(async (url) => {
    const Constructor = window.lifecycleTileset.constructor as typeof import('../packages/cesium-vector-tileset/src/cesium-vector-tileset').CesiumVectorTileset;
    const candidate = await Constructor.fromUrl(url, { show: false });
    window.lifecycleTileset = candidate;
    window.renderValidation.viewer.scene.primitives.add(candidate);
    return { ready: candidate.ready, show: candidate.show };
  }, `${renderUrl}/lifecycle/style.json`);
  assert.deepEqual(initiallyHidden, { ready: true, show: false });
  await idle();
  assert.equal(await page.evaluate(() => window.lifecycleTileset.stats().renderableTiles), 0);
  assert.ok((await page.evaluate(color => window.renderValidation.readCoverage(color), blue)).every(ratio => ratio < 0.01));
  await page.evaluate(() => {
    window.lifecycleTileset.show = true;
  });
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await page.evaluate(() => {
    window.renderValidation.viewer.scene.primitives.remove(window.lifecycleTileset);
  });
  await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeLessThan(0.01);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});

test('retained removal and reinsertion wake a settled scene without destroying the tileset', async ({ page, renderUrl }) => {
  const { errors } = await open(page, renderUrl);
  const idle = async () => expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const before = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.viewer.scene.globe.tilesLoaded && validation.renderedFrames === before;
  })).toBe(true);
  await idle();
  await page.evaluate(() => {
    const { viewer, tileset } = window.renderValidation;
    viewer.scene.primitives.destroyPrimitives = false;
    viewer.scene.primitives.remove(tileset);
  });
  await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeLessThan(0.01);
  assert.equal(await page.evaluate(() => window.renderValidation.tileset.isDestroyed()), false);
  await idle();
  await page.evaluate(() => window.renderValidation.viewer.scene.primitives.add(window.renderValidation.tileset));
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await idle();
  await page.evaluate(() => {
    const { viewer, tileset } = window.renderValidation;
    const Collection = Object.getPrototypeOf(tileset.constructor) as typeof import('cesium').PrimitiveCollection;
    const parent = new Collection({ destroyPrimitives: false });
    viewer.scene.primitives.remove(tileset);
    parent.add(tileset);
    viewer.scene.primitives.add(parent);
    window.lifecycleParent = parent;
  });
  await idle();
  await page.evaluate(() => window.renderValidation.viewer.scene.primitives.remove(window.lifecycleParent));
  await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeLessThan(0.01);
  assert.equal(await page.evaluate(() => window.renderValidation.tileset.isDestroyed()), false);
  await idle();
  await page.evaluate(() => window.renderValidation.viewer.scene.primitives.add(window.lifecycleParent));
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await idle();
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});

test('transparent parent and child tile replacement keeps each pixel at a single opacity', async ({ page, renderUrl }, testInfo) => {
  const initialStyle = style(renderUrl);
  initialStyle.sources.land.maxzoom = 14;
  initialStyle.layers[0].paint['fill-opacity'] = 0.5;
  initialStyle.layers.unshift({ id: 'background', type: 'background', paint: { 'background-color': '#aa2222' } });
  const { errors, requests } = await open(page, renderUrl, { initialStyle, tileDelayMs: 150, expected: null });
  await expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const frames = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.renderedFrames === frames && validation.viewer.scene.globe.tilesLoaded && validation.tileset.tilesLoaded;
  }), { timeout: 60_000 }).toBe(true);
  const baseline = await page.evaluate(() => window.renderValidation.readPixelSamples());
  const output = testInfo.outputPath('transparent-parent-child-pixels.json');
  await writeFile(output, JSON.stringify({ baseline }, null, 2));
  const color = baseline[1][1].slice(0, 3);
  assert.ok(color[0] > blue[0] + 15 && color[0] < 170 - 15
    && color[2] > 34 + 15 && color[2] < blue[2] - 15, `the initial fill was not visibly translucent: ${JSON.stringify(baseline)}`);
  assert.ok(baseline.every(row => row.every(pixel => pixel.slice(0, 3).every((channel, index) => Math.abs(channel - color[index]) <= 5))), `the settled initial pixels already overlap: ${JSON.stringify(baseline)}`);
  const initialCoverage = await page.evaluate(color => window.renderValidation.readCoverage(color), color);
  assert.ok(initialCoverage.every(ratio => ratio >= 0.98), `the settled initial framebuffer was not uniform: ${JSON.stringify(initialCoverage)}`);
  const beforeRequests = requests.filter(url => url.endsWith('.pbf')).length;
  const frames = await page.evaluate(async (color) => {
    const validation = window.renderValidation;
    const frames = [];
    let step = 0;
    const remove = validation.viewer.scene.postRender.addEventListener(() => {
      const coverage = validation.readCoverage(color);
      const pixels = validation.readPixelSamples();
      const frame: { step: number; coverage: number[]; pixels: number[][][]; diagnostic?: unknown } = { step, coverage, pixels };
      if (coverage.some(ratio => ratio < 0.98)) {
        const tileset = validation.tileset;
        frame.diagnostic = {
          stats: tileset.stats(),
          sources: Object.entries(tileset._renderer.style.tilePyramids).map(([id, pyramid]) => ({ id, ideal: pyramid._covering.idealTileIDs.map(tile => tile.toString()), renderable: pyramid.getRenderableIds() })),
          live: [...tileset._renderer.vector.collections].map(([id, collection]) => ({ id, show: collection.show })),
          held: [...tileset._renderer.residency._sources].map(([id, source]) => ({ id, tiles: [...source.held] })),
          jobs: [...tileset._renderer.publishQueue._jobs.values()].map(job => ({ tileId: job.tileId, surfaces: job.surfaces, symbols: job.symbols })),
        };
      }
      frames.push(frame);
    });
    try {
      for (step = 0; step < 8; step++) {
        const camera = validation.viewer.camera;
        camera.zoomIn(camera.positionCartographic.height * 0.15);
        validation.viewer.scene.requestRender();
        await new Promise<void>(resolve => setTimeout(resolve, 60));
      }
      for (step = 8; step < 38; step++)
        await new Promise<void>(resolve => setTimeout(resolve, 60));
      return frames;
    }
    finally {
      remove();
    }
  }, color);
  await writeFile(output, JSON.stringify({ baseline, frames }, null, 2));
  await testInfo.attach('transparent-parent-child-pixels', { path: output, contentType: 'application/json' });
  assert.ok(requests.filter(url => url.endsWith('.pbf')).length > beforeRequests, 'the zoom did not request child tiles');
  assert.ok(frames.length > 0, 'the zoom produced no rendered frames');
  const changed = frames.filter(frame => frame.coverage.some(ratio => ratio < 0.98)
    || frame.pixels.some((row, rowIndex) => row.some((pixel, pixelIndex) => pixel.slice(0, 3).some((channel, channelIndex) => Math.abs(channel - baseline[rowIndex][pixelIndex][channelIndex]) > 5))));
  assert.equal(changed.length, 0, `transparent tile pixels changed during parent/child replacement: ${JSON.stringify(changed.map(({ step, coverage, pixels }) => ({ step, coverage, pixels })))}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});
