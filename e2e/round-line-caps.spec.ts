import type { LineLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import type { NativePrimitive, NativeTexture, NativeVertexArray } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface RoundCapProbe {
  coordinates: string;
  endpoint: { x: number; y: number };
  radius: number;
  pixels: Record<'inside' | 'corner' | 'body' | 'seam', number[]>;
  picks: { inside?: string; corner?: string };
  buffersStable: boolean;
}

declare global {
  interface Window {
    roundCapPrimitives: () => NativePrimitive[];
    roundCapOwners: Map<NativePrimitive, { arrays: NativeVertexArray[]; texture?: NativeTexture }>;
    roundCapResourcesStable: () => boolean;
    stopRoundCapPixels: () => void;
    roundCapSnapshot: Uint8Array;
    roundCapPaintedPixels: () => number;
    roundCapProbe: (tiles: string[], width: number) => RoundCapProbe | undefined;
  }
}

const tile = Buffer.from(fromGeojsonVt({
  ground: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  roads: { features: [{ type: 2, geometry: [[[1024, 2048], [3072, 2048]]], tags: {} }] },
}, { version: 2, extent: 4096 }));

for (const { mode, dpr } of [{ mode: '3d', dpr: 1 }, { mode: '2d', dpr: 1 }, { mode: 'cv', dpr: 1 }, { mode: 'cv', dpr: 2 }]) {
  test.describe(() => {
    test.use({ deviceScaleFactor: dpr });
    for (const kind of ['solid', 'dash']) {
      test(`round ${kind} caps preserve shape, opacity and buffers in ${mode} DPR${dpr}`, async ({ page, renderUrl }, testInfo) => {
        const errors: string[] = [];
        const requestedTiles = new Set<string>();
        let requests = 0;
        page.on('pageerror', error => errors.push(error.message));
        const style = {
          version: 8,
          transition: { duration: 0, delay: 0 },
          sources: { city: { type: 'vector', tiles: [`${renderUrl}/round-caps/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
          layers: [
            { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } },
            {
              'id': 'roads',
              'type': 'line',
              'source': 'city',
              'source-layer': 'roads',
              'layout': { 'line-join': 'miter', 'line-cap': 'round' },
              'paint': { 'line-color': '#ff0000', 'line-width': 32, 'line-opacity': 0.5, ...(kind === 'dash' ? { 'line-dasharray': [100000, 1] } : {}) },
            },
          ],
        } satisfies StyleSpecification;
        await page.route('**/round-caps/**', (route) => {
          const match = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
          if (match) {
            requestedTiles.add(match.slice(1).join('/'));
            requests++;
            return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
          }
          return route.fulfill({ json: style });
        });
        const query = new URLSearchParams({ mode, style: `${renderUrl}/round-caps/style.json`, synthetic: '4096' });
        await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
        await expect.poll(() => page.evaluate(() => {
          const validation = window.renderValidation;
          return validation?.tileset.tilesLoaded && validation.tileset.stats().renderableTiles > 0 && validation.viewer.scene.globe.tilesLoaded;
        }), { timeout: 60_000 }).toBe(true);
        await page.evaluate(() => {
          const { viewer, tileset } = window.renderValidation;
          viewer.scene.debugShowFramesPerSecond = true;
          window.roundCapPrimitives = () => [...new Set([
            ...tileset._vectorRenderer.tileIds.flatMap(id => tileset._vectorRenderer.getTileCollections(id)
              .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index) as NativePrimitive & { primitive?: NativePrimitive }))
              .map(entry => entry.primitive ?? entry)),
            ...[...tileset._patternRenderer._tiles.values()].flatMap(entries => entries.map(entry => entry.primitive)),
          ])].filter((primitive): primitive is NativePrimitive => (primitive as NativePrimitive)._attributeLocations?.a_lineFlags !== undefined && !!(primitive as NativePrimitive)._va?.length);
          window.roundCapOwners = new Map(window.roundCapPrimitives().map(primitive => [primitive, { arrays: [...primitive._va], texture: primitive.positionTexture }]));
          window.roundCapResourcesStable = () => {
            const current = window.roundCapPrimitives();
            return current.length === window.roundCapOwners.size && current.every((primitive) => {
              const original = window.roundCapOwners.get(primitive);
              return original && !primitive.isDestroyed() && primitive.positionTexture === original.texture
                && original.texture && !original.texture.isDestroyed()
                && primitive._va.length === original.arrays.length
                && primitive._va.every((array, index) => array === original.arrays[index]);
            });
          };
          window.stopRoundCapPixels = viewer.scene.postRender.addEventListener(() => {
            window.roundCapSnapshot = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
          });
          window.roundCapPaintedPixels = () => {
            const pixels = window.roundCapSnapshot;
            let count = 0;
            if (!pixels)
              return count;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if (pixels[offset] > 100 && pixels[offset + 1] < 60 && pixels[offset + 2] < 60)
                count++;
            }
            return count;
          };
          window.roundCapProbe = (tiles, width) => {
            const { canvas, scene } = viewer;
            if (!window.roundCapSnapshot)
              return undefined;
            const project = (z: number, x: number, y: number, tileX: number) => {
              const longitude = (x + tileX / 4096) / 2 ** z * 360 - 180;
              const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** z))) * 180 / Math.PI;
              return window.renderValidation.projectPosition(longitude, latitude);
            };
            const sample = (position: { x: number; y: number }) => {
              const x = Math.floor(position.x * canvas.width / canvas.clientWidth);
              const y = canvas.height - 1 - Math.floor(position.y * canvas.height / canvas.clientHeight);
              return Array.from(window.roundCapSnapshot.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
            };
            const margin = width + 8;
            for (const coordinates of tiles) {
              const [z, x, y] = coordinates.split('/').map(Number);
              const start = project(z, x, y, 1024);
              const end = project(z, x, y, 3072);
              if (!start || !end)
                continue;
              const length = Math.hypot(end.x - start.x, end.y - start.y);
              if (length < width * 3)
                continue;
              for (const [endpoint, other] of [[start, end], [end, start]]) {
                if (endpoint.x < margin || endpoint.x > canvas.clientWidth - margin || endpoint.y < margin || endpoint.y > canvas.clientHeight - margin)
                  continue;
                const dx = (endpoint.x - other.x) / length;
                const dy = (endpoint.y - other.y) / length;
                const radius = (width + 0.5) / 2;
                const offset = (along: number, across: number) => ({ x: endpoint.x + radius * (dx * along - dy * across), y: endpoint.y + radius * (dy * along + dx * across) });
                const inside = offset(0.55, 0.2);
                const corner = offset(0.9, 0.9);
                const body = offset(-0.4, 0.2);
                const seam = offset(0, 0.2);
                if (sample(inside)[0] < 100)
                  continue;
                const pickLayer = (position: { x: number; y: number }) => {
                  const picked = scene.pick(position);
                  return (picked?.id ?? picked)?.layerId;
                };
                return {
                  coordinates,
                  endpoint,
                  radius,
                  pixels: { inside: sample(inside), corner: sample(corner), body: sample(body), seam: sample(seam) },
                  picks: { inside: pickLayer(inside), corner: pickLayer(corner) },
                  buffersStable: window.roundCapResourcesStable(),
                };
              }
            }
          };
          viewer.scene.requestRender();
        });
        const measurements: Array<RoundCapProbe & { width: number }> = [];
        const initialRequests = requests;
        for (const width of [32, 64]) {
          if (width !== 32) {
            const next = structuredClone(style);
            (next.layers[1] as LineLayerSpecification).paint!['line-width'] = width;
            await page.evaluate(next => window.renderValidation.tileset.setStyle(next), next);
            await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
          }
          await expect.poll(() => page.evaluate(({ tiles, width }) => window.roundCapProbe(tiles, width), { tiles: [...requestedTiles], width })).toBeTruthy();
          const probe = await page.evaluate(({ tiles, width }) => window.roundCapProbe(tiles, width), { tiles: [...requestedTiles], width });
          await writeFile(testInfo.outputPath(`round-cap-probe-${width}.json`), JSON.stringify(probe, null, 2));
          const near = (actual: number[], expected: number[]) => actual.length === 3 && actual.every((channel, index) => Math.abs(channel - expected[index]) <= 3);
          for (const name of ['inside', 'body', 'seam'] as const)
            assert.ok(near(probe.pixels[name], [145, 34, 43]), `${mode}/${kind}/${width}: ${name} must have one half-opacity blend: ${probe.pixels[name]}`);
          assert.ok(near(probe.pixels.corner, [34, 68, 85]), `${mode}/${kind}/${width}: quad corner escaped circle clipping: ${probe.pixels.corner}`);
          assert.equal(probe.picks.inside, 'roads', 'round cap lost Native picking');
          assert.equal(probe.picks.corner, 'ground', 'transparent quad corner intercepted the ground pick');
          assert.ok(probe.buffersStable, 'width paint replaced round-cap buffers or position textures');
          measurements.push({ width, ...probe });
        }
        assert.equal(requests, initialRequests, 'width paint refetched MVT');
        const visible = structuredClone(style);
        (visible.layers[1] as LineLayerSpecification).paint!['line-width'] = 64;
        for (const property of ['line-width', 'line-opacity'] as const) {
          const invisible = structuredClone(visible);
          (invisible.layers[1] as LineLayerSpecification).paint![property] = 0;
          await page.evaluate(invisible => window.renderValidation.tileset.setStyle(invisible), invisible);
          await expect.poll(() => page.evaluate(() => window.roundCapPaintedPixels())).toBe(0);
          assert.ok(await page.evaluate(() => window.roundCapResourcesStable()), `${property} zero replaced round-cap buffers or position textures`);
          await page.evaluate(visible => window.renderValidation.tileset.setStyle(visible), visible);
          await expect.poll(() => page.evaluate(tiles => window.roundCapProbe(tiles, 64), [...requestedTiles])).toBeTruthy();
          const restored = await page.evaluate(tiles => window.roundCapProbe(tiles, 64), [...requestedTiles]);
          assert.ok(restored.buffersStable, `${property} restoration replaced round-cap buffers or position textures`);
          for (const name of ['inside', 'body', 'seam'] as const)
            assert.ok(restored.pixels[name].every((channel, index) => Math.abs(channel - [145, 34, 43][index]) <= 3), `${property} restoration lost half-opacity ${name}: ${restored.pixels[name]}`);
          assert.equal(restored.picks.inside, 'roads', `${property} restoration lost Native picking`);
        }
        assert.equal(requests, initialRequests, 'zero paint restoration refetched MVT');
        const state = await page.evaluate(() => {
          const owners = window.roundCapPrimitives();
          const textures = [...new Set(owners.map(primitive => primitive.positionTexture))];
          return {
            fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
            renderErrors: window.renderValidation.renderErrors,
            owners: owners.length,
            textures: textures.map(texture => texture && ({ width: texture.width, height: texture.height, bytes: texture.sizeInBytes, destroyed: texture.isDestroyed() })),
            textureCapacityBytes: textures.reduce((bytes, texture) => bytes + (texture?.sizeInBytes ?? 0), 0),
            uploads: owners.flatMap((primitive) => {
              const names = new Map(Object.entries(primitive._attributeLocations).map(([name, location]) => [location, name]));
              return primitive._va.map(array => ({
                vertices: array.numberOfVertices,
                vertexBytes: [...new Set(Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index).vertexBuffer))].reduce((bytes, buffer) => bytes + buffer.sizeInBytes, 0),
                layout: Object.fromEntries(Array.from({ length: array.numberOfAttributes }, (_, index) => {
                  const attribute = array.getAttribute(index);
                  return [names.get(attribute.index), { componentDatatype: attribute.componentDatatype, components: attribute.componentsPerAttribute, normalize: attribute.normalize }];
                })),
              }));
            }),
          };
        });
        assert.ok(state.fps);
        assert.deepEqual(state.renderErrors, []);
        assert.deepEqual(errors, []);
        assert.ok(state.uploads.length > 0);
        assert.equal(state.textures.length, state.owners, 'physical round-cap owners must own distinct position textures');
        assert.ok(state.textureCapacityBytes > 0 && state.textures.every(texture => texture && texture.width > 0 && texture.height > 0 && texture.bytes > 0 && !texture.destroyed), 'Native position texture capacity was not captured');
        for (const upload of state.uploads) {
          assert.ok(upload.vertices % 8 === 0 && upload.vertexBytes / upload.vertices === (kind === 'dash' ? 35 : 7));
          assert.deepEqual(upload.layout.a_lineRecord, { componentDatatype: 5126, components: 1, normalize: false });
          assert.deepEqual(upload.layout.a_lineFlags, { componentDatatype: 5121, components: 1, normalize: false });
          assert.deepEqual(upload.layout.batchId, { componentDatatype: 5123, components: 1, normalize: false });
          for (const name of ['position3DHigh', 'position3DLow', 'position2DHigh', 'position2DLow', 'prevOffset', 'nextOffset'])
            assert.ok(!upload.layout[name], `round cap uploaded redundant ${name}`);
        }
        const output = testInfo.outputPath('round-cap-metrics.json');
        await writeFile(output, JSON.stringify({ mode, dpr, kind, measurements, ...state }, null, 2));
        await testInfo.attach('round-cap-metrics', { path: output, contentType: 'application/json' });
        const destroyed = await page.evaluate(() => {
          const { viewer, tileset } = window.renderValidation;
          window.stopRoundCapPixels();
          const current = window.roundCapPrimitives();
          const owners = [...new Set([...window.roundCapOwners.keys(), ...current])];
          const arrays = [...new Set([...window.roundCapOwners.values()].flatMap(resource => resource.arrays).concat(current.flatMap(primitive => primitive._va)))];
          const textures = [...new Set([...window.roundCapOwners.values()].map(resource => resource.texture).concat(current.map(primitive => primitive.positionTexture)).filter((texture): texture is NativeTexture => !!texture))];
          viewer.scene.primitives.remove(tileset);
          return { primitives: owners.every(primitive => primitive.isDestroyed()), arrays: arrays.every(array => array.isDestroyed()), textures: textures.length > 0 && textures.every(texture => texture.isDestroyed()) };
        });
        assert.ok(destroyed.primitives && destroyed.arrays && destroyed.textures, 'Native round-cap resources survived tileset removal');
      });
    }
  });
}
