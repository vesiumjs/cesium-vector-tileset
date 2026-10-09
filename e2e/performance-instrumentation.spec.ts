import { expect } from 'playwright/test';
import { test } from './fixtures';

for (const [name, parameters, diagnostics] of [
  ['city timing', { cityPerf: '1' }, false],
  ['explicit city diagnostics', { cityPerf: '1', cityStages: '1' }, true],
  ['ordinary render validation', {}, true],
] as const) {
  test(`${name} keeps only its requested instrumentation`, async ({ page, renderUrl }) => {
    await page.route('**/instrumentation-style.json', route => route.fulfill({ json: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#183040' } }],
    } }));
    const query = new URLSearchParams({
      style: `${renderUrl}/instrumentation-style.json`,
      readback: '0',
      ...parameters,
    });
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.stats().submittedCommands ?? 0)).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const { viewer } = window.renderValidation;
      for (let step = 0; step < 3; step++) {
        viewer.camera.zoomIn(10);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    });
    const state = await page.evaluate(() => {
      const { measurements, renderedFrames, tileset, renderErrors } = window.renderValidation;
      return {
        renderedFrames,
        updates: measurements.updateMs.length,
        sources: measurements.sourceMs.length,
        frames: measurements.frames.length,
        ownUpdate: Object.hasOwn(tileset, 'update'),
        ownEvaluate: Object.hasOwn(tileset._renderer.evaluation, 'evaluate'),
        motionFrames: window.cityMotion?.snapshot().frames.length,
        renderErrors,
      };
    });
    expect(state.renderedFrames).toBeGreaterThan(1);
    expect(state.renderErrors).toEqual([]);
    expect(state.ownUpdate).toBe(diagnostics);
    expect(state.ownEvaluate).toBe(diagnostics);
    if (diagnostics) {
      expect(state.updates).toBeGreaterThan(0);
      expect(state.frames).toBeGreaterThan(0);
    }
    else {
      expect(state.updates).toBe(0);
      expect(state.sources).toBe(0);
      expect(state.frames).toBe(0);
    }
    if ('cityPerf' in parameters)
      expect(state.motionFrames).toBeGreaterThan(1);
  });
}
