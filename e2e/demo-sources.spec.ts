import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from 'canvas';
import { expect } from 'playwright/test';
import { test } from './fixtures';

interface Region {
  name: string;
  longitude: number;
  latitude: number;
  scale: number;
  tileSource?: string;
}

const regions: Record<string, Region[]> = {
  'liberty': [{ name: 'London', longitude: -0.1276, latitude: 51.5072, scale: 2 }],
  'versatiles': [{ name: 'Cape Town', longitude: 18.4241, latitude: -33.9249, scale: 2 }],
  'osm': [{ name: 'Tokyo', longitude: 139.6917, latitude: 35.6895, scale: 2 }],
  'basemap-world': [
    { name: 'Berlin', longitude: 13.405, latitude: 52.52, scale: 2, tileSource: 'bm_web_de_3857' },
    { name: 'London', longitude: -0.1276, latitude: 51.5072, scale: 2, tileSource: 'bm_web_wld_3857' },
  ],
  'waymorphic': [{ name: 'Sydney', longitude: 151.2108, latitude: -33.8588, scale: 2 }],
  'osm-us': [{ name: 'São Paulo', longitude: -46.6559, latitude: -23.5614, scale: 2 }],
  'world': [{ name: 'World overview', longitude: 0, latitude: 20, scale: 512 }],
};

function tileCoordinates(url: string) {
  if (/fonts|glyph/i.test(url))
    return;
  const match = new URL(url).pathname.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.(?:pbf|mvt))?$/);
  if (match)
    return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}

function coversRegion(tile: ReturnType<typeof tileCoordinates>, region: Region, overview: boolean) {
  if (!tile || (overview ? tile.z > 6 : tile.z < 8))
    return false;
  const count = 2 ** tile.z;
  const latitude = region.latitude * Math.PI / 180;
  const x = Math.floor((region.longitude + 180) / 360 * count);
  const y = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2 * count);
  return tile.x === x && tile.y === y;
}

async function pixelsAfterStyle(page: Page, style?: StyleSpecification, background = false) {
  const before = await page.evaluate<number, unknown>((nextStyle) => {
    const { tileset, viewer, renderedFrames } = window.renderValidation;
    if (nextStyle)
      tileset.setStyle(nextStyle as StyleSpecification);
    viewer.scene.requestRender();
    return renderedFrames;
  }, style);
  // A style handoff can retain predecessor paint. Wait for public readiness
  // and source residency to clear, then sample a subsequent actual postRender.
  await expect.poll(() => page.evaluate(({ frame, backgroundOnly }) => {
    const { tileset, renderedFrames } = window.renderValidation;
    const stats = tileset.stats();
    return renderedFrames > frame && tileset.tilesLoaded && stats.pendingPublishes === 0
      && (backgroundOnly
        ? stats.bucket.tiles === 0 && stats.symbol.tiles === 0 && stats.symbol.fadingTiles === 0
        && stats.pattern.tiles === 0 && stats.raster.tiles === 0
        && stats.featureIndexes === 0 && stats.gpuMemory.entries === 0
        : stats.bucket.collections > 0);
  }, { frame: before, backgroundOnly: background }), { timeout: background ? 30_000 : 90_000 }).toBe(true);
  const frame = await page.evaluate(() => {
    const { viewer, renderedFrames } = window.renderValidation;
    viewer.scene.requestRender();
    return renderedFrames;
  });
  // This counter advances only in the fixture's actual postRender listener.
  await expect.poll(() => page.evaluate(() => window.renderValidation.renderedFrames)).toBeGreaterThan(frame);
  const image = await loadImage(await page.locator('#cesium canvas').screenshot());
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const stats = await page.evaluate(() => window.renderValidation.tileset.stats());
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data, stats };
}

function changedPixels(first: Awaited<ReturnType<typeof pixelsAfterStyle>>, second: Awaited<ReturnType<typeof pixelsAfterStyle>>) {
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
  let changed = 0;
  let sampled = 0;
  // Top-down ground in the central 70% x 60%; exclude credits and edge UI.
  // Sample every fourth pixel, ignoring small antialiasing/color fluctuations.
  for (let y = Math.floor(first.height * 0.2); y < first.height * 0.8; y += 4) {
    for (let x = Math.floor(first.width * 0.15); x < first.width * 0.85; x += 4) {
      const offset = (y * first.width + x) * 4;
      sampled++;
      if ([0, 1, 2].some(channel => Math.abs(first.data[offset + channel] - second.data[offset + channel]) >= 20))
        changed++;
    }
  }
  return changed / sampled;
}

// Maptoolkit forbids fixed media output, so it is verified through resource
// probes in the source research rather than this screenshot-capable runner.
for (const id of ['liberty', 'versatiles', 'osm', 'basemap-world', 'waymorphic', 'osm-us', 'world']) {
  test(`global provider ${id} renders its actual public MVT @live`, async ({ page, renderUrl }, testInfo) => {
    test.setTimeout(id === 'basemap-world' ? 480_000 : 240_000);
    const errors = [];
    const vectorResponses = [];
    const evidence = [];
    const cleanupErrors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', (response) => {
      const tile = tileCoordinates(response.url());
      if (tile)
        vectorResponses.push({ url: response.url(), status: response.status(), tile });
    });
    const blank = `${renderUrl}/source-smoke.html`;
    await page.route(blank, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Source catalog</title>' }));
    await page.goto(blank);
    const stylePreset = await page.evaluate(async (styleId) => {
      const moduleUrl = new URL('./src/demo/preset-catalog.ts', location.href).href;
      const { stylePresets } = await import(moduleUrl) as typeof import('../src/demo/preset-catalog');
      return stylePresets.find(preset => preset.id === styleId);
    }, id);
    assert.ok(stylePreset, `missing demo preset ${id}`);
    try {
      for (const region of regions[id]) {
        const responseStart = vectorResponses.length;
        let pixelEvidence;
        let originalStyle: StyleSpecification | undefined;
        let needsRestore = false;
        try {
          const query = new URLSearchParams({ style: stylePreset.url, center: `${region.longitude},${region.latitude}`, scale: String(region.scale) });
          await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
          await expect.poll(() => page.evaluate(() => {
            const validation = window.renderValidation;
            return validation && validation.tileset.tilesLoaded && validation.tileset.stats().bucket.collections > 0;
          }), { timeout: 90_000 }).toBe(true);
          await expect(page.locator('.cesium-performanceDisplay')).toBeVisible();
          const responses = vectorResponses.slice(responseStart);
          assert.ok(responses.some(response => response.status >= 200 && response.status < 300
            && coversRegion(response.tile, region, id === 'world')
            && (!region.tileSource || response.url.includes(region.tileSource))), `${id}: no successful MVT covering ${region.name} from its expected source`);
          originalStyle = await page.evaluate(() => window.renderValidation.tileset.styleSpec);
          assert.ok(originalStyle.layers.some(layer => 'source' in layer), `${id}: style has no source-backed layers`);
          const shown = await pixelsAfterStyle(page);
          // This test-only counterexample keeps every original source-less
          // layer. Removing sources also releases any held predecessor paint.
          const backgroundStyle: StyleSpecification = {
            ...originalStyle,
            sources: {},
            layers: originalStyle.layers.filter(layer => !('source' in layer)),
          };
          needsRestore = true;
          const background = await pixelsAfterStyle(page, backgroundStyle, true);
          const restored = await pixelsAfterStyle(page, originalStyle);
          needsRestore = false;
          pixelEvidence = {
            sourceDifference: changedPixels(shown, background),
            restoredDifference: changedPixels(restored, background),
            restorationDrift: changedPixels(shown, restored),
            backgroundStats: background.stats,
          };
          // At least 1% of sampled ground differs from the same background.
          // Allow symbol fades and placement changes after restoring the style.
          assert.ok(pixelEvidence.sourceDifference > 0.01, `${id}/${region.name}: no visible source-backed paint: ${JSON.stringify(pixelEvidence)}`);
          assert.ok(pixelEvidence.restoredDifference >= pixelEvidence.sourceDifference * 0.75, `${id}/${region.name}: MVT paint did not return: ${JSON.stringify(pixelEvidence)}`);
          assert.ok(pixelEvidence.restorationDrift <= Math.max(0.02, pixelEvidence.sourceDifference * 0.25), `${id}/${region.name}: restored paint differs substantially: ${JSON.stringify(pixelEvidence)}`);
          const result = await page.evaluate(() => {
            const { viewer, tileset, renderErrors } = window.renderValidation;
            return { stats: tileset.stats(), errors: renderErrors, fps: viewer.scene.debugShowFramesPerSecond, globe: viewer.scene.globe.show };
          });
          assert.ok(result.fps && result.globe);
          assert.ok(result.stats.submittedCommands > 0, `${id} produced no draw commands`);
          assert.deepEqual(result.errors, []);
        }
        finally {
          // Cleanup failures remain diagnostic and cannot replace the original
          // readiness, response or pixel assertion that failed.
          if (needsRestore) {
            await page.evaluate<void, unknown>((style) => {
              window.renderValidation.tileset.setStyle(style as StyleSpecification);
              window.renderValidation.viewer.scene.requestRender();
            }, originalStyle!).catch(error => cleanupErrors.push(String(error)));
          }
          const result = await page.evaluate(() => {
            const validation = window.renderValidation;
            return validation && { stats: validation.tileset.stats(), errors: validation.renderErrors, renderedFrames: validation.renderedFrames, fps: validation.viewer.scene.debugShowFramesPerSecond, globe: validation.viewer.scene.globe.show };
          }).catch(error => ({ diagnosticError: String(error) }));
          evidence.push({ region, vectorResponses: vectorResponses.slice(responseStart), pixels: pixelEvidence, result });
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(cleanupErrors, []);
    }
    finally {
      await testInfo.attach('provider-smoke', { body: JSON.stringify({ provider: stylePreset.provider, vectorResponses, regions: evidence, errors, cleanupErrors }, null, 2), contentType: 'application/json' });
    }
  });
}
