import type { FillLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import type { Budget } from '../packages/cesium-vector-tileset/src/render/scene/frame-budget';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativePrimitive, NativeVertexArray } from './fixtures/browser-types';
import type { compareSurfaceFloat } from './fixtures/surface-float-reference';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface SurfaceMorphLayout {
  attributes: string[];
  morphTime: number;
  descriptors: number;
  arrays: Array<{ batchId: { type: number; components: number; normalize: boolean }; coordinates: Array<{ type: number; components: number; normalize: boolean }>; vertices: number; vertexBytes: number }>;
}

declare global {
  interface Window {
    viewportBudgetProof: { calls: Array<{ commands: number; ready: boolean; sameBudget: boolean }>; halves: number[]; fps: boolean; errors: string[] };
    surfaceResources: NativePrimitive[];
    surfaceArrays: NativeVertexArray[][];
    surfaceStable: () => boolean;
    stopSurfacePixels: () => void;
    surfacePixels: Uint8Array;
    surfaceSample: (color: number[]) => { count: number; picked?: TilePickObject };
    surfaceMorphLayouts: SurfaceMorphLayout[];
    stopSurfaceMorph: () => void;
  }
}

function assertFloatReference(result: Awaited<ReturnType<typeof compareSurfaceFloat>>, morph = false) {
  assert.ok(result.independentUniforms && result.sharedProgram, 'surface owners must isolate descriptors while sharing the same bounded shader program');
  assert.equal(result.descriptorCount, morph ? 12 : 6);
  for (const array of result.reference) {
    const positions = array.attributes.filter(attribute => /^position[23]D(?:High|Low)$/.test(attribute.name));
    assert.equal(positions.length, 4, 'Native oracle must retain both real FLOAT position tracks');
    assert.ok(positions.every(attribute => attribute.type === 0x1406 && attribute.components === 3 && !attribute.normalize));
  }
  for (const array of result.production) {
    assert.ok(array.attributes.every(attribute => attribute.name === 'batchId' || /^a_surface\d+$/.test(attribute.name)), 'production retained unpacked position attributes');
    assert.ok(array.attributes.filter(attribute => attribute.name !== 'batchId').every(attribute => attribute.type === 0x1401 && attribute.components >= 1 && attribute.components <= 4 && !attribute.normalize));
  }
  for (const comparison of result.comparisons) {
    assert.deepEqual(comparison.mismatches, [0, 0], `${comparison.view} compressed positions differ from independent Native FLOAT framebuffer`);
    const visible = comparison.samples.filter(sample => sample.count > 50);
    assert.ok(visible.length >= (comparison.view.startsWith('date-line') ? 1 : 2), `${comparison.view} oracle rendered no useful source geometry`);
    for (const sample of visible)
      assert.deepEqual(sample.picks, [sample.id, sample.id], 'compressed and Native FLOAT instance picking differs');
    if (morph)
      assert.equal(comparison.morphTime, result.morphTime, 'morph camera advanced between FLOAT comparison frames');
  }
  if (morph)
    assert.ok(result.morphTime > 0 && result.morphTime < 1, 'FLOAT oracle must compare a real intermediate scene morph');
  assert.ok(result.fps && result.destroyed, 'FLOAT oracle disabled FPS or retained Native resources');
}

const tile = Buffer.from(fromGeojsonVt({
  ground: { features: [{ id: 100, type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  parcels: { features: [{ id: 200, type: 3, geometry: [[[1024, 1024], [3072, 1024], [3072, 3072], [1024, 3072], [1024, 1024]]], tags: {} }] },
}, { version: 2, extent: 4096 }));

test('date-line viewports share preparation time and draw a Native upload before afterRender ready', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/viewport-budget/style.json', route => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
  const query = new URLSearchParams({ mode: '2d', center: '180,-16.5', atlas: '1', style: `${renderUrl}/viewport-budget/style.json` });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => !!window.renderValidation?.atlas)).toBe(true);
  await page.evaluate(() => {
    const { viewer, tileset, atlas } = window.renderValidation;
    const { Color, ColorGeometryInstanceAttribute, GeometryInstance, PerInstanceColorAppearance, Primitive, Rectangle, RectangleGeometry } = atlas.cesium;
    const geometry = RectangleGeometry.createGeometry(new RectangleGeometry({
      rectangle: Rectangle.fromDegrees(179.965, -16.514, -179.965, -16.486),
      height: 1000,
      vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
    }));
    const primitive = new Primitive({
      geometryInstances: [new GeometryInstance({ geometry, id: 'date-line-upload', attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.LIME) } })],
      appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
    });
    tileset.add(primitive);
    const collections = tileset._sceneCollections;
    collections.queueFirstUpdate([primitive]);
    const pump = collections.pumpFirstUpdates;
    const calls: Array<{ frame: number; budget: Budget; commands: number; ready: boolean }> = [];
    let targetFrame: number | undefined;
    let exhaustedBudget: Budget | undefined;
    collections.pumpFirstUpdates = function (frame, budget) {
      const first = frame.commandList.length;
      const result = pump.call(this, frame, budget);
      const commands = frame.commandList.slice(first).filter(command => command.owner === primitive).length;
      const ready = primitive.ready;
      calls.push({ frame: frame.frameNumber, budget, commands, ready });
      if (commands > 0 && !ready && targetFrame === undefined) {
        targetFrame = frame.frameNumber;
        exhaustedBudget = budget;
        // Deterministically leave no preparation time for the second viewport.
        Object.defineProperty(budget, 'exhausted', { get: () => true });
      }
      return result;
    };
    const stop = viewer.scene.postRender.addEventListener(() => {
      if (viewer.scene._frameState.frameNumber !== targetFrame)
        return;
      const frameCalls = calls.filter(call => call.frame === targetFrame);
      const pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
      const halves = [0, 0];
      for (let y = 0; y < viewer.canvas.height; y++) {
        for (let x = 0; x < viewer.canvas.width; x++) {
          const offset = (y * viewer.canvas.width + x) * 4;
          if (pixels[offset] < 10 && pixels[offset + 1] > 245 && pixels[offset + 2] < 10)
            halves[x < viewer.canvas.width / 2 ? 0 : 1]++;
        }
      }
      window.viewportBudgetProof = {
        calls: frameCalls.map(call => ({ commands: call.commands, ready: call.ready, sameBudget: call.budget === exhaustedBudget })),
        halves,
        fps: viewer.scene.debugShowFramesPerSecond,
        errors: window.renderValidation.renderErrors,
      };
      collections.pumpFirstUpdates = pump;
      stop();
    });
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => !!window.viewportBudgetProof)).toBe(true);
  const result = await page.evaluate(() => window.viewportBudgetProof);
  assert.equal(result.calls.length, 2, 'camera did not execute both date-line viewports');
  assert.ok(result.calls.every(call => call.commands > 0 && call.sameBudget && !call.ready), 'a viewport lost its Native upload commands or obtained a fresh allowance');
  assert.ok(result.halves.every(count => count > 50), 'Native rectangle did not draw on both sides of the date line');
  assert.ok(result.fps);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  const output = testInfo.outputPath('viewport-budget.json');
  await writeFile(output, JSON.stringify(result, null, 2));
  await testInfo.attach('viewport-budget', { path: output, contentType: 'application/json' });
});

for (const mode of ['2d', 'cv']) {
  test(`planar surfaces upload one exact position track and retain paint and picking in ${mode}`, async ({ page, renderUrl }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const style = {
      version: 8,
      transition: { duration: 0, delay: 0 },
      sources: { city: { type: 'vector', tiles: [`${renderUrl}/surface-layout/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
      layers: [
        { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } },
        { 'id': 'parcels', 'type': 'fill', 'source': 'city', 'source-layer': 'parcels', 'paint': { 'fill-color': '#ff0000', 'fill-antialias': false } },
      ],
    } satisfies StyleSpecification;
    await page.route('**/surface-layout/**', route => route.request().url().endsWith('.pbf')
      ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
      : route.fulfill({ json: style }));
    const query = new URLSearchParams({ mode, style: `${renderUrl}/surface-layout/style.json`, synthetic: '4096' });
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded
      && window.renderValidation.tileset.stats().renderableTiles > 0), { timeout: 60_000 }).toBe(true);
    const layout = await page.evaluate(() => {
      const { tileset, viewer, drawBatch } = window.renderValidation;
      viewer.scene.debugShowFramesPerSecond = true;
      const bucket = tileset._vectorRenderer;
      const primitives = [...new Set(bucket.tileIds.flatMap(id => bucket.getTileCollections(id)
        .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index) as NativePrimitive))))];
      window.surfaceResources = primitives.filter(primitive => primitive._attributeLocations
        && drawBatch(primitive)?.kind === 'fill');
      window.surfaceArrays = window.surfaceResources.map(primitive => [...primitive._va]);
      window.surfaceStable = () => window.surfaceResources.every((primitive, index) => !primitive.isDestroyed()
        && primitive._va.length === window.surfaceArrays[index].length
        && primitive._va.every((array, arrayIndex) => array === window.surfaceArrays[index][arrayIndex]));
      window.stopSurfacePixels = viewer.scene.postRender.addEventListener(() => {
        const pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
        window.surfacePixels = pixels;
      });
      window.surfaceSample = (color) => {
        const { canvas, scene } = viewer;
        const pixels = window.surfacePixels;
        if (!pixels)
          return { count: 0 };
        let count = 0;
        let position: { x: number; y: number } | undefined;
        const matches = (x: number, y: number) => color.every((channel, index) => Math.abs(pixels[(y * canvas.width + x) * 4 + index] - channel) < 3);
        for (let y = 32; y < canvas.height - 32; y++) {
          for (let x = 32; x < canvas.width - 32; x++) {
            if (!matches(x, y))
              continue;
            count++;
            if (!position && matches(x - 2, y) && matches(x + 2, y) && matches(x, y - 2) && matches(x, y + 2))
              position = { x: (x + 0.5) * canvas.clientWidth / canvas.width, y: (canvas.height - y - 0.5) * canvas.clientHeight / canvas.height };
          }
        }
        return { count, picked: position && scene.pick(position)?.id };
      };
      viewer.scene.requestRender();
      return window.surfaceResources.map(primitive => ({
        attributes: Object.keys(primitive._attributeLocations),
        coordinateLocations: Object.entries(primitive._attributeLocations).filter(([name]) => /^a_surface\d+$/.test(name)).map(([, location]) => location),
        descriptors: (primitive.appearance as typeof primitive.appearance & { uniforms: { surface_words: unknown[] } }).uniforms.surface_words.length,
        batchLocation: primitive._attributeLocations.batchId,
        arrays: primitive._va.map(array => ({
          vertices: array.numberOfVertices,
          vertexBytes: [...new Set(Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index).vertexBuffer))]
            .reduce((bytes, buffer) => bytes + (buffer?.sizeInBytes ?? 0), 0),
          attributes: Array.from({ length: array.numberOfAttributes }, (_, index) => {
            const attribute = array.getAttribute(index);
            return { index: attribute.index, type: attribute.componentDatatype, components: attribute.componentsPerAttribute, normalize: attribute.normalize };
          }),
        })),
      }));
    });
    assert.ok(layout.length > 0, 'no actual Native surface VA was uploaded');
    for (const primitive of layout) {
      assert.ok(primitive.attributes.every(name => name === 'batchId' || /^a_surface\d+$/.test(name)), 'planar surface retained an unpacked position track');
      assert.equal(primitive.descriptors, 6);
      for (const array of primitive.arrays) {
        const coordinates = primitive.coordinateLocations.map(location => array.attributes.find(attribute => attribute.index === location)!);
        assert.ok(coordinates.every((attribute, index) => attribute.type === 0x1401 && !attribute.normalize && attribute.components >= 1 && attribute.components <= 4 && (index === coordinates.length - 1 || attribute.components === 4)), 'surface coordinate bytes lost the unnormalized UBYTE layout');
        const coordinateBytes = coordinates.reduce((bytes, attribute) => bytes + attribute.components, 0);
        assert.ok(coordinateBytes <= 18, 'compressed planar coordinates exceed their exact original layout');
        assert.equal(array.vertexBytes / array.vertices, coordinateBytes + 2, 'actual Native VA byte capacity disagrees with its packed attributes');
      }
      assert.ok(primitive.arrays.every(array => array.attributes.some(attribute => attribute.index === primitive.batchLocation && attribute.type === 0x1403 && attribute.components === 1 && !attribute.normalize)), 'Native instance IDs were not uploaded as exact unsigned SHORT');
    }
    const floatReference = await page.evaluate(async () => {
      const fixtureUrl = new URL('./surface-float-reference.ts', location.href).href;
      const fixture = await import(/* @vite-ignore */ fixtureUrl) as typeof import('./fixtures/surface-float-reference');
      return fixture.compareSurfaceFloat(window.renderValidation.viewer, window.renderValidation.tileset);
    });
    const floatOutput = testInfo.outputPath('surface-float-reference.json');
    await writeFile(floatOutput, JSON.stringify(floatReference, null, 2));
    await testInfo.attach('surface-float-reference', { path: floatOutput, contentType: 'application/json' });
    assertFloatReference(floatReference);
    await expect.poll(() => page.evaluate(() => window.surfaceSample([255, 0, 0]).count)).toBeGreaterThan(100);
    const initial = await page.evaluate(() => window.surfaceSample([255, 0, 0]));
    assert.equal(initial.picked?.layerId, 'parcels');
    assert.equal(initial.picked?.featureIndex, 0);
    (style.layers[1] as FillLayerSpecification).paint!['fill-color'] = '#00ff00';
    await page.evaluate(style => window.renderValidation.tileset.setStyle(style), style);
    await expect.poll(() => page.evaluate(() => window.surfaceSample([0, 255, 0]).count)).toBeGreaterThan(100);
    assert.ok(await page.evaluate(() => window.surfaceStable()), 'paint replaced an uploaded surface VA');
    (style.layers[1] as FillLayerSpecification).paint!['fill-opacity'] = 0;
    await page.evaluate(style => window.renderValidation.tileset.setStyle(style), style);
    await expect.poll(() => page.evaluate(() => window.surfaceSample([0, 255, 0]).count)).toBe(0);
    (style.layers[1] as FillLayerSpecification).paint!['fill-opacity'] = 1;
    await page.evaluate(style => window.renderValidation.tileset.setStyle(style), style);
    await expect.poll(() => page.evaluate(() => window.surfaceSample([0, 255, 0]).count)).toBeGreaterThan(100);
    const final = await page.evaluate(() => {
      const { viewer, tileset, renderErrors } = window.renderValidation;
      const picked = window.surfaceSample([0, 255, 0]).picked;
      const result = { picked, stable: window.surfaceStable(), fps: viewer.scene.debugShowFramesPerSecond, renderErrors, destroyed: false };
      window.stopSurfacePixels();
      viewer.scene.primitives.remove(tileset);
      result.destroyed = window.surfaceResources.every(primitive => primitive.isDestroyed());
      return result;
    });
    assert.equal(final.picked?.layerId, 'parcels');
    assert.equal(final.picked?.featureIndex, 0);
    assert.ok(final.stable && final.fps && final.destroyed);
    assert.deepEqual(final.renderErrors, []);
    assert.deepEqual(errors, []);
    const output = testInfo.outputPath('surface-geometry.json');
    await writeFile(output, JSON.stringify({ mode, layout, floatReference, initial, final }, null, 2));
    await testInfo.attach('surface-geometry', { path: output, contentType: 'application/json' });
  });
}

test('surface morph uploads both exact position tracks and finishes in the 3D Native collection', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/surface-morph/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [{ 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } }],
  } satisfies StyleSpecification;
  await page.route('**/surface-morph/**', route => route.request().url().endsWith('.pbf')
    ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
    : route.fulfill({ json: style }));
  const query = new URLSearchParams({ mode: '2d', style: `${renderUrl}/surface-morph/style.json`, synthetic: '4096' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded
    && window.renderValidation.tileset.stats().renderableTiles > 0), { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => {
    const { tileset, viewer } = window.renderValidation;
    viewer.scene.debugShowFramesPerSecond = true;
    window.surfaceMorphLayouts = [];
    window.stopSurfaceMorph = viewer.scene.postRender.addEventListener(() => {
      if (viewer.scene.mode !== 0)
        return;
      const bucket = tileset._vectorRenderer;
      for (const primitive of bucket.tileIds.flatMap(id => bucket.getTileCollections(id)
        .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index) as NativePrimitive)))) {
        if (primitive._layout === 'surface-morph' && primitive.ready && primitive._va.length) {
          window.surfaceMorphLayouts.push({
            attributes: Object.keys(primitive._attributeLocations).sort(),
            descriptors: (primitive.appearance as typeof primitive.appearance & { uniforms: { surface_words: unknown[] } }).uniforms.surface_words.length,
            morphTime: viewer.scene.morphTime,
            arrays: primitive._va.map((array) => {
              const attributes = Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index));
              const batchId = attributes.find(attribute => attribute.index === primitive._attributeLocations.batchId);
              return {
                batchId: { type: batchId.componentDatatype, components: batchId.componentsPerAttribute, normalize: batchId.normalize },
                coordinates: Object.entries(primitive._attributeLocations).filter(([name]) => /^a_surface\d+$/.test(name)).map(([, location]) => {
                  const attribute = attributes.find(attribute => attribute.index === location)!;
                  return { type: attribute.componentDatatype, components: attribute.componentsPerAttribute, normalize: attribute.normalize };
                }),
                vertices: array.numberOfVertices,
                vertexBytes: [...new Set(attributes.map(attribute => attribute.vertexBuffer))].reduce((bytes, buffer) => bytes + (buffer?.sizeInBytes ?? 0), 0),
              };
            }),
          });
        }
      }
    });
    viewer.scene.morphTo3D(3);
  });
  const floatReference = await page.evaluate(async () => {
    const fixtureUrl = new URL('./surface-float-reference.ts', location.href).href;
    const fixture = await import(/* @vite-ignore */ fixtureUrl) as typeof import('./fixtures/surface-float-reference');
    for (let frame = 0; frame < 300; frame++) {
      const scene = window.renderValidation.viewer.scene;
      if (scene.mode === 0 && scene.morphTime > 0.2 && scene.morphTime < 0.8)
        return fixture.compareSurfaceFloat(window.renderValidation.viewer, window.renderValidation.tileset, true);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    throw new Error('surface FLOAT oracle missed the intermediate morph');
  });
  const floatOutput = testInfo.outputPath('surface-float-reference.json');
  await writeFile(floatOutput, JSON.stringify(floatReference, null, 2));
  await testInfo.attach('surface-float-reference', { path: floatOutput, contentType: 'application/json' });
  assertFloatReference(floatReference, true);
  await expect.poll(() => page.evaluate(() => window.surfaceMorphLayouts.length), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.renderValidation.viewer.scene.mode === 3
    && window.renderValidation.tileset.tilesLoaded), { timeout: 60_000 }).toBe(true);
  const result = await page.evaluate((floatReference) => {
    const { viewer, tileset, renderErrors } = window.renderValidation;
    const bucket = tileset._vectorRenderer;
    const collections = bucket.tileIds.flatMap(id => bucket.getTileCollections(id));
    window.stopSurfaceMorph();
    return { floatReference, layouts: window.surfaceMorphLayouts, renderErrors, fps: viewer.scene.debugShowFramesPerSecond, buffers3D: collections.filter(collection => collection.constructor.name === 'BufferPolygonCollection').length };
  }, floatReference);
  const output = testInfo.outputPath('surface-morph.json');
  await writeFile(output, JSON.stringify(result, null, 2));
  await testInfo.attach('surface-morph', { path: output, contentType: 'application/json' });
  for (const layout of result.layouts) {
    assert.ok(layout.attributes.every(name => name === 'batchId' || /^a_surface\d+$/.test(name)), 'morph surface retained unpacked position tracks');
    assert.equal(layout.descriptors, 12);
    for (const array of layout.arrays) {
      assert.ok(array.coordinates.every((attribute, index) => attribute.type === 0x1401 && !attribute.normalize && attribute.components >= 1 && attribute.components <= 4 && (index === array.coordinates.length - 1 || attribute.components === 4)));
      const coordinateBytes = array.coordinates.reduce((bytes, attribute) => bytes + attribute.components, 0);
      assert.ok(coordinateBytes <= 36);
      assert.equal(array.vertexBytes / array.vertices, coordinateBytes + 2, 'Native morph VA capacity disagrees with its packed attributes');
    }
    assert.ok(layout.arrays.every(array => array.batchId.type === 0x1403 && array.batchId.components === 1 && !array.batchId.normalize), 'Native morph instance IDs lost their exact unsigned SHORT layout');
  }
  assert.ok(result.layouts.some(layout => layout.morphTime > 0 && layout.morphTime < 1), 'no uploaded surface was observed during intermediate morph');
  assert.ok(result.buffers3D > 0 && result.fps);
  assert.deepEqual(result.renderErrors, []);
  assert.deepEqual(errors, []);
});
