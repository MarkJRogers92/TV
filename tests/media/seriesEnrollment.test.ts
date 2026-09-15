import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import {
  createRepositories,
  type Repositories,
} from "../../src/db/repositories.js";
import { seedDemoIfEmpty } from "../../src/demo/marktvLaughs.js";
import { episodeKey } from "../../src/acquisition/models.js";
import {
  ENROLLMENT_CHANNEL_ID,
  reconcileImportedSeries,
} from "../../src/media/seriesEnrollment.js";
import { generateSchedule } from "../../src/scheduler/generate.js";
import type { Channel } from "../../src/domain/models.js";

const SERIES = "According to Jim";
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

async function setup({ seedChannel = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "marktv-enroll-"));
  dirs.push(dir);
  const repositories = createRepositories(openDatabase(dir));
  if (seedChannel) seedDemoIfEmpty(repositories, "America/Chicago");
  return repositories;
}

let sequence = 0;

/**
 * Completes one acquisition import the way the coordinator's finalize step does:
 * a placing job whose ledger, media row, and job state commit together.
 */
function importEpisode(
  repositories: Repositories,
  {
    series = SERIES,
    season = 1,
    episode,
    title = `Episode ${episode}`,
    directory = "/managed",
  }: {
    series?: string;
    season?: number;
    episode: number;
    title?: string;
    directory?: string;
  },
) {
  const suffix = `${season}-${episode}-${(sequence += 1)}`;
  const jobId = `job-${suffix}`;
  const wantedId = `wanted-${suffix}`;
  const mediaId = `media-${suffix}`;
  const canonicalName = `${series} - S0${season}E0${episode} - ${title}.mkv`;
  const destinationPath = `${directory}/${canonicalName}`;
  const at = "2026-09-14T00:00:00.000Z";
  const key = episodeKey(series, season, episode);
  repositories.acquisitions.wanted.create({
    id: wantedId,
    seriesTitle: series,
    season,
    episode,
    episodeTitle: title,
    status: "placing",
    statusDetail: null,
    createdAt: at,
    updatedAt: at,
  });
  const placing = {
    id: jobId,
    wantedId,
    episodeKey: key,
    provider: "real-debrid" as const,
    // Each episode is a distinct provider file; the ledger refuses one remote
    // file backing two episodes, so the fixture must not reuse them.
    remoteItemId: `item-${suffix}`,
    remoteFileId: `file-${suffix}`,
    originalFilename: "a.mkv",
    expectedBytes: 14,
    receivedBytes: 14,
    state: "placing" as const,
    attempt: 1,
    maxAttempts: 3,
    retryAfterMs: null,
    cancelRequested: false,
    partPath: `/inbox/${jobId}.part`,
    destinationPath,
    verifiedSha256: "a".repeat(64),
    lastError: null,
    createdAt: at,
    updatedAt: at,
  };
  repositories.acquisitions.jobs.save(placing);
  const media = {
    id: mediaId,
    source: "local-folder" as const,
    path: destinationPath,
    kind: "episode" as const,
    title,
    showTitle: series,
    season,
    episode,
    durationMs: 1_320_000,
    durationStatus: "ok" as const,
    available: true,
    tags: [],
  };
  const completed = {
    id: `import-${suffix}`,
    wantedId,
    episodeKey: key,
    provider: placing.provider,
    remoteItemId: placing.remoteItemId,
    remoteFileId: placing.remoteFileId,
    mediaId,
    canonicalName,
    destinationPath,
    importedAt: at,
  };
  repositories.completeAcquisitionImport({
    media,
    completedImport: completed,
    importedJob: { ...placing, state: "imported" },
  });
  return { media, completed, placing };
}

const episodeSlots = (channel: Channel) =>
  channel.slots.filter((slot) => slot.kind === "episode");
const seriesPools = (repositories: Repositories) =>
  repositories.pools
    .list()
    .filter((pool) => pool.name === SERIES && pool.kinds.includes("episode"));

test("enrolls the first imported episode into one chronological series pool", async () => {
  const repositories = await setup();
  const { media } = importEpisode(repositories, { episode: 1 });
  const outcomes = reconcileImportedSeries(repositories);

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0].mediaId).toBe(media.id);
  const pool = repositories.pools.get(outcomes[0].poolId);
  expect(pool).toEqual({
    id: outcomes[0].poolId,
    name: SERIES,
    kinds: ["episode"],
    mediaIds: [media.id],
    mode: "chronological",
    noRepeatMinutes: 720,
    weight: 1,
  });
  expect(seriesPools(repositories)).toHaveLength(1);
});

test("references the series pool from every episode slot and nothing else", async () => {
  const repositories = await setup();
  importEpisode(repositories, { episode: 1 });
  const [outcome] = reconcileImportedSeries(repositories);
  const channel = repositories.channels.get(ENROLLMENT_CHANNEL_ID)!;

  expect(episodeSlots(channel)).toHaveLength(5);
  for (const slot of episodeSlots(channel)) {
    expect(slot.poolIds).toContain(outcome.poolId);
    // Appended, never reordered: the configured pools stay first and intact.
    expect(slot.poolIds.slice(0, 2)).toEqual(["apartment-4b", "space-neighbors"]);
  }
  for (const slot of channel.slots.filter((slot) => slot.kind !== "episode"))
    expect(slot.poolIds).not.toContain(outcome.poolId);
  expect(channel.breakPolicy.poolIds).not.toContain(outcome.poolId);
  expect(channel.breakPolicy.stationIdPoolIds).not.toContain(outcome.poolId);
});

test("adds every verified episode of the season to the same pool", async () => {
  const repositories = await setup();
  const mediaIds = [1, 2, 3, 4, 5, 6].map(
    (episode) => importEpisode(repositories, { episode }).media.id,
  );
  reconcileImportedSeries(repositories);

  const pools = seriesPools(repositories);
  expect(pools).toHaveLength(1);
  expect(pools[0].mediaIds).toEqual(mediaIds);
  for (const slot of episodeSlots(repositories.channels.get(ENROLLMENT_CHANNEL_ID)!))
    expect(slot.poolIds.filter((id) => id === pools[0].id)).toHaveLength(1);
});

test("replaying completion and re-reconciling create no duplicates", async () => {
  const repositories = await setup();
  const { media, completed, placing } = importEpisode(repositories, { episode: 1 });

  // An exact ledger replay is idempotent and must not enroll a second time.
  repositories.completeAcquisitionImport({
    media,
    completedImport: completed,
    importedJob: { ...placing, state: "imported" },
  });
  reconcileImportedSeries(repositories);
  reconcileImportedSeries(repositories);
  reconcileImportedSeries(repositories);

  const pools = seriesPools(repositories);
  expect(pools).toHaveLength(1);
  expect(pools[0].mediaIds).toEqual([media.id]);
  const channel = repositories.channels.get(ENROLLMENT_CHANNEL_ID)!;
  expect(
    channel.slots.flatMap((slot) => slot.poolIds).filter((id) => id === pools[0].id),
  ).toHaveLength(5);
  expect(repositories.acquisitions.imports.list()).toHaveLength(1);
});

test("interleaved completions and reconciles keep one pool and lose no media id", async () => {
  const repositories = await setup();
  const first = importEpisode(repositories, { episode: 1 });
  reconcileImportedSeries(repositories);
  const second = importEpisode(repositories, { episode: 2 });
  reconcileImportedSeries(repositories);
  const third = importEpisode(repositories, { episode: 3 });
  reconcileImportedSeries(repositories);

  const pools = seriesPools(repositories);
  expect(pools).toHaveLength(1);
  expect(pools[0].mediaIds).toEqual([
    first.media.id,
    second.media.id,
    third.media.id,
  ]);
  expect(repositories.pools.list().filter((pool) => pool.name === SERIES)).toHaveLength(1);
});

test("reuses an existing compatible pool without overwriting its settings", async () => {
  const repositories = await setup();
  repositories.pools.put({
    id: "according-to-jim",
    name: SERIES,
    kinds: ["episode"],
    mediaIds: ["existing-media"],
    mode: "shuffle",
    noRepeatMinutes: 90,
    weight: 5,
  });
  const { media } = importEpisode(repositories, { episode: 1 });
  const outcomes = reconcileImportedSeries(repositories);

  expect(outcomes[0].poolId).toBe("according-to-jim");
  expect(outcomes[0].poolCreated).toBe(false);
  expect(repositories.pools.get("according-to-jim")).toEqual({
    id: "according-to-jim",
    name: SERIES,
    kinds: ["episode"],
    mediaIds: ["existing-media", media.id],
    mode: "shuffle",
    noRepeatMinutes: 90,
    weight: 5,
  });
});

test("uses a deterministic collision-safe pool id when the slug is taken", async () => {
  const repositories = await setup();
  repositories.pools.put({
    id: "according-to-jim",
    name: "An Unrelated Show",
    kinds: ["movie"],
    mediaIds: [],
    mode: "shuffle",
    noRepeatMinutes: 0,
    weight: 1,
  });
  importEpisode(repositories, { episode: 1 });

  const first = reconcileImportedSeries(repositories)[0];
  expect(first.poolId).not.toBe("according-to-jim");
  expect(first.poolId.startsWith("according-to-jim-")).toBe(true);

  // Deterministic: a later reconcile resolves to the same pool, never a second one.
  const second = reconcileImportedSeries(repositories)[0];
  expect(second.poolId).toBe(first.poolId);
  expect(seriesPools(repositories)).toHaveLength(1);
  expect(repositories.pools.get("according-to-jim")!.name).toBe("An Unrelated Show");
});

test("a missing target channel preserves the import and reports a diagnostic", async () => {
  const repositories = await setup({ seedChannel: false });
  const { media, completed } = importEpisode(repositories, { episode: 1 });
  const [outcome] = reconcileImportedSeries(repositories);

  expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "CHANNEL_MISSING",
  );
  expect(outcome.poolId).toBeTruthy();
  // The import survives intact and the pool still holds the media.
  expect(repositories.media.get(media.id)).toBeDefined();
  expect(repositories.acquisitions.imports.get(completed.id)).toBeDefined();
  expect(repositories.pools.get(outcome.poolId)!.mediaIds).toEqual([media.id]);
});

test("enrolls only media that an acquisition actually imported", async () => {
  const repositories = await setup();
  repositories.media.put({
    id: "scanned-only",
    source: "local-folder",
    path: "/managed/According to Jim - S01E09 - Scanned.mkv",
    kind: "episode",
    title: "Scanned",
    showTitle: SERIES,
    season: 1,
    episode: 9,
    durationMs: 1_320_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  });
  expect(reconcileImportedSeries(repositories)).toEqual([]);
  expect(seriesPools(repositories)).toEqual([]);
});

test("a generated schedule selects the imported series in season and episode order", async () => {
  const repositories = await setup();
  const mediaIds = [1, 2, 3, 4, 5, 6].map(
    (episode) => importEpisode(repositories, { episode }).media.id,
  );
  reconcileImportedSeries(repositories);

  const result = generateSchedule({
    channel: repositories.channels.get(ENROLLMENT_CHANNEL_ID)!,
    pools: repositories.pools.list(),
    items: repositories.media.list(),
    date: "2026-09-14",
    now: new Date("2026-09-13T13:00:00.000Z"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const picked = result.schedule.entries
    .map((entry) => entry.mediaId)
    .filter((id): id is string => Boolean(id) && mediaIds.includes(id!))
    .map((id) => mediaIds.indexOf(id) + 1);
  expect(picked.length).toBeGreaterThan(0);

  // Season/episode order means the first pass through the pool is episodes 1..6
  // in order. The schedule spans two days here -- the overnight daypart crosses
  // midnight -- so asserting global monotonicity would be wrong; what must hold
  // is that a later pass restarts at episode 1 rather than resuming mid-season.
  expect(picked.slice(0, mediaIds.length)).toEqual(
    mediaIds.map((_, index) => index + 1),
  );
  if (picked.length > mediaIds.length)
    expect(picked[mediaIds.length]).toBe(1);
});

test("leaves the previously generated schedule untouched until it is regenerated", async () => {
  const repositories = await setup();
  const generated = generateSchedule({
    channel: repositories.channels.get(ENROLLMENT_CHANNEL_ID)!,
    pools: repositories.pools.list(),
    items: repositories.media.list(),
    date: "2026-09-14",
    now: new Date("2026-09-13T13:00:00.000Z"),
  });
  expect(generated.ok).toBe(true);
  if (!generated.ok) return;
  repositories.schedules.replaceSuccessful(ENROLLMENT_CHANNEL_ID, generated.schedule);
  const stored = repositories.schedules.latest(ENROLLMENT_CHANNEL_ID)!;

  importEpisode(repositories, { episode: 1 });
  reconcileImportedSeries(repositories);

  expect(repositories.schedules.latest(ENROLLMENT_CHANNEL_ID)).toEqual(stored);
  expect(repositories.schedules.list(ENROLLMENT_CHANNEL_ID)).toHaveLength(1);
});

test("a completed Season 1 import reaches the schedule with its canonical local path", async () => {
  const repositories = await setup();
  const library = await mkdtemp(join(tmpdir(), "marktv-library-"));
  dirs.push(library);
  const generate = () =>
    generateSchedule({
      channel: repositories.channels.get(ENROLLMENT_CHANNEL_ID)!,
      pools: repositories.pools.list(),
      items: repositories.media.list(),
      date: "2026-09-14",
      now: new Date("2026-09-13T13:00:00.000Z"),
    });

  // A schedule generated before the import, stored the way ScheduleService does.
  const before = generate();
  expect(before.ok).toBe(true);
  if (!before.ok) return;
  repositories.schedules.replaceSuccessful(ENROLLMENT_CHANNEL_ID, before.schedule);
  const stored = repositories.schedules.latest(ENROLLMENT_CHANNEL_ID)!;

  // Complete three Season 1 imports whose media exists on disk at the canonical
  // library paths, exactly as the importer publishes them.
  const mediaIds: string[] = [];
  for (const episode of [1, 2, 3]) {
    const { media } = importEpisode(repositories, { episode, directory: library });
    await writeFile(media.path!, `fixture bytes for episode ${episode}`);
    mediaIds.push(media.id);
  }
  reconcileImportedSeries(repositories);

  // 1. every episode is in the media repository
  for (const mediaId of mediaIds)
    expect(repositories.media.get(mediaId)).toMatchObject({
      source: "local-folder",
      kind: "episode",
      available: true,
    });

  // 2. the pool and the channel references exist without any manual step
  const pools = seriesPools(repositories);
  expect(pools).toHaveLength(1);
  expect(pools[0].mediaIds).toEqual(mediaIds);
  for (const slot of episodeSlots(
    repositories.channels.get(ENROLLMENT_CHANNEL_ID)!,
  ))
    expect(slot.poolIds).toContain(pools[0].id);

  // 3. a newly generated schedule contains the series, with a real local path
  const after = generate();
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  const entry = after.schedule.entries.find(
    (candidate) => candidate.mediaId && mediaIds.includes(candidate.mediaId),
  );
  expect(entry).toBeDefined();
  // `entry.source` names the originating slot, not the media source, so the
  // canonical path is what identifies the media here.
  expect(entry!.path).toBe(repositories.media.get(entry!.mediaId!)!.path);
  expect(existsSync(entry!.path!)).toBe(true);
  expect(entry!.path!.startsWith(library)).toBe(true);

  // 4. the previously generated schedule is untouched
  expect(repositories.schedules.latest(ENROLLMENT_CHANNEL_ID)).toEqual(stored);
  expect(repositories.schedules.list(ENROLLMENT_CHANNEL_ID)).toHaveLength(1);
});

test("reuses a pool that already holds the series even when its name differs", async () => {
  const repositories = await setup();
  // The shape found in real data: the pool is named by hand, while the episode
  // showTitles come from filenames and carry a year or different casing.
  const first = importEpisode(repositories, {
    series: "Home Improvement (1991)",
    episode: 1,
  });
  repositories.pools.put({
    id: "home-improvement",
    name: "Home Improvement",
    kinds: ["episode"],
    mediaIds: [first.media.id],
    mode: "chronological",
    noRepeatMinutes: 720,
    weight: 1,
  });
  const second = importEpisode(repositories, {
    series: "Home Improvement (1991)",
    episode: 2,
  });
  reconcileImportedSeries(repositories);

  // Reused, not cloned: a name-only match would have created
  // "home-improvement-1991" holding the same episodes.
  expect(repositories.pools.list().map((pool) => pool.id)).not.toContain(
    "home-improvement-1991",
  );
  expect(repositories.pools.get("home-improvement")).toMatchObject({
    name: "Home Improvement",
    noRepeatMinutes: 720,
    mediaIds: [first.media.id, second.media.id],
  });
  expect(
    repositories.pools.list().filter((pool) => pool.kinds.includes("episode")),
  ).toHaveLength(3); // the demo's two plus this one
});
