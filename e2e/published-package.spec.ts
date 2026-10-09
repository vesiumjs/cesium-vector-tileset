import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'playwright/test';

const run = promisify(execFile);
const node = process.env.E2E_PACKAGE_NODE ?? process.execPath;
const library = fileURLToPath(new URL('../packages/cesium-vector-tileset/', import.meta.url));
let directory: string;
let published: string;
let server: Server;
let consumerUrl: string;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cesium-vector-tileset-published-'));
  await run('pnpm', ['build:ci'], { cwd: fileURLToPath(new URL('../', import.meta.url)) });
  await run('pnpm', ['pack', '--pack-destination', directory], { cwd: library });
  const metadata = JSON.parse(await readFile(path.join(library, 'package.json'), 'utf8'));
  const archive = path.join(directory, `${metadata.name}-${metadata.version}.tgz`);
  await run('tar', ['-xzf', archive, '-C', directory]);
  published = path.join(directory, 'package');
  // Reuse installed dependencies while loading the actual packed files. The
  // child process uses Node resolution, without Vite or a DOM shim.
  await symlink(path.join(library, 'node_modules'), path.join(published, 'node_modules'), 'dir');
  await mkdir(path.join(directory, 'node_modules'));
  await symlink(published, path.join(directory, 'node_modules', 'cesium-vector-tileset'), 'dir');
  const cesiumDirectory = path.dirname(createRequire(path.join(library, 'package.json')).resolve('cesium'));
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    response.setHeader('access-control-allow-origin', '*');
    try {
      if (pathname === '/consumer.html') {
        const cdn = new URL(consumerUrl);
        cdn.hostname = 'localhost';
        response.setHeader('content-type', 'text/html');
        response.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'nonce-packed' 'unsafe-eval' 'wasm-unsafe-eval' ${cdn.origin}; worker-src 'self' blob: ${cdn.origin}; connect-src 'self' ${cdn.origin}`);
        response.end(`<!doctype html><script nonce="packed" type="importmap">{"imports":{"cesium":"/cesium/index.js"}}</script><script type="module" src="/consumer.js"></script>`);
        return;
      }
      const filename = pathname === '/consumer.js'
        ? fileURLToPath(new URL('./fixtures/published-geometry-worker-fixture.js', import.meta.url))
        : pathname.startsWith('/package/dist/')
          ? path.join(published, pathname.slice('/package/'.length))
          : pathname.startsWith('/cesium/')
            ? path.join(cesiumDirectory, 'Build/Cesium', pathname.slice('/cesium/'.length))
            : undefined;
      if (!filename) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/javascript');
      response.end(await readFile(filename));
    }
    catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  consumerUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

for (const specifier of ['cesium-vector-tileset', 'cesium-vector-tileset/min']) {
  test(`${specifier} import and require share the published constructor`, async () => {
    const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
    const imported = await import(process.argv[1]);
    assert.equal(typeof imported.CesiumVectorTileset.fromUrl, 'function');
    const required = createRequire(import.meta.url)(process.argv[1]);
    assert.equal(imported.CesiumVectorTileset, required.CesiumVectorTileset);
  `;
    await run(node, ['--input-type=module', '-e', script, specifier], { cwd: directory });
  });
}

test('packed declarations resolve for ESM and CommonJS TypeScript consumers', async () => {
  const esm = path.join(directory, 'consumer.mts');
  const cjs = path.join(directory, 'consumer.cts');
  await writeFile(esm, `import {CesiumVectorTileset} from 'cesium-vector-tileset';
    import {CesiumVectorTileset as MinifiedTileset} from 'cesium-vector-tileset/min';
    const create: typeof CesiumVectorTileset.fromUrl = CesiumVectorTileset.fromUrl;
    const createMinified: typeof CesiumVectorTileset.fromUrl = MinifiedTileset.fromUrl;
    void create;
    void createMinified;
  `);
  await writeFile(cjs, `import api = require('cesium-vector-tileset');
    import minified = require('cesium-vector-tileset/min');
    const create: typeof api.CesiumVectorTileset.fromUrl = api.CesiumVectorTileset.fromUrl;
    const createMinified: typeof api.CesiumVectorTileset.fromUrl = minified.CesiumVectorTileset.fromUrl;
    void create;
    void createMinified;
  `);
  const tsc = createRequire(import.meta.url).resolve('typescript/lib/tsc');
  await run(node, [tsc, '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--target', 'ES2022', esm, cjs], { cwd: directory });
});

for (const suffix of ['', '.min']) {
  test(`raw packed geometry-worker${suffix} prepares line payload across CDN with explicit CSP and no Worker import map`, async ({ page }) => {
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${consumerUrl}/consumer.html?minify=${suffix === '.min'}`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { publishedGeometryResult?: object }).publishedGeometryResult), { timeout: 15000 }).toBeTruthy();
    const result = await page.evaluate(() => (window as unknown as { publishedGeometryResult: { error?: string; mainConstructor: boolean; indices: number[]; attributes: string[]; textureBytes: number; doubleBounds: boolean; sourceIntact: boolean; taskCount: number; detached: boolean; terminated: number; bootstrapRevoked: boolean } }).publishedGeometryResult);
    assert.equal(result.error, undefined);
    assert.equal(result.mainConstructor, true);
    assert.ok(result.indices.length > 0 && result.attributes.includes('a_lineRecord'));
    assert.ok(result.textureBytes > 0 && result.doubleBounds && result.sourceIntact && result.detached);
    assert.equal(result.taskCount, 1);
    assert.equal(result.terminated, 1);
    assert.equal(result.bootstrapRevoked, true);
    assert.deepEqual(errors, []);
    assert.ok(requests.some(url => new URL(url).hostname === 'localhost' && url.endsWith(`/package/dist/geometry-worker${suffix}.mjs`)));
    assert.ok(!requests.some(url => /(?:createGeometry|combineGeometry)\.js/.test(url)));
    const workerModules = requests.filter(url => new URL(url).pathname.startsWith('/package/dist/') && !url.endsWith(`/index${suffix}.mjs`));
    assert.ok(workerModules.some(url => !url.endsWith(`/geometry-worker${suffix}.mjs`)), 'the geometry Worker did not load its shared runtime');
    assert.ok(workerModules.every(url => new URL(url).hostname === 'localhost'), 'a Worker module escaped its CDN origin');
    assert.ok(workerModules.every(url => url.endsWith('.min.mjs') === (suffix === '.min')), 'the geometry Worker loaded the other build variant');
  });

  test(`raw packed worker${suffix} handles style messages without a Worker import map`, async ({ page }) => {
    await page.goto(`${consumerUrl}/consumer.html?minify=${suffix === '.min'}`);
    const result = await page.evaluate(suffix => new Promise<{ type?: string; error?: string }>((resolve) => {
      const worker = new Worker(`/package/dist/worker${suffix}.mjs`, { type: 'module' });
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (result: { type?: string; error?: string }) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(result);
      };
      timeout = setTimeout(finish, 10000, { error: 'data Worker did not answer' });
      worker.onerror = event => finish({ error: event.message || 'data Worker failed to load' });
      worker.onmessage = event => finish({ type: event.data.type, error: event.data.error?.message });
      worker.postMessage({ id: 'packed-style', type: 'SL', sourceMapId: 'packed-consumer', origin: location.origin, data: [] });
    }), suffix);
    expect(result.error).toBeUndefined();
    expect(result.type).toBe('<response>');
  });
}
