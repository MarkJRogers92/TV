import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";

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

test("proxies and rewrites the configured Tunarr HLS stream for the browser", async () => {
  const upstream = createServer((request, response) => {
    if (request.url === "/stream/channels/tunarr-channel.m3u8?mode=hls") {
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
    `#EXTM3U\n#EXTINF:-1,MarkTV Live\nhttp://127.0.0.1:${address.port}/stream/channels/tunarr-channel.m3u8?mode=hls\n`,
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
