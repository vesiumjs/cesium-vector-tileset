import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { Buffer } from 'node:buffer';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

test('globe hides symbols on the far side while keeping front symbols visible', async ({ page, renderUrl }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sprite = createCanvas(32, 16);
  const context = sprite.getContext('2d');
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, 16, 16);
  context.fillStyle = '#ff0000';
  context.fillRect(16, 0, 16, 16);
  const tile = Buffer.from(fromGeojsonVt({ points: { features: [
    // About 50°E and 85°E: one tile straddles the camera's ~76° horizon.
    { type: 1, geometry: [[2617, 2048]], tags: { icon: 'front' } },
    { type: 1, geometry: [[3015, 2048]], tags: { icon: 'back' } },
  ] } }, { version: 2, extent: 4096 }));
  const style = {
    version: 8,
    sprite: `${renderUrl}/symbol-occlusion/sprite`,
    sources: { world: { type: 'vector', tiles: [`${renderUrl}/symbol-occlusion/{z}/{x}/{y}.pbf`], maxzoom: 0 } },
    layers: [{ 'id': 'points', 'type': 'symbol', 'source': 'world', 'source-layer': 'points', 'layout': {
      'icon-image': ['get', 'icon'],
      'icon-allow-overlap': true,
    } }],
  } satisfies StyleSpecification;
  await page.route('**/symbol-occlusion/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('.pbf'))
      return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
    if (url.endsWith('.png'))
      return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
    if (url.includes('sprite')) {
      return route.fulfill({ json: {
        front: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 },
        back: { x: 16, y: 0, width: 16, height: 16, pixelRatio: 1 },
      } });
    }
    return route.fulfill({ json: style });
  });
  const query = new URLSearchParams({ mode: '3d', center: '0,0', scale: '2000', atlas: '1', antialias: '0', style: `${renderUrl}/symbol-occlusion/style.json` });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => !!window.renderValidation)).toBe(true);
  await page.evaluate(() => {
    const { viewer, atlas } = window.renderValidation;
    viewer.camera.setView({ destination: atlas.cesium.Cartesian3.fromDegrees(0, 0, 20_000_000) });
    viewer.scene.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded
    && window.renderValidation.tileset.stats().renderableTiles > 0)).toBe(true);
  const sample = () => page.evaluate(async () => {
    const { viewer, renderErrors } = window.renderValidation;
    return new Promise<{ front: number; back: number; renderErrors: string[] }>((resolve) => {
      const remove = viewer.scene.postRender.addEventListener(() => {
        remove();
        const pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
        let front = 0;
        let back = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const [r, g, b] = pixels.subarray(index, index + 3);
          if (g > 180 && r < 30 && b < 30)
            front++;
          if (r > 180 && g < 30 && b < 30)
            back++;
        }
        resolve({ front, back, renderErrors });
      });
      viewer.scene.requestRender();
    });
  });
  await expect.poll(async () => (await sample()).front).toBeGreaterThan(100);
  const result = await sample();
  expect(result.back, `far-side symbol pixels: ${JSON.stringify(result)}`).toBe(0);
  await expect.poll(() => page.evaluate(() => [...window.renderValidation.tileset._renderer.symbol._tiles.values()]
    .flatMap(entry => entry.batches.flatMap(batch => Array.from(batch.icon!.opacities))))).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);

  // Bring the red symbol onto the front, then rotate it behind the horizon.
  // The first rendered frame must hide it even with the old placement alive.
  await page.evaluate(() => {
    const { viewer, atlas } = window.renderValidation;
    viewer.camera.setView({ destination: atlas.cesium.Cartesian3.fromDegrees(85, 0, 20_000_000) });
    viewer.scene.requestRender();
  });
  await expect.poll(async () => (await sample()).back).toBeGreaterThan(100);
  await page.evaluate(() => {
    const { viewer, atlas } = window.renderValidation;
    viewer.camera.setView({ destination: atlas.cesium.Cartesian3.fromDegrees(0, 0, 20_000_000) });
  });
  expect((await sample()).back).toBe(0);

  // Planar projections have no ellipsoid horizon: both symbols must return.
  for (const mode of ['2d', 'cv']) {
    await page.evaluate((mode) => {
      const { viewer, atlas } = window.renderValidation;
      if (mode === '2d')
        viewer.scene.morphTo2D(0);
      else
        viewer.scene.morphToColumbusView(0);
      viewer.camera.setView({ destination: atlas.cesium.Rectangle.fromDegrees(20, -25, 115, 25) });
      viewer.scene.requestRender();
    }, mode);
    await expect.poll(async () => {
      const result = await sample();
      return Math.min(result.front, result.back);
    }).toBeGreaterThan(100);
  }
  expect(result.renderErrors).toEqual([]);
  expect(errors).toEqual([]);
});
