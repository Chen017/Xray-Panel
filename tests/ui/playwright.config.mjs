import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/ui',
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  use: {
    actionTimeout: 8_000,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    ['desktop', devices['Desktop Chrome']],
    ['android', devices['Pixel 7']],
    ['iphone', devices['iPhone 13']],
  ].flatMap(([name, device]) => ['light', 'dark'].map(colorScheme => ({
    name: `${name}-${colorScheme}`,
    use: { ...device, colorScheme },
  }))),
});
