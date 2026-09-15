import { link, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { importVerifiedEpisode, ImportNeedsReviewError, ImportVerificationError } from "../../src/acquisition/importer.js";
import type { AcquisitionJob, CompletedImport, WantedEpisode } from "../../src/acquisition/models.js";
import type { MediaItem } from "../../src/domain/models.js";
import { captureManagedDirectory, type ManagedDirectoryIdentity } from "../../src/acquisition/paths.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "marktv-import-")); dirs.push(dir);
  const library = join(dir, "library"); const inbox = join(dir, "inbox");
  await Promise.all([mkdir(library), mkdir(inbox)]);
  const partPath = join(inbox, "job.part"); await writeFile(partPath, "verified media");
  return {
    dir, library, inbox, partPath,
    inboxIdentity: await captureManagedDirectory(inbox),
    libraryIdentity: await captureManagedDirectory(library),
  };
}
const wanted: WantedEpisode = { id: "wanted", seriesTitle: "A Show", season: 3, episode: 4, episodeTitle: "The Pilot", status: "verifying", statusDetail: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
const job: AcquisitionJob = { id: "job", wantedId: "wanted", episodeKey: "a show|s3|e4", provider: "real-debrid", remoteItemId: "remote", remoteFileId: "file", originalFilename: "A.Show.S03E04.mkv", expectedBytes: null, receivedBytes: 14, state: "verifying", attempt: 0, maxAttempts: 3, retryAfterMs: null, cancelRequested: false, partPath: null, destinationPath: null, verifiedSha256: null, lastError: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
const canonical = "A Show - S03E04 - The Pilot.mkv";
function context(library: string, inbox: string, identities: { inboxIdentity: ManagedDirectoryIdentity; libraryIdentity: ManagedDirectoryIdentity }, overrides: Partial<Record<string, unknown>> = {}) {
  const scan = vi.fn(async (root: string) => ({ items: (await (await import("node:fs/promises")).readdir(root)).map((file) => ({ id: `media-${file}`, source: "local-folder" as const, path: join(root, file), kind: "episode" as const, title: "The Pilot", showTitle: "A Show", season: 3, episode: 4, durationMs: 1000, durationStatus: "ok" as const, available: true, tags: [] } satisfies MediaItem)) }));
  return { library, inbox, ...identities, now: () => new Date("2026-09-14T00:00:00.000Z"), completedImportFor: () => undefined, persistPlacing: vi.fn(), needsReview: vi.fn(), probe: async () => ({ durationMs: 1000, hasVideoStream: true }), scan, finalize: vi.fn(), ...overrides } as any;
}
test("verifies complete bound part, atomically publishes, finalizes, then removes only that part", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const ctx = context(library, inbox, fixture);
  const result = await importVerifiedEpisode(job, wanted, partPath, ctx);
  expect(result.destinationPath).toBe(join(library, canonical));
  expect(await readFile(result.destinationPath, "utf8")).toBe("verified media");
  await expect(lstat(partPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(ctx.persistPlacing).toHaveBeenCalledWith(expect.objectContaining({ state: "placing", partPath, destinationPath: result.destinationPath, verifiedSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  expect(ctx.finalize).toHaveBeenCalledWith(expect.objectContaining({ path: result.destinationPath }), expect.objectContaining({ provider: "real-debrid", remoteItemId: "remote", remoteFileId: "file" }), expect.objectContaining({ state: "imported" }));
});
test("aborts after placing is persisted without publishing, scanning, finalizing, or cleaning the part", async () => {
  const fixture = await setup();
  const controller = new AbortController();
  let placingPersisted!: () => void;
  let releasePlacing!: () => void;
  const persisted = new Promise<void>((resolve) => { placingPersisted = resolve; });
  const release = new Promise<void>((resolve) => { releasePlacing = resolve; });
  const ctx = context(fixture.library, fixture.inbox, fixture, {
    signal: controller.signal,
    persistPlacing: vi.fn(async () => { placingPersisted(); await release; }),
    scan: vi.fn(),
    finalize: vi.fn(),
  });
  const importing = importVerifiedEpisode(job, wanted, fixture.partPath, ctx);
  await persisted;
  controller.abort();
  releasePlacing();
  await expect(importing).rejects.toMatchObject({ name: "AbortError" });
  await expect(lstat(join(fixture.library, canonical))).rejects.toMatchObject({ code: "ENOENT" });
  expect(ctx.scan).not.toHaveBeenCalled();
  expect(ctx.finalize).not.toHaveBeenCalled();
  expect(await readFile(fixture.partPath, "utf8")).toBe("verified media");
});
test("rejects identity mismatch before a corrupt ledger can win", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const ctx = context(library, inbox, fixture, { completedImportFor: () => ({}) });
  await expect(importVerifiedEpisode({ ...job, wantedId: "other" }, wanted, partPath, ctx)).rejects.toBeInstanceOf(ImportVerificationError);
  expect(ctx.scan).not.toHaveBeenCalled();
});
test("rejects startup-identity replacement of inbox, library, or their root before mutation", async () => {
  for (const target of ["inbox", "library", "root"] as const) {
    const fixture = await setup();
    const ctx = context(fixture.library, fixture.inbox, fixture);
    if (target === "root") {
      const moved = `${fixture.dir}-moved`; await rename(fixture.dir, moved); dirs.push(moved);
      await mkdir(fixture.dir); await mkdir(fixture.inbox); await mkdir(fixture.library);
    } else {
      const path = target === "inbox" ? fixture.inbox : fixture.library;
      await rename(path, `${path}-moved`); await mkdir(path);
    }
    await expect(importVerifiedEpisode(job, wanted, fixture.partPath, ctx)).rejects.toThrow(/replaced|ENOENT/i);
    expect(ctx.persistPlacing).not.toHaveBeenCalled();
    expect(ctx.scan).not.toHaveBeenCalled();
    expect(ctx.finalize).not.toHaveBeenCalled();
  }
});
test("validates ledger identity, exact contained destination, and media id plus path", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const destinationPath = join(library, canonical); await writeFile(destinationPath, "verified media");
  const base: CompletedImport = { id: "done", wantedId: wanted.id, episodeKey: job.episodeKey, provider: job.provider, remoteItemId: job.remoteItemId, remoteFileId: job.remoteFileId, mediaId: `media-${canonical}`, canonicalName: canonical, destinationPath, importedAt: wanted.createdAt };
  const bad = context(library, inbox, fixture, { completedImportFor: () => ({ ...base, destinationPath: "/outside" }) });
  await expect(importVerifiedEpisode(job, wanted, partPath, bad)).rejects.toBeInstanceOf(ImportNeedsReviewError);
  const mismatch = context(library, inbox, fixture, { completedImportFor: () => base, scan: async () => ({ items: [{ id: base.mediaId, path: join(library, "other.mkv") }] }) });
  await expect(importVerifiedEpisode(job, wanted, partPath, mismatch)).rejects.toBeInstanceOf(ImportNeedsReviewError);
});
test("rejects outside, wrong, symlink, incomplete, and no-video partials", async () => {
  const fixture = await setup(); const { dir, library, inbox, partPath } = fixture; const outside = join(dir, "outside.part"); await writeFile(outside, "verified media");
  await expect(importVerifiedEpisode(job, wanted, outside, context(library, inbox, fixture))).rejects.toBeInstanceOf(ImportVerificationError);
  await writeFile(join(inbox, "other.part"), "verified media");
  await expect(importVerifiedEpisode({ ...job, partPath: join(inbox, "other.part") }, wanted, partPath, context(library, inbox, fixture))).rejects.toBeInstanceOf(ImportVerificationError);
  await rm(partPath); await symlink(outside, partPath);
  await expect(importVerifiedEpisode(job, wanted, partPath, context(library, inbox, fixture))).rejects.toBeInstanceOf(ImportVerificationError);
  await rm(partPath); await writeFile(partPath, "short");
  await expect(importVerifiedEpisode({ ...job, expectedBytes: 14 }, wanted, partPath, context(library, inbox, fixture))).rejects.toBeInstanceOf(ImportVerificationError);
  await expect(importVerifiedEpisode({ ...job, receivedBytes: 5 }, wanted, partPath, context(library, inbox, fixture, { probe: async () => ({ durationMs: 1, hasVideoStream: false }) }))).rejects.toBeInstanceOf(ImportVerificationError);
});
test("final-only recovery needs placing, exact destination, persisted hash, complete matching bytes, and video", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const destinationPath = join(library, canonical); await writeFile(destinationPath, "verified media"); await rm(partPath);
  const ctx = context(library, inbox, fixture); const wrongState = { ...job, state: "verifying" as const, destinationPath, verifiedSha256: "a".repeat(64) };
  await expect(importVerifiedEpisode(wrongState, wanted, partPath, ctx)).rejects.toBeInstanceOf(ImportNeedsReviewError);
  expect(ctx.needsReview).toHaveBeenCalled();
  const badHash = { ...job, state: "placing" as const, destinationPath, verifiedSha256: "a".repeat(64) };
  await expect(importVerifiedEpisode(badHash, wanted, partPath, context(library, inbox, fixture))).rejects.toBeInstanceOf(ImportNeedsReviewError);
});
test("EEXIST conflict, scan failure, and finalize failure retain recovery files", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const destinationPath = join(library, canonical); await writeFile(destinationPath, "different media");
  await expect(importVerifiedEpisode(job, wanted, partPath, context(library, inbox, fixture))).rejects.toBeInstanceOf(ImportNeedsReviewError);
  expect(await readFile(partPath, "utf8")).toBe("verified media");
  await rm(destinationPath);
  await expect(importVerifiedEpisode(job, wanted, partPath, context(library, inbox, fixture, { scan: async () => { throw new Error("scan failed"); } }))).rejects.toThrow("scan failed");
  expect(await readFile(partPath, "utf8")).toBe("verified media");
  await expect(importVerifiedEpisode(job, wanted, partPath, context(library, inbox, fixture, { finalize: () => { throw new Error("finalize failed"); } }))).rejects.toThrow("finalize failed");
  expect(await readFile(partPath, "utf8")).toBe("verified media");
});
test("accepts a same-inode EEXIST publication race and rejects missing part plus final", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const destinationPath = join(library, canonical);
  const ctx = context(library, inbox, fixture, { persistPlacing: async () => { await link(partPath, destinationPath); } });
  const result = await importVerifiedEpisode(job, wanted, partPath, ctx);
  expect(result.recovered).toBe(true);
  const second = await setup();
  await rm(second.partPath);
  await expect(importVerifiedEpisode(job, wanted, second.partPath, context(second.library, second.inbox, second))).rejects.toBeInstanceOf(ImportVerificationError);
});
test("validated ledger recovery removes only its exact managed partial", async () => {
  const fixture = await setup(); const { library, inbox, partPath } = fixture; const destinationPath = join(library, canonical); await writeFile(destinationPath, "verified media");
  const existing: CompletedImport = { id: "done", wantedId: wanted.id, episodeKey: job.episodeKey, provider: job.provider, remoteItemId: job.remoteItemId, remoteFileId: job.remoteFileId, mediaId: `media-${canonical}`, canonicalName: canonical, destinationPath, importedAt: wanted.createdAt };
  const result = await importVerifiedEpisode({ ...job, verifiedSha256: "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b" }, wanted, partPath, context(library, inbox, fixture, { completedImportFor: () => existing }));
  expect(result.recovered).toBe(true); await expect(lstat(partPath)).rejects.toMatchObject({ code: "ENOENT" });
});
