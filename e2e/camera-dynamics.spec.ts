import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Page, TestInfo } from 'playwright/test';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { fromGeojsonVt, GeoJSONVT, test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';

async function openDynamics(page: Page, renderUrl: string, testInfo: TestInfo, count = 100, minzoom = 13, drape = false, compare = false) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const extent = 4096;
  const worldLabels = compare
    ? new GeoJSONVT({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-0.1276, 51.5072] } },
        ...Array.from({ length: count }, (_, index) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [-0.1276 + ((index % Math.sqrt(count)) - (Math.sqrt(count) - 1) / 2) * 0.003, 51.5072 + (Math.floor(index / Math.sqrt(count)) - (Math.sqrt(count) - 1) / 2) * 0.003] } })),
      ] }, { maxZoom: 14, buffer: 0 })
    : undefined;
  const tile = Buffer.from(fromGeojsonVt({
    land: { features: [{ type: 3, geometry: [[[0, 0], [extent, 0], [extent, extent], [0, extent], [0, 0]]] }] },
    labels: { features: Array.from({ length: count }, (_, index) => ({
      type: 1,
      tags: { radius: 10 },
      geometry: [[(index % Math.sqrt(count) + 0.5) * extent / Math.sqrt(count), (Math.floor(index / Math.sqrt(count)) + 0.5) * extent / Math.sqrt(count)]],
    })) },
  }, { version: 2, extent }));
  const sprite = createCanvas(12, 12);
  const context = sprite.getContext('2d');
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, 12, 12);
  const style: StyleSpecification = {
    version: 8,
    sprite: `${renderUrl}/camera-dynamics/sprite`,
    sources: { world: { type: 'vector', tiles: [`${renderUrl}/camera-dynamics/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [
      { 'id': 'land', 'type': 'fill', 'source': 'world', 'source-layer': 'land', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } },
      { 'id': 'detail', 'type': 'fill', 'source': 'world', 'source-layer': 'land', minzoom, 'paint': { 'fill-color': '#ff00ff', 'fill-antialias': false } },
      { 'id': 'points', 'type': 'circle', 'source': 'world', 'source-layer': 'labels', minzoom, 'paint': { 'circle-color': '#ff0000', 'circle-radius': 10 } },
      { 'id': 'labels', 'type': 'symbol', 'source': 'world', 'source-layer': 'labels', minzoom, 'layout': { 'icon-image': 'label' } },
    ],
  };
  await page.route('**/camera-dynamics/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('.pbf')) {
      // Keep an outgoing generation alive while its replacement is loading.
      await new Promise(resolve => setTimeout(resolve, 80));
      const coordinate = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
      const body = worldLabels && coordinate ? Buffer.from(fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [extent, 0], [extent, extent], [0, extent], [0, 0]]] }] }, labels: worldLabels.getTile(...coordinate.slice(1).map(Number) as [number, number, number]) ?? { features: [] } }, { version: 2, extent })) : tile;
      return route.fulfill({ body, contentType: 'application/x-protobuf' });
    }
    if (url.endsWith('.png'))
      return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
    if (url.includes('sprite'))
      return route.fulfill({ json: { label: { x: 0, y: 0, width: 12, height: 12, pixelRatio: 1 } } });
    return route.fulfill({ json: style });
  });
  const query = new URLSearchParams({ style: `${renderUrl}/camera-dynamics/style.json`, atlas: '1', scale: '0.5', ...(drape ? { drape: '1' } : {}), ...(compare ? { compare: '1', readback: '0' } : {}) });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  const state = () => page.evaluate(() => {
    const validation = window.renderValidation;
    if (!validation)
      return { initialized: false };
    const symbol = validation.tileset._renderer.symbol;
    return {
      loaded: validation.tileset.tilesLoaded,
      stats: validation.tileset.stats(),
      errors: validation.renderErrors,
      pending: symbol.hasPendingWork,
      placement: { index: symbol._targetPlacement.job?.pass._batchIndex, batches: symbol._targetPlacement.batches.length, pending: symbol._targetPlacement.pending },
      visible: { index: symbol._visiblePlacement.job?.pass._batchIndex, batches: symbol._visiblePlacement.batches.length, pending: symbol._visiblePlacement.pending },
      handoff: { index: symbol._handoffPlacement.job?.pass._batchIndex, batches: symbol._handoffPlacement.batches.length, pending: symbol._handoffPlacement.pending },
      unplaced: [...symbol._tiles].filter(([, entry]) => !entry.placed).length,
      firstUpdates: validation.tileset._renderer.collections.pendingFirstUpdateCount,
      opacity: symbol._pendingOpacityHalves.size,
      dynamic: symbol._pendingDynamicHalves.size,
      zoom: validation.zoom,
      rendered: validation.measurements.frames.slice(-5),
      frames: validation.renderedFrames,
    };
  });
  try {
    await expect.poll(async () => {
      const current = await state();
      return current.loaded && (current.stats?.renderableTiles ?? 0) > 0 && (current.stats?.submittedCommands ?? 0) > 0;
    }).toBe(true);
  }
  catch (error) {
    const diagnostic = await state();
    const file = testInfo.outputPath('initial-state.json');
    await writeFile(file, JSON.stringify({ diagnostic, errors }, null, 2));
    await testInfo.attach('initial-state', { path: file, contentType: 'application/json' });
    throw error;
  }
  return { errors, initial: await state() };
}

// Keep the original collision-overflow workload for the full camera replay.
test('continuous zoom and orbit hide out-of-range content (900 symbols per tile) without caller render requests', async ({ page, renderUrl }, testInfo) => {
  const { errors, initial } = await openDynamics(page, renderUrl, testInfo, 900);
  const result = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const { viewer, tileset, atlas } = validation;
    const { Cartesian3, HeadingPitchRange, Matrix4 } = atlas!.cesium;
    const initialHeight = viewer.camera.positionCartographic.height;
    const frames: Array<{ phase: string; zoom: number; green: number; red: number; magenta: number; pending: number; symbols: number; placed: number; updateMs: number }> = [];
    let phase = 'out';
    const remove = viewer.scene.postRender.addEventListener(() => {
      const pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
      let green = 0;
      let red = 0;
      let magenta = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 30 && pixels[index + 1] > 180 && pixels[index + 2] < 30)
          green++;
        if (pixels[index] > 180 && pixels[index + 1] < 30 && pixels[index + 2] < 30)
          red++;
        if (pixels[index] > 180 && pixels[index + 1] < 30 && pixels[index + 2] > 180)
          magenta++;
      }
      frames.push({ phase, zoom: validation.zoom, green, red, magenta, pending: tileset.stats().pendingPublishes, symbols: tileset._renderer.symbol._tiles.size, placed: [...tileset._renderer.symbol._tiles.values()].filter(entry => entry.placed).length, updateMs: validation.measurements.updateMs.at(-1) ?? 0 });
    });
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    validation.reset();
    try {
      for (const direction of ['out', 'in']) {
        phase = direction;
        for (let step = 1; step <= 32; step++) {
          const fraction = direction === 'out' ? step / 32 : 1 - step / 32;
          viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, initialHeight * 2 ** (fraction * 4)), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
          await nextFrame();
        }
      }
      phase = 'orbit';
      for (let step = 0; step < 36; step++) {
        viewer.camera.lookAt(Cartesian3.fromDegrees(-0.1276, 51.5072), new HeadingPitchRange(step * Math.PI / 18, -Math.PI / 2 + Math.sin(step * Math.PI / 36) * Math.PI / 3, initialHeight));
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        await nextFrame();
      }
      phase = 'settled';
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, initialHeight), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      for (let frame = 0; frame < 120 && !tileset.tilesLoaded; frame++)
        await nextFrame();
      await nextFrame();
      return { frames, measurements: structuredClone(validation.measurements), renderErrors: validation.renderErrors, loaded: tileset.tilesLoaded, initialHeight };
    }
    finally { remove(); }
  });
  const file = testInfo.outputPath('camera-dynamics.json');
  await writeFile(file, JSON.stringify({ initial, ...result }, null, 2));
  await testInfo.attach('camera-dynamics', { path: file, contentType: 'application/json' });
  expect(result.frames.filter(frame => frame.phase === 'out' && frame.zoom < 13).length).toBeGreaterThan(5);
  expect(result.frames.some(frame => frame.green > 100)).toBe(true);
  expect(result.frames.some(frame => frame.red > 100)).toBe(true);
  expect(result.frames.some(frame => frame.magenta > 100)).toBe(true);
  expect(result.frames.filter(frame => frame.zoom < 13 && (frame.green > 0 || frame.red > 0 || frame.magenta > 0)), 'out-of-range content must disappear on the first rendered frame').toEqual([]);
  expect(result.frames.filter(frame => frame.phase === 'orbit' && frame.green === 0).length, 'visible symbols must survive continuous camera rotation').toBe(0);
  expect(result.loaded).toBe(true);
  expect(result.renderErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test('terrain draped fills hide and recover at the layer zoom boundary without caller render requests', async ({ page, renderUrl }, testInfo) => {
  const { errors } = await openDynamics(page, renderUrl, testInfo, 100, 14.125, true);
  const initial = await page.evaluate(() => {
    const { tileset, viewer, atlas } = window.renderValidation;
    const provider = (viewer.scene as unknown as { vectorProvider: { _heightReferenceByCollection: Map<object, number> } }).vectorProvider;
    const collections = [...tileset._renderer.vector._records].flatMap(([tileId, record]) => [...record.collections].map(([layerId, collection]) => ({ tileId, layerId, collection })));
    return { zoom: window.renderValidation.zoom, collections: collections.map(({ tileId, layerId, collection }) => {
      const native = collection as import('./fixtures/browser-types').NativeBufferCollection & { primitiveCount: number; heightReference: number };
      let color: number[] | undefined;
      if (native._getPrimitiveClass && native.primitiveCount) {
        const primitive = native.get(0, new (native._getPrimitiveClass())());
        const material = primitive.getMaterial({ color: new atlas!.cesium.Color() });
        color = [material.color.red, material.color.green, material.color.blue, material.color.alpha];
      }
      return { tileId, layerId, show: collection.show, heightReference: native.heightReference, count: native.primitiveCount, color };
    }), provider: [...provider._heightReferenceByCollection].map(([collection]) => {
      const owned = collections.find(entry => entry.collection === collection);
      return owned && { tileId: owned.tileId, layerId: owned.layerId };
    }) };
  });
  await writeFile(testInfo.outputPath('draped-initial.json'), JSON.stringify(initial, null, 2));
  await expect.poll(() => page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 0, 255])))).toBeGreaterThan(0.5);
  const initialHeight = await page.evaluate(() => window.renderValidation.viewer.camera.positionCartographic.height);
  for (const factor of [1.16, 1, 1.16, 1]) {
    await page.evaluate(({ initialHeight, factor }) => {
      const { viewer, atlas } = window.renderValidation;
      viewer.camera.setView({ destination: atlas!.cesium.Cartesian3.fromDegrees(-0.1276, 51.5072, initialHeight * factor), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    }, { initialHeight, factor });
    const color = factor > 1 ? [51, 102, 170] : [255, 0, 255];
    await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), color)).toBeGreaterThan(0.5);
    await expect.poll(() => page.evaluate(async () => {
      const before = window.renderValidation.renderedFrames;
      await new Promise(resolve => setTimeout(resolve, 400));
      return window.renderValidation.tileset.tilesLoaded && window.renderValidation.renderedFrames === before;
    })).toBe(true);
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.renderValidation.renderErrors)).toEqual([]);
});

test('world symbols remain continuous and appear promptly against the same MapLibre camera and delayed tiles', async ({ page, renderUrl }, testInfo) => {
  const { errors } = await openDynamics(page, renderUrl, testInfo, 100, 13, false, true);
  await page.evaluate(() => window.renderValidation.syncReference());
  await expect.poll(() => page.evaluate(() => window.renderValidation.reference?.loaded())).toBe(true);
  const result = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const { viewer, reference, atlas } = validation;
    const { Cartesian3, HeadingPitchRange, Matrix4 } = atlas!.cesium;
    const height = viewer.camera.positionCartographic.height;
    const anchor = Cartesian3.fromDegrees(-0.1276, 51.5072);
    let phase = 'baseline';
    const frames: Array<{ renderer: string; phase: string; time: number; zoom: number; green: boolean; x: number; y: number }> = [];
    const nativeSample = () => {
      const point = validation.projectPosition(-0.1276, 51.5072)!;
      const pixel = viewer.scene.context.readPixels({ x: Math.round(point.x), y: viewer.canvas.height - Math.round(point.y) - 1, width: 1, height: 1 });
      frames.push({ renderer: 'cesium', phase, time: performance.now(), zoom: validation.zoom, green: pixel[0] < 30 && pixel[1] > 150 && pixel[2] < 30, x: point.x, y: point.y });
    };
    const referenceSample = () => {
      const canvas = reference!.getCanvas();
      const point = reference!.project([-0.1276, 51.5072]);
      const gl = canvas.getContext('webgl2')!;
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.round(point.x), canvas.height - Math.round(point.y) - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      frames.push({ renderer: 'maplibre', phase, time: performance.now(), zoom: reference!.getZoom(), green: pixel[0] < 30 && pixel[1] > 150 && pixel[2] < 30, x: point.x, y: point.y });
    };
    const remove = viewer.scene.postRender.addEventListener(nativeSample);
    reference!.on('render', referenceSample);
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    try {
      nativeSample();
      referenceSample();
      for (const direction of ['out', 'in']) {
        phase = direction;
        for (let step = 1; step <= 24; step++) {
          const fraction = direction === 'out' ? step / 24 : 1 - step / 24;
          viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, height * 2 ** (fraction * 2)), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
          validation.syncReference();
          await nextFrame();
        }
      }
      for (let step = 0; step < 36; step++) {
        phase = 'orbit';
        viewer.camera.lookAt(anchor, new HeadingPitchRange(step * Math.PI / 18, -Math.PI / 2 + Math.sin(step * Math.PI / 36) * Math.PI / 3, height));
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        validation.syncReference();
        await nextFrame();
      }
      return { frames, errors: validation.renderErrors, referenceErrors: validation.referenceErrors };
    }
    finally {
      remove();
      reference!.off('render', referenceSample);
    }
  });
  await writeFile(testInfo.outputPath('maplibre-symbol-dynamics.json'), JSON.stringify(result, null, 2));
  for (const renderer of ['cesium', 'maplibre']) {
    expect(result.frames.some(frame => frame.renderer === renderer && frame.green)).toBe(true);
    expect(result.frames.filter(frame => frame.renderer === renderer && frame.zoom < 13 && frame.green), 'the layer zoom boundary must hide symbols immediately').toEqual([]);
    expect(result.frames.filter(frame => frame.renderer === renderer && frame.phase === 'orbit' && !frame.green), 'the same world symbol must survive continuous rotation and tilt').toEqual([]);
  }
  const native = result.frames.find(frame => frame.renderer === 'cesium' && frame.phase === 'in' && frame.green);
  const reference = result.frames.find(frame => frame.renderer === 'maplibre' && frame.phase === 'in' && frame.green);
  expect(native).toBeDefined();
  expect(reference).toBeDefined();
  expect(native!.time - reference!.time, 'symbol appearance must not lag the same MapLibre motion by more than 150ms').toBeLessThanOrEqual(150);
  expect(result.errors).toEqual([]);
  expect(result.referenceErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test('public city data settles after continuous zoom, pan and orbit @live', async ({ page, renderUrl }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.E2E_CITY_RESOURCES === 'capture' || process.env.E2E_CITY_RESOURCES === 'replay')
    await routeCityReplay(page.context(), process.env.E2E_CITY_RESOURCES);
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?view=london&scale=0.5&atlas=1&compare=1&readback=0&motionBaseline=1`);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded), { timeout: 90_000 }).toBe(true);
  await page.evaluate(() => window.renderValidation.syncReference());
  await expect.poll(() => page.evaluate(() => window.renderValidation.reference?.loaded()), { timeout: 60_000 }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('city-initial.png') });
  const profiler = process.env.E2E_PROFILE === '1' ? await page.context().newCDPSession(page) : undefined;
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
  }
  const result = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const { viewer, tileset, atlas } = validation;
    const { Cartesian3, HeadingPitchRange, Matrix4 } = atlas!.cesium;
    const height = viewer.camera.positionCartographic.height;
    let phase = 'out';
    const frames: Array<{ phase: string; time: number; zoom: number; commands: number; pending: number; symbols: number; updateMs: number; placementMs: number }> = [];
    const coverage: unknown[] = [];
    const captureCoverage = () => coverage.push({ phase, zoom: validation.zoom, globe: viewer.scene.globe._surface._tilesToRender.map(tile => `${tile.level}/${tile.x}/${tile.y}`), sources: Object.fromEntries(Object.entries(tileset._renderer.style.tilePyramids).map(([id, pyramid]) => [id, { source: { minzoom: pyramid.getSource().minzoom, maxzoom: pyramid.getSource().maxzoom }, tiles: [...pyramid.getRenderableIds()] }])), vectors: [...tileset._renderer.vector.tileIds] });
    const remove = viewer.scene.postRender.addEventListener(() => {
      const stats = tileset.stats();
      frames.push({ phase, time: performance.now(), zoom: validation.zoom, commands: stats.submittedCommands, pending: stats.pendingPublishes, symbols: stats.symbol.tiles, updateMs: validation.measurements.updateMs.at(-1) ?? 0, placementMs: validation.measurements.placementMs.at(-1) ?? 0 });
    });
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    validation.reset();
    captureCoverage();
    try {
      for (const direction of ['out', 'in']) {
        phase = direction;
        for (let step = 1; step <= 24; step++) {
          const fraction = direction === 'out' ? step / 24 : 1 - step / 24;
          viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, height * 2 ** (fraction * 3)), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
          validation.syncReference();
          await nextFrame();
          if (step === 24)
            captureCoverage();
        }
      }
      phase = 'pan';
      for (let step = 0; step < 24; step++) {
        viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276 + Math.sin(step * Math.PI / 12) * 0.025, 51.5072, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        validation.syncReference();
        await nextFrame();
      }
      phase = 'orbit';
      for (let step = 0; step < 36; step++) {
        const pitch = -Math.PI / 2 + Math.sin(step * Math.PI / 36) * Math.PI / 3;
        viewer.camera.lookAt(Cartesian3.fromDegrees(-0.1276, 51.5072), new HeadingPitchRange(step * Math.PI / 18, pitch, height));
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        validation.syncReference();
        validation.reference?.jumpTo({ pitch: 90 + pitch * 180 / Math.PI });
        await nextFrame();
      }
      phase = 'settle';
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      validation.syncReference();
      validation.reference?.jumpTo({ pitch: 0 });
      const gl = viewer.scene.context._gl;
      const renderer = gl.getExtension('WEBGL_debug_renderer_info');
      return { frames, coverage, gpu: renderer && gl.getParameter(renderer.UNMASKED_RENDERER_WEBGL), measurements: structuredClone(validation.measurements), errors: validation.renderErrors };
    }
    finally { remove(); }
  });
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    await writeFile(testInfo.outputPath('city-motion.cpuprofile'), JSON.stringify(profile));
    await profiler.detach();
  }
  await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const before = window.renderValidation.renderedFrames;
    await new Promise(resolve => setTimeout(resolve, 500));
    return window.renderValidation.renderedFrames === before;
  }), { timeout: 15_000 }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('city-settled.png') });
  const output = testInfo.outputPath('public-camera-dynamics.json');
  await writeFile(output, JSON.stringify(result, null, 2));
  await testInfo.attach('public-camera-dynamics', { path: output, contentType: 'application/json' });
  if (process.env.E2E_CITY_RESOURCES)
    await page.context().unrouteAll({ behavior: 'wait' });
  expect(result.frames.length).toBeGreaterThan(60);
  expect(result.frames.every(frame => frame.commands > 0)).toBe(true);
  expect(result.frames.some(frame => frame.symbols > 0)).toBe(true);
  expect(result.errors).toEqual([]);
  expect(errors).toEqual([]);
  if (process.env.E2E_VERIFY_BUDGET === '1') {
    const builds = [...result.measurements.buildMs].sort((a, b) => a - b);
    expect(result.measurements.builds, 'the measured camera motion must exercise fresh tile construction').toBeGreaterThan(0);
    expect(builds[Math.floor((builds.length - 1) * 0.95)], 'tile construction P95 must fit one 60 Hz frame').toBeLessThanOrEqual(1000 / 60);
    expect(Math.max(...builds), 'tile construction must not monopolize the main thread for 50 ms').toBeLessThan(50);
  }
});
