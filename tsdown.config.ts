import type { UserConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';
import { replacePlugin } from 'rolldown/plugins';
import { defineConfig } from 'tsdown';

const packageDirectory = fileURLToPath(new URL('./packages/cesium-vector-tileset', import.meta.url));

export default defineConfig([false, true].flatMap<UserConfig>((minify) => {
  const extension = minify ? '.min.mjs' : '.mjs';
  const output = {
    cwd: packageDirectory,
    platform: 'browser' as const,
    minify,
    outExtensions: () => ({ js: extension }),
  };
  return [{
    ...output,
    entry: 'index.ts',
    dts: !minify,
    tsconfig: '../../tsconfig.build.json',
    deps: {
      alwaysBundle: [/^(?!cesium(?:\/|$))/],
      dts: { alwaysBundle: [] },
    },
    // Vite consumes the source URL; published modules load the bundled worker.
    plugins: [{
      name: 'geometry-worker-url',
      resolveId(id) {
        if (id.endsWith('/geometry.worker.ts?worker&url'))
          return '\0geometry-worker-url';
      },
      load(id) {
        if (id === '\0geometry-worker-url')
          return `export default new URL('./geometry-worker${extension}', import.meta.url).href;`;
      },
    }, replacePlugin({ './tile.worker.ts': `./worker${extension}` }, {
      delimiters: ['', ''],
    })],
  }, {
    ...output,
    entry: {
      'worker': 'src/worker/tile.worker.ts',
      'geometry-worker': 'src/worker/geometry.worker.ts',
    },
    dts: false,
    // Workers cannot inherit the document's import map.
    deps: { alwaysBundle: [/.*/] },
  }];
}));
