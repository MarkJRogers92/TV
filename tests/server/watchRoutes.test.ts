import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { watchProxyLimits } from "../../src/server/routes/watch.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("explains when live TV has not been connected to a Tunarr channel", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-watch-route-"));
  directories.push(dataDir);
  const app = await buildApp({ dataDir });

  const response = await app.inject("/api/v1/watch/marktv-laughs/stream.m3u8");

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    code: "LIVE_TV_NOT_CONFIGURED",
    message: "Sync this MarkTV channel with Tunarr before watching live TV",
  });
  await app.close();
});

test("respects the channel stream mode and rewrites the Tunarr HLS stream for the browser", async () => {
  const upstream = createServer((request, response) => {
    if (request.url === "/stream/channels/tunarr-channel.m3u8") {
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end(
        "#EXTM3U\n/stream/channels/tunarr-channel/hls/stream.m3u8\n",
      );
      return;
    }
    if (request.url === "/stream/channels/tunarr-channel/hls/stream.m3u8") {
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\ndata000001.ts\n',
      );
      return;
    }
    if (request.url === "/stream/channels/tunarr-channel/hls/data000001.ts") {
      response.setHeader("content-type", "video/mp2t");
      response.end(Buffer.from([0x47, 0x40, 0x00, 0x10]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");

  const dataDir = await mkdtemp(join(tmpdir(), "marktv-watch-route-"));
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  repositories.settings.put("tunarr-mapping", {
    url: `http://127.0.0.1:${address.port}`,
    marktvChannelId: "marktv-laughs",
    channelId: "tunarr-channel",
  });
  repositories.close();
  const app = await buildApp({ dataDir });

  const master = await app.inject("/api/v1/watch/marktv-laughs/stream.m3u8");
  expect(master.statusCode).toBe(200);
  expect(master.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
  expect(master.body).toBe(
    "#EXTM3U\n/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/stream.m3u8\n",
  );

  const child = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/stream.m3u8",
  );
  expect(child.statusCode).toBe(200);
  expect(child.body).toBe(
    '#EXTM3U\n#EXT-X-MAP:URI="/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/init.mp4"\n#EXTINF:4.0,\n/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/data000001.ts\n',
  );

  const segment = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/data000001.ts",
  );
  expect(segment.statusCode).toBe(200);
  expect(segment.rawPayload).toEqual(Buffer.from([0x47, 0x40, 0x00, 0x10]));

  const vlcPlaylist = await app.inject(
    "/api/v1/watch/marktv-laughs/marktv-live.m3u",
  );
  expect(vlcPlaylist.statusCode).toBe(200);
  expect(vlcPlaylist.headers["content-disposition"]).toBe(
    'attachment; filename="MarkTV-Live.m3u"',
  );
  expect(vlcPlaylist.body).toBe(
    `#EXTM3U\n#EXTINF:-1,MarkTV Live\nhttp://127.0.0.1:${address.port}/stream/channels/tunarr-channel.m3u8\n`,
  );

  await app.close();
  await new Promise<void>((resolve, reject) =>
    upstream.close((error) => (error ? reject(error) : resolve())),
  );
});

test("does not follow Tunarr redirects to another server", async () => {
  const redirectTarget = createServer((_request, response) => {
    response.setHeader("content-type", "application/vnd.apple.mpegurl");
    response.end("#EXTM3U\n");
  });
  await new Promise<void>((resolve) =>
    redirectTarget.listen(0, "127.0.0.1", resolve),
  );
  const redirectAddress = redirectTarget.address();
  if (!redirectAddress || typeof redirectAddress === "string")
    throw new Error("Missing redirect target address");

  const upstream = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader(
      "location",
      `http://127.0.0.1:${redirectAddress.port}/outside.m3u8`,
    );
    response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("Missing upstream address");

  const dataDir = await mkdtemp(join(tmpdir(), "marktv-watch-route-"));
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  repositories.settings.put("tunarr-mapping", {
    url: `http://127.0.0.1:${upstreamAddress.port}`,
    marktvChannelId: "marktv-laughs",
    channelId: "tunarr-channel",
  });
  repositories.close();
  const app = await buildApp({ dataDir });

  const response = await app.inject(
    "/api/v1/watch/marktv-laughs/stream.m3u8",
  );

  expect(response.statusCode).toBe(502);
  expect(response.json()).toEqual({
    code: "LIVE_TV_UNAVAILABLE",
    message: "Tunarr could not provide the live stream",
  });

  await app.close();
  await new Promise<void>((resolve, reject) =>
    upstream.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    redirectTarget.close((error) => (error ? reject(error) : resolve())),
  );
});

const SEGMENT_BYTES = Buffer.from([0x47, 0x40, 0x00, 0x10]);

/** Boots an upstream + MarkTV pair wired together and hands back both. */
async function withProxy(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
  // The advertised-window guard remembers state per channel id, so tests that
  // exercise it take their own id rather than inheriting another test's window.
  options?: { channelId?: string },
) {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");

  const dataDir = await mkdtemp(join(tmpdir(), "marktv-watch-route-"));
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  repositories.settings.put("tunarr-mapping", {
    url: `http://127.0.0.1:${address.port}`,
    marktvChannelId: "marktv-laughs",
    channelId: options?.channelId ?? "tunarr-channel",
  });
  repositories.close();
  const app = await buildApp({ dataDir });

  const teardown = async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  };
  return { app, teardown, upstream, upstreamPort: address.port };
}

const SEGMENT_PATH =
  "/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/data000001.ts";

test("forwards Range requests and preserves the partial-content answer", async () => {
  const seenRanges: (string | undefined)[] = [];
  const { app, teardown } = await withProxy((request, response) => {
    seenRanges.push(request.headers.range);
    if (request.headers.range === "bytes=0-1023") {
      response.statusCode = 206;
      response.setHeader("content-type", "video/mp2t");
      response.setHeader("content-range", "bytes 0-1023/4096");
      response.setHeader("content-length", "1024");
      response.end(Buffer.alloc(1024));
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "video/mp2t");
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("content-length", "4096");
    response.end(Buffer.alloc(4096));
  });

  const ranged = await app.inject({
    headers: { range: "bytes=0-1023" },
    url: SEGMENT_PATH,
  });

  expect(seenRanges).toEqual(["bytes=0-1023"]);
  expect(ranged.statusCode).toBe(206);
  expect(ranged.headers["content-range"]).toBe("bytes 0-1023/4096");
  expect(ranged.headers["content-length"]).toBe("1024");
  expect(ranged.rawPayload.length).toBe(1024);

  const whole = await app.inject(SEGMENT_PATH);
  expect(whole.statusCode).toBe(200);
  expect(whole.headers["accept-ranges"]).toBe("bytes");
  await teardown();
});

test("passes a 416 through instead of flattening it into a gateway error", async () => {
  const { app, teardown } = await withProxy((_request, response) => {
    response.statusCode = 416;
    response.setHeader("content-range", "bytes */4096");
    response.end("range not satisfiable");
  });

  const response = await app.inject({
    headers: { range: "bytes=999999999-" },
    url: SEGMENT_PATH,
  });

  expect(response.statusCode).toBe(416);
  expect(response.headers["content-range"]).toBe("bytes */4096");
  await teardown();
});

test("streams a segment through instead of retaining it whole", async () => {
  // The upstream sends a first chunk, then stalls. If the proxy buffered the
  // whole body before replying, the client could not see anything yet.
  const { app, teardown } = await withProxy((_request, response) => {
    response.setHeader("content-type", "video/mp2t");
    response.write(SEGMENT_BYTES);
    setTimeout(() => response.end(SEGMENT_BYTES), 400);
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing MarkTV address");

  const firstChunkAt = await new Promise<number>((resolve, reject) => {
    const started = Date.now();
    const request = httpRequest(
      { host: "127.0.0.1", path: SEGMENT_PATH, port: address.port },
      (response) => {
        expect(response.statusCode).toBe(200);
        response.once("data", () => {
          resolve(Date.now() - started);
          request.destroy();
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

  // Well under the upstream's 400ms stall, so the body was forwarded early.
  expect(firstChunkAt).toBeLessThan(300);
  await teardown();
});

test("gives up on an upstream that never answers", async () => {
  const previous = watchProxyLimits.upstreamDeadlineMs;
  watchProxyLimits.upstreamDeadlineMs = 150;
  const { app, teardown } = await withProxy(() => {
    // Deliberately never respond.
  });

  const response = await app.inject(SEGMENT_PATH);

  expect(response.statusCode).toBe(502);
  expect(response.json()).toEqual({
    code: "LIVE_TV_UNAVAILABLE",
    message: "Tunarr could not provide the live stream",
  });
  watchProxyLimits.upstreamDeadlineMs = previous;
  await teardown();
});

test("abandons the upstream request when the browser goes away", async () => {
  let upstreamClosedEarly = false;
  const { app, teardown } = await withProxy((_request, response) => {
    response.setHeader("content-type", "video/mp2t");
    response.write(SEGMENT_BYTES);
    response.on("close", () => {
      if (!response.writableEnded) upstreamClosedEarly = true;
    });
    // Far longer than the test is willing to wait.
    setTimeout(() => response.end(SEGMENT_BYTES), 5_000).unref();
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing MarkTV address");

  await new Promise<void>((resolve) => {
    const request = httpRequest(
      { host: "127.0.0.1", path: SEGMENT_PATH, port: address.port },
      (response) => {
        response.once("data", () => {
          // The browser navigates away mid-segment.
          request.destroy();
          resolve();
        });
      },
    );
    request.on("error", () => resolve());
    request.end();
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(upstreamClosedEarly).toBe(true);
  await teardown();
});

test("re-tunes once and replays a media request when Tunarr reports no session", async () => {
  // Mirrors the real failure: Tunarr drops an idle session, the media routes
  // answer 404 "No session found" and are get-only so they cannot rebuild it,
  // and only the master tune-in route creates a new one.
  let sessionLive = false;
  let masterHits = 0;
  let mediaHits = 0;
  const { app, teardown } = await withProxy((request, response) => {
    if (request.url === "/stream/channels/tunarr-channel.m3u8") {
      masterHits += 1;
      sessionLive = true;
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n/stream/channels/tunarr-channel/hls/stream.m3u8\n");
      return;
    }
    if (request.url === "/stream/channels/tunarr-channel/hls/stream.m3u8") {
      mediaHits += 1;
      if (!sessionLive) {
        response.statusCode = 404;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("No session found");
        return;
      }
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n#EXTINF:4.0,\ndata000001.ts\n");
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const response = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/stream.m3u8",
  );

  expect(response.statusCode).toBe(200);
  expect(response.body).toBe(
    "#EXTM3U\n#EXTINF:4.0,\n/api/v1/watch/marktv-laughs/media/stream/channels/tunarr-channel/hls/data000001.ts\n",
  );
  expect(masterHits).toBe(1);
  expect(mediaHits).toBe(2);
  await teardown();
});

test("re-tunes for a segment request too, and retries at most once", async () => {
  let masterHits = 0;
  let segmentHits = 0;
  const { app, teardown } = await withProxy((request, response) => {
    if (request.url === "/stream/channels/tunarr-channel.m3u8") {
      masterHits += 1;
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n/stream/channels/tunarr-channel/hls/stream.m3u8\n");
      return;
    }
    segmentHits += 1;
    response.statusCode = 404;
    response.end("No session found");
  });

  const response = await app.inject(SEGMENT_PATH);

  expect(response.statusCode).toBe(502);
  expect(response.json()).toEqual({
    code: "LIVE_TV_UNAVAILABLE",
    message: "Tunarr could not provide the live stream",
  });
  expect(masterHits).toBe(1);
  expect(segmentHits).toBe(2);
  await teardown();
});

test("does not re-tune when the tune-in request itself fails", async () => {
  // The master route is what building a session means, so retrying it would
  // just repeat the same call and could loop.
  let masterHits = 0;
  const { app, teardown } = await withProxy((_request, response) => {
    masterHits += 1;
    response.statusCode = 500;
    response.end("boom");
  });

  const response = await app.inject("/api/v1/watch/marktv-laughs/stream.m3u8");

  expect(response.statusCode).toBe(502);
  expect(masterHits).toBe(1);
  await teardown();
});

test("refuses a segment below the advertised window without touching upstream", async () => {
  // Forwarding such a request is what damages the session: Tunarr records the
  // number before checking the file exists, which anchors its advertised window
  // below the point it has already deleted to.
  const hits: string[] = [];
  const { app, teardown } = await withProxy(
    (request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/stream/channels/window-channel/hls/stream.m3u8") {
        response.setHeader("content-type", "application/vnd.apple.mpegurl");
        response.end("#EXTM3U\n#EXTINF:4.0,\ndata000100.ts\n#EXTINF:4.0,\ndata000119.ts\n");
        return;
      }
      response.setHeader("content-type", "video/mp2t");
      response.end(SEGMENT_BYTES);
    },
    { channelId: "window-channel" },
  );

  const playlist = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/window-channel/hls/stream.m3u8",
  );
  expect(playlist.statusCode).toBe(200);
  hits.length = 0;

  const below = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/window-channel/hls/data000050.ts",
  );
  expect(below.statusCode).toBe(404);
  expect(below.json()).toEqual({ code: "NOT_FOUND" });
  expect(hits).toEqual([]);

  // A segment inside the window still goes through, so this is a floor and not
  // a blanket refusal.
  const inside = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/window-channel/hls/data000110.ts",
  );
  expect(inside.statusCode).toBe(200);
  expect(hits).toEqual([
    "/stream/channels/window-channel/hls/data000110.ts",
  ]);
  await teardown();
});

test("forwards a low segment when no window has been advertised yet", async () => {
  const hits: string[] = [];
  const { app, teardown } = await withProxy(
    (request, response) => {
      hits.push(request.url ?? "");
      response.setHeader("content-type", "video/mp2t");
      response.end(SEGMENT_BYTES);
    },
    { channelId: "nowindow-channel" },
  );

  const response = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/nowindow-channel/hls/data000050.ts",
  );

  expect(response.statusCode).toBe(200);
  expect(hits).toEqual([
    "/stream/channels/nowindow-channel/hls/data000050.ts",
  ]);
  await teardown();
});

test("fails open once the advertised window is stale", async () => {
  // A restarted channel renumbers from zero, so a remembered floor must not
  // outlive its usefulness.
  const previous = watchProxyLimits.windowGuardTtlMs;
  watchProxyLimits.windowGuardTtlMs = 0;
  const hits: string[] = [];
  const { app, teardown } = await withProxy(
    (request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/stream/channels/stale-channel/hls/stream.m3u8") {
        response.setHeader("content-type", "application/vnd.apple.mpegurl");
        response.end("#EXTM3U\n#EXTINF:4.0,\ndata000100.ts\n");
        return;
      }
      response.setHeader("content-type", "video/mp2t");
      response.end(SEGMENT_BYTES);
    },
    { channelId: "stale-channel" },
  );

  await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/stale-channel/hls/stream.m3u8",
  );
  hits.length = 0;
  // A zero TTL only expires once a millisecond has actually elapsed, so without
  // this the proxy can still see a fresh window and refuse the request.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const response = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/stale-channel/hls/data000050.ts",
  );

  expect(response.statusCode).toBe(200);
  expect(hits).toEqual([
    "/stream/channels/stale-channel/hls/data000050.ts",
  ]);
  watchProxyLimits.windowGuardTtlMs = previous;
  await teardown();
});

test("does not mistake a channel uuid's digits for a segment number", async () => {
  // The master playlist's only line embeds the channel uuid, which is full of
  // digits. Parsing those as a window would refuse good low-numbered segments,
  // which is why the pattern is anchored to the basename suffix.
  const hits: string[] = [];
  const { app, teardown } = await withProxy(
    (request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/stream/channels/9f8e7d6c5b4a.m3u8") {
        response.setHeader("content-type", "application/vnd.apple.mpegurl");
        response.end(
          "#EXTM3U\n/stream/channels/9f8e7d6c5b4a/hls/stream.m3u8\n",
        );
        return;
      }
      if (request.url === "/stream/channels/9f8e7d6c5b4a/hls/stream.m3u8") {
        response.setHeader("content-type", "application/vnd.apple.mpegurl");
        response.end("#EXTM3U\n#EXTINF:4.0,\ndata000900.ts\n");
        return;
      }
      response.setHeader("content-type", "video/mp2t");
      response.end(SEGMENT_BYTES);
    },
    { channelId: "9f8e7d6c5b4a" },
  );

  // Proxy the MASTER, whose line is /stream/channels/<uuid>/hls/stream.m3u8.
  const master = await app.inject("/api/v1/watch/marktv-laughs/stream.m3u8");
  expect(master.statusCode).toBe(200);
  hits.length = 0;

  const response = await app.inject(
    "/api/v1/watch/marktv-laughs/media/stream/channels/9f8e7d6c5b4a/hls/data000001.ts",
  );

  expect(response.statusCode).toBe(200);
  expect(hits).toEqual([
    "/stream/channels/9f8e7d6c5b4a/hls/data000001.ts",
  ]);
  await teardown();
});
