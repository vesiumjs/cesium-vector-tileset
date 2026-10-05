import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
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
