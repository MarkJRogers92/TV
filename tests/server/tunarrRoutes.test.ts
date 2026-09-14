import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildApp } from "../../src/server/app.js";

test("returns stable 4xx/503 responses instead of exposing Tunarr failures", async () => {
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  const missingPlan = await app.inject({
    method: "POST",
    url: "/api/v1/tunarr/sync",
  });
  expect(missingPlan.statusCode).toBe(409);
  expect(missingPlan.json()).toEqual({ code: "STALE_DRY_RUN" });
  const unavailable = await app.inject({
    method: "POST",
    url: "/api/v1/tunarr/test",
    payload: { url: "http://127.0.0.1:1", channelId: "7" },
  });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json()).toMatchObject({ code: "UNREACHABLE" });
  await app.close();
});
