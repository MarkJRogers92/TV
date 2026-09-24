import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { createPreparationExecutor } from "../../src/preparation/executor.js";
import type { PreflightEvidence } from "../../src/preparation/preflight.js";

const SOURCE = { path: "/approved/media/episode.mp4", sizeBytes: "10", modifiedMs: "1720000000000", deviceId: "1", inode: "1" };

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(options: { seed?: boolean } = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/marktv-executor-`);
  const repositories = createRepositories(openDatabase(dataDir));
  cleanups.push(() => repositories.close());
  if (options.seed ?? true) {
    // Two observations >=60s apart settle into one queued preparation job.
    repositories.preparation.observe({ sourceMediaId: "media-1", source: SOURCE, observedAt: "2026-09-24T12:00:00.000Z" });
    repositories.preparation.observe({ sourceMediaId: "media-1", source: SOURCE, observedAt: "2026-09-24T12:01:00.000Z" });
  }
  return {
    repositories,
    executor: (collect: (path: string, options?: { level?: string }) => Promise<PreflightEvidence>) =>
      createPreparationExecutor(repositories, {
        collect: collect as never,
        readSource: () => SOURCE,
        now: () => new Date("2026-09-24T12:02:00.000Z"),
      }),
  };
}

function evidence(result: PreflightEvidence["result"], overrides: Partial<PreflightEvidence> = {}): PreflightEvidence {
  const failed = result === "decode_error";
  return {
    requestedLevel: "sampled",
    result,
    sourceBefore: SOURCE,
    sourceAfter: SOURCE,
    sourceUnchanged: true,
    metadata: {
      status: failed ? "failed" : "passed", durationSeconds: 60, tracks: [],
      selectedVideoTrackIndex: 0, selectedAudioTrackIndex: null,
      ...(result === "unavailable" ? { status: "unavailable", reason: "media_or_tool_unavailable" } : {}),
      ...(failed ? { reason: "probe_or_decode_failed" } : {}),
    },
    sampledDecode: { status: result === "sampled" ? "passed" : "deferred", testedRanges: [] },
    fullDecode: { status: "deferred", testedRanges: [] },
    ...overrides,
  } as PreflightEvidence;
}

test("records graded evidence and marks a playable source ready_original", async () => {
  const { repositories, executor } = await fixture();
  await executor(async () => evidence("sampled")).runOnce();

  const jobs = repositories.preparation.jobs.list();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ state: "completed", classification: "ready_original" });
  expect(jobs[0].sampleEvidence).toEqual({ status: "passed", testedRanges: [] });
  expect(jobs[0].metadataEvidence).toMatchObject({ status: "passed", durationSeconds: 60 });
});

test("quarantines a source that fails the requested decode", async () => {
  const { repositories, executor } = await fixture();
  await executor(async () => evidence("decode_error")).runOnce();

  expect(repositories.preparation.jobs.list()[0]).toMatchObject({
    state: "completed", classification: "quarantined", failureKind: "decode_corruption",
  });
});

test("records an unreadable source as unavailable, never as corruption", async () => {
  const { repositories, executor } = await fixture();
  await executor(async () => evidence("unavailable")).runOnce();

  expect(repositories.preparation.jobs.list()[0]).toMatchObject({
    state: "completed", classification: "unavailable", failureKind: "source_unavailable",
  });
});

test("leaves the job stale when the source changed during preflight", async () => {
  const { repositories, executor } = await fixture();
  const changed = { ...SOURCE, modifiedMs: "1720000000001" };
  await executor(async () => evidence("stale_source", { sourceAfter: changed, sourceUnchanged: false })).runOnce();

  expect(repositories.preparation.jobs.list()[0]).toMatchObject({ state: "stale" });
});

test("does nothing when no job is queued", async () => {
  const { executor } = await fixture({ seed: false });
  const collect = vi.fn();
  await executor(collect).runOnce();
  expect(collect).not.toHaveBeenCalled();
});

test("reports a collector fault as a processing failure without a media verdict", async () => {
  const { repositories, executor } = await fixture();
  const onError = vi.fn();
  const runner = createPreparationExecutor(repositories, {
    collect: (async () => { throw new Error("boom"); }) as never,
    readSource: () => SOURCE,
    onError,
  });
  await runner.runOnce();

  expect(repositories.preparation.jobs.list()[0]).toMatchObject({
    state: "failed", classification: null, failureKind: "processing_error",
  });
  expect(onError).toHaveBeenCalledTimes(1);
});
