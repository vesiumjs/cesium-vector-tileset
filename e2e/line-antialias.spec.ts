import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface PixelPosition { x: number; y: number }
interface CapPositions { native: PixelPosition; reference: PixelPosition }
interface CapSample {
  column: number;
  row: number;
  rgb: number[];
  along?: number;
  across?: number;
  straddlesSharedEdge?: boolean;
}
interface AntialiasProfile {
  center: number;
  ratio: number;
  rows: Array<{ row: number; distance: number; rgb: number[] }>;
  capSamples: CapSample[];
}
interface AntialiasProbe {
  coordinates: string;
  nativePosition: PixelPosition;
  referencePosition: PixelPosition;
  capPositions: CapPositions;
  native: AntialiasProfile;
  maplibre: AntialiasProfile;
}
interface AntialiasEndpointsProbe {
  coordinates: string;
  lines: Array<{
    geometryIndex: number;
    geometry: number[][];
    endpoints: Array<{
      endpoint: string;
      capPositions: CapPositions;
      fraction: PixelPosition;
      pixelCenterAlong: number;
      outward: PixelPosition;
      native: AntialiasProfile;
      maplibre: AntialiasProfile;
    }>;
  }>;
}
interface ObliqueLineProbe {
  coordinates: string;
  ratio: number;
  start: PixelPosition;
  end: PixelPosition;
  length: number;
  profiles: Array<{ progress: number; center: PixelPosition; samples: Array<{
    x: number;
    y: number;
    distance: number;
    alpha: number;
    expected: number[];
    rgb: number[];
  }>; }>;
}
declare global {
  interface Window {
    stopAntialiasPixels: () => void;
    antialiasNative: Uint8Array;
    antialiasReference: Uint8Array;
    antialiasProbe: (tiles: string[], width: number) => AntialiasProbe;
    antialiasEndpointsProbe: (tiles: string[], width: number) => AntialiasEndpointsProbe;
    stopObliquePixels: () => void;
    obliquePixels: Uint8Array;
    obliqueLineProbe: (tiles: string[], width: number) => ObliqueLineProbe;
  }
}

const straightGeometry = [[1024, 2048], [3072, 2048]];

function lineTile(geometries) {
  return Buffer.from(fromGeojsonVt({
    ground: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
    roads: { features: geometries.map(geometry => ({ type: 2, geometry: [geometry], tags: {} })) },
  }, { version: 2, extent: 4096 }));
}

async function serveLines(page: Page, renderUrl: string, kind: string, cap: 'round' | 'butt' | 'square' = 'round', geometries = [straightGeometry]) {
  const tile = lineTile(geometries);
  const requestedTiles = new Set<string>();
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/line-antialias/{z}/{x}/{y}.pbf`], minzoom: 14, maxzoom: 14 } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#224455', 'fill-antialias': false } },
      {
        'id': 'roads',
        'type': 'line',
        'source': 'city',
        'source-layer': 'roads',
        'layout': { 'line-join': 'miter', 'line-cap': cap },
        'paint': { 'line-color': '#ff0000', 'line-width': 3, ...(kind === 'dash' ? { 'line-dasharray': [100000, 1] } : {}) },
      },
    ],
  } satisfies StyleSpecification;
  await page.route('**/line-antialias/**', (route) => {
    const match = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (match) {
      requestedTiles.add(match.slice(1).join('/'));
      return route.fulfill({ body: tile, contentType: 'application/x-protobuf' });
    }
    return route.fulfill({ json: style });
  });
  return { style, requestedTiles };
}

function compareCapProfiles(label, dpr, width, capPositions, native, maplibre) {
  assert.ok(Math.hypot(capPositions.native.x - capPositions.reference.x, capPositions.native.y - capPositions.reference.y) < 0.05, 'cap profiles must use the same projected pixel phase');
  assert.equal(native.ratio, dpr);
  assert.equal(maplibre.ratio, dpr);
  for (const [index, sample] of native.capSamples.entries()) {
    const expected = maplibre.capSamples[index];
    assert.equal(sample.column, expected.column);
    assert.equal(sample.row, expected.row);
    assert.ok(sample.rgb.every((channel, channelIndex) => Math.abs(channel - expected.rgb[channelIndex]) <= 6), `${label}/${dpr}/${width}: cap pixel ${sample.column}/${sample.row} differs from MapLibre: ${sample.rgb} vs ${expected.rgb}`);
  }
}

async function installAntialiasCapture(page: Page, geometries = [straightGeometry]) {
  await page.evaluate((geometries) => {
    const { viewer, reference } = window.renderValidation;
    viewer.scene.debugShowFramesPerSecond = true;
    window.stopAntialiasPixels = viewer.scene.postRender.addEventListener(() => {
      window.antialiasNative = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    });
    reference.on('render', () => {
      const canvas = reference.getCanvas();
      const gl = canvas.getContext('webgl2');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      window.antialiasReference = pixels;
    });
    const profile = (canvas: HTMLCanvasElement, pixels: Uint8Array, position: PixelPosition, capPosition: PixelPosition, width: number): AntialiasProfile => {
      const ratio = canvas.width / canvas.clientWidth;
      const x = Math.floor(position.x * ratio);
      const centerY = position.y * ratio;
      const radius = Math.ceil(width * ratio / 2 + 2);
      const rows = Array.from({ length: radius * 2 + 1 }, (_, index) => {
        const y = Math.floor(centerY) + index - radius;
        const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
        return { row: y, distance: y + 0.5 - centerY, rgb: Array.from(pixels.slice(offset, offset + 3)) };
      });
      const capSamples: CapSample[] = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = Math.floor(capPosition.x * ratio) + dx;
          const y = Math.floor(capPosition.y * ratio) + dy;
          const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
          capSamples.push({ column: x, row: y, rgb: Array.from(pixels.slice(offset, offset + 3)) });
        }
      }
      return { center: centerY, ratio, rows, capSamples };
    };
    window.antialiasProbe = (tiles, width) => {
      if (!window.antialiasNative || !window.antialiasReference)
        return undefined;
      for (const coordinates of tiles) {
        const [z, x, y] = coordinates.split('/').map(Number);
        const longitude = (x + 0.5) / 2 ** z * 360 - 180;
        const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** z))) * 180 / Math.PI;
        const nativePosition = window.renderValidation.projectPosition(longitude, latitude);
        const referencePosition = reference.project([longitude, latitude]);
        if (!nativePosition || [nativePosition, referencePosition].some(position => position.x < 20 || position.x > viewer.canvas.clientWidth - 20 || position.y < 20 || position.y > viewer.canvas.clientHeight - 20))
          continue;
        const capPositions = [1024, 3072].map((tileX) => {
          const capLongitude = (x + tileX / 4096) / 2 ** z * 360 - 180;
          return { native: window.renderValidation.projectPosition(capLongitude, latitude), reference: reference.project([capLongitude, latitude]) };
        }).find(pair => pair.native && [pair.native, pair.reference].every(position => position.x > 20 && position.x < viewer.canvas.clientWidth - 20 && position.y > 20 && position.y < viewer.canvas.clientHeight - 20));
        if (!capPositions)
          continue;
        const native = profile(viewer.canvas, window.antialiasNative, nativePosition, capPositions.native, width);
        const maplibre = profile(reference.getCanvas(), window.antialiasReference, referencePosition, capPositions.reference, width);
        if (Math.max(...native.rows.map(row => row.rgb[0])) < 90 || Math.max(...maplibre.rows.map(row => row.rgb[0])) < 90)
          continue;
        return { coordinates, nativePosition, referencePosition, capPositions, native, maplibre };
      }
    };
    window.antialiasEndpointsProbe = (tiles, width) => {
      if (!window.antialiasNative || !window.antialiasReference)
        return undefined;
      const visible = position => position && position.x > 20 && position.x < viewer.canvas.clientWidth - 20 && position.y > 20 && position.y < viewer.canvas.clientHeight - 20;
      for (const coordinates of tiles) {
        const [z, x, y] = coordinates.split('/').map(Number);
        const project = ([tileX, tileY]: number[]) => {
          const longitude = (x + tileX / 4096) / 2 ** z * 360 - 180;
          const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + tileY / 4096) / 2 ** z))) * 180 / Math.PI;
          return { native: window.renderValidation.projectPosition(longitude, latitude), reference: reference.project([longitude, latitude]) };
        };
        const projected = geometries.map(geometry => geometry.map(project));
        if (projected.some(points => points.some(pair => !visible(pair.native) || !visible(pair.reference))))
          continue;
        const lines = projected.map((positions, geometryIndex) => {
          const endpoints = positions.map((capPositions, endpointIndex) => {
            const other = positions[1 - endpointIndex].native;
            const ratio = viewer.canvas.width / viewer.canvas.clientWidth;
            const cap = { x: capPositions.native.x * ratio, y: capPositions.native.y * ratio };
            const length = Math.hypot(capPositions.native.x - other.x, capPositions.native.y - other.y);
            const outward = { x: (capPositions.native.x - other.x) / length, y: (capPositions.native.y - other.y) / length };
            const native = profile(viewer.canvas, window.antialiasNative, capPositions.native, capPositions.native, width);
            const maplibre = profile(reference.getCanvas(), window.antialiasReference, capPositions.reference, capPositions.reference, width);
            for (const sample of native.capSamples) {
              const dx = sample.column + 0.5 - cap.x;
              const dy = sample.row + 0.5 - cap.y;
              sample.along = dx * outward.x + dy * outward.y;
              sample.across = -dx * outward.y + dy * outward.x;
              // A pixel square straddles the cap/strip shared edge even when
              // its center lies outside the triangle receiving some samples.
              sample.straddlesSharedEdge = Math.abs(sample.along) < (Math.abs(outward.x) + Math.abs(outward.y)) * 0.5;
            }
            return {
              endpoint: endpointIndex === 0 ? 'start' : 'end',
              capPositions,
              fraction: { x: cap.x - Math.floor(cap.x), y: cap.y - Math.floor(cap.y) },
              pixelCenterAlong: (Math.floor(cap.x) + 0.5 - cap.x) * outward.x + (Math.floor(cap.y) + 0.5 - cap.y) * outward.y,
              outward,
              native,
              maplibre,
            };
          });
          return { geometryIndex, geometry: geometries[geometryIndex], endpoints };
        });
        if (lines.some(line => line.endpoints.some(endpoint => Math.max(...endpoint.native.capSamples.map(sample => sample.rgb[0])) < 90 || Math.max(...endpoint.maplibre.capSamples.map(sample => sample.rgb[0])) < 90)))
          continue;
        return { coordinates, lines };
      }
    };
    window.renderValidation.syncReference();
    viewer.scene.requestRender();
    reference.triggerRepaint();
  }, geometries);
}

for (const dpr of [1, 2]) {
  test.describe(() => {
    test.use({ deviceScaleFactor: dpr });
    for (const [kind, msaa, cap] of [...['solid', 'dash'].flatMap(kind => [1, 4].map(msaa => [kind, msaa, 'round'] as [string, number, 'round'])), ['solid', 1, 'square'] as [string, number, 'square']]) {
      test(`${cap} ${kind} line antialias matches MapLibre at DPR${dpr} MSAA${msaa}`, async ({ page, renderUrl }, testInfo) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const { style, requestedTiles } = await serveLines(page, renderUrl, kind, cap);
        const query = new URLSearchParams({ mode: '2d', compare: '1', scale: '0.25', antialias: '0', style: `${renderUrl}/line-antialias/style.json` });
        if (msaa === 4)
          query.delete('antialias');
        await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
        await expect.poll(() => page.evaluate(() => {
          const validation = window.renderValidation;
          return validation?.tileset.tilesLoaded && validation.reference?.loaded() && validation.viewer.scene.globe.tilesLoaded;
        }), { timeout: 60_000 }).toBe(true);
        await installAntialiasCapture(page);
        const profiles = [];
        for (const width of [1, 3, 6]) {
          const next = structuredClone(style);
          next.layers[1].paint['line-width'] = width;
          await page.evaluate(({ next, width }) => {
            const { viewer, tileset, reference } = window.renderValidation;
            window.antialiasNative = undefined;
            window.antialiasReference = undefined;
            tileset.setStyle(next);
            reference.setPaintProperty('roads', 'line-width', width);
            viewer.scene.requestRender();
            reference.triggerRepaint();
          }, { next, width });
          await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded && window.renderValidation.reference.loaded())).toBe(true);
          await expect.poll(() => page.evaluate(({ tiles, width }) => window.antialiasProbe(tiles, width), { tiles: [...requestedTiles], width })).toBeTruthy();
          profiles.push({ width, ...await page.evaluate(({ tiles, width }) => window.antialiasProbe(tiles, width), { tiles: [...requestedTiles], width }) });
        }
        const state = await page.evaluate(() => ({
          fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
          errors: [...window.renderValidation.renderErrors, ...window.renderValidation.referenceErrors],
          antialias: {
            native: window.renderValidation.viewer.canvas.getContext('webgl2').getContextAttributes().antialias,
            maplibre: window.renderValidation.reference.getCanvas().getContext('webgl2').getContextAttributes().antialias,
            msaaSamples: window.renderValidation.viewer.scene.msaaSamples,
          },
        }));
        const output = testInfo.outputPath('line-antialias-profiles.json');
        await writeFile(output, JSON.stringify({ kind, cap, dpr, msaa, profiles, ...state }, null, 2));
        await testInfo.attach('line-antialias-profiles', { path: output, contentType: 'application/json' });
        assert.deepEqual(errors, []);
        assert.deepEqual(state.errors, []);
        assert.ok(state.fps);
        assert.deepEqual(state.antialias, { native: msaa === 4, maplibre: false, msaaSamples: msaa });
        for (const { width, nativePosition, referencePosition, capPositions, native, maplibre } of profiles) {
          assert.ok(Math.hypot(nativePosition.x - referencePosition.x, nativePosition.y - referencePosition.y) < 0.05, 'line profiles must use the same projected pixel phase');
          assert.ok(Math.hypot(capPositions.native.x - capPositions.reference.x, capPositions.native.y - capPositions.reference.y) < 0.05, 'cap profiles must use the same projected pixel phase');
          assert.equal(native.ratio, dpr);
          assert.equal(maplibre.ratio, dpr);
          for (const [index, sample] of native.rows.entries()) {
            const expected = maplibre.rows[index];
            assert.equal(sample.row, expected.row);
            assert.ok(sample.rgb.every((channel, channelIndex) => Math.abs(channel - expected.rgb[channelIndex]) <= 6), `${kind}/${dpr}/${width}: row ${sample.row} differs from MapLibre: ${sample.rgb} vs ${expected.rgb}`);
          }
          compareCapProfiles(`${cap}/${kind}`, dpr, width, capPositions, native, maplibre);
        }
        await page.evaluate(() => window.stopAntialiasPixels());
      });
    }
  });
}

test.describe(() => {
  test.use({ deviceScaleFactor: 1 });
  for (const kind of ['solid', 'dash']) {
    test(`round ${kind} cap shared edges match MapLibre across pixel phases and directions at DPR1 MSAA4`, async ({ page, renderUrl }, testInfo) => {
      test.setTimeout(120_000);
      // Distinct features keep endpoint neighborhoods clear of other strips.
      // Phase assertions below use actual projections, rather than assuming
      // that these integer MVT offsets imply particular framebuffer phases.
      const geometries = [
        [[1024, 1856], [3072, 1856]],
        [[1026, 1984], [3074, 1984]],
        [[1028, 2112], [3076, 2112]],
        [[2800, 2192], [1500, 1504]],
      ];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const { style, requestedTiles } = await serveLines(page, renderUrl, kind, 'round', geometries);
      const query = new URLSearchParams({ mode: '2d', compare: '1', scale: '0.25', center: '-0.120849609375,51.5072', style: `${renderUrl}/line-antialias/style.json` });
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => {
        const validation = window.renderValidation;
        return validation?.tileset.tilesLoaded && validation.reference?.loaded() && validation.viewer.scene.globe.tilesLoaded;
      }), { timeout: 60_000 }).toBe(true);
      await installAntialiasCapture(page, geometries);
      const profiles = [];
      for (const width of [1, 3, 6]) {
        const next = structuredClone(style);
        next.layers[1].paint['line-width'] = width;
        await page.evaluate(({ next, width }) => {
          const { viewer, tileset, reference } = window.renderValidation;
          window.antialiasNative = undefined;
          window.antialiasReference = undefined;
          tileset.setStyle(next);
          reference.setPaintProperty('roads', 'line-width', width);
          viewer.scene.requestRender();
          reference.triggerRepaint();
        }, { next, width });
        await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded && window.renderValidation.reference.loaded())).toBe(true);
        await expect.poll(() => page.evaluate(({ tiles, width }) => window.antialiasEndpointsProbe(tiles, width), { tiles: [...requestedTiles], width })).toBeTruthy();
        profiles.push({ width, ...await page.evaluate(({ tiles, width }) => window.antialiasEndpointsProbe(tiles, width), { tiles: [...requestedTiles], width }) });
      }
      const state = await page.evaluate(() => ({
        fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
        errors: [...window.renderValidation.renderErrors, ...window.renderValidation.referenceErrors],
        antialias: {
          native: window.renderValidation.viewer.canvas.getContext('webgl2').getContextAttributes().antialias,
          maplibre: window.renderValidation.reference.getCanvas().getContext('webgl2').getContextAttributes().antialias,
          msaaSamples: window.renderValidation.viewer.scene.msaaSamples,
        },
      }));
      const output = testInfo.outputPath('line-cap-phase-profiles.json');
      await writeFile(output, JSON.stringify({ kind, dpr: 1, msaa: 4, geometries, profiles, ...state }, null, 2));
      await testInfo.attach('line-cap-phase-profiles', { path: output, contentType: 'application/json' });
      assert.deepEqual(errors, []);
      assert.deepEqual(state.errors, []);
      assert.ok(state.fps);
      assert.deepEqual(state.antialias, { native: true, maplibre: false, msaaSamples: 4 });
      for (const { width, lines } of profiles) {
        assert.equal(lines.length, geometries.length);
        for (const endpointIndex of [0, 1]) {
          const horizontal = lines.slice(0, 3).map(line => line.endpoints[endpointIndex]);
          assert.ok(horizontal.some(endpoint => endpoint.fraction.x < 0.5), 'horizontal endpoint phases must include fractions below one half');
          assert.ok(horizontal.some(endpoint => endpoint.fraction.x > 0.5), 'horizontal endpoint phases must include fractions above one half');
          assert.ok(horizontal.some(endpoint => endpoint.pixelCenterAlong < 0), 'shared-edge pixel centers must include the strip side');
          assert.ok(horizontal.some(endpoint => endpoint.pixelCenterAlong > 0), 'shared-edge pixel centers must include the cap side');
        }
        const diagonal = lines[3];
        assert.ok(diagonal.endpoints[0].outward.x > 0 && Math.abs(diagonal.endpoints[0].outward.y) > 0.1, 'the diagonal feature must reverse the horizontal direction');
        for (const { geometryIndex, endpoints } of lines) {
          assert.equal(endpoints.length, 2);
          for (const { endpoint, capPositions, native, maplibre } of endpoints) {
            const shared = native.capSamples.filter(sample => sample.straddlesSharedEdge);
            assert.ok(shared.length > 0, 'the probe must include pixels straddling the cap/strip edge');
            if (geometryIndex === 3) {
              assert.ok(shared.some(sample => sample.along < 0), 'diagonal shared-edge pixels must include strip-side centers');
              assert.ok(shared.some(sample => sample.along > 0), 'diagonal shared-edge pixels must include cap-side centers');
            }
            assert.ok(native.capSamples.some(sample => sample.along < 0 && Math.abs(sample.across) < width / 2 + 0.5), 'the endpoint region must contain painted strip-side pixels');
            assert.ok(native.capSamples.some(sample => sample.along > 0 && Math.abs(sample.across) < width / 2 + 0.5), 'the endpoint region must contain cap-side pixels');
            compareCapProfiles(`round/${kind}/geometry${geometryIndex}/${endpoint}`, 1, width, capPositions, native, maplibre);
          }
        }
      }
      await page.evaluate(() => window.stopAntialiasPixels());
    });
  }
});

for (const mode of ['3d', 'cv']) {
  for (const kind of ['solid', 'dash']) {
    test(`${kind} line keeps pixel coverage in an oblique ${mode} view`, async ({ page, renderUrl }, testInfo) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const { style, requestedTiles } = await serveLines(page, renderUrl, kind);
      const query = new URLSearchParams({ mode, scale: '0.25', style: `${renderUrl}/line-antialias/style.json` });
      await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
      await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded && window.renderValidation.viewer.scene.globe.tilesLoaded), { timeout: 60_000 }).toBe(true);
      await page.evaluate(() => {
        const validation = window.renderValidation;
        validation.viewer.scene.debugShowFramesPerSecond = true;
        validation.setObliqueView();
        window.stopObliquePixels = validation.viewer.scene.postRender.addEventListener(() => {
          const { canvas, scene } = validation.viewer;
          window.obliquePixels = scene.context.readPixels({ width: canvas.width, height: canvas.height });
        });
        window.obliqueLineProbe = (tiles, width) => {
          if (!window.obliquePixels)
            return undefined;
          const { canvas } = validation.viewer;
          const ratio = canvas.width / canvas.clientWidth;
          const project = (z, x, y, tileX) => {
            const longitude = (x + tileX / 4096) / 2 ** z * 360 - 180;
            const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** z))) * 180 / Math.PI;
            // The second style layer is lifted by the common 1m surface
            // offset plus its 0.01m layer offset. Oblique views see this lift.
            const position = validation.projectPosition(longitude, latitude, 1.01);
            return position && { x: position.x * ratio, y: position.y * ratio };
          };
          const sample = (x, y) => {
            const offset = ((canvas.height - 1 - y) * canvas.width + x) * 4;
            return Array.from(window.obliquePixels.slice(offset, offset + 3));
          };
          const halfWidth = width * ratio / 2;
          const margin = halfWidth + 10;
          for (const coordinates of tiles) {
            const [z, x, y] = coordinates.split('/').map(Number);
            const start = project(z, x, y, 1024);
            const end = project(z, x, y, 3072);
            if (!start || !end || [start, end].some(position => position.x < margin || position.x > canvas.width - margin || position.y < margin || position.y > canvas.height - margin))
              continue;
            const length = Math.hypot(end.x - start.x, end.y - start.y);
            if (length < width * ratio * 5 || Math.abs(end.y - start.y) < 40)
              continue;
            const tangent = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
            const normal = { x: -tangent.y, y: tangent.x };
            const profiles = [0.2, 0.5, 0.8].map((progress) => {
              const center = { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress };
              const samples = new Map();
              for (let across = -Math.ceil(halfWidth + 2); across <= Math.ceil(halfWidth + 2); across += 0.5) {
                for (const along of [-1, 0, 1]) {
                  const px = Math.floor(center.x + normal.x * across + tangent.x * along);
                  const py = Math.floor(center.y + normal.y * across + tangent.y * along);
                  const distance = Math.abs((px + 0.5 - start.x) * normal.x + (py + 0.5 - start.y) * normal.y);
                  const alpha = Math.max(0, Math.min(1, halfWidth + 0.5 - distance));
                  const expected = [34, 68, 85].map((background, channel) => Math.round(background + ((channel === 0 ? 255 : 0) - background) * alpha));
                  samples.set(`${px}/${py}`, { x: px, y: py, distance, alpha, expected, rgb: sample(px, py) });
                }
              }
              return { progress, center, samples: [...samples.values()] };
            });
            if (profiles.some(profile => Math.max(...profile.samples.map(pixel => pixel.rgb[0])) < 250))
              continue;
            return { coordinates, ratio, start, end, length, profiles };
          }
        };
        validation.viewer.scene.requestRender();
      });
      const measurements = [];
      for (const width of [12, 24]) {
        const next = structuredClone(style);
        next.layers[1].paint['line-width'] = width;
        await page.evaluate((next) => {
          window.obliquePixels = undefined;
          window.renderValidation.tileset.setStyle(next);
          window.renderValidation.viewer.scene.requestRender();
        }, next);
        await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded), { timeout: 60_000 }).toBe(true);
        await expect.poll(() => page.evaluate(({ tiles, width }) => window.obliqueLineProbe(tiles, width), { tiles: [...requestedTiles], width })).toBeTruthy();
        measurements.push({ width, ...await page.evaluate(({ tiles, width }) => window.obliqueLineProbe(tiles, width), { tiles: [...requestedTiles], width }) });
      }
      const state = await page.evaluate(() => ({
        fps: window.renderValidation.viewer.scene.debugShowFramesPerSecond,
        msaaSamples: window.renderValidation.viewer.scene.msaaSamples,
        renderErrors: window.renderValidation.renderErrors,
      }));
      const output = testInfo.outputPath('oblique-line-profiles.json');
      await writeFile(output, JSON.stringify({ mode, kind, measurements, ...state }, null, 2));
      await testInfo.attach('oblique-line-profiles', { path: output, contentType: 'application/json' });
      assert.deepEqual(errors, []);
      assert.deepEqual(state.renderErrors, []);
      assert.ok(state.fps);
      assert.equal(state.msaaSamples, 4);
      for (const { width, profiles } of measurements) {
        for (const { progress, samples } of profiles) {
          assert.ok(samples.some(pixel => pixel.alpha > 0 && pixel.alpha < 1), 'probe must include a fractional edge pixel');
          for (const sample of samples)
            assert.ok(sample.rgb.every((channel, index) => Math.abs(channel - sample.expected[index]) <= 6), `${mode}/${kind}/${width}/${progress}: pixel ${sample.x}/${sample.y} differs from constant screen-space coverage: ${sample.rgb} vs ${sample.expected}`);
        }
      }
      await page.evaluate(() => window.stopObliquePixels());
    });
  }
}
