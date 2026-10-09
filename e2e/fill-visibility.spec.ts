import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

test('non-draped fills cull actual offscreen content and retain Native pixels, picking and cached arrays', async ({ page, renderUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const style = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#224455' } }] } satisfies StyleSpecification;
  await page.route('**/fill-visibility/style.json', route => route.fulfill({ json: style }));
  const query = new URLSearchParams({ style: `${renderUrl}/fill-visibility/style.json`, fillVisibility: '1', cityPerf: '1', motionBaseline: '1', antialias: '0', scale: '0.25', readback: '0' });
  await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
  await expect.poll(() => page.evaluate(() => !!window.renderValidation?.tileset.tilesLoaded)).toBe(true);
  await page.evaluate(() => window.fillVisibility.create());
  await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded), { timeout: 60_000 }).toBe(true);
  try {
    const samples = [];
    for (const inside of [false, true, false, true]) {
      await page.evaluate(inside => window.fillVisibility.move(inside), inside);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded), { timeout: 60_000 }).toBe(true);
      const sample = await page.evaluate(async () => {
        const reference = await window.fillVisibility.sample(true);
        const current = await window.fillVisibility.sample();
        let differences = 0;
        for (let index = 0; index < current.pixels.length; index++)
          differences += Number(current.pixels[index] !== reference.pixels[index]);
        return { ...current, pixels: undefined, referenceDraws: reference.draws, differences };
      });
      samples.push({ inside, ...sample });
    }
    await writeFile(testInfo.outputPath('fill-visibility.json'), JSON.stringify(samples, null, 2));
    expect(samples[0].owners).toBeGreaterThan(0);
    expect(samples[0].referenceDraws).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.differences).toBe(0);
      expect(sample.stable).toBe(true);
      expect(sample.enclosed).toBe(true);
      if (sample.inside) {
        expect(sample.draws).toBeGreaterThan(0);
        expect(sample.green).toBeGreaterThan(100);
        expect(sample.picked).toBe('visibility-fill');
      }
      else {
        expect(sample.green).toBe(0);
        expect(sample.draws).toBe(0);
      }
    }
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.renderValidation.renderErrors)).toEqual([]);
  }
  finally {
    await page.evaluate(() => window.fillVisibility.dispose());
  }
});
