import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
        resolve: {
          alias: process.env.E2E_CESIUM_BUILD === 'production'
            ? [{ find: /^cesium$/, replacement: path.join(path.dirname(createRequire(import.meta.url).resolve('cesium/package.json')), 'Build/Cesium/index.js') }]
            : [],
        },
        cacheDir: path.resolve('node_modules/.cache/playwright/vite', `${process.pid}-${workerInfo.workerIndex}`),
        optimizeDeps: {
          entries: [
            'index.html',
            'packages/cesium-vector-tileset/src/worker/tile.worker.ts',
            'e2e/fixtures/*.html',
          ],
        },
        plugins: process.env.E2E_BASELINE_DIR
          ? [{
              name: 'captured-performance-baseline',
              enforce: 'pre',
              async load(id) {
                // Vite generates the URL wrapper; freeze the worker module
                // itself when its worker_file request reaches this loader.
                if (new URLSearchParams(id.split('?')[1]).has('worker'))
                  return;
                const relative = path.relative(process.cwd(), id.split('?')[0]);
                if (!relative.startsWith('packages/cesium-vector-tileset/src/'))
                  return;
                try {
                  return await readFile(path.join(process.env.E2E_BASELINE_DIR!, relative), 'utf8');
                }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                }
              },
            }]
          : [],
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
