import type { FillLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Material, Primitive, PrimitiveCollection } from 'cesium';
import type { Page, TestInfo } from 'playwright/test';
import type { TilesetStyleSpecification } from '../packages/cesium-vector-tileset/src/tileset-options';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    trackFrames: Array<{ coverage: number[]; diagnostic?: unknown }>;
    stopTrackFrames: () => void;
    imageUpdateFrames: number[][];
    stopImageUpdateFrames: () => void;
    iconUpdateFrames: number[][];
    stopIconUpdateFrames: () => void;
    restoreRasterMaterialUpdates: () => void;
    patternLinePixels: () => number;
    stopPatternLinePixels: () => void;
    canvasHandoffResources: Primitive[];
    canvasResizeFrames: number[][];
    stopCanvasResizeFrames: () => void;
  }
}

const blue = [51, 102, 170];
const green = [34, 170, 85];
const tiles = Object.fromEntries(['a', 'b'].map(source => [source, fromGeojsonVt({
  land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: { pattern: source === 'a' ? 'blue' : 'green' } }] },
  icons: { features: Array.from({ length: 256 }, (_, index) => ({ type: 1, geometry: [[(index % 16 + 0.5) * 256, (Math.floor(index / 16) + 0.5) * 256]], tags: {} })) },
  roads: { features: Array.from({ length: 32 }, (_, index) => ({ type: 2, geometry: [[[0, (index + 0.5) * 128], [4096, (index + 0.5) * 128]]], tags: {} })) },
}, { version: 2, extent: 4096 })]));

function image(color: string, width = 8, height = 8) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas;
}

function style(baseUrl: string, track: string, source = 'a'): TilesetStyleSpecification {
  const raster = track === 'raster';
  return {
    version: 8,
    sprite: `${baseUrl}/tracks/sprite`,
    sources: { fixture: raster
      ? { type: 'raster', tiles: [`${baseUrl}/tracks/${source}/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 12 }
      : { type: 'vector', tiles: [`${baseUrl}/tracks/${source}/{z}/{x}/{y}.pbf`], maxzoom: 12 } },
    layers: [raster
      ? { id: 'land', type: 'raster', source: 'fixture', paint: { 'raster-fade-duration': 0 } }
      : { 'id': 'land', 'type': 'fill', 'source': 'fixture', 'source-layer': 'land', 'paint': { 'fill-antialias': false, ...(track === 'pattern' ? { 'fill-pattern': ['get', 'pattern'] } : { 'fill-color': '#22aa55' }) } }],
  };
}

async function open(page: Page, baseUrl: string, initial: TilesetStyleSpecification, spriteSize = 8) {
  const requests: string[] = [];
  const errors: string[] = [];
  const sprite = image('#3366aa', spriteSize * 2, spriteSize);
  const spriteContext = sprite.getContext('2d');
  spriteContext.fillStyle = '#22aa55';
  spriteContext.fillRect(spriteSize, 0, spriteSize, spriteSize);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/tracks/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (/\/b\//.test(url))
      await new Promise<void>(resolve => setTimeout(resolve, 150));
    if (url.endsWith('.pbf'))
      return route.fulfill({ body: Buffer.from(tiles[url.includes('/b/') ? 'b' : 'a']), contentType: 'application/x-protobuf' });
    if (url.includes('sprite') && url.endsWith('.png'))
      return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
    if (url.includes('sprite') && url.endsWith('.json'))
      return route.fulfill({ json: { blue: { x: 0, y: 0, width: spriteSize, height: spriteSize, pixelRatio: 1 }, green: { x: spriteSize, y: 0, width: spriteSize, height: spriteSize, pixelRatio: 1 } } });
    if (url.endsWith('.png'))
      return route.fulfill({ body: image(url.includes('/b/') ? '#22aa55' : '#3366aa').toBuffer('image/png'), contentType: 'image/png' });
    return route.fulfill({ json: initial });
  });
  const query = new URLSearchParams({ style: `${baseUrl}/tracks/style.json`, synthetic: '4096' });
  if (initial.layers[0].type === 'raster')
    query.set('atlas', '1');
  await page.goto(`${baseUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded ?? false)).toBe(true);
  return { requests, errors };
}

async function replace(page: Page, next: TilesetStyleSpecification, expected: number[], testInfo: TestInfo, name: string) {
  await page.evaluate(({ nextJson, blue, green }) => {
    const next: TilesetStyleSpecification = JSON.parse(nextJson);
    const validation = window.renderValidation;
    window.trackFrames = [];
    window.stopTrackFrames = validation.viewer.scene.postRender.addEventListener(() => {
      const previous = validation.readCoverage(blue);
      const current = validation.readCoverage(green);
      const coverage = previous.map((ratio, index) => ratio + current[index]);
      const frame: { coverage: number[]; diagnostic?: unknown } = { coverage };
      if (coverage.some(ratio => ratio < 0.98)) {
        const tileset = validation.tileset;
        frame.diagnostic = {
          stats: tileset.stats(),
          blackCoverage: validation.readCoverage([0, 0, 0]),
          whiteCoverage: validation.readCoverage([255, 255, 255]),
          pixels: validation.readPixelSamples(),
          vector: [...tileset._renderer.vector.collections].map(([id, collection]) => ({ id, show: collection.show, length: (collection as PrimitiveCollection).length })),
          patterns: [...tileset._renderer.pattern._tiles].flatMap(([id, entries]) => entries.map(entry => ({ id, show: entry.primitive.show, ready: entry.primitive.ready, layerId: entry.id.layerId, parentShow: entry.collection.show }))),
          retainedPatterns: [...tileset._renderer.pattern.collections].map(([id, collection]) => ({ id, show: collection.show, length: (collection as PrimitiveCollection).length })),
          rasters: [...tileset._renderer.raster._tiles].flatMap(([id, entries]) => entries.map((entry) => {
            const owner = entry.type === 'dynamic' ? entry.batch : entry;
            const texture = owner.material?.uniforms.image as { width: number; height: number; isDestroyed?: () => boolean } | undefined;
            return { id, show: owner.primitive?.show, ready: owner.primitive?.ready, parentShow: owner.collection.show, fade: owner.material?.uniforms.u_fade, opacity: owner.material?.uniforms.opacity, texture: texture && { width: texture.width, height: texture.height, destroyed: texture.isDestroyed?.() }, source: { width: owner.sourceIdentity.width, height: owner.sourceIdentity.height } };
          })),
          jobs: [...tileset._renderer.publishQueue._jobs.values()].map(job => ({ tileId: job.tileId, progress: job.generation.publication })),
          firstUpdates: tileset._renderer.collections._firstUpdates.flatMap(queue => [...queue].map(([collection, update]) => ({ show: collection.show, length: (collection as PrimitiveCollection).length, index: update.index }))),
        };
      }
      window.trackFrames.push(frame);
    });
    validation.tileset.setStyle(next);
  }, { nextJson: JSON.stringify(next), blue, green });
  let frames;
  try {
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), expected)).toBeGreaterThanOrEqual(0.98);
    await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
  }
  finally {
    frames = await page.evaluate(() => {
      window.stopTrackFrames();
      return window.trackFrames;
    });
    const output = testInfo.outputPath(`${name}.json`);
    await writeFile(output, JSON.stringify(frames, null, 2));
    await testInfo.attach(name, { path: output, contentType: 'application/json' });
  }
  assert.ok(frames.length > 0, 'style replacement produced no sampled frames');
  assert.ok(frames.every(frame => frame.coverage.every(ratio => ratio >= 0.98)), `${name}: tile pixels disappeared: ${JSON.stringify(frames.map(frame => frame.coverage))}`);
}

test('public solid and pattern paint switches replace geometry without empty frames', async ({ page, renderUrl }, testInfo) => {
  const { errors } = await open(page, renderUrl, style(renderUrl, 'solid'));
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), green)).toBeGreaterThanOrEqual(0.98);
  await replace(page, style(renderUrl, 'pattern'), blue, testInfo, 'solid-to-pattern');
  await replace(page, style(renderUrl, 'solid'), green, testInfo, 'pattern-to-solid');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});

test('animated canvas hands its visible pixels and resources to a vector source with the same ID', async ({ page, renderUrl }, testInfo) => {
  // This catches shared dynamic owners surviving a public source/track handoff,
  // and verifies that delayed replacement data never exposes an empty frame.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const canvas = document.createElement('canvas');
      canvas.id = 'handoff-canvas';
      canvas.width = canvas.height = 16;
      canvas.hidden = true;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#3366aa';
      context.fillRect(0, 0, canvas.width, canvas.height);
      document.body.append(canvas);
    }, { once: true });
  });
  const initial = style(renderUrl, 'raster');
  initial.sources.fixture = {
    type: 'canvas',
    canvas: 'handoff-canvas',
    animate: true,
    coordinates: [[-1.1276, 52.5072], [0.8724, 52.5072], [0.8724, 50.5072], [-1.1276, 50.5072]],
  };
  const { errors, requests } = await open(page, renderUrl, initial);
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  const zoom = await page.evaluate(() => {
    const renderer = window.renderValidation.tileset._renderer;
    const resources = new Set<Primitive>();
    for (const id of renderer.raster.tileIds) {
      renderer.raster.someTilePrimitive(id, (primitive) => {
        resources.add(primitive);
        return false;
      });
    }
    window.canvasHandoffResources = [...resources];
    return renderer.style.getSource('fixture')!.maxzoom;
  });
  await page.evaluate((color) => {
    const validation = window.renderValidation;
    window.canvasResizeFrames = [];
    window.stopCanvasResizeFrames = validation.viewer.scene.postRender.addEventListener(() => {
      window.canvasResizeFrames.push(validation.readCoverage(color));
    });
    const canvas = document.getElementById('handoff-canvas') as HTMLCanvasElement;
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3366aa';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, blue);
  await expect.poll(() => page.evaluate(() => {
    const entries = [...window.renderValidation.tileset._renderer.raster._tiles.values()].flat();
    return entries.length > 0 && entries.every((entry) => {
      if (entry.type !== 'dynamic')
        return false;
      const texture = entry.batch.material?.uniforms.image as { width: number; height: number } | undefined;
      return texture?.width === 32 && texture.height === 32;
    }) && window.canvasResizeFrames.length >= 3;
  })).toBe(true);
  const resizeFrames = await page.evaluate(() => {
    window.stopCanvasResizeFrames();
    return {
      coverage: window.canvasResizeFrames,
      ownersSurvived: window.canvasHandoffResources.every(resource => !resource.isDestroyed()),
    };
  });
  assert.ok(resizeFrames.ownersSurvived, 'canvas resize replaced an already uploaded geometry owner');
  assert.ok(resizeFrames.coverage.every(frame => frame.every(ratio => ratio >= 0.98)), 'canvas resize exposed an empty frame');
  const next = style(renderUrl, 'solid', 'b');
  const source = next.sources.fixture;
  if (source.type !== 'vector')
    throw new Error('The canvas successor must be a vector source');
  source.minzoom = source.maxzoom = zoom;
  await replace(page, next, green, testInfo, 'canvas-vector-handoff');
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.renderValidation.tileset._renderer;
    return renderer.raster.stats.layerCollections === 0 && renderer.raster.stats.tiles === 0
      && window.canvasHandoffResources.length > 0 && window.canvasHandoffResources.every(resource => resource.isDestroyed());
  })).toBe(true);
  assert.ok(requests.some(url => url.includes('/b/') && url.endsWith('.pbf')));
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});

test('image lines repaint width and opacity and draw in every surface mode', async ({ page, renderUrl }) => {
  const initial = style(renderUrl, 'solid');
  initial.transition = { duration: 0, delay: 0 };
  initial.layers = [{
    'id': 'roads',
    'type': 'line',
    'source': 'fixture',
    'source-layer': 'roads',
    'layout': { 'line-cap': 'round', 'line-join': 'round' },
    'paint': { 'line-pattern': 'blue', 'line-width': 2 },
  }];
  const { errors, requests } = await open(page, renderUrl, initial);
  await page.evaluate((color) => {
    const { viewer } = window.renderValidation;
    const context = viewer.scene.context as unknown as { readPixels: (options: object) => Uint8Array };
    let count = 0;
    window.stopPatternLinePixels = viewer.scene.postRender.addEventListener(() => {
      const pixels = context.readPixels({ x: 0, y: 0, width: viewer.canvas.width, height: viewer.canvas.height });
      count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (color.every((channel, index) => Math.abs(pixels[offset + index] - channel) < 5))
          count++;
      }
    });
    window.patternLinePixels = () => count;
    viewer.scene.requestRender();
  }, blue);
  await expect.poll(() => page.evaluate(() => window.patternLinePixels())).toBeGreaterThan(100);
  const narrowPixels = await page.evaluate(() => window.patternLinePixels());
  const beforeRequests = requests.filter(url => url.endsWith('.pbf')).length;
  await page.evaluate(() => {
    const { tileset, viewer } = window.renderValidation;
    tileset._renderer.style.setPaintProperty('roads', 'line-width', 8);
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.patternLinePixels())).toBeGreaterThan(narrowPixels * 1.5);
  assert.equal(requests.filter(url => url.endsWith('.pbf')).length, beforeRequests, 'image line paint refetched source tiles');
  await page.evaluate(() => {
    const { tileset, viewer } = window.renderValidation;
    tileset._renderer.style.setPaintProperty('roads', 'line-opacity', 0);
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.patternLinePixels())).toBe(0);
  await page.evaluate(() => {
    const { tileset, viewer } = window.renderValidation;
    tileset._renderer.style.setPaintProperty('roads', 'line-opacity', 1);
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.patternLinePixels())).toBeGreaterThan(100);
  for (const mode of ['2d', 'cv', '3d'] as const) {
    await page.evaluate((mode) => {
      const validation = window.renderValidation;
      if (mode === '2d')
        validation.viewer.scene.morphTo2D(0);
      else if (mode === 'cv')
        validation.viewer.scene.morphToColumbusView(0);
      else validation.viewer.scene.morphTo3D(0);
      validation.setTopView();
    }, mode);
    await expect.poll(() => page.evaluate(() => window.patternLinePixels())).toBeGreaterThan(100);
    await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
  await page.evaluate(() => window.stopPatternLinePixels());
});

for (const track of ['raster']) {
  test(`same source ID with a new URL keeps ${track} pixels until replacement tiles draw`, async ({ page, renderUrl }, testInfo) => {
    const { requests, errors } = await open(page, renderUrl, style(renderUrl, track));
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
    if (track === 'raster') {
      await page.evaluate(() => {
        const { viewer, atlas } = window.renderValidation;
        if (!atlas)
          throw new Error('Raster test requires the Native Cesium fixture');
        const prototype = atlas.cesium.Material.prototype as Material & { update: (context: object) => void };
        const update = prototype.update;
        const firstFrame = new WeakMap<Material, number>();
        // Native can visit a material twice during its first frame. A raster
        // must already have pixels after the first visit, without depending
        // on the duplicate visit to consume Material's queued image upload.
        prototype.update = function (context) {
          if (this.uniforms.u_fade !== undefined) {
            const frame = viewer.scene._frameState.frameNumber;
            if (frame === undefined)
              throw new Error('Raster test requires a Native frame number');
            if (firstFrame.get(this) === frame)
              return;
            if (!firstFrame.has(this))
              firstFrame.set(this, frame);
          }
          update.call(this, context);
        };
        window.restoreRasterMaterialUpdates = () => {
          prototype.update = update;
        };
      });
    }
    try {
      await replace(page, style(renderUrl, track, 'b'), green, testInfo, `${track}-source-replacement`);
    }
    finally {
      if (track === 'raster')
        await page.evaluate(() => window.restoreRasterMaterialUpdates());
    }
    assert.ok(requests.some(url => /\/b\//.test(url)), 'the replacement source URL was not requested');
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
  });
}

test('public 8px icon image updates repaint an idle scene without refetching tiles', async ({ page, renderUrl }, testInfo) => {
  const initial = style(renderUrl, 'solid');
  (initial.layers[0] as FillLayerSpecification).paint = { 'fill-color': '#990000', 'fill-antialias': false };
  initial.layers.push({
    'id': 'icons',
    'type': 'symbol',
    'source': 'fixture',
    'source-layer': 'icons',
    'layout': { 'icon-image': 'blue', 'icon-size': 4, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  });
  const { errors, requests } = await open(page, renderUrl, initial, 8);
  await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThan(0.04);
  await expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const frames = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.renderedFrames === frames && validation.tileset.tilesLoaded;
  }), { timeout: 30_000 }).toBe(true);
  const beforeRequests = requests.filter(url => url.endsWith('.pbf')).length;
  const baseline = await page.evaluate(color => window.renderValidation.readCoverage(color), blue);
  await page.evaluate(({ blue, green }) => {
    const validation = window.renderValidation;
    window.iconUpdateFrames = [];
    window.stopIconUpdateFrames = validation.viewer.scene.postRender.addEventListener(() => {
      const previous = validation.readCoverage(blue);
      const next = validation.readCoverage(green);
      window.iconUpdateFrames.push(previous.map((ratio, index) => ratio + next[index]));
    });
    const data = new Uint8Array(8 * 8 * 4);
    for (let offset = 0; offset < data.length; offset += 4)
      data.set([...green, 255], offset);
    validation.tileset.updateImage('blue', { width: 8, height: 8, data }, { pixelRatio: 1 });
  }, { blue, green });
  let frames;
  try {
    await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), green)).toBeGreaterThan(0.04);
    await expect.poll(() => page.evaluate(color => Math.max(...window.renderValidation.readCoverage(color)), blue)).toBeLessThan(0.005);
    assert.equal(requests.filter(url => url.endsWith('.pbf')).length, beforeRequests, 'an icon pixel update refetched MVT data');
  }
  finally {
    const result = await page.evaluate(({ blue, green }) => {
      window.stopIconUpdateFrames();
      const validation = window.renderValidation;
      const image = validation.tileset._renderer.style.getImage('blue');
      if (!image)
        throw new Error('Updated icon image is missing');
      return { frames: window.iconUpdateFrames, blueCoverage: validation.readCoverage(blue), greenCoverage: validation.readCoverage(green), pixels: validation.readPixelSamples(), stats: validation.tileset.stats(), image: { version: image.version, firstPixel: Array.from(image.data.data.subarray(0, 4)) } };
    }, { blue, green });
    frames = result.frames;
    const output = testInfo.outputPath('icon-image-update.json');
    await writeFile(output, JSON.stringify(result, null, 2));
    await testInfo.attach('icon-image-update', { path: output, contentType: 'application/json' });
  }
  assert.ok(frames.length > 0, 'an idle icon image update caused no rendered frames');
  assert.ok(frames.every(rows => rows.every((ratio, index) => ratio >= baseline[index] * 0.95)), `icon pixels disappeared during image upload: ${JSON.stringify(frames)}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});
