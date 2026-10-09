import type { LineLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Material, PrimitiveCollection } from 'cesium';
import type { Page, TestInfo } from 'playwright/test';
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
  }
}

const blue = [51, 102, 170];
const green = [34, 170, 85];
const tiles = Object.fromEntries(['a', 'b'].map(source => [source, fromGeojsonVt({
  land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: { pattern: source === 'a' ? 'blue' : 'green' } }] },
  icons: { features: Array.from({ length: 256 }, (_, index) => ({ type: 1, geometry: [[(index % 16 + 0.5) * 256, (Math.floor(index / 16) + 0.5) * 256]], tags: {} })) },
  roads: { features: Array.from({ length: 32 }, (_, index) => ({ type: 2, geometry: [[[0, (index + 0.5) * 128], [4096, (index + 0.5) * 128]]], tags: {} })) },
}, { version: 2, extent: 4096 })]));

function image(color, width = 8, height = 8) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas;
}

function style(baseUrl: string, track: string, source = 'a'): StyleSpecification {
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

async function open(page: Page, baseUrl: string, initial: StyleSpecification, spriteSize = 8) {
  const requests = [];
  const errors = [];
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

async function replace(page: Page, next: StyleSpecification, expected: number[], testInfo: TestInfo, name: string) {
  await page.evaluate(({ nextJson, blue, green }) => {
    const next: StyleSpecification = JSON.parse(nextJson);
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
            const texture = entry.material._textures.image;
            return { id, show: entry.primitive.show, ready: entry.primitive.ready, parentShow: entry.collection.show, fade: entry.material.uniforms.u_fade, opacity: entry.material.uniforms.opacity, texture: texture && { width: texture.width, height: texture.height, destroyed: texture.isDestroyed() }, source: { width: entry.image.width, height: entry.image.height } };
          })),
          jobs: [...tileset._renderer.publishQueue._jobs.values()].map(job => ({ tileId: job.tileId, surfaces: job.surfaces, symbols: job.symbols })),
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

for (const track of ['pattern', 'raster']) {
  test(`same source ID with a new URL keeps ${track} pixels until replacement tiles draw`, async ({ page, renderUrl }, testInfo) => {
    const { requests, errors } = await open(page, renderUrl, style(renderUrl, track));
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
    if (track === 'raster') {
      await page.evaluate(() => {
        const { viewer, atlas } = window.renderValidation;
        const prototype = atlas.cesium.Material.prototype as Material & { update: (context: object) => void };
        const update = prototype.update;
        const firstFrame = new WeakMap<Material, number>();
        // Native can visit a material twice during its first frame. A raster
        // must already have pixels after the first visit, without depending
        // on the duplicate visit to consume Material's queued image upload.
        prototype.update = function (context) {
          if (this.uniforms.u_fade !== undefined) {
            const frame = viewer.scene._frameState.frameNumber;
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

test('public solid and dashed line paint switches produce their respective pixels', async ({ page, renderUrl }) => {
  const initial = style(renderUrl, 'solid');
  const road: LineLayerSpecification = { 'id': 'roads', 'type': 'line', 'source': 'fixture', 'source-layer': 'roads', 'paint': { 'line-color': '#ffffff', 'line-width': 8 } };
  initial.layers.push(road);
  const { errors } = await open(page, renderUrl, initial);
  await expect.poll(() => page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 255, 255])))).toBeGreaterThan(0.03);
  const whiteCoverage = await page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 255, 255])));
  assert.ok(whiteCoverage > 0.03, `solid road pixels were absent: ${whiteCoverage}`);
  const dashed = structuredClone(initial);
  (dashed.layers[1] as LineLayerSpecification).paint['line-color'] = '#ff0000';
  (dashed.layers[1] as LineLayerSpecification).paint['line-dasharray'] = [3, 1];
  await page.evaluate((json) => {
    const style: StyleSpecification = JSON.parse(json);
    window.renderValidation.tileset.setStyle(style);
  }, JSON.stringify(dashed));
  await expect.poll(() => page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 0, 0])))).toBeGreaterThan(0.02);
  await expect.poll(() => page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 255, 255])))).toBeLessThan(0.01);
  const redCoverage = await page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 0, 0])));
  assert.ok(redCoverage < whiteCoverage * 0.9, `dash gaps were absent: dashed ${redCoverage} / solid ${whiteCoverage}`);
  await page.evaluate((json) => {
    const style: StyleSpecification = JSON.parse(json);
    window.renderValidation.tileset.setStyle(style);
  }, JSON.stringify(initial));
  await expect.poll(() => page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 255, 255])))).toBeGreaterThan(0.03);
  await expect.poll(() => page.evaluate(() => Math.max(...window.renderValidation.readCoverage([255, 0, 0])))).toBeLessThan(0.01);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});

test('an opaque 8px pattern stays uniform through image updates, replacement and camera zoom', async ({ page, renderUrl }, testInfo) => {
  const { errors, requests } = await open(page, renderUrl, style(renderUrl, 'pattern'), 8);
  await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  await expect.poll(() => page.evaluate(async () => {
    const validation = window.renderValidation;
    const frames = validation.renderedFrames;
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    return validation.renderedFrames === frames && validation.viewer.scene.globe.tilesLoaded && validation.tileset.tilesLoaded;
  }), { timeout: 30_000 }).toBe(true);
  const beforeUpdate = requests.filter(url => url.endsWith('.pbf')).length;
  await page.evaluate(({ blue, green }) => {
    const validation = window.renderValidation;
    window.imageUpdateFrames = [];
    window.stopImageUpdateFrames = validation.viewer.scene.postRender.addEventListener(() => {
      const before = validation.readCoverage(blue);
      const after = validation.readCoverage(green);
      window.imageUpdateFrames.push(before.map((ratio, index) => ratio + after[index]));
    });
    const data = new Uint8Array(8 * 8 * 4);
    for (let offset = 0; offset < data.length; offset += 4)
      data.set([...green, 255], offset);
    validation.tileset.updateImage('blue', { width: 8, height: 8, data }, { pixelRatio: 1 });
  }, { blue, green });
  let frames;
  try {
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), green)).toBeGreaterThanOrEqual(0.98);
    assert.equal(requests.filter(url => url.endsWith('.pbf')).length, beforeUpdate, 'a same-size image update refetched MVT data');
    for (const direction of ['in', 'out']) {
      const before = await page.evaluate((direction) => {
        const validation = window.renderValidation;
        const { viewer } = validation;
        const distance = viewer.camera.positionCartographic.height * 0.08;
        if (direction === 'in')
          viewer.camera.zoomIn(distance);
        else viewer.camera.zoomOut(distance);
        viewer.scene.requestRender();
        return validation.renderedFrames;
      }, direction);
      await expect.poll(() => page.evaluate(({ color, before }) => {
        const validation = window.renderValidation;
        return validation.renderedFrames > before ? Math.min(...validation.readCoverage(color)) : 0;
      }, { color: green, before })).toBeGreaterThanOrEqual(0.98);
    }
    await page.evaluate((blue) => {
      const { tileset } = window.renderValidation;
      const data = new Uint8Array(8 * 8 * 4);
      for (let offset = 0; offset < data.length; offset += 4)
        data.set([...blue, 255], offset);
      // Replace an image between frames using its original ID. Old atlas
      // content must not win merely because the name and dimensions match.
      tileset.removeImage('blue');
      tileset.addImage('blue', { width: 8, height: 8, data }, { pixelRatio: 1 });
    }, blue);
    await expect.poll(() => page.evaluate(color => Math.min(...window.renderValidation.readCoverage(color)), blue)).toBeGreaterThanOrEqual(0.98);
  }
  finally {
    const result = await page.evaluate(() => {
      window.stopImageUpdateFrames();
      const validation = window.renderValidation;
      const image = validation.tileset._renderer.style.getImage('blue');
      return { frames: window.imageUpdateFrames, pixels: validation.readPixelSamples(), stats: validation.tileset.stats(), image: { version: image.version, firstPixel: Array.from(image.data.data.subarray(0, 4)) } };
    });
    frames = result.frames;
    const output = testInfo.outputPath('small-pattern-image-update.json');
    await writeFile(output, JSON.stringify(result, null, 2));
    await testInfo.attach('small-pattern-image-update', { path: output, contentType: 'application/json' });
  }
  assert.ok(frames.length > 0, 'public image updates caused no rendered frames');
  assert.ok(frames.every(rows => rows.every(ratio => ratio >= 0.98)), `opaque pattern acquired seams or gaps: ${JSON.stringify(frames)}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.renderValidation.renderErrors), []);
});

test('public 8px icon image updates repaint an idle scene without refetching tiles', async ({ page, renderUrl }, testInfo) => {
  const initial = style(renderUrl, 'solid');
  initial.layers[0].paint['fill-color'] = '#990000';
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
