import { afterEach, expect, test, vi } from "vitest";
import { createViewerRequestWatch } from "../../src/autopilot/viewerRequestWatch.js";
import type { Repositories } from "../../src/db/repositories.js";

const channel = { id: "cult", enabled: true };

function sessions(lastHeartbeat: number, userAgent = "TiviMate/5.3.3") {
  return {
    "tunarr-cult": [
      {
        type: "hls",
        channelId: "tunarr-cult",
        connections: [
          { ip: "10.0.0.105", userAgent, lastHeartbeat },
        ],
      },
    ],
  };
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

afterEach(() => vi.restoreAllMocks());

test("alerts on a viewer request gap only after seeing it active, then reports recovery", async () => {
  let time = 1_790_000_000_000;
  let heartbeat = time;
  let producerModifiedAt = time;
  const alerts: unknown[] = [];
  const urls: string[] = [];
  const repositories = {
    channels: { list: () => [channel] },
  } as unknown as Repositories;

  const watch = createViewerRequestWatch(repositories, {
    streamsDirectoryFor: () => "/streams/cult",
    sessionsUrlFor: () => "http://127.0.0.1:8000/api/sessions",
    tunarrChannelIdFor: () => "tunarr-cult",
    producerModifiedAt: async () => producerModifiedAt,
    now: () => new Date(time),
    intervalMs: 10_000,
    heartbeatStaleMs: 25_000,
    fetchImpl: (async (url) => {
      urls.push(String(url));
      return response(sessions(heartbeat));
    }) as typeof fetch,
    onAlert: (alert) => alerts.push(alert),
  });

  await watch.runOnce();
  expect(alerts).toEqual([]);

  time += 26_000;
  producerModifiedAt = time;
  await watch.runOnce();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({
    condition: "viewer-request-stalled",
    channelId: "cult",
  });
  expect(urls).toEqual([
    "http://127.0.0.1:8000/api/sessions",
    "http://127.0.0.1:8000/api/sessions",
  ]);

  time += 10_000;
  heartbeat = time;
  producerModifiedAt = time;
  await watch.runOnce();
  expect(alerts).toHaveLength(2);
  expect(alerts[1]).toMatchObject({
    condition: "recovered",
    channelId: "cult",
  });

  await watch.stop();
});

test("does not alert for an already-stale or non-viewer session", async () => {
  let time = 1_790_000_000_000;
  const alerts: unknown[] = [];
  const repositories = {
    channels: { list: () => [channel] },
  } as unknown as Repositories;
  const watch = createViewerRequestWatch(repositories, {
    streamsDirectoryFor: () => "/streams/cult",
    sessionsUrlFor: () => "http://127.0.0.1:8000/api/sessions",
    tunarrChannelIdFor: () => "tunarr-cult",
    producerModifiedAt: async () => time,
    now: () => new Date(time),
    fetchImpl: (async () =>
      response(sessions(time - 60_000, "marktv-always-on/1.0"))) as typeof fetch,
    onAlert: (alert) => alerts.push(alert),
  });

  await watch.runOnce();
  time += 60_000;
  await watch.runOnce();
  expect(alerts).toEqual([]);
  await watch.stop();
});
