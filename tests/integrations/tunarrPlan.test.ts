import { expect, test } from "vitest";
import type { Schedule } from "../../src/domain/models.js";
import { buildTunarrSyncPlan } from "../../src/integrations/tunarr/plan.js";
import type {
  TunarrCapabilities,
  TunarrInventory,
  TunarrSnapshots,
} from "../../src/integrations/tunarr/types.js";

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
  {
    id: "ad",
    path: "/media/ad.mkv",
    program: wrapper("ad", "/media/ad.mkv"),
  },
  {
    id: "episode",
    path: "/media/episode.mkv",
    program: wrapper("episode", "/media/episode.mkv"),
  },
  {
    id: "station-id",
    path: "/media/station-id.mkv",
    program: wrapper("station-id", "/media/station-id.mkv"),
  },
];
const existingChannel = {
  id: "7",
  name: "Old",
  number: 99,
  duration: 1,
  groupTitle: "Existing",
  guideMinimumDuration: 30_000,
  icon: {
    path: "old.png",
    width: 1,
    duration: 1,
    position: "top-left" as const,
  },
  startTime: 123,
  stealth: true,
  offline: { mode: "pic" as const },
  onDemand: { enabled: false },
  streamMode: "hls" as const,
  transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  disableFillerOverlay: true,
  subtitlesEnabled: false,
  programCount: 0,
};
const programming = {
  totalPrograms: 0,
  programs: {},
  lineup: [],
  startTimeOffsets: [],
};
const snapshots: TunarrSnapshots = {
  channels: [existingChannel],
  fillerLists: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "MarkTV - Laughs (marktv)",
      contentCount: 0,
    },
  ],
  fillerPrograms: { "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": [] },
  transcodeConfigs: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Default" },
  ],
  programming,
};
const schedule: Schedule = {
  id: "schedule",
  channelId: "marktv",
  channelName: "Laughs",
  channelNumber: 7,
  date: "2026-09-13",
  timezone: "UTC",
  seed: "seed",
  revision: "revision-1",
  generatedAt: "2026-09-13T00:00:00.000Z",
  durationMs: 7_380_000,
  diagnostics: [],
  breakPolicy: {
    boundaryMinutes: 15,
    cooldownMinutes: 120,
    poolIds: [],
    stationIdPoolIds: [],
  },
  entries: [
    {
      id: "movie-entry",
      start: "2026-09-13T00:00:00.000Z",
      end: "2026-09-13T02:02:00.000Z",
      localStart: "00:00",
      localEnd: "02:02",
      durationMs: 7_320_000,
      contentDurationMs: 7_200_000,
      kind: "movie",
      title: "Movie",
      path: "/media/movie.mkv",
      midrolls: [
        { offsetMs: 1_800_000, durationMs: 60_000 },
        { offsetMs: 5_400_000, durationMs: 60_000 },
      ],
    },
    {
      id: "ad-entry",
      start: "2026-09-13T02:02:00.000Z",
      end: "2026-09-13T02:03:00.000Z",
      localStart: "02:02",
      localEnd: "02:03",
      durationMs: 60_000,
      kind: "commercial",
      title: "Ad",
      path: "/media/ad.mkv",
    },
  ],
};

test("plans channel/filler updates and the exact midroll lineup", () => {
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  expect(plan.syncEligible).toBe(true);
  expect(plan.operations.map((operation) => operation.type)).toEqual([
    "channel-update",
    "filler-update",
    "programming",
  ]);
  expect(plan.operations[0]).toMatchObject({
    type: "channel-update",
    channelId: "7",
    payload: {
      name: "Laughs",
      number: 7,
      groupTitle: "Existing",
      icon: { path: "old.png" },
    },
  });
  expect(plan.operations[1]).toMatchObject({
    type: "filler-update",
    fillerListId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    payload: {
      name: "MarkTV - Laughs (marktv)",
      programs: [wrapper("ad", "/media/ad.mkv")],
    },
  });
  const lineup = plan.operations[2].payload;
  expect(lineup).toHaveLength(6);
  expect(lineup).toEqual([
    { type: "content", id: "movie", duration: 1_800_000, startOffsetMs: 0 },
    { type: "content", id: "ad", duration: 60_000 },
    {
      type: "content",
      id: "movie",
      duration: 3_600_000,
      startOffsetMs: 1_800_000,
    },
    { type: "content", id: "ad", duration: 60_000 },
    {
      type: "content",
      id: "movie",
      duration: 1_800_000,
      startOffsetMs: 5_400_000,
    },
    { type: "content", id: "ad", duration: 60_000 },
  ]);
});

test("splits an episode at exact source offsets and preserves broadcast duration", () => {
  const episodeSchedule: Schedule = {
    ...schedule,
    durationMs: 1_620_000,
    entries: [
      {
        id: "episode-entry",
        start: "2026-09-13T00:00:00.000Z",
        end: "2026-09-13T00:25:00.000Z",
        localStart: "00:00",
        localEnd: "00:25",
        durationMs: 1_500_000,
        contentDurationMs: 1_380_000,
        kind: "episode",
        title: "Episode",
        path: "/media/episode.mkv",
        midrolls: [
          { offsetMs: 448_500, durationMs: 60_000 },
          { offsetMs: 903_500, durationMs: 60_000 },
        ],
      },
      {
        id: "ad-entry",
        start: "2026-09-13T00:25:00.000Z",
        end: "2026-09-13T00:26:00.000Z",
        localStart: "00:25",
        localEnd: "00:26",
        durationMs: 60_000,
        kind: "commercial",
        title: "Ad",
        path: "/media/ad.mkv",
      },
      {
        id: "flex-entry",
        start: "2026-09-13T00:26:00.000Z",
        end: "2026-09-13T00:27:00.000Z",
        localStart: "00:26",
        localEnd: "00:27",
        durationMs: 60_000,
        kind: "flex",
        title: "Flexible programming",
      },
    ],
  };
  const plan = buildTunarrSyncPlan(
    episodeSchedule,
    inventory,
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  expect(plan.syncEligible).toBe(true);
  const programmingOperation = plan.operations.at(-1)!;
  expect(programmingOperation.type).toBe("programming");
  const lineup =
    programmingOperation.type === "programming"
      ? programmingOperation.payload
      : [];
  expect(lineup).toEqual([
    { type: "content", id: "episode", duration: 448_500, startOffsetMs: 0 },
    { type: "content", id: "ad", duration: 60_000 },
    {
      type: "content",
      id: "episode",
      duration: 455_000,
      startOffsetMs: 448_500,
    },
    { type: "content", id: "ad", duration: 60_000 },
    {
      type: "content",
      id: "episode",
      duration: 476_500,
      startOffsetMs: 903_500,
    },
    { type: "content", id: "ad", duration: 60_000 },
    { type: "flex", duration: 60_000 },
  ]);
  expect(lineup.reduce((total, item) => total + item.duration, 0)).toBe(
    episodeSchedule.durationMs,
  );
});

test("materializes mid-roll commercials instead of leaving Tunarr offline flex", () => {
  const adInventory = Array.from({ length: 5 }, (_, index) => ({
    id: `ad-${index + 1}`,
    path: `/media/ad-${index + 1}.mkv`,
    program: {
      ...wrapper(`ad-${index + 1}`, `/media/ad-${index + 1}.mkv`),
      duration: 30_000,
    },
  }));
  const adEntries = adInventory.map((item, index) => ({
    id: `ad-entry-${index + 1}`,
    start: new Date(Date.parse("2026-09-13T00:25:30.000Z") + index * 30_000).toISOString(),
    end: new Date(Date.parse("2026-09-13T00:26:00.000Z") + index * 30_000).toISOString(),
    localStart: `00:${String(25 + Math.floor((30 + index * 30) / 60)).padStart(2, "0")}`,
    localEnd: `00:${String(25 + Math.floor((60 + index * 30) / 60)).padStart(2, "0")}`,
    durationMs: 30_000,
    kind: "commercial" as const,
    title: `Ad ${index + 1}`,
    path: item.path,
  }));
  const episodeSchedule: Schedule = {
    ...schedule,
    durationMs: 1_680_000,
    entries: [
      {
        id: "episode-entry",
        start: "2026-09-13T00:00:00.000Z",
        end: "2026-09-13T00:25:30.000Z",
        localStart: "00:00",
        localEnd: "00:25",
        durationMs: 1_530_000,
        contentDurationMs: 1_380_000,
        kind: "episode",
        title: "Episode",
        path: "/media/episode.mkv",
        midrolls: [{ offsetMs: 450_000, durationMs: 150_000 }],
      },
      ...adEntries,
    ],
  };
  const plan = buildTunarrSyncPlan(
    episodeSchedule,
    [...inventory, ...adInventory],
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  expect(plan.syncEligible).toBe(true);
  const programming = plan.operations.find(
    (operation) => operation.type === "programming",
  );
  const lineup = programming?.type === "programming" ? programming.payload : [];
  const firstResume = lineup.findIndex(
    (item) => item.type === "content" && item.startOffsetMs === 450_000,
  );
  const midroll = lineup.slice(1, firstResume);
  expect(midroll).toHaveLength(5);
  expect(midroll.every((item) => item.type === "content")).toBe(true);
  expect(midroll.reduce((total, item) => total + item.duration, 0)).toBe(150_000);
});

test("keeps station IDs out of the mid-roll filler list", () => {
  const withStationId: Schedule = {
    ...schedule,
    durationMs: schedule.durationMs + 60_000,
    entries: [
      ...schedule.entries,
      {
        id: "station-id-entry",
        start: "2026-09-13T02:03:00.000Z",
        end: "2026-09-13T02:04:00.000Z",
        localStart: "02:03",
        localEnd: "02:04",
        durationMs: 60_000,
        kind: "station-id",
        title: "Station ID",
        path: "/media/station-id.mkv",
      },
    ],
  };
  const plan = buildTunarrSyncPlan(
    withStationId,
    inventory,
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  const filler = plan.operations.find(
    (operation) => operation.type === "filler-update",
  );
  expect(filler?.type === "filler-update" && filler.payload.programs).toEqual([
    wrapper("ad", "/media/ad.mkv"),
  ]);
});

test.each([
  {
    name: "duplicate offsets",
    midrolls: [
      { offsetMs: 450_000, durationMs: 150_000 },
      { offsetMs: 450_000, durationMs: 150_000 },
    ],
    contentDurationMs: 1_380_000,
    durationMs: 1_680_000,
  },
  {
    name: "offset beyond source duration",
    midrolls: [{ offsetMs: 1_400_000, durationMs: 150_000 }],
    contentDurationMs: 1_380_000,
    durationMs: 1_530_000,
  },
  {
    name: "broadcast runtime mismatch",
    midrolls: [{ offsetMs: 450_000, durationMs: 150_000 }],
    contentDurationMs: 1_380_000,
    durationMs: 1_380_000,
  },
  {
    name: "legacy mid-roll without explicit source duration",
    midrolls: [{ offsetMs: 450_000, durationMs: 150_000 }],
    contentDurationMs: undefined,
    durationMs: 1_380_000,
  },
])(
  "blocks $name instead of silently rewriting the content",
  ({ midrolls, contentDurationMs, durationMs }) => {
    const invalid = {
      ...schedule,
      durationMs,
      entries: [
        {
          ...schedule.entries[0],
          kind: "episode" as const,
          path: "/media/episode.mkv",
          durationMs,
          contentDurationMs,
          end: new Date(
            Date.parse(schedule.entries[0].start) + durationMs,
          ).toISOString(),
          midrolls,
        },
      ],
    };
    const plan = buildTunarrSyncPlan(
      invalid,
      inventory,
      capabilities,
      { libraryId: "lib", channelId: "7", createChannel: false },
      snapshots,
    );
    expect(plan.syncEligible).toBe(false);
    expect(plan.blockingErrors).toContainEqual(
      expect.objectContaining({ code: "INVALID_MIDROLL_LAYOUT" }),
    );
  },
);

test("blocks channel creation without a verified transcode and plans safe defaults", () => {
  const baseMapping = { libraryId: "lib", createChannel: true };
  const empty = { ...snapshots, channels: [], programming: undefined };
  const missing = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    baseMapping,
    empty,
  );
  expect(missing.blockingErrors).toContainEqual(
    expect.objectContaining({ code: "TRANSCODE_CONFIG_REQUIRED" }),
  );
  const created = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    {
      ...baseMapping,
      transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    empty,
  );
  expect(created.syncEligible).toBe(true);
  expect(created.operations[0]).toMatchObject({
    type: "channel-create",
    payload: {
      type: "new",
      channel: {
        name: "Laughs",
        number: 7,
        transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        offline: { mode: "pic" },
        onDemand: { enabled: false },
        streamMode: "hls",
        subtitlesEnabled: false,
      },
    },
  });
});

test("blocks midroll sync when no usable filler list can be created", () => {
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory.slice(0, 1),
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    { ...snapshots, fillerLists: [], fillerPrograms: {} },
  );
  expect(plan.blockingErrors).toContainEqual(
    expect.objectContaining({ code: "MIDROLL_FILLER_UNAVAILABLE" }),
  );
});

test("blocks midroll sync when complete spots cannot exactly fill the break", () => {
  const unfillable: Schedule = {
    ...schedule,
    durationMs: 7_440_000,
    entries: [
      {
        ...schedule.entries[0],
        durationMs: 7_380_000,
        midrolls: [
          { offsetMs: 1_800_000, durationMs: 90_000 },
          { offsetMs: 5_400_000, durationMs: 90_000 },
        ],
      },
      schedule.entries[1],
    ],
  };
  const plan = buildTunarrSyncPlan(
    unfillable,
    inventory,
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  expect(plan.syncEligible).toBe(false);
  expect(plan.blockingErrors).toContainEqual(
    expect.objectContaining({ code: "MIDROLL_EXACT_FILL_UNAVAILABLE" }),
  );
});

test("blocks duplicate, unmatched, placeholder, and relative media", () => {
  const mapping = { libraryId: "lib", channelId: "7", createChannel: false };
  expect(
    buildTunarrSyncPlan(
      schedule,
      [...inventory, inventory[0]],
      capabilities,
      mapping,
      snapshots,
    ).blockingErrors,
  ).toContainEqual(expect.objectContaining({ code: "AMBIGUOUS_MEDIA_PATH" }));
  expect(
    buildTunarrSyncPlan(schedule, [], capabilities, mapping, snapshots)
      .blockingErrors,
  ).toContainEqual(expect.objectContaining({ code: "UNMATCHED_MEDIA_PATH" }));
  expect(
    buildTunarrSyncPlan(
      { ...schedule, entries: [{ ...schedule.entries[0], path: undefined }] },
      [],
      capabilities,
      mapping,
      snapshots,
    ).blockingErrors,
  ).toContainEqual(expect.objectContaining({ code: "PLACEHOLDER_MEDIA" }));
  expect(() =>
    buildTunarrSyncPlan(
      {
        ...schedule,
        entries: [{ ...schedule.entries[0], path: "relative.mkv" }],
      },
      [],
      capabilities,
      mapping,
      snapshots,
    ),
  ).toThrowError(expect.objectContaining({ code: "RELATIVE_MEDIA_PATH" }));
});

test("fingerprints remote snapshots and user creation inputs", () => {
  const mapping = { libraryId: "lib", channelId: "7", createChannel: false };
  const base = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    mapping,
    snapshots,
  );
  expect(
    buildTunarrSyncPlan(schedule, inventory, capabilities, mapping, {
      ...snapshots,
      transcodeConfigs: [],
    }).fingerprint,
  ).not.toBe(base.fingerprint);
  expect(
    buildTunarrSyncPlan(
      schedule,
      inventory,
      { ...capabilities, version: "next" },
      mapping,
      snapshots,
    ).fingerprint,
  ).not.toBe(base.fingerprint);
  expect(
    buildTunarrSyncPlan(
      { ...schedule, revision: "next" },
      inventory,
      capabilities,
      mapping,
      snapshots,
    ).fingerprint,
  ).not.toBe(base.fingerprint);
});

test("blocks a valid HTTP health response that reports an unhealthy subsystem", () => {
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory,
    { ...capabilities, healthy: false },
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  expect(plan.blockingErrors).toContainEqual(
    expect.objectContaining({ code: "TUNARR_UNHEALTHY" }),
  );
});

test("normalizes library IDs by trimming and deduplicating", async () => {
  const mod =
    (await import("../../src/integrations/tunarr/types.js")) as unknown as {
      normalizeLibraryIds: (ids: unknown) => string[];
      resolveLibraryIds: (input: unknown) => string[];
    };
  expect(typeof mod.normalizeLibraryIds).toBe("function");
  expect(typeof mod.resolveLibraryIds).toBe("function");
  expect(
    mod.normalizeLibraryIds([" lib-a ", "lib-a", "lib-b ", "", "  "]),
  ).toEqual(["lib-a", "lib-b"]);
  expect(mod.resolveLibraryIds({ libraryId: "lib" })).toEqual(["lib"]);
  expect(mod.resolveLibraryIds({ libraryIds: [" b ", "a", "b"] })).toEqual([
    "b",
    "a",
  ]);
  expect(
    mod.resolveLibraryIds({ libraryId: "legacy", libraryIds: ["a", "legacy"] }),
  ).toEqual(["a", "legacy"]);
});

test("preserves canonical libraryIds in the sync plan mapping", async () => {
  const mod =
    (await import("../../src/integrations/tunarr/types.js")) as unknown as {
      resolveLibraryIds: (input: unknown) => string[];
    };
  const canonical = mod.resolveLibraryIds({ libraryIds: ["lib-a", "lib-b"] });
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    {
      libraryId: canonical[0],
      libraryIds: canonical,
      channelId: "7",
      createChannel: false,
    } as never,
    snapshots,
  );
  expect(plan.mapping).toMatchObject({ libraryIds: ["lib-a", "lib-b"] });
  expect(plan.syncEligible).toBe(true);
});
