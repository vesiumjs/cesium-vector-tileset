import { config } from '../util/config';

/**
 * Creates the worker used for off-main-thread tile processing.
 *
 * Uses Vite's worker loading pattern (https://vite.dev/guide/features#web-workers):
 * the `new URL(..., import.meta.url)` expression makes Vite bundle
 * `./worker-entry.ts` into a dedicated worker chunk and rewrite the URL at build time.
 * A worker is always constructed as a module worker; no classic-worker or
 * cross-origin fallbacks are performed.
 */
export function createWorker(): Worker {
  if (config.WORKER_URL) {
    return new Worker(config.WORKER_URL, { type: 'module' });
  }
  return new Worker(new URL('./worker-entry.ts', import.meta.url), { type: 'module' });
}
