import type { LineLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import type { LineFamilyChunk } from '../packages/cesium-vector-tileset/src/render/line/line-family';
import type { DrawBatch } from '../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativePrimitive, NativeTexture, NativeVertexArray } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

type LineFamilyResource = (NativePrimitive | Omit<LineFamilyChunk, 'primitive'>) & {
  primitive?: NativePrimitive;
  _layers?: LineFamilyChunk['_layers'];
  _va?: NativeVertexArray[];
  [key: symbol]: DrawBatch | undefined;
};

declare global {
  interface Window {
    lineFamilyCurrentResources: () => LineFamilyResource[];
    lineFamilyResources: LineFamilyResource[];
    lineFamilyPrimitiveOwners: (entries: LineFamilyResource[]) => NativePrimitive[];
    lineFamilyArrayOwners: Map<NativePrimitive, NativeVertexArray[]>;
    lineFamilyTextureOwners: Map<NativePrimitive, NativeTexture | undefined>;
    lineFamilyBuffersStable: () => boolean;
    lineFamilyArrays: NativeVertexArray[];
    lineFamilyTextures: NativeTexture[];
    stopLineFamilyPixels: () => void;
    lineFamilySnapshot: Uint8Array;
    lineFamilyCommands: Record<string, number>;
    lineFamilyPixels: (color: number[]) => { count: number; position?: { x: number; y: number }; picked?: TilePickObject };
    lineFamilyBuilding: () => TilePickObject | undefined;
  }
}

const tile = Buffer.from(fromGeojsonVt({
  ground: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  buildings: { features: [{ type: 3, geometry: [[[1024, 1024], [3072, 1024], [3072, 3072], [1024, 3072], [1024, 1024]]], tags: {} }] },
  roads: { features: Array.from({ length: 32 }, (_, index) => ({
    type: 2,
    geometry: [Array.from({ length: 33 }, (_, step) => [step * 128, (index + 0.5) * 128 + Math.round(Math.sin(step * Math.PI / 4) * 4)])],
    tags: {},
  })) },
}, { version: 2, extent: 4096 }));

test('roads and buildings retain paint and picking through 2D, CV and 3D handoffs and release GPU resources', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  let tileRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/line-family/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } },
      { 'id': 'buildings', 'type': 'fill-extrusion', 'source': 'city', 'source-layer': 'buildings', 'paint': { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 80 } },
      ...([['casing', '#00cc00', 24], ['roads', '#ffffff', 6]] as Array<[string, string, number]>).map(([id, color, width]) => ({
        'id': id,
        'type': 'line',
        'source': 'city',
        'source-layer': 'roads',
        'layout': { 'line-join': 'miter', 'line-cap': 'butt' },
        'paint': { 'line-color': color, 'line-width': width },
      } satisfies LineLayerSpecification)),
    ],
  } satisfies StyleSpecification;
  await page.route('**/line-family/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('.pbf')) {
      tileRequests++;
      return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
    }
    return route.fulfill({ json: style });
  });
  const query = new URLSearchParams({ mode: '2d', style: `${renderUrl}/line-family/style.json`, synthetic: '4096', atlas: '1' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => {
    const validation = window.renderValidation;
    return validation?.tileset.tilesLoaded && validation.tileset.stats().renderableTiles > 0 && validation.viewer.scene.globe.tilesLoaded;
  }), { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => {
    const { tileset, viewer } = window.renderValidation;
    viewer.scene.debugShowFramesPerSecond = true;
    const bucket = tileset._renderer.vector;
    window.lineFamilyCurrentResources = () => [...new Set([...bucket.tileIds.flatMap(tileId => bucket.getTileCollections(tileId)
      .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index) as LineFamilyResource)
        .filter(entry => (entry.primitive && entry._layers?.length === 2)
          || (entry._va?.length && ['line', 'dash'].includes(entry[Symbol.for('cesium-vector-tileset.draw-batch')]?.kind ?? ''))))), ...[...tileset._renderer.pattern._tiles.values()].flatMap(entries => entries.map(entry => entry.primitive as LineFamilyResource))])];
    window.lineFamilyResources = window.lineFamilyCurrentResources();
    window.lineFamilyPrimitiveOwners = entries => [...new Set(entries.map(entry => (entry.primitive ?? entry) as NativePrimitive))];
    const owners = window.lineFamilyPrimitiveOwners(window.lineFamilyResources);
    window.lineFamilyArrayOwners = new Map(owners.map(primitive => [primitive, [...primitive._va]]));
    window.lineFamilyTextureOwners = new Map(owners.map(primitive => [primitive, primitive.positionTexture]));
    window.lineFamilyBuffersStable = () => {
      const current = window.lineFamilyCurrentResources();
      return current.length === window.lineFamilyResources.length
        && current.every(entry => window.lineFamilyResources.includes(entry) && !entry.isDestroyed())
        && window.lineFamilyPrimitiveOwners(current).every((primitive) => {
          const original = window.lineFamilyArrayOwners.get(primitive);
          const texture = window.lineFamilyTextureOwners.get(primitive);
          const arrays = primitive._va;
          return original && !primitive.isDestroyed() && primitive.positionTexture === texture
            && (!texture || !texture.isDestroyed()) && arrays.length === original.length
            && arrays.every((array, index) => array === original[index]);
        });
    };
    window.lineFamilyArrays = [...new Set(owners.flatMap(primitive => primitive._va))];
    window.lineFamilyTextures = [...new Set(owners.map(primitive => primitive.positionTexture).filter((texture): texture is NativeTexture => !!texture))];
    const width = viewer.canvas.width;
    const height = viewer.canvas.height;
    const x = 0;
    const y = 0;
    const rowWidth = width;
    const rows = height;
    // With preserveDrawingBuffer:false only postRender reliably owns the
    // displayed framebuffer. Picking has its own framebuffer as well.
    window.stopLineFamilyPixels = viewer.scene.postRender.addEventListener(() => {
      window.lineFamilySnapshot = viewer.scene.context.readPixels({ x, y, width: rowWidth, height: rows });
      const commands: Record<string, number> = {};
      const key = Symbol.for('cesium-vector-tileset.draw-batch');
      for (const command of viewer.scene._frameState.commandList) {
        const batch = (command as unknown as Record<symbol, DrawBatch | undefined>)[key]
          ?? (command.owner as Record<symbol, DrawBatch | undefined> | undefined)?.[key];
        if (batch)
          commands[batch.layerId] = (commands[batch.layerId] ?? 0) + 1;
      }
      window.lineFamilyCommands = commands;
    });
    window.lineFamilyPixels = (color) => {
      const pixels = window.lineFamilySnapshot;
      if (!pixels)
        return { count: 0 };
      const matches = (column: number, row: number) => color.every((channel, index) => Math.abs(pixels[(row * rowWidth + column) * 4 + index] - channel) < 3);
      let count = 0;
      let position: { x: number; y: number } | undefined;
      for (let row = 2; row < rows - 2; row++) {
        for (let column = 2; column < rowWidth - 2; column++) {
          if (!matches(column, row))
            continue;
          count++;
          if (!position && matches(column, row - 1) && matches(column, row + 1)
            && matches(column - 1, row) && matches(column + 1, row)) {
            position = { x: (x + column + 0.5) * viewer.canvas.clientWidth / width, y: (height - y - row - 0.5) * viewer.canvas.clientHeight / height };
          }
        }
      }
      return { count, position, picked: position && viewer.scene.pick(position, 1, 1)?.id };
    };
    window.lineFamilyBuilding = () => {
      const pixels = window.lineFamilySnapshot;
      const blue = (column: number, row: number) => {
        const offset = (row * rowWidth + column) * 4;
        return pixels[offset + 2] > 100 && pixels[offset + 2] > pixels[offset] * 4 && pixels[offset + 2] > pixels[offset + 1] * 4;
      };
      for (let row = 2; row < rows - 2; row++) {
        for (let column = 2; column < rowWidth - 2; column++) {
          if (blue(column, row) && blue(column - 2, row) && blue(column + 2, row)
            && blue(column, row - 2) && blue(column, row + 2)) {
            const position = { x: (x + column + 0.5) * viewer.canvas.clientWidth / width, y: (height - y - row - 0.5) * viewer.canvas.clientHeight / height };
            return viewer.scene.pick(position)?.id;
          }
        }
      }
    };
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.lineFamilyPixels([255, 255, 255]).count)).toBeGreaterThan(8);
  const initial = await page.evaluate(() => ({
    resources: window.lineFamilyResources.length,
    shared: window.lineFamilyResources.every(entry => entry._layers?.length === 2),
    arrays: window.lineFamilyArrays.length,
    white: window.lineFamilyPixels([255, 255, 255]),
    green: window.lineFamilyPixels([0, 204, 0]),
  }));
  assert.ok(initial.resources > 0 && initial.arrays >= initial.resources, 'family did not upload real shared Primitive buffers');
  assert.ok(initial.white.count > 8 && initial.green.count > 8, 'both family layers must produce visible pixels');
  assert.equal(initial.white.picked?.layerId, 'roads', 'top layer pick did not use its replay batch table');
  assert.equal(initial.green.picked?.layerId, 'casing', 'casing pick lost the base Native instance ID');
  assert.ok(initial.shared, 'solid layers lost their shared physical Primitive');
  const beforeRequests = tileRequests;
  const next = structuredClone(style);
  const roadPaint = (next.layers.find(layer => layer.id === 'roads') as LineLayerSpecification).paint!;
  roadPaint['line-color'] = '#ff0000';
  roadPaint['line-width'] = 10;
  await page.evaluate(next => window.renderValidation.tileset.setStyle(next), next);
  await expect.poll(() => page.evaluate(() => window.lineFamilyPixels([255, 0, 0]).count)).toBeGreaterThan(initial.white.count);
  await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
  const painted = await page.evaluate(() => ({
    red: window.lineFamilyPixels([255, 0, 0]),
    green: window.lineFamilyPixels([0, 204, 0]),
    white: window.lineFamilyPixels([255, 255, 255]).count,
    stable: window.lineFamilyBuffersStable(),
    fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
    errors: window.renderValidation.renderErrors,
  }));
  assert.equal(painted.red.picked?.layerId, 'roads');
  assert.equal(painted.green.picked?.layerId, 'casing');
  assert.equal(painted.white, 0, 'old paint survived after the new frame');
  assert.ok(painted.stable, 'paint replaced the uploaded family geometry');
  assert.equal(tileRequests, beforeRequests, 'paint refetched source tiles');
  assert.ok(painted.fps, 'Native Cesium FPS must remain enabled');
  for (const property of ['line-width', 'line-opacity'] as const) {
    const invisible = structuredClone(next);
    (invisible.layers.find(layer => layer.id === 'roads') as LineLayerSpecification).paint![property] = 0;
    await page.evaluate(invisible => window.renderValidation.tileset.setStyle(invisible), invisible);
    await expect.poll(() => page.evaluate(() => window.lineFamilyPixels([255, 0, 0]).count)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.lineFamilyCommands.roads ?? 0), { message: `${property} zero retained Native roads commands` }).toBe(0);
    assert.ok(await page.evaluate(() => (window.lineFamilyCommands.casing ?? 0) > 0), `${property} zero removed the visible casing commands`);
    assert.ok(await page.evaluate(() => window.lineFamilyBuffersStable()), `${property} zero replaced line buffers or position textures`);
    await page.evaluate(next => window.renderValidation.tileset.setStyle(next), next);
    await expect.poll(() => page.evaluate(() => window.lineFamilyPixels([255, 0, 0]).count)).toBeGreaterThan(initial.white.count);
    assert.ok(await page.evaluate(() => (window.lineFamilyCommands.roads ?? 0) > 0), `${property} restoration did not submit Native roads commands`);
    assert.equal((await page.evaluate(() => window.lineFamilyPixels([255, 0, 0]))).picked?.layerId, 'roads', `${property} restoration lost roads picking`);
    assert.ok(await page.evaluate(() => window.lineFamilyBuffersStable()), `${property} restoration replaced line buffers or position textures`);
  }
  assert.equal(tileRequests, beforeRequests, 'line restoration refetched source tiles');
  // Leave gaps between the dense road rows so the same framebuffer can
  // verify buildings as well as roads throughout the mode handoff.
  await page.evaluate(() => {
    const { tileset, viewer } = window.renderValidation;
    tileset._renderer.style.setPaintProperty('casing', 'line-width', 14);
    tileset._renderer.style.setPaintProperty('roads', 'line-width', 6);
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.lineFamilyBuilding()?.layerId)).toBe('buildings');
  const transitions = [];
  for (const target of ['cv', '2d', '3d', '2d'] as const) {
    const samples = await page.evaluate(async (target) => {
      const { viewer, tileset } = window.renderValidation;
      const fromMode = viewer.scene.mode;
      const frames: Array<{ roads: number; casing: number; buildings: number }> = [];
      const stop = viewer.scene.postRender.addEventListener(() => {
        const pixels = window.lineFamilySnapshot;
        let roads = 0;
        let casing = 0;
        let buildings = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset] === 255 && pixels[offset + 1] === 0 && pixels[offset + 2] === 0)
            roads++;
          if (pixels[offset] === 0 && pixels[offset + 1] === 204 && pixels[offset + 2] === 0)
            casing++;
          if (pixels[offset + 2] > 100 && pixels[offset + 2] > pixels[offset] * 4 && pixels[offset + 2] > pixels[offset + 1] * 4)
            buildings++;
        }
        frames.push({ roads, casing, buildings });
      });
      const oldResources = window.lineFamilyCurrentResources();
      const oldOwners = window.lineFamilyPrimitiveOwners(oldResources);
      const oldArrays = oldOwners.flatMap(owner => owner._va);
      const oldTextures = oldOwners.map(owner => owner.positionTexture).filter((texture): texture is NativeTexture => !!texture);
      const buildings = () => [...tileset._renderer.vector._records.values()].flatMap((record) => {
        const collection = record.collections.get('extrusions') as PrimitiveCollection | undefined;
        return collection ? Array.from({ length: collection.length }, (_, index) => collection.get(index) as NativePrimitive) : [];
      });
      const oldBuildings = buildings();
      const oldBuildingArrays = oldBuildings.flatMap(primitive => primitive._va);
      try {
        if (target === 'cv')
          viewer.scene.morphToColumbusView(0);
        else if (target === '3d')
          viewer.scene.morphTo3D(0);
        else viewer.scene.morphTo2D(0);
        window.renderValidation.setTopView();
        const expectedMode = target === 'cv' ? 1 : target === '3d' ? 3 : 2;
        for (let frame = 0; frame < 600; frame++) {
          await new Promise<void>((resolve) => {
            viewer.scene.postRender.addEventListener(function once() {
              viewer.scene.postRender.removeEventListener(once);
              resolve();
            });
            viewer.scene.requestRender();
          });
          const records = [...tileset._renderer.vector._records.values()];
          if (records.length > 0 && records.every(record => record.mode === expectedMode)
            && tileset.tilesLoaded && oldResources.every(resource => resource.isDestroyed())) {
            return {
              frames,
              fromMode,
              mode: viewer.scene.mode,
              roads: window.lineFamilyPixels([255, 0, 0]),
              casing: window.lineFamilyPixels([0, 204, 0]),
              building: window.lineFamilyBuilding(),
              released: oldOwners.every(owner => owner.isDestroyed()) && oldArrays.every(array => array.isDestroyed()) && oldTextures.every(texture => texture.isDestroyed()),
              buildingsReleased: oldBuildings.length > 0 && oldBuildings.every(owner => owner.isDestroyed()) && oldBuildingArrays.every(array => array.isDestroyed()),
              fps: viewer.scene.debugShowFramesPerSecond,
            };
          }
        }
        throw new Error('Scene mode did not publish and release a complete replacement generation');
      }
      finally { stop(); }
    }, target);
    transitions.push({ ...samples, target });
  }
  const transitionPath = testInfo.outputPath('line-mode-transitions.json');
  await writeFile(transitionPath, JSON.stringify(transitions, null, 2));
  await testInfo.attach('line-mode-transitions', { path: transitionPath, contentType: 'application/json' });
  for (const { target, ...samples } of transitions) {
    assert.equal(samples.mode, target === 'cv' ? 1 : target === '3d' ? 3 : 2);
    assert.ok(samples.frames.length > 0 && samples.roads.count > 8 && samples.casing.count > 8, 'mode replacement did not publish visible road/casing layers');
    assert.ok(samples.frames.every(frame => frame.roads > 8 && frame.casing > 8), 'mode replacement produced an empty road/casing frame');
    assert.ok(samples.frames.every(frame => frame.buildings > 8), `${target}: mode replacement produced an empty building frame`);
    assert.equal(samples.roads.picked?.layerId, 'roads');
    assert.equal(samples.casing.picked?.layerId, 'casing');
    assert.equal(samples.building?.layerId, 'buildings');
    assert.ok(samples.buildingsReleased, 'mode replacement leaked the old building owner or VA');
    assert.ok(samples.released && samples.fps);
  }
  assert.deepEqual(painted.errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
  assert.deepEqual(errors, []);
  const destroyed = await page.evaluate(() => {
    const { viewer, tileset } = window.renderValidation;
    window.stopLineFamilyPixels();
    const current = window.lineFamilyCurrentResources();
    const currentOwners = window.lineFamilyPrimitiveOwners(current);
    const owners = window.lineFamilyPrimitiveOwners([...window.lineFamilyResources, ...current]);
    const arrays = [...new Set([...window.lineFamilyArrays, ...currentOwners.flatMap(primitive => primitive._va)])];
    const textures = [...new Set([...window.lineFamilyTextures, ...currentOwners.map(primitive => primitive.positionTexture).filter((texture): texture is NativeTexture => !!texture)])];
    viewer.scene.primitives.remove(tileset);
    return { primitives: [...window.lineFamilyResources, ...current].every(entry => entry.isDestroyed()) && owners.every(primitive => primitive.isDestroyed()), arrays: arrays.every(array => array.isDestroyed()), textures: textures.length > 0 && textures.every(texture => texture.isDestroyed()) };
  });
  assert.ok(destroyed.primitives && destroyed.arrays && destroyed.textures, 'Native family resources survived tileset removal');
});
