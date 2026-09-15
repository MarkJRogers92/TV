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
  durationMs: 7_260_000,
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
      end: "2026-09-13T02:00:00.000Z",
      localStart: "00:00",
      localEnd: "02:00",
      durationMs: 7_200_000,
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
      start: "2026-09-13T02:00:00.000Z",
      end: "2026-09-13T02:01:00.000Z",
      localStart: "02:00",
      localEnd: "02:01",
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
    {
      type: "flex",
      duration: 60_000,
      fillerConfig: {
        fillerListIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        fillerRepeatCooldownMs: 7_200_000,
        origin: "midroll",
      },
    },
    {
      type: "content",
      id: "movie",
      duration: 3_600_000,
      startOffsetMs: 1_800_000,
    },
    {
      type: "flex",
      duration: 60_000,
      fillerConfig: {
        fillerListIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        fillerRepeatCooldownMs: 7_200_000,
        origin: "midroll",
      },
    },
    {
      type: "content",
      id: "movie",
      duration: 1_800_000,
      startOffsetMs: 5_400_000,
    },
    { type: "content", id: "ad", duration: 60_000 },
  ]);
});

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
  const mod = (await import(
    "../../src/integrations/tunarr/types.js"
  )) as unknown as {
    normalizeLibraryIds: (ids: unknown) => string[];
    resolveLibraryIds: (input: unknown) => string[];
  };
  expect(typeof mod.normalizeLibraryIds).toBe("function");
  expect(typeof mod.resolveLibraryIds).toBe("function");
  expect(mod.normalizeLibraryIds([" lib-a ", "lib-a", "lib-b ", "", "  "])).toEqual([
    "lib-a",
    "lib-b",
  ]);
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
  const mod = (await import(
    "../../src/integrations/tunarr/types.js"
  )) as unknown as {
    resolveLibraryIds: (input: unknown) => string[];
  };
  const canonical = mod.resolveLibraryIds({ libraryIds: ["lib-a", "lib-b"] });
  const plan = buildTunarrSyncPlan(
    schedule,
    inventory,
    capabilities,
    { libraryId: canonical[0], libraryIds: canonical, channelId: "7", createChannel: false } as never,
    snapshots,
  );
  expect(plan.mapping).toMatchObject({ libraryIds: ["lib-a", "lib-b"] });
  expect(plan.syncEligible).toBe(true);
});
