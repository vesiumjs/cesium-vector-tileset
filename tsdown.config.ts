import { fileURLToPath } from 'node:url';
import { replacePlugin } from 'rolldown/plugins';
import { defineConfig } from 'tsdown';

const packageDirectory = fileURLToPath(new URL('./packages/cesium-vector-tileset', import.meta.url));

export default defineConfig([{
  cwd: packageDirectory,
  entry: 'index.ts',
  platform: 'browser',
  fixedExtension: true,
  minify: true,
  tsconfig: '../../tsconfig.build.json',
  deps: {
    alwaysBundle: [/^(?!cesium(?:\/|$))/],
    dts: { alwaysBundle: [] },
  },
  // Vite consumes the source URL; published modules load the bundled worker.
  plugins: [{
    name: 'geometry-worker-url',
    resolveId(id) {
      if (id.endsWith('/geometry-worker-entry.ts?worker&url'))
        return '\0geometry-worker-url';
    },
    load(id) {
      if (id === '\0geometry-worker-url')
        return 'export default new URL(\'./geometry-worker.mjs\', import.meta.url).href;';
    },
  }, replacePlugin({ './worker-entry.ts': './worker.mjs' }, {
    delimiters: ['', ''],
  })],
}, {
  cwd: packageDirectory,
  entry: {
    'worker': 'src/worker/worker-entry.ts',
    'geometry-worker': 'src/worker/geometry-worker-entry.ts',
  },
  platform: 'browser',
  fixedExtension: true,
  minify: true,
  dts: false,
  // Workers cannot inherit the document's import map.
  deps: { alwaysBundle: [/.*/] },
}]);
