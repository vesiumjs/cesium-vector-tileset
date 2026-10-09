import type { FillExtrusionLayerSpecification, LayerSpecification, LineLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import type { LineFamilyChunk } from '../packages/cesium-vector-tileset/src/render/line/line-family';
import type { DrawBatch } from '../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativePrimitive, NativeTexture, NativeVertexArray } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import * as Cesium from 'cesium';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

const Pass = (Cesium as typeof Cesium & { Pass: { OPAQUE: number; OVERLAY: number } }).Pass;

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
  labels: { features: [{ type: 1, geometry: [[2048, 2048]], tags: {} }] },
  roads: { features: Array.from({ length: 32 }, (_, index) => ({
    type: 2,
    geometry: [Array.from({ length: 33 }, (_, step) => [step * 128, (index + 0.5) * 128 + Math.round(Math.sin(step * Math.PI / 4) * 4)])],
    tags: {},
  })) },
}, { version: 2, extent: 4096 }));

const sprite = createCanvas(16, 8);
const spriteContext = sprite.getContext('2d');
spriteContext.fillStyle = '#0000ff';
spriteContext.fillRect(0, 0, 8, 8);
spriteContext.fillStyle = '#ff00ff';
spriteContext.fillRect(8, 0, 8, 8);

for (const [mode, kind] of ['2d', 'cv', '3d'].flatMap(mode => ['solid', 'dash'].map(kind => [mode, kind]))) {
  test(`${kind} line buffers preserve paint, style picking and destruction in ${mode}`, async ({ page, renderUrl }, testInfo) => {
    const errors: string[] = [];
    let tileRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    const style = {
      version: 8,
      transition: { duration: 0, delay: 0 },
      ...(kind === 'dash' ? { sprite: `${renderUrl}/line-family/sprite` } : {}),
      sources: { city: { type: 'vector', tiles: [`${renderUrl}/line-family/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
      layers: [
        { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': mode === '3d', ...(mode === '3d' ? { 'fill-outline-color': '#224455' } : {}) } },
        { 'id': 'buildings', 'type': 'fill-extrusion', 'source': 'city', 'source-layer': 'buildings', 'paint': { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 80, ...(kind === 'dash' ? { 'fill-extrusion-pattern': 'building-blue' } : {}) } },
        ...([['casing', '#00cc00', 24], ['roads', '#ffffff', 6]] as Array<[string, string, number]>).map(([id, color, width]) => ({
          'id': id,
          'type': 'line',
          'source': 'city',
          'source-layer': 'roads',
          'layout': { 'line-join': 'miter', 'line-cap': 'butt' },
          'paint': { 'line-color': color, 'line-width': width, ...(kind === 'dash' ? { 'line-dasharray': [3, 1] } : {}) },
        } satisfies LineLayerSpecification)),
      ],
    } satisfies StyleSpecification;
    await page.route('**/line-family/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('sprite.png'))
        return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
      if (url.endsWith('sprite.json'))
        return route.fulfill({ json: { 'building-blue': { x: 0, y: 0, width: 8, height: 8, pixelRatio: 1 }, 'label-magenta': { x: 8, y: 0, width: 8, height: 8, pixelRatio: 1 } } });
      if (url.endsWith('.pbf')) {
        tileRequests++;
        return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
      }
      return route.fulfill({ json: style });
    });
    const query = new URLSearchParams({ mode, style: `${renderUrl}/line-family/style.json`, synthetic: '4096', atlas: '1' });
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
    const storage = await page.evaluate(() => {
      const owners = window.lineFamilyPrimitiveOwners(window.lineFamilyResources)
        .filter(primitive => ['line'].includes(primitive._layout));
      const textures = [...new Set(owners.map(primitive => primitive.positionTexture))];
      return {
        owners: owners.length,
        textures: textures.map(texture => texture && ({ width: texture.width, height: texture.height, bytes: texture.sizeInBytes, destroyed: texture.isDestroyed() })),
        textureCapacityBytes: textures.reduce((bytes, texture) => bytes + (texture?.sizeInBytes ?? 0), 0),
        uploads: owners.flatMap((primitive) => {
          const names = new Map(Object.entries(primitive._attributeLocations).map(([name, location]) => [location, name]));
          return primitive._va.map((array) => {
            const attributes = Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index));
            return {
              layout: Object.fromEntries(attributes.map(attribute => [names.get(attribute.index), {
                componentDatatype: attribute.componentDatatype,
                components: attribute.componentsPerAttribute,
                normalize: attribute.normalize,
              }])),
              vertices: array.numberOfVertices,
              vertexBytes: [...new Set(attributes.map(attribute => attribute.vertexBuffer))]
                .reduce((bytes, buffer) => bytes + (buffer?.sizeInBytes ?? 0), 0),
            };
          });
        }),
      };
    });
    const { uploads } = storage;
    const uploadPath = testInfo.outputPath('line-native-layout.json');
    await writeFile(uploadPath, JSON.stringify(storage, null, 2));
    await testInfo.attach('line-native-layout', { path: uploadPath, contentType: 'application/json' });
    if (kind === 'solid')
      assert.ok(initial.shared, `${mode}: solid layers lost their shared physical Primitive`);
    assert.ok(uploads.length > 0, 'no real Native line VA was inspected');
    assert.equal(storage.textures.length, storage.owners, 'physical line owners must own distinct position textures');
    assert.ok(storage.textureCapacityBytes > 0 && storage.textures.every(texture => texture && texture.width > 0 && texture.height > 0 && texture.bytes > 0 && !texture.destroyed), 'Native position texture capacity was not captured');
    for (const upload of uploads) {
      assert.deepEqual(upload.layout.a_lineRecord, { componentDatatype: 5126, components: 1, normalize: false }, `${mode}: Native VA did not retain FLOAT position record IDs`);
      for (const name of ['position3DHigh', 'position3DLow', 'position2DHigh', 'position2DLow', 'prevOffset', 'nextOffset'])
        assert.ok(!upload.layout[name], `${mode}: redundant ${name} was uploaded`);
      assert.deepEqual(upload.layout.a_lineFlags, { componentDatatype: 5121, components: 1, normalize: false }, `${mode}: Native VA did not retain byte line roles`);
      assert.deepEqual(upload.layout.batchId, { componentDatatype: 5123, components: 1, normalize: false }, `${mode}: Native VA did not retain exact unsigned 16-bit instance IDs`);
      assert.ok(!upload.layout.a_cornerParam, `${mode}: line uploaded redundant corner parameters`);
      assert.equal(upload.vertexBytes / upload.vertices, kind === 'dash' ? 35 : 7, `${mode}: Native vertex capacity differs from the record layout`);
    }
    if (mode === '3d') {
      const depth = await page.evaluate(() => ({ logDepth: window.renderValidation.viewer.scene._frameState.useLogDepth, building: window.lineFamilyBuilding() }));
      assert.ok(depth.logDepth, '3D pick must exercise the Native logarithmic-depth derivative');
      assert.equal(depth.building?.layerId, 'buildings', 'surface picking ignored the visible physical building');
    }
    if (mode === '3d') {
      const cache = await page.evaluate(async () => {
        const { viewer } = window.renderValidation;
        const native = window.renderValidation.atlas!.cesium as unknown as {
          DerivedCommand: { createLogDepthCommand: (command: { owner?: object }, ...args: unknown[]) => unknown };
        };
        const derive = native.DerivedCommand.createLogDepthCommand;
        const derivations: Record<string, number> = { roads: 0, casing: 0, outline: 0 };
        native.DerivedCommand.createLogDepthCommand = function (command, ...args) {
          const batch = window.renderValidation.drawBatch(command) ?? window.renderValidation.drawBatch(command.owner);
          if (batch?.kind === 'fill-outline')
            derivations.outline++;
          else if (batch && batch.layerId in derivations)
            derivations[batch.layerId]++;
          return derive.call(this, command, ...args);
        };
        const { heading, pitch, roll } = viewer.camera;
        const before = window.renderValidation.renderedFrames;
        try {
          for (const offset of [0.0001, -0.0001, 0.0001, 0]) {
            await new Promise<void>((resolve) => {
              const stop = viewer.scene.postRender.addEventListener(() => {
                stop();
                resolve();
              });
              viewer.camera.setView({ orientation: { heading: heading + offset, pitch, roll } });
            });
          }
          const outlines = viewer.scene._frameState.commandList.filter(command =>
            (window.renderValidation.drawBatch(command) ?? window.renderValidation.drawBatch(command.owner))?.kind === 'fill-outline').length;
          return { derivations, frames: window.renderValidation.renderedFrames - before, commands: window.lineFamilyCommands.roads ?? 0, outlines, stable: window.lineFamilyBuffersStable() };
        }
        finally {
          native.DerivedCommand.createLogDepthCommand = derive;
        }
      });
      await writeFile(testInfo.outputPath('line-family-derived-cache.json'), JSON.stringify(cache, null, 2));
      expect(cache.frames).toBeGreaterThanOrEqual(4);
      expect(cache.commands).toBeGreaterThan(0);
      expect(cache.outlines).toBeGreaterThan(0);
      expect(cache.stable).toBe(true);
      expect(cache.derivations).toEqual({ roads: 0, casing: 0, outline: 0 });
    }
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
    if (mode === '3d') {
      const invisible = structuredClone(next);
      for (const layer of invisible.layers) {
        if (layer.type === 'line')
          layer.paint!['line-opacity'] = 0;
      }
      await page.evaluate(invisible => window.renderValidation.tileset.setStyle(invisible), invisible);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window.lineFamilyCommands.roads ?? 0) + (window.lineFamilyCommands.casing ?? 0))).toBe(0);
      const hiddenUpdates = await page.evaluate(async (visible) => {
        const { viewer, tileset } = window.renderValidation;
        const owners = new Set(window.lineFamilyCurrentResources().filter(entry => (entry.primitive && entry._layers?.length === 2)
          || entry[Symbol.for('cesium-vector-tileset.draw-batch')]?.kind === 'dash').map(entry => (entry.primitive ?? entry) as NativePrimitive));
        let updates = 0;
        const native = window.renderValidation.atlas!.cesium.Primitive.prototype as unknown as { update: (this: NativePrimitive, frame: unknown) => void };
        const update = native.update;
        native.update = function (frame) {
          if (owners.has(this))
            updates++;
          update.call(this, frame);
        };
        const { heading, pitch, roll } = viewer.camera;
        const before = window.renderValidation.renderedFrames;
        try {
          for (const offset of [0.0001, -0.0001, 0.0001, 0]) {
            await new Promise<void>((resolve) => {
              const stop = viewer.scene.postRender.addEventListener(() => {
                stop();
                resolve();
              });
              viewer.camera.setView({ orientation: { heading: heading + offset, pitch, roll } });
            });
          }
          const hidden = {
            owners: owners.size,
            updates,
            frames: window.renderValidation.renderedFrames - before,
            stable: window.lineFamilyBuffersStable(),
            pixels: window.lineFamilyPixels([255, 0, 0]).count + window.lineFamilyPixels([0, 204, 0]).count,
          };
          await new Promise<void>((resolve) => {
            const stop = viewer.scene.postRender.addEventListener(() => {
              if (updates > 0) {
                stop();
                resolve();
              }
            });
            tileset.setStyle(visible);
          });
          return { ...hidden, restoredUpdates: updates };
        }
        finally {
          native.update = update;
        }
      }, next);
      assert.ok(hiddenUpdates.owners > 0, 'all-zero validation observed no Native owners');
      assert.ok(hiddenUpdates.frames >= 4, 'all-zero validation did not render camera motion');
      assert.equal(hiddenUpdates.updates, 0, 'ready all-zero families still updated their Native owners');
      assert.ok(hiddenUpdates.restoredUpdates > 0, 'Native delegate observer did not see restored owners update');
      assert.ok(hiddenUpdates.stable, 'camera motion replaced hidden family resources');
      assert.equal(hiddenUpdates.pixels, 0, 'hidden owners retained visible pixels');
      await expect.poll(() => page.evaluate(() => window.lineFamilyPixels([255, 0, 0]).count)).toBeGreaterThan(initial.white.count);
      assert.equal((await page.evaluate(() => window.lineFamilyPixels([255, 0, 0]))).picked?.layerId, 'roads');
      assert.equal((await page.evaluate(() => window.lineFamilyPixels([0, 204, 0]))).picked?.layerId, 'casing');
      assert.ok(await page.evaluate(() => window.lineFamilyBuffersStable()), 'all-zero restoration replaced Native resources');
      assert.equal(tileRequests, beforeRequests, 'all-zero restoration refetched source tiles');
    }
    if (mode === '3d') {
      const cameraPaint = structuredClone(next);
      const paint = (cameraPaint.layers.find(layer => layer.id === 'roads') as LineLayerSpecification).paint!;
      // These literal linear stops make width = zoom and alpha = zoom / 24.
      paint['line-width'] = ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 24];
      paint['line-opacity'] = ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 1];
      await page.evaluate(cameraPaint => window.renderValidation.tileset.setStyle(cameraPaint), cameraPaint);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      const samples = await page.evaluate(async () => {
        const { tileset, viewer } = window.renderValidation;
        const renderer = tileset._renderer.vector;
        const updatePaint = renderer.updatePaint;
        const initialHeight = viewer.camera.positionCartographic.height;
        const initialZoom = window.renderValidation.zoom;
        const applied = [...renderer._records.values()].map(record => ({ record, zoom: record.paint.lastZoom }));
        // Only admission to heavy paint changes; StyleEvaluation and all
        // Native uploads, commands and uniform getters still run normally.
        renderer.updatePaint = frame => updatePaint.call(renderer, { ...frame, budget: { exhausted: true } });
        const frames: Array<{ zoom: number; widths: number[]; alphas: number[]; stable: boolean; heavyPaintUntouched: boolean }> = [];
        try {
          for (let index = 0; index < 4; index++) {
            viewer.camera.zoomIn(initialHeight * 0.001);
            await new Promise<void>((resolve) => {
              const stop = viewer.scene.postRender.addEventListener(() => {
                stop();
                const key = Symbol.for('cesium-vector-tileset.draw-batch');
                const commands = viewer.scene._frameState.commandList.filter((command) => {
                  const batch = (command as unknown as Record<symbol, DrawBatch | undefined>)[key]
                    ?? (command.owner as Record<symbol, DrawBatch | undefined> | undefined)?.[key];
                  return batch?.layerId === 'roads';
                });
                frames.push({
                  zoom: window.renderValidation.zoom,
                  widths: commands.map(command => command.uniformMap!.u_line_width() as number),
                  alphas: commands.map(command => (command.uniformMap!.u_line_color() as Cesium.Color).alpha),
                  stable: window.lineFamilyBuffersStable(),
                  heavyPaintUntouched: applied.every(({ record, zoom }) => record.paint.lastZoom === zoom),
                });
                resolve();
              });
              viewer.scene.requestRender();
            });
          }
        }
        finally {
          renderer.updatePaint = updatePaint;
          viewer.camera.zoomOut(initialHeight - viewer.camera.positionCartographic.height);
          viewer.scene.requestRender();
        }
        return { initialZoom, frames };
      });
      assert.ok(samples.frames.every(frame => frame.zoom > samples.initialZoom), 'camera did not change the evaluated zoom');
      for (const frame of samples.frames) {
        assert.ok(frame.widths.length > 0 && frame.alphas.length > 0, 'Native roads commands disappeared');
        assert.ok(frame.widths.every(width => Math.abs(width - frame.zoom) < 1e-6), 'exhausted budget delayed Native camera width uniforms');
        assert.ok(frame.alphas.every(alpha => Math.abs(alpha - frame.zoom / 24) < 1e-6), 'exhausted budget delayed Native camera opacity uniforms');
        assert.ok(frame.stable, 'camera uniforms replaced uploaded buffers or position textures');
        assert.ok(frame.heavyPaintUntouched, 'live uniforms marked budgeted record paint complete');
      }
      assert.equal(tileRequests, beforeRequests, 'camera uniforms refetched source tiles');
      await page.evaluate(next => window.renderValidation.tileset.setStyle(next), next);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      const heldCamera = structuredClone(next);
      const cutoff = await page.evaluate(() => window.renderValidation.zoom + 0.0001);
      const heldPaint = (heldCamera.layers.find(layer => layer.id === 'roads') as LineLayerSpecification).paint!;
      heldPaint['line-width'] = ['step', ['zoom'], 10, cutoff, 0];
      heldPaint['line-opacity'] = ['step', ['zoom'], 1, cutoff, 0];
      await page.evaluate(heldCamera => window.renderValidation.tileset.setStyle(heldCamera), heldCamera);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const key = Symbol.for('cesium-vector-tileset.draw-batch');
        const commands = window.renderValidation.viewer.scene._frameState.commandList.filter((command) => {
          const batch = (command as unknown as Record<symbol, DrawBatch | undefined>)[key]
            ?? (command.owner as Record<symbol, DrawBatch | undefined> | undefined)?.[key];
          return batch?.layerId === 'roads';
        });
        return commands.length > 0 && commands.every(command => command.uniformMap!.u_line_width() === 10
          && (command.uniformMap!.u_line_color() as Cesium.Color).alpha === 1)
        && window.lineFamilyPixels([255, 0, 0]).picked?.layerId === 'roads';
      }), { message: 'old camera expression did not commit real Native paint before freezing' }).toBe(true);
      const heldSuccessor = structuredClone(heldCamera);
      const successorRoads = heldSuccessor.layers.find(layer => layer.id === 'roads') as LineLayerSpecification;
      successorRoads.layout!['line-join'] = 'bevel';
      successorRoads.paint!['line-width'] = 18;
      successorRoads.paint!['line-opacity'] = 1;
      successorRoads.paint!['line-color'] = '#ff00ff';
      const heldResult = await page.evaluate(async ({ heldSuccessor, cutoff }) => {
        const { tileset, viewer } = window.renderValidation;
        const renderer = tileset._renderer.vector;
        const queue = tileset._renderer.publishQueue;
        const drain = queue.drain;
        const sceneCollections = tileset._renderer.collections;
        const pump = sceneCollections.pumpFirstUpdates;
        const initialHeight = viewer.camera.positionCartographic.height;
        const original = new Map(renderer._records);
        const oldResources = window.lineFamilyCurrentResources();
        const oldOwners = window.lineFamilyPrimitiveOwners(oldResources);
        const arrays = new Map(oldOwners.map(owner => [owner, [...owner._va]]));
        const textures = new Map(oldOwners.map(owner => [owner, owner.positionTexture]));
        const atlas = renderer.dashMaterial.material.uniforms.u_dashAtlas;
        const usesDash = oldResources.some(resource => resource[Symbol.for('cesium-vector-tileset.draw-batch')]?.kind === 'dash');
        const stable = () => oldResources.every(resource => !resource.isDestroyed())
          && oldOwners.every(owner => !owner.isDestroyed()
            && owner.positionTexture === textures.get(owner)
            && owner._va.length === arrays.get(owner)!.length
            && owner._va.every((array, index) => array === arrays.get(owner)![index]))
          && (!usesDash || renderer.dashMaterial.material.uniforms.u_dashAtlas === atlas);
        const frame = () => new Promise<void>((resolve) => {
          const stop = viewer.scene.postRender.addEventListener(() => {
            stop();
            resolve();
          });
          viewer.scene.requestRender();
        });
        const commands = () => viewer.scene._frameState.commandList.filter((command) => {
          const key = Symbol.for('cesium-vector-tileset.draw-batch');
          const batch = (command as unknown as Record<symbol, DrawBatch | undefined>)[key]
            ?? (command.owner as Record<symbol, DrawBatch | undefined> | undefined)?.[key];
          return batch?.layerId === 'roads';
        });
        const uniforms = () => commands().map(command => ({ width: command.uniformMap!.u_line_width() as number, alpha: (command.uniformMap!.u_line_color() as Cesium.Color).alpha }));
        const heldMaps = commands().map(command => command.uniformMap!);
        const hidden = async (stage: string) => {
          for (let index = 0; index < 3; index++) {
            viewer.camera.zoomIn(initialHeight * 0.001);
            await frame();
            const paints = heldMaps.map(map => ({ width: map.u_line_width() as number, alpha: (map.u_line_color() as Cesium.Color).alpha }));
            if (window.renderValidation.zoom <= cutoff || paints.length === 0)
              throw new Error(`${stage}: did not cross the camera cutoff with Native roads commands`);
            if (!paints.every(paint => paint.width === 0 && paint.alpha === 0))
              throw new Error(`${stage}: held Native camera paint did not become zero: ${JSON.stringify(paints)}`);
            if (commands().length !== 0)
              throw new Error(`${stage}: zero camera paint retained Native color or pick commands`);
            const redPixels = window.lineFamilyPixels([255, 0, 0]).count;
            if (redPixels > 0)
              throw new Error(`${stage}: zero camera paint retained ${redPixels} red pixels`);
            if (!stable())
              throw new Error(`${stage}: camera paint replaced held Native storage`);
          }
        };
        let publishedGeneration = false;
        let deletedRecords = 0;
        try {
          // Only successor publication admission is held; real style evaluation,
          // Native commands, GPU buffers, picking and camera projection continue.
          queue.drain = () => 0;
          sceneCollections.pumpFirstUpdates = (state, budget, measure, minimumProgress) => pump.call(sceneCollections, state, publishedGeneration ? { exhausted: true } : budget, measure, publishedGeneration ? false : minimumProgress);
          tileset.setStyle(heldSuccessor);
          await frame();
          if (!original.size || ![...original.values()].every(record => record.paint.frozen))
            throw new Error('structural style replacement did not hold the committed generation');
          if (window.lineFamilyPixels([255, 0, 0]).picked?.layerId !== 'roads')
            throw new Error(`held generation lost Native roads picking before its successor: ${JSON.stringify({ zoom: window.renderValidation.zoom, cutoff, paints: uniforms(), pixels: window.lineFamilyPixels([255, 0, 0]) })}`);
          await hidden('before successor publication');
          viewer.camera.zoomOut(initialHeight - viewer.camera.positionCartographic.height);
          await frame();
          if (!uniforms().every(paint => paint.width === 10 && paint.alpha === 1)
            || window.lineFamilyPixels([255, 0, 0]).picked?.layerId !== 'roads') {
            throw new Error('held generation did not restore its old camera curve and picking');
          }
          // Let actual publication replace the renderer record, then stop
          // admission while SceneCollections still draws replacement.old.
          queue.drain = (budget, _maxCommits, priority, minimumProgress) => {
            if (publishedGeneration)
              return 0;
            return drain.call(queue, {
              get exhausted() {
                deletedRecords = [...original].filter(([tileId, record]) => {
                  const current = renderer._records.get(tileId);
                  return current && current !== record;
                }).length;
                publishedGeneration = deletedRecords > 0;
                return publishedGeneration || budget.exhausted;
              },
              takeMinimumProgress: budget.takeMinimumProgress?.bind(budget),
            }, 1, priority, minimumProgress);
          };
          for (let index = 0; index < 120; index++) {
            await frame();
            if (publishedGeneration)
              break;
          }
          if (!publishedGeneration || ![...tileset._renderer.collections._replacements].some(replacement => replacement.kind === 'vector' && (replacement.awaitingDetail || replacement.waiting.size > 0) && replacement.old.size > 0)) {
            throw new Error(`real publication did not leave a drawable held generation: ${JSON.stringify({
              publishedGeneration,
              deletedRecords,
              replacements: [...tileset._renderer.collections._replacements].map(replacement => ({ tileId: replacement.tileId, kind: replacement.kind, detail: replacement.awaitingDetail, old: replacement.old.size, next: replacement.next.size, waiting: replacement.waiting.size })),
              records: [...renderer._records].map(([tileId, record]) => ({ tileId, complete: record.complete, frozen: record.paint.frozen })),
            })}`);
          }
          await hidden('after successor publication removed the old record');
          return { deletedRecords, heldOwners: oldOwners.length };
        }
        finally {
          queue.drain = drain;
          sceneCollections.pumpFirstUpdates = pump;
          viewer.camera.zoomOut(initialHeight - viewer.camera.positionCartographic.height);
          viewer.scene.requestRender();
        }
      }, { heldSuccessor, cutoff });
      assert.ok(heldResult.deletedRecords > 0 && heldResult.heldOwners > 0, 'held Native regression did not cross the renderer/scene ownership seam');
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      await page.evaluate(next => window.renderValidation.tileset.setStyle(next), next);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
    }
    if (mode === '2d' && kind === 'solid') {
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
                const current = window.lineFamilyCurrentResources();
                const owners = window.lineFamilyPrimitiveOwners(current);
                return {
                  frames,
                  fromMode,
                  mode: viewer.scene.mode,
                  rows: owners.map(owner => ({ vertices: owner._va.reduce((total, array) => total + array.numberOfVertices, 0), instances: owner._numberOfInstances })),
                  roads: window.lineFamilyPixels([255, 0, 0]),
                  casing: window.lineFamilyPixels([0, 204, 0]),
                  building: window.lineFamilyBuilding(),
                  buildingArrays: buildings().flatMap(primitive => primitive._va.map((array) => {
                    const buffers = new Set(Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index).vertexBuffer));
                    return {
                      layout: primitive._layout,
                      attributes: Object.keys(primitive._attributeLocations),
                      vertices: array.numberOfVertices,
                      vertexBytes: [...buffers].reduce((sum, buffer) => sum + buffer.sizeInBytes, 0),
                      indexBytes: array.indexBuffer?.sizeInBytes ?? 0,
                    };
                  })),
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
        assert.ok(samples.rows.length > 0 && samples.rows.every(row => row.vertices === row.instances * 128), 'mode replacement lost incoming or outgoing segment roles');
        assert.equal(samples.roads.picked?.layerId, 'roads');
        assert.equal(samples.casing.picked?.layerId, 'casing');
        assert.equal(samples.building?.layerId, 'buildings');
        assert.ok(samples.buildingArrays.length > 0 && samples.buildingArrays.every(array => array.layout === 'extrusion'
          && ['a_extrusionHigh3D', 'a_extrusionLow3D', 'a_extrusionHigh2D', 'a_extrusionLow2D'].every(name => array.attributes.includes(name))), 'building lost packed cross-mode positions');
        assert.ok(samples.buildingsReleased, 'mode replacement leaked the old building owner or VA');
        assert.ok(samples.released && samples.fps);
      }
    }
    if (mode === '3d' && kind === 'dash') {
      const translucent = structuredClone(next);
      (translucent.layers.find(layer => layer.id === 'buildings') as FillExtrusionLayerSpecification).paint!['fill-extrusion-opacity'] = 0.5;
      (translucent.layers as LayerSpecification[]).push({
        'id': 'labels',
        'type': 'symbol',
        'source': 'city',
        'source-layer': 'labels',
        'layout': { 'icon-image': 'label-magenta', 'icon-size': 4, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      });
      await page.evaluate(translucent => window.renderValidation.tileset.setStyle(translucent), translucent);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.lineFamilyPixels([255, 0, 255]).count)).toBeGreaterThan(16);
      const building = await page.evaluate(() => window.lineFamilyBuilding());
      assert.equal(building?.layerId, 'buildings', 'translucent building lost its physical pick');
      await page.evaluate(() => window.renderValidation.viewer.scene.requestRender());
      await expect.poll(() => page.evaluate(({ opaquePass, overlayPass }) => {
        const { viewer } = window.renderValidation;
        const commands = viewer.scene._frameState.commandList.filter(command =>
          (command.owner as Record<symbol, DrawBatch | undefined>)?.[Symbol.for('cesium-vector-tileset.draw-batch')]?.kind === 'extrusion');
        const labels = viewer.scene._frameState.commandList.filter(command =>
          (command.owner as Record<symbol, DrawBatch | undefined>)?.[Symbol.for('cesium-vector-tileset.draw-batch')]?.layerId === 'labels');
        return !viewer.scene._frameState.passes.pick && commands.length > 0
          && commands.every((command) => {
            const layer = command as unknown as { pass: number; _commands?: Array<{ owner: { appearance: { isTranslucent: () => boolean } }; renderState: { depthMask: boolean; blending: { enabled: boolean } } }> };
            return layer.pass === opaquePass && layer._commands && layer._commands.length > 0
              && layer._commands.every(source => source.owner.appearance.isTranslucent()
                && source.renderState.depthMask && !source.renderState.blending.enabled);
          })
          && labels.length > 0 && labels.every(command => command.pass === overlayPass);
      }, { opaquePass: Pass.OPAQUE, overlayPass: Pass.OVERLAY })).toBe(true);
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
}
