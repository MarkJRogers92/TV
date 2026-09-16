import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";

test("reports a healthy local service", async () => {
  // Must not fall back to ./data: that is the live data directory, and a running
  // MarkTV holds its database. With the app supervised by launchd it is always
  // running, so this test would otherwise wait out better-sqlite3's lock timeout
  // and fail on a healthy service.
  const app = await buildApp({
    dataDir: await mkdtemp(`${tmpdir()}/marktv-health-`),
  });
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "ok" });
  await app.close();
});
