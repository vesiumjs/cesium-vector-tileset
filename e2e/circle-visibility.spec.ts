import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

for (const dataDriven of [false, true]) {
  test(`3D ${dataDriven ? 'data-driven' : 'constant'} circle retains pixels beyond a culled tile sphere`, async ({ page, renderUrl }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const style = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#224455' } }] } satisfies StyleSpecification;
    await page.route('**/circle-visibility/style.json', route => route.fulfill({ json: style }));
    const query = new URLSearchParams({ style: `${renderUrl}/circle-visibility/style.json`, circleVisibility: '1', cityPerf: '1', antialias: '0', readback: '0' });
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => !!window.renderValidation?.tileset.tilesLoaded)).toBe(true);
    await page.evaluate(driven => window.circleVisibility.create(driven), dataDriven);
    await expect.poll(() => page.evaluate(() => window.circleVisibility.ready()), { timeout: 60_000 }).toBe(true);
    const samples = [];
    try {
      for (const phase of [
        { name: 'inside-small', inside: true, radius: 8, stroke: 0 },
        { name: 'outside-small', inside: false, radius: 8, stroke: 0 },
        { name: 'outside-large', inside: false, radius: 96, stroke: 0 },
        { name: 'outside-stroke', inside: false, radius: 8, stroke: 96 },
        { name: 'inside-near-clipped', inside: true, radius: 96, stroke: 0 },
        { name: 'inside-restored', inside: true, radius: 8, stroke: 0 },
      ]) {
        await page.evaluate(({ radius, stroke }) => window.circleVisibility.paint(radius, stroke), phase);
        await expect.poll(() => page.evaluate(() => window.circleVisibility.material())).toEqual({ size: phase.radius * 2, stroke: phase.stroke });
        await page.evaluate(inside => window.circleVisibility.move(inside), phase.inside);
        if (phase.name === 'inside-near-clipped')
          await page.evaluate(() => window.circleVisibility.clipNear());
        const sample = await page.evaluate(async () => {
          const reference = await window.circleVisibility.sample(true);
          const current = await window.circleVisibility.sample();
          let differences = 0;
          for (let index = 0; index < current.pixels.length; index++)
            differences += Number(current.pixels[index] !== reference.pixels[index]);
          return { reference: { ...reference, pixels: undefined }, current: { ...current, pixels: undefined }, differences };
        });
        samples.push({ ...phase, ...sample });
      }
      const boundary = samples.filter(sample => sample.name === 'outside-large' || sample.name === 'outside-stroke');
      const status = boundary.every(sample => sample.reference.edgeGreen > 0)
        ? 'native-edge-positive-control-established'
        : 'unsupported-native-wide-point-edge-positive-control';
      await writeFile(testInfo.outputPath('circle-visibility.json'), JSON.stringify({ status, dataDriven, samples, errors, renderErrors: await page.evaluate(() => window.renderValidation.renderErrors) }, null, 2));
      expect(status, 'Native backend did not render the offscreen-center reference; inspect circle-visibility.json rather than treating this as a culling success').toBe('native-edge-positive-control-established');
      for (const sample of samples) {
        expect(sample.current.ownerCount).toBe(1);
        expect(sample.current.loadsAfterUpload).toBe(0);
        expect(sample.current.centerEnclosed).toBe(true);
        expect(sample.reference.stable && sample.current.stable).toBe(true);
        expect(sample.reference.boundsUnchanged && sample.current.boundsUnchanged).toBe(true);
        expect(sample.current.shown).toBe(true);
        if (sample.name === 'inside-near-clipped') {
          expect(sample.reference.green).toBe(0);
          expect(sample.current.green).toBe(0);
          expect(sample.differences).toBe(0);
        }
        else if (sample.inside) {
          expect(sample.current.green).toBeGreaterThan(20);
          expect(sample.current.picked).toBe('visibility-circle');
          expect(sample.differences).toBe(0);
        }
        else {
          expect(sample.current.visibility).toBe(-1);
          expect(sample.current.center!.x).toBeLessThan(0);
          if (sample.name === 'outside-small') {
            expect(sample.reference.draws).toBeGreaterThan(0);
            expect(sample.reference.green).toBe(0);
            expect(sample.current.green).toBe(0);
          }
          else {
            expect(sample.reference.draws).toBeGreaterThan(0);
            expect(sample.reference.edgeGreen).toBeGreaterThan(0);
            expect(sample.reference.picked).toBe('visibility-circle');
            expect(sample.current.edgeGreen, `${sample.name}: default Native CPU culling lost the established edge pixels`).toBe(sample.reference.edgeGreen);
            expect(sample.differences).toBe(0);
          }
        }
      }
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => window.renderValidation.renderErrors)).toEqual([]);
    }
    finally { await page.evaluate(() => window.circleVisibility.dispose()); }
  });
}
