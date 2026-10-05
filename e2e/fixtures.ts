import path from 'node:path';
import process from 'node:process';
import { fromGeojsonVt as encodeTile } from '@maplibre/vt-pbf';
import { test as base } from 'playwright/test';
import { createServer } from 'vite';

export { GeoJSONVT } from '@maplibre/geojson-vt';
// geojson-vt's tile type intersects pre-transform and integer geometries.
// The encoder consumes the transformed geometry below, also used by fixtures.
export const fromGeojsonVt = encodeTile as unknown as (
  layers: Record<string, { features: Array<{
    type: number;
    geometry: number[][] | number[][][];
    tags?: Record<string, unknown>;
    id?: string | number;
  }>; }>,
  options?: { extent?: number; version?: number },
) => Uint8Array;

export const test = base.extend<{ cpuThrottle: void }, { renderUrl: string }>({
  cpuThrottle: [
    async ({ page }, use) => {
      const session = process.env.E2E_CPU_RATE ? await page.context().newCDPSession(page) : undefined;
      if (session)
        await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_RATE) });
      try {
        await use();
      }
      finally {
        await session?.detach();
      }
    },
    { auto: true },
  ],
  renderUrl: [
    // Playwright requires a destructured first argument even without dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      if (process.env.RENDER_URL) {
        await use(process.env.RENDER_URL);
        return;
      }
      const server = await createServer({
        cacheDir: path.resolve('node_modules/.cache/playwright/vite', `${process.pid}-${workerInfo.workerIndex}`),
        optimizeDeps: {
          entries: [
            'index.html',
            'packages/cesium-vector-tileset/src/worker/worker-entry.ts',
            'e2e/fixtures/*.html',
          ],
        },
        server: { host: '127.0.0.1', port: 0, hmr: false },
      });
      try {
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === 'string')
          throw new Error('E2E render server did not expose a TCP address');
        await use(`http://127.0.0.1:${address.port}${server.config.base.replace(/\/$/, '')}`);
      }
      finally {
        await server.close();
      }
    },
    { scope: 'worker' },
  ],
});
