import { defineConfig } from 'vitest/config';

const base = '/cesium-vector-tileset/';

export default defineConfig({
  base,
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: `http://localhost${base}`,
        pretendToBeVisual: true,
      },
    },
    setupFiles: [
      'vitest-webgl-canvas-mock',
    ],
    include: [
      'packages/cesium-vector-tileset/src/**/__test__/*.test.ts',
      'src/**/__test__/*.test.ts',
    ],
  },
});
