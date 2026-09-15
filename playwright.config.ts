import { defineConfig } from "@playwright/test";

const port = process.env.MARKTV_PLAYWRIGHT_PORT ?? "4177";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  use: { baseURL, browserName: "chromium" },
  webServer: {
    command: "npm run build && node scripts/playwright-server.mjs",
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
