import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

for (const { pixelRatio, scale, across, expectCulling } of [{ pixelRatio: 1, scale: 0.25, across: 24, expectCulling: true }, { pixelRatio: 2, scale: 0.25, across: 24, expectCulling: true }, { pixelRatio: 1, scale: 0.005, across: 4, expectCulling: false }]) {
  test.describe(() => {
    test.use({ deviceScaleFactor: pixelRatio });
    test(`screen-edge caps and miters keep uncull pixels and picking during 3D camera motion at DPR ${pixelRatio} and scale ${scale}`, async ({ page, renderUrl }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const initial = { version: 8, transition: { duration: 0, delay: 0 }, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#224455' } }] } satisfies StyleSpecification;
      await page.route('**/line-visibility/style.json', route => route.fulfill({ json: initial }));
      const query = new URLSearchParams({ style: `${renderUrl}/line-visibility/style.json`, atlas: '1', cityPerf: '1', motionBaseline: '1', antialias: '0', scale: `${scale}`, readback: '0' });
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => !!window.renderValidation?.tileset.tilesLoaded)).toBe(true);
      await page.evaluate((across) => {
        const { viewer, tileset, atlas } = window.renderValidation;
        const native = atlas!.cesium as any;
        const width = viewer.canvas.clientWidth;
        const height = viewer.canvas.clientHeight;
        const edges = ['left', 'right', 'top', 'bottom'];
        const point = (edge: string, across: number, along: number) => {
          const x = edge === 'left' ? -across : edge === 'right' ? width + across : width / 2 + along;
          const y = edge === 'top' ? -across : edge === 'bottom' ? height + across : height / 2 + along;
          const world = viewer.camera.pickEllipsoid(new native.Cartesian2(x, y), viewer.scene.mapProjection.ellipsoid);
          if (!world)
            throw new Error('Edge fixture ray missed the globe');
          const position = native.Cartographic.fromCartesian(world);
          return [native.Math.toDegrees(position.longitude), native.Math.toDegrees(position.latitude)];
        };
        const features = edges.map((edge, index) => ({
          type: 'Feature',
          properties: { edge },
          geometry: { type: 'LineString', coordinates: index < 2
            ? [point(edge, across, -2), point(edge, across, 2)]
            : [point(edge, across + 4, -3), point(edge, across, 0), point(edge, across + 4, 3)] },
        }));
        const layers = edges.flatMap((edge, index) => ['casing', 'roads'].map(layer => ({
          id: `${edge}-${layer}`,
          type: 'line',
          source: 'edges',
          filter: ['==', ['get', 'edge'], edge],
          layout: { 'line-cap': index % 2 === 0 ? 'round' : 'square', 'line-join': 'miter', 'line-miter-limit': index < 2 ? 2 : 12 },
          paint: { 'line-color': layer === 'casing' ? '#00cc00' : '#ffffff', 'line-width': layer === 'casing' ? 96 : 2 },
        })));
        tileset.setStyle({ version: 8, transition: { duration: 0, delay: 0 }, sources: { edges: { type: 'geojson', data: { type: 'FeatureCollection', features }, maxzoom: 18, tolerance: 0 } }, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#224455' } }, ...layers] } as any);
      }, across);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded), { timeout: 60_000 }).toBe(true);
      const result = await page.evaluate(async (renderUrl) => {
        const { viewer, tileset, atlas } = window.renderValidation;
        const native = atlas!.cesium as any;
        const registry = await import(`${renderUrl}/packages/cesium-vector-tileset/src/render/scene/draw-batch.ts`);
        const scene = viewer.scene as any;
        scene.debugShowFramesPerSecond = false;
        const renderer = (tileset as any)._vectorRenderer;
        const owners = () => {
          const found = new Set<any>();
          const visit = (entry: any) => {
            if (registry.uniformLineExtentForOwner(entry))
              found.add(entry);
            if (entry.primitive)
              visit(entry.primitive);
            for (const paint of entry._layers ?? [])
              visit(paint.owner);
            if (entry.get) {
              for (let index = 0; index < entry.length; index++)
                visit(entry.get(index));
            }
          };
          for (const tileId of renderer.tileIds) {
            for (const collection of renderer.getTileCollections(tileId))
              visit(collection);
          }
          return [...found];
        };
        const physical = () => {
          const result = new Set<any>();
          const visit = (entry: any) => {
            if (entry._va?.length)
              result.add(entry);
            if (entry.primitive)
              visit(entry.primitive);
            if (entry.get) {
              for (let index = 0; index < entry.length; index++)
                visit(entry.get(index));
            }
          };
          for (const tileId of renderer.tileIds) {
            for (const collection of renderer.getTileCollections(tileId))
              visit(collection);
          }
          return [...result];
        };
        let draws = 0;
        const originalDraw = scene.context.draw;
        scene.context.draw = function (command: any, ...args: any[]) {
          const batch = registry.drawBatchForOwner(command) ?? registry.drawBatchForOwner(command.owner);
          if (batch?.kind === 'line')
            draws++;
          return originalDraw.call(this, command, ...args);
        };
        const frame = () => new Promise<{ pixels: Uint8Array; draws: number }>((resolve) => {
          const stop = scene.postRender.addEventListener(() => {
            stop();
            const pixels = scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
            resolve({ pixels, draws });
          });
          draws = 0;
          scene.requestRender();
        });
        const initialPosition = native.Cartographic.clone(viewer.camera.positionCartographic);
        const { heading, pitch, roll } = viewer.camera;
        const samples = [];
        try {
          for (const [heightScale, angle] of [[1, 0], [1.04, 0.004], [0.96, -0.004], [1, 0]]) {
            viewer.camera.setView({ destination: native.Cartesian3.fromRadians(initialPosition.longitude, initialPosition.latitude, initialPosition.height * heightScale), orientation: { heading: heading + angle, pitch, roll } });
            await frame();
            const active = owners();
            const extents = active.map(owner => registry.uniformLineExtentForOwner(owner));
            const resources = physical().map(owner => ({ owner, arrays: [...owner._va], texture: owner.positionTexture }));
            active.forEach(owner => registry.registerUniformLineExtent(owner, undefined));
            let reference: Awaited<ReturnType<typeof frame>>;
            try {
              reference = await frame();
            }
            finally {
              active.forEach((owner, index) => registry.registerUniformLineExtent(owner, extents[index]));
            }
            const filtered = await frame();
            let differences = 0;
            let green = 0;
            let pickPosition: { x: number; y: number } | undefined;
            for (let offset = 0; offset < reference.pixels.length; offset += 4) {
              if ([0, 1, 2, 3].some(channel => reference.pixels[offset + channel] !== filtered.pixels[offset + channel]))
                differences++;
              if (filtered.pixels[offset] < 3 && Math.abs(filtered.pixels[offset + 1] - 204) < 3 && filtered.pixels[offset + 2] < 3) {
                green++;
                const pixel = offset / 4;
                const x = pixel % viewer.canvas.width;
                const y = Math.floor(pixel / viewer.canvas.width);
                if (!pickPosition && x > 2 && x < viewer.canvas.width - 3 && y > 2 && y < viewer.canvas.height - 3)
                  pickPosition = { x: (x + 0.5) * viewer.canvas.clientWidth / viewer.canvas.width, y: (viewer.canvas.height - y - 0.5) * viewer.canvas.clientHeight / viewer.canvas.height };
              }
            }
            const stable = resources.every(({ owner, arrays, texture }) => !owner.isDestroyed() && owner.positionTexture === texture && owner._va.length === arrays.length && arrays.every((array, index) => owner._va[index] === array));
            const picked = pickPosition && scene.pick(pickPosition, 1, 1)?.id?.layerId;
            samples.push({ heightScale, angle, height: viewer.camera.positionCartographic.height, owners: active.length, referenceDraws: reference.draws, filteredDraws: filtered.draws, differences, green, picked, stable });
          }
        }
        finally {
          scene.context.draw = originalDraw;
        }
        return samples;
      }, renderUrl);
      await writeFile(testInfo.outputPath('line-visibility-motion.json'), JSON.stringify(result, null, 2));
      expect(result[0].owners).toBeGreaterThan(0);
      // At ground level the world-metre height allowance can cover the narrow
      // road too. The close camera case verifies pixels, not a draw reduction.
      if (expectCulling)
        expect(result[0].filteredDraws).toBeLessThan(result[0].referenceDraws);
      expect(result[0].green).toBeGreaterThan(100);
      expect(result[0].picked).toMatch(/-casing$/);
      for (const sample of result) {
        expect(sample.differences).toBe(0);
        expect(sample.stable).toBe(true);
        expect(sample.filteredDraws).toBeLessThanOrEqual(sample.referenceDraws);
      }
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => window.renderValidation.renderErrors)).toEqual([]);
    });
  });
}
