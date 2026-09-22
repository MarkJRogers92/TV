import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import {
  createRepositories,
  type Repositories,
} from "../../src/db/repositories.js";
import { ScheduleService } from "../../src/server/scheduleService.js";
import { writePreservedLineup } from "../../src/scheduler/preservedLineup.js";
import type { ContinuityPreparer } from "../../src/continuity/prepare.js";
import type {
  Channel,
  MediaItem,
  Pool,
  PreservedLineupSource,
  ScheduleDiagnostic,
} from "../../src/domain/models.js";
import {
  archiveOf,
  coveringSpecs,
  dayStart,
  moviePattern,
  preservedZone,
  repeatSpecs,
  type PreservedEntrySpec,
} from "../support/preservedLineupFixture.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const now = () => new Date("2026-09-15T12:00:00.000Z");

function catalogFor(specs: PreservedEntrySpec[]): MediaItem[] {
  const seen = new Set<string>();
  const media: MediaItem[] = [];
  for (const spec of specs) {
    if (seen.has(spec.mediaId)) continue;
    seen.add(spec.mediaId);
    media.push({
      id: spec.mediaId,
      source: "local-folder",
      path:
        spec.kind === "movie"
          ? `/media/movies/${spec.mediaId}.mkv`
          : `/media/spots/${spec.mediaId}.mp4`,
      kind: spec.kind,
      title: `Imported ${spec.mediaId}`,
      durationMs: Math.round(spec.durationMs),
      durationStatus: "ok",
      available: true,
      tags: [],
    });
  }
  return media;
}

function preservedChannel(
  binding: Omit<PreservedLineupSource, "cycle"> & { cycle?: PreservedLineupSource["cycle"] },
  id = "channel-8-movies",
): Channel {
  return {
    id,
    name: "Channel 8 Movies",
    number: 8,
    timezone: preservedZone,
    enabled: true,
    revision: "preserved-1",
    dayparts: [],
    slots: [],
    preservedLineup: { cycle: "once", ...binding },
    breakPolicy: {
      boundaryMinutes: 30,
      poolIds: [],
      stationIdPoolIds: [],
      cooldownMinutes: 120,
    },
  };
}

async function openFixture(): Promise<{
  dataDir: string;
  repositories: Repositories;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-preserved-lineup-"));
  directories.push(dataDir);
  return { dataDir, repositories: createRepositories(openDatabase(dataDir)) };
}

function serviceWith(
  repositories: Repositories,
  dataDir: string,
  preparer?: ContinuityPreparer,
) {
  return new ScheduleService(
    repositories,
    dataDir,
    now,
    async () => join(dataDir, "export.json"),
    undefined,
    preparer ??
      (async (input) => ({
        media: input.media,
        prepared: [],
        diagnostics: [],
        rasterSupported: false,
      })),
    "/tmp/repo-root",
  );
}

const codes = (diagnostics: ScheduleDiagnostic[]) =>
  diagnostics.map((diagnostic) => diagnostic.code);

test("a bound channel airs the sliced archive and still gets the continuity pass", async () => {
  const { dataDir, repositories } = await openFixture();
  const specs = coveringSpecs(moviePattern, 3 * 86_400_000);
  for (const item of catalogFor(specs)) repositories.media.put(item);
  const archive = archiveOf(dayStart("2026-09-15"), specs);
  writePreservedLineup(repositories, archive);
  const channel = preservedChannel({
    sourceId: "channel-8-movies",
    digest: archive.digest,
    cycle: "once",
  });
  repositories.channels.put(channel);

  const prepared: string[] = [];
  const preparer: ContinuityPreparer = async (input) => {
    prepared.push(input.schedule.id);
    return {
      media: input.media,
      prepared: [],
      diagnostics: [{ code: "TEST_PREPARE", message: "offline preparation ran" }],
      rasterSupported: false,
    };
  };
  const service = serviceWith(repositories, dataDir, preparer);
  const generated = await service.generate(channel, "2026-09-15");
  expect(generated.ok).toBe(true);
  if (!generated.ok) return;
  const { schedule } = generated;

  // The day is the archive, in order, at the archive's own instants.
  expect(schedule.entries[0].start).toBe(
    new Date(dayStart("2026-09-15")).toISOString(),
  );
  expect(schedule.entries[0].mediaId).toBe("movie-a-1");
  expect(schedule.entries[1].mediaId).toBe("ad-a-1");
  expect(schedule.entries[1].durationMs).toBe(30_001);
  expect(schedule.entries[2].mediaId).toBe("movie-b-1");
  expect(schedule.entries.every((entry) => Boolean(entry.path))).toBe(true);
  expect(schedule.entries.every((entry) => !entry.sourceSlotId)).toBe(true);
  expect(schedule.entries.at(-1)!.end).toBe(
    new Date(dayStart("2026-09-16")).toISOString(),
  );
  expect(codes(schedule.diagnostics)).toContain("PRESERVED_LINEUP_APPLIED");
  // Continuity is the same second pass it is for every other channel, and it is
  // handed the preserved lineup rather than a regenerated one.
  expect(codes(schedule.diagnostics)).toContain("TEST_PREPARE");
  expect(prepared).toEqual([schedule.id]);
  expect(repositories.schedules.latestForDate(channel.id, "2026-09-15")?.id).toBe(
    schedule.id,
  );
});

test("the archive digest is part of the schedule identity", async () => {
  const { dataDir, repositories } = await openFixture();
  const specs = coveringSpecs(moviePattern, 3 * 86_400_000);
  for (const item of catalogFor(specs)) repositories.media.put(item);
  const base = dayStart("2026-09-15");
  const first = archiveOf(base, specs);
  writePreservedLineup(repositories, first);
  const channel = preservedChannel({ sourceId: "channel-8-movies" });
  repositories.channels.put(channel);
  const service = serviceWith(repositories, dataDir);

  const before = await service.generate(channel, "2026-09-15");
  expect(before.ok).toBe(true);
  if (!before.ok) return;

  // Re-import the same lineup with one film a minute shorter: a different
  // approved archive, so the same date must mint a new revision.
  const reimported = archiveOf(
    base,
    specs.map((spec, index) =>
      index === 0 ? { ...spec, durationMs: spec.durationMs - 60_000 } : spec,
    ),
  );
  expect(reimported.digest).not.toBe(first.digest);
  writePreservedLineup(repositories, reimported);
  const after = await service.generate(channel, "2026-09-15");
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.schedule.id).not.toBe(before.schedule.id);
  expect(after.schedule.entries[0].durationMs).toBe(
    before.schedule.entries[0].durationMs - 60_000,
  );
});

test("a missing archive refuses the day instead of falling back to selection", async () => {
  const { dataDir, repositories } = await openFixture();
  const specs = coveringSpecs(moviePattern, 2 * 86_400_000);
  for (const item of catalogFor(specs)) repositories.media.put(item);
  // Ordinary programming is fully available, which is exactly the state that
  // must NOT be used as a substitute.
  const pool: Pool = {
    id: "movies",
    name: "Movies",
    kinds: ["movie"],
    mediaIds: specs
      .filter((spec) => spec.kind === "movie")
      .map((spec) => spec.mediaId),
    mode: "shuffle",
    noRepeatMinutes: 0,
    weight: 1,
  };
  repositories.pools.put(pool);
  const channel = preservedChannel({ sourceId: "never-imported" });
  repositories.channels.put(channel);
  const service = serviceWith(repositories, dataDir);

  const generated = await service.generate(channel, "2026-09-15");
  expect(generated.ok).toBe(false);
  if (generated.ok) return;
  expect(generated.issues.map((entry) => entry.code)).toEqual([
    "PRESERVED_LINEUP_MISSING",
  ]);
  expect(repositories.schedules.latestForDate(channel.id, "2026-09-15")).toBe(
    undefined,
  );
  expect(await repositories.schedules.list(channel.id)).toEqual([]);
});

test("an exhausted archive fails closed unless the binding repeats it", async () => {
  const { dataDir, repositories } = await openFixture();
  // Twelve 119.5-minute features plus a 30s break are exactly one broadcast day.
  const specs = repeatSpecs(
    [
      { mediaId: "movie", kind: "movie", durationMs: 7_170_000 },
      { mediaId: "ad", kind: "commercial", durationMs: 30_000 },
    ],
    12,
  );
  for (const item of catalogFor(specs)) repositories.media.put(item);
  writePreservedLineup(repositories, archiveOf(dayStart("2026-09-15"), specs));
  const service = serviceWith(repositories, dataDir);

  const once = preservedChannel({ sourceId: "channel-8-movies" });
  repositories.channels.put(once);
  const refused = await service.generate(once, "2026-09-16");
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.issues.map((entry) => entry.code)).toEqual([
    "PRESERVED_LINEUP_EXHAUSTED",
  ]);
  expect(repositories.schedules.latestForDate(once.id, "2026-09-16")).toBe(
    undefined,
  );

  const repeat = preservedChannel(
    { sourceId: "channel-8-movies", cycle: "repeat" },
    "channel-8-loop",
  );
  repositories.channels.put(repeat);
  const looped = await service.generate(repeat, "2026-09-16");
  expect(looped.ok).toBe(true);
  if (!looped.ok) return;
  expect(looped.schedule.entries[0].start).toBe(
    new Date(dayStart("2026-09-16")).toISOString(),
  );
  expect(looped.schedule.entries[0].mediaId).toBe("movie-1");
});

test("a channel bound to a different archive than it holds is refused", async () => {
  const { dataDir, repositories } = await openFixture();
  const specs = coveringSpecs(moviePattern, 2 * 86_400_000);
  for (const item of catalogFor(specs)) repositories.media.put(item);
  writePreservedLineup(repositories, archiveOf(dayStart("2026-09-15"), specs));
  const channel = preservedChannel({
    sourceId: "channel-8-movies",
    digest: "f".repeat(64),
  });
  repositories.channels.put(channel);
  const service = serviceWith(repositories, dataDir);

  const generated = await service.generate(channel, "2026-09-15");
  expect(generated.ok).toBe(false);
  if (generated.ok) return;
  expect(generated.issues.map((entry) => entry.code)).toEqual([
    "PRESERVED_LINEUP_DIGEST_MISMATCH",
  ]);
});

test("channels without a binding generate exactly as they did before", async () => {
  const { dataDir, repositories } = await openFixture();
  const movies = Array.from({ length: 6 }, (_, index) => ({
    id: `ordinary-movie-${index + 1}`,
    kind: "movie" as const,
    durationMs: 90 * 60_000 + index * 60_000,
  }));
  for (const spec of movies) {
    repositories.media.put({
      id: spec.id,
      source: "local-folder",
      path: `/media/movies/${spec.id}.mkv`,
      kind: "movie",
      title: `Ordinary ${spec.id}`,
      durationMs: spec.durationMs,
      durationStatus: "ok",
      available: true,
      tags: [],
    });
  }
  repositories.pools.put({
    id: "movies",
    name: "Movies",
    kinds: ["movie"],
    mediaIds: movies.map((movie) => movie.id),
    mode: "shuffle",
    noRepeatMinutes: 0,
    weight: 1,
  });
  const channel: Channel = {
    id: "ordinary-movies",
    name: "Ordinary Movies",
    number: 9,
    timezone: preservedZone,
    enabled: true,
    revision: "ordinary-1",
    dayparts: [
      {
        id: "all-day",
        name: "All day",
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "00:00",
        end: "00:00",
        priority: 1,
      },
    ],
    slots: [
      {
        id: "movies-slot",
        daypartId: "all-day",
        days: [],
        poolIds: ["movies"],
        kind: "movie",
        fallbackPoolIds: [],
      },
    ],
    breakPolicy: {
      boundaryMinutes: 30,
      poolIds: [],
      stationIdPoolIds: [],
      cooldownMinutes: 120,
    },
  };
  repositories.channels.put(channel);
  const service = serviceWith(repositories, dataDir);

  const generated = await service.generate(channel, "2026-09-15");
  expect(generated.ok).toBe(true);
  if (!generated.ok) return;
  expect(generated.schedule.entries.some((entry) => entry.sourceSlotId === "movies-slot")).toBe(
    true,
  );
  expect(
    codes(generated.schedule.diagnostics).filter((code) =>
      code.startsWith("PRESERVED_LINEUP"),
    ),
  ).toEqual([]);
  expect(generated.schedule.entries.every((entry) => !entry.id.startsWith("preserved-"))).toBe(
    true,
  );
});
