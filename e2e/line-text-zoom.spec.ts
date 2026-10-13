import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test.use({ deviceScaleFactor: 1, viewport: { width: 1254, height: 710 } });

test('actual CJK line text retains glyph quad shapes when zooming near the ground', async ({ page, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_GPU !== 'hardware', 'Small-angle GPU precision requires actual hardware');
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request().url();
    if (request.startsWith('http') && new URL(request).origin !== new URL(renderUrl).origin) {
      remoteRequests.push(request);
      await route.abort();
    }
    else {
      await route.continue();
    }
  });
  await page.goto(`${renderUrl}/e2e/fixtures/line-text-zoom-fixture.html`);
  const captures: Awaited<ReturnType<Window['lineTextZoom']['capture']>>[] = [];
  for (const height of [650.22, 71.98]) {
    await expect.poll(() => page.evaluate(() => !!window.lineTextZoom)).toBe(true);
    await page.evaluate(height => window.lineTextZoom.setHeight(height), height);
    await expect.poll(() => page.evaluate(() => window.lineTextZoom.ready()), { timeout: 60_000 }).toBe(true);
    captures.push(await page.evaluate(() => window.lineTextZoom.capture()));
    await page.screenshot({ path: testInfo.outputPath(`line-text-${height}.png`) });
  }
  await writeFile(testInfo.outputPath('line-text-feedback.json'), JSON.stringify(captures, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, [], 'CJK glyphs must render locally without remote resources');
  for (const capture of captures) {
    assert.deepEqual(capture.errors, []);
    assert.ok(!/swiftshader|llvmpipe|software/i.test(capture.gpu), capture.gpu);
    assert.ok(capture.ink > 30, `${capture.height}m: actual SDF text must draw ink`);
    // The actual triangle indices identify exactly the nine drawn glyph quads.
    const starts = new Set(capture.indices.map(vertex => Math.floor(vertex / 4) * 4));
    assert.equal(starts.size, 9, 'The real worker must draw all nine CJK glyphs');
    for (const start of starts) {
      const clip = [0, 1, 3, 2].map(corner => capture.clip[start + corner]);
      assert.ok(clip.every(corner => corner.every(Number.isFinite) && corner[3] > 0), `${capture.height}m glyph ${start / 4}: finite real clip corners`);
      const corners = clip.map(([x, y, , w]) => [x / w * capture.viewport[2] / 2, y / w * capture.viewport[3] / 2]);
      const edges = corners.map((a, index) => {
        const b = corners[(index + 1) % 4];
        return [b[0] - a[0], b[1] - a[1]];
      });
      const lengths = edges.map(([x, y]) => Math.hypot(x, y));
      assert.ok(lengths.every(length => length > 1 && length < 40), `${capture.height}m glyph ${start / 4}: nondegenerate 14px glyph edges ${lengths}`);
      const turns = edges.map((a, index) => {
        const b = edges[(index + 1) % 4];
        return a[0] * b[1] - a[1] * b[0];
      });
      assert.ok(turns.every(turn => turn > 0) || turns.every(turn => turn < 0), `${capture.height}m glyph ${start / 4}: real quad must not fold`);
      for (let edge = 0; edge < 2; edge++) {
        const opposite = edge + 2;
        const cosine = (edges[edge][0] * edges[opposite][0] + edges[edge][1] * edges[opposite][1]) / (lengths[edge] * lengths[opposite]);
        assert.ok(cosine < -0.99, `${capture.height}m glyph ${start / 4}: opposite edges became skewed (${cosine})`);
      }
    }
  }
});
