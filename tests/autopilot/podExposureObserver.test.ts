import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAiringLedger } from "../../src/autopilot/airingLedger.js";
import {
  createPodExposureObserver,
  recordObservedPod,
  type PodExposureDecision,
  type PodExposurePassSummary,
} from "../../src/autopilot/podExposureObserver.js";
import {
  observedPodInterval,
  parseAdvertisedSegments,
  parseProgramDateTimeMs,
  scheduledPods,
} from "../../src/continuity/podObservation.js";
import { openDatabase } from "../../src/db/database.js";
import type { Repositories } from "../../src/db/repositories.js";
import type { Schedule } from "../../src/domain/models.js";

/*
 * SC06 activation — "Playback stops 45 seconds into a three-by-30-second pod.
 * Record 30/15/0 seconds for members, not three completed ads."
 *
 * tests/continuity/podExposure.test.ts covers the arithmetic with a given
 * interval; tests/autopilot/airingLedger.test.ts covers storing it. These cover
 * the missing link: deriving the interval from what the CHANNEL actually
 * advertised, and refusing to record when there is no such evidence. That
 * refusal is the point - if a plan could stand in for an observation, every pod
 * would be recorded 30/30/30, which is the fault the case names.
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

const CHANNEL = "marktv-laughs";
const POD_START = Date.parse("2026-09-24T12:00:00.000Z");
const POD_END = POD_START + 90_000;
const MEMBERS = [
  { id: "ad_a", durationMs: 30_000 },
  { id: "ad_b", durationMs: 30_000 },
  { id: "ad_c", durationMs: 30_000 },
];

/** A playlist in FFmpeg's own shape, with an explicit offset (no 'Z'). */
function playlist(
  segments: Array<{ startMs: number; durationMs: number }>,
): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
      d.getUTCHours(),
    )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+0000`;
  };
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:15",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  segments.forEach((segment, index) => {
    lines.push(`#EXTINF:${(segment.durationMs / 1000).toFixed(3)},`);
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${stamp(segment.startMs)}`);
    lines.push(`/stream/channels/${CHANNEL}/hls/data${pad(index, 6)}.ts`);
  });
  return lines.join("\n");
}

/** The pod's first 45 seconds advertised: ad_a in full, ad_b halfway, ad_c not. */
const FAULT_PLAYLIST = playlist([
  { startMs: POD_START, durationMs: 15_000 },
  { startMs: POD_START + 15_000, durationMs: 15_000 },
  { startMs: POD_START + 30_000, durationMs: 15_000 },
]);

const FULL_PLAYLIST = playlist([
  { startMs: POD_START, durationMs: 30_000 },
  { startMs: POD_START + 30_000, durationMs: 30_000 },
  { startMs: POD_START + 60_000, durationMs: 30_000 },
]);

test("[SC06] the playlist's program-date-times are parsed, including the -0500 form FFmpeg writes", () => {
  expect(parseProgramDateTimeMs("2026-09-24T12:00:00.000+0000")).toBe(
    POD_START,
  );
  // The exact shape seen on the live install: no colon in the offset.
  expect(parseProgramDateTimeMs("2026-09-24T07:00:00.000-0500")).toBe(
    POD_START,
  );
  expect(parseProgramDateTimeMs("not a timestamp")).toBeUndefined();

  const parsed = parseAdvertisedSegments(FAULT_PLAYLIST);
  expect(parsed.map((segment) => segment.durationMs)).toEqual([
    15_000, 15_000, 15_000,
  ]);
  expect(parsed[0]?.startMs).toBe(POD_START);
});

test("[SC06] the F16 fault is observed from the playlist and recorded as 30/15/0", async () => {
  const ledger = createAiringLedger(
    openDatabase(await tempDir("marktv-pod-obs-")),
  );
  const decision = recordObservedPod({
    ledger,
    pod: {
      podId: "pod-f16",
      channelId: CHANNEL,
      startMs: POD_START,
      endMs: POD_END,
      members: MEMBERS,
    },
    advertised: parseAdvertisedSegments(FAULT_PLAYLIST),
    observedAt: "2026-09-24T12:02:00.000Z",
  });

  expect(decision.outcome).toBe("recorded");
  expect(decision.observed).toEqual({
    startMs: POD_START,
    endMs: POD_START + 45_000,
  });
  expect(decision.record?.members.map((m) => m.airedSeconds)).toEqual([
    30, 15, 0,
  ]);
  expect(decision.record?.members.map((m) => m.completed)).toEqual([
    true,
    false,
    false,
  ]);
  expect(decision.record?.podCompleted).toBe(false);
});

test("[SC06] a fully advertised pod is recorded complete, not assumed complete", async () => {
  const ledger = createAiringLedger(
    openDatabase(await tempDir("marktv-pod-obs-")),
  );
  const decision = recordObservedPod({
    ledger,
    pod: {
      podId: "pod-full",
      channelId: CHANNEL,
      startMs: POD_START,
      endMs: POD_END,
      members: MEMBERS,
    },
    advertised: parseAdvertisedSegments(FULL_PLAYLIST),
    observedAt: "2026-09-24T12:02:00.000Z",
  });

  expect(decision.record?.members.map((m) => m.airedSeconds)).toEqual([
    30, 30, 30,
  ]);
  expect(decision.record?.podCompleted).toBe(true);
});

test("[SC06] with no evidence that the pod's start aired, NOTHING is recorded", async () => {
  const directory = await tempDir("marktv-pod-obs-");
  const ledger = createAiringLedger(openDatabase(directory));
  // The channel was advertising a different part of its hour: nothing covers the
  // pod's start, so there is no observation to record.
  const unrelated = parseAdvertisedSegments(
    playlist([{ startMs: POD_START + 600_000, durationMs: 30_000 }]),
  );
  const decision = recordObservedPod({
    ledger,
    pod: {
      podId: "pod-unseen",
      channelId: CHANNEL,
      startMs: POD_START,
      endMs: POD_END,
      members: MEMBERS,
    },
    advertised: unrelated,
  });

  expect(decision.outcome).toBe("not-observed");
  expect(decision.record).toBeUndefined();
  // The crucial assertion: no row was invented.
  expect(ledger.podExposure("pod-unseen")).toBeUndefined();
});

test("[SC06] a gap in the advertised run ends the observed interval", () => {
  // Covers the first 30s, then jumps a minute: the pod's coverage stops at 30s.
  const gapped = parseAdvertisedSegments(
    playlist([
      { startMs: POD_START, durationMs: 30_000 },
      { startMs: POD_START + 90_000, durationMs: 30_000 },
    ]),
  );
  expect(
    observedPodInterval({ startMs: POD_START, endMs: POD_END }, gapped),
  ).toEqual({ startMs: POD_START, endMs: POD_START + 30_000 });

  // And an advertised run that only reaches past the end is clipped to the pod.
  const overshooting = parseAdvertisedSegments(
    playlist([{ startMs: POD_START, durationMs: 120_000 }]),
  );
  expect(
    observedPodInterval({ startMs: POD_START, endMs: POD_END }, overshooting),
  ).toEqual({ startMs: POD_START, endMs: POD_END });
});

test("[SC06] a station id inside a break does not split the pod", () => {
  // The live schedules interleave station-id and bumper entries inside breaks, so
  // grouping only commercials would cut one pod into several and record each part
  // as its own exposure.
  const at = (offsetMs: number) => new Date(POD_START + offsetMs).toISOString();
  const pods = scheduledPods(
    [
      { id: "ad-a", kind: "commercial", start: at(0), end: at(30_000) },
      { id: "id-1", kind: "station-id", start: at(30_000), end: at(35_000) },
      { id: "ad-b", kind: "commercial", start: at(35_000), end: at(65_000) },
      { id: "bump", kind: "bumper", start: at(65_000), end: at(70_000) },
    ],
    { channelId: CHANNEL },
  );

  expect(pods).toHaveLength(1);
  expect(pods[0]?.members.map((m) => m.id)).toEqual([
    "ad-a",
    "id-1",
    "ad-b",
    "bump",
  ]);
  expect(pods[0]?.endMs).toBe(POD_START + 70_000);
});

test("[SC06] schedule pods are grouped by adjacency, and an unknown kind splits them", () => {
  const entry = (
    id: string,
    kind: string,
    startMs: number,
    durationMs: number,
  ) => ({
    id,
    kind,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + durationMs).toISOString(),
  });

  const pods = scheduledPods(
    [
      entry("episode-1", "episode", POD_START - 1_800_000, 1_800_000),
      entry("ad-a", "commercial", POD_START, 30_000),
      entry("ad-b", "commercial", POD_START + 30_000, 30_000),
      // An unknown kind must break the run rather than be swallowed into it.
      entry("mystery", "flex", POD_START + 60_000, 30_000),
      entry("ad-c", "commercial", POD_START + 90_000, 30_000),
    ],
    { channelId: CHANNEL },
  );

  expect(pods.map((pod) => pod.members.map((m) => m.id))).toEqual([
    ["ad-a", "ad-b"],
    ["ad-c"],
  ]);
  expect(pods[0]?.startMs).toBe(POD_START);
  expect(pods[0]?.endMs).toBe(POD_START + 60_000);
});

test("[SC06] the observer records a finished pod from the channel's own playlist, once", async () => {
  const dataDir = await tempDir("marktv-pod-db-");
  const streamsRoot = await tempDir("marktv-pod-streams-");
  const streamDir = `stream_${CHANNEL}`;
  await mkdir(join(streamsRoot, streamDir), { recursive: true });
  await writeFile(join(streamsRoot, streamDir, "stream.m3u8"), FAULT_PLAYLIST);

  const schedule: Schedule = {
    channelId: CHANNEL,
    date: "2026-09-24",
    generatedAt: "2026-09-24T11:00:00.000Z",
    durationMs: 86_400_000,
    entries: [
      {
        id: "ad-a",
        kind: "commercial",
        start: new Date(POD_START).toISOString(),
        end: new Date(POD_START + 30_000).toISOString(),
        durationMs: 30_000,
      },
      {
        id: "ad-b",
        kind: "commercial",
        start: new Date(POD_START + 30_000).toISOString(),
        end: new Date(POD_START + 60_000).toISOString(),
        durationMs: 30_000,
      },
      {
        id: "ad-c",
        kind: "commercial",
        start: new Date(POD_START + 60_000).toISOString(),
        end: new Date(POD_START + 90_000).toISOString(),
        durationMs: 30_000,
      },
    ],
  } as unknown as Schedule;

  const repositories = {
    channels: { list: () => [{ id: CHANNEL, enabled: true }] },
    schedules: {
      list: () => [schedule],
      latestForDate: () => schedule,
    },
  } as unknown as Repositories;
  const ledger = createAiringLedger(openDatabase(dataDir));

  const decisions: PodExposureDecision[] = [];
  const observer = createPodExposureObserver(repositories, ledger, {
    streamsRoot,
    streamsDirectoryFor: () => join(streamsRoot, streamDir),
    // The pod's window has passed, so it is eligible.
    now: () => new Date(POD_END + 60_000),
    onDecision: (decision) => decisions.push(decision),
  });

  await observer.runOnce();
  const recorded = decisions.filter(
    (decision) => decision.outcome === "recorded",
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.record?.members.map((m) => m.airedSeconds)).toEqual([
    30, 15, 0,
  ]);

  // A second pass is a replay: still exactly one record, and it says so.
  await observer.runOnce();
  expect(
    decisions.filter((decision) => decision.outcome === "already-recorded"),
  ).toHaveLength(1);
  expect(
    ledger.podExposuresForPod(
      `${CHANNEL}:${new Date(POD_START).toISOString()}@2026-09-24`,
    ),
  ).toHaveLength(1);
});

test("[SC06] a pod still in progress is not recorded by the observer", async () => {
  const dataDir = await tempDir("marktv-pod-db-");
  const streamsRoot = await tempDir("marktv-pod-streams-");
  const streamDir = `stream_${CHANNEL}`;
  await mkdir(join(streamsRoot, streamDir), { recursive: true });
  await writeFile(join(streamsRoot, streamDir, "stream.m3u8"), FAULT_PLAYLIST);

  const schedule = {
    channelId: CHANNEL,
    date: "2026-09-24",
    generatedAt: "2026-09-24T11:00:00.000Z",
    durationMs: 86_400_000,
    entries: [
      {
        id: "ad-a",
        kind: "commercial",
        start: new Date(POD_START).toISOString(),
        end: new Date(POD_END).toISOString(),
        durationMs: 90_000,
      },
    ],
  } as unknown as Schedule;

  const repositories = {
    channels: { list: () => [{ id: CHANNEL, enabled: true }] },
    schedules: { list: () => [schedule], latestForDate: () => schedule },
  } as unknown as Repositories;
  const ledger = createAiringLedger(openDatabase(dataDir));

  const decisions: PodExposureDecision[] = [];
  const observer = createPodExposureObserver(repositories, ledger, {
    streamsRoot,
    streamsDirectoryFor: () => join(streamsRoot, streamDir),
    // Mid-pod: recording now would freeze a partial figure the ledger would then
    // refuse to correct, so the observer must wait for the window to pass.
    now: () => new Date(POD_START + 45_000),
    onDecision: (decision) => decisions.push(decision),
  });

  await observer.runOnce();
  expect(decisions).toHaveLength(0);
});

test("[SC06] a pass with nothing observable SAYS so, rather than staying silent", async () => {
  // The auditability half: an observer that finds nothing and reports nothing
  // cannot be told apart from one that is not running, which is exactly how this
  // looked on the live install before the summary existed.
  const dataDir = await tempDir("marktv-pod-db-");
  const streamsRoot = await tempDir("marktv-pod-streams-");
  const streamDir = `stream_${CHANNEL}`;
  await mkdir(join(streamsRoot, streamDir), { recursive: true });
  // The channel is advertising a part of its hour that this pod does not occupy.
  await writeFile(
    join(streamsRoot, streamDir, "stream.m3u8"),
    playlist([{ startMs: POD_START + 3_600_000, durationMs: 30_000 }]),
  );

  const schedule = {
    channelId: CHANNEL,
    date: "2026-09-24",
    generatedAt: "2026-09-24T11:00:00.000Z",
    durationMs: 86_400_000,
    entries: [
      {
        id: "ad-a",
        kind: "commercial",
        start: new Date(POD_START).toISOString(),
        end: new Date(POD_END).toISOString(),
        durationMs: 90_000,
      },
    ],
  } as unknown as Schedule;
  const repositories = {
    channels: { list: () => [{ id: CHANNEL, enabled: true }] },
    schedules: { list: () => [schedule], latestForDate: () => schedule },
  } as unknown as Repositories;
  const ledger = createAiringLedger(openDatabase(dataDir));

  const summaries: PodExposurePassSummary[] = [];
  const observer = createPodExposureObserver(repositories, ledger, {
    streamsRoot,
    streamsDirectoryFor: () => join(streamsRoot, streamDir),
    now: () => new Date(POD_END + 60_000),
    onPass: (summary) => summaries.push(summary),
  });

  await observer.runOnce();
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({
    podsConsidered: 1,
    recorded: 0,
    notObserved: 1,
  });
  // And, critically, a pass that observed nothing wrote nothing.
  expect(
    ledger.podExposuresForPod(
      `${CHANNEL}:${new Date(POD_START).toISOString()}@2026-09-24`,
    ),
  ).toEqual([]);
});

test("[SC06] a pod straddled by a segment grid offset from its start IS observed", () => {
  // The realistic shape, and the bug this pins: segments are ~4s long, so the
  // segment covering a pod's start normally begins SEVERAL SECONDS BEFORE it.
  // The first version of the anchor check used a symmetric 1s tolerance and so
  // rejected exactly the segments it should have accepted - every real pod would
  // have come back "not observed" while the tidy fixtures passed.
  const gridOffset = 3_000;
  const advertised = parseAdvertisedSegments(
    playlist(
      Array.from({ length: 8 }, (_, index) => ({
        startMs: POD_START - 4_000 + index * 4_000,
        durationMs: 4_000,
      })),
    ),
  );

  // The pod's first 12 seconds are covered by the grid above.
  const observed = observedPodInterval(
    { startMs: POD_START, endMs: POD_START + 12_000 },
    advertised,
  );
  expect(observed).toEqual({ startMs: POD_START, endMs: POD_START + 12_000 });
  expect(gridOffset).toBe(3_000); // documents the fixture's offset, not asserted on

  // And a run that genuinely starts mid-pod is still refused.
  const late = parseAdvertisedSegments(
    playlist([{ startMs: POD_START + 10_000, durationMs: 4_000 }]),
  );
  expect(
    observedPodInterval({ startMs: POD_START, endMs: POD_END }, late),
  ).toBeNull();
});
