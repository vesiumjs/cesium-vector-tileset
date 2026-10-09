import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    patternMotion: { evicted: number; pixel: number[]; stop: () => void };
  }
}

test('pattern commands and pixels return after continuous pan, zoom visibility changes and orbit', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const tile = Buffer.from(fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]] }] } }, { version: 2, extent: 4096 }));
  const sprite = createCanvas(8, 8);
  sprite.getContext('2d').fillStyle = '#ff00ff';
  sprite.getContext('2d').fillRect(0, 0, 8, 8);
  const style: StyleSpecification = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sprite: `${renderUrl}/pattern-motion/sprite`,
    sources: { world: { type: 'vector', tiles: [`${renderUrl}/pattern-motion/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'world', 'source-layer': 'land', 'paint': { 'fill-color': '#123456', 'fill-antialias': false } },
      { 'id': 'hatch', 'type': 'fill', 'source': 'world', 'source-layer': 'land', 'minzoom': 13, 'paint': { 'fill-pattern': 'hatch', 'fill-antialias': false } },
    ],
  };
  await page.route('**/pattern-motion/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('.pbf'))
      return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
    if (url.endsWith('sprite.png'))
      return route.fulfill({ body: sprite.toBuffer('image/png'), contentType: 'image/png' });
    if (url.endsWith('sprite.json'))
      return route.fulfill({ json: { hatch: { x: 0, y: 0, width: 8, height: 8, pixelRatio: 1 } } });
    return route.fulfill({ json: style });
  });
  const query = new URLSearchParams({ style: `${renderUrl}/pattern-motion/style.json`, atlas: '1', readback: '0', cityPerf: '1' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => {
    const validation = window.renderValidation;
    return validation?.tileset.tilesLoaded && validation.tileset.stats().pattern.tiles > 0 && validation.cityCommands().some(command => command.kind === 'pattern');
  }), { timeout: 60_000 }).toBe(true);

  const initial = await page.evaluate(() => {
    const { viewer, tileset } = window.renderValidation;
    const renderer = tileset._patternRenderer;
    const clear = renderer.clearRetired.bind(renderer);
    const observation = window.patternMotion = { evicted: 0, pixel: [] as number[], stop: () => {} };
    renderer.clearRetired = () => {
      observation.evicted += renderer.stats.retiredTiles;
      return clear();
    };
    const remove = viewer.scene.postRender.addEventListener(() => {
      observation.pixel = [...viewer.scene.context.readPixels({ x: Math.floor(viewer.canvas.width / 2), y: Math.floor(viewer.canvas.height / 2), width: 1, height: 1 })];
    });
    observation.stop = () => {
      remove();
      renderer.clearRetired = clear;
    };
    viewer.camera.zoomIn(viewer.camera.positionCartographic.height * 0.001);
    return { height: viewer.camera.positionCartographic.height, zoom: window.renderValidation.zoom, pattern: tileset.stats().pattern };
  });
  const visiblePattern = () => page.evaluate(() => {
    const { tileset, cityCommands } = window.renderValidation;
    const [red, green, blue] = window.patternMotion.pixel;
    return tileset.tilesLoaded && tileset.stats().pendingPublishes === 0 && tileset.stats().pattern.tiles > 0
      && cityCommands().some(command => command.kind === 'pattern') && red > 200 && green < 40 && blue > 200;
  });
  try {
    expect(initial.zoom).toBeGreaterThanOrEqual(13);
    await expect.poll(visiblePattern).toBe(true);
    await page.evaluate(async (height) => {
      const { viewer, atlas } = window.renderValidation;
      const { Cartesian3 } = atlas!.cesium;
      for (let step = 1; step <= 24; step++) {
        viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276 + step / 24 * 0.15, 51.5072, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    }, initial.height);
    await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.stats().pattern.retiredTiles)).toBeGreaterThan(0);
    await page.evaluate(async (height) => {
      const { viewer, atlas } = window.renderValidation;
      const { Cartesian3 } = atlas!.cesium;
      for (let step = 1; step <= 36; step++) {
        viewer.camera.setView({ destination: Cartesian3.fromDegrees(0.0224, 51.5072, height * 2 ** (step / 36 * 4)), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    }, initial.height);
    await expect.poll(() => page.evaluate(() => window.patternMotion.evicted)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.renderValidation.zoom)).toBeLessThan(13);
    await page.evaluate(async (height) => {
      const { viewer, atlas } = window.renderValidation;
      const { Cartesian3, HeadingPitchRange, Matrix4 } = atlas!.cesium;
      for (let step = 0; step < 36; step++) {
        viewer.camera.lookAt(Cartesian3.fromDegrees(-0.1276, 51.5072), new HeadingPitchRange(step * Math.PI / 18, -Math.PI / 2 + Math.sin(step * Math.PI / 36) * Math.PI / 3, height));
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    }, initial.height);
    await expect.poll(visiblePattern, { timeout: 60_000 }).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.renderValidation.renderErrors)).toEqual([]);
  }
  finally {
    const result = await page.evaluate(() => {
      const { tileset, cityCommands } = window.renderValidation;
      window.patternMotion.stop();
      return { evicted: window.patternMotion.evicted, pixel: window.patternMotion.pixel, stats: tileset.stats(), commands: cityCommands() };
    });
    await writeFile(testInfo.outputPath('pattern-motion.json'), JSON.stringify({ initial, result, errors }, null, 2));
  }
});
