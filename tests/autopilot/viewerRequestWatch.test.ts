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

test("reports a gap, then classifies it as a stall when requests resume", async () => {
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
    condition: "viewer-request-gap",
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
    condition: "viewer-request-stalled",
    channelId: "cult",
  });
  // Measured between the viewer's own heartbeats: 26s + 10s.
  expect((alerts[1] as { detail: string }).detail).toContain("about 36 seconds");

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

test("classifies a gap that ends with the session leaving as a viewer leaving", async () => {
  let time = 1_790_000_000_000;
  let body: unknown = sessions(time);
  const alerts: Array<{ condition: string }> = [];
  const repositories = {
    channels: { list: () => [channel] },
  } as unknown as Repositories;
  const watch = createViewerRequestWatch(repositories, {
    streamsDirectoryFor: () => "/streams/cult",
    sessionsUrlFor: () => "http://127.0.0.1:8000/api/sessions",
    tunarrChannelIdFor: () => "tunarr-cult",
    producerModifiedAt: async () => time,
    now: () => new Date(time),
    fetchImpl: (async () => response(body)) as typeof fetch,
    onAlert: (alert) => alerts.push(alert),
  });

  await watch.runOnce();
  time += 30_000;
  await watch.runOnce();
  // Tunarr drops the abandoned session after its stale interval.
  body = {};
  time += 100_000;
  await watch.runOnce();
  expect(alerts.map((alert) => alert.condition)).toEqual([
    "viewer-request-gap",
    "viewer-left",
  ]);
  await watch.stop();
});

test("reports a slow sessions response", async () => {
  let time = 1_790_000_000_000;
  const slow: number[] = [];
  const repositories = {
    channels: { list: () => [channel] },
  } as unknown as Repositories;
  const watch = createViewerRequestWatch(repositories, {
    streamsDirectoryFor: () => "/streams/cult",
    sessionsUrlFor: () => "http://127.0.0.1:8000/api/sessions",
    tunarrChannelIdFor: () => "tunarr-cult",
    producerModifiedAt: async () => time,
    now: () => new Date(time),
    fetchImpl: (async () => {
      time += 1_500;
      return response(sessions(time));
    }) as typeof fetch,
    onSlowResponse: (durationMs) => slow.push(durationMs),
  });

  await watch.runOnce();
  expect(slow).toEqual([1_500]);
  await watch.stop();
});
