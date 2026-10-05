import type { LineLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PrimitiveCollection } from 'cesium';
import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface TileClipProbe {
  ratio: number;
  center: { x: number; y: number };
  start: { x: number; y: number };
  end: { x: number; y: number };
  length: number;
  samples: Array<{
    label: string;
    painted: boolean;
    x: number;
    y: number;
    expectedOwner: string;
    rgb: number[];
    feature: ReturnType<typeof window.renderValidation.tileset.pick>;
  }>;
}
declare global {
  interface Window {
    stopTileClipPixels: () => void;
    tileClipPixels: Uint8Array;
    tileClipProbe: (pick?: boolean) => TileClipProbe;
  }
}

const zoom = 14;
const extent = 4096;
const width = 24;
const background = [34, 68, 85];
// Half-opacity red over #224455, also used by round-line-caps.spec.ts.
const singleBlend = [145, 34, 43];
const scenarios = [
  { name: 'horizontal shared edge', center: [8186.5, 5449], direction: [1, 0], geometries: [0, extent].map(y => [[1024, y], [3072, y]]) },
  { name: 'vertical shared edge', center: [8187, 5448.5], direction: [0, 1], geometries: [0, extent].map(x => [[x, 1024], [x, 3072]]) },
  { name: 'date line shared edge', dateLine: true, center: [2 ** zoom, 5448.5], direction: [0, 1], geometries: [0, extent].map(x => [[x, 1024], [x, 3072]]) },
  { name: 'western date line shared edge', dateLine: true, center: [0, 5448.5], direction: [0, 1], geometries: [0, extent].map(x => [[x, 1024], [x, 3072]]) },
  { name: 'date line buffered outside centerline', dateLine: true, center: [2 ** zoom - 8 / extent, 5448.5], direction: [0, 1], geometries: [-8, extent - 8].map(x => [[x, 1024], [x, 3072]]) },
  { name: 'horizontal buffered outside centerline', center: [8186.5, 5449 - 8 / extent], direction: [1, 0], geometries: [-8, extent - 8].map(y => [[1024, y], [3072, y]]) },
  { name: 'vertical buffered outside centerline', center: [8187 - 8 / extent, 5448.5], direction: [0, 1], geometries: [-8, extent - 8].map(x => [[x, 1024], [x, 3072]]) },
  {
    name: 'diagonal shared four corners',
    center: [8187, 5449],
    direction: [1, 1],
    corners: true,
    geometries: [0, extent].flatMap(x => [0, extent].map(y => [[x - 1024, y - 1024], [x + 1024, y + 1024]])),
  },
];

function geographic([x, y]: number[]) {
  return [x / 2 ** zoom * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI];
}

async function serveTiles(page: Page, renderUrl: string, kind: string, scenario: typeof scenarios[number]) {
  const requestedTiles = new Set<string>();
  const style: StyleSpecification = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/line-tile-clip/{z}/{x}/{y}.pbf`], minzoom: zoom, maxzoom: zoom } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } },
      {
        'id': 'roads',
        'type': 'line',
        'source': 'city',
        'source-layer': 'roads',
        'layout': { 'line-join': 'miter', 'line-cap': 'butt' },
        // Exercise the dash shader with a continuous painted interval so dash
        // phase cannot obscure a tile seam or supply a different pixel oracle.
        'paint': { 'line-color': '#ff0000', 'line-width': width, 'line-opacity': 0.5, ...(kind === 'dash' ? { 'line-dasharray': [100000, 1] } : {}) },
      },
    ],
  };
  if (kind === 'family') {
    const underlay = structuredClone(style.layers[1] as LineLayerSpecification);
    underlay.id = 'underlay';
    underlay.paint = { 'line-color': '#224455', 'line-width': 36 };
    style.layers.splice(1, 0, underlay);
  }
  await page.route('**/line-tile-clip/**', (route) => {
    const match = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!match)
      return route.fulfill({ json: style });
    const owner = match.slice(1).join('/');
    requestedTiles.add(owner);
    const tile = Buffer.from(fromGeojsonVt({
      ground: { features: [{ type: 3, geometry: [[[0, 0], [extent, 0], [extent, extent], [0, extent], [0, 0]]], tags: { owner } }] },
      roads: { features: scenario.geometries.map(geometry => ({ type: 2, geometry: [geometry], tags: { owner, road: scenario.name } })) },
    }, { version: 2, extent }));
    return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
  });
  return requestedTiles;
}

async function installProbe(page: Page, scenario: typeof scenarios[number], mode: string, lineHeight: number) {
  await page.evaluate(({ scenario, mode, zoom, extent, width, lineHeight }) => {
    const validation = window.renderValidation;
    const { viewer, tileset } = validation;
    const { canvas, scene } = viewer;
    if (mode !== '2d')
      validation.setObliqueView();
    window.stopTileClipPixels = scene.postRender.addEventListener(() => {
      if (tileset.tilesLoaded && scene.globe.tilesLoaded)
        window.tileClipPixels = scene.context.readPixels({ width: canvas.width, height: canvas.height });
    });
    const ratio = canvas.width / canvas.clientWidth;
    const project = ([x, y]: number[]) => {
      const longitude = x / 2 ** zoom * 360 - 180;
      const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI;
      const point = validation.projectPosition(longitude, latitude, lineHeight);
      return point && { x: point.x * ratio, y: point.y * ratio };
    };
    const visible = point => point && point.x > width && point.x < canvas.width - width && point.y > width && point.y < canvas.height - width;
    window.tileClipProbe = (pick = false) => {
      if (!window.tileClipPixels)
        return undefined;
      const center = project(scenario.center);
      const start = project(scenario.center.map((value, index) => value - scenario.direction[index] / 16));
      const end = project(scenario.center.map((value, index) => value + scenario.direction[index] / 16));
      if (![center, start, end].every(visible))
        return undefined;
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const tangent = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
      const normal = { x: -tangent.y, y: tangent.x };
      // Invert the local projected tile axes to determine the source tile
      // owning each exact framebuffer pixel. Samples stay several pixels away
      // from the seam, so the tiny geographic curvature cannot change owners.
      const east = project([scenario.center[0] + 1 / extent, scenario.center[1]]);
      const south = project([scenario.center[0], scenario.center[1] + 1 / extent]);
      const axisX = { x: (east.x - center.x) * extent, y: (east.y - center.y) * extent };
      const axisY = { x: (south.x - center.x) * extent, y: (south.y - center.y) * extent };
      const determinant = axisX.x * axisY.y - axisX.y * axisY.x;
      const sample = (point, painted, label) => {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const rawTileX = Math.floor(scenario.center[0] + (dx * axisY.y - dy * axisY.x) / determinant);
        const dimension = 2 ** zoom;
        const tileX = ((rawTileX % dimension) + dimension) % dimension;
        const tileY = Math.floor(scenario.center[1] + (dy * axisX.x - dx * axisX.y) / determinant);
        const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
        const position = { x: (x + 0.5) / ratio, y: (y + 0.5) / ratio };
        const picked = pick && scene.pick(position, 1, 1);
        const id = picked && (picked.id ?? picked);
        return {
          label,
          painted,
          x,
          y,
          expectedOwner: `${zoom}/${tileX}/${tileY}`,
          rgb: Array.from(window.tileClipPixels.slice(offset, offset + 3)),
          feature: id ? tileset.pick(id) : undefined,
        };
      };
      const offset = (point, along, across) => ({ x: point.x + tangent.x * along + normal.x * across, y: point.y + tangent.y * along + normal.y * across });
      const samples = [];
      if (scenario.corners) {
        // NW/NE/SW/SE tiles all buffer this same diagonal at their respective
        // corner. These four interior pixels exercise all four clip owners.
        for (const [along, across] of [[-width / 4, 0], [width / 4, 0], [0, -width / 4], [0, width / 4]])
          samples.push(sample(offset(center, along * ratio, across * ratio), true, `corner ${along}/${across}`));
      }
      else {
        for (const progress of [0.2, 0.5, 0.8]) {
          // Project each geographic center independently in 3D rather than
          // assuming its curved world path is a straight screen-space strip.
          const point = project(scenario.center.map((value, index) => value + scenario.direction[index] * (progress - 0.5) / 8));
          for (const side of [-1, 1])
            samples.push(sample(offset(point, 0, side * width * ratio / 4), true, `${progress}/${side}`));
        }
      }
      for (const side of [-1, 1])
        samples.push(sample(offset(center, 0, side * width * ratio), false, `background/${side}`));
      return { ratio, center, start, end, length, samples };
    };
    scene.requestRender();
  }, { scenario, mode, zoom, extent, width, lineHeight });
}

test.describe(() => {
  test.use({ deviceScaleFactor: 1 });
  for (const mode of ['2d', '3d', 'cv']) {
    for (const kind of mode === '3d' ? ['solid', 'dash'] : ['solid', 'dash', 'family']) {
      for (const scenario of scenarios) {
        if (kind === 'family' && scenario !== scenarios[0] && !scenario.dateLine)
          continue;
        // Native CV ends at +/-pi. Its two map ends are not neighboring
        // viewports; the date-line pair belongs to 2D and the 3D globe.
        if (mode === 'cv' && scenario.dateLine)
          continue;
        test(`${kind} ${scenario.name} blends once and picks its tile in ${mode}`, async ({ page, renderUrl }, testInfo) => {
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const requestedTiles = await serveTiles(page, renderUrl, kind, scenario);
          const cameraCenter = geographic(scenario.center);
          // Keep both Native 2D viewports while avoiding SceneTransforms'
          // ambiguous projection when the camera is exactly on longitude pi.
          if (mode === '2d' && scenario.dateLine)
            cameraCenter[0] += scenario.center[0] === 0 ? 0.001 : -0.001;
          const query = new URLSearchParams({ mode, scale: '0.25', center: cameraCenter.join(','), style: `${renderUrl}/line-tile-clip/style.json` });
          await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
          await expect.poll(() => page.evaluate(() => {
            const validation = window.renderValidation;
            return validation?.tileset.tilesLoaded && validation.tileset.stats().renderableTiles > 0 && validation.viewer.scene.globe.tilesLoaded;
          }), { timeout: 60_000 }).toBe(true);
          await installProbe(page, scenario, mode, kind === 'family' ? 1.02 : 1.01);
          // Readiness depends on completed rendering and projection, never on
          // pixels matching the expected result: missing halves must fail.
          await expect.poll(() => page.evaluate(() => window.tileClipProbe()), { timeout: 60_000 }).toBeTruthy();
          const probe = await page.evaluate(() => window.tileClipProbe(true));
          const state = await page.evaluate(() => ({
            fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
            globe: window.renderValidation.viewer.scene.globe.show,
            msaaSamples: window.renderValidation.viewer.scene.msaaSamples,
            renderErrors: window.renderValidation.renderErrors,
            sharedFamilies: window.renderValidation.tileset._vectorRenderer.tileIds.flatMap(tileId => window.renderValidation.tileset._vectorRenderer.getTileCollections(tileId)
              .flatMap(collection => Array.from({ length: (collection as PrimitiveCollection).length ?? 0 }, (_, index) => (collection as PrimitiveCollection).get(index))))
              .filter(entry => entry._layers?.length === 2)
              .length,
          }));
          const output = testInfo.outputPath('line-tile-clip.json');
          await writeFile(output, JSON.stringify({ mode, kind, scenario, requestedTiles: [...requestedTiles], probe, state }, null, 2));
          await testInfo.attach('line-tile-clip', { path: output, contentType: 'application/json' });
          assert.deepEqual(errors, []);
          assert.deepEqual(state.renderErrors, []);
          assert.ok(state.fps && state.globe, 'FPS and Globe must remain enabled');
          assert.equal(state.msaaSamples, 4);
          assert.equal(probe.ratio, 1);
          if (kind === 'family')
            assert.ok(state.sharedFamilies > 0, 'two layers must replay one Native Primitive');
          const owners = new Set(probe.samples.filter(sample => sample.painted).map(sample => sample.expectedOwner));
          assert.equal(owners.size, scenario.corners ? 4 : 2, 'interior probes must cover every neighboring tile');
          for (const owner of owners)
            assert.ok(requestedTiles.has(owner), `neighbor ${owner} must have supplied a real MVT`);
          for (const sample of probe.samples) {
            const expected = sample.painted ? singleBlend : background;
            assert.ok(sample.rgb.every((channel, index) => Math.abs(channel - expected[index]) <= 3), `${mode}/${kind}/${scenario.name}/${sample.label}: pixel ${sample.x}/${sample.y} must ${sample.painted ? 'blend once' : 'stay background'}: ${sample.rgb} vs ${expected}`);
            assert.equal(sample.feature?.layerId, sample.painted ? 'roads' : 'ground', `${sample.label}: render and pick coverage must agree`);
            assert.equal(sample.feature?.properties.owner, sample.expectedOwner, `${sample.label}: pick escaped its source tile`);
            if (sample.painted)
              assert.equal(sample.feature.properties.road, scenario.name);
          }
          await page.evaluate(() => window.stopTileClipPixels());
        });
      }
    }
  }
});
