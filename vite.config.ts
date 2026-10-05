import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import UnpluginCesium from 'unplugin-cesium/vite';
import { defineConfig } from 'vite';

const base = '/cesium-vector-tileset/';

export default defineConfig({
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
});
