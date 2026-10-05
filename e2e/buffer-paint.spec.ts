import type { CircleLayerSpecification, FillLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Color } from 'cesium';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativeBufferCollection, NativeVertexArray } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

type BufferPick = TilePickObject;
interface BufferSample { count: number; color?: number[]; picked?: BufferPick; samePick?: boolean }
interface StrokePhase { fill: number; stroke: number; width: number }
interface BufferOwner {
  tileId: string;
  layerId: string;
  collection: NativeBufferCollection;
  primitive: InstanceType<ReturnType<NativeBufferCollection['_getPrimitiveClass']>>;
  material: InstanceType<ReturnType<NativeBufferCollection['_getMaterialClass']>>;
  array: NativeVertexArray | undefined;
  pickIds: Array<{ color: Color }>;
}

declare global {
  interface Window {
    bufferOwners: BufferOwner[];
    bufferHandles: Set<WebGLBuffer>;
    bufferUploads: { allocations: number; updates: number };
    bufferStable: () => boolean;
    stopBufferPixels: () => void;
    bufferPixels: Uint8Array;
    bufferPaintAlpha: number[];
    bufferSample: (channel: number) => BufferSample;
    bufferInitialPicks: Array<BufferPick | undefined> | undefined;
    circleCoverage: () => { interior: number; edge: number };
  }
}

const tile = Buffer.from(fromGeojsonVt({
  ground: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  parcels: { features: [{ id: 200, type: 3, geometry: [[[768, 768], [2304, 768], [2304, 2304], [768, 2304], [768, 768]]], tags: {} }] },
  points: { features: [{ id: 300, type: 1, geometry: [[3072, 3072]], tags: {} }] },
}, { version: 2, extent: 4096 }));

test('3D fill and circle alpha crossings preserve Native collection, GPU buffers and pick identity', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/buffer-paint/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#000000', 'fill-antialias': false } },
      { 'id': 'parcels', 'type': 'fill', 'source': 'city', 'source-layer': 'parcels', 'paint': { 'fill-color': '#ff0000', 'fill-antialias': false } },
      { 'id': 'points', 'type': 'circle', 'source': 'city', 'source-layer': 'points', 'paint': { 'circle-color': '#00ff00', 'circle-radius': 18 } },
    ],
  } satisfies StyleSpecification;
  await page.route('**/buffer-paint/**', route => route.request().url().endsWith('.pbf')
    ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
    : route.fulfill({ json: style }));
  const query = new URLSearchParams({ mode: '3d', antialias: '0', style: `${renderUrl}/buffer-paint/style.json`, synthetic: '4096' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => !!window.renderValidation)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const validation = window.renderValidation;
    return validation && {
      loaded: validation.tileset.tilesLoaded,
      globeLoaded: validation.viewer.scene.globe.tilesLoaded,
      renderable: validation.tileset.stats().renderableTiles > 0,
      stats: validation.tileset.stats(),
      errors: validation.renderErrors,
    };
  }), { timeout: 60_000 }).toMatchObject({ loaded: true, globeLoaded: true, renderable: true });
  const initial = await page.evaluate(() => {
    const { tileset, viewer, drawBatch } = window.renderValidation;
    viewer.scene.debugShowFramesPerSecond = true;
    viewer.scene.postProcessStages.fxaa.enabled = false;
    const bucket = tileset._vectorRenderer;
    window.bufferOwners = bucket.tileIds.flatMap(tileId => bucket.getTileCollections(tileId)
      .filter(collection => ['parcels', 'points'].includes(drawBatch(collection)?.layerId ?? ''))
      .map((source) => {
        const collection = source as NativeBufferCollection;
        return {
          tileId,
          collection,
          layerId: drawBatch(collection)!.layerId,
          primitive: new (collection._getPrimitiveClass())(),
          material: new (collection._getMaterialClass())(),
          array: collection._renderContext?.vertexArray,
          pickIds: [...collection._pickIds.values()].flat(),
        };
      }));
    const uploaded = window.bufferOwners.filter(owner => owner.array);
    window.bufferHandles = new Set(uploaded.flatMap(({ array }) => [
      ...Array.from({ length: array!.numberOfAttributes }, (_, index) => array!.getAttribute(index).vertexBuffer?._getBuffer()),
      array!.indexBuffer?._getBuffer(),
    ]).filter((buffer): buffer is WebGLBuffer => buffer !== undefined));
    window.bufferUploads = { allocations: 0, updates: 0 };
    const gl = viewer.scene.context._gl;
    const bufferData = gl.bufferData;
    const bufferSubData = gl.bufferSubData;
    const observes = (target: number) => window.bufferHandles.has(gl.getParameter(target === gl.ELEMENT_ARRAY_BUFFER
      ? gl.ELEMENT_ARRAY_BUFFER_BINDING
      : gl.ARRAY_BUFFER_BINDING));
    gl.bufferData = function (...args: [number, number | AllowSharedBufferSource | null, number, number?, number?]) {
      if (observes(args[0]))
        window.bufferUploads.allocations++;
      return Reflect.apply(bufferData, this, args);
    };
    gl.bufferSubData = function (...args: [number, number, AllowSharedBufferSource | null, number?, number?]) {
      if (observes(args[0]))
        window.bufferUploads.updates++;
      return Reflect.apply(bufferSubData, this, args);
    };
    window.bufferStable = () => window.bufferOwners.every((owner) => {
      const collection = owner.collection;
      const picks = [...collection._pickIds.values()].flat();
      return !collection.isDestroyed()
        && bucket.getTileCollections(owner.tileId).includes(collection)
        && (!owner.array || collection._renderContext?.vertexArray === owner.array)
        && owner.pickIds.length === picks.length
        && owner.pickIds.every((pick, index) => picks[index] === pick);
    });
    window.stopBufferPixels = viewer.scene.postRender.addEventListener(() => {
      window.bufferPixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
      window.bufferPaintAlpha = window.bufferOwners.map(owner => owner.collection.get(0, owner.primitive).getMaterial(owner.material).color.alpha);
    });
    window.bufferSample = (channel) => {
      const pixels = window.bufferPixels;
      const { canvas, scene } = viewer;
      if (!pixels)
        return { count: 0 };
      let count = 0;
      let position: { x: number; y: number } | undefined;
      let color: number[] | undefined;
      const matches = (x: number, y: number) => {
        const index = (y * canvas.width + x) * 4;
        return pixels[index + channel] > 30
          && [0, 1, 2].every(axis => axis === channel || pixels[index + axis] < pixels[index + channel] - 20);
      };
      for (let y = 32; y < canvas.height - 32; y++) {
        for (let x = 32; x < canvas.width - 32; x++) {
          if (!matches(x, y))
            continue;
          count++;
          if (!position && matches(x - 2, y) && matches(x + 2, y) && matches(x, y - 2) && matches(x, y + 2)) {
            position = { x: (x + 0.5) * canvas.clientWidth / canvas.width, y: (canvas.height - y - 0.5) * canvas.clientHeight / canvas.height };
            color = [...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)];
          }
        }
      }
      const picked = position && scene.pick(position) as BufferPick | undefined;
      if (position && !window.bufferInitialPicks)
        window.bufferInitialPicks = [];
      if (picked && !window.bufferInitialPicks![channel])
        window.bufferInitialPicks![channel] = picked;
      return { count, color, picked, samePick: picked === window.bufferInitialPicks?.[channel] };
    };
    window.circleCoverage = () => {
      const pixels = window.bufferPixels;
      const { width, height } = viewer.canvas;
      let interior = 0;
      let edge = 0;
      for (let y = 32; y < height - 32; y++) {
        for (let x = 32; x < width - 32; x++) {
          const index = (y * width + x) * 4;
          if (pixels[index] > 2 || pixels[index + 2] > 2)
            continue;
          const green = pixels[index + 1];
          if (green >= 250)
            interior++;
          else if (green > 2)
            edge++;
        }
      }
      return { interior, edge };
    };
    viewer.scene.requestRender();
    return {
      collections: window.bufferOwners.length,
      uploaded: uploaded.length,
      kinds: [...new Set(uploaded.map(owner => owner.collection.constructor.name))],
      buffers: window.bufferHandles.size,
    };
  });
  assert.ok(initial.collections > 0 && initial.uploaded > 0 && initial.buffers > 0);
  assert.equal(initial.uploaded, initial.collections, 'every captured Native collection must have its GPU VA');
  assert.deepEqual(initial.kinds.sort(), ['BufferPointCollection', 'BufferPolygonCollection']);
  type BufferLifecycle = Awaited<ReturnType<typeof nativeLifecycle>>;
  const samples: Array<{ alpha: number; lifecycle: BufferLifecycle } | ({ alpha: number; channel: number } & BufferSample)> = [];
  const nativeLifecycle = () => page.evaluate(async () => {
    const { viewer } = window.renderValidation;
    const owners = window.bufferOwners.filter(owner => owner.array);
    const commands = owners.map(owner => owner.collection._renderContext.command);
    const states = owners.map(owner => owner.collection._renderContext.renderState);
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => {
        const remove = viewer.scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        viewer.scene.requestRender();
      });
    }
    return {
      commandsStable: owners.every((owner, index) => owner.collection._renderContext.command === commands[index]),
      statesStable: owners.every((owner, index) => owner.collection._renderContext.renderState === states[index]),
      blends: owners.map(owner => ({ layerId: owner.layerId, enabled: owner.collection._renderContext.renderState.blending.enabled })),
    };
  });
  for (const alpha of [1, 0.5, 0, 1]) {
    (style.layers[1] as FillLayerSpecification).paint!['fill-opacity'] = alpha;
    (style.layers[2] as CircleLayerSpecification).paint!['circle-opacity'] = alpha;
    await page.evaluate(style => window.renderValidation.tileset.setStyle(style), style);
    await expect.poll(() => page.evaluate(alpha => window.renderValidation.tileset.tilesLoaded
      && window.bufferPaintAlpha?.every(value => Math.abs(value - alpha) < 0.01), alpha)).toBe(true);
    const lifecycle = await nativeLifecycle();
    assert.ok(lifecycle.commandsStable && lifecycle.statesStable, 'steady paint rebuilt Native commands or render states');
    if (alpha === 1) {
      const coverage = await page.evaluate(() => window.circleCoverage());
      const output = testInfo.outputPath(`circle-coverage-${samples.length}.json`);
      await writeFile(output, JSON.stringify({ alpha, coverage, lifecycle }, null, 2));
      await testInfo.attach('circle-coverage', { path: output, contentType: 'application/json' });
      assert.ok(coverage.interior > 100, 'the coverage test did not render opaque circle interiors');
      assert.ok(coverage.edge > 20, 'opaque circle edges lost Native shader antialiasing coverage');
    }
    assert.ok(lifecycle.blends.every(({ layerId, enabled }) => enabled === (layerId === 'points' || alpha < 1)), 'Native blend state must preserve circle edge coverage and fill opacity');
    samples.push({ alpha, lifecycle });
    for (const channel of [0, 1]) {
      if (alpha === 0)
        await expect.poll(() => page.evaluate(channel => window.bufferSample(channel).count, channel)).toBe(0);
      else
        await expect.poll(() => page.evaluate(channel => window.bufferSample(channel).count, channel)).toBeGreaterThan(100);
      const sample = await page.evaluate(channel => window.bufferSample(channel), channel);
      samples.push({ alpha, channel, ...sample });
      if (alpha > 0) {
        assert.equal(sample.picked?.layerId, channel === 0 ? 'parcels' : 'points');
        assert.ok(sample.samePick, 'paint changed the actual Native pick object');
        if (alpha === 0.5)
          assert.ok(sample.color![channel] < 240, 'translucent paint rendered as opaque');
      }
    }
    assert.ok(await page.evaluate(() => window.bufferStable()), 'alpha crossing replaced Native ownership or GPU VA');
  }
  const strokeSamples: Array<{ phase: StrokePhase; lifecycle: BufferLifecycle; channels: Array<{ channel: number } & BufferSample> }> = [];
  for (const phase of [
    { fill: 1, stroke: 0.5, width: 4 },
    { fill: 0, stroke: 1, width: 4 },
    { fill: 1, stroke: 0, width: 0 },
    { fill: 1, stroke: 1, width: 4 },
  ]) {
    Object.assign((style.layers[2] as CircleLayerSpecification).paint!, {
      'circle-opacity': phase.fill,
      'circle-stroke-color': '#0000ff',
      'circle-stroke-opacity': phase.stroke,
      'circle-stroke-width': phase.width,
    });
    await page.evaluate(style => window.renderValidation.tileset.setStyle(style), style);
    await expect.poll(() => page.evaluate(phase => window.renderValidation.tileset.tilesLoaded
      && window.bufferOwners.filter(owner => owner.layerId === 'points').every(owner =>
        Math.abs(owner.material.color.alpha - phase.fill) < 0.01
        && Math.abs(owner.material.outlineColor.alpha - phase.stroke) < 0.01
        && owner.material.outlineWidth === phase.width), phase)).toBe(true);
    const lifecycle = await nativeLifecycle();
    assert.ok(lifecycle.commandsStable && lifecycle.statesStable, 'steady stroke paint rebuilt Native commands or render states');
    assert.ok(lifecycle.blends.every(({ layerId, enabled }) => enabled === (layerId === 'points')));
    const channels: Array<{ channel: number } & BufferSample> = [];
    for (const channel of [1, 2]) {
      const visible = channel === 1 ? phase.fill > 0 : phase.stroke > 0 && phase.width > 0;
      if (visible)
        await expect.poll(() => page.evaluate(channel => window.bufferSample(channel).count, channel)).toBeGreaterThan(30);
      else
        await expect.poll(() => page.evaluate(channel => window.bufferSample(channel).count, channel)).toBe(0);
      const sample = await page.evaluate(channel => window.bufferSample(channel), channel);
      if (visible) {
        assert.equal(sample.picked?.layerId, 'points');
        assert.ok(sample.samePick, 'stroke paint changed the actual Native pick object');
        if (channel === 2 && phase.stroke === 0.5)
          assert.ok(sample.color![2] < 240, 'translucent stroke rendered as opaque');
      }
      channels.push({ channel, ...sample });
    }
    assert.ok(await page.evaluate(() => window.bufferStable()), 'stroke paint replaced Native ownership or GPU VA');
    strokeSamples.push({ phase, lifecycle, channels });
  }
  const final = await page.evaluate(() => {
    const { viewer, tileset, renderErrors } = window.renderValidation;
    const result = { stable: window.bufferStable(), uploads: window.bufferUploads, fps: viewer.scene.debugShowFramesPerSecond, renderErrors, destroyed: false };
    window.stopBufferPixels();
    viewer.scene.primitives.remove(tileset);
    result.destroyed = window.bufferOwners.every(owner => !owner.collection._renderContext
      && (!owner.array || owner.array.isDestroyed())
      && owner.pickIds.every(pick => viewer.scene.context.getObjectByPickColor(pick.color) === undefined));
    return result;
  });
  assert.ok(final.stable && final.destroyed && final.fps);
  assert.equal(final.uploads.allocations, 0, 'paint reallocated an existing Native GPU buffer');
  assert.ok(final.uploads.updates > 0, 'the test did not observe actual Native GPU paint uploads');
  assert.deepEqual(final.renderErrors, []);
  assert.deepEqual(errors, []);
  const output = testInfo.outputPath('buffer-paint.json');
  await writeFile(output, JSON.stringify({ initial, samples, strokeSamples, final }, null, 2));
  await testInfo.attach('buffer-paint', { path: output, contentType: 'application/json' });
});
