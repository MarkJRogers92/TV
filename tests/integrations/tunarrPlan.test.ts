import { expect, test } from "vitest";
import type { MediaItem, Schedule } from "../../src/domain/models.js";
import { buildTunarrSyncPlan } from "../../src/integrations/tunarr/plan.js";
import type {
  TunarrCapabilities,
  TunarrInventory,
  TunarrLineup,
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

test("preserved mapping replaces a day without replacing the full channel timeline", () => {
  const start = Date.parse(schedule.entries[0].start);
  const day: Schedule = { ...schedule, durationMs: 120_000, entries: [
    { ...schedule.entries[0], durationMs: 120_000, contentDurationMs: undefined, midrolls: undefined,
      end: new Date(start + 120_000).toISOString() },
  ] };
  const remote: TunarrSnapshots = { ...snapshots,
    channels: [{ ...existingChannel, startTime: start - 60_000, duration: 300_000 }],
    programming: { ...programming, totalPrograms: 3, lineup: [
      { type: "content", id: "ad", duration: 60_000 },
      { type: "content", id: "movie", duration: 120_000 },
      { type: "content", id: "future", duration: 120_000 },
    ] },
  };
  const mapping = { libraryId: "lib", channelId: "7", createChannel: false, preserveExistingLineup: true };
  const plan = buildTunarrSyncPlan(day, inventory, capabilities, mapping, remote);
  expect(plan.blockingErrors).toEqual([]);
  expect(plan.operations[0]).toMatchObject({ payload: { startTime: start - 60_000, duration: 300_000 } });
  const programmed = plan.operations.find(operation => operation.type === "programming");
  expect(programmed).toMatchObject({ payload: remote.programming!.lineup });
  const changed = structuredClone(remote);
  changed.programming!.lineup[1] = { type: "content", id: "different", duration: 120_000 };
  expect(buildTunarrSyncPlan(day, inventory, capabilities, mapping, changed).syncEligible).toBe(false);
});

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

const voicedCatalogItem = (
  id: string,
  path: string,
  role: "break" | "return",
  extraTags: string[] = [],
  durationMs = role === "break" ? 10_000 : 8_000,
): MediaItem => ({
  id,
  source: "local-folder",
  path,
  kind: "bumper",
  title: id,
  durationMs,
  durationStatus: "ok",
  available: true,
  tags: [
    "voiced-continuity",
    `continuity-role=${role}`,
    "continuity-scope=evergreen",
    role === "break"
      ? "continuity-map=MARKTV_BREAK_OUT_001"
      : "continuity-map=MARKTV_RETURN_APOLOGY_001",
    "continuity-channel=marktv-laughs",
    ...extraTags,
  ],
});

function voicedMidrollSchedule(
  adDurationMs = 42_000,
  withExplicitVoice = false,
): Schedule {
  const start = "2026-09-22T12:00:00.000Z";
  const episodeDurationMs = 660_000;
  const episode = {
    id: "episode-entry",
    start,
    end: new Date(Date.parse(start) + episodeDurationMs).toISOString(),
    localStart: "12:00",
    localEnd: "12:11",
    durationMs: episodeDurationMs,
    contentDurationMs: 600_000,
    kind: "episode" as const,
    title: "Episode",
    mediaId: "episode",
    path: "/media/episode.mkv",
    midrolls: [{ offsetMs: 300_000, durationMs: 60_000 }],
  };
  const ad = {
    id: "ad-entry",
    start: episode.end,
    end: new Date(Date.parse(episode.end) + adDurationMs).toISOString(),
    localStart: "12:11",
    localEnd: "12:12",
    durationMs: adDurationMs,
    kind: "commercial" as const,
    title: "Commercial",
    mediaId: "ad",
    path: "/media/ad.mkv",
  };
  const explicitVoice = withExplicitVoice
    ? [{
        id: "explicit-voice-entry",
        start: new Date(Date.parse(start) - 30_000).toISOString(),
        end: start,
        localStart: "11:59",
        localEnd: "12:00",
        durationMs: 30_000,
        kind: "bumper" as const,
        title: "Scheduled voice",
        mediaId: "voice-break",
        path: "/media/voices/break.mp4",
      }]
    : [];
  const entries = [...explicitVoice, episode, ad];
  return {
    id: "voiced-midroll",
    channelId: "marktv-laughs",
    channelName: "Laughs",
    channelNumber: 7,
    date: "2026-09-22",
    timezone: "UTC",
    seed: "voiced-seed",
    revision: "revision-1",
    generatedAt: start,
    durationMs: entries.reduce((total, entry) => total + entry.durationMs, 0),
    diagnostics: [],
    entries,
  };
}

const voicedInventory: TunarrInventory = [
  ...inventory,
  {
    id: "voice-break",
    path: "/media/voices/break.mp4",
    program: { ...wrapper("voice-break", "/media/voices/break.mp4"), duration: 10_000 },
  },
  {
    id: "voice-return",
    path: "/media/voices/return.mp4",
    program: { ...wrapper("voice-return", "/media/voices/return.mp4"), duration: 8_000 },
  },
];

const voicedCatalog = [
  voicedCatalogItem("voice-break", "/media/voices/break.mp4", "break"),
  voicedCatalogItem("voice-return", "/media/voices/return.mp4", "return"),
];

function plannedLineup(plan: ReturnType<typeof buildTunarrSyncPlan>): TunarrLineup {
  const operation = plan.operations.find(
    (candidate) => candidate.type === "programming",
  );
  return operation?.type === "programming" ? operation.payload : [];
}

test("places voiced break and return at the edges of a midroll and preserves exact duration", () => {
  const plan = buildTunarrSyncPlan(
    voicedMidrollSchedule(),
    voicedInventory,
    capabilities,
    mapping,
    snapshots,
    voicedCatalog,
  );
  const lineup = plannedLineup(plan);
  expect(plan.blockingErrors).toEqual([]);
  expect(plan.syncEligible).toBe(true);
  expect(lineup).toContainEqual({ type: "content", id: "voice-break", duration: 10_000 });
  expect(lineup).toContainEqual({ type: "content", id: "voice-return", duration: 8_000 });
  expect(lineup).toEqual([
    { type: "content", id: "episode", duration: 300_000, startOffsetMs: 0 },
    { type: "content", id: "voice-break", duration: 10_000 },
    { type: "content", id: "ad", duration: 42_000 },
    { type: "content", id: "voice-return", duration: 8_000 },
    { type: "content", id: "episode", duration: 300_000, startOffsetMs: 300_000 },
    { type: "content", id: "ad", duration: 42_000 },
  ]);
  expect(lineup?.reduce((total, item) => total + item.duration, 0)).toBe(
    voicedMidrollSchedule().durationMs,
  );
});

test.each(["marktv-movies", "marktv-cult-movies"])(
  "uses only allowlisted shared break/return clips for %s midrolls",
  (channelId) => {
    const sharedCatalog = voicedCatalog.map((item) => ({
      ...item,
      tags: [...item.tags, "continuity-shared-channels=marktv-movies,marktv-cult-movies"],
    }));
    const sharedSchedule = { ...voicedMidrollSchedule(), channelId };
    const sharedMapping = { ...mapping, channelId: channelId === "marktv-movies" ? "8" : "9" };
    const sharedSnapshots = { ...snapshots, channels: [{ ...existingChannel, id: sharedMapping.channelId }] };
    const plan = buildTunarrSyncPlan(
      sharedSchedule,
      voicedInventory,
      capabilities,
      sharedMapping,
      sharedSnapshots,
      sharedCatalog,
    );
    expect(plan.syncEligible).toBe(true);
    expect(plannedLineup(plan)).toContainEqual({ type: "content", id: "voice-break", duration: 10_000 });
    expect(plannedLineup(plan)).toContainEqual({ type: "content", id: "voice-return", duration: 8_000 });
  },
);

test("normalizes fractional container milliseconds without accepting a different clip duration", () => {
  const fractionalInventory = voicedInventory.map((item) => item.id === "voice-break"
    ? { ...item, program: { ...item.program, duration: 10_000.333 } }
    : item);
  const plan = buildTunarrSyncPlan(voicedMidrollSchedule(), fractionalInventory, capabilities, mapping, snapshots, voicedCatalog);
  expect(plan.syncEligible).toBe(true);
  expect(plannedLineup(plan)).toContainEqual({ type: "content", id: "voice-break", duration: 10_000 });
});

test.each([
  ["missing inventory", voicedInventory.filter((item) => item.id !== "voice-break"), voicedCatalog],
  ["staged media", voicedInventory, [
    voicedCatalogItem("voice-break", "/media/voices/break.mp4", "break", ["continuity-staged-reason=needs-review"]),
    voicedCatalog[1]!,
  ]],
  ["unhealthy inventory", voicedInventory.map((item) => item.id === "voice-break"
    ? { ...item, program: { ...item.program, program: { ...item.program.program, state: "missing" } } }
    : item), voicedCatalog],
  ["duration mismatch", voicedInventory.map((item) => item.id === "voice-break"
    ? { ...item, program: { ...item.program, duration: 10_001 } }
    : item), voicedCatalog],
])("fails closed for %s even when the voiced combination would otherwise fit", (_name, candidateInventory, catalog) => {
  const plan = buildTunarrSyncPlan(
    voicedMidrollSchedule(),
    candidateInventory as TunarrInventory,
    capabilities,
    mapping,
    snapshots,
    catalog as MediaItem[],
  );
  const lineup = plannedLineup(plan);
  expect(plan.syncEligible).toBe(false);
  expect(lineup?.some((item) => item.id === "voice-break" || item.id === "voice-return")).toBe(false);
  expect(plan.blockingErrors).toContainEqual(expect.objectContaining({ code: "MIDROLL_EXACT_FILL_UNAVAILABLE" }));
});

test("does not use a voiced clip assigned to another MarkTV channel", () => {
  const schedule: Schedule = {
    ...voicedMidrollSchedule(60_000),
    channelId: "marktv-movies",
  };
  const plan = buildTunarrSyncPlan(
    schedule,
    voicedInventory,
    capabilities,
    mapping,
    snapshots,
    voicedCatalog,
  );
  const lineup = plannedLineup(plan);
  expect(plan.syncEligible).toBe(true);
  expect(lineup).not.toContainEqual(expect.objectContaining({ id: "voice-break" }));
  expect(lineup).not.toContainEqual(expect.objectContaining({ id: "voice-return" }));
  expect(lineup).toContainEqual({ type: "content", id: "ad", duration: 60_000 });
});

test("uses only actual commercials for the nested pod remainder", () => {
  const schedule = voicedMidrollSchedule(42_000);
  const filler = schedule.entries[1]!;
  filler.kind = "bumper";
  filler.mediaId = "bumper42";
  filler.path = "/media/bumper42.mkv";
  const commercial = {
    ...filler,
    id: "commercial60-entry",
    start: filler.end,
    end: new Date(Date.parse(filler.end) + 60_000).toISOString(),
    localStart: "12:12",
    localEnd: "12:13",
    durationMs: 60_000,
    kind: "commercial" as const,
    mediaId: "commercial60",
    path: "/media/commercial60.mkv",
  };
  schedule.entries.push(commercial);
  schedule.durationMs = schedule.entries.reduce(
    (total, entry) => total + entry.durationMs,
    0,
  );
  const plan = buildTunarrSyncPlan(
    schedule,
    [...voicedInventory,
      { id: "bumper42", path: filler.path!, program: wrapper("bumper42", filler.path!) },
      { id: "commercial60", path: commercial.path!, program: wrapper("commercial60", commercial.path!) },
    ],
    capabilities,
    mapping,
    snapshots,
    voicedCatalog,
  );
  const lineup = plannedLineup(plan);
  expect(plan.syncEligible).toBe(true);
  expect(lineup).not.toContainEqual(expect.objectContaining({ id: "voice-break" }));
  expect(lineup).not.toContainEqual(expect.objectContaining({ id: "voice-return" }));
  expect(lineup).toContainEqual({ type: "content", id: "commercial60", duration: 60_000 });
});

test("falls back to the unchanged exact pod when voiced clips leave no exact commercial fill", () => {
  const plan = buildTunarrSyncPlan(
    voicedMidrollSchedule(60_000),
    voicedInventory,
    capabilities,
    mapping,
    snapshots,
    voicedCatalog,
  );
  const lineup = plannedLineup(plan);
  expect(lineup).not.toContainEqual(expect.objectContaining({ id: "voice-break" }));
  expect(lineup).not.toContainEqual(expect.objectContaining({ id: "voice-return" }));
  expect(lineup).toContainEqual({ type: "content", id: "ad", duration: 60_000 });
});

test("applies the clip cooldown at each actual pod broadcast time", () => {
  const schedule = voicedMidrollSchedule(42_000);
  const episode = schedule.entries[0]!;
  const ad42 = schedule.entries[1]!;
  const ad60 = {
    ...ad42,
    id: "ad60-entry",
    start: episode.end,
    end: new Date(Date.parse(episode.end) + 60_000).toISOString(),
    durationMs: 60_000,
    mediaId: "ad60",
    path: "/media/ad60.mkv",
  };
  episode.durationMs = 720_000;
  episode.end = new Date(Date.parse(episode.start) + episode.durationMs).toISOString();
  episode.midrolls = [
    { offsetMs: 100_000, durationMs: 60_000 },
    { offsetMs: 400_000, durationMs: 60_000 },
  ];
  ad42.start = episode.end;
  ad42.end = new Date(Date.parse(ad42.start) + ad42.durationMs).toISOString();
  ad60.start = ad42.end;
  ad60.end = new Date(Date.parse(ad60.start) + ad60.durationMs).toISOString();
  schedule.entries.push(ad60);
  schedule.durationMs = schedule.entries.reduce(
    (total, entry) => total + entry.durationMs,
    0,
  );
  const plan = buildTunarrSyncPlan(
    schedule,
    [...voicedInventory, {
      id: "ad60",
      path: "/media/ad60.mkv",
      program: wrapper("ad60", "/media/ad60.mkv"),
    }],
    capabilities,
    mapping,
    snapshots,
    voicedCatalog,
  );
  const lineup = plannedLineup(plan);
  expect(plan.syncEligible).toBe(true);
  expect(lineup.filter((item) => item.id === "voice-break")).toHaveLength(1);
  expect(lineup.filter((item) => item.id === "voice-return")).toHaveLength(1);
  expect(lineup).toContainEqual({ type: "content", id: "ad60", duration: 60_000 });
});

test("never puts voiced clips in generic filler even when they are scheduled explicitly", () => {
  const plan = buildTunarrSyncPlan(
    voicedMidrollSchedule(42_000, true),
    voicedInventory,
    capabilities,
    mapping,
    snapshots,
    voicedCatalog,
  );
  const filler = plan.operations.find(
    (operation) =>
      operation.type === "filler-update" || operation.type === "filler-create",
  );
  expect(filler?.payload.programs.map((program) => program.id)).toEqual(["ad"]);
  expect(plannedLineup(plan)[0]).toMatchObject({ id: "voice-break" });
});

test("excludes the installed voiced root from generic filler when the catalog is absent", () => {
  const schedule = voicedMidrollSchedule(60_000, true);
  const voiceEntry = schedule.entries[0]!;
  const path = "/media/generated/voiced-canon-install-a/break.mp4";
  voiceEntry.path = path;
  voiceEntry.mediaId = "voice-root";
  const plan = buildTunarrSyncPlan(
    schedule,
    [...voicedInventory, {
      id: "voice-root",
      path,
      program: wrapper("voice-root", path),
    }],
    capabilities,
    mapping,
    snapshots,
  );
  const filler = plan.operations.find(
    (operation) =>
      operation.type === "filler-update" || operation.type === "filler-create",
  );
  expect(filler?.payload.programs.map((program) => program.id)).toEqual(["ad"]);
});

test("breaks inside one programme do not reuse the same spot when others fit", () => {
  const ads = ["ad-a", "ad-b", "ad-c", "ad-d"];
  const adInventory: TunarrInventory = [
    {
      id: "movie",
      path: "/media/movie.mkv",
      program: wrapper("movie", "/media/movie.mkv"),
    },
    ...ads.map((id) => ({
      id,
      path: `/media/${id}.mkv`,
      program: wrapper(id, `/media/${id}.mkv`),
    })),
  ];
  const clock = (minute: number) => `2026-09-13T02:${String(minute).padStart(2, "0")}:00.000Z`;
  const adEntries: Schedule["entries"] = ads.map((id, index) => ({
    id: `entry-${id}`,
    start: clock(4 + index),
    end: clock(5 + index),
    localStart: `02:0${4 + index}`,
    localEnd: `02:0${5 + index}`,
    durationMs: 60_000,
    kind: "commercial" as const,
    title: id,
    path: `/media/${id}.mkv`,
  }));
  const fourBreaks: Schedule = {
    ...schedule,
    durationMs: 7_740_000,
    entries: [
      {
        id: "movie-entry",
        start: clock(0),
        end: clock(4),
        localStart: "00:00",
        localEnd: "02:04",
        durationMs: 7_440_000,
        contentDurationMs: 7_200_000,
        kind: "movie",
        title: "Movie",
        path: "/media/movie.mkv",
        midrolls: [
          { offsetMs: 1_200_000, durationMs: 60_000 },
          { offsetMs: 2_400_000, durationMs: 60_000 },
          { offsetMs: 3_600_000, durationMs: 60_000 },
          { offsetMs: 4_800_000, durationMs: 60_000 },
        ],
      },
      ...adEntries,
      {
        id: "tail",
        start: clock(8),
        end: clock(9),
        localStart: "02:08",
        localEnd: "02:09",
        durationMs: 60_000,
        kind: "flex",
        title: "Flexible programming",
      },
    ],
  };
  const plan = buildTunarrSyncPlan(
    fourBreaks,
    adInventory,
    capabilities,
    { libraryId: "lib", channelId: "7", createChannel: false },
    snapshots,
  );
  expect(plan.syncEligible).toBe(true);
  const operation = plan.operations[2];
  if (operation.type !== "programming")
    throw new Error("expected a programming operation");
  const lineup = operation.payload;
  // The movie is split into five content pieces with one pod between each pair,
  // so the first nine items are the film and its four breaks. (The schedule's own
  // commercial entries come after them and are not break fill.)
  const usedIds = lineup
    .slice(0, 9)
    .filter((item) => item.type === "content" && item.id !== "movie")
    .map((item) => item.id);
  expect(usedIds).toHaveLength(4);
  // Four one-minute breaks with four distinct one-minute spots available: the
  // bag is not emptied onto the first break and repeated for the rest.
  expect(new Set(usedIds).size).toBe(4);
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
    buildTunarrSyncPlan(schedule, inventory, capabilities, mapping, {
      ...snapshots,
      channels: [{
        ...existingChannel,
        sessions: [{ connections: [{ lastHeartbeat: 1, lastHeartbeatStr: "before" }] }],
      }],
    }).fingerprint,
  ).toBe(base.fingerprint);
  expect(
    buildTunarrSyncPlan(schedule, inventory, capabilities, mapping, {
      ...snapshots,
      channels: [{ ...existingChannel, name: "Updated channel configuration" }],
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

const TERMINAL_UUID = "11111111-1111-4111-8111-111111111111";

/** The mapped plan inputs the Tunarr page would send for the existing channel. */
const mapping = {
  libraryId: "lib",
  channelId: "7",
  createChannel: false,
} as const;

test("refuses a schedule path whose only Tunarr match Tunarr reports as missing", () => {
  // The path looks right - the movie entry says /media/movie.mkv and so does
  // this inventory item - but Tunarr has marked the file it points at missing,
  // so a lineup built on it would air offline time.
  const missing: TunarrInventory = inventory.map((item) =>
    item.id === "movie"
      ? { ...item, program: { ...item.program, state: "missing" } }
      : item,
  );

  const plan = buildTunarrSyncPlan(
    schedule,
    missing,
    capabilities,
    mapping,
    snapshots,
  );

  expect(plan.syncEligible).toBe(false);
  expect(plan.blockingErrors).toContainEqual(
    expect.objectContaining({
      code: "UNUSABLE_MEDIA_STATE",
      message: expect.stringContaining("/media/movie.mkv"),
    }),
  );
  // Counted as a miss rather than a match: nothing playable answers that path.
  expect(plan.matchCounts).toMatchObject({ matched: 1, unmatched: 1 });
  expect(
    plan.operations.find((operation) => operation.type === "programming")
      ?.payload,
  ).not.toContainEqual(expect.objectContaining({ id: "movie" }));
});

test("treats a program Tunarr declares unusable as no match, wherever it says so", () => {
  const path = "/media/movie.mkv";
  const unusable: Array<[string, TunarrInventory[number]["program"]]> = [
    [
      "a wrapper state",
      {
        type: "content",
        id: "movie",
        duration: 60_000,
        state: "missing",
        program: { uuid: TERMINAL_UUID, sourceType: "local", externalId: path },
      },
    ],
    [
      "a terminal program state",
      {
        type: "content",
        id: "movie",
        duration: 60_000,
        program: {
          uuid: TERMINAL_UUID,
          sourceType: "local",
          externalId: path,
          state: "missing",
        },
      },
    ],
    [
      "a media-item state",
      {
        type: "content",
        id: "movie",
        duration: 60_000,
        program: {
          uuid: TERMINAL_UUID,
          sourceType: "local",
          externalId: path,
          mediaItem: {
            state: "missing",
            locations: [{ type: "local", path }],
          },
        },
      },
    ],
    [
      "an explicit unavailable flag",
      {
        type: "content",
        id: "movie",
        duration: 60_000,
        available: false,
        program: { uuid: TERMINAL_UUID, sourceType: "local", externalId: path },
      },
    ],
    [
      "a state MarkTV does not recognize",
      {
        type: "content",
        id: "movie",
        duration: 60_000,
        state: "quarantined",
        program: { uuid: TERMINAL_UUID, sourceType: "local", externalId: path },
      },
    ],
  ];

  for (const [where, program] of unusable) {
    const plan = buildTunarrSyncPlan(
      schedule,
      [
        { id: "movie", path, program },
        ...inventory.filter((item) => item.id !== "movie"),
      ],
      capabilities,
      mapping,
      snapshots,
    );
    expect(plan.syncEligible, `${where} must block`).toBe(false);
    expect(plan.blockingErrors, `${where} must block`).toContainEqual(
      expect.objectContaining({ code: "UNUSABLE_MEDIA_STATE" }),
    );
    expect(
      plan.operations.find((operation) => operation.type === "programming")
        ?.payload,
      `${where} must not be programmed`,
    ).not.toContainEqual(expect.objectContaining({ id: "movie" }));
  }
});

test("still matches a playable program when an unusable one shares its path", () => {
  // Two Tunarr rows exposing one path is Tunarr's own business. Only the one it
  // can actually play can satisfy the schedule, so this stays eligible rather
  // than becoming ambiguous.
  const movie = inventory[0]!;
  const plan = buildTunarrSyncPlan(
    schedule,
    [
      ...inventory,
      {
        ...movie,
        id: "movie-copy",
        program: { ...movie.program, state: "missing" },
      },
    ],
    capabilities,
    mapping,
    snapshots,
  );

  expect(plan.syncEligible).toBe(true);
  expect(plan.matchCounts).toMatchObject({ matched: 2, unmatched: 0 });
});
