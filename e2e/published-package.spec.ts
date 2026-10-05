import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'playwright/test';

const run = promisify(execFile);
const node = process.env.E2E_PACKAGE_NODE ?? process.execPath;
const library = fileURLToPath(new URL('../packages/cesium-vector-tileset/', import.meta.url));
let directory: string;
let published: string;
let files: string[];

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cesium-vector-tileset-published-'));
  await run('pnpm', ['pack', '--pack-destination', directory], { cwd: library });
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
});

test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

for (const format of ['import', 'require']) {
  test(`packed package loads with ${format} in Node without browser globals`, async () => {
    const script = `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      assert.equal(typeof document, 'undefined');
      assert.equal(typeof window, 'undefined');
      const api = process.argv[1] === 'require'
        ? createRequire(import.meta.url)('cesium-vector-tileset')
        : await import('cesium-vector-tileset');
      assert.equal(typeof api.CesiumVectorTileset, 'function');
      assert.equal(typeof api.CesiumVectorTileset.fromUrl, 'function');
      console.log(JSON.stringify({loaded: true}));
    `;
    const { stdout } = await run(node, ['--input-type=module', '-e', script, format], { cwd: directory });
    assert.deepEqual(JSON.parse(stdout), { loaded: true });
  });
}

test('import and require share the published constructor', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    const imported = await import('cesium-vector-tileset');
    const required = createRequire(import.meta.url)('cesium-vector-tileset');
    assert.equal(imported.CesiumVectorTileset, required.CesiumVectorTileset);
  `;
  await run(node, ['--input-type=module', '-e', script], { cwd: directory });
});

test('packed declarations resolve for ESM and CommonJS TypeScript consumers', async () => {
  const esm = path.join(directory, 'consumer.mts');
  const cjs = path.join(directory, 'consumer.cts');
  await writeFile(esm, `import {CesiumVectorTileset} from 'cesium-vector-tileset';
    const create: typeof CesiumVectorTileset.fromUrl = CesiumVectorTileset.fromUrl;
    void create;
  `);
  await writeFile(cjs, `import api = require('cesium-vector-tileset');
    const create: typeof api.CesiumVectorTileset.fromUrl = api.CesiumVectorTileset.fromUrl;
    void create;
  `);
  const tsc = createRequire(import.meta.url).resolve('typescript/lib/tsc');
  await run(node, [tsc, '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--target', 'ES2022', esm, cjs], { cwd: directory });
});

test('packed metadata includes one typed entry, worker, shared module and licenses', async () => {
  const metadata = JSON.parse(await readFile(path.join(published, 'package.json'), 'utf8'));
  assert.deepEqual(metadata.exports['.'], {
    types: './dist/index.d.mts',
    default: './dist/index.mjs',
  });
  assert.equal(metadata.peerDependencies.cesium, '1.146.0');
  assert.equal(metadata.engines.node, '>=22.13.0');
  assert.equal(metadata.dependencies['@maplibre/mlt'], undefined, 'the bundled decoder must not require a consumer dependency');
  assert.deepEqual(Object.keys(metadata.exports), ['.', './package.json']);
  const shared = files.filter(file => /^package\/dist\/shared-[\w-]+\.mjs$/.test(file));
  assert.equal(shared.length, 1, 'main and worker must share one published module');
  assert.deepEqual(files, [
    'package/LICENSE',
    'package/THIRD_PARTY_NOTICES.txt',
    'package/dist/index.d.mts',
    'package/dist/index.d.mts.map',
    'package/dist/index.mjs',
    'package/dist/index.mjs.map',
    'package/dist/worker.mjs',
    'package/dist/worker.mjs.map',
    shared[0],
    `${shared[0]}.map`,
    'package/package.json',
  ].sort());
});
