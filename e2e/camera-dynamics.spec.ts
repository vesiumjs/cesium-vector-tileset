import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Page, TestInfo } from 'playwright/test';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { fromGeojsonVt, GeoJSONVT, test } from './fixtures';
import { routeCityReplay } from './fixtures/city-replay';

test.use({ video: { mode: 'on', size: { width: 640, height: 360 } } });

declare global {
  interface Window {
    circleTransition: { frames: Array<{ sizes: number[]; red: boolean }>; stop: () => void };
  }
}

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

for (const count of [100, 900]) {
  test(`continuous zoom and orbit hide out-of-range content (${count} symbols per tile) without caller render requests`, async ({ page, renderUrl }, testInfo) => {
    const { errors, initial } = await openDynamics(page, renderUrl, testInfo, count);
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
}

test('a visibility crossing within one source zoom reuses complete geometry', async ({ page, renderUrl }, testInfo) => {
  const { errors } = await openDynamics(page, renderUrl, testInfo, 100, 14.125);
  const result = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const { viewer, tileset, atlas } = validation;
    const { Cartesian3 } = atlas!.cesium;
    const initialHeight = viewer.camera.positionCartographic.height;
    const before = new Map(tileset._renderer.vector.tileIds.map(id => [id, [...tileset._renderer.vector.getTileCollections(id)]]));
    const beforeSymbols = new Map(tileset._renderer.symbol.tileIds.map(id => [id, [...tileset._renderer.symbol.getTileCollections(id)]]));
    const initial = { vectors: [...before.keys()], symbols: [...beforeSymbols.keys()], stats: tileset.stats(), frames: validation.renderedFrames, globe: viewer.scene.globe._surface._tilesToRender.map(tile => `${tile.level}/${tile.x}/${tile.y}`) };
    validation.reset();
    const snapshots = [];
    for (const fraction of [1.16, 1]) {
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, initialHeight * fraction), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      for (let frame = 0; frame < 60; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (tileset.tilesLoaded && frame >= 5)
          break;
      }
      const common = [...before].filter(([id]) => tileset._renderer.vector.getTileCollections(id).length > 0);
      snapshots.push({ zoom: validation.zoom, vectors: tileset._renderer.vector.tileIds, globe: viewer.scene.globe._surface._tilesToRender.map(tile => `${tile.level}/${tile.x}/${tile.y}`), common: common.length, changed: common.filter(([id, collections]) => {
        const current = tileset._renderer.vector.getTileCollections(id);
        return current.length !== collections.length || collections.some((collection, index) => collection !== current[index]);
      }).map(([id]) => id), changedSymbols: [...beforeSymbols].filter(([id, collections]) => {
        const current = tileset._renderer.symbol.getTileCollections(id);
        return current.length > 0 && (current.length !== collections.length || collections.some((collection, index) => collection !== current[index]));
      }).map(([id]) => id), loaded: tileset.tilesLoaded });
    }
    const rotations = [];
    for (let step = 1; step <= 12; step++) {
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, initialHeight), orientation: { heading: step * Math.PI / 6, pitch: -Math.PI / 2, roll: 0 } });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const common = [...before].filter(([id]) => tileset._renderer.vector.getTileCollections(id).length > 0);
      rotations.push({ common: common.length, changed: common.filter(([id, collections]) => {
        const current = tileset._renderer.vector.getTileCollections(id);
        return current.length !== collections.length || collections.some((collection, index) => collection !== current[index]);
      }).map(([id]) => id) });
    }
    return { initial, snapshots, rotations, builds: validation.measurements.builds, errors: validation.renderErrors };
  });
  await writeFile(testInfo.outputPath('visibility-resources.json'), JSON.stringify(result, null, 2));
  expect(result.snapshots[0].zoom).toBeLessThan(14.125);
  expect(result.snapshots[1].zoom).toBeGreaterThan(14.125);
  for (const snapshot of result.snapshots) {
    expect(snapshot.common).toBeGreaterThan(0);
    expect(snapshot.changed, 'visibility must retain the same buffers for surviving tiles').toEqual([]);
    expect(snapshot.changedSymbols, 'visibility must reuse already extracted symbols for surviving tiles').toEqual([]);
    expect(snapshot.loaded).toBe(true);
  }
  for (const rotation of result.rotations) {
    expect(rotation.common).toBeGreaterThan(0);
    expect(rotation.changed, 'heading changes must retain surviving tile buffers').toEqual([]);
  }
  expect(errors).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('a stopped camera waits for symbol recency without continuous render requests', async ({ page, renderUrl }, testInfo) => {
  const { errors, initial } = await openDynamics(page, renderUrl, testInfo, 100);
  const result = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const { viewer, tileset, atlas } = validation;
    const symbols = tileset._renderer.symbol;
    const scopes = [symbols._targetPlacement, symbols._visiblePlacement, symbols._handoffPlacement];
    const recencyMs = 300;
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const identity = new WeakMap<object, number>();
    let nextIdentity = 0;
    const id = (object: object) => {
      let value = identity.get(object);
      if (value === undefined) {
        value = ++nextIdentity;
        identity.set(object, value);
      }
      return value;
    };
    // Read uploaded Native objects only; no geometry arrays or uniform getters.
    const resources = () => [...symbols._tiles].map(([tileId, entry]) => ({
      tileId,
      primitives: entry.primitives.map(({ primitive }) => {
        const native = primitive as import('./fixtures/browser-types').NativePrimitive;
        return {
          id: id(native),
          ready: native.ready,
          arrays: native._va.map(array => ({
            id: id(array),
            index: array.indexBuffer && id(array.indexBuffer),
            buffers: Array.from({ length: array.numberOfAttributes }, (_, index) => {
              const buffer = array.getAttribute(index).vertexBuffer;
              return buffer && id(buffer);
            }),
          })),
        };
      }),
    }));
    const sourceState = () => Object.entries(tileset._renderer.style.tilePyramids).map(([sourceId, pyramid]) => ({
      sourceId,
      loaded: pyramid.loaded(),
      renderable: pyramid.getRenderableIds().sort(),
    }));
    const view = (value: typeof symbols._lineView) => value && ({
      parameters: {
        width: value.width,
        height: value.height,
        pixelRatio: value.pixelRatio,
        cameraZoom: value.cameraZoom,
        projectPosition: !!value.projectPosition,
        isPointVisible: !!value.isPointVisible,
        viewport: value.viewport && { ...value.viewport },
      },
      matrix: Array.from(value.viewProjection),
    });
    const snapshot = () => ({
      time: performance.now(),
      frame: validation.renderedFrames,
      zoom: validation.zoom,
      runnable: symbols.hasRunnableWork,
      pending: symbols.hasPendingWork,
      scopes: scopes.map(scope => ({
        pending: scope.pending,
        job: !!scope.job,
        urgent: scope._urgent,
        lastCommit: scope._lastCommitMs,
        batches: scope.batches.length,
      })),
      opacity: symbols._pendingOpacityHalves.size,
      dynamic: symbols._pendingDynamicHalves.size,
      firstUpdates: tileset._renderer.collections.pendingFirstUpdateCount,
      publishes: tileset.stats().pendingPublishes,
      source: JSON.stringify(sourceState()),
      camera: Array.from({ length: 16 }, (_, index) => viewer.camera.viewMatrix[index]),
      resources: JSON.stringify(resources()),
    });
    const greenPixels = () => {
      const pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
      let green = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 30 && pixels[index + 1] > 180 && pixels[index + 2] < 30)
          green++;
      }
      return green;
    };
    const start = performance.now();
    while ((!tileset.tilesLoaded || symbols.hasPendingWork) && performance.now() - start < 5000)
      await nextFrame();
    const uploaded = resources();
    const baseline = snapshot();
    const beforeCommit = scopes.map(scope => scope._lastCommitMs);
    type Phase = 'prime' | 'wait' | 'settled';
    let phase: Phase = 'prime';
    const frames: Array<ReturnType<typeof snapshot> & { phase: Phase }> = [];
    let prime: { state: ReturnType<typeof snapshot>; green: number; views: Array<ReturnType<typeof view>> } | undefined;
    let waiting: { state: ReturnType<typeof snapshot>; scope: number; deadline: number; currentView: ReturnType<typeof view>; committedView: ReturnType<typeof view> } | undefined;
    let finished: { state: ReturnType<typeof snapshot>; green: number; loaded: boolean } | undefined;
    let headingCamera: number[] | undefined;
    let observerCpuMs = 0;
    const remove = viewer.scene.postRender.addEventListener(() => {
      const observeStart = performance.now();
      try {
        const state = snapshot();
        frames.push({ ...state, phase });
        if (phase === 'prime' && scopes[0]._lastCommitMs > beforeCommit[0]
          && !symbols.hasPendingWork && state.firstUpdates === 0 && state.publishes === 0) {
          prime = { state, green: greenPixels(), views: scopes.map(scope => view(scope._view)) };
          phase = 'wait';
          // Keep the real position and height; only the view matrix changes.
          viewer.camera.setView({
            destination: viewer.camera.positionWC.clone(),
            orientation: { heading: viewer.camera.heading + Math.PI / 180000, pitch: -Math.PI / 2, roll: 0 },
          });
          headingCamera = Array.from({ length: 16 }, (_, index) => viewer.camera.viewMatrix[index]);
        }
        else if (phase === 'wait') {
          if (!waiting) {
            const scope = state.scopes.reduce((earliest, value, index) => {
              const active = index < 2 || symbols._prospectiveVisibleTiles !== undefined;
              return active && value.batches > 0 && value.pending
                && (earliest < 0 || value.lastCommit < state.scopes[earliest].lastCommit)
                ? index
                : earliest;
            }, -1);
            if (scope >= 0 && !state.scopes[scope].job && !state.scopes[scope].urgent
              && state.scopes.every(value => !value.job)
              && state.opacity === 0 && state.dynamic === 0 && state.firstUpdates === 0 && state.publishes === 0) {
              waiting = {
                state,
                scope,
                deadline: state.scopes[scope].lastCommit + recencyMs,
                currentView: view(symbols._lineView),
                committedView: view(scopes[scope]._view),
              };
            }
          }
          if (waiting && state.time >= waiting.deadline
            && scopes[waiting.scope]._lastCommitMs > waiting.state.scopes[waiting.scope].lastCommit
            && !symbols.hasPendingWork && tileset.tilesLoaded) {
            finished = { state, green: greenPixels(), loaded: tileset.tilesLoaded };
            phase = 'settled';
          }
        }
      }
      finally { observerCpuMs += performance.now() - observeStart; }
    });
    try {
      // A tiny real zoom primes an urgent commit without changing source LOD.
      viewer.camera.setView({
        destination: atlas!.cesium.Cartesian3.fromDegrees(-0.1276, 51.5072, viewer.camera.positionCartographic.height * 1.0001),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const timeout = performance.now() + 5000;
      while (performance.now() < timeout) {
        if (finished)
          break;
        await nextFrame();
      }
      const quietStart = waiting && waiting.state.time + 80;
      const quietEnd = waiting && waiting.deadline - 30;
      const waitingFrames = waiting ? frames.filter(frame => frame.phase === 'wait' && frame.time >= waiting.state.time && frame.time < waiting.deadline - 30) : [];
      return {
        diagnosticOnly: true,
        fairTiming: false,
        observerCpuMs,
        recencyMs,
        uploaded,
        baseline,
        prime,
        waiting,
        finished,
        headingCamera,
        frames,
        quietStart,
        quietEnd,
        quietFrames: quietStart !== undefined && quietEnd !== undefined
          ? frames.filter(frame => frame.phase === 'wait' && frame.time >= quietStart && frame.time < quietEnd)
          : [],
        waitingFrames,
        final: snapshot(),
        renderErrors: validation.renderErrors,
      };
    }
    finally { remove(); }
  });
  const file = testInfo.outputPath('camera-recency-stop.json');
  await writeFile(file, JSON.stringify({ initial, ...result }, null, 2));
  await testInfo.attach('camera-recency-stop', { path: file, contentType: 'application/json' });
  expect(result.uploaded.length).toBeGreaterThan(0);
  expect(result.uploaded.every(tile => tile.primitives.length > 0 && tile.primitives.every(primitive => primitive.ready && primitive.arrays.length > 0))).toBe(true);
  expect(result.prime, 'the real zoom must produce a fresh uploaded placement commit').toBeDefined();
  expect(result.prime?.state.source, 'priming must preserve the loaded source tile set').toBe(result.baseline.source);
  expect(result.waiting, 'the real heading change must enter recency, rather than urgent layout').toBeDefined();
  const wait = result.waiting!;
  expect(wait.currentView?.parameters, 'heading must preserve every actual placement parameter, including exact zoom').toEqual(wait.committedView?.parameters);
  expect(wait.currentView?.matrix, 'heading must change the actual projection matrix').not.toEqual(wait.committedView?.matrix);
  expect(wait.state.scopes[wait.scope]).toMatchObject({ pending: true, job: false, urgent: false });
  expect(wait.state.time - wait.state.scopes[wait.scope].lastCommit).toBeLessThan(300);
  expect(wait.state.runnable, 'a recency-only wait must not drive root continuation renders').toBe(false);
  expect(result.quietEnd! - result.quietStart!, 'observe a meaningful quiet interval before the real deadline').toBeGreaterThan(30);
  for (const frame of result.waitingFrames) {
    expect(frame.scopes.every(scope => !scope.job)).toBe(true);
    expect(frame.scopes[result.waiting!.scope].urgent).toBe(false);
    expect(frame.source, 'camera followups must not introduce source work').toBe(result.prime!.state.source);
    // Native orthonormalization can change the last bits after setView.
    expect(Math.max(...frame.camera.map((value, index) => Math.abs(value - result.headingCamera![index]))), 'the camera must remain stopped throughout recency').toBeLessThan(1e-8);
    expect(frame.resources, 'recency must preserve all uploaded VA and VBO identities').toBe(result.prime!.state.resources);
    expect([frame.opacity, frame.dynamic, frame.firstUpdates, frame.publishes]).toEqual([0, 0, 0, 0]);
    expect(frame.runnable).toBe(false);
  }
  expect(result.quietFrames, 'after legitimate camera followups, no continuous postRender is allowed before recency expires').toEqual([]);
  expect(result.finished, 'the owned deadline timer must complete layout without a caller render request').toBeDefined();
  expect(result.finished?.loaded).toBe(true);
  expect(result.finished?.green).toBeGreaterThan(0);
  expect(result.prime?.green).toBeGreaterThan(0);
  expect(result.finished?.state.resources).toBe(result.prime?.state.resources);
  expect(result.finished?.state.source).toBe(result.prime?.state.source);
  expect(result.finished?.state.pending).toBe(false);
  expect(result.renderErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test('pending tiles finish a default data-driven paint transition and draw without caller render requests', async ({ page, renderUrl }, testInfo) => {
  const { errors } = await openDynamics(page, renderUrl, testInfo, 4);
  await page.evaluate(() => {
    const { tileset } = window.renderValidation;
    const style = structuredClone(tileset.styleSpec);
    for (const layer of style.layers) {
      if (layer.id === 'points' && layer.type === 'circle')
        layer.paint = { 'circle-color': '#ff0000', 'circle-radius': ['get', 'radius'] };
      else if (layer.id !== 'land')
        layer.layout = { ...layer.layout, visibility: 'none' };
    }
    // Use MapLibre's default 300ms duration; zero-duration transitions would
    // miss the worker-schema/current-paint mismatch this case exercises.
    delete style.transition;
    tileset.setStyle(style);
  });
  await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  let requests = 0;
  await page.route('**/camera-dynamics/**.pbf', async (route) => {
    requests++;
    await held;
    await route.fallback();
  });
  try {
    await page.evaluate(() => {
      const { viewer, tileset, atlas } = window.renderValidation;
      const { Cartesian3, BufferPoint, BufferPointCollection, BufferPointMaterial, SceneTransforms } = atlas!.cesium;
      const frames: Window['circleTransition']['frames'] = [];
      const point = new BufferPoint();
      const material = new BufferPointMaterial();
      const stop = viewer.scene.postRender.addEventListener(() => {
        const sizes: number[] = [];
        let red = false;
        for (const id of tileset._renderer.vector.tileIds) {
          for (const collection of tileset._renderer.vector.getTileCollections(id)) {
            if (!(collection instanceof BufferPointCollection) || !collection.show)
              continue;
            for (let index = 0; index < collection.primitiveCount; index++) {
              collection.get(index, point);
              point.getMaterial(material);
              sizes.push(material.size);
              const pixel = SceneTransforms.worldToWindowCoordinates(viewer.scene, point.getPosition());
              if (pixel && pixel.x > 40 && pixel.x < viewer.canvas.width - 40 && pixel.y > 40 && pixel.y < viewer.canvas.height - 40) {
                const color = viewer.scene.context.readPixels({ x: Math.round(pixel.x) + 14, y: viewer.canvas.height - Math.round(pixel.y) - 1, width: 1, height: 1 });
                red ||= color[0] > 200 && color[1] < 30 && color[2] < 30;
              }
            }
          }
        }
        frames.push({ sizes, red });
      });
      window.circleTransition = { frames, stop };
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.03, 51.5072, viewer.camera.positionCartographic.height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    });
    await expect.poll(() => requests).toBeGreaterThan(0);
    await page.evaluate(() => {
      const { tileset } = window.renderValidation;
      const style = structuredClone(tileset.styleSpec);
      const circles = style.layers.find(layer => layer.id === 'points');
      if (circles?.type === 'circle')
        circles.paint = { 'circle-color': '#ff0000', 'circle-radius': 16 };
      tileset.setStyle(style);
    });
    release();
    await expect.poll(() => page.evaluate(() => ({
      loaded: window.renderValidation.tileset.tilesLoaded,
      drawn: window.circleTransition.frames.some(frame => frame.red && frame.sizes.includes(32)),
    }))).toEqual({ loaded: true, drawn: true });
    const result = await page.evaluate(() => {
      window.circleTransition.stop();
      return { frames: window.circleTransition.frames, errors: window.renderValidation.renderErrors };
    });
    await writeFile(testInfo.outputPath('default-paint-transition.json'), JSON.stringify(result, null, 2));
    expect(result.frames.flatMap(frame => frame.sizes).every(size => size >= 20), 'a worker schema change must not collapse a visible circle during the transition').toBe(true);
    expect(result.frames.at(-1)?.sizes.every(size => size === 32)).toBe(true);
    expect(result.errors).toEqual([]);
    expect(errors).toEqual([]);
  }
  finally {
    release();
    await page.evaluate(() => window.circleTransition?.stop());
    await page.unrouteAll({ behavior: 'wait' });
  }
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

test('zoom replacement draws a half-transparent symbol exactly once at its world anchor', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const index = new GeoJSONVT({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-0.1276, 51.5072] } }, { maxZoom: 14, buffer: 0 });
  const sprite = createCanvas(32, 32);
  sprite.getContext('2d').fillStyle = '#ffffff';
  sprite.getContext('2d').fillRect(0, 0, 32, 32);
  const style: StyleSpecification = {
    version: 8,
    sprite: `${renderUrl}/symbol-handoff/sprite`,
    sources: { world: { type: 'vector', tiles: [`${renderUrl}/symbol-handoff/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [
      { 'id': 'land', 'type': 'fill', 'source': 'world', 'source-layer': 'land', 'paint': { 'fill-color': '#3366aa', 'fill-antialias': false } },
      { 'id': 'label', 'type': 'symbol', 'source': 'world', 'source-layer': 'labels', 'layout': { 'icon-image': 'label' }, 'paint': { 'icon-opacity': 0.5 } },
    ],
  };
  await page.route('**/symbol-handoff/**', async (route) => {
    const url = route.request().url();
    const coordinate = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (coordinate) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const labels = index.getTile(...coordinate.slice(1).map(Number) as [number, number, number]);
      const tile = fromGeojsonVt({
        land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]] }] },
        labels: labels ?? { features: [] },
      }, { version: 2, extent: 4096 });
      return route.fulfill({ body: Buffer.from(tile), contentType: 'application/x-protobuf' });
    }
    if (url.endsWith('.png'))
      return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
    if (url.includes('sprite'))
      return route.fulfill({ json: { label: { x: 0, y: 0, width: 32, height: 32, pixelRatio: 1 } } });
    return route.fulfill({ json: style });
  });
  const query = new URLSearchParams({ style: `${renderUrl}/symbol-handoff/style.json`, scale: '0.5', atlas: '1' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded)).toBe(true);
  const result = await page.evaluate(async () => {
    const validation = window.renderValidation;
    const { viewer, tileset, atlas } = validation;
    const { Cartesian3 } = atlas!.cesium;
    const height = viewer.camera.positionCartographic.height;
    const frames: Array<{ zoom: number; phase: string; pixel: number[]; fading: number }> = [];
    let phase = 'baseline';
    const remove = viewer.scene.postRender.addEventListener(() => {
      const pixel = viewer.scene.context.readPixels({ x: Math.floor(viewer.canvas.width / 2), y: Math.floor(viewer.canvas.height / 2), width: 1, height: 1 });
      frames.push({ zoom: validation.zoom, phase, pixel: Array.from(pixel), fading: tileset.stats().symbol.fadingTiles });
    });
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const setHeight = (factor: number) => viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, height * factor), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    try {
      setHeight(1.0001);
      await nextFrame();
      await nextFrame();
      for (const direction of ['out', 'in']) {
        phase = direction;
        for (let step = 1; step <= 20; step++) {
          const fraction = direction === 'out' ? step / 20 : 1 - step / 20;
          setHeight(2 ** (fraction * 2));
          await nextFrame();
        }
        for (let frame = 0; frame < 120 && !tileset.tilesLoaded; frame++)
          await nextFrame();
      }
      return { frames, loaded: tileset.tilesLoaded, errors: validation.renderErrors };
    }
    finally { remove(); }
  });
  await writeFile(testInfo.outputPath('symbol-handoff-pixels.json'), JSON.stringify(result, null, 2));
  const baseline = result.frames.find(frame => frame.phase === 'baseline');
  expect(baseline).toBeDefined();
  expect(baseline!.pixel[0]).toBeGreaterThan(100);
  expect(baseline!.pixel[0], 'icon-opacity 0.5 must blend the sprite with the ground').toBeLessThan(250);
  expect(result.frames.filter(frame => frame.phase === 'out').length).toBeGreaterThan(15);
  expect(result.frames.filter(frame => frame.pixel.slice(0, 3).some((value, channel) => value > baseline!.pixel[channel] + 3)), 'a replacing tile must not draw over the old copy of the same symbol').toEqual([]);
  expect(result.loaded).toBe(true);
  expect(result.errors).toEqual([]);
  expect(errors).toEqual([]);
  const withoutLabels = structuredClone(style);
  withoutLabels.layers = withoutLabels.layers.filter(layer => layer.type !== 'symbol');
  await page.evaluate(json => window.renderValidation.tileset.setStyle(JSON.parse(json) as StyleSpecification), JSON.stringify(withoutLabels));
  await expect.poll(() => page.evaluate(() => ({
    loaded: window.renderValidation.tileset.tilesLoaded,
    symbols: window.renderValidation.tileset.stats().symbol.tiles,
    pixel: window.renderValidation.readPixelSamples()[1][1].slice(0, 3),
  }))).toEqual({ loaded: true, symbols: 0, pixel: [51, 102, 170] });
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
