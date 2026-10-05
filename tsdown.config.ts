import { fileURLToPath } from 'node:url';
import { replacePlugin } from 'rolldown/plugins';
import { defineConfig } from 'tsdown';

const packageDirectory = fileURLToPath(new URL('./packages/cesium-vector-tileset', import.meta.url));

export default defineConfig({
  cwd: packageDirectory,
  entry: {
    index: 'index.ts',
    worker: 'src/worker/worker-entry.ts',
  },
  platform: 'browser',
  fixedExtension: true,
  minify: true,
  dts: { cwd: packageDirectory, entry: ['index.ts'] },
  sourcemap: true,
  tsconfig: '../../tsconfig.build.json',
  deps: {
    neverBundle: ['cesium'],
    alwaysBundle: [/^(?!cesium(?:\/|$))/],
    onlyBundle: false,
    dts: { neverBundle: true, alwaysBundle: [] },
  },
  outputOptions: {
    chunkFileNames: 'shared-[hash].mjs',
  },
  // Vite consumes the source URL; published modules load the bundled worker.
  plugins: [replacePlugin({ './worker-entry.ts': './worker.mjs' }, {
    delimiters: ['', ''],
    sourcemap: true,
  })],
});
