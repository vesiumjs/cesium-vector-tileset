import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativePrimitive, NativeTexture, NativeVertexArray, TestTileset } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

type ParcelRecord = Parameters<TestTileset['_vectorRenderer']['_records']['set']>[1];
interface ParcelCombineInput { instances: number; geometryBytes: number; instanceBytes: number; serializedBytes: number }
interface ParcelNativeSnapshot { tileId: string; features: number; instances: number; state: number; combining: boolean; ready: boolean; arrays: number }
interface ParcelFrame {
  phase: string;
  paint: string;
  budgetExhausted: boolean;
  samples: Array<{ featureIndex: number; onScreen: boolean; pixel: number[] }>;
}
interface ParcelHandoff {
  holding: boolean;
  held: Array<() => void>;
  recording: boolean;
  phase: string;
  frames: ParcelFrame[];
  oldColors: number[][];
  newColors: number[][];
  exhaustPaint: boolean;
  budgetSkipped: number;
  newVisible: boolean;
  restore?: () => void;
  native?: () => ParcelNativeSnapshot[];
}
interface ParcelSnapshot {
  records: Array<{
    tileId: string;
    generationId: number;
    features: number;
    featureIndices: number[];
    primitives: Array<{
      identity: number;
      type: string;
      layout: string;
      instances: number;
      state: number;
      ready: boolean;
      batchTableIdentity: number;
      textureIdentity: number;
      textureHandleIdentity: number;
      attributes: string[];
      descriptors: number;
      arrays: Array<{ identity: number; vertices: number; vertexBytes: number; indexBytes: number; attributes: Array<{ name: string; type: number; components: number; normalize: boolean }> }>;
    }>;
  }>;
  stable: boolean;
  probes: Array<{
    featureIndex: number;
    position: { x: number; y: number };
    onScreen: boolean;
    pixels: number[][];
    picked: TilePickObject;
    matchesEntry: boolean;
    attributes: { color: number[]; show: number[] };
  }>;
}
interface ParcelReport {
  mode: string;
  center: number[];
  bounds: number[];
  probes: typeof probes;
  phases: Array<{ phase: string } & ParcelSnapshot>;
  errors: string[];
  phase?: string;
  retired?: unknown;
  heldNative?: { heldResults: number; primitives: ParcelNativeSnapshot[]; currentPaint?: { budgetSkipped: number; frames: number; primitives: ParcelNativeSnapshot[] } };
  final?: unknown;
  failure?: { message: string; stack?: string };
  lastBrowserState?: unknown;
  artifactCollectionError?: string;
}
declare global {
  interface Window {
    parcelCombineInputs: ParcelCombineInput[];
    parcelOriginalRecords: Array<[string, ParcelRecord]>;
    parcelOriginal: Array<{ primitive: NativePrimitive; arrays: NativeVertexArray[]; batchTable: NativePrimitive['_batchTable']; texture?: NativeTexture; textureHandle?: WebGLTexture }>;
    parcelStable: () => boolean;
    stopParcelPixels: () => void;
    parcelPixels: Uint8Array;
    parcelHandoff: ParcelHandoff;
    parcelSnapshot: (source?: string) => ParcelSnapshot;
  }
}

const extent = 4096;
const tileCount = 2 ** 14;
const tileX = 8192;
const tileY = 8192;
const indices = [0, 512, 1023];
const initialColors = ['#ff0000', '#00ff00', '#0000ff'];
const repaintColors = ['#ff00ff', '#00ffff', '#ffff00'];
const restoredColors = ['#ff8000', '#8000ff', '#00ff80'];
const cells = Array.from({ length: 1024 }, (_, index) => index);
// Move the boundary probes into adjacent central cells. The camera sees all
// three even though most of the dense tile lies outside its narrow viewport.
for (const [index, cell] of [[0, 15 * 32 + 15], [512, 15 * 32 + 16], [1023, 15 * 32 + 17]]) {
  const previous = cells.indexOf(cell);
  [cells[index], cells[previous]] = [cells[previous], cells[index]];
}
const longitude = x => ((tileX + x / extent) / tileCount) * 360 - 180;
const latitude = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + y / extent) / tileCount))) * 180 / Math.PI;
const center = [longitude(extent / 2), latitude(extent / 2)];
const bounds: [number, number, number, number] = [longitude(1), latitude(extent - 1), longitude(extent - 1), latitude(1)];
const probes = indices.map((featureIndex) => {
  const cell = cells[featureIndex];
  return { featureIndex, longitude: longitude((cell % 32) * 128 + 64), latitude: latitude(Math.floor(cell / 32) * 128 + 64) };
});
const tile = Buffer.from(fromGeojsonVt({
  parcels: { features: cells.map((cell, featureIndex) => {
    const x = (cell % 32) * 128 + 12;
    const y = Math.floor(cell / 32) * 128 + 12;
    const probeIndex = indices.indexOf(featureIndex);
    return {
      id: featureIndex + 1,
      type: 3,
      geometry: [[[x, y], [x + 104, y], [x + 104, y + 104], [x, y + 104], [x, y]]],
      tags: {
        parcel: featureIndex,
        initialColor: probeIndex < 0 ? '#224455' : initialColors[probeIndex],
      },
    };
  }) },
}, { version: 2, extent }));

function rgb(colors: string[]) {
  return colors.map(color => [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16)));
}

function colorStates(colors) {
  return Array.from({ length: 1024 }, (_, featureIndex) => {
    const probeIndex = indices.indexOf(featureIndex);
    return { featureIndex, state: { color: probeIndex < 0 ? '#224455' : colors[probeIndex] } };
  });
}

function opacityStates(opacity) {
  return Array.from({ length: 1024 }, (_, featureIndex) => ({ featureIndex, state: { opacity } }));
}

function assertBatches(snapshot: ParcelSnapshot) {
  assert.equal(snapshot.records.length, 1, 'the bounded city fixture must render exactly one tile');
  const [record] = snapshot.records;
  assert.equal(record.features, 1024, 'the dense parcel layer lost geometry instances');
  assert.deepEqual(record.featureIndices, Array.from({ length: 1024 }, (_, index) => index));
  assert.equal(record.primitives.length, 1, '1024 four-corner parcels must share one Native primitive');
  const [primitive] = record.primitives;
  assert.equal(primitive.type, 'GeometryPrimitive');
  assert.equal(primitive.layout, 'surface-planar');
  assert.equal(primitive.instances, 1024);
  assert.ok(primitive.batchTableIdentity && primitive.textureIdentity && primitive.textureHandleIdentity, 'Native instance paint must use an actual batch table texture');
  assert.equal(primitive.arrays.length, 1, 'ordinary city parcels must upload one Native VA');
  const [array] = primitive.arrays;
  assert.equal(array.vertices, 4096);
  assert.equal(array.vertexBytes, 4096 * 9, 'dense parcels must upload seven coordinate bytes and two exact batch bytes per vertex');
  assert.equal(array.indexBytes, 1024 * 6 * 2);
  assert.deepEqual(primitive.attributes.sort(), ['a_surface0', 'a_surface1', 'batchId']);
  assert.equal(primitive.descriptors, 6);
  assert.deepEqual(array.attributes.filter(attribute => attribute.name.startsWith('a_surface')).map(attribute => ({ type: attribute.type, components: attribute.components, normalize: attribute.normalize })), [
    { type: 0x1401, components: 4, normalize: false },
    { type: 0x1401, components: 3, normalize: false },
  ]);
  assert.deepEqual(array.attributes.find(attribute => attribute.name === 'batchId'), { name: 'batchId', type: 0x1403, components: 1, normalize: false });
}

function assertProbes(snapshot: ParcelSnapshot, colors: number[][], source: string, hidden: number[] = []) {
  for (const [index, probe] of snapshot.probes.entries()) {
    assert.equal(probe.featureIndex, indices[index]);
    assert.ok(probe.onScreen, `parcel ${probe.featureIndex} is outside the viewport`);
    assert.equal(probe.attributes.show[0], hidden.includes(probe.featureIndex) ? 0 : 1);
    if (hidden.includes(probe.featureIndex)) {
      assert.equal(probe.attributes.color[3], 0);
      assert.notEqual(probe.picked?.layerId, 'parcels', 'hidden instance remained pickable');
      continue;
    }
    assert.deepEqual(probe.attributes.color, [...colors[index], 255]);
    assert.ok(probe.pixels.length === 9 && probe.pixels.every(pixel => colors[index].every((channel, channelIndex) => Math.abs(pixel[channelIndex] - channel) < 3)), `parcel ${probe.featureIndex} has incorrect actual framebuffer color`);
    assert.equal(probe.picked?.layerId, 'parcels');
    assert.equal(probe.picked?.featureIndex, probe.featureIndex);
    assert.equal(probe.picked?.tileId, snapshot.records[0].tileId);
    assert.equal(probe.picked?.generationId, snapshot.records[0].generationId);
    assert.ok(probe.picked.tileId.startsWith(`${source}/`));
    assert.ok(probe.matchesEntry, 'scene.pick did not return the recorded Native instance ID');
  }
}

for (const mode of ['2d', 'cv']) {
  test(`1024 standard parcels share one Native batch and retain independent feature-state paint, picking and residency in ${mode}`, async ({ page, renderUrl }, testInfo) => {
    const errors: string[] = [];
    const phases: ParcelReport['phases'] = [];
    const heldRequests: Array<() => void> = [];
    const report: ParcelReport = { mode, center, bounds, probes, phases, errors };
    page.on('pageerror', error => errors.push(error.message));
    try {
      // Observe real Native serialized input before its buffers are transferred.
      // The original Worker executes every combine and uploads the actual GPU VA.
      await page.addInitScript(() => {
        window.parcelCombineInputs = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          parcelCombine: boolean;
          messageListeners = new Map<EventListenerOrEventListenerObject, EventListener>();

          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.parcelCombine = String(url).endsWith('/Workers/combineGeometry.js');
            this.messageListeners = new Map();
          }

          postMessage(message: { parameters?: { packedInstances?: Float64Array; createGeometryResults: Array<{ packedData: Float64Array }> } }, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
            const parameters = message?.parameters;
            if (this.parcelCombine && parameters?.packedInstances) {
              const geometryBytes = parameters.createGeometryResults.reduce((bytes, result) => bytes + result.packedData.byteLength, 0);
              const instanceBytes = parameters.packedInstances.byteLength;
              window.parcelCombineInputs.push({ instances: parameters.packedInstances[0], geometryBytes, instanceBytes, serializedBytes: geometryBytes + instanceBytes });
            }
            return Array.isArray(transferOrOptions) ? super.postMessage(message, transferOrOptions) : super.postMessage(message, transferOrOptions);
          }

          addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
            if (!this.parcelCombine || type !== 'message')
              return super.addEventListener(type, listener, options);
            const wrapped: EventListener = (event) => {
              const deliver = () => (listener as EventListener).call(this, event);
              const control = window.parcelHandoff;
              // Cesium's actual Worker has finished. Hold only the delivery of
              // its transferred result, leaving the owner in Native COMBINING.
              if (control?.holding && (event as MessageEvent<{ result?: unknown }>).data.result !== undefined)
                control.held.push(deliver);
              else
                deliver();
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
      const style = {
        version: 8,
        transition: { duration: 0, delay: 0 },
        sources: { city: { type: 'vector', tiles: [`${renderUrl}/parcel-batches/city/{z}/{x}/{y}.pbf`], minzoom: 14, maxzoom: 14, bounds } },
        layers: [{ 'id': 'parcels', 'type': 'fill', 'source': 'city', 'source-layer': 'parcels', 'paint': {
          'fill-color': ['to-color', ['coalesce', ['feature-state', 'color'], ['get', 'initialColor']]],
          'fill-opacity': ['number', ['feature-state', 'opacity'], 1],
          'fill-antialias': false,
        } }],
      } satisfies StyleSpecification;
      await page.route('**/parcel-batches/**', async (route) => {
        if (!route.request().url().endsWith('.pbf'))
          return route.fulfill({ json: style });
        if (route.request().url().includes('/successor/'))
          await new Promise<void>(resolve => heldRequests.push(resolve));
        return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
      });
      const query = new URLSearchParams({ mode, style: `${renderUrl}/parcel-batches/style.json`, center: center.join(','), scale: '0.7', synthetic: '4096', atlas: '1', antialias: '0' });
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => {
        const validation = window.renderValidation;
        return {
          loaded: validation?.tileset.tilesLoaded ?? false,
          zoom: validation?.tileset._styleEvaluation.zoom,
          stats: validation?.tileset.stats(),
          records: validation
            ? [...validation.tileset._vectorRenderer._records.values()].map(record => ({
                features: record.standard?.polygons.length,
                ready: record.standard?.polygons.every(entry => entry.primitive.ready && entry.primitive._va.length > 0),
              }))
            : [],
        };
      }), { timeout: 60_000 }).toMatchObject({ loaded: true, records: [{ features: 1024, ready: true }] });
      await page.evaluate((probes) => {
        const { viewer, tileset } = window.renderValidation;
        viewer.scene.debugShowFramesPerSecond = true;
        const identity = new WeakMap<object, number>();
        let nextIdentity = 1;
        const resourceId = (resource: object) => {
          if (!identity.has(resource))
            identity.set(resource, nextIdentity++);
          return identity.get(resource);
        };
        const nativePrimitives = () => [...new Set([...tileset._vectorRenderer._records.values()].flatMap(record => record.standard?.polygons.map(entry => entry.primitive) ?? []))];
        window.parcelOriginalRecords = [...tileset._vectorRenderer._records.entries()];
        window.parcelOriginal = nativePrimitives().map(primitive => ({
          primitive,
          arrays: [...primitive._va],
          batchTable: primitive._batchTable,
          texture: primitive._batchTable._texture,
          textureHandle: primitive._batchTable._texture?._texture,
        }));
        window.parcelStable = () => window.parcelOriginal.every(({ primitive, arrays, batchTable, texture, textureHandle }) => !primitive.isDestroyed()
          && primitive._va.length === arrays.length && arrays.every((array, index) => primitive._va[index] === array)
          && primitive._batchTable === batchTable
          && (!texture || primitive._batchTable._texture === texture)
          && (!textureHandle || primitive._batchTable._texture?._texture === textureHandle));
        window.stopParcelPixels = viewer.scene.postRender.addEventListener(() => {
          window.parcelPixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
          const control = window.parcelHandoff;
          if (!control?.recording)
            return;
          const { canvas } = viewer;
          const samples = probes.map((probe) => {
            const position = window.renderValidation.projectPosition(probe.longitude, probe.latitude);
            const x = position && Math.floor(position.x * canvas.width / canvas.clientWidth);
            const y = position && canvas.height - 1 - Math.floor(position.y * canvas.height / canvas.clientHeight);
            const onScreen = !!position && x > 1 && x < canvas.width - 2 && y > 1 && y < canvas.height - 2;
            return { featureIndex: probe.featureIndex, onScreen, pixel: onScreen ? Array.from(window.parcelPixels.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)) : [] };
          });
          const matches = (colors: number[][]) => samples.every((sample, index) => sample.onScreen && colors[index].every((channel, channelIndex) => Math.abs(sample.pixel[channelIndex] - channel) < 3));
          const paint = matches(control.oldColors) ? 'old' : matches(control.newColors) ? 'new' : 'invalid';
          control.frames.push({ phase: control.phase, paint, samples, budgetExhausted: control.exhaustPaint });
          if (paint === 'new') {
            control.newVisible = true;
            control.exhaustPaint = false;
          }
        });
        window.parcelSnapshot = (source = 'city') => {
          const { canvas, scene } = viewer;
          let selected = [...tileset._vectorRenderer._records.entries()].filter(([tileId]) => tileId.startsWith(`${source}/`));
          // A source handoff can keep the predecessor scene collections alive
          // after removing their live record. Retain their real entries for the
          // old-source pixel/pick checks during that ownership transfer.
          if (!selected.length && source === 'city' && window.parcelStable())
            selected = window.parcelOriginalRecords;
          const records = selected.map(([tileId, record]) => ({
            tileId,
            generationId: record.generationId,
            features: record.standard.polygons.length,
            featureIndices: record.standard.polygons.map(entry => entry.id.featureIndex).sort((a, b) => a - b),
            primitives: [...new Set(record.standard.polygons.map(entry => entry.primitive))].map(primitive => ({
              identity: resourceId(primitive),
              type: primitive.constructor.name,
              layout: primitive._layout,
              instances: primitive._numberOfInstances,
              state: primitive._state,
              ready: primitive.ready,
              batchTableIdentity: primitive._batchTable && resourceId(primitive._batchTable),
              textureIdentity: primitive._batchTable?._texture && resourceId(primitive._batchTable._texture),
              textureHandleIdentity: primitive._batchTable?._texture?._texture && resourceId(primitive._batchTable._texture._texture),
              attributes: Object.keys(primitive._attributeLocations ?? {}),
              descriptors: (primitive.appearance as typeof primitive.appearance & { uniforms: { surface_words: unknown[] } }).uniforms.surface_words.length,
              arrays: primitive._va.map((array) => {
                const attributes = Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index));
                return {
                  identity: resourceId(array),
                  vertices: array.numberOfVertices,
                  vertexBytes: [...new Set(attributes.map(attribute => attribute.vertexBuffer))].reduce((bytes, buffer) => bytes + (buffer?.sizeInBytes ?? 0), 0),
                  indexBytes: array.indexBuffer?.sizeInBytes ?? 0,
                  attributes: Object.entries(primitive._attributeLocations).map(([name, location]) => {
                    const attribute = attributes.find(attribute => attribute.index === location)!;
                    return { name, type: attribute.componentDatatype, components: attribute.componentsPerAttribute, normalize: attribute.normalize };
                  }),
                };
              }),
            })),
          }));
          return {
            records,
            stable: window.parcelStable(),
            probes: probes.map((probe) => {
              const entry = selected.flatMap(([, record]) => record.standard.polygons).find(entry => entry.id.featureIndex === probe.featureIndex);
              const attributes = entry?.primitive.getGeometryInstanceAttributes(entry.id);
              const position = window.renderValidation.projectPosition(probe.longitude, probe.latitude);
              const x = position && Math.floor(position.x * canvas.width / canvas.clientWidth);
              const y = position && canvas.height - 1 - Math.floor(position.y * canvas.height / canvas.clientHeight);
              const onScreen = !!position && x > 1 && x < canvas.width - 2 && y > 1 && y < canvas.height - 2;
              const pixels = onScreen && window.parcelPixels
                ? [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => Array.from(window.parcelPixels.subarray(((y + dy) * canvas.width + x + dx) * 4, ((y + dy) * canvas.width + x + dx) * 4 + 4))))
                : [];
              const picked = onScreen ? scene.pick(position)?.id : undefined;
              return {
                featureIndex: probe.featureIndex,
                position: position && { x: position.x, y: position.y },
                onScreen,
                pixels,
                picked,
                matchesEntry: picked === entry?.id,
                attributes: attributes && { color: Array.from(attributes.color), show: Array.from(attributes.show) },
              };
            }),
          };
        };
        viewer.scene.requestRender();
      }, probes);
      const capture = async (phase: string, colors: number[][], source = 'city', hidden: number[] = []) => {
        report.phase = phase;
        await expect.poll(() => page.evaluate(({ colors, hidden, source }) => {
          const snapshot = window.parcelSnapshot(source);
          return snapshot.probes.every((probe, index) => probe.onScreen && probe.attributes
            && (hidden.includes(probe.featureIndex)
              ? probe.attributes.show[0] === 0 && probe.picked?.layerId !== 'parcels'
              : probe.attributes.show[0] === 1 && probe.pixels.length === 9
                && probe.pixels.every(pixel => colors[index].every((channel, channelIndex) => Math.abs(pixel[channelIndex] - channel) < 3))
                && probe.picked?.featureIndex === probe.featureIndex));
        }, { colors, hidden, source }), { timeout: 30_000 }).toBe(true);
        const snapshot = await page.evaluate(source => window.parcelSnapshot(source), source);
        phases.push({ phase, ...snapshot });
        assertBatches(snapshot);
        assertProbes(snapshot, colors, source, hidden);
        if (source === 'city')
          assert.ok(snapshot.stable, `${phase} replaced an uploaded Native VA`);
        return snapshot;
      };
      // Preserve one Worker paint binding throughout the identity checks.
      // Changing a data-driven expression legitimately reparses its binder and
      // reloads source geometry. Feature state exercises mutable instance paint
      // through the real Style path; surface-geometry covers constant changes.
      const setStates = async (states, source = 'city') => page.evaluate(({ states, source }) => {
        const { tileset, viewer } = window.renderValidation;
        for (const { featureIndex, state } of states)
          tileset._style.setFeatureState({ source, sourceLayer: 'parcels', id: featureIndex + 1 }, state);
        viewer.scene.requestRender();
      }, { states, source });
      const initial = await capture('initial-data-paint', rgb(initialColors));
      assert.equal(initial.records[0].primitives[0].instances, 1024);
      const inputs = await page.evaluate(() => window.parcelCombineInputs);
      assert.equal(inputs.length, 1, 'the one-tile parcel layer scheduled multiple Native combines');
      assert.equal(inputs[0].instances, 1024);
      assert.ok(inputs[0].serializedBytes <= 512 * 1024);

      await setStates(Array.from({ length: 1024 }, (_, featureIndex) => ({ featureIndex, state: { color: '#ffffff' } })));
      await capture('uniform-feature-state-paint', rgb(['#ffffff', '#ffffff', '#ffffff']));
      await setStates(colorStates(repaintColors));
      await capture('updated-feature-state-paint', rgb(repaintColors));
      await setStates([{ featureIndex: 512, state: { opacity: 0 } }]);
      await capture('independent-instance-show-zero', rgb(repaintColors), 'city', [512]);
      await setStates(opacityStates(0));
      await capture('opacity-and-show-zero', rgb(repaintColors), 'city', indices);
      await setStates(opacityStates(1));
      await capture('opacity-and-show-restored', rgb(repaintColors));

      // Exercise the real out-of-view residency path, then change paint while
      // the GPU resources are retired and restore the same camera footprint.
      await page.evaluate((center) => {
        const { viewer, atlas } = window.renderValidation;
        viewer.camera.setView({ destination: atlas.cesium.Rectangle.fromDegrees(center[0] + 0.2, center[1] - 0.00315, center[0] + 0.215, center[1] + 0.00315) });
        viewer.scene.requestRender();
      }, center);
      const originalTile = initial.records[0].tileId;
      await expect.poll(() => page.evaluate(tileId => !!window.renderValidation.tileset._vectorRenderer._retired.get(tileId), originalTile), { timeout: 30_000 }).toBe(true);
      await setStates(colorStates(restoredColors));
      const retired = await page.evaluate(tileId => ({
        tileId,
        cached: !!window.renderValidation.tileset._vectorRenderer._retired.get(tileId),
        stable: window.parcelStable(),
      }), originalTile);
      report.retired = retired;
      assert.ok(retired.cached && retired.stable, 'retirement discarded the uploaded parcel batch');
      await page.evaluate((center) => {
        const { viewer, atlas } = window.renderValidation;
        viewer.camera.setView({ destination: atlas.cesium.Rectangle.fromDegrees(center[0] - 0.02625, center[1] - 0.011025, center[0] + 0.02625, center[1] + 0.011025) });
        viewer.scene.requestRender();
      }, center);
      await expect.poll(() => page.evaluate(tileId => window.renderValidation.tileset._vectorRenderer._records.has(tileId), originalTile), { timeout: 30_000 }).toBe(true);
      await capture('restored-current-feature-state-paint', rgb(restoredColors));

      const successor = {
        ...structuredClone(style),
        sources: { successor: { ...style.sources.city, tiles: [`${renderUrl}/parcel-batches/successor/{z}/{x}/{y}.pbf`] } },
      };
      successor.layers[0].source = 'successor';
      await page.evaluate(({ oldColors, newColors }) => {
        const { tileset } = window.renderValidation;
        const control: ParcelHandoff = window.parcelHandoff = {
          holding: true,
          held: [],
          recording: true,
          phase: 'network-hold',
          frames: [],
          oldColors,
          newColors,
          exhaustPaint: false,
          budgetSkipped: 0,
          newVisible: false,
        };
        const renderer = tileset._vectorRenderer;
        const update = renderer.updatePaint;
        renderer.updatePaint = function (frame) {
          if (control.exhaustPaint)
            control.budgetSkipped++;
          return Reflect.apply(update, this, [control.exhaustPaint ? { ...frame, budget: { exhausted: true } } : frame]);
        };
        control.restore = () => {
          renderer.updatePaint = update;
          control.recording = false;
          control.holding = false;
          control.held.splice(0).forEach(deliver => deliver());
        };
        control.native = () => [...tileset._vectorRenderer._records.entries()]
          .filter(([tileId]) => tileId.startsWith('successor/'))
          .flatMap(([tileId, record]) => [...new Set(record.standard?.polygons.map(entry => entry.primitive) ?? [])].map(primitive => ({
            tileId,
            features: record.standard.polygons.length,
            instances: primitive._numberOfInstances,
            state: primitive._state,
            combining: primitive._state === (window.renderValidation.atlas.cesium as unknown as { PrimitiveState: { COMBINING: number } }).PrimitiveState.COMBINING,
            ready: primitive.ready,
            arrays: primitive._va.length,
          })));
      }, { oldColors: rgb(restoredColors), newColors: rgb(repaintColors) });
      await page.evaluate(style => window.renderValidation.tileset.setStyle(style), successor);
      await expect.poll(() => heldRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
      await capture('pending-source-handoff', rgb(restoredColors));
      await page.evaluate(() => {
        window.parcelHandoff.phase = 'native-hold';
      });
      for (const resolve of heldRequests.splice(0)) resolve();
      await expect.poll(() => page.evaluate(() => window.parcelHandoff.held.length), { timeout: 60_000 }).toBe(1);
      report.heldNative = await page.evaluate(() => ({ heldResults: window.parcelHandoff.held.length, primitives: window.parcelHandoff.native() }));
      assert.equal(report.heldNative.primitives.length, 1, 'the successor did not combine its 1024 instances in one Native task');
      assert.deepEqual(report.heldNative.primitives[0], {
        tileId: report.heldNative.primitives[0].tileId,
        features: 1024,
        instances: 1024,
        state: 3,
        combining: true,
        ready: false,
        arrays: 0,
      });
      await capture('held-native-combine', rgb(restoredColors));
      await page.evaluate(async (states) => {
        const { viewer, tileset } = window.renderValidation;
        const control = window.parcelHandoff;
        control.phase = 'native-hold-current-paint';
        control.exhaustPaint = true;
        for (const { featureIndex, state } of states)
          tileset._style.setFeatureState({ source: 'successor', sourceLayer: 'parcels', id: featureIndex + 1 }, state);
        viewer.scene.requestRender();
        const frames = control.frames.length;
        // Keep the actual combine result held for multiple real draws while
        // the regular paint continuation receives an exhausted frame budget.
        while (control.frames.length < frames + 5) {
          viewer.scene.requestRender();
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      }, colorStates(repaintColors));
      await capture('held-native-current-paint', rgb(restoredColors));
      report.heldNative.currentPaint = await page.evaluate(() => ({ budgetSkipped: window.parcelHandoff.budgetSkipped, frames: window.parcelHandoff.frames.length, primitives: window.parcelHandoff.native() }));
      assert.ok(report.heldNative.currentPaint.budgetSkipped > 0, 'the actual paint update never received an exhausted budget');
      assert.ok(report.heldNative.currentPaint.primitives.every(primitive => primitive.combining && !primitive.ready && primitive.arrays === 0));
      await page.evaluate(() => {
        const control = window.parcelHandoff;
        control.phase = 'native-upload';
        control.holding = false;
        control.held.splice(0).forEach(deliver => deliver());
        window.renderValidation.viewer.scene.requestRender();
      });
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded
        && window.parcelHandoff.newVisible
        && window.parcelHandoff.native().length === 1
        && window.parcelHandoff.native().every(primitive => primitive.ready)), { timeout: 60_000 }).toBe(true);
      await capture('completed-source-handoff', rgb(repaintColors), 'successor');
      const final = await page.evaluate(() => {
        const { viewer, tileset, renderErrors } = window.renderValidation;
        const primitives = [...new Set([...tileset._vectorRenderer._records.values()].flatMap(record => record.standard.polygons.map(entry => entry.primitive)))];
        const result = {
          originalDestroyed: window.parcelOriginal.every(({ primitive }) => primitive.isDestroyed()),
          hiddenStyleTiles: tileset._tileResidency.hiddenStyleTiles.size,
          fps: viewer.scene.debugShowFramesPerSecond,
          renderErrors: [...renderErrors],
          inputs: window.parcelCombineInputs,
          handoffFrames: [...window.parcelHandoff.frames],
          budgetSkipped: window.parcelHandoff.budgetSkipped,
          newVisible: window.parcelHandoff.newVisible,
          budgetReleased: !window.parcelHandoff.exhaustPaint,
        };
        window.parcelHandoff.restore();
        window.stopParcelPixels();
        viewer.scene.primitives.remove(tileset);
        const destroyed = primitives.every(primitive => primitive.isDestroyed());
        return { ...result, destroyed };
      });
      report.final = final;
      assert.ok(final.originalDestroyed && final.destroyed && final.fps);
      assert.equal(final.hiddenStyleTiles, 0);
      assert.equal(final.inputs.length, 2, 'paint or retired restoration repeated Native combine');
      assert.ok(final.inputs.every(input => input.instances === 1024 && input.serializedBytes <= 512 * 1024));
      assert.ok(final.budgetSkipped > 0 && final.newVisible && final.budgetReleased);
      assert.ok(final.handoffFrames.some(frame => frame.phase === 'network-hold'));
      assert.ok(final.handoffFrames.some(frame => frame.phase === 'native-hold'));
      assert.ok(final.handoffFrames.some(frame => frame.phase === 'native-hold-current-paint' && frame.budgetExhausted));
      assert.ok(final.handoffFrames.some(frame => frame.phase === 'native-upload' && frame.paint === 'new' && frame.budgetExhausted), 'current paint was not visible during the exhausted first-upload window');
      assert.ok(final.handoffFrames.every(frame => frame.paint === 'old' || frame.paint === 'new'), 'Native source handoff drew blank, stale or mixed parcel colors');
      assert.ok(final.handoffFrames.filter(frame => frame.phase !== 'native-upload').every(frame => frame.paint === 'old'), 'successor paint escaped the pending source handoff');
      assert.deepEqual(final.renderErrors, []);
      assert.deepEqual(errors, []);
    }
    catch (error) {
      report.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
      throw error;
    }
    finally {
      // Preserve phases and every observed handoff frame even when a strict
      // pixel, Native identity or pick assertion fails before normal teardown.
      try {
        report.lastBrowserState = await page.evaluate(() => {
          const validation = window.renderValidation;
          const control = window.parcelHandoff;
          const result: Record<string, unknown> & { inputs: ParcelCombineInput[]; phase?: string; heldResults?: number; handoffFrames?: ParcelFrame[]; budgetSkipped?: number; newVisible?: boolean; renderErrors?: string[]; fps?: boolean } = {
            inputs: window.parcelCombineInputs,
            phase: control?.phase,
            heldResults: control?.held.length,
            handoffFrames: control?.frames,
            budgetSkipped: control?.budgetSkipped,
            newVisible: control?.newVisible,
            renderErrors: validation?.renderErrors,
            fps: validation?.viewer.scene.debugShowFramesPerSecond,
          };
          if (validation && !validation.tileset.isDestroyed()) {
            result.pendingNative = control?.native();
            for (const source of ['city', 'successor']) {
              try {
                result[source] = window.parcelSnapshot?.(source);
              }
              catch (error) {
                result[`${source}SnapshotError`] = error instanceof Error ? error.message : String(error);
              }
            }
          }
          control?.restore();
          window.stopParcelPixels?.();
          if (validation && !validation.tileset.isDestroyed())
            validation.viewer.scene.primitives.remove(validation.tileset);
          return result;
        });
      }
      catch (error) {
        report.artifactCollectionError = error instanceof Error ? error.message : String(error);
      }
      for (const resolve of heldRequests.splice(0)) resolve();
      const output = testInfo.outputPath('standard-polygon-batching.json');
      await writeFile(output, JSON.stringify(report, null, 2));
      await testInfo.attach('standard-polygon-batching', { path: output, contentType: 'application/json' });
    }
  });
}
