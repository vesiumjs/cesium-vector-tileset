import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface CombinePrimitive {
  ready: boolean;
  _layout: string;
  _va?: unknown[];
  _geometries?: unknown;
  geometryInstances?: unknown;
  isDestroyed: () => boolean;
}
interface CombineFrame {
  phase: string;
  red: number;
  green: number;
  newGround: number;
  coverage: number[];
}
interface NativeCombineControl {
  held: Array<() => void>;
  scheduled: number;
  holding: boolean;
  frames: CombineFrame[];
  phase: string;
  dashDefaultFrames: number;
  exhaustPaint: boolean;
  budgetSkipped: number;
  primitives?: () => CombinePrimitive[];
  latest?: Omit<CombineFrame, 'phase'> & { pickPosition?: { x: number; y: number } };
  predecessors?: CombinePrimitive[];
  cancelled?: CombinePrimitive[];
  flush?: () => void;
  restore?: () => void;
}
declare global {
  interface Window { nativeCombineControl: NativeCombineControl }
}

const tile = Buffer.from(fromGeojsonVt({
  ground: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  roads: { features: [{ id: 100, type: 2, geometry: [[[1024, 2048], [3072, 2048]]], tags: { width: 24 } }] },
}, { version: 2, extent: 4096 }));

for (const mode of ['3d', '2d', 'cv']) {
  for (const [line, paint] of [['solid', 'uniform'], ['solid', 'instance'], ['dash', 'instance']]) {
    test(`Native combine preserves current ${line} ${paint} paint, held roads and late destruction in ${mode}`, async ({ page, renderUrl }, testInfo) => {
      const errors = [];
      const workers = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('worker', worker => workers.push(worker.url()));
      await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          combine: boolean;
          messageListeners = new Map<EventListenerOrEventListenerObject, EventListener>();
          heldDeliveries = new WeakMap<Event, Array<() => void>>();

          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.combine = String(url).endsWith('/Workers/combineGeometry.js');
          }

          postMessage(message: { parameters?: object }, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
            if (this.combine && message.parameters && window.nativeCombineControl)
              window.nativeCombineControl.scheduled++;
            return Array.isArray(transferOrOptions) ? super.postMessage(message, transferOrOptions) : super.postMessage(message, transferOrOptions);
          }

          addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
            if (!this.combine || type !== 'message')
              return super.addEventListener(type, listener, options);
            // Run the original Worker and transfer; hold only delivery of its
            // completed result to the owner. No production scheduling hook.
            const wrapped: EventListener = (event) => {
              const deliver = () => (listener as EventListener).call(this, event);
              const control = window.nativeCombineControl;
              if (control?.holding && (event as MessageEvent<{ result?: unknown }>).data.result !== undefined) {
                // Native has one listener per task. Hold each real reply once
                // and release its normal broadcast to all those listeners.
                let deliveries = this.heldDeliveries.get(event);
                if (!deliveries) {
                  deliveries = [];
                  this.heldDeliveries.set(event, deliveries);
                  control.held.push(() => deliveries.forEach(deliver => deliver()));
                }
                deliveries.push(deliver);
              }
              else {
                deliver();
              }
            };
            this.messageListeners.set(listener, wrapped);
            return super.addEventListener(type, wrapped, options);
          }

          removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
            const wrapped = type === 'message' && this.messageListeners.get(listener);
            this.messageListeners.delete(listener);
            return super.removeEventListener(type, wrapped || listener, options);
          }
        };
      });
      const background = { version: 8, transition: { duration: 0, delay: 0 }, sources: {}, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#224455' } },
      ] } satisfies StyleSpecification;
      const cityStyle = (source: string, color: string, width = 24) => ({
        ...background,
        sources: { [source]: { type: 'vector', tiles: [`${renderUrl}/native-combine/${source}/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
        layers: [
          ...background.layers,
          { 'id': 'ground', 'type': 'fill', source, 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } },
          { 'id': 'roads', 'type': 'line', source, 'source-layer': 'roads', 'paint': {
            'line-color': color,
            'line-width': paint === 'instance' ? ['get', 'width'] : width,
            ...(line === 'dash' ? { 'line-dasharray': [2, 2] } : {}),
          } },
        ],
      } satisfies StyleSpecification);
      await page.route('**/native-combine/**', route => route.request().url().endsWith('.pbf')
        ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
        : route.fulfill({ json: background }));
      const query = new URLSearchParams({ mode, style: `${renderUrl}/native-combine/style.json`, synthetic: '4096', atlas: '1' });
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => window.renderValidation?.readCoverage([34, 68, 85]).every(value => value > 0.98)), { timeout: 60_000 }).toBe(true);

      await page.evaluate((exhaustPaint) => {
        const { viewer, tileset } = window.renderValidation;
        viewer.scene.debugShowFramesPerSecond = true;
        const control: NativeCombineControl = window.nativeCombineControl = { held: [], scheduled: 0, holding: true, frames: [], phase: 'first', dashDefaultFrames: 0, exhaustPaint: false, budgetSkipped: 0 };
        const renderer = tileset._vectorRenderer;
        const paintUpdate = renderer.updatePaint;
        if (exhaustPaint) {
          renderer.updatePaint = function (frame) {
            if (control.exhaustPaint)
              control.budgetSkipped++;
            return Reflect.apply(paintUpdate, this, [control.exhaustPaint ? { ...frame, budget: { exhausted: true } } : frame]);
          };
        }
        control.primitives = () => [...new Set([
          ...tileset._vectorRenderer.tileIds.flatMap(id => tileset._vectorRenderer.getTileCollections(id)
            .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index)))),
          ...tileset._patternRenderer.tileIds.flatMap(id => tileset._patternRenderer.getTilePrimitives(id)),
        ].map(entry => entry.primitive ?? entry))].filter(primitive => typeof primitive._layout === 'string');
        const stop = viewer.scene.postRender.addEventListener(() => {
          const { canvas, scene } = viewer;
          const pixels = scene.context.readPixels({ width: canvas.width, height: canvas.height });
          let red = 0;
          let green = 0;
          let newGround = 0;
          let pickPosition;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const r = pixels[offset];
            const g = pixels[offset + 1];
            const b = pixels[offset + 2];
            if (Math.abs(r - 170) < 3 && Math.abs(g - 51) < 3 && Math.abs(b - 85) < 3)
              newGround++;
            if (r > 200 && g < 40 && b < 40)
              red++;
            if (g > 200 && r < 40 && b < 40) {
              green++;
              const x = offset / 4 % canvas.width;
              const y = Math.floor(offset / 4 / canvas.width);
              if (!pickPosition && x > 32 && x < canvas.width - 32 && y > 32 && y < canvas.height - 32) {
                pickPosition = {
                  x: (x + 0.5) * canvas.clientWidth / canvas.width,
                  y: (canvas.height - y - 0.5) * canvas.clientHeight / canvas.height,
                };
              }
            }
          }
          const coverage = [0.25, 0.5, 0.75].map((row) => {
            let filled = 0;
            const y = Math.floor(canvas.height * row);
            const start = Math.floor(canvas.width * 0.1);
            const end = Math.floor(canvas.width * 0.9);
            for (let x = start; x < end; x++) {
              const offset = (y * canvas.width + x) * 4;
              if (pixels[offset] + pixels[offset + 1] > 20)
                filled++;
            }
            return filled / (end - start);
          });
          control.latest = { red, green, newGround, coverage, pickPosition };
          control.frames.push({ phase: control.phase, red, green, newGround, coverage });
          const material = tileset._vectorRenderer.dashMaterial?._material;
          if (green > 0 && material && (!material._textures.u_dashAtlas || material._textures.u_dashAtlas === scene.context.defaultTexture))
            control.dashDefaultFrames++;
          if (red > 0 || green > 0)
            control.exhaustPaint = false;
        });
        control.flush = () => {
          control.holding = false;
          control.held.splice(0).forEach(resolve => resolve());
          viewer.scene.requestRender();
        };
        control.restore = () => {
          control.holding = false;
          renderer.updatePaint = paintUpdate;
          stop();
        };
      }, mode === 'cv' && line === 'dash');

      const initialStyle = cityStyle('a', '#ff0000', 8);
      if (mode !== '3d')
        initialStyle.layers[1].paint['fill-color'] = '#ff0000';
      await page.evaluate(style => window.renderValidation.tileset.setStyle(style), initialStyle);
      await expect.poll(() => page.evaluate(() => window.nativeCombineControl.held.length), { timeout: 60_000 }).toBe(2);
      await expect.poll(() => page.evaluate(() => window.nativeCombineControl.primitives().length), { timeout: 30_000 }).toBeGreaterThan(2);
      const waiting = await page.evaluate(async () => {
        const control = window.nativeCombineControl;
        const frames = control.frames.length;
        while (control.frames.length < frames + 5) {
          window.renderValidation.viewer.scene.requestRender();
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        return {
          scheduled: control.scheduled,
          pending: control.primitives().length,
          uploaded: control.primitives().filter(primitive => primitive.ready || primitive._va.length > 0).length,
          ...control.latest,
        };
      });
      assert.equal(waiting.scheduled, 2, 'pending results exceeded two in-flight slots');
      assert.equal(waiting.uploaded, 0, 'pending combine uploaded a VA or became ready');
      assert.equal(waiting.red, 0);

      await page.evaluate(({ style, exhaustPaint }) => {
        window.nativeCombineControl.exhaustPaint = exhaustPaint;
        window.renderValidation.tileset.setStyle(style);
        window.nativeCombineControl.flush();
      }, { style: cityStyle('a', '#00ff00'), exhaustPaint: mode === 'cv' && line === 'dash' });
      await expect.poll(() => page.evaluate(() => !!(window.renderValidation.tileset.tilesLoaded && window.nativeCombineControl.latest.pickPosition)), { timeout: 60_000 }).toBe(true);
      const first = await page.evaluate(() => {
        const { viewer, tileset } = window.renderValidation;
        const control = window.nativeCombineControl;
        const picked = viewer.scene.pick(control.latest.pickPosition);
        control.predecessors = control.primitives().filter(primitive => primitive.ready);
        return {
          visible: control.latest.green,
          staleFrames: control.frames.filter(frame => frame.red > 0).length,
          pickLayer: (picked?.id ?? picked)?.layerId,
          ready: control.primitives().filter(primitive => primitive.ready).length,
          loaded: tileset.tilesLoaded,
          dashDefaultFrames: control.dashDefaultFrames,
          budgetSkipped: control.budgetSkipped,
        };
      });
      const firstOutput = testInfo.outputPath('first-native-paint.json');
      await writeFile(firstOutput, JSON.stringify({ waiting, first }, null, 2));
      await testInfo.attach('first-native-paint', { path: firstOutput, contentType: 'application/json' });
      assert.equal(first.staleFrames, 0, 'first visible Native result used superseded paint');
      assert.equal(first.pickLayer, 'roads');
      assert.equal(first.dashDefaultFrames, 0, 'first dash draw sampled the default texture');
      if (mode === 'cv' && line === 'dash')
        assert.ok(first.budgetSkipped > 0, 'paint budget exhaustion was not exercised');
      assert.ok(first.ready > 0);

      await page.evaluate(() => {
        const control = window.nativeCombineControl;
        control.holding = true;
        control.scheduled = 0;
        control.phase = 'replace';
      });
      const successorStyle = cityStyle('b', '#00ff00');
      successorStyle.layers[1].paint['fill-color'] = '#aa3355';
      await page.evaluate(style => window.renderValidation.tileset.setStyle(style), successorStyle);
      await expect.poll(() => page.evaluate(() => window.nativeCombineControl.held.length), { timeout: 60_000 }).toBe(2);
      const replacement = await page.evaluate(() => {
        const control = window.nativeCombineControl;
        control.cancelled = control.primitives().filter(primitive => !primitive.ready);
        return { green: control.latest.green, newGround: control.latest.newGround, pending: control.cancelled.length, scheduled: control.scheduled };
      });
      assert.equal(replacement.scheduled, 2);
      assert.ok(replacement.pending >= 2);
      assert.ok(replacement.green > 0, 'old roads disappeared while successors were combining');
      assert.equal(replacement.newGround, 0, 'new ground escaped the pending source handoff');

      await page.evaluate(() => {
        window.nativeCombineControl.phase = 'complete';
        window.nativeCombineControl.flush();
      });
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded && window.nativeCombineControl.latest.newGround > 0), { timeout: 60_000 }).toBe(true);
      const completed = await page.evaluate(() => {
        const control = window.nativeCombineControl;
        const { viewer, tileset } = window.renderValidation;
        const picked = viewer.scene.pick(control.latest.pickPosition);
        return {
          oldDestroyed: control.predecessors.every(primitive => primitive.isDestroyed()),
          hidden: tileset._tileResidency.hiddenStyleTiles.size,
          newGround: control.latest.newGround,
          green: control.latest.green,
          pickLayer: (picked?.id ?? picked)?.layerId,
          pickTile: (picked?.id ?? picked)?.tileId,
        };
      });
      assert.ok(completed.oldDestroyed, 'completed source replacement retained old Native primitives');
      assert.equal(completed.hidden, 0);
      assert.equal(completed.pickLayer, 'roads');
      assert.ok(completed.pickTile.startsWith('b/'), 'completed source still picked the old generation');
      await page.evaluate(() => {
        const control = window.nativeCombineControl;
        control.holding = true;
        control.scheduled = 0;
        control.phase = 'cancelPending';
      });
      await page.evaluate(style => window.renderValidation.tileset.setStyle(style), cityStyle('c', '#00ff00'));
      await expect.poll(() => page.evaluate(() => window.nativeCombineControl.held.length), { timeout: 60_000 }).toBe(2);
      await page.evaluate(() => {
        const control = window.nativeCombineControl;
        control.cancelled = control.primitives().filter(primitive => !primitive.ready);
      });
      await page.evaluate((style) => {
        window.nativeCombineControl.phase = 'cancelled';
        return window.renderValidation.tileset.setStyle(style);
      }, background);
      await expect.poll(() => page.evaluate(() => window.nativeCombineControl.cancelled.every(primitive => primitive.isDestroyed())), { timeout: 30_000 }).toBe(true);
      await page.evaluate(async () => {
        const control = window.nativeCombineControl;
        control.phase = 'cancelled';
        control.flush();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const final = await page.evaluate(() => {
        const { viewer, renderErrors } = window.renderValidation;
        const control = window.nativeCombineControl;
        const result = {
          cancelled: control.cancelled.map(primitive => ({
            destroyed: primitive.isDestroyed(),
            geometry: primitive.geometryInstances !== undefined || primitive._geometries !== undefined,
            arrays: primitive._va?.length ?? 0,
          })),
          staleFrames: control.frames.filter(frame => frame.red > 0).length,
          replacementHoles: control.frames.filter(frame => frame.phase === 'replace' && frame.green === 0).length,
          partialSourceFrames: control.frames.filter(frame => frame.phase === 'replace' && frame.newGround > 0).length,
          coverageMinimum: Math.min(...control.frames.flatMap(frame => frame.coverage)),
          fps: viewer.scene.debugShowFramesPerSecond,
          renderErrors,
        };
        control.restore();
        return result;
      });
      assert.ok(final.cancelled.length >= 2);
      assert.ok(final.cancelled.every(primitive => primitive.destroyed && !primitive.geometry && primitive.arrays === 0), 'a late result revived destroyed geometry');
      assert.equal(final.staleFrames, 0);
      assert.equal(final.replacementHoles, 0, 'source replacement hid held roads');
      assert.equal(final.partialSourceFrames, 0, 'a partial source generation became visible');
      assert.ok(final.coverageMinimum > 0.98);
      assert.ok(final.fps);
      assert.deepEqual(final.renderErrors, []);
      assert.deepEqual(errors, []);
      const combineWorkers = workers.filter(url => url.endsWith('/combineGeometry.js'));
      assert.equal(combineWorkers.length, 1, 'Native geometry chunks created separate Workers');
      const metrics = testInfo.outputPath('native-combine.json');
      await writeFile(metrics, JSON.stringify({ mode, line, paint, waiting, first, replacement, completed, ...final, workers }, null, 2));
      await testInfo.attach('native-combine', { path: metrics, contentType: 'application/json' });
    });
  }
}
