import process from 'node:process';
import { defineConfig } from 'playwright/test';

const live = process.env.E2E_LIVE === '1';
const hardware = process.env.E2E_GPU === 'hardware';

export default defineConfig({
  testDir: './e2e',
  outputDir: './node_modules/.cache/playwright/test-results',
  testMatch: '**/*.spec.ts',
  grep: live ? /@live/ : undefined,
  grepInvert: live ? undefined : /@live/,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './node_modules/.cache/playwright/report' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: hardware
        ? ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
