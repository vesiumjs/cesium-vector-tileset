import type { Page } from 'playwright/test';
import type { OverscaledTileID } from '../packages/cesium-vector-tileset/src/tile/tile-id';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface GlobalLineDraw {
  tileId: string;
  kind: string;
  canonical?: { z: number; x: number; y: number };
  overscaledZ?: number;
  wrap?: number;
}
interface GlobalLineSnapshot {
  pixels: Uint8Array;
  draws: GlobalLineDraw[];
  tiles: Array<Omit<GlobalLineDraw, 'kind'>>;
  cameraHeight: number;
  cameraLongitude: number;
  cameraLatitude: number;
}
interface GlobalLineProbe {
  ratio: number;
  center: { x: number; y: number };
  draws: GlobalLineDraw[];
  tiles: GlobalLineSnapshot['tiles'];
  cameraHeight: number;
  cameraLongitude: number;
  cameraLatitude: number;
  canvasWidth: number;
  canvasHeight: number;
  samples: Array<{
    along: number;
    across: number;
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
    stopGlobalLinePixels: () => void;
    globalLineSnapshot: GlobalLineSnapshot;
    globalLineProbe: (pick?: boolean) => GlobalLineProbe;
  }
}

const extent = 4096;
const width = 24;
const background = [34, 68, 85];
const singleBlend = [145, 34, 43];
const meridianLatitude = Math.atan(Math.sinh(Math.PI / 4)) * 180 / Math.PI;
interface GlobalLineScenario {
  name: string;
  zoom: number;
  meridian?: boolean;
  geometry?: number[][];
  height?: number;
  views: Array<{ longitude: number; latitude: number; heading: number; pitch: number; painted?: boolean }>;
}

const cases: GlobalLineScenario[] = [
  ...[0, 180, -180].map(longitude => ({
    name: `z1 meridian ${longitude}`,
    zoom: 1,
    meridian: true,
    views: [{ longitude, latitude: meridianLatitude, heading: 37, pitch: -48 }],
  })),
  {
    name: 'z1 equator follows rotated low camera across longitude',
    zoom: 1,
    views: [
      { longitude: -135, latitude: 0, heading: 29, pitch: -38 },
      { longitude: -45, latitude: 0, heading: 123, pitch: -52 },
    ],
  },
  { name: 'z0 single owner preserves both stroke sides', zoom: 0, meridian: true, views: [{ longitude: 0, latitude: 0, heading: 61, pitch: -43 }] },
];

function tileGeometry(scenario, x, y) {
  if (scenario.geometry)
    return [scenario.geometry];
  if (scenario.zoom === 0)
    return [[[2048, 2047], [2048, 2048], [2048, 2049]]];
  if (scenario.meridian) {
    if (y !== 0)
      return [];
    const dateline = scenario.views[0].longitude !== 0;
    const edge = (x === 0) === dateline ? 0 : extent;
    return [[[edge, 3071], [edge, 3072], [edge, 3073]]];
  }
  const edge = y === 0 ? extent : 0;
  return [1024, 3072].map(center => [[center - 1, edge], [center, edge], [center + 1, edge]]);
}

async function serveTiles(page: Page, renderUrl: string, scenario: typeof cases[number]) {
  const requestedTiles = new Set<string>();
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/line-global/{z}/{x}/{y}.pbf`], minzoom: scenario.zoom, maxzoom: scenario.zoom } },
    layers: [{
      'id': 'roads',
      'type': 'line',
      'source': 'city',
      'source-layer': 'roads',
      'layout': { 'line-join': 'miter', 'line-cap': 'butt' },
      'paint': { 'line-color': '#ff0000', 'line-width': width, 'line-opacity': 0.5 },
    }],
  };
  await page.route('**/line-global/**', (route) => {
    const match = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!match)
      return route.fulfill({ json: style });
    const owner = match.slice(1).join('/');
    requestedTiles.add(owner);
    if (scenario.geometry && owner !== '0/0/0')
      return route.fulfill({ status: 422, body: 'Buffered source requires canonical z0/0/0' });
    const [, x, y] = match.slice(1).map(Number);
    const tile = Buffer.from(fromGeojsonVt({ roads: { features: tileGeometry(scenario, x, y).map(geometry => ({
      type: 2,
      geometry: [geometry],
      tags: { owner, road: scenario.name },
    })) } }, { version: 2, extent }));
    return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
  });
  return requestedTiles;
}

async function installLowZoomTileset(page: Page, styleUrl: string) {
  await page.evaluate(async (styleUrl) => {
    const moduleUrl = new URL('../../packages/cesium-vector-tileset/index.ts', location.href).href;
    const { CesiumVectorTileset } = await import(moduleUrl) as typeof import('../packages/cesium-vector-tileset');
    const validation = window.renderValidation;
    const { viewer } = validation;
    const { Color, PrimitiveCollection } = validation.atlas.cesium;
    viewer.scene.primitives.remove(validation.tileset);
    const tileset = await CesiumVectorTileset.fromUrl(styleUrl, {
      zoomLevelsToOverscale: 0,
    });
    validation.tileset = tileset as unknown as typeof validation.tileset;
    viewer.scene.globe.baseColor = Color.fromCssColorString('#224455');
    viewer.scene.primitives.add(tileset);
    const scene = viewer.scene;
    let draws: GlobalLineDraw[] = [];
    scene.preRender.addEventListener(() => {
      draws = [];
    });
    const draw = scene.context.draw;
    scene.context.draw = function (command, ...args) {
      const batch = validation.drawBatch(command) ?? validation.drawBatch(command.owner);
      if (batch?.layerId === 'roads' && scene._frameState.passes.render) {
        // Resolve the actual command's tile record. Its TileID proves that the
        // primitive used z0/z1 bounds, not merely a low-zoom URL overzoomed by
        // the default fixture tileset at this very low camera height.
        const tileID = validation.tileset._vectorRenderer._records.get(batch.tileId)?.tileID as OverscaledTileID;
        draws.push({
          tileId: batch.tileId,
          kind: batch.kind,
          canonical: tileID && { z: tileID.canonical.z, x: tileID.canonical.x, y: tileID.canonical.y },
          overscaledZ: tileID?.overscaledZ,
          wrap: tileID?.wrap,
        });
      }
      return draw.call(this, command, ...args);
    };
    window.stopGlobalLinePixels = scene.postRender.addEventListener(() => {
      const records = [...validation.tileset._vectorRenderer._records];
      // Empty views must still yield a completed framebuffer. A correct
      // Greenwich frame need not contain any road draw command.
      const ready = records.length > 0 && records.every(([, record]) => record.complete
        && [...record.collections.values()].every(collection => !(collection instanceof PrimitiveCollection)
          || Array.from({ length: collection.length }, (_, index) => collection.get(index) as { ready: boolean }).every(primitive => primitive.ready)));
      if (tileset.tilesLoaded && scene.globe.tilesLoaded && ready) {
        window.globalLineSnapshot = {
          pixels: scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height }),
          draws: [...draws],
          tiles: records.map(([tileId, record]) => {
            const tileID = record.tileID as OverscaledTileID;
            return { tileId, canonical: { z: tileID.canonical.z, x: tileID.canonical.x, y: tileID.canonical.y }, overscaledZ: tileID.overscaledZ, wrap: tileID.wrap };
          }),
          cameraHeight: viewer.camera.positionCartographic.height,
          cameraLongitude: viewer.camera.positionCartographic.longitude * 180 / Math.PI,
          cameraLatitude: viewer.camera.positionCartographic.latitude * 180 / Math.PI,
        };
      }
    });
  }, styleUrl);
}

async function setLowView(page: Page, view: typeof cases[number]['views'][number], scenario: typeof cases[number]) {
  await page.evaluate(({ view, scenario, width }) => {
    const validation = window.renderValidation;
    const { viewer, tileset } = validation;
    const { Cartesian3, HeadingPitchRange, Matrix4 } = validation.atlas.cesium;
    const pitch = view.pitch * Math.PI / 180;
    // The first style layer has the standard 1m lift. Aim at its exact middle
    // MVT vertex: adjacent coarse z1 vertices are kilometers apart, so a long
    // endpoint-to-endpoint ECEF chord would otherwise disappear underground.
    if (scenario.height === undefined) {
      viewer.camera.lookAt(Cartesian3.fromDegrees(view.longitude, view.latitude, 1), new HeadingPitchRange(view.heading * Math.PI / 180, pitch, 14 / Math.sin(-pitch)));
      viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    }
    else {
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(view.longitude, view.latitude, scenario.height),
        orientation: { heading: view.heading * Math.PI / 180, pitch, roll: 0 },
      });
    }
    window.globalLineSnapshot = undefined;
    const { canvas, scene } = viewer;
    const ratio = canvas.width / canvas.clientWidth;
    const project = (longitude, latitude) => {
      const point = validation.projectPosition(longitude, latitude, 1);
      return point && { x: point.x * ratio, y: point.y * ratio };
    };
    window.globalLineProbe = (pick = false) => {
      const snapshot = window.globalLineSnapshot;
      if (!snapshot)
        return undefined;
      const center = project(view.longitude, view.latitude);
      if (!center || center.x < width * 2 || center.x > canvas.width - width * 2 || center.y < width * 2 || center.y > canvas.height - width * 2)
        return undefined;
      const delta = 0.000001;
      const east = project(view.longitude + delta, view.latitude);
      const north = project(view.longitude, view.latitude + delta);
      const axisX = { x: (east.x - center.x) / delta, y: (east.y - center.y) / delta };
      const axisY = { x: (north.x - center.x) / delta, y: (north.y - center.y) / delta };
      const axis = scenario.meridian ? axisY : axisX;
      const length = Math.hypot(axis.x, axis.y);
      const tangent = { x: axis.x / length, y: axis.y / length };
      const normal = { x: -tangent.y, y: tangent.x };
      const determinant = axisX.x * axisY.y - axisX.y * axisY.x;
      const dimension = 2 ** scenario.zoom;
      const sample = (along, across, painted) => {
        const x = Math.floor(center.x + (tangent.x * along + normal.x * across) * ratio);
        const y = Math.floor(center.y + (tangent.y * along + normal.y * across) * ratio);
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const longitude = view.longitude + (dx * axisY.y - dy * axisY.x) / determinant;
        const latitude = view.latitude + (dy * axisX.x - dx * axisX.y) / determinant;
        const tileX = ((Math.floor((longitude + 180) / 360 * dimension) % dimension) + dimension) % dimension;
        const tileY = Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * dimension);
        const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
        const picked = pick && scene.pick({ x: (x + 0.5) / ratio, y: (y + 0.5) / ratio }, 1, 1);
        const id = picked && (picked.id ?? picked);
        return {
          along,
          across,
          painted,
          x,
          y,
          expectedOwner: `${scenario.zoom}/${tileX}/${tileY}`,
          rgb: Array.from(snapshot.pixels.slice(offset, offset + 3)),
          feature: id?.layerId === 'roads' ? tileset.pick(id) : undefined,
        };
      };
      return {
        ratio,
        center,
        draws: snapshot.draws,
        tiles: snapshot.tiles,
        cameraHeight: snapshot.cameraHeight,
        cameraLongitude: snapshot.cameraLongitude,
        cameraLatitude: snapshot.cameraLatitude,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        samples: (scenario.geometry ? [sample(0, 0, view.painted !== false)] : [])
          .concat([-4, 4].flatMap(along => [-6, 6].map(across => sample(along, across, view.painted !== false))))
          .concat([-width, width].map(across => sample(0, across, false))),
      };
    };
    scene.requestRender();
  }, { view, scenario, width });
}

test.describe(() => {
  test.use({ deviceScaleFactor: 1 });
  for (const scenario of cases) {
    test(`${scenario.name} clips canonical 3D tiles at 15m`, async ({ page, renderUrl }, testInfo) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const requestedTiles = await serveTiles(page, renderUrl, scenario);
      const styleUrl = `${renderUrl}/line-global/style.json`;
      const first = scenario.views[0];
      const query = new URLSearchParams({ mode: '3d', atlas: '1', center: `${first.longitude},${first.latitude}`, style: styleUrl });
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => Boolean(window.renderValidation?.atlas?.cesium))).toBe(true);
      await installLowZoomTileset(page, styleUrl);
      const measurements: Array<{ view: GlobalLineScenario['views'][number] } & GlobalLineProbe> = [];
      for (const view of scenario.views) {
        await setLowView(page, view, scenario);
        // Readiness requires a completed native draw and projection; it does
        // not wait for any pixel to match the expected color.
        await expect.poll(() => page.evaluate(() => window.globalLineProbe()), { timeout: 60_000 }).toBeTruthy();
        measurements.push({ view, ...await page.evaluate(() => window.globalLineProbe(true)) });
      }
      const state = await page.evaluate(() => ({
        fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
        globe: window.renderValidation.viewer.scene.globe.show,
        msaaSamples: window.renderValidation.viewer.scene.msaaSamples,
        renderErrors: window.renderValidation.renderErrors,
      }));
      const output = testInfo.outputPath('line-tile-clip-global.json');
      await writeFile(output, JSON.stringify({ scenario, requestedTiles: [...requestedTiles], measurements, state }, null, 2));
      await testInfo.attach('line-tile-clip-global', { path: output, contentType: 'application/json' });
      assert.deepEqual(errors, []);
      assert.deepEqual(state.renderErrors, []);
      assert.ok(state.fps && state.globe, 'FPS and Globe must remain enabled');
      assert.equal(state.msaaSamples, 4);
      for (const measurement of measurements) {
        assert.equal(measurement.ratio, 1);
        assert.ok(Math.abs(measurement.cameraHeight - 15) < 0.01, `camera must actually be 15m high: ${measurement.cameraHeight}`);
        const owners = new Set(measurement.samples.filter(sample => sample.painted).map(sample => sample.expectedOwner));
        assert.equal(owners.size, scenario.zoom === 0 ? 1 : 2, 'probes must cover each canonical stroke owner');
        const drawnOwners = new Set();
        for (const draw of measurement.draws) {
          assert.equal(draw.canonical?.z, scenario.zoom, `actual draw ${draw.tileId} must use the low canonical zoom`);
          assert.equal(draw.overscaledZ, scenario.zoom, `actual draw ${draw.tileId} must not overzoom`);
          drawnOwners.add(`${draw.canonical.z}/${draw.canonical.x}/${draw.canonical.y}`);
        }
        for (const owner of owners) {
          assert.ok(requestedTiles.has(owner), `${owner} must supply a real MVT`);
          assert.ok(drawnOwners.has(owner), `${owner} must participate in the real native draw`);
        }
        for (const sample of measurement.samples) {
          const expected = sample.painted ? singleBlend : background;
          assert.ok(sample.rgb.every((channel, index) => Math.abs(channel - expected[index]) <= 3), `${scenario.name}/${measurement.view.longitude}/${sample.along}/${sample.across}: ${sample.rgb} vs ${expected}`);
          if (sample.painted) {
            assert.equal(sample.feature?.layerId, 'roads', 'painted stroke must pick the road');
            assert.equal(sample.feature.properties.owner, sample.expectedOwner, 'pick must retain its canonical tile owner');
            assert.equal(sample.feature.properties.road, scenario.name);
          }
          else {
            assert.equal(sample.feature, undefined, 'discarded line fragments must not intercept the Globe pick');
          }
        }
      }
      await page.evaluate(() => window.stopGlobalLinePixels());
    });
  }

  for (const mode of ['2d', 'cv', '3d']) {
    test(`z0 buffered source branches paint their map ends without Greenwich ghosts in ${mode}`, async ({ page, renderUrl }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const results: Array<{
        scenario: GlobalLineScenario;
        requestedTiles: string[];
        measurements: Array<{ view: GlobalLineScenario['views'][number] } & GlobalLineProbe>;
        state: { fps: boolean; globe: boolean; msaaSamples: number; renderErrors: string[] };
      }> = [];
      for (const side of [-1, 1]) {
        const edge = side < 0 ? 0 : extent;
        const scenario: GlobalLineScenario = {
          name: side < 0 ? 'west-buffer' : 'east-buffer',
          zoom: 0,
          geometry: [[edge - 1, extent / 2], [edge + 1, extent / 2]],
          height: 1500,
          // CV has separate map ends. Probe each inside its own endpoint;
          // Native 2D's repeated viewport is not required for this control.
          views: [
            { longitude: 0, latitude: 0, heading: 0, pitch: -90, painted: false },
            { longitude: side * 179.99, latitude: 0, heading: 0, pitch: -90, painted: true },
          ],
        };
        await page.unroute('**/line-global/**');
        const requestedTiles = await serveTiles(page, renderUrl, scenario);
        const styleUrl = `${renderUrl}/line-global/style.json`;
        const query = new URLSearchParams({ mode, atlas: '1', center: '0,0', style: styleUrl });
        // Separate documents keep the ECEF-overlapping western and eastern
        // inputs independent, including their opacity and public pick oracle.
        await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
        await expect.poll(() => page.evaluate(() => Boolean(window.renderValidation?.atlas?.cesium))).toBe(true);
        await installLowZoomTileset(page, styleUrl);
        const measurements: typeof results[number]['measurements'] = [];
        for (const view of scenario.views) {
          await setLowView(page, view, scenario);
          await expect.poll(() => page.evaluate(() => {
            window.renderValidation.viewer.scene.requestRender();
            return Boolean(window.globalLineProbe());
          }), { timeout: 60_000 }).toBe(true);
          measurements.push({ view, ...await page.evaluate(() => window.globalLineProbe(true)) });
        }
        const state = await page.evaluate(() => ({
          fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
          globe: window.renderValidation.viewer.scene.globe.show,
          msaaSamples: window.renderValidation.viewer.scene.msaaSamples,
          renderErrors: window.renderValidation.renderErrors,
        }));
        results.push({ scenario, requestedTiles: [...requestedTiles], measurements, state });
        await page.evaluate(() => window.stopGlobalLinePixels());
      }
      const output = testInfo.outputPath('line-tile-clip-global.json');
      await writeFile(output, JSON.stringify({ mode, extent, errors, results }, null, 2));
      await testInfo.attach('line-tile-clip-global', { path: output, contentType: 'application/json' });
      assert.deepEqual(errors, []);
      assert.equal(results.length, 2);
      for (const { scenario, requestedTiles, measurements, state } of results) {
        assert.deepEqual(requestedTiles, ['0/0/0'], 'source must request only canonical z0');
        assert.deepEqual(state.renderErrors, []);
        assert.equal(state.fps, true, 'Native FPS must remain enabled');
        assert.equal(state.globe, true);
        assert.equal(state.msaaSamples, 4);
        assert.equal(measurements.length, 2);
        for (const measurement of measurements) {
          assert.equal(measurement.ratio, 1);
          assert.equal(measurement.canvasWidth, 1280);
          assert.equal(measurement.canvasHeight, 720);
          assert.ok(Math.abs(measurement.cameraHeight - 1500) < 0.01, `camera must actually be 1500m high: ${measurement.cameraHeight}`);
          assert.ok(Math.abs(measurement.cameraLongitude - measurement.view.longitude) < 0.000001, `camera longitude differs: ${measurement.cameraLongitude}`);
          assert.ok(Math.abs(measurement.cameraLatitude) < 0.000001, `camera latitude differs: ${measurement.cameraLatitude}`);
          assert.ok(measurement.tiles.length > 0, 'completed native tile records must exist even for the empty view');
          for (const tile of [...measurement.tiles, ...measurement.draws]) {
            assert.deepEqual(tile.canonical, { z: 0, x: 0, y: 0 });
            assert.equal(tile.overscaledZ, 0, 'actual geometry must not overzoom');
            assert.equal(tile.wrap, 0, 'source branch must belong to the canonical world');
          }
          if (measurement.view.painted)
            assert.ok(measurement.draws.length > 0, 'the positive endpoint must execute a real native road draw');
          for (const sample of measurement.samples) {
            assert.equal(sample.expectedOwner, '0/0/0');
            const expected = sample.painted ? singleBlend : background;
            assert.ok(sample.rgb.every((channel, index) => Math.abs(channel - expected[index]) <= 3), `${mode}/${scenario.name}/${measurement.view.longitude}/${sample.along}/${sample.across}: ${sample.rgb} vs ${expected}`);
            if (sample.painted) {
              assert.equal(sample.feature?.layerId, 'roads', 'the source endpoint must publicly pick its road');
              assert.equal(sample.feature.properties.owner, '0/0/0');
              assert.equal(sample.feature.properties.road, scenario.name);
            }
            else {
              assert.equal(sample.feature, undefined, 'background and Greenwich ghost probes must not publicly pick a road');
            }
          }
        }
      }
    });
  }
});
