import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import type { PreparationSourceVersion } from "../../src/preparation/models.js";

const directories: string[] = [];
const opened: Array<ReturnType<typeof createRepositories>> = [];

afterEach(async () => {
  opened.splice(0).forEach((repositories) => repositories.close());
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-preparation-"));
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  opened.push(repositories);
  return { dataDir, repositories };
}

const source = (overrides: Partial<PreparationSourceVersion> = {}): PreparationSourceVersion => ({
  path: "/media/movies/Feature.mkv",
  sizeBytes: "1000",
  modifiedMs: "1700000000000",
  deviceId: "8",
  inode: "42",
  ...overrides,
});

const time = (seconds: number) => new Date(Date.UTC(2026, 8, 24, 12, 0, seconds)).toISOString();

test("requires two matching observations at least 60 seconds apart before enqueueing", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;

  expect(prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) }).kind).toBe("observed");
  expect(prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(59) }).kind).toBe("observed");
  expect(prep.jobs.list()).toEqual([]);
  const settled = prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });

  expect(settled.kind).toBe("settled");
  expect(prep.jobs.list()).toHaveLength(1);
  expect(prep.claimNext(() => source())).toMatchObject({ sourceMediaId: "movie-1", state: "running", source: source() });
});

test("allows only one durable running preparation claim at a time", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  for (const [id, path] of [["movie-1", "/media/movies/One.mkv"], ["movie-2", "/media/movies/Two.mkv"]]) {
    const version = source({ path });
    prep.observe({ sourceMediaId: id, source: version, observedAt: time(0) });
    prep.observe({ sourceMediaId: id, source: version, observedAt: time(60) });
  }

  expect(prep.claimNext((path) => source({ path }))).toBeDefined();
  expect(prep.claimNext((path) => source({ path }))).toBeUndefined();
  expect(prep.jobs.list().filter((job) => job.state === "running")).toHaveLength(1);
});

test("ignores partial files and paths inside preparation output directories", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  const options = { outputDirectories: ["/media/prepared"] };

  expect(prep.observe({ sourceMediaId: "partial", source: source({ path: "/media/movies/.Feature.mkv.partial" }), observedAt: time(0) }, options).kind).toBe("ignored");
  expect(prep.observe({ sourceMediaId: "output", source: source({ path: "/media/prepared/sub/Feature.mkv" }), observedAt: time(0) }, options).kind).toBe("ignored");
  expect(prep.jobs.list()).toEqual([]);
});

test("persists evidence and the source version across restart, and treats repeat observation idempotently", async () => {
  const { dataDir, repositories } = await fixture();
  const prep = repositories.preparation;
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });
  const job = prep.claimNext(() => source())!;
  prep.recordEvidence(job.id, { metadataEvidence: { container: "matroska" } }, source());
  repositories.close();
  opened.pop();

  const restarted = createRepositories(openDatabase(dataDir));
  opened.push(restarted);
  expect(restarted.preparation.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(120) }).kind).toBe("settled");
  expect(restarted.preparation.jobs.list()).toHaveLength(1);
  expect(restarted.preparation.jobs.get(job.id)).toMatchObject({
    state: "running",
    sourceMediaId: "movie-1",
    metadataEvidence: { container: "matroska" },
  });
  expect(restarted.preparation.recoverInterrupted()).toBe(1);
  expect(restarted.preparation.jobs.get(job.id)?.state).toBe("queued");
});

test("stales a running result when source identity changes during processing", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });
  const job = prep.claimNext(() => source())!;

  const result = prep.complete(job.id, {
    classification: "ready_original",
    sampleEvidence: { decodedSeconds: 30 },
    fullDecodeEvidence: { succeeded: true },
    airingEvidence: { eligible: true },
  }, source({ sizeBytes: "1200", modifiedMs: "1700000001000" }));

  expect(result.kind).toBe("stale");
  expect(prep.jobs.get(job.id)).toMatchObject({ state: "stale", classification: null });
  expect(prep.jobs.get(job.id)?.fullDecodeEvidence).toBeNull();
});

test("keeps unavailable media distinct from quarantined corruption and retains source provenance", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });
  const unavailable = prep.claimNext(() => source())!;
  expect(prep.complete(unavailable.id, { classification: "unavailable", failureKind: "source_unavailable" }, source()).kind).toBe("completed");
  expect(prep.jobs.get(unavailable.id)).toMatchObject({ sourceMediaId: "movie-1", classification: "unavailable", failureKind: "source_unavailable" });

  prep.observe({ sourceMediaId: "movie-2", source: source({ path: "/media/movies/Broken.mkv" }), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-2", source: source({ path: "/media/movies/Broken.mkv" }), observedAt: time(60) });
  const corrupt = prep.claimNext(() => source({ path: "/media/movies/Broken.mkv" }))!;
  expect(prep.complete(corrupt.id, { classification: "quarantined", failureKind: "decode_corruption" }, source({ path: "/media/movies/Broken.mkv" })).kind).toBe("completed");
  expect(prep.jobs.get(corrupt.id)).toMatchObject({ sourceMediaId: "movie-2", classification: "quarantined", failureKind: "decode_corruption" });
});

test("new source version invalidates older queued work without changing logical source identity", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });
  expect(prep.jobs.list()[0]?.state).toBe("queued");

  prep.observe({ sourceMediaId: "movie-1", source: source({ sizeBytes: "2000" }), observedAt: time(120) });
  expect(prep.jobs.list()).toMatchObject([{ sourceMediaId: "movie-1", state: "stale" }]);
});

test("retries one failed source version without creating a duplicate job", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });
  const job = prep.claimNext(() => source())!;
  expect(prep.fail(job.id, "temporary worker error")).toBe(true);
  expect(prep.retry(job.id, source(), time(120))).toEqual({ kind: "queued" });
  expect(prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(180) }).job?.id).toBe(job.id);
  expect(prep.jobs.list()).toHaveLength(1);
  expect(prep.jobs.get(job.id)).toMatchObject({ state: "queued", attempt: 1, failureKind: null });
});

test("an absent source invalidates the claim as unavailable, never as corruption", async () => {
  const { repositories } = await fixture();
  const prep = repositories.preparation;
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(0) });
  prep.observe({ sourceMediaId: "movie-1", source: source(), observedAt: time(60) });

  expect(prep.claimNext(() => null)).toBeUndefined();
  expect(prep.jobs.list()[0]).toMatchObject({
    state: "stale",
    classification: "unavailable",
    failureKind: "source_unavailable",
  });
  expect(prep.jobs.list()[0]?.classification).not.toBe("quarantined");
  expect(prep.retry(prep.jobs.list()[0]!.id, source(), time(120))).toEqual({ kind: "queued" });
  expect(prep.jobs.list()[0]).toMatchObject({ state: "queued", classification: null, failureKind: null });
});
