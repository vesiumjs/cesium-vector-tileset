import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createCanvas, loadImage } from 'canvas';

import { fromGeojsonVt, test } from './fixtures';

interface RenderScenario { name: string; view: string; synthetic?: string; mode?: string; symbols?: string; lines?: string; dpr?: string; scale?: string; style?: string }

const cases: RenderScenario[] = [
  { name: 'coverage-3d', view: 'london', synthetic: '64' },
  { name: 'coverage-2d', view: 'tokyo', mode: '2d', synthetic: '8192' },
  { name: 'coverage-cv', view: 'london', mode: 'cv', synthetic: '4096' },
  { name: 'coverage-dateline', view: 'antimeridian', mode: '2d', synthetic: '64' },
  { name: 'symbols-dateline', view: 'antimeridian', mode: '2d', synthetic: '64', symbols: '1' },
  { name: 'lines-dateline', view: 'antimeridian', mode: '2d', synthetic: '64', lines: '1' },
  { name: 'lines-3d-dateline', view: 'antimeridian', mode: '3d', synthetic: '64', lines: '1' },
  { name: 'lines-cv', view: 'london', mode: 'cv', synthetic: '4096', lines: '1' },
  { name: 'lines-cv-retina', view: 'london', mode: 'cv', synthetic: '4096', lines: '1', dpr: '2' },
  { name: 'london-3d', view: 'london' },
  { name: 'new-york-3d', view: 'newYork', scale: '2' },
  { name: 'shanghai-3d', view: 'shanghai', scale: '0.5' },
  { name: 'london-cv', view: 'london', mode: 'cv' },
  { name: 'hawaii-low', view: 'hawaii', scale: '256' },
  { name: 'hawaii-mid', view: 'hawaii', scale: '64' },
  { name: 'beibu-3d', view: 'beibu', scale: '2' },
];

// Reproduced with the unmodified upstream style/MVT and MapLibre featureFilter
// on 2026-10-01; see docs/research/cesium-and-public-mvt.md. Keep unknown
// warnings fatal and retain every warning in the measurement attachments.
const upstreamReferenceWarnings = new Set([
  'highway-shield-non-us',
  'highway-shield-us-interstate',
  'road_shield_us',
].map(id => `layers[${id}].filter[1]: Expected value to be of type number, but found null instead. Falling back to false.`));

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 };
}
async function screenshotPixels(file) {
  const screenshot = await loadImage(file);
  const canvas = createCanvas(screenshot.width, screenshot.height);
  const context = canvas.getContext('2d');
  context.drawImage(screenshot, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return { pixels, width: canvas.width, height: canvas.height };
}
async function checkSymbols(page, file) {
  const shown = await screenshotPixels(file);
  const hiddenFile = file.replace('.png', '-without-symbols.png');
  try {
    await page.evaluate(() => window.renderValidation.setSymbolsVisible(false));
    await page.screenshot({ path: hiddenFile });
  }
  finally {
    await page.evaluate(() => window.renderValidation.setSymbolsVisible(true));
  }
  const hidden = await screenshotPixels(hiddenFile);
  let changedPixels = 0;
  // Inspect the Cesium half, excluding the attribution at the bottom.
  for (let y = 20; y < shown.height - 40; y++) {
    for (let x = 20; x < shown.width / 2 - 20; x++) {
      const offset = (y * shown.width + x) * 4;
      if ([0, 1, 2].some(channel => Math.abs(shown.pixels[offset + channel] - hidden.pixels[offset + channel]) > 10))
        changedPixels++;
    }
  }
  assert.ok(changedPixels > 100, `${path.basename(file)}: symbols produced only ${changedPixels} visible pixels`);
  return changedPixels;
}
async function checkDash(file) {
  const { pixels, width, height } = await screenshotPixels(file);
  const halfWidth = width / 2;
  const periods = [0, 1].map((half) => {
    const white = (x, y) => {
      const pixel = (y * width + x) * 4;
      return pixels[pixel] > 245 && pixels[pixel + 1] > 245 && pixels[pixel + 2] > 245;
    };
    let bestX = 0;
    let bestCount = 0;
    for (let x = half * halfWidth + 20; x < (half + 1) * halfWidth - 20; x++) {
      let count = 0;
      for (let y = 10; y < height - 50; y++) {
        if (white(x, y))
          count++;
      }
      if (count > bestCount) {
        bestX = x;
        bestCount = count;
      }
    }
    const starts = [];
    let wasWhite = false;
    for (let y = 10; y < height - 50; y++) {
      const isWhite = white(bestX, y);
      if (isWhite && !wasWhite)
        starts.push(y);
      wasWhite = isWhite;
    }
    const lengths = starts.slice(1).map((start, index) => start - starts[index]).sort((a, b) => a - b);
    assert.ok(lengths.length >= 3, `${file}: no repeated dash pattern in half ${half}`);
    return lengths[Math.floor(lengths.length / 2)];
  });
  assert.ok(Math.abs(periods[0] - periods[1]) <= 1, `${file}: dash period differs from MapLibre (${periods})`);
  return periods;
}
async function checkOcean(file) {
  const { pixels, width, height } = await screenshotPixels(file);
  const half = width / 2;
  let water = 0;
  let exposedPark = 0;
  for (let y = 10; y < height - 30; y++) {
    for (let x = 10; x < half - 10; x++) {
      const reference = (y * width + x + half) * 4;
      const actual = (y * width + x) * 4;
      if (pixels[reference] === 158 && pixels[reference + 1] === 189 && pixels[reference + 2] === 255) {
        water++;
        if (pixels[actual] > 200 && pixels[actual + 1] > 200 && pixels[actual + 2] < 240)
          exposedPark++;
      }
    }
  }
  const mismatch = exposedPark / water;
  assert.ok(water > 10000 && mismatch < 0.005, `${file}: protected areas leaked through ocean (${(mismatch * 100).toFixed(2)}%)`);
  return { water, exposedPark, mismatch };
}

for (const scenario of cases) {
  test.describe(() => {
    test.use({ deviceScaleFactor: Number(scenario.dpr ?? 1) });
    test(scenario.name, { tag: scenario.synthetic ? '@deterministic' : '@live' }, async ({ page, renderUrl }, testInfo) => {
      if (!scenario.synthetic)
        test.setTimeout(240000);
      const output = testInfo.outputDir;
      const baseUrl = renderUrl;
      const errors = [];
      const expressionWarnings = [];
      const unavailableTiles = [];
      let profiler;
      page.on('pageerror', error => errors.push((error instanceof Error ? error.message : String(error))));
      page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('Expected value to be of type'))
          expressionWarnings.push(message.text());
      });
      page.on('response', (response) => {
        if (response.status() === 404 && response.url().includes('.pbf'))
          unavailableTiles.push(response.url());
      });
      try {
        const query = new URLSearchParams({ compare: '1', ...scenario });
        if (scenario.synthetic) {
          const extent = Number(scenario.synthetic);
          const layers: Parameters<typeof fromGeojsonVt>[0] = { land: { features: [{ type: 3, geometry: [
            [[0, 0], [extent, 0], [extent, extent], [0, extent], [0, 0]],
          ], tags: {} }] } };
          if (scenario.symbols) {
            layers.labels = { features: Array.from({ length: 400 }, (_, index) => ({
              type: 1,
              geometry: [[(index % 20 + 0.5) * extent / 20, (Math.floor(index / 20) + 0.5) * extent / 20]],
              tags: {},
            })) };
          }
          if (scenario.lines) {
            layers.roads = { features: [
              { type: 2, geometry: [[[0, extent / 2], [extent / 2, extent / 2], [extent, extent / 2]]], tags: { kind: 'solid' } },
              { type: 2, geometry: [[[extent / 2, 0], [extent / 2, extent / 2], [extent / 2, extent]]], tags: { kind: 'dash' } },
            ] };
          }
          const tile = fromGeojsonVt(layers, { version: 2, extent });
          const style: StyleSpecification = {
            version: 8,
            sources: { synthetic: { type: 'vector', tiles: [`${baseUrl}/render-synthetic/tile/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
            layers: [{ 'id': 'basecolor', 'type': 'fill', 'source': 'synthetic', 'source-layer': 'land', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } }],
          };
          const sprite = createCanvas(8, 8);
          const spriteContext = sprite.getContext('2d');
          spriteContext.fillStyle = '#fff';
          spriteContext.fillRect(0, 0, 8, 8);
          if (scenario.symbols) {
            style.sprite = `${baseUrl}/render-synthetic/sprite`;
            style.layers.push({ 'id': 'labels', 'type': 'symbol', 'source': 'synthetic', 'source-layer': 'labels', 'layout': { 'icon-image': 'label' } });
          }
          if (scenario.lines) {
            for (const kind of ['solid', 'dash']) {
              style.layers.push({
                'id': kind,
                'type': 'line',
                'source': 'synthetic',
                'source-layer': 'roads',
                'filter': ['==', ['get', 'kind'], kind],
                'layout': { 'line-cap': 'round', 'line-join': 'round' },
                'paint': { 'line-color': '#ffffff', 'line-width': 8, ...(kind === 'dash' ? { 'line-dasharray': [3, 1] } : {}) },
              });
            }
          }
          await page.route('**/render-synthetic/**', (route) => {
            const url = route.request().url();
            if (url.endsWith('.pbf'))
              return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
            if (url.endsWith('sprite.png'))
              return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
            if (url.endsWith('sprite.json'))
              return route.fulfill({ json: { label: { x: 0, y: 0, width: 8, height: 8, pixelRatio: 1 } } });
            return route.fulfill({ json: style });
          });
          query.set('style', `${baseUrl}/render-synthetic/style.json`);
        }
        await page.goto(`${baseUrl}/e2e/fixtures/render-fixture.html?${query}`, { waitUntil: 'domcontentloaded' });
        const settled = async () => {
          await page.waitForFunction(() => {
            const validation = window.renderValidation;
            const stats = validation?.tileset.stats();
            return validation?.renderErrors.length || (stats && stats.bucket.tiles > 0 && stats.pendingPublishes === 0
              && validation.tileset._sceneCollections.pendingFirstUpdateCount === 0
              && !validation.tileset._symbolRenderer.hasPendingWork
              && validation.viewer.scene.globe.tilesLoaded);
          }, undefined, { timeout: 60000 });
          assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), [], `${scenario.name}: Cesium render stopped`);
        };
        await settled();
        await page.waitForTimeout(1000);
        await page.evaluate(() => window.renderValidation.syncReference());
        await page.waitForFunction(() => window.renderValidation.reference.loaded(), undefined, { timeout: 60000 });
        await page.screenshot({ path: path.join(output, `${scenario.name}-initial.png`) });
        const initial = await page.evaluate(() => ({ zoom: window.renderValidation.zoom, stats: window.renderValidation.tileset.stats() }));
        if (scenario.lines) {
          const uploads = await page.evaluate(() => {
            const tileset = window.renderValidation.tileset;
            const bucket = tileset._vectorRenderer;
            const primitives = [
              ...bucket.tileIds.flatMap(tileId => bucket.getTileCollections(tileId)
                .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => {
                  const entry = (collection as PrimitiveCollection).get(index);
                  return entry.primitive ?? entry;
                }))),
              ...[...tileset._patternRenderer._tiles.values()].flatMap(entries => entries.map(entry => entry.primitive)),
            ];
            return [...new Set(primitives)].filter(primitive => primitive.ready && primitive.positionTexture).flatMap((primitive) => {
              const names = new Map(Object.entries(primitive._attributeLocations).map(([name, location]) => [location, name]));
              return primitive._va.map(array => ({
                attributes: Array.from({ length: array.numberOfAttributes }, (_, attribute) => names.get(array.getAttribute(attribute).index)),
                layout: Object.fromEntries(Array.from({ length: array.numberOfAttributes }, (_, index) => {
                  const attribute = array.getAttribute(index);
                  return [names.get(attribute.index), {
                    componentDatatype: attribute.componentDatatype,
                    components: attribute.componentsPerAttribute,
                    normalize: attribute.normalize,
                  }];
                })),
                vertices: array.numberOfVertices,
                positionTexture: {
                  pixelFormat: primitive.positionTexture.pixelFormat,
                  pixelDatatype: primitive.positionTexture.pixelDatatype,
                  width: primitive.positionTexture.width,
                  height: primitive.positionTexture.height,
                  bytes: primitive.positionTexture.sizeInBytes,
                  destroyed: primitive.positionTexture.isDestroyed(),
                },
                vertexBytes: [...new Set(Array.from({ length: array.numberOfAttributes }, (_, attribute) => array.getAttribute(attribute).vertexBuffer))]
                  .reduce((bytes, buffer) => bytes + (buffer?.sizeInBytes ?? 0), 0),
              }));
            });
          });
          assert.ok(uploads.length > 0, `${scenario.name}: no real line uploads were inspected`);
          assert.ok(uploads.some(upload => upload.attributes.includes('a_linesofar')), `${scenario.name}: dashed uploads were not inspected`);
          for (const upload of uploads) {
            assert.deepEqual(upload.layout.a_lineRecord, { componentDatatype: 5126, components: 1, normalize: false }, `${scenario.name}: Native VA did not retain exact position record IDs`);
            for (const name of ['position2DHigh', 'position2DLow', 'position3DHigh', 'position3DLow', 'prevOffset', 'nextOffset', 'a_cornerParam'])
              assert.ok(!upload.attributes.includes(name), `${scenario.name}: line uploaded redundant positions or corner parameters (${name})`);
            assert.deepEqual(upload.layout.a_lineFlags, { componentDatatype: 5121, components: 1, normalize: false }, `${scenario.name}: Native VA did not retain byte line roles`);
            assert.deepEqual(upload.layout.batchId, { componentDatatype: 5123, components: 1, normalize: false }, `${scenario.name}: Native VA did not retain exact unsigned 16-bit instance IDs`);
            assert.equal(upload.vertexBytes / upload.vertices, upload.attributes.includes('a_linesofar') ? 35 : 7, `${scenario.name}: vertex buffer capacity differs from its record layout`);
            const texture = upload.positionTexture;
            assert.ok(texture.width > 0 && texture.height > 0 && !texture.destroyed, `${scenario.name}: Native position texture is unavailable`);
            assert.equal(texture.pixelFormat, 36249, `${scenario.name}: Native position texture must use RGBA_INTEGER`);
            assert.equal(texture.pixelDatatype, 5125, `${scenario.name}: Native position texture must use UNSIGNED_INT`);
            assert.equal(texture.bytes, texture.width * texture.height * 16, `${scenario.name}: actual position texture capacity differs from RGBA32UI storage`);
          }
          await writeFile(path.join(output, 'line-uploads.json'), JSON.stringify(uploads, null, 2));
        }
        const symbolPixels = [];
        const symbolsExpected = async () => scenario.symbols || (!scenario.synthetic && await page.evaluate(() => {
          const reference = window.renderValidation.reference;
          const canvas = reference.getCanvas();
          return reference.queryRenderedFeatures([[20, 20], [canvas.clientWidth - 20, canvas.clientHeight - 40]])
            .some(feature => feature.layer.type === 'symbol');
        }));
        if (await symbolsExpected())
          symbolPixels.push(await checkSymbols(page, path.join(output, `${scenario.name}-initial.png`)));
        const ocean = [];
        const dash = [];
        const checkDashCoverage = scenario.lines && scenario.mode === 'cv';
        const checkOceanCoverage = scenario.view === 'hawaii' || scenario.view === 'beibu';
        if (checkOceanCoverage)
          ocean.push(await checkOcean(path.join(output, `${scenario.name}-initial.png`)));
        if (checkDashCoverage)
          dash.push(await checkDash(path.join(output, `${scenario.name}-initial.png`)));
        let linePaint;
        if (scenario.name === 'london-3d') {
          linePaint = await page.evaluate(() => window.renderValidation.probeLinePaint());
          assert.ok(linePaint.resources > 0 && linePaint.changedWidths > 0, '3D line widths froze during continuous zoom');
          assert.ok(linePaint.arraysStable, 'continuous zoom replaced uploaded line vertex arrays');
          assert.equal(linePaint.builds, 0, 'continuous zoom rebuilt static line geometry');
          await settled();
        }
        if (process.env.RENDER_PROFILE === '1') {
          profiler = await page.context().newCDPSession(page);
          await profiler.send('Profiler.enable');
          await profiler.send('Profiler.setSamplingInterval', { interval: 1000 });
          await profiler.send('Profiler.start');
        }
        await page.evaluate(async () => {
          const validation = window.renderValidation;
          validation.reset();
          // A fixed 2 cm pan spans several pixels at z21. Keep this probe
          // below a pixel at every scale; the following pan traverses tiles.
          const distance = Math.min(0.02, validation.viewer.camera.positionCartographic.height * 0.00001);
          for (let frame = 0; frame < 20; frame++) {
            validation.viewer.camera.moveRight(distance);
            validation.viewer.scene.requestRender();
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          }
        });
        const pan = await page.evaluate(() => structuredClone(window.renderValidation.measurements));
        assert.equal(pan.builds, 0, `${scenario.name}: tiny pans rebuilt static geometry`);
        assert.equal(pan.pyramidWalks, 0, `${scenario.name}: tiny pans reselected the same tile pyramid`);
        await page.evaluate(() => window.renderValidation.reset());
        for (const direction of ['in', 'out']) {
          for (let step = 0; step < 12; step++) {
            await page.evaluate((direction) => {
              const { viewer } = window.renderValidation;
              const distance = viewer.camera.positionCartographic.height * 0.1;
              if (direction === 'in')
                viewer.camera.zoomIn(distance);
              else viewer.camera.zoomOut(distance);
              viewer.scene.requestRender();
              window.renderValidation.syncReference();
            }, direction);
            await page.waitForTimeout(100);
            if (step % 3 === 2)
              await page.screenshot({ path: path.join(output, `${scenario.name}-zoom-${direction}-${step}.png`) });
          }
          await settled();
          await page.evaluate(() => window.renderValidation.syncReference());
          await page.waitForFunction(() => window.renderValidation.reference.loaded(), undefined, { timeout: 60000 });
          await page.screenshot({ path: path.join(output, `${scenario.name}-settled-${direction}.png`) });
          if (checkOceanCoverage)
            ocean.push(await checkOcean(path.join(output, `${scenario.name}-settled-${direction}.png`)));
          if (checkDashCoverage)
            dash.push(await checkDash(path.join(output, `${scenario.name}-settled-${direction}.png`)));
        }
        await page.evaluate(async () => {
          const { viewer } = window.renderValidation;
          const distance = viewer.camera.positionCartographic.height * 0.04;
          for (let step = 0; step < 12; step++) {
            viewer.camera.moveRight(distance);
            viewer.scene.requestRender();
            await new Promise<void>(resolve => setTimeout(resolve, 80));
          }
          for (let step = 0; step < 12; step++) {
            viewer.camera.moveLeft(distance);
            viewer.scene.requestRender();
            await new Promise<void>(resolve => setTimeout(resolve, 80));
          }
        });
        await settled();
        await page.evaluate(() => window.renderValidation.syncReference());
        await page.waitForFunction(() => window.renderValidation.reference.loaded(), undefined, { timeout: 60000 });
        await page.screenshot({ path: path.join(output, `${scenario.name}-final.png`) });
        if (checkOceanCoverage)
          ocean.push(await checkOcean(path.join(output, `${scenario.name}-final.png`)));
        if (checkDashCoverage)
          dash.push(await checkDash(path.join(output, `${scenario.name}-final.png`)));
        const dynamic = await page.evaluate(() => ({ measurements: window.renderValidation.measurements, coverage: window.renderValidation.coverage, zoom: window.renderValidation.zoom, stats: window.renderValidation.tileset.stats() }));
        if (await symbolsExpected())
          symbolPixels.push(await checkSymbols(page, path.join(output, `${scenario.name}-final.png`)));
        const symbolState = await page.evaluate(() => {
          const tileset = window.renderValidation.tileset;
          const symbol = tileset._symbolRenderer;
          return {
            held: [...tileset._tileResidency._sources].flatMap(([source, sync]) => [...sync.held].map(tileId => ({ source, tileId }))),
            tiles: [...symbol._tiles].map(([tileId, entry]) => ({
              tileId,
              placed: entry.placed,
              eligible: !symbol._excludedPlacementTiles?.has(tileId),
              visibleCollections: entry.collections.filter(collection => collection.show).length,
              collections: entry.collections.length,
              visibleVertices: entry.batches.reduce((count, batch) => count + [batch.text, batch.icon].reduce((sum, half) => sum + (half?.opacities.filter(value => value > 0).length ?? 0), 0), 0),
            })),
          };
        });
        assert.deepEqual(symbolState.held, [], `${scenario.name}: ready replacement tiles never released their predecessor`);
        // Live-record count can reach zero during a same-tile handoff while
        // SceneCollections still draws the previous generation's surfaces.
        const emptyFrames = dynamic.measurements.frames.filter(frame => frame.commands === 0 || frame.surfaces === 0);
        assert.equal(emptyFrames.length, 0, `${scenario.name}: loaded coverage vanished during camera movement`);
        assert.deepEqual(errors, [], `${scenario.name}: browser render errors`);
        if (!scenario.style) {
          const unexpectedWarnings = [...new Set(expressionWarnings)]
            .filter(warning => scenario.synthetic || !upstreamReferenceWarnings.has(warning));
          assert.deepEqual(unexpectedWarnings, [], `${scenario.name}: unexpected default style expression warnings`);
        }
        const referenceErrors = await page.evaluate(() => window.renderValidation.referenceErrors);
        assert.deepEqual(referenceErrors, [], `${scenario.name}: MapLibre reference errors`);
        const renderErrors = await page.evaluate(() => window.renderValidation.renderErrors);
        assert.deepEqual(renderErrors, [], `${scenario.name}: Cesium render errors`);
        if (scenario.synthetic) {
          assert.ok(dynamic.coverage.length > 0, `${scenario.name}: no framebuffer coverage samples`);
          assert.ok(dynamic.coverage.every(ratio => ratio >= 0.98), `${scenario.name}: basecolor coverage dropped to ${Math.min(...dynamic.coverage)}`);
        }
        const result = {
          scenario,
          initial,
          linePaint,
          symbolPixels,
          ocean,
          dash,
          pan: { builds: pan.builds, pyramidWalks: pan.pyramidWalks, updateMs: distribution(pan.updateMs), placementMs: distribution(pan.placementMs) },
          dynamic: { builds: dynamic.measurements.builds, pyramidWalks: dynamic.measurements.pyramidWalks, updateMs: distribution(dynamic.measurements.updateMs), placementMs: distribution(dynamic.measurements.placementMs), uploadMs: distribution(dynamic.measurements.uploadMs), childrenMs: distribution(dynamic.measurements.childrenMs), buildMs: distribution(dynamic.measurements.buildMs), paintMs: distribution(dynamic.measurements.paintMs), sourceMs: distribution(dynamic.measurements.sourceMs), releaseMs: distribution(dynamic.measurements.releaseMs), styleMs: distribution(dynamic.measurements.styleMs), patternMs: distribution(dynamic.measurements.patternMs), backgroundMs: distribution(dynamic.measurements.backgroundMs), residencyMs: distribution(dynamic.measurements.residencyMs), rebuildMs: distribution(dynamic.measurements.rebuildMs), coverage: dynamic.coverage, frames: dynamic.measurements.frames, emptyFrames: emptyFrames.length, zoom: dynamic.zoom, stats: dynamic.stats },
          unavailableTiles,
          errors,
          expressionWarnings,
          symbolState,
        };
        const measurements = testInfo.outputPath('measurements.json');
        await writeFile(measurements, JSON.stringify(result, null, 2));
        await testInfo.attach('measurements', { path: measurements, contentType: 'application/json' });
        for (const stage of ['initial', 'final']) {
          await testInfo.attach(stage, { path: path.join(output, `${scenario.name}-${stage}.png`), contentType: 'image/png' });
        }
      }
      catch (error) {
        const diagnostic = await page.evaluate(() => {
          const validation = window.renderValidation;
          if (!validation)
            return { initialized: false };
          const { tileset, viewer } = validation;
          const symbol = tileset._symbolRenderer;
          return {
            zoom: validation.zoom,
            renderErrors: validation.renderErrors,
            stats: tileset.stats(),
            coverage: validation.coverage,
            globeTiles: viewer.scene.globe._surface._tilesToRender.length,
            firstUpdates: tileset._sceneCollections.pendingFirstUpdateCount,
            sourceTiles: Object.entries(tileset._style.tilePyramids).map(([source, pyramid]) => ({
              source,
              tiles: pyramid.getRenderableIds().map((key) => {
                const tile = pyramid.getTileByID(key);
                return { key, canonical: tile?.tileID.canonical, buckets: Object.entries(tile?.buckets ?? {}).map(([id, bucket]) => ({ id, type: bucket.layers[0]?.type, instances: (bucket as typeof bucket & { symbolInstances?: { length: number } }).symbolInstances?.length })) };
              }),
            })),
            residentTiles: [...tileset._tileResidency._tiles].map(([id, tile]) => ({ id, live: tile.live, stage: tile.publicationStage, canonical: tile.tileID.canonical })),
            symbolTiles: [...symbol._tiles].map(([id, entry]) => ({ id, layers: entry.layerIds, placed: entry.placed, excluded: symbol._excludedPlacementTiles.has(id), visibleVertices: entry.batches.reduce((count, batch) => count + [batch.text, batch.icon].reduce((sum, half) => sum + (half?.opacities.filter(value => value > 0).length ?? 0), 0), 0) })),
            retiredSymbols: [...symbol._retired.entries()].map(([id, entry]) => ({ id, layers: entry.layerIds })),
            referenceSymbols: validation.reference?.queryRenderedFeatures().filter(feature => feature.layer.type === 'symbol').map(feature => ({ id: feature.layer.id, name: feature.properties.name })).slice(0, 30),
            dash: {
              canvas: { width: viewer.canvas.width, height: viewer.canvas.height, clientWidth: viewer.canvas.clientWidth, clientHeight: viewer.canvas.clientHeight, devicePixelRatio: window.devicePixelRatio, recommendedResolution: viewer.useBrowserRecommendedResolution },
              framePixelRatio: viewer.scene._frameState.pixelRatio,
              rendererPixelRatio: tileset._patternRenderer.pixelRatio,
              crossfade: tileset._style.getLayer('dash')?.getCrossfadeParameters(),
              materials: tileset._vectorRenderer.dashMaterial?._material
                ? [{
                    uniforms: Object.fromEntries(['u_mix', 'u_fromScale', 'u_toScale', 'u_dpr', 'u_worldPixels', 'u_atlasSize'].map(name => [name, tileset._vectorRenderer.dashMaterial._material.uniforms[name]])),
                  }]
                : [],
              atlasCenter: tileset._vectorRenderer.dashMaterial && Array.from(tileset._vectorRenderer.dashMaterial.atlas.data.subarray(7 * 256 + 220, 7 * 256 + 230)),
            },
            firstUpdateDetails: tileset._sceneCollections._firstUpdates.flatMap(queue => [...queue].map(([collection, upload]) => ({
              size: (collection as PrimitiveCollection).length,
              index: upload.index,
              show: collection.show,
              kind: (collection as PrimitiveCollection).length ? window.renderValidation.drawBatch((collection as PrimitiveCollection).get(0))?.kind : undefined,
            }))),
            held: [...tileset._tileResidency._sources].flatMap(([source, sync]) => [...sync.held].map(tileId => ({ source, tileId }))),
            jobs: [...tileset._tilePublishQueue._jobs.values()].map(job => ({ tileId: job.tileId, phase: job.phase })),
            measurements: validation.measurements,
            placement: {
              pending: symbol.hasPendingWork,
              dirty: symbol._placementDirty,
              urgent: symbol._placementUrgent,
              job: !!symbol._placement,
              batchIndex: symbol._placement?._batchIndex,
              batches: symbol._orderedBatches.length,
              opacity: symbol._pendingOpacityHalves.size,
              dynamic: symbol._pendingDynamicHalves.size,
              unplacedTiles: [...symbol._tiles].filter(([, entry]) => !entry.placed).map(([id]) => id),
              pendingPrimitives: [...symbol._pendingOpacityHalves, ...symbol._pendingDynamicHalves].map(half => ({
                layer: half.layerId,
                ready: half.opacity?.target?.primitive.ready,
                arrays: (half.opacity?.target?.primitive as import('cesium').Primitive & { _va?: unknown[] })?._va?.length,
              })),
            },
          };
        }).catch(() => ({ initialized: false }));
        const failure = { scenario, failure: (error instanceof Error ? error.message : String(error)), errors, expressionWarnings, unavailableTiles, diagnostic };
        await page.screenshot({ path: path.join(output, `${scenario.name}-failure.png`) }).catch(() => {});
        const diagnostics = testInfo.outputPath('diagnostics.json');
        await writeFile(diagnostics, JSON.stringify(failure, null, 2));
        await testInfo.attach('diagnostics', { path: diagnostics, contentType: 'application/json' });
        throw error;
      }
      finally {
        if (profiler) {
          const { profile } = await profiler.send('Profiler.stop');
          const file = testInfo.outputPath('cpu.cpuprofile');
          await writeFile(file, JSON.stringify(profile));
          await testInfo.attach('cpu-profile', { path: file, contentType: 'application/json' });
          await profiler.detach();
        }
      }
    });
  });
}
