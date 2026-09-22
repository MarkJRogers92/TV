import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultMaxAttempts,
  type CoordinatorTimers,
  type DownloadExecutor,
  type ImportExecutor,
} from "../../src/acquisition/coordinator.js";
import { DownloadError } from "../../src/acquisition/downloader.js";
import {
  acquisitionJobSchema,
  acquisitionReviewSchema,
  episodeKey,
  type AcquisitionJob,
  type AcquisitionReview,
  type AcquisitionReviewCandidate,
  type WantedEpisode,
} from "../../src/acquisition/models.js";
import type { ProviderName, RemoteItem } from "../../src/acquisition/providerTypes.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories, type AcquisitionImportCompletion } from "../../src/db/repositories.js";
import {
  ProviderError,
  type AcquisitionProvider,
  type ProviderErrorCode,
} from "../../src/integrations/acquisition/provider.js";
import type { CredentialStore } from "../../src/security/credentialStore.js";
import { buildApp } from "../../src/server/app.js";

const WANTED_URL = "/api/v1/acquisitions/wanted";
const SEASON_PACKS_URL = "/api/v1/acquisitions/season-packs";
const STATUS_URL = "/api/v1/acquisitions/status";
const POLL_URL = "/api/v1/acquisitions/poll";
const retryUrl = (id: string) => `/api/v1/acquisitions/jobs/${id}/retry`;
const cancelUrl = (id: string) => `/api/v1/acquisitions/jobs/${id}/cancel`;
const importSeasonUrl = (id: string) =>
  `/api/v1/acquisitions/reviews/${id}/import-season`;
const selectCandidateUrl = (id: string) =>
  `/api/v1/acquisitions/reviews/${id}/select-candidate`;
const dismissReviewUrl = (id: string) =>
  `/api/v1/acquisitions/reviews/${id}/dismiss`;

const NOW = "2026-09-14T10:00:00.000Z";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Sentinels that must never appear in any acquisition response. */
const TOKEN = "rd-token-SENTINEL-2f2b";
const RAW_PROVIDER_MESSAGE = "RAW-PROVIDER-SENTINEL-9f3c";
const SIGNED_URL = `https://signed.invalid/file?token=${TOKEN}`;
const PACK_BYTES = 60_000_000;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marktv-acquisition-routes-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

class MemoryCredentialStore implements CredentialStore {
  private readonly tokens = new Map<ProviderName, string>();

  constructor(initial: Partial<Record<ProviderName, string>> = {}) {
    for (const [provider, token] of Object.entries(initial)) {
      this.tokens.set(provider as ProviderName, token as string);
    }
  }

  async get(provider: ProviderName): Promise<string | null> {
    return this.tokens.get(provider) ?? null;
  }

  async set(provider: ProviderName, token: string): Promise<void> {
    this.tokens.set(provider, token);
  }

  async remove(provider: ProviderName): Promise<void> {
    this.tokens.delete(provider);
  }
}

type ProviderBehavior =
  | { kind: "ok"; items: readonly RemoteItem[] }
  | { kind: "provider-error"; code: ProviderErrorCode }
  | { kind: "generic-error" };

/** A provider double that never touches the network and never stores a URL. */
class MockProvider implements AcquisitionProvider {
  behavior: ProviderBehavior;

  constructor(
    readonly provider: ProviderName,
    behavior: ProviderBehavior = { kind: "ok", items: [] },
  ) {
    this.behavior = behavior;
  }

  async testAuthentication() {
    return { label: "mock-account" };
  }

  async listCompletedItems(): Promise<readonly RemoteItem[]> {
    if (this.behavior.kind === "provider-error") {
      throw new ProviderError(
        this.behavior.code,
        `${RAW_PROVIDER_MESSAGE} Bearer ${TOKEN} ${SIGNED_URL}`,
        this.behavior.code === "RATE_LIMITED",
        1_500,
      );
    }
    if (this.behavior.kind === "generic-error") {
      throw new Error(`${RAW_PROVIDER_MESSAGE} token=${TOKEN}`);
    }
    return this.behavior.items;
  }

  async requestDownloadUrl(): Promise<string> {
    throw new Error("no download URL is requested in these tests");
  }
}

type Rig = {
  app: FastifyInstance;
  directory: string;
  store: MemoryCredentialStore;
  realDebrid: MockProvider;
  torbox: MockProvider;
};

type RigOptions = {
  items?: readonly RemoteItem[];
  behavior?: ProviderBehavior;
  credentials?: Partial<Record<ProviderName, string>>;
  download?: DownloadExecutor;
  importEpisode?: ImportExecutor;
  hasFreeBytes?: (neededBytes: number) => Promise<boolean>;
  timers?: CoordinatorTimers;
};

/**
 * Builds the real app with an in-memory credential store, mock providers, and
 * injected transfer/import seams: no network, Keychain, or ffprobe.
 */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const store = new MemoryCredentialStore(
    options.credentials ?? { "real-debrid": TOKEN },
  );
  const realDebrid = new MockProvider(
    "real-debrid",
    options.behavior ?? { kind: "ok", items: options.items ?? [] },
  );
  const torbox = new MockProvider("torbox");
  const app = await buildApp({
    dataDir: directory,
    now: () => new Date(NOW),
    credentials: store,
    providers: { "real-debrid": realDebrid, torbox },
    coordinator: {
      download:
        options.download ??
        (async () => {
          throw new DownloadError("PERMANENT_REJECTION", "no download", false);
        }),
      ...(options.importEpisode ? { importEpisode: options.importEpisode } : {}),
      hasFreeBytes: options.hasFreeBytes ?? (async () => true),
      ...(options.timers ? { timers: options.timers } : {}),
    },
  });
  return { app, directory, store, realDebrid, torbox };
}

/** A second connection to the same SQLite file, for durable row assertions. */
function directDatabase() {
  return createRepositories(openDatabase(directory));
}

function wantedRecord(
  id: string,
  episode: number,
  status: WantedEpisode["status"] = "wanted",
  seriesTitle = "A Show",
): WantedEpisode {
  return {
    id,
    seriesTitle,
    season: 1,
    episode,
    episodeTitle: null,
    status,
    statusDetail: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function jobRecord(
  overrides: Partial<AcquisitionJob> & { id: string; wantedId: string },
): AcquisitionJob {
  const wanted = overrides.wantedId;
  const wantedEpisode = wanted === "wanted-e1" ? 1 : 2;
  return acquisitionJobSchema.parse({
    episodeKey: episodeKey("A Show", 1, wantedEpisode),
    provider: "real-debrid",
    remoteItemId: "item-1",
    remoteFileId: "file-1",
    originalFilename: "A.Show.S01E02.720p.mkv",
    state: "wanted",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function packCandidate(episode: number, remoteItemId = "pack-1"): AcquisitionReviewCandidate {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId,
    remoteFileId: `file-${episode}`,
    filename: `A.Show.S01E0${episode}.1080p.mkv`,
    sizeBytes: PACK_BYTES,
    resolution: "1080p",
    season: 1,
    episode,
  };
}

function packOffer(
  overrides: Partial<AcquisitionReview> & { id: string; wantedId: string },
): AcquisitionReview {
  return acquisitionReviewSchema.parse({
    kind: "season-pack",
    message: "Season pack with 3 recognized episodes",
    candidates: [1, 2, 3].map((episode) => packCandidate(episode)),
    packEpisodeCount: 3,
    packTotalBytes: 3 * PACK_BYTES,
    packSeriesTitle: "A Show",
    packSeason: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function episodeCandidate(remoteFileId = "candidate-a"): AcquisitionReviewCandidate {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId: "item-1",
    remoteFileId,
    filename: `A.Show.S01E02.720p.${remoteFileId}.mkv`,
    sizeBytes: PACK_BYTES,
    resolution: "720p",
    season: 1,
    episode: 2,
  };
}

function episodeReview(
  overrides: Partial<AcquisitionReview> & { id: string; wantedId: string },
): AcquisitionReview {
  return acquisitionReviewSchema.parse({
    kind: "ambiguous",
    message: "More than one equally good file matches this episode",
    candidates: [episodeCandidate("candidate-a"), episodeCandidate("candidate-b")],
    packEpisodeCount: null,
    packTotalBytes: null,
    packSeriesTitle: null,
    packSeason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function packItem(files: number[], remoteItemId = "pack-1"): RemoteItem {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId,
    originalName: "A Show S01 1080p",
    completedAt: NOW,
    files: files.map((episode) => ({
      provider: "real-debrid" as const,
      itemType: "torrent" as const,
      remoteItemId,
      remoteFileId: `file-${episode}`,
      originalFilename: `A.Show.S01E0${episode}.1080p.mkv`,
      remotePath: `A.Show.S01E0${episode}.1080p.mkv`,
      bytes: PACK_BYTES,
    })),
  };
}

/** Every key/value in a JSON response, for secret-leak assertions. */
function collectJson(value: unknown, keys: string[] = [], values: unknown[] = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectJson(entry, keys, values));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      keys.push(key);
      collectJson(entry, keys, values);
    });
  } else {
    values.push(value);
  }
  return { keys, values };
}

const FORBIDDEN_KEY_PATTERN =
  /token|secret|authorization|bearer|api-?key|credential|password|signature/i;
/** Locator/path keys a projection must never carry, in any spelling. */
const FORBIDDEN_LOCATOR_KEYS = [
  "partPath",
  "destinationPath",
  "remoteItemId",
  "remoteFileId",
  "originalFilename",
  "lastError",
  "mediaId",
  "canonicalName",
];

function expectNoLeaks(body: unknown) {
  const { keys, values } = collectJson(body);
  expect(keys.filter((key) => FORBIDDEN_KEY_PATTERN.test(key))).toEqual([]);
  for (const key of FORBIDDEN_LOCATOR_KEYS) {
    expect(keys).not.toContain(key);
  }
  const serialized = JSON.stringify(body);
  for (const secret of [TOKEN, RAW_PROVIDER_MESSAGE, SIGNED_URL]) {
    expect(serialized).not.toContain(secret);
  }
  for (const value of values) {
    if (typeof value !== "string") continue;
    expect(value).not.toContain(TOKEN);
    expect(value).not.toContain(RAW_PROVIDER_MESSAGE);
    expect(value).not.toMatch(/https?:\/\//i);
    expect(value).not.toContain(".part");
    expect(value).not.toContain(directory);
  }
}

function postWanted(app: FastifyInstance, payload: object) {
  return app.inject({ method: "POST", url: WANTED_URL, payload });
}

describe("local request boundary", () => {
  test.each([
    { headers: { host: "marktv.example.test" } },
    { headers: { host: "localhost.evil.test" } },
    { headers: { host: "127.0.0.1.evil.test" } },
    { headers: { host: "localhost", origin: "https://marktv.example.test" } },
    { headers: { host: "localhost", referer: "http://localhost.evil.test/page" } },
  ])("rejects hostile Host, Origin, and Referer without echoing input", async ({ headers }) => {
    const { app } = await rig();
    try {
      const response = await app.inject({ method: "GET", url: WANTED_URL, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "LOCAL_ONLY", message: "MarkTV accepts local browser requests only" });
      expect(response.body).not.toContain("evil");
      expect(response.body).not.toContain("marktv.example");
    } finally {
      await app.close();
    }
  });

  test("allows exact local Host with no Origin and a local Referer", async () => {
    const { app } = await rig();
    try {
      expect((await app.inject({ method: "GET", url: WANTED_URL, headers: { host: "127.0.0.1:3100" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: WANTED_URL, headers: { host: "[::1]:3100", referer: "http://[::1]:3100/wanted" } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("GET/POST /api/v1/acquisitions/wanted", () => {
  test("creates a Wanted episode with a server-generated id and wanted status", async () => {
    const { app } = await rig();
    try {
      expect((await app.inject(WANTED_URL)).json()).toEqual([]);

      const created = await postWanted(app, {
        seriesTitle: "Severance",
        season: 1,
        episode: 2,
        episodeTitle: "Half Loop",
      });
      expect(created.statusCode).toBe(201);
      const record = created.json();
      expect(record).toMatchObject({
        seriesTitle: "Severance",
        season: 1,
        episode: 2,
        episodeTitle: "Half Loop",
        status: "wanted",
        createdAt: NOW,
        updatedAt: NOW,
        job: null,
        review: null,
      });
      expect(record.id).toMatch(UUID_V4);
      expect(record.stremioUrl).toBe(
        "stremio:///search?search=Severance%20S01E02%20Half%20Loop",
      );

      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(record);
      expectNoLeaks(listed);
    } finally {
      await app.close();
    }
  });

  test("generates a distinct id per episode and defaults the episode title to null", async () => {
    const { app } = await rig();
    try {
      const first = (
        await postWanted(app, {
          seriesTitle: "Severance",
          season: 1,
          episode: 2,
        })
      ).json();
      const second = (
        await postWanted(app, {
          seriesTitle: "Severance",
          season: 1,
          episode: 3,
        })
      ).json();
      expect(first.id).toMatch(UUID_V4);
      expect(second.id).toMatch(UUID_V4);
      expect(first.id).not.toBe(second.id);
      expect(first.episodeTitle).toBeNull();
      expect(first.stremioUrl).toBe(
        "stremio:///search?search=Severance%20S01E02",
      );
    } finally {
      await app.close();
    }
  });

  test("refuses a Wanted episode already represented by the completion ledger", async () => {
    const { app } = await rig();
    const database = directDatabase();
    database.acquisitions.imports.record({
      id: "imported-episode",
      wantedId: "historical-wanted",
      episodeKey: episodeKey("A Show", 1, 2),
      provider: "real-debrid",
      remoteItemId: "item-imported",
      remoteFileId: "file-imported",
      mediaId: "media-imported",
      canonicalName: "A Show - S01E02 - Pilot.mkv",
      destinationPath: join(directory, "library", "A Show - S01E02 - Pilot.mkv"),
      importedAt: NOW,
    });
    database.close();
    try {
      const response = await postWanted(app, {
        seriesTitle: "  a   show  ",
        season: 1,
        episode: 2,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: "ALREADY_IMPORTED", message: "This episode was already imported" });
      expect((await app.inject(WANTED_URL)).json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("rejects malformed and client-controlled records without persisting", async () => {
    const { app } = await rig();
    try {
      const invalid = [
        {},
        { seriesTitle: "   ", season: 1, episode: 1 },
        { seriesTitle: "Severance", season: -1, episode: 1 },
        { seriesTitle: "Severance", season: 1, episode: 1.5 },
        { seriesTitle: "Severance", season: 1, episode: 1, status: "imported" },
        { seriesTitle: "Severance", season: 1, episode: 1, id: randomUUID() },
        {
          seriesTitle: "Severance",
          season: 1,
          episode: 1,
          token: "super-secret-token",
        },
      ];
      for (const payload of invalid) {
        const response = await postWanted(app, payload);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
        expect(response.body).not.toContain("super-secret-token");
      }
      expect((await app.inject(WANTED_URL)).json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("returns 409 for a duplicate episode identity, including normalized spellings", async () => {
    const { app } = await rig();
    try {
      const original = (
        await postWanted(app, {
          seriesTitle: "Star Trek: Strange New Worlds",
          season: 1,
          episode: 2,
        })
      ).json();

      const exact = await postWanted(app, {
        seriesTitle: "Star Trek: Strange New Worlds",
        season: 1,
        episode: 2,
      });
      expect(exact.statusCode).toBe(409);
      expect(exact.json()).toMatchObject({ code: "ALREADY_WANTED" });

      const normalized = await postWanted(app, {
        seriesTitle: "star trek strange new worlds",
        season: 1,
        episode: 2,
      });
      expect(normalized.statusCode).toBe(409);
      expect(normalized.json()).toMatchObject({ code: "ALREADY_WANTED" });

      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(original.id);
      expect(listed[0].seriesTitle).toBe("Star Trek: Strange New Worlds");
    } finally {
      await app.close();
    }
  });

  test("projects the latest job progress and the episode-scoped review", async () => {
    const exactFile = (remoteFileId: string) => ({
      provider: "real-debrid" as const,
      itemType: "torrent" as const,
      remoteItemId: "item-1",
      remoteFileId,
      originalFilename: `A.Show.S01E02.1080p.${remoteFileId}.mkv`,
      remotePath: `A.Show.S01E02.1080p.${remoteFileId}.mkv`,
      bytes: PACK_BYTES,
    });
    // Two equally good files for one episode are ambiguous, not automatic.
    const { app } = await rig({
      items: [
        {
          provider: "real-debrid",
          itemType: "torrent",
          remoteItemId: "item-1",
          originalName: "A Show S01E02 1080p",
          completedAt: NOW,
          files: [exactFile("a"), exactFile("b")],
        },
      ],
    });
    try {
      await postWanted(app, { seriesTitle: "A Show", season: 1, episode: 2 });
      const poll = await app.inject({ method: "POST", url: POLL_URL });
      expect(poll.statusCode).toBe(200);
      const reviewId = poll.json().reviewId as string;
      expect(reviewId).toEqual(expect.any(String));
      expect(poll.json().reservedJobIds).toEqual([]);

      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        status: "needs-review",
        job: null,
        review: {
          id: reviewId,
          kind: "ambiguous",
          message: "More than one equally good file matches this episode",
          candidateCount: 2,
        },
      });
      expect(listed[0].statusDetail).toBe(
        "More than one equally good file matches this episode",
      );
      expectNoLeaks(listed);
    } finally {
      await app.close();
    }
  });

  test("projects only safe metadata for selectable episode candidates", async () => {
    const { app } = await rig();
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2, "needs-review"));
    database.acquisitions.reviews.save(episodeReview({ id: "review-candidates", wantedId: "wanted-e2" }));
    database.close();
    try {
      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed[0].review).toMatchObject({
        id: "review-candidates",
        candidates: [
          { candidateIndex: 0, provider: "real-debrid", filename: "A.Show.S01E02.720p.candidate-a.mkv", sizeBytes: PACK_BYTES, resolution: "720p" },
          { candidateIndex: 1, provider: "real-debrid", filename: "A.Show.S01E02.720p.candidate-b.mkv", sizeBytes: PACK_BYTES, resolution: "720p" },
        ],
      });
      expect(JSON.stringify(listed[0].review)).not.toMatch(/remote(Item|File)Id|path|token|url/i);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/acquisitions/reviews/:id/select-candidate", () => {
  test("validates a strict fresh selection and reserves exactly the chosen matching file", async () => {
    const selected = episodeCandidate("candidate-b");
    const { app } = await rig({
      items: [{
        provider: "real-debrid",
        itemType: "torrent",
        remoteItemId: selected.remoteItemId,
        originalName: "A Show S01E02 720p",
        completedAt: NOW,
        files: [{
          provider: selected.provider,
          itemType: selected.itemType,
          remoteItemId: selected.remoteItemId,
          remoteFileId: selected.remoteFileId,
          originalFilename: selected.filename,
          remotePath: "safe-provider-display-name",
          bytes: selected.sizeBytes,
        }],
      }],
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2, "needs-review"));
    database.acquisitions.reviews.save(episodeReview({ id: "review-select", wantedId: "wanted-e2" }));
    database.close();
    try {
      const response = await app.inject({
        method: "POST",
        url: selectCandidateUrl("review-select"),
        payload: { candidateIndex: 1, reviewUpdatedAt: NOW },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "scheduled" });
      const after = directDatabase();
      expect(after.acquisitions.reviews.get("review-select")).toBeUndefined();
      expect(after.acquisitions.wanted.get("wanted-e2")).toMatchObject({ status: "match-found" });
      expect(after.acquisitions.jobs.listByWanted("wanted-e2")).toMatchObject([
        { provider: "real-debrid", remoteItemId: "item-1", remoteFileId: "candidate-b", originalFilename: selected.filename, state: "match-found" },
      ]);
      after.close();
    } finally {
      await app.close();
    }
  });

  test("rejects stale timestamps, invalid selection indexes, and missing provider files without consuming the review", async () => {
    const { app } = await rig();
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2, "needs-review"));
    database.acquisitions.reviews.save(episodeReview({ id: "review-stale", wantedId: "wanted-e2", updatedAt: "2026-09-14T10:01:00.000Z" }));
    database.close();
    try {
      const stale = await app.inject({ method: "POST", url: selectCandidateUrl("review-stale"), payload: { candidateIndex: 0, reviewUpdatedAt: NOW } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "STALE_REVIEW" });
      const invalid = await app.inject({ method: "POST", url: selectCandidateUrl("review-stale"), payload: { candidateIndex: -1, reviewUpdatedAt: "2026-09-14T10:01:00.000Z" } });
      expect(invalid.statusCode).toBe(422);
      const missing = await app.inject({ method: "POST", url: selectCandidateUrl("review-stale"), payload: { candidateIndex: 0, reviewUpdatedAt: "2026-09-14T10:01:00.000Z" } });
      expect(missing.statusCode).toBe(409);
      expect(missing.json()).toMatchObject({ code: "STALE_CANDIDATE" });
      expect(directDatabase().acquisitions.reviews.get("review-stale")).toBeDefined();
    } finally {
      await app.close();
    }
  });

  test("keeps a review when credentials are absent, a candidate changes, or an active job conflicts", async () => {
    const selected = episodeCandidate("candidate-a");
    const { app, store, realDebrid } = await rig({ credentials: {} });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2, "needs-review"));
    database.acquisitions.reviews.save(episodeReview({ id: "review-guarded", wantedId: "wanted-e2" }));
    database.close();
    try {
      const noCredential = await app.inject({ method: "POST", url: selectCandidateUrl("review-guarded"), payload: { candidateIndex: 0, reviewUpdatedAt: NOW } });
      expect(noCredential.statusCode).toBe(409);
      expect(noCredential.json()).toMatchObject({ code: "NO_CREDENTIAL", provider: "real-debrid" });
      await store.set("real-debrid", TOKEN);
      realDebrid.behavior = {
        kind: "ok",
        items: [{
          provider: "real-debrid", itemType: "torrent", remoteItemId: "item-1", originalName: "A Show S01E02 720p", completedAt: NOW,
          files: [{ provider: "real-debrid", itemType: "torrent", remoteItemId: "item-1", remoteFileId: selected.remoteFileId, originalFilename: "A.Show.S01E02.1080p.changed.mkv", remotePath: "display", bytes: PACK_BYTES }],
        }],
      };
      const changed = await app.inject({ method: "POST", url: selectCandidateUrl("review-guarded"), payload: { candidateIndex: 0, reviewUpdatedAt: NOW } });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: "STALE_CANDIDATE" });
      const afterChanged = directDatabase();
      afterChanged.acquisitions.jobs.save(jobRecord({ id: "job-active", wantedId: "wanted-e2", state: "downloading", remoteFileId: "other-file" }));
      afterChanged.close();
      realDebrid.behavior = {
        kind: "ok",
        items: [{
          provider: "real-debrid", itemType: "torrent", remoteItemId: "item-1", originalName: "A Show S01E02 720p", completedAt: NOW,
          files: [{ provider: selected.provider, itemType: selected.itemType, remoteItemId: selected.remoteItemId, remoteFileId: selected.remoteFileId, originalFilename: selected.filename, remotePath: "display", bytes: selected.sizeBytes }],
        }],
      };
      const conflict = await app.inject({ method: "POST", url: selectCandidateUrl("review-guarded"), payload: { candidateIndex: 0, reviewUpdatedAt: NOW } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "SELECTION_CONFLICT" });
      const final = directDatabase();
      expect(final.acquisitions.reviews.get("review-guarded")).toBeDefined();
      final.close();
    } finally {
      await app.close();
    }
  });

  test("does not reserve when the Wanted title changes during provider revalidation", async () => {
    const selected = episodeCandidate("candidate-a");
    const { app, realDebrid } = await rig({
      items: [{
        provider: selected.provider, itemType: selected.itemType, remoteItemId: selected.remoteItemId,
        originalName: "A Show S01E02 720p", completedAt: NOW,
        files: [{ provider: selected.provider, itemType: selected.itemType, remoteItemId: selected.remoteItemId, remoteFileId: selected.remoteFileId, originalFilename: selected.filename, remotePath: "display", bytes: selected.sizeBytes }],
      }],
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2, "needs-review"));
    database.acquisitions.reviews.save(episodeReview({ id: "review-title-race", wantedId: "wanted-e2" }));
    database.close();
    const originalList = realDebrid.listCompletedItems.bind(realDebrid);
    realDebrid.listCompletedItems = async () => {
      const changed = directDatabase();
      const wanted = changed.acquisitions.wanted.get("wanted-e2")!;
      changed.acquisitions.wanted.save({ ...wanted, seriesTitle: "Different Show" });
      changed.close();
      return originalList();
    };
    try {
      const response = await app.inject({ method: "POST", url: selectCandidateUrl("review-title-race"), payload: { candidateIndex: 0, reviewUpdatedAt: NOW } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "SELECTION_CONFLICT" });
      const final = directDatabase();
      expect(final.acquisitions.jobs.listByWanted("wanted-e2")).toEqual([]);
      expect(final.acquisitions.reviews.get("review-title-race")).toBeDefined();
      final.close();
    } finally {
      await app.close();
    }
  });
});

describe("DELETE /api/v1/acquisitions/wanted/:id", () => {
  test("removes a Wanted episode and reports unknown ids as not found", async () => {
    const { app } = await rig();
    try {
      const created = (
        await postWanted(app, {
          seriesTitle: "Severance",
          season: 1,
          episode: 2,
        })
      ).json();

      const removed = await app.inject({
        method: "DELETE",
        url: `${WANTED_URL}/${created.id}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ id: created.id, review: null });
      expect((await app.inject(WANTED_URL)).json()).toEqual([]);

      const missing = await app.inject({
        method: "DELETE",
        url: `${WANTED_URL}/does-not-exist`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  test("rejects removal with 409 ACTIVE_JOB while a nonterminal job exists", async () => {
    const { app } = await rig();
    const created = (
      await postWanted(app, {
        seriesTitle: "A Show",
        season: 1,
        episode: 2,
      })
    ).json();

    const database = directDatabase();
    database.acquisitions.jobs.save(
      jobRecord({
        id: randomUUID(),
        wantedId: created.id,
        state: "downloading",
        remoteItemId: "item-1",
        remoteFileId: "file-1",
      }),
    );
    database.close();

    try {
      const blocked = await app.inject({
        method: "DELETE",
        url: `${WANTED_URL}/${created.id}`,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: "ACTIVE_JOB" });
      expect((await app.inject(WANTED_URL)).json()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test("dismisses a season-pack offer that will not be imported", async () => {
    const { app } = await rig();
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.reviews.save(
      packOffer({ id: "pack-dismiss", wantedId: "wanted-e2" }),
    );
    database.close();

    try {
      expect((await app.inject(SEASON_PACKS_URL)).json()).toHaveLength(1);

      const dismissed = await app.inject({
        method: "POST",
        url: dismissReviewUrl("pack-dismiss"),
      });
      expect(dismissed.statusCode).toBe(200);
      expect(dismissed.json()).toMatchObject({
        dismissed: true,
        id: "pack-dismiss",
      });

      expect((await app.inject(SEASON_PACKS_URL)).json()).toHaveLength(0);
      const after = directDatabase();
      expect(after.acquisitions.reviews.get("pack-dismiss")).toBeUndefined();
      // Dismissing an OFFER must not touch the wanted episode it was anchored to:
      // offers are durable precisely so that removing one is an independent act.
      expect(after.acquisitions.wanted.get("wanted-e2")).toBeDefined();
      after.close();
    } finally {
      await app.close();
    }
  });

  test("dismissing an offer that does not exist reports not found", async () => {
    const { app } = await rig();
    try {
      const response = await app.inject({
        method: "POST",
        url: dismissReviewUrl("no-such-offer"),
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  test("keeps a durable season-pack offer when its anchor episode is removed", async () => {
    const { app } = await rig();
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.reviews.save(
      packOffer({ id: "pack-offer", wantedId: "wanted-e2" }),
    );
    database.close();

    try {
      expect((await app.inject(SEASON_PACKS_URL)).json()).toHaveLength(1);
      const removed = await app.inject({
        method: "DELETE",
        url: `${WANTED_URL}/wanted-e2`,
      });
      expect(removed.statusCode).toBe(200);

      // The offer itself is durable, not a cached view of the anchor.
      const after = directDatabase();
      expect(after.acquisitions.reviews.get("pack-offer")).toMatchObject({
        id: "pack-offer",
        kind: "season-pack",
      });
      after.close();

      const offers = (await app.inject(SEASON_PACKS_URL)).json();
      expect(offers).toHaveLength(1);
      expect(offers[0].episodes).toEqual([
        { episode: 1, sizeBytes: PACK_BYTES, resolution: "1080p", status: null },
        { episode: 2, sizeBytes: PACK_BYTES, resolution: "1080p", status: null },
        { episode: 3, sizeBytes: PACK_BYTES, resolution: "1080p", status: null },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe("acquisition status and command mappings", () => {
  test("summarizes durable Wanted, job and review records", async () => {
    const { app } = await rig();
    try {
      const empty = (await app.inject(STATUS_URL)).json();
      expect(empty).toMatchObject({
        wanted: { total: 0 },
        jobs: { total: 0, active: 0 },
        reviews: { total: 0 },
      });

      await postWanted(app, { seriesTitle: "Severance", season: 1, episode: 2 });
      const status = (await app.inject(STATUS_URL)).json();
      expect(status.wanted.total).toBe(1);
      expect(status.wanted.byStatus).toMatchObject({ wanted: 1 });
    } finally {
      await app.close();
    }
  });

  test("polls providers, reserves one exact match, and reports only typed state", async () => {
    const { app, realDebrid } = await rig({
      items: [
        {
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
              bytes: PACK_BYTES,
            },
          ],
        },
      ],
      download: async () => {
        // A temporary provider failure is retried with bounded backoff.
        throw new DownloadError("TEMPORARY_SERVICE_FAILURE", `token=${TOKEN}`, false);
      },
    });
    try {
      await postWanted(app, { seriesTitle: "A Show", season: 1, episode: 2 });
      const poll = await app.inject({ method: "POST", url: POLL_URL });
      expect(poll.statusCode).toBe(200);
      const body = poll.json();
      expect(body.providers).toContainEqual({
        provider: "real-debrid",
        state: "ok",
        itemCount: 1,
        errorCode: null,
      });
      expect(body.providers).toContainEqual({
        provider: "torbox",
        state: "missing-credential",
        itemCount: 0,
        errorCode: null,
      });
      expect(body.reservedJobIds).toHaveLength(1);
      expect(body.matchedWantedIds).toHaveLength(1);
      expect(body.reviewId).toBeNull();
      expect(body.seasonPackReviewId).toBeNull();
      expectNoLeaks(body);

      // The download ran through the coordinator and persisted retry state.
      const job = (await app.inject(STATUS_URL)).json().jobs;
      expect(job).toMatchObject({ total: 1, active: 1 });
      expect(job.byState).toEqual({ "retry-wait": 1 });
      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed[0]).toMatchObject({
        status: "retry-wait",
        job: {
          id: body.reservedJobIds[0],
          state: "retry-wait",
          provider: "real-debrid",
          attempt: 1,
          maxAttempts: defaultMaxAttempts,
          receivedBytes: 0,
          cancelRequested: false,
        },
      });
      expectNoLeaks(listed);
      expect(realDebrid.behavior.kind).toBe("ok");
    } finally {
      await app.close();
    }
  });

  test("contains provider poll failures as a typed error state only", async () => {
    const { app } = await rig({ behavior: { kind: "provider-error", code: "RATE_LIMITED" } });
    try {
      await postWanted(app, { seriesTitle: "A Show", season: 1, episode: 2 });
      const poll = await app.inject({ method: "POST", url: POLL_URL });
      expect(poll.statusCode).toBe(200);
      const body = poll.json();
      expect(body.providers).toContainEqual({
        provider: "real-debrid",
        state: "error",
        itemCount: 0,
        errorCode: "RATE_LIMITED",
      });
      expect(body.reservedJobIds).toEqual([]);
      expectNoLeaks(body);

      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed[0]).toMatchObject({
        status: "waiting-provider",
        statusDetail: null,
        job: null,
      });
    } finally {
      await app.close();
    }
  });

  test("maps every retry outcome to a safe, explicit response", async () => {
    const { app } = await rig({
      download: async () => {
        throw new DownloadError("PERMANENT_REJECTION", `token=${TOKEN}`, false);
      },
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.jobs.save(
      jobRecord({ id: "job-retry", wantedId: "wanted-e2", state: "needs-review" }),
    );
    database.acquisitions.wanted.create(wantedRecord("wanted-imported", 3));
    database.acquisitions.jobs.save(
      jobRecord({
        id: "job-imported",
        wantedId: "wanted-imported",
        episodeKey: episodeKey("A Show", 1, 3),
        state: "cancelled",
        cancelRequested: true,
        remoteItemId: "item-3",
        remoteFileId: "file-3",
      }),
    );
    database.acquisitions.imports.record({
      id: "import-3",
      wantedId: "wanted-imported",
      episodeKey: episodeKey("A Show", 1, 3),
      provider: "real-debrid",
      remoteItemId: "item-3",
      remoteFileId: "file-3",
      mediaId: "media-3",
      canonicalName: "A Show - S01E03 - Pilot.mkv",
      destinationPath: join(directory, "library", "A Show - S01E03 - Pilot.mkv"),
      importedAt: NOW,
    });
    database.acquisitions.wanted.create(wantedRecord("wanted-orphan", 4));
    database.acquisitions.jobs.save(
      jobRecord({
        id: "job-orphan",
        wantedId: "wanted-orphan",
        episodeKey: episodeKey("A Show", 1, 4),
        state: "cancelled",
        cancelRequested: true,
        remoteItemId: "item-4",
        remoteFileId: "file-4",
      }),
    );
    expect(database.acquisitions.wanted.remove("wanted-orphan").kind).toBe("removed");
    database.close();

    try {
      const queued = await app.inject({ method: "POST", url: retryUrl("job-retry") });
      expect(queued.statusCode).toBe(200);
      expect(queued.json()).toMatchObject({
        status: "queued",
        job: { id: "job-retry", state: "match-found", attempt: 0 },
      });
      expectNoLeaks(queued.json());

      const missing = await app.inject({
        method: "POST",
        url: retryUrl(randomUUID()),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });

      const imported = await app.inject({
        method: "POST",
        url: retryUrl("job-imported"),
      });
      expect(imported.statusCode).toBe(409);
      expect(imported.json()).toMatchObject({
        code: "ALREADY_IMPORTED",
        job: { id: "job-imported", state: "imported" },
      });
      expectNoLeaks(imported.json());

      const orphaned = await app.inject({
        method: "POST",
        url: retryUrl("job-orphan"),
      });
      expect(orphaned.statusCode).toBe(409);
      expect(orphaned.json()).toMatchObject({
        code: "WANTED_MISSING",
        reason: "missing-wanted",
        job: { id: "job-orphan", state: "cancelled" },
      });
      expectNoLeaks(orphaned.json());
    } finally {
      await app.close();
    }
  });

  test("reports a running transfer as an active job without starting a second one", async () => {
    let downloadStarted!: () => void;
    const began = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const { app } = await rig({
      download: async (_job, _provider, _token, _hooks, signal) => {
        downloadStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted by the user")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.jobs.save(
      jobRecord({ id: "job-active", wantedId: "wanted-e2", state: "match-found" }),
    );
    database.close();

    try {
      const first = app.inject({ method: "POST", url: retryUrl("job-active") });
      await began;

      const active = await app.inject({ method: "POST", url: retryUrl("job-active") });
      expect(active.statusCode).toBe(409);
      expect(active.json()).toMatchObject({ code: "ACTIVE_JOB" });
      expectNoLeaks(active.json());

      const cancelled = await app.inject({
        method: "POST",
        url: cancelUrl("job-active"),
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({
        status: "cancelled",
        job: { id: "job-active", state: "cancelled", cancelRequested: true },
      });

      expect((await first).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  test("maps every cancel outcome to a safe, explicit response", async () => {
    const { app } = await rig();
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.jobs.save(
      jobRecord({ id: "job-open", wantedId: "wanted-e2", state: "retry-wait" }),
    );
    database.acquisitions.jobs.save(
      jobRecord({
        id: "job-imported",
        wantedId: "wanted-e2",
        state: "imported",
        remoteItemId: "item-2",
        remoteFileId: "file-2",
      }),
    );
    database.close();

    try {
      const cancelled = await app.inject({ method: "POST", url: cancelUrl("job-open") });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({
        status: "cancelled",
        job: { id: "job-open", state: "cancelled", cancelRequested: true },
      });

      const again = await app.inject({ method: "POST", url: cancelUrl("job-open") });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "ALREADY_CANCELLED" });
      expectNoLeaks(again.json());

      const imported = await app.inject({
        method: "POST",
        url: cancelUrl("job-imported"),
      });
      expect(imported.statusCode).toBe(409);
      expect(imported.json()).toMatchObject({ code: "ALREADY_IMPORTED" });

      const missing = await app.inject({
        method: "POST",
        url: cancelUrl(randomUUID()),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });

      // Cancellation never removes durable audit or resumable state.
      const after = directDatabase();
      expect(after.acquisitions.jobs.get("job-open")).toMatchObject({
        state: "cancelled",
        cancelRequested: true,
      });
      after.close();
    } finally {
      await app.close();
    }
  });

  test("maps Import Season preflight, provider, and scheduling outcomes", async () => {
    const { app, realDebrid } = await rig({
      items: [packItem([1, 2, 3])],
      download: async () => {
        throw new DownloadError("TEMPORARY_SERVICE_FAILURE", "no download", false);
      },
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.reviews.save(
      packOffer({ id: "pack-offer", wantedId: "wanted-e2" }),
    );
    database.acquisitions.reviews.save(
      acquisitionReviewSchema.parse({
        id: "ambiguous-review",
        wantedId: "wanted-e2",
        kind: "ambiguous",
        message: "More than one equally good file matches this episode",
        candidates: [packCandidate(2)],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    database.close();

    try {
      const missing = await app.inject({
        method: "POST",
        url: importSeasonUrl(randomUUID()),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });

      const invalid = await app.inject({
        method: "POST",
        url: importSeasonUrl("ambiguous-review"),
      });
      expect(invalid.statusCode).toBe(409);
      expect(invalid.json()).toMatchObject({ code: "INVALID_OFFER" });

      // No saved credential is a user-actionable conflict, not a provider call.
      const { app: noCredentialApp } = await rig({
        credentials: {},
        items: [packItem([1, 2, 3])],
      });
      const noCredentialDatabase = directDatabase();
      if (!noCredentialDatabase.acquisitions.wanted.get("wanted-e2")) {
        noCredentialDatabase.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
      }
      noCredentialDatabase.close();
      try {
        const noCredential = await noCredentialApp.inject({
          method: "POST",
          url: importSeasonUrl("pack-offer"),
        });
        expect(noCredential.statusCode).toBe(409);
        expect(noCredential.json()).toMatchObject({
          code: "NO_CREDENTIAL",
          provider: "real-debrid",
        });
        expectNoLeaks(noCredential.json());
      } finally {
        await noCredentialApp.close();
      }

      realDebrid.behavior = { kind: "provider-error", code: "AUTHENTICATION" };
      const providerError = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(providerError.statusCode).toBe(502);
      expect(providerError.json()).toMatchObject({
        code: "AUTHENTICATION",
        provider: "real-debrid",
        retryable: false,
        message: "Authentication failed. Check the saved token and try again.",
      });
      expectNoLeaks(providerError.json());

      realDebrid.behavior = { kind: "generic-error" };
      const unavailable = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(unavailable.statusCode).toBe(502);
      expect(unavailable.json()).toMatchObject({
        code: "UNAVAILABLE",
        retryable: true,
      });
      expectNoLeaks(unavailable.json());

      realDebrid.behavior = { kind: "ok", items: [] };
      const gone = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(gone.statusCode).toBe(409);
      expect(gone.json()).toMatchObject({ code: "STALE_PACK", reason: "item-missing" });
      expectNoLeaks(gone.json());

      realDebrid.behavior = { kind: "ok", items: [packItem([1, 2, 3, 4])] };
      const changed = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: "STALE_PACK", reason: "changed-pack" });

      realDebrid.behavior = { kind: "ok", items: [packItem([1, 2, 3])] };
      const scheduled = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(scheduled.statusCode).toBe(200);
      expect(scheduled.json()).toMatchObject({
        status: "scheduled",
        alreadyImported: 0,
        alreadyScheduled: 0,
      });
      expect(scheduled.json().wantedIds).toHaveLength(3);
      expect(scheduled.json().jobIds).toHaveLength(3);
      expectNoLeaks(scheduled.json());

      // The durable offer is consumed exactly once: a replay is a plain 404.
      const replay = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(replay.statusCode).toBe(404);
      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed).toHaveLength(3);
      expect((await app.inject(SEASON_PACKS_URL)).json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("refuses Import Season when the managed inbox has no room", async () => {
    const { app } = await rig({
      items: [packItem([1, 2, 3])],
      hasFreeBytes: async () => false,
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.reviews.save(
      packOffer({ id: "pack-offer", wantedId: "wanted-e2" }),
    );
    database.close();

    try {
      const response = await app.inject({
        method: "POST",
        url: importSeasonUrl("pack-offer"),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "INSUFFICIENT_SPACE",
        provider: "real-debrid",
        neededBytes: 3 * PACK_BYTES,
      });
      expectNoLeaks(response.json());

      // Nothing was scheduled and the durable offer is still importable later.
      expect((await app.inject(SEASON_PACKS_URL)).json()).toHaveLength(1);
      expect((await app.inject(WANTED_URL)).json()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test("projects durable season-pack offers and survives anchor completion", async () => {
    const { app } = await rig({
      items: [packItem([1, 2, 3])],
      download: async () => {
        throw new DownloadError("TEMPORARY_SERVICE_FAILURE", "no download", false);
      },
    });
    try {
      await postWanted(app, { seriesTitle: "A Show", season: 1, episode: 2 });
      const poll = await app.inject({ method: "POST", url: POLL_URL });
      expect(poll.json().seasonPackReviewId).toEqual(expect.any(String));
      // Only the exact Wanted episode is reserved from the pack.
      expect(poll.json().reservedJobIds).toHaveLength(1);

      const offers = (await app.inject(SEASON_PACKS_URL)).json();
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        id: poll.json().seasonPackReviewId,
        provider: "real-debrid",
        seriesTitle: "A Show",
        season: 1,
        episodeCount: 3,
        totalBytes: 3 * PACK_BYTES,
        message: "Season pack with 3 recognized episodes",
      });
      expect(offers[0].episodes).toEqual([
        { episode: 1, sizeBytes: PACK_BYTES, resolution: "1080p", status: null },
        { episode: 2, sizeBytes: PACK_BYTES, resolution: "1080p", status: "retry-wait" },
        { episode: 3, sizeBytes: PACK_BYTES, resolution: "1080p", status: null },
      ]);
      expectNoLeaks(offers);

      // A pack offer is never folded into an episode's own review projection.
      const listed = (await app.inject(WANTED_URL)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ status: "retry-wait", review: null });

      const jobId = poll.json().reservedJobIds[0] as string;
      expect(
        (await app.inject({ method: "POST", url: cancelUrl(jobId) })).statusCode,
      ).toBe(200);

      // Simulated completion: the ledger wins and the anchor Wanted row goes
      // away, exactly as `completeAcquisitionImport` does.
      const database = directDatabase();
      const anchor = database.acquisitions.wanted.findByIdentity("A Show", 1, 2);
      expect(anchor).toBeDefined();
      const destinationPath = join(directory, "library", "A Show - S01E02 - Pilot.mkv");
      const placingJob = acquisitionJobSchema.parse({
        ...database.acquisitions.jobs.get(jobId)!,
        state: "placing",
        partPath: join(directory, "inbox", `${jobId}.part`),
        destinationPath,
        expectedBytes: PACK_BYTES,
        receivedBytes: PACK_BYTES,
        verifiedSha256: "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b",
        cancelRequested: false,
        updatedAt: NOW,
      });
      database.acquisitions.jobs.save(placingJob);
      database.acquisitions.wanted.setStatus(anchor!.id, "placing", { now: NOW });
      const media = {
        id: "media-e2",
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
      const completion: AcquisitionImportCompletion = {
        media,
        completedImport: {
          id: "import-e2",
          wantedId: anchor!.id,
          episodeKey: episodeKey("A Show", 1, 2),
          provider: "real-debrid",
          remoteItemId: placingJob.remoteItemId,
          remoteFileId: placingJob.remoteFileId,
          mediaId: media.id,
          canonicalName: basename(destinationPath),
          destinationPath,
          importedAt: NOW,
        },
        importedJob: { ...placingJob, state: "imported" },
      };
      database.completeAcquisitionImport(completion);
      database.close();

      const afterCompletion = (await app.inject(SEASON_PACKS_URL)).json();
      expect(afterCompletion).toHaveLength(1);
      expect(
        afterCompletion[0].episodes.map(
          (episode: { episode: number; status: string | null }) => [
            episode.episode,
            episode.status,
          ],
        ),
      ).toEqual([
        [1, null],
        [2, "imported"],
        [3, null],
      ]);
      expect((await app.inject(WANTED_URL)).json()).toEqual([]);
      expectNoLeaks(afterCompletion);
    } finally {
      await app.close();
    }
  });

  test("never returns tokens, credentials, URLs, local paths, or provider text", async () => {
    const { app } = await rig({
      behavior: { kind: "provider-error", code: "UNAVAILABLE" },
    });
    const database = directDatabase();
    database.acquisitions.wanted.create(wantedRecord("wanted-e2", 2));
    database.acquisitions.jobs.save(
      jobRecord({
        id: "job-secret",
        wantedId: "wanted-e2",
        state: "needs-review",
        partPath: join(directory, "inbox", "job-secret.part"),
        destinationPath: join(directory, "library", "A Show - S01E02 - Pilot.mkv"),
        lastError: RAW_PROVIDER_MESSAGE,
      }),
    );
    database.acquisitions.reviews.save(
      packOffer({ id: "pack-offer", wantedId: "wanted-e2" }),
    );
    database.close();

    try {
      const created = await postWanted(app, {
        seriesTitle: "A Show",
        season: 1,
        episode: 3,
      });
      const responses = await Promise.all([
        app.inject(WANTED_URL),
        app.inject(STATUS_URL),
        app.inject(SEASON_PACKS_URL),
        app.inject({ method: "POST", url: POLL_URL }),
        app.inject({ method: "POST", url: retryUrl("job-secret") }),
        app.inject({ method: "POST", url: cancelUrl("job-secret") }),
        app.inject({ method: "POST", url: importSeasonUrl("pack-offer") }),
        app.inject({ method: "POST", url: importSeasonUrl("missing-review") }),
        app.inject({ method: "POST", url: retryUrl("missing-job") }),
      ]);
      expect(created.statusCode).toBe(201);
      for (const response of responses) {
        expectNoLeaks(response.json());
      }
      expect((await app.inject(STATUS_URL)).json().wanted.total).toBe(2);

      // The token never reaches SQLite either.
      const raw = openDatabase(directory);
      const rows = raw
        .prepare("SELECT json FROM wanted_episodes UNION ALL SELECT json FROM acquisition_jobs UNION ALL SELECT json FROM acquisition_reviews UNION ALL SELECT json FROM completed_imports")
        .all() as Array<{ json: string }>;
      raw.close();
      const serialized = rows.map((row) => row.json).join("\n");
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(SIGNED_URL);
    } finally {
      await app.close();
    }
  });
});

test("persists Wanted records across an app restart with the same data directory", async () => {
  const first = await rig();
  const created = (
    await postWanted(first.app, {
      seriesTitle: "Severance",
      season: 1,
      episode: 2,
      episodeTitle: "Half Loop",
    })
  ).json();
  await first.app.close();

  const second = await rig();
  try {
    const listed = (await second.app.inject(WANTED_URL)).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
  } finally {
    await second.app.close();
  }
});

const WANTED_MOVIES_URL = "/api/v1/acquisitions/wanted-movies";

function postMovie(app: FastifyInstance, payload: object) {
  return app.inject({ method: "POST", url: WANTED_MOVIES_URL, payload });
}

describe("GET/POST/DELETE /api/v1/acquisitions/wanted-movies", () => {
  test("creates a wanted movie with a server id, wanted status and Stremio link", async () => {
    const { app } = await rig();
    try {
      expect((await app.inject(WANTED_MOVIES_URL)).json()).toEqual([]);

      const created = await postMovie(app, { title: "Dune", year: 2021 });
      expect(created.statusCode).toBe(201);
      const record = created.json();
      expect(record).toMatchObject({
        title: "Dune",
        year: 2021,
        status: "wanted",
        statusDetail: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(record.id).toMatch(UUID_V4);
      expect(record.stremioUrl).toBe("stremio:///search?search=Dune%202021");

      const listed = (await app.inject(WANTED_MOVIES_URL)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(record);
      expectNoLeaks(listed);
    } finally {
      await app.close();
    }
  });

  test("defaults an omitted year to null and drops it from the search query", async () => {
    const { app } = await rig();
    try {
      const created = await postMovie(app, { title: "Dune" });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ title: "Dune", year: null });
      expect(created.json().stremioUrl).toBe("stremio:///search?search=Dune");
    } finally {
      await app.close();
    }
  });

  test("treats title plus year as the identity, so remakes stay separate", async () => {
    const { app } = await rig();
    try {
      expect((await postMovie(app, { title: "Dune", year: 1984 })).statusCode).toBe(201);
      expect((await postMovie(app, { title: "Dune", year: 2021 })).statusCode).toBe(201);

      const listed = (await app.inject(WANTED_MOVIES_URL)).json();
      expect(listed).toHaveLength(2);
      expect(listed.map((movie: { year: number }) => movie.year).sort()).toEqual([1984, 2021]);
    } finally {
      await app.close();
    }
  });

  test("conflicts on a duplicate identity, including a case-only respelling", async () => {
    const { app } = await rig();
    try {
      const original = (await postMovie(app, { title: "The Thing", year: 1982 })).json();

      const exact = await postMovie(app, { title: "The Thing", year: 1982 });
      expect(exact.statusCode).toBe(409);
      expect(exact.json()).toMatchObject({ code: "ALREADY_WANTED" });

      const respelled = await postMovie(app, { title: "the  THING!", year: 1982 });
      expect(respelled.statusCode).toBe(409);
      expect(respelled.json()).toMatchObject({ code: "ALREADY_WANTED" });

      // A different year is a different film, not a duplicate.
      expect((await postMovie(app, { title: "The Thing", year: 2011 })).statusCode).toBe(201);

      const listed = (await app.inject(WANTED_MOVIES_URL)).json();
      expect(listed).toHaveLength(2);
      // Both records use the test's fixed clock, so the repository's secondary
      // UUID ordering is intentionally not insertion ordering.
      expect(listed.some((movie: { id: string }) => movie.id === original.id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("distinguishes an unknown year from a real one", async () => {
    const { app } = await rig();
    try {
      expect((await postMovie(app, { title: "Solaris", year: null })).statusCode).toBe(201);
      expect((await postMovie(app, { title: "Solaris", year: 1972 })).statusCode).toBe(201);
      // Repeating the unknown-year entry is still a duplicate of itself.
      expect((await postMovie(app, { title: "Solaris" })).statusCode).toBe(409);
      expect((await app.inject(WANTED_MOVIES_URL)).json()).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  test("removes a movie and reports an unknown id as missing", async () => {
    const { app } = await rig();
    try {
      const created = (await postMovie(app, { title: "Dune", year: 2021 })).json();

      const removed = await app.inject({
        method: "DELETE",
        url: `${WANTED_MOVIES_URL}/${created.id}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual(created);
      expect((await app.inject(WANTED_MOVIES_URL)).json()).toEqual([]);

      const missing = await app.inject({
        method: "DELETE",
        url: `${WANTED_MOVIES_URL}/no-such-movie`,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  test("rejects a blank title, an unknown key, and a non-positive year", async () => {
    const { app } = await rig();
    try {
      expect((await postMovie(app, { title: "   " })).statusCode).toBe(422);
      expect((await postMovie(app, { title: "Dune", year: 0 })).statusCode).toBe(422);
      expect((await postMovie(app, { title: "Dune", year: -4 })).statusCode).toBe(422);
      expect((await postMovie(app, { title: "Dune", year: 2021.5 })).statusCode).toBe(422);
      // The record shape is server-owned, so an injected status can never be stored.
      expect(
        (await postMovie(app, { title: "Dune", status: "imported" })).statusCode,
      ).toBe(422);
      expect((await app.inject(WANTED_MOVIES_URL)).json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("persists a wanted movie across a restart, like a wanted episode", async () => {
    const first = await rig();
    const created = (
      await postMovie(first.app, { title: "Dune", year: 2021 })
    ).json();
    await first.app.close();

    const second = await rig();
    try {
      const listed = (await second.app.inject(WANTED_MOVIES_URL)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(created);
    } finally {
      await second.app.close();
    }
  });
});
