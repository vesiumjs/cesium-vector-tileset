import { defineConfig } from 'taze';

export default defineConfig({
  recursive: true,
  write: true,
  install: true,
  mode: 'major',
  // Keep the Node.js version pin under manual control
  nodeVersion: false,
  // Keep the packageManager pin under manual control
  depFields: {
    packageManager: false,
  },
  exclude: [
    'typescript',
  ],
});
