import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  defaultPollIntervalMs,
  type CoordinatorTimers,
  type DownloadExecutor,
  type ImportExecutor,
} from "../../src/acquisition/coordinator.js";
import { DownloadError } from "../../src/acquisition/downloader.js";
import {
  acquisitionJobSchema,
  episodeKey,
  type AcquisitionJob,
} from "../../src/acquisition/models.js";
import type { ProviderName, RemoteItem } from "../../src/acquisition/providerTypes.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import type { AcquisitionProvider } from "../../src/integrations/acquisition/provider.js";
import type { CredentialStore } from "../../src/security/credentialStore.js";
import { buildApp } from "../../src/server/app.js";

const NOW = "2026-09-14T10:00:00.000Z";
const TOKEN = "rd-token-SENTINEL-2f2b";
const PART_BYTES = 60_000_000;
const VERIFIED_SHA256 =
  "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b";
const WANTED_URL = "/api/v1/acquisitions/wanted";
const POLL_URL = "/api/v1/acquisitions/poll";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marktv-acquisition-restart-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const credentials: CredentialStore = {
  get: async (provider: ProviderName) => (provider === "real-debrid" ? TOKEN : null),
  set: async () => undefined,
  remove: async () => undefined,
};

function provider(name: ProviderName, items: readonly RemoteItem[] = []): AcquisitionProvider {
  return {
    provider: name,
    testAuthentication: async () => ({ label: "mock-account" }),
    listCompletedItems: async () => items,
    requestDownloadUrl: async () => "https://example.invalid/file",
  };
}

/** One completed provider file for `A Show` S01E02 with a known byte count. */
function readyItem(): RemoteItem {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId: "item-1",
    originalName: "A Show S01E02 720p",
    completedAt: NOW,
    files: [
      {
        provider: "real-debrid",
        itemType: "torrent",
        remoteItemId: "item-1",
        remoteFileId: "file-1",
        originalFilename: "A.Show.S01E02.720p.mkv",
        remotePath: "A.Show.S01E02.720p.mkv",
        bytes: PART_BYTES,
      },
    ],
  };
}

type RestartRigOptions = {
  items?: readonly RemoteItem[];
  download?: DownloadExecutor;
  importEpisode?: ImportExecutor;
  timers?: CoordinatorTimers;
  now?: () => Date;
};

/** The real app with an in-memory store and injected transfer/import seams. */
async function buildRig(options: RestartRigOptions = {}) {
  const app = await buildApp({
    dataDir: directory,
    now: options.now ?? (() => new Date(NOW)),
    credentials,
    providers: {
      "real-debrid": provider("real-debrid", options.items ?? []),
      torbox: provider("torbox"),
    },
    coordinator: {
      download:
        options.download ??
        (async () => {
          throw new DownloadError("TEMPORARY_SERVICE_FAILURE", "no download", false);
        }),
      ...(options.importEpisode ? { importEpisode: options.importEpisode } : {}),
      hasFreeBytes: async () => true,
      ...(options.timers ? { timers: options.timers } : {}),
    },
  });
  return app;
}

/** A second connection to the same SQLite file, for durable row assertions. */
function observe() {
  return createRepositories(openDatabase(directory));
}

async function addWanted(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: "POST",
    url: WANTED_URL,
    payload: { seriesTitle: "A Show", season: 1, episode: 2, episodeTitle: "Pilot" },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

/** An import seam that publishes deterministically without ffprobe or disk IO. */
function completedImportRecorder(): {
  importEpisode: ImportExecutor;
  imported: string[];
} {
  const imported: string[] = [];
  const importEpisode: ImportExecutor = async (job, wanted, partPath, context) => {
    imported.push(job.id);
    const canonicalName = "A Show - S01E02 - Pilot.mkv";
    const destinationPath = join(context.library, canonicalName);
    const placing: AcquisitionJob = {
      ...job,
      state: "placing",
      partPath,
      destinationPath,
      verifiedSha256: VERIFIED_SHA256,
      updatedAt: job.updatedAt,
    };
    await context.persistPlacing(placing);
    const media = {
      id: "media-recovered",
      source: "local-folder" as const,
      path: destinationPath,
      kind: "episode" as const,
      title: "Pilot",
      showTitle: "A Show",
      season: 1,
      episode: 2,
      durationMs: 1_000,
      durationStatus: "ok" as const,
      available: true,
      tags: [],
    };
    const completedImport = {
      id: "import-recovered",
      wantedId: wanted.id,
      episodeKey: job.episodeKey,
      provider: job.provider,
      remoteItemId: job.remoteItemId,
      remoteFileId: job.remoteFileId,
      mediaId: media.id,
      canonicalName,
      destinationPath,
      importedAt: job.updatedAt,
    };
    await context.finalize(media, completedImport, { ...placing, state: "imported" });
    return { media, completedImport, destinationPath, recovered: true };
  };
  return { importEpisode, imported };
}

test("arms exactly one unreferenced sixty-second poll timer per app", async () => {
  const timer = { unref: vi.fn() };
  const setInterval = vi.fn<CoordinatorTimers["setInterval"]>(() => timer);
  const clearInterval = vi.fn();
  const timers: CoordinatorTimers = { setInterval, clearInterval };

  const first = await buildRig({ timers });
  expect(setInterval).toHaveBeenCalledTimes(1);
  expect(setInterval.mock.calls[0][1]).toBe(defaultPollIntervalMs);
  expect(defaultPollIntervalMs).toBe(60_000);
  expect(timer.unref).toHaveBeenCalledTimes(1);

  // Requests never arm or duplicate the timer.
  await first.inject({ method: "POST", url: POLL_URL });
  await first.inject(WANTED_URL);
  expect(setInterval).toHaveBeenCalledTimes(1);

  await first.close();
  expect(clearInterval).toHaveBeenCalledTimes(1);
  expect(clearInterval).toHaveBeenCalledWith(timer);

  // A restart against the same data dir registers the managed library once and
  // arms one timer for the new app instead of accumulating either.
  const second = await buildRig({ timers });
  try {
    expect(setInterval).toHaveBeenCalledTimes(2);
    const roots = (await second.inject("/api/v1/media/roots")).json();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      id: expect.any(String),
      path: await realpath(join(directory, "library")),
      lastScannedAt: null,
    });
  } finally {
    await second.close();
  }
  expect(clearInterval).toHaveBeenCalledTimes(2);
});

test("fails closed instead of returning a half-started app", async () => {
  const timers: CoordinatorTimers = {
    setInterval: () => {
      throw new Error("timer unavailable");
    },
    clearInterval: () => undefined,
  };
  await expect(buildRig({ timers })).rejects.toThrow("timer unavailable");

  // The failed start released the coordinator and database, so the same data
  // directory still starts normally afterwards.
  const app = await buildRig();
  try {
    expect((await app.inject("/api/v1/acquisitions/status")).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

test("recovers a downloaded partial after restart and imports exactly once", async () => {
  let downloadStarted!: () => void;
  const began = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  const first = await buildRig({
    items: [readyItem()],
    download: async (job, _provider, _token, hooks, signal) => {
      await writeFile(join(hooks.inbox, `${job.id}.part`), Buffer.alloc(PART_BYTES));
      if (!hooks.onProgress) throw new Error("expected a transfer progress hook");
      await hooks.onProgress(PART_BYTES, PART_BYTES);
      downloadStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    },
  });

  await addWanted(first);
  // The transfer starts inside the poll and never finishes; closing the app is
  // the crash: the coordinator aborts local work and preserves both the partial
  // and the resumable durable state.
  const polling = first.inject({ method: "POST", url: POLL_URL });
  await began;
  await first.close();
  expect((await polling).statusCode).toBe(200);

  const before = observe();
  const interrupted = before.acquisitions.jobs.list();
  expect(interrupted).toHaveLength(1);
  expect(interrupted[0]).toMatchObject({
    state: "downloading",
    cancelRequested: false,
    receivedBytes: PART_BYTES,
    expectedBytes: PART_BYTES,
  });
  const partPath = interrupted[0].partPath;
  expect(partPath).toEqual(join(await realpath(join(directory, "inbox")), `${interrupted[0].id}.part`));
  expect((await stat(partPath!)).size).toBe(PART_BYTES);
  before.close();

  // Restart: startup recovery turns the complete partial into one verified
  // import without a second download.
  const { importEpisode, imported } = completedImportRecorder();
  const second = await buildRig({ items: [readyItem()], importEpisode });
  try {
    expect(imported).toHaveLength(1);
    expect((await second.inject(WANTED_URL)).json()).toEqual([]);
    expect((await second.inject("/api/v1/acquisitions/status")).json()).toMatchObject({
      wanted: { total: 0 },
      jobs: { total: 1, byState: { imported: 1 } },
    });

    // Re-polling the same completed provider item cannot duplicate the import.
    const poll = await second.inject({ method: "POST", url: POLL_URL });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().reservedJobIds).toEqual([]);
    const after = observe();
    expect(after.acquisitions.jobs.list()).toHaveLength(1);
    expect(after.acquisitions.imports.list()).toHaveLength(1);
    expect(after.acquisitions.imports.get("import-recovered")).toMatchObject({
      episodeKey: episodeKey("A Show", 1, 2),
      mediaId: "media-recovered",
    });
    expect(after.media.get("media-recovered")).toMatchObject({
      kind: "episode",
      showTitle: "A Show",
      season: 1,
      episode: 2,
    });
    after.close();
  } finally {
    await second.close();
  }
});

test("awaits coordinator.stop before closing the repositories on shutdown", async () => {
  const timer = { unref: vi.fn() };
  const setInterval = vi.fn(() => timer);
  const clearInterval = vi.fn();
  // Distinct, strictly increasing timestamps make the post-abort durable write
  // observable, which is what proves stop() ran while the database was open.
  let ticks = 0;
  const now = () => new Date(Date.parse(NOW) + ticks++ * 1_000);

  let downloadStarted!: () => void;
  const began = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  const app = await buildRig({
    timers: { setInterval, clearInterval },
    now,
    download: async (job, _provider, _token, hooks, signal) => {
      await writeFile(join(hooks.inbox, `${job.id}.part`), Buffer.alloc(PART_BYTES));
      if (!hooks.onProgress) throw new Error("expected a transfer progress hook");
      await hooks.onProgress(PART_BYTES, PART_BYTES);
      downloadStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted by shutdown")),
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
  });

  const observer = observe();
  observer.acquisitions.wanted.create({
    id: "wanted-e2",
    seriesTitle: "A Show",
    season: 1,
    episode: 2,
    episodeTitle: "Pilot",
    status: "wanted",
    statusDetail: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  observer.acquisitions.jobs.save(
    acquisitionJobSchema.parse({
      id: "job-shutdown",
      wantedId: "wanted-e2",
      episodeKey: episodeKey("A Show", 1, 2),
      provider: "real-debrid",
      remoteItemId: "item-1",
      remoteFileId: "file-1",
      originalFilename: "A.Show.S01E02.720p.mkv",
      expectedBytes: PART_BYTES,
      state: "match-found",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );

  const pending = app.inject({
    method: "POST",
    url: "/api/v1/acquisitions/jobs/job-shutdown/retry",
  });
  await began;
  const duringTransfer = observer.acquisitions.jobs.get("job-shutdown")!;
  expect(duringTransfer).toMatchObject({
    state: "downloading",
    attempt: 1,
    receivedBytes: PART_BYTES,
  });

  await app.close();
  expect(clearInterval).toHaveBeenCalledWith(timer);

  const afterClose = observer.acquisitions.jobs.get("job-shutdown")!;
  expect(afterClose).toMatchObject({
    state: "downloading",
    cancelRequested: false,
    receivedBytes: PART_BYTES,
    retryAfterMs: null,
  });
  // stop() persisted the interrupted state (a fresh, later timestamp) before
  // repositories.close() ran; a closed database would have refused this write.
  expect(Date.parse(afterClose.updatedAt)).toBeGreaterThan(
    Date.parse(duringTransfer.updatedAt),
  );
  expect((await stat(afterClose.partPath!)).size).toBe(PART_BYTES);

  const response = await pending;
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "queued" });
  observer.close();
});
