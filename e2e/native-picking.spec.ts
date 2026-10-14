import type { TilesetPickObject } from '../packages/cesium-vector-tileset/index';
import assert from 'node:assert/strict';
import { createCanvas } from 'canvas';
import { expect } from 'playwright/test';
import { test } from './fixtures';

// A transparent sprite center must pick the visible geometry underneath,
// while its painted border and text belong to their individual source feature.
test('native picking honors type selection, alpha holes and per-feature drillPick in shared batches', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const image = createCanvas(48, 32);
  const context = image.getContext('2d');
  context.fillStyle = '#0080ff';
  context.fillRect(0, 0, 32, 32);
  context.clearRect(8, 8, 16, 16);
  context.fillRect(32, 0, 16, 16);
  const rasterImage = createCanvas(16, 16);
  const rasterContext = rasterImage.getContext('2d');
  rasterContext.fillStyle = '#ff8000';
  rasterContext.fillRect(0, 0, 16, 16);
  const rasterPng = rasterImage.toBuffer('image/png');
  const png = image.toBuffer('image/png');
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sprite: `${renderUrl}/native-picking/sprite`,
    glyphs: `${renderUrl}/native-picking/fonts/{fontstack}/{range}.pbf`,
    sources: {
      imagery: { type: 'image', url: `${renderUrl}/native-picking/image.png`, coordinates: [[0.002, -0.002], [0.005, -0.002], [0.005, -0.003], [0.002, -0.003]] },
      stops: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', id: 33, properties: { name: '丙站' }, geometry: { type: 'Point', coordinates: [-0.002, 0] } },
            { type: 'Feature', id: 11, properties: { name: '甲站' }, geometry: { type: 'Point', coordinates: [-0.002, 0] } },
            { type: 'Feature', id: 22, properties: { name: '乙站' }, geometry: { type: 'Point', coordinates: [0.002, 0] } },
            ...[44, 55].map(id => ({ type: 'Feature', id, properties: { surface: 'pattern' }, geometry: { type: 'Polygon', coordinates: [[[-0.005, -0.002], [-0.002, -0.002], [-0.002, -0.003], [-0.005, -0.003], [-0.005, -0.002]]] } })),
            ...[66, 77].map(id => ({ type: 'Feature', id, properties: { surface: 'solid' }, geometry: { type: 'Polygon', coordinates: [[[-0.001, -0.002], [0.001, -0.002], [0.001, -0.003], [-0.001, -0.003], [-0.001, -0.002]]] } })),
          ],
        },
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
      { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
      { id: 'patches', type: 'fill', source: 'stops', filter: ['==', 'surface', 'pattern'], paint: { 'fill-pattern': 'solid' } },
      { id: 'solid', type: 'fill', source: 'stops', filter: ['==', 'surface', 'solid'], paint: { 'fill-color': '#0080ff', 'fill-antialias': false } },
      { id: 'points', type: 'circle', source: 'stops', filter: ['all', ['==', '$type', 'Point'], ['!=', 'name', '丙站']], paint: { 'circle-radius': 16, 'circle-color': '#00ff00' } },
      {
        id: 'stops',
        type: 'symbol',
        source: 'stops',
        filter: ['==', '$type', 'Point'],
        layout: { 'symbol-z-order': 'source', 'icon-image': 'ring', 'icon-allow-overlap': true, 'text-field': ['get', 'name'], 'text-font': ['sans-serif'], 'text-size': 24, 'text-offset': [0, 1.6], 'text-allow-overlap': true },
        paint: { 'text-color': '#ff0000' },
      },
    ],
  };
  await page.route('**/native-picking/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/image.png'))
      return route.fulfill({ body: rasterPng, contentType: 'image/png' });
    if (/sprite.*\.png$/.test(url))
      return route.fulfill({ body: png, contentType: 'image/png' });
    if (/sprite.*\.json$/.test(url))
      return route.fulfill({ json: { ring: { x: 0, y: 0, width: 32, height: 32, pixelRatio: 1 }, solid: { x: 32, y: 0, width: 16, height: 16, pixelRatio: 1 } } });
    if (url.endsWith('.pbf'))
      return route.fulfill({ status: 404 });
    return route.fulfill({ json: style });
  });
  const captures = [];
  for (const policy of ['default', 'symbol', 'surfaces', 'all'] as const) {
    const query = new URLSearchParams({ center: '0,0', cameraHeight: '1200', style: `${renderUrl}/native-picking/style.json`, antialias: '0', readback: '0', atlas: '1' });
    if (policy !== 'default')
      query.set('picking', policy === 'all' ? 'true' : JSON.stringify(policy === 'symbol' ? { symbol: true } : { fill: true, raster: true }));
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => {
      const validation = window.renderValidation;
      return validation?.tileset.tilesLoaded && validation.tileset.stats().symbol.primitives > 0 && validation.viewer.scene.globe.tilesLoaded;
    }), { timeout: 60_000 }).toBe(true);
    const capture = await page.evaluate(async () => {
      const { viewer, projectPosition, tileset } = window.renderValidation;
      let pixels: Uint8Array | undefined;
      const stop = viewer.scene.postRender.addEventListener(() => pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height }));
      for (let frame = 0; frame < 8; frame++) {
        viewer.scene.requestRender();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      stop();
      if (!pixels)
        throw new Error('The actual symbol framebuffer is missing');
      const pick = (position: { x: number; y: number }) => {
        const hit = viewer.scene.pick(position, 1, 1);
        return hit && (hit.id ?? hit) as TilesetPickObject | undefined;
      };
      const stops = [-0.002, 0.002].map((longitude) => {
        const anchor = projectPosition(longitude, 0)!;
        let text: { x: number; y: number } | undefined;
        for (let y = Math.floor(anchor.y) + 20; y < anchor.y + 65 && !text; y++) {
          for (let x = Math.floor(anchor.x) - 32; x < anchor.x + 32; x++) {
            const offset = ((viewer.canvas.height - y - 1) * viewer.canvas.width + x) * 4;
            if (pixels![offset] > 180 && pixels![offset + 1] < 40 && pixels![offset + 2] < 40) {
              text = { x: x + 0.5, y: y + 0.5 };
              break;
            }
          }
        }
        if (!text)
          throw new Error('The real red Chinese label must render before testing picking');
        const border = { x: anchor.x - 12, y: anchor.y };
        const drill = viewer.scene.drillPick(new window.renderValidation.atlas!.cesium.Cartesian2(border.x, border.y), 10, 1, 1).map(hit => (hit.id ?? hit) as TilesetPickObject);
        return { icon: pick(border), text: pick(text), hole: pick(anchor), drill };
      });
      const surfaces = [-0.0035, 0, 0.0035].map((longitude) => {
        const position = projectPosition(longitude, -0.0025)!;
        const offset = ((viewer.canvas.height - Math.floor(position.y) - 1) * viewer.canvas.width + Math.floor(position.x)) * 4;
        const color = [...pixels!.slice(offset, offset + 3)];
        const drill = viewer.scene.drillPick(new window.renderValidation.atlas!.cesium.Cartesian2(position.x, position.y), 10, 1, 1).map(hit => (hit.id ?? hit) as TilesetPickObject);
        return { color, picked: pick(position), drill };
      });
      const shader = viewer.canvas.getContext('webgl2')!;
      const gpu = shader.getExtension('WEBGL_debug_renderer_info');
      return { stops, surfaces, gpu: String(shader.getParameter(gpu?.UNMASKED_RENDERER_WEBGL ?? shader.RENDERER)), stats: tileset.stats(), errors: window.renderValidation.renderErrors };
    });
    captures.push({ policy, ...capture });
    await page.screenshot({ path: testInfo.outputPath(`native-picking-${policy}.png`) });
    assert.deepEqual(capture.errors, []);
    for (const [index, stop] of capture.stops.entries()) {
      const featureId = index === 0 ? 11 : 22;
      const name = index === 0 ? '甲站' : '乙站';
      if (policy === 'default' || policy === 'surfaces') {
        assert.equal(stop.icon, undefined);
        assert.equal(stop.text, undefined);
        assert.equal(stop.hole, undefined);
        assert.deepEqual(stop.drill, []);
      }
      else {
        assert.equal(stop.icon?.layerId, 'stops');
        assert.equal(stop.icon?.featureId, featureId);
        assert.equal(stop.text?.featureId, featureId);
        assert.deepEqual(stop.text?.properties, { name });
        assert.equal(stop.text?.source, 'stops');
        assert.equal(stop.text?.type, 'symbol');
        assert.ok(stop.drill.some(hit => hit.layerId === 'stops' && hit.featureId === featureId));
        if (index === 0)
          assert.ok(stop.drill.some(hit => hit.layerId === 'stops' && hit.featureId === 33), 'drillPick must reach a second symbol in the same merged Primitive');
        if (policy === 'symbol') {
          assert.equal(stop.hole, undefined);
          assert.ok(stop.drill.every(hit => hit.type === 'symbol'));
        }
        else {
          assert.equal(stop.hole?.layerId, 'points');
          assert.equal(stop.hole?.featureId, featureId);
          assert.ok(stop.drill.some(hit => hit.layerId === 'points' && hit.featureId === featureId));
        }
      }
    }
    for (const [index, surface] of capture.surfaces.entries()) {
      const layerId = ['patches', 'solid', 'imagery'][index];
      assert.deepEqual(surface.color, index === 2 ? [255, 128, 0] : [0, 128, 255], 'The actual surface must render before testing native picking');
      if (policy === 'default' || policy === 'symbol') {
        assert.equal(surface.picked, undefined);
        assert.deepEqual(surface.drill, []);
      }
      else {
        assert.equal(surface.picked?.layerId, layerId);
        assert.equal(surface.picked?.type, index === 2 ? 'raster' : 'fill');
        assert.equal(surface.picked?.source, index === 2 ? 'imagery' : 'stops');
        if (index < 2) {
          const ids = surface.drill.filter(hit => hit.layerId === layerId).map(hit => hit.featureId);
          assert.deepEqual(ids.sort(), index === 0 ? [44, 55] : [66, 77], 'Native drillPick must hide individual features inside a surface batch');
          assert.deepEqual(surface.picked?.properties, { surface: index === 0 ? 'pattern' : 'solid' });
        }
        else {
          assert.deepEqual(surface.picked?.properties, {});
          assert.equal(surface.drill.length, 1);
        }
      }
    }
  }
  await testInfo.attach('native-picking', { body: JSON.stringify(captures, null, 2), contentType: 'application/json' });
  assert.deepEqual(errors, []);
});
