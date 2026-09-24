import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { alertFilePath, createAlertSink } from "../../src/autopilot/alerts.js";
import {
  createPlayoutWatch,
  newestSegmentNumber,
  parseProgramDateTimeMs,
  segmentStartMs,
} from "../../src/autopilot/playoutWatch.js";
import type { Repositories } from "../../src/db/repositories.js";

/*
 * The two halves of "find out and look in one place": alerts that reach a person,
 * and the playout checks that used to live only in an external script.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

function playlist(segments: Array<{ n: number; startMs: number }>): string {
  const stamp = (ms: number) => {
    const pad = (v: number, w = 2) => String(v).padStart(w, "0");
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
      d.getUTCHours(),
    )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+0000`;
  };
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (const segment of segments) {
    lines.push("#EXTINF:4.004000,");
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${stamp(segment.startMs)}`);
    lines.push(
      `/stream/channels/x/hls/data${String(segment.n).padStart(6, "0")}.ts`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

test("[R17] an alert reaches a file a person can be told to look at", async () => {
  const dir = await tempDir("marktv-alerts-");
  const file = join(dir, "alerts.log");
  const sink = createAlertSink({
    file,
    now: () => new Date("2026-09-24T20:00:00.000Z"),
  });

  const record = sink.raise({
    kind: "incident",
    channelId: "marktv-laughs",
    reason: "stalled",
    action: "re-push this channel's line-up; see /api/v1/diagnostics",
  });

  expect(record.at).toBe("2026-09-24T20:00:00.000Z");
  // No notification was asked for, and the record says so rather than implying one.
  expect(record.notified).toBe(false);

  const lines = (await readFile(file, "utf-8")).trim().split("\n");
  expect(lines).toHaveLength(1);
  const written = JSON.parse(lines[0]!);
  expect(written).toMatchObject({
    kind: "incident",
    channelId: "marktv-laughs",
    reason: "stalled",
  });
  // The action is the point: an alert that does not say what to do is a mystery.
  expect(written.action).toContain("diagnostics");
});

test("[R17] the alert file stays bounded, keeping the newest alerts", async () => {
  const dir = await tempDir("marktv-alerts-");
  const file = join(dir, "alerts.log");
  const sink = createAlertSink({
    file,
    maxBytes: 400,
    keepLines: 3,
    now: () => new Date("2026-09-24T20:00:00.000Z"),
  });

  for (let index = 0; index < 20; index += 1) {
    sink.raise({ kind: "incident", channelId: "c", reason: `fault-${index}` });
  }

  const lines = (await readFile(file, "utf-8")).trim().split("\n");
  expect(lines.length).toBeLessThanOrEqual(3);
  // The newest survived, which is what matters when the file is what you read.
  expect(lines.at(-1)).toContain("fault-19");
});

test("[R17] a notification is attempted only when asked for, and its outcome is recorded", async () => {
  const dir = await tempDir("marktv-alerts-");
  const file = join(dir, "alerts.log");
  const notifier = vi.fn(() => true);
  const sink = createAlertSink({ file, notify: true, notifier });

  expect(
    sink.raise({ kind: "dispatched", channelId: "c", reason: "repair" })
      .notified,
  ).toBe(true);
  expect(notifier).toHaveBeenCalledTimes(1);

  // A notifier that fails must not break the alert: the record says it failed and
  // the file still has it, because the file is the channel that always works.
  const failing = createAlertSink({
    file,
    notify: true,
    notifier: () => false,
  });
  expect(
    failing.raise({ kind: "suppressed", channelId: "c", reason: "breaker" })
      .notified,
  ).toBe(false);
  expect((await readFile(file, "utf-8")).trim().split("\n").length).toBe(2);
});

test("[R17] an unwritable alert path never throws into the caller", async () => {
  // An alerting path that can break recovery is worse than no alerting path.
  const sink = createAlertSink({ file: "/definitely/not/writable/alerts.log" });
  expect(() =>
    sink.raise({ kind: "incident", channelId: "c", reason: "boom" }),
  ).not.toThrow();
  expect(sink.recent()).toEqual([]);
});

test("[R17] recent() reads back newest first and survives a corrupt line", async () => {
  const dir = await tempDir("marktv-alerts-");
  const file = join(dir, "alerts.log");
  const sink = createAlertSink({ file });
  sink.raise({ kind: "incident", channelId: "c", reason: "first" });
  await writeFile(
    file,
    (await readFile(file, "utf-8")) + "not json\n",
    "utf-8",
  );
  sink.raise({ kind: "recovered", channelId: "c", reason: "second" });

  const recent = sink.recent(10);
  expect(recent.map((r) => r.reason)).toEqual(["second", "first"]);
});

test("[R17] the alert file path is configurable and otherwise follows the data dir", () => {
  expect(
    alertFilePath({ MARKTV_ALERT_FILE: "/tmp/a.log" } as NodeJS.ProcessEnv),
  ).toBe("/tmp/a.log");
  expect(
    alertFilePath({ MARKTV_DATA_DIR: "/tmp/d" } as NodeJS.ProcessEnv),
  ).toBe("/tmp/d/alerts.log");
  // An empty value is not a path.
  expect(
    alertFilePath({
      MARKTV_ALERT_FILE: "  ",
      MARKTV_DATA_DIR: "/tmp/d",
    } as NodeJS.ProcessEnv),
  ).toBe("/tmp/d/alerts.log");
});

// ---------------------------------------------------------------------------
// Playout watch
// ---------------------------------------------------------------------------

test("[R17] playlist parsing reads the newest segment and the -0500 tag form", () => {
  const body = playlist([
    { n: 5, startMs: Date.parse("2026-09-24T20:00:00Z") },
    { n: 6, startMs: Date.parse("2026-09-24T20:00:04Z") },
  ]);
  expect(newestSegmentNumber(body)).toBe(6);
  expect(segmentStartMs(body, 5)).toBe(Date.parse("2026-09-24T20:00:00Z"));
  // The shape FFmpeg actually writes, no colon in the offset.
  expect(parseProgramDateTimeMs("2026-09-24T15:00:00.000-0500")).toBe(
    Date.parse("2026-09-24T20:00:00Z"),
  );
  expect(parseProgramDateTimeMs("nonsense")).toBeNull();
});

test("[R17] the watch reports producer advance, the served head, and the delta", async () => {
  const root = await tempDir("marktv-playout-");
  const dir = join(root, "stream_c1");
  await writeFile(join(root, "placeholder"), "").catch(() => undefined);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });

  const base = Date.parse("2026-09-24T20:00:00Z");
  const fileBody = playlist([
    { n: 10, startMs: base },
    { n: 11, startMs: base + 4_000 },
  ]);
  await writeFile(join(dir, "stream.m3u8"), fileBody, "utf-8");

  // The served head is the same segment, described 100s ahead of the file's tag:
  // the monotonic repair, which is expected and must be REPORTED, not alerted on.
  const servedBody = playlist([{ n: 11, startMs: base + 4_000 + 100_000 }]);
  const repositories = {
    channels: { list: () => [{ id: "c1", enabled: true }] },
  } as unknown as Repositories;

  const watch = createPlayoutWatch(repositories, {
    streamsRoot: root,
    servedUrlFor: () => "http://tunarr/served.m3u8",
    healthFor: () => "buffered_idle",
    now: () => new Date("2026-09-24T20:01:00Z"),
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => servedBody,
      }) as unknown as Response) as typeof fetch,
  });

  await watch.runOnce();
  const [sample] = watch.snapshot();
  expect(sample).toMatchObject({
    channelId: "c1",
    newestSegment: 11,
    servedSegment: 11,
    health: "buffered_idle",
  });
  expect(sample?.servedDeltaMs).toBe(100_000);
  // First sample cannot know whether it advanced; the second can.
  expect(sample?.advancing).toBe(false);

  await writeFile(
    join(dir, "stream.m3u8"),
    playlist([
      { n: 10, startMs: base },
      { n: 11, startMs: base + 4_000 },
      { n: 12, startMs: base + 8_000 },
    ]),
    "utf-8",
  );
  await watch.runOnce();
  const [second] = watch.snapshot();
  expect(second?.newestSegment).toBe(12);
  expect(second?.advancing).toBe(true);
  expect(second?.advancedAt).toBe("2026-09-24T20:01:00.000Z");
});

test("[R17] an unreadable channel reports nulls, never a healthy guess", async () => {
  const root = await tempDir("marktv-playout-");
  const repositories = {
    channels: { list: () => [{ id: "missing", enabled: true }] },
  } as unknown as Repositories;

  const errors: unknown[] = [];
  const watch = createPlayoutWatch(repositories, {
    streamsRoot: root,
    onError: (error) => errors.push(error),
  });

  await watch.runOnce();
  const [sample] = watch.snapshot();
  expect(sample?.newestSegment).toBeNull();
  expect(sample?.servedSegment).toBeNull();
  expect(sample?.advancing).toBe(false);
  expect(errors.length).toBeGreaterThan(0);
});

test("[R17] a served playlist that fails does not lose the producer reading", async () => {
  const root = await tempDir("marktv-playout-");
  const dir = join(root, "stream_c1");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "stream.m3u8"),
    playlist([{ n: 3, startMs: Date.parse("2026-09-24T20:00:00Z") }]),
    "utf-8",
  );

  const repositories = {
    channels: { list: () => [{ id: "c1", enabled: true }] },
  } as unknown as Repositories;
  const watch = createPlayoutWatch(repositories, {
    streamsRoot: root,
    servedUrlFor: () => "http://tunarr/served.m3u8",
    fetchImpl: (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch,
  });

  await watch.runOnce();
  const [sample] = watch.snapshot();
  // The file-side evidence is the durable half and must survive the fetch failing.
  expect(sample?.newestSegment).toBe(3);
  expect(sample?.servedSegment).toBeNull();
  expect(sample?.servedDeltaMs).toBeNull();
});

test("[R17] the served-head defect is reported ahead of a stall, and only on entry", async () => {
  const root = await tempDir("marktv-playout-");
  const dir = join(root, "stream_c1");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });

  const base = Date.parse("2026-09-24T20:00:00Z");
  const write = async (fileNewest: number, servedNewest: number | null) => {
    await writeFile(
      join(dir, "stream.m3u8"),
      playlist([{ n: fileNewest, startMs: base + fileNewest * 4_000 }]),
      "utf-8",
    );
    return servedNewest === null
      ? null
      : playlist([{ n: servedNewest, startMs: base + servedNewest * 4_000 }]);
  };

  const repositories = {
    channels: { list: () => [{ id: "c1", enabled: true }] },
  } as unknown as Repositories;
  const alerts: Array<{ condition: string; detail: string }> = [];
  let servedBody: string | null = null;
  const watch = createPlayoutWatch(repositories, {
    streamsRoot: root,
    servedUrlFor: () => "http://tunarr/served.m3u8",
    stallSamples: 1,
    onAlert: (alert) =>
      alerts.push({ condition: alert.condition, detail: alert.detail }),
    fetchImpl: (async () =>
      ({
        ok: servedBody !== null,
        status: servedBody !== null ? 200 : 500,
        text: async () => servedBody ?? "",
      }) as unknown as Response) as typeof fetch,
  });

  // Healthy first sample: nothing to announce.
  servedBody = await write(10, 10);
  await watch.runOnce();
  expect(alerts).toEqual([]);

  // The defect: viewers offered a segment the producer has already passed.
  servedBody = await write(20, 15);
  await watch.runOnce();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.condition).toBe("served-head-below-producer");
  expect(alerts[0]?.detail).toContain("15");
  expect(alerts[0]?.detail).toContain("20");

  // Still defective: it must NOT be repeated. A file that repeats is not read.
  await watch.runOnce();
  expect(alerts).toHaveLength(1);

  // Recovered: worth knowing, because it is how you learn it fixed itself.
  servedBody = await write(21, 21);
  await watch.runOnce();
  expect(alerts.map((a) => a.condition)).toEqual([
    "served-head-below-producer",
    "recovered",
  ]);
});

test("[R17] a producer that stops advancing is called a stall, once", async () => {
  const root = await tempDir("marktv-playout-");
  const dir = join(root, "stream_c1");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });

  const base = Date.parse("2026-09-24T20:00:00Z");
  const repositories = {
    channels: { list: () => [{ id: "c1", enabled: true }] },
  } as unknown as Repositories;
  const alerts: string[] = [];
  const watch = createPlayoutWatch(repositories, {
    streamsRoot: root,
    stallSamples: 2,
    onAlert: (alert) => alerts.push(alert.condition),
  });

  await writeFile(
    join(dir, "stream.m3u8"),
    playlist([{ n: 5, startMs: base }]),
    "utf-8",
  );
  await watch.runOnce();
  await watch.runOnce(); // second static sample: the stall is confirmed
  await watch.runOnce(); // third: still stalled, but already announced
  expect(alerts).toEqual(["producer-stalled"]);

  // It moves again.
  await writeFile(
    join(dir, "stream.m3u8"),
    playlist([
      { n: 5, startMs: base },
      { n: 6, startMs: base + 4_000 },
    ]),
    "utf-8",
  );
  await watch.runOnce();
  expect(alerts).toEqual(["producer-stalled", "recovered"]);
});

test("[R17] a channel that has never produced a playlist is not a fault", async () => {
  const root = await tempDir("marktv-playout-");
  const repositories = {
    channels: { list: () => [{ id: "not-started", enabled: true }] },
  } as unknown as Repositories;
  const alerts: string[] = [];
  const watch = createPlayoutWatch(repositories, {
    streamsRoot: root,
    stallSamples: 1,
    onAlert: (alert) => alerts.push(alert.condition),
    onError: () => undefined,
  });

  await watch.runOnce();
  await watch.runOnce();
  // Never readable, so there is nothing to have lost: silence is correct here.
  expect(alerts).toEqual([]);
});

test("[R17] the status view carries the playout readings and the alert tail", async () => {
  const { buildApp } = await import("../../src/server/app.js");
  const dir = await tempDir("marktv-status-alerts-");
  const alertFile = join(dir, "alerts.log");
  const app = await buildApp({ dataDir: dir, alertFile, alertsNotify: false });
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/autopilot/status",
  });
  expect(response.statusCode).toBe(200);
  // Both are arrays even when nothing has been observed: the shape is the
  // contract, so a dashboard does not have to special-case "not running".
  expect(response.json()).toMatchObject({
    playout: expect.any(Array),
    alerts: expect.any(Array),
  });
  await app.close();
});

test("[OP06] the diagnostic bundle redacts the extras it is handed", async () => {
  const { diagnosticBundle } =
    await import("../../src/autopilot/diagnostics.js");
  const { createRepositories } = await import("../../src/db/repositories.js");
  const { openDatabase } = await import("../../src/db/database.js");
  const dir = await tempDir("marktv-diag-extras-");
  const repositories = createRepositories(openDatabase(dir));

  // The extras are assembled from observations and alert text, so they must go
  // through the same redaction as everything else in the bundle.
  const bundle = await diagnosticBundle(
    repositories,
    new Date("2026-09-24T20:00:00Z"),
    {
      playout: [
        { servedUrl: "http://tunarr/stream?token=Bearer abc123def456ghi789" },
      ],
      alerts: [{ reason: "Bearer abc123def456ghi789" }],
    },
  );

  const text = JSON.stringify(bundle);
  expect(text).not.toContain("Bearer abc123def456ghi789");
  expect(text).toContain("playout");
  expect(text).toContain("alerts");
  repositories.close();
});
