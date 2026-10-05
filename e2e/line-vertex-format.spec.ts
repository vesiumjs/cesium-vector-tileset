import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

declare global {
  interface Window {
    lineFormatValidation: Awaited<ReturnType<typeof import('./fixtures/line-vertex-format-fixture').createLineFormatValidation>>;
  }
}

type Mode = '2d' | 'cv' | '3d';

for (const [scenario, mode] of [...['curved', 'dateline', 'short-legs'].flatMap(scenario => (['2d', 'cv', '3d'] as const).map(mode => [scenario, mode])), ['near-plane', '3d'] as const, ['dense-lines', '2d'] as const, ['dense-lines', '3d'] as const]) {
  test(`exact line positions preserve ${scenario} Native float pixels and picking in ${mode}`, async ({ page, renderUrl }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/line-format/style.json', route => route.fulfill({ json: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#224455' } }],
    } }));
    const query = new URLSearchParams({ mode, center: scenario === 'dateline' ? '179.999,-16.5' : '-0.1276,51.5072', scale: '0.2', antialias: '0', style: `${renderUrl}/line-format/style.json` });
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => !!window.renderValidation)).toBe(true);
    await page.evaluate(async ({ mode, scenario }) => {
      const moduleUrl = '/e2e/fixtures/line-vertex-format-fixture.ts';
      const { createLineFormatValidation } = await import(moduleUrl) as typeof import('./fixtures/line-vertex-format-fixture');
      window.lineFormatValidation = await createLineFormatValidation(mode as Mode, scenario as Parameters<typeof createLineFormatValidation>[1]);
    }, { mode, scenario });
    await expect.poll(() => page.evaluate(() => window.lineFormatValidation.ready()), { timeout: 60_000 }).toBe(true);
    const evidence = await page.evaluate(() => window.lineFormatValidation.compare());
    const output = testInfo.outputPath('line-format-pixels.json');
    await writeFile(output, JSON.stringify(evidence, null, 2));
    await testInfo.attach('line-format-pixels', { path: output, contentType: 'application/json' });
    assert.deepEqual(errors, []);
    assert.deepEqual(evidence.errors, []);
    assert.ok(evidence.fps);
    assert.ok(evidence.paintedPixels > 500, 'reference must visibly render curved, closed and capped lines');
    assert.ok(evidence.comparedPixels > evidence.paintedPixels, 'comparison must include background and faint AA pixels');
    assert.equal(evidence.changedPixels, 0, 'position lookups must preserve the entire Native FLOAT framebuffer');
    if (scenario === 'curved' && mode === '2d') {
      assert.equal(evidence.cameraViews.length, 3);
      assert.ok(evidence.cameraViews.every(view => view.changedPixels === 0 && view.stableStorage), 'pan, heading and zoom must preserve frozen pixels without rebuilding VA or position texture');
    }
    assert.ok(evidence.packedPick, 'compact Primitive must preserve Native feature picking');
    assert.deepEqual(evidence.packedPick, evidence.referencePick);
    assert.ok(evidence.geometryBytes < (scenario === 'dense-lines' ? 8_000_000 : scenario === 'dateline' ? 10000 : 8192), `Native geometry exceeds its capacity budget: ${evidence.geometryBytes} bytes`);
    if (scenario === 'dense-lines') {
      assert.deepEqual(evidence.sourcePointCounts, mode === '2d' ? [11_000, 11_000, 11_000] : [11_000, 11_000], 'integer source centreline points must survive bucket extraction');
      assert.equal(evidence.uploadedVertices, mode === '2d' ? 132_000 : 88_000, 'both incoming and outgoing segment roles must survive Native upload for near-plane clipping across scene modes');
      assert.ok(evidence.indexDatatypes.includes(5125), 'Native must use UNSIGNED_INT indices for the large batch');
    }
    if (scenario === 'short-legs')
      assert.ok(evidence.shortLegMeters !== undefined && evidence.shortLegMeters > 0.005 && evidence.shortLegMeters < 0.03, 'the real integer source must preserve its centimetre-scale leg');
    assert.ok(evidence.textureBytes > 0 && evidence.geometryBytes > evidence.textureBytes, 'resource budget must include both real VA and Native texture allocations');
    assert.deepEqual(evidence.textureFormat, { pixelFormat: 36249, pixelDatatype: 5125 }, 'exact position records must use the actual Native RGBA32UI allocation');
    if (scenario === 'dense-lines' && mode === '2d')
      assert.ok(evidence.textureBytes < evidence.sourcePointCounts.reduce((count, points) => count + points * 48, 0), 'dense planar lines must omit common position prefixes from the real GPU texture');
    assert.ok(evidence.textureDestroyed, 'destroying the owner must release its Native geometry texture');
    assert.ok(evidence.cpuRecordsReleased, 'uploaded Native position textures must release their CPU record backing');
    if (scenario === 'curved')
      assert.ok(Object.values(evidence.isolation).every(Boolean), `owners must isolate texture uniforms while sharing Native programs: ${JSON.stringify(evidence.isolation)}`);
    assert.ok(evidence.attributes.includes('a_lineRecord'));
    assert.ok(!evidence.attributes.includes('position2DHigh') && !evidence.attributes.includes('position3DHigh') && !evidence.attributes.includes('prevOffset'));
    assert.ok(!evidence.attributes.includes('a_cornerParam'));
  });
}
