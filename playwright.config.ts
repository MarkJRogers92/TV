import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4177", browserName: "chromium" },
  webServer: {
    command: "npm run build && node scripts/playwright-server.mjs",
    url: "http://127.0.0.1:4177/api/v1/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
