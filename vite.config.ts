import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import UnpluginCesium from 'unplugin-cesium/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command, isPreview }) => {
  const base = process.env.VITE_BASE_PATH ?? (command === 'build' || isPreview ? '/cesium-vector-tileset/' : '/');

  return {
    base,
    plugins: [
      vue(),
      UnpluginCesium({ base }),
    ],
    define: {
      global: 'globalThis',
      globalThis: 'globalThis',
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('src', import.meta.url)),
      },
    },
    optimizeDeps: {
      // Discover decoder dependencies before live module Workers request them.
      entries: ['index.html', 'packages/cesium-vector-tileset/src/worker/worker-entry.ts'],
    },
    worker: {
      format: 'es',
    },
  };
});
