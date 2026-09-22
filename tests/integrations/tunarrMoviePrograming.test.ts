import { expect, test } from "vitest";
import type { Schedule } from "../../src/domain/models.js";
import { buildTunarrSyncPlan } from "../../src/integrations/tunarr/plan.js";
import type {
  TunarrCapabilities,
  TunarrInventory,
  TunarrSnapshots,
} from "../../src/integrations/tunarr/types.js";

/**
 * The Tunarr half of a movie that crossed midnight.
 *
 * MarkTV continues the same file on the next broadcast day instead of dropping
 * the tail, so every content segment it plans has to be quoted at its offset in
 * the SOURCE file. A plan that restarted the film at zero, or that read the
 * entry-relative offsets as source offsets, would air the wrong part of the
 * movie.
 */

const capabilities: TunarrCapabilities = {
  url: "http://127.0.0.1:8000",
  version: "0.20.1",
  healthy: true,
  supportsChannels: true,
  supportsFillerLists: true,
  supportsTranscodeConfigs: true,
  supportsInventory: true,
  supportsProgramming: true,
};

const wrapper = (id: string, path: string) => ({
  type: "content" as const,
  id,
  duration: 60_000,
  program: {
    uuid: "11111111-1111-4111-8111-111111111111",
    mediaItem: { locations: [{ type: "local" as const, path }] },
  },
});

const inventory: TunarrInventory = [
  {
    id: "movie",
    path: "/media/movie.mkv",
    program: wrapper("movie", "/media/movie.mkv"),
  },
  { id: "ad", path: "/media/ad.mkv", program: wrapper("ad", "/media/ad.mkv") },
];

const snapshots: TunarrSnapshots = {
  channels: [
    {
      id: "channel",
      name: "Channel",
      number: 7,
      duration: 1,
      groupTitle: "MarkTV",
      guideMinimumDuration: 30_000,
      icon: { path: "", width: 0, duration: 0, position: "bottom-right" },
      startTime: 0,
      stealth: false,
      offline: { mode: "pic" },
      onDemand: { enabled: false },
      streamMode: "hls",
      transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      disableFillerOverlay: false,
      subtitlesEnabled: false,
      programCount: 0,
    },
  ],
  fillerLists: [],
  fillerPrograms: {},
  transcodeConfigs: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Default" },
  ],
  programming: { totalPrograms: 0, programs: {}, lineup: [], startTimeOffsets: [] },
};

const mapping = {
  libraryId: "lib",
  channelId: "channel",
  createChannel: false,
};

test("schedule-bound continuity plays only in its assigned slot, never the generic filler pool", () => {
  const cardPath = "/media/generated/continuity/day/next.mp4";
  const schedule = continuationSchedule({
    id: "continuity:generated:card",
    start: "2026-09-13T00:00:00.000Z", end: "2026-09-13T00:00:10.000Z",
    localStart: "00:00", localEnd: "00:00", durationMs: 10_000,
    kind: "bumper", title: "NEXT", mediaId: "card", path: cardPath,
    source: "continuity:next",
  });
  const plan = buildTunarrSyncPlan(schedule, [{
    id: "card", path: cardPath,
    program: { ...wrapper("card", cardPath), duration: 10_000 },
  }], capabilities, mapping, snapshots);
  expect(plan.syncEligible).toBe(true);
  const filler = plan.operations.find(operation => operation.type === "filler-create");
  expect(filler?.payload.programs).toEqual([]);
  expect(plan.operations.at(-1)?.payload).toEqual([
    { type: "content", id: "card", duration: 10_000 },
  ]);
});

function continuationSchedule(
  entry: Schedule["entries"][number],
  filler: Schedule["entries"] = [],
): Schedule {
  const durationMs = [entry, ...filler].reduce(
    (total, item) => total + item.durationMs,
    0,
  );
  return {
    id: "continuation",
    channelId: "marktv",
    channelName: "Laughs",
    channelNumber: 7,
    date: "2026-09-13",
    timezone: "UTC",
    seed: "seed",
    revision: "revision-1",
    generatedAt: "2026-09-13T00:00:00.000Z",
    durationMs,
    diagnostics: [],
    entries: [entry, ...filler],
  };
}

test("a movie tail plans content segments at their source offsets", () => {
  const start = "2026-09-13T00:00:00.000Z";
  const schedule = continuationSchedule(
    {
      id: "tail",
      start,
      end: "2026-09-13T01:01:00.000Z",
      localStart: "00:00",
      localEnd: "01:01",
      durationMs: 3_660_000,
      contentDurationMs: 3_600_000,
      sourceOffsetMs: 3_600_000,
      kind: "movie",
      title: "Long Movie",
      mediaId: "movie",
      path: "/media/movie.mkv",
      movieRole: "weekend-closer",
      movieOccurrenceKey: "2026-09-12:double-feature-2",
      midrolls: [{ offsetMs: 1_800_000, durationMs: 60_000 }],
    },
    // A mid-roll pod can only be materialized from matched filler that is part of
    // this schedule, which is exactly what the boundary fill provides on air.
    [
      {
        id: "ad-entry",
        start: "2026-09-13T01:01:00.000Z",
        end: "2026-09-13T01:02:00.000Z",
        localStart: "01:01",
        localEnd: "01:02",
        durationMs: 60_000,
        kind: "commercial",
        title: "Ad",
        mediaId: "ad",
        path: "/media/ad.mkv",
      },
    ],
  );
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    mapping,
    snapshots,
  );
  expect(plan.blockingErrors).toEqual([]);
  expect(plan.syncEligible).toBe(true);
  expect(plan.operations.at(-1)?.payload).toEqual([
    { type: "content", id: "movie", duration: 1_800_000, startOffsetMs: 3_600_000 },
    { type: "content", id: "ad", duration: 60_000 },
    { type: "content", id: "movie", duration: 1_800_000, startOffsetMs: 5_400_000 },
    { type: "content", id: "ad", duration: 60_000 },
  ]);
});

test("a tail without mid-rolls still resumes at its source offset", () => {
  const schedule = continuationSchedule({
    id: "tail",
    start: "2026-09-13T00:00:00.000Z",
    end: "2026-09-13T00:30:00.000Z",
    localStart: "00:00",
    localEnd: "00:30",
    durationMs: 1_800_000,
    sourceOffsetMs: 7_200_000,
    kind: "movie",
    title: "Long Movie",
    mediaId: "movie",
    path: "/media/movie.mkv",
  });
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    mapping,
    snapshots,
  );
  expect(plan.syncEligible).toBe(true);
  expect(plan.operations.at(-1)?.payload).toEqual([
    { type: "content", id: "movie", duration: 1_800_000, startOffsetMs: 7_200_000 },
  ]);
});
