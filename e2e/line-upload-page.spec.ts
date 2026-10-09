import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativePrimitive } from './fixtures/browser-types';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

declare global {
  interface Window {
    linePage: {
      frames: Array<{ loaded: boolean; commands: number; owners: number; tiles: number; arrays: number; vertices: number }>;
      owners: NativePrimitive[];
      pixels?: Uint8Array;
      remove: () => void;
    };
  }
}

for (const mode of ['3d', 'cv', '2d']) {
  test(`${mode} dense dash upload quanta settle into one real VA per tile and layer`, async ({ page, renderUrl }, testInfo) => {
    const extent = 4096;
    const tileX = 8186;
    const tileY = 5448;
    const level = 14;
    const longitude = (x: number) => x / 2 ** level * 360 - 180;
    const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** level))) * 180 / Math.PI;
    const features = Array.from({ length: 256 }, (_, index) => ({
      id: index + 1,
      type: 2,
      tags: { ordinal: index },
      geometry: [Array.from({ length: 33 }, (_, step) => [step * 128, 8 + index * 16 + (step % 2 ? 3 : -3)])],
    }));
    const tile = Buffer.from(fromGeojsonVt({ roads: { features } }, { version: 2, extent }));
    const style: StyleSpecification = {
      version: 8,
      transition: { duration: 0, delay: 0 },
      sources: { city: {
        type: 'vector',
        tiles: [`${renderUrl}/line-page/{z}/{x}/{y}.pbf`],
        minzoom: level,
        maxzoom: level,
        bounds: [longitude(tileX), latitude(tileY + 1), longitude(tileX + 1), latitude(tileY)],
      } },
      layers: [{
        'id': 'roads',
        'type': 'line',
        'source': 'city',
        'source-layer': 'roads',
        'layout': { 'line-join': 'miter', 'line-cap': 'butt' },
        'paint': { 'line-width': 4, 'line-color': '#ffffff', 'line-dasharray': [3, 1] },
      }],
    };
    await page.route('**/line-page/**', route => route.request().url().endsWith('.pbf')
      ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
      : route.fulfill({ json: style }));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const query = new URLSearchParams({
      mode,
      style: `${renderUrl}/line-page/style.json`,
      center: `${longitude(tileX + 0.5)},${latitude(tileY + 0.5)}`,
      scale: '0.6',
      antialias: '0',
      readback: '0',
      cityPerf: '1',
    });
    if (mode === '2d')
      query.delete('cityPerf');
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => Boolean(window.renderValidation))).toBe(true);
    await page.evaluate(() => {
      const { tileset, viewer, drawBatch } = window.renderValidation;
      window.linePage = { frames: [], owners: [], remove: () => {} };
      window.linePage.remove = viewer.scene.postRender.addEventListener(() => {
        if (tileset.isDestroyed())
          return;
        const owners = tileset._renderer.vector.tileIds.flatMap(tileId => tileset._renderer.vector.getTileCollections(tileId)
          .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index) as NativePrimitive))
          .filter(owner => drawBatch(owner)?.layerId === 'roads'));
        window.linePage.owners = owners;
        const arrays = owners.flatMap(owner => owner._va ?? []);
        const commands = viewer.scene._frameState.commandList.filter(command => (drawBatch(command) ?? drawBatch(command.owner))?.layerId === 'roads').length;
        window.linePage.frames.push({
          loaded: tileset.tilesLoaded,
          owners: owners.length,
          tiles: new Set(owners.map(owner => drawBatch(owner)?.tileId)).size,
          arrays: arrays.length,
          vertices: arrays.reduce((count, array) => count + array.numberOfVertices, 0),
          commands,
        });
        if (commands > 0)
          window.linePage.pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
      });
    });
    await expect.poll(() => page.evaluate(() => window.linePage.frames.at(-1)), { timeout: 90_000 })
      .toMatchObject({ loaded: true });
    // Before the first source selection an empty scene may already be loaded.
    // Qualify actual uploaded data rather than accepting that startup frame.
    await expect.poll(() => page.evaluate(() => {
      const frame = window.linePage.frames.at(-1);
      return Boolean(frame?.loaded && frame.vertices > 30_000);
    }), { timeout: 90_000 }).toBe(true);
    const result = await page.evaluate(() => {
      const { viewer, renderErrors } = window.renderValidation;
      const pixels = window.linePage.pixels;
      const picks: TilePickObject[] = [];
      const width = viewer.canvas.width;
      const height = viewer.canvas.height;
      let white = 0;
      if (pixels) {
        for (let row = 2; row < height - 2; row++) {
          for (let column = 2; column < width - 2; column++) {
            const offset = (row * width + column) * 4;
            if (pixels[offset] < 240 || pixels[offset + 1] < 240 || pixels[offset + 2] < 240)
              continue;
            white++;
            if (picks.length < 3 && white % 100 === 0) {
              const picked = viewer.scene.pick({ x: column * viewer.canvas.clientWidth / width, y: (height - row - 1) * viewer.canvas.clientHeight / height }, 1, 1)?.id as TilePickObject | undefined;
              if (picked && !picks.some(value => value.featureIndex === picked.featureIndex))
                picks.push(picked);
            }
          }
        }
      }
      return { frames: window.linePage.frames, final: window.linePage.frames.at(-1), white, picks, renderErrors };
    });
    await writeFile(testInfo.outputPath('line-page.json'), JSON.stringify(result, null, 2));
    expect(errors).toEqual([]);
    expect(result.renderErrors).toEqual([]);
    expect(result.final?.vertices).toBeGreaterThan(30_000);
    expect(result.white).toBeGreaterThan(100);
    expect(result.picks.length).toBeGreaterThanOrEqual(2);
    expect(result.picks.every(pick => pick.layerId === 'roads' && pick.featureIndex >= 0 && pick.featureIndex < 256)).toBe(true);
    expect(result.frames.some(frame => !frame.loaded && frame.commands > 0), 'completed features must draw while the rest continues uploading').toBe(true);
    expect(result.final?.owners, 'upload work units must not become permanent draw owners').toBe(result.final?.tiles);
    expect(result.final?.arrays, 'one page must own one actual uploaded Native VA per tile').toBe(result.final?.tiles);
    expect(result.final?.commands).toBe(result.final?.tiles);
    const motion = await page.evaluate(async () => {
      const { viewer, tileset } = window.renderValidation;
      const original = window.linePage.owners;
      const arrays = new Map(original.map(owner => [owner, [...owner._va]]));
      const textures = new Map(original.map(owner => [owner, owner.positionTexture]));
      const snapshots: Array<{ common: number; stable: boolean; commands: number }> = [];
      for (let step = 0; step < 12; step++) {
        const height = viewer.camera.positionCartographic.height;
        if (step < 6)
          viewer.camera.zoomIn(height * 0.015);
        else
          viewer.camera.zoomOut(height * 0.015);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const common = window.linePage.owners.filter(owner => original.includes(owner));
        snapshots.push({
          common: common.length,
          stable: common.every(owner => owner._va.length === arrays.get(owner)!.length
            && owner._va.every((array, index) => array === arrays.get(owner)![index])
            && owner.positionTexture === textures.get(owner)),
          commands: window.linePage.frames.at(-1)?.commands ?? 0,
        });
      }
      window.linePage.remove();
      const resources = [...new Set([...original, ...window.linePage.owners])];
      const gpu = resources.flatMap(owner => owner._va);
      const positions = resources.map(owner => owner.positionTexture).filter(value => value !== undefined);
      viewer.scene.primitives.remove(tileset);
      return {
        snapshots,
        destroyed: resources.every(owner => owner.isDestroyed()),
        arraysDestroyed: gpu.every(array => array.isDestroyed()),
        positionsDestroyed: positions.every(texture => texture.isDestroyed()),
      };
    });
    await writeFile(testInfo.outputPath('line-page-motion.json'), JSON.stringify(motion, null, 2));
    expect(motion.snapshots.every(value => value.common > 0 && value.stable && value.commands > 0)).toBe(true);
    expect(motion).toMatchObject({ destroyed: true, arraysDestroyed: true, positionsDestroyed: true });
    expect(errors).toEqual([]);
  });
}
