import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AcquisitionCoordinator, defaultPollIntervalMs } from "../../src/acquisition/coordinator.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { initializeManagedPaths } from "../../src/acquisition/paths.js";
import { DownloadError, downloadJob } from "../../src/acquisition/downloader.js";
import { ProviderError } from "../../src/integrations/acquisition/provider.js";
import type { AcquisitionProvider } from "../../src/integrations/acquisition/provider.js";
import type { AcquisitionJob, AcquisitionReview, CompletedImport } from "../../src/acquisition/models.js";
import type { RemoteItem } from "../../src/acquisition/providerTypes.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
const file = { provider: "real-debrid" as const, itemType: "torrent" as const, remoteItemId: "item", remoteFileId: "file", originalFilename: "A.Show.S01E02.720p.mkv", remotePath: "A.Show.S01E02.720p.mkv", bytes: 60_000_000 };
const item: RemoteItem = { provider: "real-debrid", itemType: "torrent", remoteItemId: "item", originalName: "A.Show.S01E02", completedAt: "2026-09-14T00:00:00.000Z", files: [file] };
function provider(name: "real-debrid" | "torbox", list: (signal?: AbortSignal) => Promise<readonly RemoteItem[]>): AcquisitionProvider {
  return { provider: name, testAuthentication: async () => ({ label: name }), listCompletedItems: (_token, signal) => list(signal), requestDownloadUrl: async () => "https://example.invalid/file" };
}
async function setup(list = async (signal?: AbortSignal): Promise<readonly RemoteItem[]> => { void signal; return [item]; }, failure: unknown = new DownloadError("PERMANENT_REJECTION", "no download", false), credentialGet: (name: "real-debrid" | "torbox") => Promise<string | null> = async (name) => name === "real-debrid" ? "token" : null, options: { download?: any; importEpisode?: any; scanLibrary?: any; probe?: any; hasFreeBytes?: any; randomId?: () => string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "marktv-coordinator-")); dirs.push(dir);
  const repositories = createRepositories(openDatabase(dir)); const paths = await initializeManagedPaths(dir);
  repositories.acquisitions.wanted.create({ id: "wanted", seriesTitle: "A Show", season: 1, episode: 2, episodeTitle: "Pilot", status: "wanted", statusDetail: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" });
  const rd = vi.fn(list); const torbox = vi.fn(async (): Promise<readonly RemoteItem[]> => []);
  const coordinator = new AcquisitionCoordinator({ repositories, paths, credentials: { get: credentialGet, set: async () => {}, remove: async () => {} }, providers: { "real-debrid": provider("real-debrid", rd), torbox: provider("torbox", torbox) }, download: options.download ?? (async () => { throw failure; }), ...(options.importEpisode ? { importEpisode: options.importEpisode } : {}), ...(options.scanLibrary ? { scanLibrary: options.scanLibrary } : {}), ...(options.probe ? { probe: options.probe } : {}), ...(options.hasFreeBytes ? { hasFreeBytes: options.hasFreeBytes } : {}), now: () => new Date("2026-09-14T00:00:00.000Z"), randomId: options.randomId ?? (() => "job") });
  return { repositories, coordinator, rd, torbox, paths };
}

function savedJob(overrides: Partial<AcquisitionJob> = {}): AcquisitionJob {
  return {
    id: "job", wantedId: "wanted", episodeKey: "a show|s1|e2", provider: "real-debrid",
    remoteItemId: "item", remoteFileId: "file", originalFilename: "A.Show.S01E02.720p.mkv",
    expectedBytes: 14, receivedBytes: 14, state: "needs-review", attempt: 1, maxAttempts: 3,
    retryAfterMs: null, cancelRequested: false, partPath: null, destinationPath: null,
    verifiedSha256: null, lastError: "retry", createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z", ...overrides,
  };
}

function completion(overrides: Partial<CompletedImport> = {}): CompletedImport {
  return {
    id: "import", wantedId: "wanted", episodeKey: "a show|s1|e2", provider: "real-debrid",
    remoteItemId: "item", remoteFileId: "file", mediaId: "media",
    canonicalName: "A Show - S01E02 - Pilot.mkv", destinationPath: "/managed/A Show - S01E02 - Pilot.mkv",
    importedAt: "2026-09-14T00:00:00.000Z", ...overrides,
  };
}

function seasonOffer(): AcquisitionReview {
  return {
    id: "season-offer", wantedId: "wanted", kind: "season-pack", message: "one episode",
    candidates: [{ provider: file.provider, itemType: file.itemType, remoteItemId: file.remoteItemId, remoteFileId: file.remoteFileId, filename: file.originalFilename, sizeBytes: file.bytes, resolution: "720p", season: 1, episode: 2 }],
    packEpisodeCount: 1, packTotalBytes: file.bytes, packSeriesTitle: "A Show", packSeason: 1,
    createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
  };
}
test("coalesces concurrent polls, isolates missing provider credentials, and reserves one exact match", async () => {
  const { repositories, coordinator, rd, torbox } = await setup();
  const [first, second] = await Promise.all([coordinator.pollOnce(), coordinator.pollOnce()]);
  expect(first).toEqual(second); expect(rd).toHaveBeenCalledTimes(1); expect(torbox).not.toHaveBeenCalled();
  expect(first.reservedJobIds).toEqual(["job"]); expect(first.providers).toContainEqual(expect.objectContaining({ provider: "torbox", state: "missing-credential" }));
  expect(repositories.acquisitions.jobs.get("job")).toMatchObject({ remoteItemId: "item", remoteFileId: "file", provider: "real-debrid" });
  expect(JSON.stringify(repositories.acquisitions.jobs.list())).not.toContain("https://");
  repositories.close();
});
test("provider failures are isolated and leave eligible Wanted waiting", async () => {
  const { repositories, coordinator } = await setup(async () => { throw new Error("offline"); });
  const outcome = await coordinator.pollOnce();
  expect(outcome.providers).toContainEqual(expect.objectContaining({ provider: "real-debrid", state: "error" }));
  expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "waiting-provider" });
  expect(repositories.acquisitions.jobs.list()).toEqual([]); repositories.close();
});
test.each([
  ["CANCELLED", false, "cancelled"], ["INSUFFICIENT_SPACE", true, "needs-review"],
  ["CAPABILITY_EXPIRED", false, "retry-wait"], ["TEMPORARY_SERVICE_FAILURE", false, "retry-wait"],
  ["UNSAFE_DOWNLOAD", true, "needs-review"], ["PERMANENT_REJECTION", true, "needs-review"],
] as const)("maps DownloadError %s to durable %s", async (code, retryable, state) => {
  const { repositories, coordinator } = await setup(undefined, new DownloadError(code, "provider token https://secret.invalid", retryable, 777));
  await coordinator.pollOnce();
  const job = repositories.acquisitions.jobs.get("job")!;
  expect(job.state).toBe(state); expect(job.lastError ?? "").not.toContain("secret");
  if (state === "retry-wait") expect(job.retryAfterMs).toBe(777);
  repositories.close();
});
test.each(["AUTHENTICATION", "RATE_LIMITED", "UNAVAILABLE", "UNSUPPORTED_SCHEMA", "PERMANENT"] as const)("contains poll ProviderError %s without leaking it", async (code) => {
  const { repositories, coordinator } = await setup(async () => { throw new ProviderError(code, "Bearer secret-token", code === "RATE_LIMITED" || code === "UNAVAILABLE", 500); });
  const result = await coordinator.pollOnce();
  expect(result.providers).toContainEqual(expect.objectContaining({ provider: "real-debrid", state: "error", errorCode: code }));
  expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "waiting-provider", statusDetail: null }); repositories.close();
});
test("converts a secret-bearing credential failure during download into safe retry state", async () => {
  let reads = 0;
  const { repositories, coordinator } = await setup(undefined, undefined, async (name) => { if (name !== "real-debrid") return null; if (reads++ === 0) return "token"; throw new Error("token=secret-value"); });
  await coordinator.pollOnce();
  const job = repositories.acquisitions.jobs.get("job")!;
  expect(job.state).toBe("retry-wait"); expect(job.lastError ?? "").not.toContain("secret"); repositories.close();
});
test("schedules bounded retry instead of Needs review when the transport rejects with a transient socket error", async () => {
  const { repositories, coordinator } = await setup(undefined, undefined, undefined, {
    download: (input: any, provider: AcquisitionProvider, token: string, hooks: any, signal: AbortSignal) =>
      downloadJob(input, provider, token, hooks, signal, {
        dnsLookup: async () => ["8.8.8.8"],
        transport: async () => { throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); },
      }),
  });
  await coordinator.pollOnce();
  const job = repositories.acquisitions.jobs.get("job")!;
  expect(job.state).toBe("retry-wait");
  expect(job.lastError).toBeNull();
  expect(job.retryAfterMs).toBeGreaterThan(0);
  expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "retry-wait", statusDetail: null });
  repositories.close();
});

test("persists downloading progress, verifying, placing, then one atomic imported completion", async () => {
  const seen: string[] = [];
  const { repositories, coordinator, paths } = await setup(undefined, undefined, undefined, {
    download: async (job: any, _provider: any, _token: any, hooks: any) => { seen.push("downloading"); await writeFile(join(paths.inbox, `${job.id}.part`), "verified media"); await hooks.onProgress(14, 14); return join(paths.inbox, `${job.id}.part`); },
    importEpisode: async (job: any, wanted: any, partPath: string, context: any) => {
      expect(repositories.acquisitions.jobs.get(job.id)?.state).toBe("verifying"); seen.push("verifying");
      const destinationPath = join(paths.library, "A Show - S01E02 - Pilot.mkv");
      const placing = { ...repositories.acquisitions.jobs.get(job.id)!, state: "placing", partPath, destinationPath, verifiedSha256: "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b", updatedAt: "2026-09-14T00:00:00.000Z" };
      await context.persistPlacing(placing); seen.push("placing");
      const media = { id: "media", source: "local-folder" as const, path: destinationPath, kind: "episode" as const, title: "Pilot", showTitle: "A Show", season: 1, episode: 2, durationMs: 1_000, durationStatus: "ok" as const, available: true, tags: [] };
      const completed = { id: "import", wantedId: wanted.id, episodeKey: job.episodeKey, provider: job.provider, remoteItemId: job.remoteItemId, remoteFileId: job.remoteFileId, mediaId: media.id, canonicalName: "A Show - S01E02 - Pilot.mkv", destinationPath, importedAt: "2026-09-14T00:00:00.000Z" };
      context.finalize(media, completed, { ...placing, state: "imported" }); seen.push("imported");
      return { media, completedImport: completed, destinationPath, recovered: false };
    },
  });
  await coordinator.pollOnce();
  expect(seen).toEqual(["downloading", "verifying", "placing", "imported"]);
  expect(repositories.acquisitions.jobs.get("job")?.state).toBe("imported"); expect(repositories.acquisitions.imports.list()).toHaveLength(1); expect(repositories.media.get("media")).toBeDefined(); expect(repositories.acquisitions.wanted.get("wanted")).toBeUndefined();
  repositories.close();
});
test("start uses the default unreferenced sixty-second timer and stop clears it", async () => {
  const { repositories } = await setup(); let callback: (() => void) | undefined; const timer = { unref: vi.fn() }; const timers = { setInterval: vi.fn((fn, ms) => { callback = fn; expect(ms).toBe(defaultPollIntervalMs); return timer; }), clearInterval: vi.fn() };
  const coordinator = new AcquisitionCoordinator({ repositories, paths: await initializeManagedPaths((dirs[dirs.length - 1])!), credentials: { get: async () => null, set: async () => {}, remove: async () => {} }, providers: { "real-debrid": provider("real-debrid", async () => []), torbox: provider("torbox", async () => []) }, timers });
  await coordinator.start(); expect(timer.unref).toHaveBeenCalled(); expect(callback).toBeDefined(); await coordinator.stop(); expect(timers.clearInterval).toHaveBeenCalled(); repositories.close();
});
test("stop detaches a delayed provider poll and prevents its later listing from mutating SQLite", async () => {
  let release!: () => void; const delayed = new Promise<readonly RemoteItem[]>((resolve) => { release = () => resolve([item]); });
  const { repositories, coordinator } = await setup(async () => delayed);
  const poll = coordinator.pollOnce();
  let stopped = false; const stopping = coordinator.stop().then(() => { stopped = true; });
  await stopping; expect(stopped).toBe(true);
  release(); await poll;
  expect(repositories.acquisitions.jobs.list()).toEqual([]);
  expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "wanted" }); repositories.close();
});

test("stop aborts a never-resolving provider listing and returns without a late mutation", async () => {
  let providerSignal: AbortSignal | undefined;
  const { repositories, coordinator } = await setup(async (signal) => {
    providerSignal = signal;
    return await new Promise<readonly RemoteItem[]>(() => undefined);
  });
  void coordinator.pollOnce();
  await vi.waitFor(() => expect(providerSignal).toBeDefined());
  await coordinator.stop();
  expect(providerSignal?.aborted).toBe(true);
  expect(repositories.acquisitions.jobs.list()).toEqual([]);
  expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "wanted" });
  repositories.close();
});

test("stop after provider listing but before queued poll application invalidates the queued mutation", async () => {
  let releaseQueue!: () => void;
  let queueEntered!: () => void;
  const entered = new Promise<void>((resolve) => { queueEntered = resolve; });
  const blocker = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const { repositories, coordinator, rd } = await setup();
  const blocked = (coordinator as any).enqueue(async () => { queueEntered(); await blocker; });
  await entered;
  const poll = coordinator.pollOnce();
  await vi.waitFor(() => expect(rd).toHaveBeenCalledTimes(1));
  const stopping = coordinator.stop();
  releaseQueue();
  await Promise.all([blocked, stopping, poll]);
  expect(repositories.acquisitions.jobs.list()).toEqual([]);
  expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "wanted" });
  repositories.close();
});

test("stop during the first job prevents the next runnable job from starting", async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const calls: string[] = [];
  const { repositories, coordinator } = await setup(async () => [], undefined, undefined, {
    download: async (input: any, _provider: any, _token: any, _hooks: any, signal: AbortSignal) => {
      calls.push(input.id);
      if (input.id !== "job-1") throw new Error("second job must not start");
      firstStarted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DownloadError("CANCELLED", "stopped", false)), { once: true }));
      throw new Error("unreachable");
    },
  });
  repositories.acquisitions.jobs.save(savedJob({ id: "job-1", state: "match-found", receivedBytes: 0, expectedBytes: null, remoteFileId: "file-1" }));
  repositories.acquisitions.jobs.save(savedJob({ id: "job-2", state: "match-found", receivedBytes: 0, expectedBytes: null, remoteFileId: "file-2", createdAt: "2026-09-14T00:00:01.000Z", updatedAt: "2026-09-14T00:00:01.000Z" }));
  const starting = coordinator.start();
  await started;
  await coordinator.stop();
  await starting;
  expect(calls).toEqual(["job-1"]);
  expect(repositories.acquisitions.jobs.get("job-2")?.state).toBe("match-found");
  repositories.close();
});

test("retry reconciles an exact completion ledger without another download", async () => {
  const download = vi.fn();
  const { repositories, coordinator } = await setup(async () => [], undefined, undefined, { download });
  repositories.acquisitions.jobs.save(savedJob());
  repositories.acquisitions.imports.record(completion());
  const outcome = await coordinator.retry("job");
  expect(outcome.kind).toBe("already-imported");
  expect(repositories.acquisitions.jobs.get("job")?.state).toBe("imported");
  expect(download).not.toHaveBeenCalled();
  repositories.close();
});

test("retry refuses an orphaned historical job and never downloads", async () => {
  const download = vi.fn();
  const { repositories, coordinator } = await setup(async () => [], undefined, undefined, { download });
  repositories.acquisitions.jobs.save(savedJob({ state: "cancelled", cancelRequested: true }));
  expect(repositories.acquisitions.wanted.remove("wanted").kind).toBe("removed");
  const outcome = await coordinator.retry("job");
  expect(outcome).toMatchObject({ kind: "unavailable", reason: "missing-wanted" });
  expect(repositories.acquisitions.jobs.get("job")?.state).toBe("cancelled");
  expect(download).not.toHaveBeenCalled();
  repositories.close();
});

test("retry reports an active download without starting a second transfer", async () => {
  let downloadStarted!: () => void;
  let releaseDownload!: () => void;
  const started = new Promise<void>((resolve) => { downloadStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseDownload = resolve; });
  const download = vi.fn(async (_input: any, _provider: any, _token: any, _hooks: any, signal: AbortSignal) => {
    downloadStarted();
    await release;
    signal.throwIfAborted();
    throw new DownloadError("PERMANENT_REJECTION", "test end", false);
  });
  const { repositories, coordinator } = await setup(undefined, undefined, undefined, { download });
  const polling = coordinator.pollOnce();
  await started;
  const outcome = await coordinator.retry("job");
  expect(outcome.kind).toBe("active");
  expect(download).toHaveBeenCalledTimes(1);
  releaseDownload();
  await polling;
  repositories.close();
});

test("retry reports an active import and cancel wins before scan or finalization", async () => {
  let placingPersisted!: () => void;
  let releaseImport!: () => void;
  const persisted = new Promise<void>((resolve) => { placingPersisted = resolve; });
  const release = new Promise<void>((resolve) => { releaseImport = resolve; });
  const scan = vi.fn();
  const finalize = vi.fn();
  const { repositories, coordinator, paths } = await setup(undefined, undefined, undefined, {
    download: async (input: any, _provider: any, _token: any, hooks: any) => {
      const part = join(paths.inbox, `${input.id}.part`);
      await writeFile(part, "verified media");
      await hooks.onProgress(14, 14);
      return part;
    },
    importEpisode: async (candidate: AcquisitionJob, _wanted: any, partPath: string, context: any) => {
      await context.persistPlacing({ ...candidate, state: "placing", partPath, destinationPath: join(paths.library, "A Show - S01E02 - Pilot.mkv"), verifiedSha256: "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b", updatedAt: candidate.updatedAt });
      placingPersisted();
      await release;
      context.signal?.throwIfAborted();
      await scan();
      await finalize();
      throw new Error("must not reach publication work");
    },
  });
  const polling = coordinator.pollOnce();
  await persisted;
  const retryPromise = coordinator.retry("job");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelling = coordinator.cancel("job");
  await vi.waitFor(() => expect(repositories.acquisitions.jobs.get("job")?.cancelRequested).toBe(true));
  releaseImport();
  const retry = await retryPromise;
  const cancelled = await cancelling;
  await polling;
  expect(retry.kind).toBe("active");
  expect(cancelled.kind).toBe("cancelled");
  expect(repositories.acquisitions.jobs.get("job")).toMatchObject({ state: "cancelled", cancelRequested: true });
  expect(repositories.acquisitions.imports.list()).toEqual([]);
  expect(scan).not.toHaveBeenCalled();
  expect(finalize).not.toHaveBeenCalled();
  repositories.close();
});

test("cancel after no-clobber publication completes the atomic import instead of orphaning the final file", async () => {
  let scanStarted!: () => void;
  let releaseScan!: () => void;
  const published = new Promise<void>((resolve) => { scanStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseScan = resolve; });
  const destinationName = "A Show - S01E02 - Pilot.mkv";
  const { repositories, coordinator, paths } = await setup(undefined, undefined, undefined, {
    download: async (input: any, _provider: any, _token: any, hooks: any) => {
      const part = join(paths.inbox, `${input.id}.part`);
      await writeFile(part, "verified media");
      await hooks.onProgress(14, 14);
      return part;
    },
    probe: async () => ({ durationMs: 1_000, hasVideoStream: true }),
    scanLibrary: async () => {
      scanStarted();
      await release;
      return { items: [{ id: "media", source: "local-folder", path: join(paths.library, destinationName), kind: "episode", title: "Pilot", showTitle: "A Show", season: 1, episode: 2, durationMs: 1_000, durationStatus: "ok", available: true, tags: [] }] } as any;
    },
  });

  const polling = coordinator.pollOnce();
  await published;
  expect(await readFile(join(paths.library, destinationName), "utf8")).toBe("verified media");

  const cancelling = coordinator.cancel("job");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(repositories.acquisitions.jobs.get("job")?.cancelRequested).toBe(false);
  releaseScan();

  const [cancelled] = await Promise.all([cancelling, polling]);
  expect(cancelled.kind).toBe("already-imported");
  expect(repositories.acquisitions.jobs.get("job")).toMatchObject({ state: "imported", cancelRequested: false });
  expect(repositories.acquisitions.imports.list()).toHaveLength(1);
  expect(repositories.media.get("media")).toBeDefined();
  expect(repositories.acquisitions.wanted.get("wanted")).toBeUndefined();
  expect(await readFile(join(paths.library, destinationName), "utf8")).toBe("verified media");
  repositories.close();
});

test("cancel after atomic import completion returns already-imported", async () => {
  let completed!: () => void;
  let releaseImport!: () => void;
  const finalized = new Promise<void>((resolve) => { completed = resolve; });
  const release = new Promise<void>((resolve) => { releaseImport = resolve; });
  const { repositories, coordinator, paths } = await setup(undefined, undefined, undefined, {
    download: async (input: any, _provider: any, _token: any, hooks: any) => {
      const part = join(paths.inbox, `${input.id}.part`); await writeFile(part, "verified media"); await hooks.onProgress(14, 14); return part;
    },
    importEpisode: async (candidate: AcquisitionJob, wanted: any, partPath: string, context: any) => {
      const destinationPath = join(paths.library, "A Show - S01E02 - Pilot.mkv");
      const placing = { ...candidate, state: "placing", partPath, destinationPath, verifiedSha256: "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b", updatedAt: candidate.updatedAt };
      await context.persistPlacing(placing);
      const media = { id: "media", source: "local-folder", path: destinationPath, kind: "episode", title: "Pilot", showTitle: "A Show", season: 1, episode: 2, durationMs: 1_000, durationStatus: "ok", available: true, tags: [] };
      await context.finalize(media, completion({ destinationPath }), { ...placing, state: "imported" });
      completed();
      await release;
      return { media, completedImport: completion({ destinationPath }), destinationPath, recovered: false };
    },
  });
  const polling = coordinator.pollOnce();
  await finalized;
  const outcome = await coordinator.cancel("job");
  expect(outcome.kind).toBe("already-imported");
  releaseImport();
  await polling;
  expect(repositories.acquisitions.jobs.get("job")?.state).toBe("imported");
  repositories.close();
});

test("importSeason contains a throwing credential store as a safe unavailable result without mutations", async () => {
  const secret = "raw-secret-token";
  const { repositories, coordinator, rd } = await setup(async () => [item], undefined, async (name) => {
    if (name === "real-debrid") throw new Error(`credential ${secret}`);
    return null;
  });
  repositories.acquisitions.reviews.save(seasonOffer());
  const before = JSON.stringify({ wanted: repositories.acquisitions.wanted.list(), jobs: repositories.acquisitions.jobs.list(), reviews: repositories.acquisitions.reviews.list(), imports: repositories.acquisitions.imports.list(), media: repositories.media.list() });
  const outcome = await coordinator.importSeason("season-offer");
  expect(outcome).toEqual({ kind: "provider-error", provider: "real-debrid", code: "UNAVAILABLE", retryable: true });
  expect(JSON.stringify(outcome)).not.toContain(secret);
  expect(rd).not.toHaveBeenCalled();
  expect(JSON.stringify({ wanted: repositories.acquisitions.wanted.list(), jobs: repositories.acquisitions.jobs.list(), reviews: repositories.acquisitions.reviews.list(), imports: repositories.acquisitions.imports.list(), media: repositories.media.list() })).toBe(before);
  repositories.close();
});

test("importSeason schedules an unchanged revalidated season offer and consumes it", async () => {
  const { repositories, coordinator } = await setup(async () => [item]);
  repositories.acquisitions.reviews.save(seasonOffer());
  const outcome = await coordinator.importSeason("season-offer");
  expect(outcome).toMatchObject({ kind: "scheduled", wantedIds: ["wanted"], jobIds: ["job"] });
  expect(repositories.acquisitions.reviews.get("season-offer")).toBeUndefined();
  expect(repositories.acquisitions.jobs.get("job")).toMatchObject({ remoteFileId: "file", originalFilename: file.originalFilename });
  repositories.close();
});

test("importSeason does not schedule when its durable offer is deleted while provider listing is blocked", async () => {
  let release!: (items: readonly RemoteItem[]) => void;
  const listing = new Promise<readonly RemoteItem[]>((resolve) => { release = resolve; });
  const { repositories, coordinator, rd } = await setup(async () => listing);
  repositories.acquisitions.reviews.save(seasonOffer());
  const importing = coordinator.importSeason("season-offer");
  await vi.waitFor(() => expect(rd).toHaveBeenCalledTimes(1));
  repositories.acquisitions.reviews.remove("season-offer");
  release([item]);
  await expect(importing).resolves.toEqual({ kind: "stale", provider: "real-debrid", reason: "changed-pack" });
  expect(repositories.acquisitions.jobs.list()).toEqual([]);
  repositories.close();
});

test("importSeason does not consume a newer replacement offer while provider listing is blocked", async () => {
  let release!: (items: readonly RemoteItem[]) => void;
  const listing = new Promise<readonly RemoteItem[]>((resolve) => { release = resolve; });
  const { repositories, coordinator, rd } = await setup(async () => listing);
  repositories.acquisitions.reviews.save(seasonOffer());
  const importing = coordinator.importSeason("season-offer");
  await vi.waitFor(() => expect(rd).toHaveBeenCalledTimes(1));
  const replacement = { ...seasonOffer(), candidates: [{ ...seasonOffer().candidates[0]!, filename: "A.Show.S01E02.1080p.mkv", resolution: "1080p" }], updatedAt: "2026-09-14T00:01:00.000Z" };
  repositories.acquisitions.reviews.save(replacement);
  release([item]);
  await expect(importing).resolves.toEqual({ kind: "stale", provider: "real-debrid", reason: "changed-pack" });
  expect(repositories.acquisitions.jobs.list()).toEqual([]);
  expect(repositories.acquisitions.reviews.get("season-offer")).toEqual(replacement);
  repositories.close();
});

test("importSeason rejects a re-listed equal-size lower-id replacement file not in the reviewed offer", async () => {
  const earlier = { ...file, remoteFileId: "000-earlier", remotePath: "A.Show.S01E02.720p.mkv" };
  const changedItem = { ...item, files: [file, earlier] };
  const { repositories, coordinator } = await setup(async () => [changedItem]);
  repositories.acquisitions.reviews.save(seasonOffer());
  await expect(coordinator.importSeason("season-offer")).resolves.toEqual({ kind: "stale", provider: "real-debrid", reason: "changed-pack" });
  expect(repositories.acquisitions.jobs.list()).toEqual([]);
  expect(repositories.acquisitions.reviews.get("season-offer")).toEqual(seasonOffer());
  repositories.close();
});

test("importSeason returns its durable scheduled result while a blocked download keeps running in the owned job loop", async () => {
  let downloadStarted!: () => void;
  let releaseDownload!: () => void;
  const started = new Promise<void>((resolve) => { downloadStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseDownload = resolve; });
  const { repositories, coordinator, paths } = await setup(async () => [item], undefined, undefined, {
    download: async (input: any, _provider: any, _token: any, hooks: any, signal: AbortSignal) => {
      downloadStarted();
      await release;
      signal.throwIfAborted();
      const part = join(paths.inbox, `${input.id}.part`);
      await writeFile(part, "verified media");
      await hooks.onProgress(14, 14);
      return part;
    },
    importEpisode: async (candidate: AcquisitionJob, _wanted: any, partPath: string, context: any) => {
      const destinationPath = join(paths.library, "A Show - S01E02 - Pilot.mkv");
      const placing = { ...candidate, state: "placing" as const, partPath, destinationPath, verifiedSha256: "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b", updatedAt: candidate.updatedAt };
      await context.persistPlacing(placing);
      const media = { id: "media", source: "local-folder" as const, path: destinationPath, kind: "episode" as const, title: "Pilot", showTitle: "A Show", season: 1, episode: 2, durationMs: 1_000, durationStatus: "ok" as const, available: true, tags: [] };
      const completed = { id: "import", wantedId: candidate.wantedId, episodeKey: candidate.episodeKey, provider: candidate.provider, remoteItemId: candidate.remoteItemId, remoteFileId: candidate.remoteFileId, mediaId: media.id, canonicalName: "A Show - S01E02 - Pilot.mkv", destinationPath, importedAt: "2026-09-14T00:00:00.000Z" };
      await context.finalize(media, completed, { ...placing, state: "imported" as const });
      return { media, completedImport: completed, destinationPath, recovered: false };
    },
  });
  repositories.acquisitions.reviews.save(seasonOffer());
  const importing = coordinator.importSeason("season-offer");
  let settled: { kind: string } | undefined;
  void importing.then((value) => { settled = value; });
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    // The durable scheduled result and the consumed offer must be visible while
    // the download is still blocked inside the owned background job loop.
    expect(settled, "importSeason must not await the blocked download").toEqual({
      kind: "scheduled", wantedIds: ["wanted"], jobIds: ["job"], alreadyImported: 0, alreadyScheduled: 0,
    });
    expect(repositories.acquisitions.reviews.get("season-offer")).toBeUndefined();
    expect(repositories.acquisitions.jobs.get("job")).toMatchObject({ state: "downloading", remoteFileId: "file", originalFilename: file.originalFilename });
    expect(repositories.acquisitions.wanted.get("wanted")).toMatchObject({ status: "downloading" });
  } finally {
    releaseDownload();
    await importing.catch(() => undefined);
  }
  await vi.waitFor(() => expect(repositories.acquisitions.jobs.get("job")?.state).toBe("imported"));
  expect(repositories.acquisitions.imports.list()).toHaveLength(1);
  expect(repositories.media.get("media")).toBeDefined();
  expect(repositories.acquisitions.wanted.get("wanted")).toBeUndefined();
  await coordinator.stop();
  repositories.close();
});

test("stop owns and interrupts a download started by the detached importSeason job loop", async () => {
  let providerSignal: AbortSignal | undefined;
  const { repositories, coordinator } = await setup(async () => [item], undefined, undefined, {
    download: async (_input: any, _provider: any, _token: any, _hooks: any, signal: AbortSignal) => {
      providerSignal = signal;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DownloadError("CANCELLED", "stopped", false)), { once: true });
      });
    },
  });
  repositories.acquisitions.reviews.save(seasonOffer());
  const importing = coordinator.importSeason("season-offer");
  await vi.waitFor(() => expect(providerSignal).toBeDefined());
  await coordinator.stop();
  expect(providerSignal?.aborted).toBe(true);
  await expect(importing).resolves.toMatchObject({ kind: "scheduled", wantedIds: ["wanted"], jobIds: ["job"] });
  expect(repositories.acquisitions.jobs.get("job")).toMatchObject({ state: "downloading", cancelRequested: false });
  expect(repositories.acquisitions.imports.list()).toEqual([]);
  repositories.close();
});

test("contains a failing background job loop instead of an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    const { repositories, coordinator } = await setup(async () => [item]);
    repositories.acquisitions.reviews.save(seasonOffer());
    const listing = vi.spyOn(repositories.acquisitions.jobs, "list").mockImplementation(() => { throw new Error("job listing failed"); });
    await expect(coordinator.importSeason("season-offer")).resolves.toMatchObject({
      kind: "scheduled", wantedIds: ["wanted"], jobIds: ["job"],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    listing.mockRestore();
    expect(rejections).toEqual([]);
    await coordinator.stop();
    repositories.close();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
