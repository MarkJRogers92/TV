import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildApp } from "../../src/server/app.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function stubTunarr(programsByLibrary: Record<string, unknown>) {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/system/health"))
      return new Response(JSON.stringify({ database: { type: "healthy" } }), {
        status: 200,
      });
    if (url.endsWith("/api/version"))
      return new Response(
        JSON.stringify({ tunarr: "1.3.14", ffmpeg: "7", nodejs: "22" }),
        { status: 200 },
      );
    if (url.endsWith("/api/channels"))
      return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/filler-lists"))
      return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/transcode_configs"))
      return new Response(JSON.stringify([]), { status: 200 });
    const match = url.match(/\/api\/media-libraries\/([^/]+)\/programs$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (id in programsByLibrary)
        return new Response(JSON.stringify(programsByLibrary[id]), {
          status: 200,
        });
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify({ error: "missing" }), {
      status: 404,
    });
  }) as typeof fetch;
  vi.stubGlobal("fetch", stub);
}

function localProgram(id: string, path: string) {
  return {
    type: "content",
    id,
    duration: 60_000,
    program: {
      uuid: "11111111-1111-4111-8111-111111111111",
      mediaItem: { locations: [{ type: "local", path }] },
    },
  };
}

test("accepts multiple libraryIds and aggregates inventory for connection test", async () => {
  stubTunarr({
    "lib-a": [localProgram("a1", "/media/A.mkv")],
    "lib-b": [localProgram("b1", "/media/B.mkv")],
  });
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/test",
      payload: { url: "http://fake", libraryIds: ["lib-a", "lib-b"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supportsInventory: true });
  } finally {
    await app.close();
  }
});

test("trims and deduplicates library IDs into canonical form", async () => {
  stubTunarr({
    "lib-a": [localProgram("a1", "/media/A.mkv")],
    "lib-b": [localProgram("b1", "/media/B.mkv")],
  });
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/test",
      payload: { url: "http://fake", libraryIds: [" lib-a ", "lib-a", "lib-b "] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supportsInventory: true });
  } finally {
    await app.close();
  }
});

test("keeps legacy singular libraryId backward compatible for dry-run validation", async () => {
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const legacy = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: { url: "http://127.0.0.1:1", libraryId: "lib" },
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({ code: "NO_SCHEDULE" });
    const canonical = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: { url: "http://127.0.0.1:1", libraryIds: ["lib"] },
    });
    expect(canonical.statusCode).toBe(409);
    expect(canonical.json()).toMatchObject({ code: "NO_SCHEDULE" });
  } finally {
    await app.close();
  }
});

test("fails closed when any library endpoint is invalid", async () => {
  stubTunarr({
    good: [localProgram("good1", "/media/Good.mkv")],
  });
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/test",
      payload: { url: "http://fake", libraryIds: ["good", "missing"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supportsInventory: false });
  } finally {
    await app.close();
  }
});
