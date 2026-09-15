import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { AcquisitionConflictError } from "../../src/acquisition/repository.js";
import { createRepositories } from "../../src/db/repositories.js";
import { episodeKey, type AcquisitionJob, type CompletedImport, type WantedEpisode } from "../../src/acquisition/models.js";
import type { MediaItem } from "../../src/domain/models.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "marktv-complete-")); dirs.push(dir);
  const database = openDatabase(dir); const repositories = createRepositories(database);
  const wanted: WantedEpisode = { id: "wanted", seriesTitle: "A Show", season: 1, episode: 2, episodeTitle: "Pilot", status: "placing", statusDetail: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
  const key = episodeKey(wanted.seriesTitle, wanted.season, wanted.episode);
  const destinationPath = "/library/A Show - S01E02 - Pilot.mkv";
  const pending: AcquisitionJob = { id: "job", wantedId: wanted.id, episodeKey: key, provider: "real-debrid", remoteItemId: "remote", remoteFileId: "file", originalFilename: "a.mkv", expectedBytes: 1, receivedBytes: 1, state: "placing", attempt: 0, maxAttempts: 3, retryAfterMs: null, cancelRequested: false, partPath: "/inbox/job.part", destinationPath, verifiedSha256: "a".repeat(64), lastError: null, createdAt: wanted.createdAt, updatedAt: wanted.updatedAt };
  repositories.acquisitions.wanted.create(wanted); repositories.acquisitions.jobs.save(pending);
  const media: MediaItem = { id: "media", source: "local-folder", path: destinationPath, kind: "episode", title: "Pilot", showTitle: "A Show", season: 1, episode: 2, durationMs: 1_000, durationStatus: "ok", available: true, tags: [] };
  const completed: CompletedImport = { id: "import", wantedId: wanted.id, episodeKey: key, provider: pending.provider, remoteItemId: pending.remoteItemId, remoteFileId: pending.remoteFileId, mediaId: media.id, canonicalName: "A Show - S01E02 - Pilot.mkv", destinationPath, importedAt: "2026-09-14T00:01:00.000Z" };
  const imported = { ...pending, state: "imported" as const, updatedAt: completed.importedAt };
  return { database, repositories, wanted, pending, media, completed, imported };
}
test("completes media, ledger, job, review cleanup, and Wanted cleanup in one transaction", async () => {
  const { repositories, wanted, media, completed, imported } = await setup();
  repositories.acquisitions.reviews.save({ id: "review", wantedId: wanted.id, kind: "ambiguous", message: "review", candidates: [], packEpisodeCount: null, packTotalBytes: null, packSeriesTitle: null, packSeason: null, createdAt: wanted.createdAt, updatedAt: wanted.updatedAt });
  expect(repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported })).toEqual(completed);
  expect(repositories.media.get(media.id)).toEqual(media);
  expect(repositories.acquisitions.imports.get(completed.id)).toEqual(completed);
  expect(repositories.acquisitions.jobs.get(imported.id)).toEqual(imported);
  expect(repositories.acquisitions.wanted.get(wanted.id)).toBeUndefined();
  expect(repositories.acquisitions.reviews.listByWanted(wanted.id)).toEqual([]);
  repositories.close();
});
test("is idempotent for exact replay and rejects conflicting ledger or media", async () => {
  const { repositories, media, completed, imported } = await setup();
  repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported });
  expect(repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported })).toEqual(completed);
  expect(() => repositories.completeAcquisitionImport({ media: { ...media, title: "Other" }, completedImport: completed, importedJob: imported })).toThrow(AcquisitionConflictError);
  expect(() => repositories.completeAcquisitionImport({ media: { ...media, id: "media-2" }, completedImport: { ...completed, id: "other", mediaId: "media-2" }, importedJob: imported })).toThrow(AcquisitionConflictError);
  repositories.close();
});
test.each([
  { state: "cancelled", cancelRequested: false }, { state: "needs-review", cancelRequested: false },
  { state: "downloading", cancelRequested: false }, { state: "imported", cancelRequested: false },
  { state: "placing", cancelRequested: true },
])("rejects non-continuous first completion jobs %#", async (change) => {
  const { repositories, pending, media, completed, imported } = await setup();
  repositories.acquisitions.jobs.save({ ...pending, state: change.state as AcquisitionJob["state"], cancelRequested: change.cancelRequested });
  expect(() => repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported })).toThrow();
  expect(repositories.media.list()).toEqual([]);
  expect(repositories.acquisitions.imports.list()).toEqual([]);
  repositories.close();
});
test.each([
  (input: Awaited<ReturnType<typeof setup>>) => ({ importedJob: { ...input.imported, destinationPath: "/library/changed.mkv" } }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ importedJob: { ...input.imported, partPath: "/inbox/changed.part" } }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ importedJob: { ...input.imported, expectedBytes: 2 } }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ importedJob: { ...input.imported, verifiedSha256: "b".repeat(64) } }),
])("rejects altered placing continuity %#", async (alter) => {
  const input = await setup(); const update = alter(input);
  expect(() => input.repositories.completeAcquisitionImport({ media: input.media, completedImport: input.completed, importedJob: update.importedJob })).toThrow();
  expect(input.repositories.acquisitions.imports.list()).toEqual([]); input.repositories.close();
});
test("permits missing Wanted only for semantic imported-ledger replay without rewriting timestamps", async () => {
  const { repositories, media, completed, imported } = await setup();
  repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported });
  const before = repositories.acquisitions.jobs.get(imported.id)!;
  expect(repositories.completeAcquisitionImport({ media, completedImport: { ...completed, id: "new-id", importedAt: "2026-09-15T00:00:00.000Z" }, importedJob: { ...imported, updatedAt: "2026-09-15T00:00:00.000Z" } })).toEqual(completed);
  expect(repositories.acquisitions.jobs.get(imported.id)).toEqual(before);
  repositories.close();
});
test.each([
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.pending, partPath: null }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.imported, partPath: null }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.imported, cancelRequested: true }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.imported, receivedBytes: 2 }),
])("rejects required partial/cancel/progress continuity %#", async (alter) => {
  const input = await setup(); const changed = alter(input);
  const current = changed.state === "placing" ? changed : input.pending;
  if (current.state === "placing") input.repositories.acquisitions.jobs.save(current);
  const importedJob = changed.state === "imported" ? changed : input.imported;
  expect(() => input.repositories.completeAcquisitionImport({ media: input.media, completedImport: input.completed, importedJob })).toThrow();
  input.repositories.close();
});
test.each(["cancelled", "needs-review"] as const)("rejects Wanted state %s before first completion", async (status) => {
  const input = await setup(); input.repositories.acquisitions.wanted.setStatus(input.wanted.id, status, { now: input.wanted.updatedAt });
  expect(() => input.repositories.completeAcquisitionImport({ media: input.media, completedImport: input.completed, importedJob: input.imported })).toThrow();
  input.repositories.close();
});
test("rejects missing Wanted and missing job for first completion or replay", async () => {
  const first = await setup(); first.database.prepare("DELETE FROM wanted_episodes WHERE id = ?").run(first.wanted.id);
  expect(() => first.repositories.completeAcquisitionImport({ media: first.media, completedImport: first.completed, importedJob: first.imported })).toThrow(); first.repositories.close();
  const replay = await setup(); replay.repositories.completeAcquisitionImport({ media: replay.media, completedImport: replay.completed, importedJob: replay.imported });
  replay.database.prepare("DELETE FROM acquisition_jobs WHERE id = ?").run(replay.imported.id);
  expect(() => replay.repositories.completeAcquisitionImport({ media: replay.media, completedImport: replay.completed, importedJob: replay.imported })).toThrow(); replay.repositories.close();
});
test("rejects a missing current job before first completion", async () => {
  const input = await setup(); input.database.prepare("DELETE FROM acquisition_jobs WHERE id = ?").run(input.pending.id);
  expect(() => input.repositories.completeAcquisitionImport({ media: input.media, completedImport: input.completed, importedJob: input.imported })).toThrow();
  expect(input.repositories.media.list()).toEqual([]); expect(input.repositories.acquisitions.imports.list()).toEqual([]);
  expect(input.repositories.acquisitions.wanted.get(input.wanted.id)).toEqual(input.wanted); input.repositories.close();
});
test("rejects split episode and remote completion lookup rows without mutation", async () => {
  const input = await setup();
  const insert = input.database.prepare(`INSERT INTO completed_imports (id, wanted_id, episode_key, provider, remote_item_id, remote_file_id, imported_at, json)
    VALUES (@id, @wantedId, @episodeKey, @provider, @remoteItemId, @remoteFileId, @importedAt, @json)`);
  const episodeRow = { ...input.completed, id: "episode-row", remoteItemId: "other-item", remoteFileId: "other-file" };
  const remoteRow = { ...input.completed, id: "remote-row", episodeKey: "other show|s1|e1", wantedId: "other-wanted", mediaId: "other-media", canonicalName: "other.mkv", destinationPath: "/library/other.mkv" };
  for (const row of [episodeRow, remoteRow]) insert.run({ id: row.id, wantedId: row.wantedId, episodeKey: row.episodeKey, provider: row.provider, remoteItemId: row.remoteItemId, remoteFileId: row.remoteFileId, importedAt: row.importedAt, json: JSON.stringify(row) });
  expect(() => input.repositories.completeAcquisitionImport({ media: input.media, completedImport: input.completed, importedJob: input.imported })).toThrow(AcquisitionConflictError);
  expect(input.repositories.media.list()).toEqual([]); expect(input.repositories.acquisitions.jobs.get(input.pending.id)?.state).toBe("placing");
  expect(input.repositories.acquisitions.wanted.get(input.wanted.id)).toEqual(input.wanted); input.repositories.close();
});
test.each([
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.pending, destinationPath: "/library/current-different.mkv" }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.pending, partPath: "/inbox/current-different.part" }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.pending, verifiedSha256: "b".repeat(64) }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.pending, receivedBytes: 2 }),
])("rejects a mutated current placing job continuity field %#", async (alter) => {
  const input = await setup(); input.repositories.acquisitions.jobs.save(alter(input));
  expect(() => input.repositories.completeAcquisitionImport({ media: input.media, completedImport: input.completed, importedJob: input.imported })).toThrow();
  expect(input.repositories.media.list()).toEqual([]); expect(input.repositories.acquisitions.imports.list()).toEqual([]);
  expect(input.repositories.acquisitions.wanted.get(input.wanted.id)).toEqual(input.wanted); input.repositories.close();
});
test.each([
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.media, showTitle: "Other" }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.media, season: 2 }),
  (input: Awaited<ReturnType<typeof setup>>) => ({ ...input.media, episode: 3 }),
])("rejects each wrong media episode identity component %#", async (alter) => {
  const input = await setup(); expect(() => input.repositories.completeAcquisitionImport({ media: alter(input), completedImport: input.completed, importedJob: input.imported })).toThrow(); input.repositories.close();
});
test("rejects canonical basename mismatch and accepts an identical preexisting media record", async () => {
  const bad = await setup(); expect(() => bad.repositories.completeAcquisitionImport({ media: bad.media, completedImport: { ...bad.completed, canonicalName: "other.mkv" }, importedJob: bad.imported })).toThrow(); bad.repositories.close();
  const exact = await setup(); exact.repositories.media.put(exact.media);
  expect(exact.repositories.completeAcquisitionImport({ media: exact.media, completedImport: exact.completed, importedJob: exact.imported })).toEqual(exact.completed); exact.repositories.close();
});
test("rejects preexisting media ID and destination path collisions", async () => {
  const byId = await setup(); byId.repositories.media.put({ ...byId.media, title: "Different" });
  expect(() => byId.repositories.completeAcquisitionImport({ media: byId.media, completedImport: byId.completed, importedJob: byId.imported })).toThrow(AcquisitionConflictError);
  expect(byId.repositories.acquisitions.imports.list()).toEqual([]); expect(byId.repositories.acquisitions.jobs.get(byId.pending.id)?.state).toBe("placing"); expect(byId.repositories.acquisitions.wanted.get(byId.wanted.id)).toEqual(byId.wanted); byId.repositories.close();
  const byPath = await setup(); byPath.repositories.media.put({ ...byPath.media, id: "other" });
  expect(() => byPath.repositories.completeAcquisitionImport({ media: byPath.media, completedImport: byPath.completed, importedJob: byPath.imported })).toThrow(AcquisitionConflictError);
  expect(byPath.repositories.acquisitions.imports.list()).toEqual([]); expect(byPath.repositories.acquisitions.jobs.get(byPath.pending.id)?.state).toBe("placing"); expect(byPath.repositories.acquisitions.wanted.get(byPath.wanted.id)).toEqual(byPath.wanted); byPath.repositories.close();
});
test("a trigger abort rolls back media, ledger, job, review, and Wanted mutations", async () => {
  const { database, repositories, wanted, media, completed, imported } = await setup();
  repositories.acquisitions.reviews.save({ id: "review", wantedId: wanted.id, kind: "ambiguous", message: "review", candidates: [], packEpisodeCount: null, packTotalBytes: null, packSeriesTitle: null, packSeason: null, createdAt: wanted.createdAt, updatedAt: wanted.updatedAt });
  database.exec("CREATE TRIGGER abort_wanted BEFORE DELETE ON wanted_episodes BEGIN SELECT RAISE(ABORT, 'rollback test'); END;");
  expect(() => repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported })).toThrow(/rollback test/);
  expect(repositories.media.list()).toEqual([]);
  expect(repositories.acquisitions.imports.list()).toEqual([]);
  expect(repositories.acquisitions.jobs.get(imported.id)?.state).toBe("placing");
  expect(repositories.acquisitions.wanted.get(wanted.id)).toEqual(wanted);
  expect(repositories.acquisitions.reviews.listByWanted(wanted.id)).toHaveLength(1);
  repositories.close();
});
test.each([
  "CREATE TRIGGER abort_media BEFORE INSERT ON documents WHEN NEW.type = 'media' BEGIN SELECT RAISE(ABORT, 'abort media'); END;",
  "CREATE TRIGGER abort_ledger BEFORE INSERT ON completed_imports BEGIN SELECT RAISE(ABORT, 'abort ledger'); END;",
  "CREATE TRIGGER abort_job BEFORE UPDATE ON acquisition_jobs BEGIN SELECT RAISE(ABORT, 'abort job'); END;",
  "CREATE TRIGGER abort_reviews BEFORE DELETE ON acquisition_reviews BEGIN SELECT RAISE(ABORT, 'abort reviews'); END;",
])("rolls back every prior durable write when a later sqlite write aborts", async (trigger) => {
  const { database, repositories, wanted, media, completed, imported } = await setup();
  repositories.acquisitions.reviews.save({ id: "review", wantedId: wanted.id, kind: "ambiguous", message: "review", candidates: [], packEpisodeCount: null, packTotalBytes: null, packSeriesTitle: null, packSeason: null, createdAt: wanted.createdAt, updatedAt: wanted.updatedAt });
  database.exec(trigger);
  expect(() => repositories.completeAcquisitionImport({ media, completedImport: completed, importedJob: imported })).toThrow(/abort/);
  expect(repositories.media.list()).toEqual([]);
  expect(repositories.acquisitions.imports.list()).toEqual([]);
  expect(repositories.acquisitions.jobs.get(imported.id)?.state).toBe("placing");
  expect(repositories.acquisitions.wanted.get(wanted.id)).toEqual(wanted);
  expect(repositories.acquisitions.reviews.listByWanted(wanted.id)).toHaveLength(1);
  repositories.close();
});
