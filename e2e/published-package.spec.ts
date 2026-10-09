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
let files: string[];
let server: Server;
let consumerUrl: string;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cesium-vector-tileset-published-'));
  await run('pnpm', ['pack:lib', '--pack-destination', directory], { cwd: fileURLToPath(new URL('../', import.meta.url)) });
  const metadata = JSON.parse(await readFile(path.join(library, 'package.json'), 'utf8'));
  const archive = path.join(directory, `${metadata.name}-${metadata.version}.tgz`);
  const listing = await run('tar', ['-tf', archive]);
  files = listing.stdout.trim().split('\n').sort();
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
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

for (const specifier of ['cesium-vector-tileset', 'cesium-vector-tileset/min']) {
  for (const format of ['import', 'require']) {
    test(`packed ${specifier} loads with ${format} in Node without browser globals`, async () => {
      const script = `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      assert.equal(typeof document, 'undefined');
      assert.equal(typeof window, 'undefined');
      const api = process.argv[1] === 'require'
        ? createRequire(import.meta.url)(process.argv[2])
        : await import(process.argv[2]);
      assert.equal(typeof api.CesiumVectorTileset, 'function');
      assert.equal(typeof api.CesiumVectorTileset.fromUrl, 'function');
      console.log(JSON.stringify({loaded: true}));
    `;
      const { stdout } = await run(node, ['--input-type=module', '-e', script, format, specifier], { cwd: directory });
      assert.deepEqual(JSON.parse(stdout), { loaded: true });
    });
  }

  test(`${specifier} import and require share the published constructor`, async () => {
    const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    const imported = await import(process.argv[1]);
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

test('packed metadata includes Worker entries, shared modules and their runtime notices', async () => {
  const metadata = JSON.parse(await readFile(path.join(published, 'package.json'), 'utf8'));
  assert.deepEqual(metadata.exports['.'], {
    types: './dist/index.d.mts',
    default: './dist/index.mjs',
  });
  assert.deepEqual(metadata.exports['./min'], {
    types: './dist/index.d.mts',
    default: './dist/index.min.mjs',
  });
  assert.deepEqual(metadata.peerDependencies, { cesium: '^1.146.0' });
  assert.equal(metadata.peerDependencies.cesium, '^1.146.0');
  assert.equal(metadata.devDependencies.cesium, '^1.146.0');
  assert.equal(metadata.engines.node, '>=22.13.0');
  assert.equal(metadata.dependencies['@maplibre/mlt'], undefined, 'the bundled decoder must not require a consumer dependency');
  assert.deepEqual(Object.keys(metadata.exports), ['.', './min', './package.json']);
  const entries = ['index.mjs', 'index.min.mjs', 'worker.mjs', 'worker.min.mjs', 'geometry-worker.mjs', 'geometry-worker.min.mjs'];
  const workerChunks = files.filter(file => file.startsWith('package/dist/') && file.endsWith('.mjs') && !entries.includes(path.basename(file)));
  assert.ok(workerChunks.length > 0, 'the Worker entries should share their bundled CPU runtime');
  assert.ok(workerChunks.some(file => file.endsWith('.min.mjs')) && workerChunks.some(file => !file.endsWith('.min.mjs')));
  assert.ok(workerChunks.every(file => /^package\/dist\/[\w-]+(?:\.min)?\.mjs$/.test(file)));
  assert.deepEqual(files, [
    'package/LICENSE',
    'package/README.md',
    'package/README.zh-CN.md',
    'package/dist/THIRD_PARTY_NOTICES.txt',
    'package/dist/index.d.mts',
    'package/dist/index.d.mts.map',
    'package/dist/index.mjs.map',
    'package/package.json',
    ...entries.map(entry => `package/dist/${entry}`),
    ...workerChunks,
  ].sort());
  const notices = await readFile(path.join(published, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const dependency of ['cesium', '@cesium/engine', '@cesium/core'])
    assert.ok(notices.includes(`${dependency} (geometry Worker runtime and upstream notices)`));
});

test('plain modules retain readable JavaScript and minified modules use their matching Workers', async () => {
  for (const entry of ['index', 'worker', 'geometry-worker']) {
    const plain = await readFile(path.join(published, `dist/${entry}.mjs`), 'utf8');
    const minified = await readFile(path.join(published, `dist/${entry}.min.mjs`), 'utf8');
    assert.ok(plain.split('\n').length > 100, `${entry}.mjs was compressed`);
    assert.ok(minified.length < plain.length, `${entry}.min.mjs was not compressed`);
    if (entry === 'index') {
      for (const worker of ['worker', 'geometry-worker']) {
        assert.ok(plain.includes(`./${worker}.mjs`));
        assert.ok(minified.includes(`./${worker}.min.mjs`));
      }
    }
  }
});

test('packed READMEs retain gallery and documentation links outside the package', async () => {
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const readme = await readFile(path.join(published, name), 'utf8');
    const gallery = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
    assert.equal(gallery.length, 6);
    assert.ok(gallery.every(url => url.startsWith('https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/')));
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    for (const link of links.filter(link => link.startsWith('./')))
      assert.ok(files.includes(`package/${link.slice(2)}`), `${name} references an unpackaged file: ${link}`);
    assert.ok(links.includes('https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/architecture.md'));
  }
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
