import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import {
  AcquisitionConflictError,
  AcquisitionReferenceError,
  createAcquisitionRepository,
} from "../../src/acquisition/repository.js";
import {
  episodeKey,
  technicalStates,
  type AcquisitionJob,
  type AcquisitionReview,
  type CompletedImport,
  type WantedEpisode,
} from "../../src/acquisition/models.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "marktv-acquisition-"));
  temporaryDirectories.push(path);
  return path;
}

const CREATED_AT = "2026-09-14T12:00:00.000Z";
const UPDATED_AT = "2026-09-14T12:05:00.000Z";

function wanted(overrides: Partial<WantedEpisode> = {}): WantedEpisode {
  return {
    id: "wanted-1",
    seriesTitle: "Star Trek: Discovery",
    season: 1,
    episode: 2,
    episodeTitle: "Battle at the Binary Stars",
    status: "wanted",
    statusDetail: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function job(overrides: Partial<AcquisitionJob> = {}): AcquisitionJob {
  return {
    id: "job-1",
    wantedId: "wanted-1",
    episodeKey: episodeKey("Star Trek: Discovery", 1, 2),
    provider: "real-debrid",
    remoteItemId: "torrent-1",
    remoteFileId: "file-1",
    originalFilename: "Star.Trek.Discovery.S01E02.1080p.WEB.mkv",
    expectedBytes: 1_500_000_000,
    receivedBytes: 0,
    state: "waiting-provider",
    attempt: 0,
    maxAttempts: 3,
    retryAfterMs: null,
    cancelRequested: false,
    partPath: null,
    destinationPath: null,
    lastError: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function review(overrides: Partial<AcquisitionReview> = {}): AcquisitionReview {
  return {
    id: "review-1",
    wantedId: "wanted-1",
    kind: "ambiguous",
    message: "Two completed files match this episode equally.",
    candidates: [
      {
        provider: "real-debrid",
        itemType: "torrent",
        remoteItemId: "torrent-1",
        remoteFileId: "file-1",
        filename: "Star.Trek.Discovery.S01E02.1080p.WEB.mkv",
        sizeBytes: 1_500_000_000,
        resolution: "1080p",
        season: 1,
        episode: 2,
      },
      {
        provider: "real-debrid",
        itemType: "torrent",
        remoteItemId: "torrent-1",
        remoteFileId: "file-2",
        filename: "Star.Trek.Discovery.S01E02.720p.WEB.mkv",
        sizeBytes: 900_000_000,
        resolution: "720p",
        season: 1,
        episode: 2,
      },
    ],
    packEpisodeCount: null,
    packTotalBytes: null,
    packSeriesTitle: null,
    packSeason: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function completedImport(
  overrides: Partial<CompletedImport> = {},
): CompletedImport {
  return {
    id: "import-1",
    wantedId: "wanted-1",
    episodeKey: episodeKey("Star Trek: Discovery", 1, 2),
    provider: "real-debrid",
    remoteItemId: "torrent-1",
    remoteFileId: "file-1",
    mediaId: "media-1",
    canonicalName:
      "Star Trek Discovery - S01E02 - Battle at the Binary Stars.mkv",
    destinationPath:
      "/library/Star Trek Discovery - S01E02 - Battle at the Binary Stars.mkv",
    importedAt: UPDATED_AT,
    ...overrides,
  };
}

/**
 * Writes a database that only has the historical `acquisition_jobs` shape: no
 * `remote_identity_guard` column and an identity index that may or may not be
 * UNIQUE, exactly like the schemas shipped before this fix.
 */
function createLegacyJobDatabase(
  file: string,
  options: { indexName: string; unique: boolean },
) {
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE acquisition_jobs (
      id TEXT PRIMARY KEY,
      wanted_id TEXT NOT NULL,
      episode_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_item_id TEXT NOT NULL,
      remote_file_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE ${options.unique ? "UNIQUE " : ""}INDEX ${options.indexName}
      ON acquisition_jobs(provider, remote_item_id, remote_file_id);
  `);
  return legacy;
}

function insertLegacyJob(
  database: ReturnType<typeof createLegacyJobDatabase>,
  record: AcquisitionJob,
) {
  database
    .prepare(
      `INSERT INTO acquisition_jobs
         (id, wanted_id, episode_key, provider, remote_item_id, remote_file_id, state, created_at, updated_at, json)
       VALUES (@id, @wantedId, @episodeKey, @provider, @remoteItemId, @remoteFileId, @state, @createdAt, @updatedAt, @json)`,
    )
    .run({
      id: record.id,
      wantedId: record.wantedId,
      episodeKey: record.episodeKey,
      provider: record.provider,
      remoteItemId: record.remoteItemId,
      remoteFileId: record.remoteFileId,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      json: JSON.stringify(record),
    });
}

test("keeps wanted episodes after closing and reopening the database", async () => {
  const directory = await temporaryDirectory();
  const database = openDatabase(directory);
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  database.close();

  const reopenedDatabase = openDatabase(directory);
  const reopened = createAcquisitionRepository(reopenedDatabase);
  expect(reopened.wanted.list()).toEqual([wanted()]);
  expect(reopened.wanted.get("wanted-1")).toEqual(wanted());
  reopenedDatabase.close();
});

test("round-trips status, job, and review records across a reopen", async () => {
  const directory = await temporaryDirectory();
  const database = openDatabase(directory);
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  const downloading = repository.wanted.setStatus("wanted-1", "downloading", {
    now: "2026-09-14T12:10:00.000Z",
  });
  expect(downloading).toMatchObject({
    status: "downloading",
    updatedAt: "2026-09-14T12:10:00.000Z",
    createdAt: CREATED_AT,
  });
  repository.jobs.save(job());
  repository.reviews.save(review());
  expect(repository.wanted.get("wanted-1")).toEqual(downloading);
  database.close();

  const reopenedDatabase = openDatabase(directory);
  const reopened = createAcquisitionRepository(reopenedDatabase);
  expect(reopened.wanted.get("wanted-1")).toEqual(downloading);
  expect(reopened.wanted.listByStatus("downloading")).toEqual([downloading]);
  expect(reopened.jobs.get("job-1")).toEqual(job());
  expect(reopened.jobs.listByWanted("wanted-1")).toEqual([job()]);
  expect(reopened.reviews.get("review-1")).toEqual(review());
  expect(reopened.reviews.listByWanted("wanted-1")).toEqual([review()]);
  reopenedDatabase.close();
});

test("keeps two providers with colliding remote ids distinct across a reopen", async () => {
  const directory = await temporaryDirectory();
  const database = openDatabase(directory);
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  const shared = {
    remoteItemId: "torrent-1",
    remoteFileId: "file-1",
    filename: "Star.Trek.Discovery.S01E02.1080p.WEB.mkv",
    sizeBytes: 1_500_000_000,
    resolution: "1080p",
    season: 1,
    episode: 2,
  } as const;
  repository.reviews.save(
    review({
      kind: "season-pack",
      candidates: [
        { ...shared, provider: "real-debrid", itemType: "torrent" },
        { ...shared, provider: "torbox", itemType: "torrent" },
      ],
      packEpisodeCount: 2,
      packTotalBytes: 3_000_000_000,
    }),
  );
  const persisted = database
    .prepare("SELECT json FROM acquisition_reviews WHERE id = ?")
    .get("review-1") as { json: string };
  // Persisted candidates never carry a capability URL or token.
  expect(persisted.json).not.toMatch(/https?:\/\/|token|bearer/i);
  database.close();

  const reopened = createAcquisitionRepository(openDatabase(directory));
  const stored = reopened.reviews.get("review-1");
  expect(stored?.kind).toBe("season-pack");
  expect(stored?.packEpisodeCount).toBe(2);
  expect(stored?.packTotalBytes).toBe(3_000_000_000);
  expect(
    stored?.candidates.map(
      (candidate) =>
        `${candidate.provider}|${candidate.itemType}|${candidate.remoteItemId}|${candidate.remoteFileId}`,
    ),
  ).toEqual([
    "real-debrid|torrent|torrent-1|file-1",
    "torbox|torrent|torrent-1|file-1",
  ]);
});

test("persists the plan's exact durable technical state vocabulary", () => {
  expect([...technicalStates]).toEqual([
    "wanted",
    "waiting-provider",
    "match-found",
    "retry-wait",
    "downloading",
    "verifying",
    "placing",
    "imported",
    "needs-review",
    "cancelled",
  ]);
});

test("round-trips every technical state for Wanted and job records", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());

  technicalStates.forEach((state, index) => {
    const now = `2026-09-14T12:${String(index).padStart(2, "0")}:00.000Z`;
    expect(repository.wanted.setStatus("wanted-1", state, { now })?.status).toBe(
      state,
    );
    expect(repository.wanted.get("wanted-1")?.status).toBe(state);
    repository.jobs.save(job({ state, attempt: index, updatedAt: now }));
    expect(repository.jobs.get("job-1")?.state).toBe(state);
    expect(repository.jobs.get("job-1")?.attempt).toBe(index);
  });

  expect(repository.wanted.listByStatus("cancelled")).toHaveLength(1);
  expect(repository.jobs.list()).toHaveLength(1);
  database.close();
});

test("rejects the older snake_case state spellings", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());

  for (const legacy of [
    "waiting_for_provider",
    "match_found",
    "needs_review",
  ]) {
    expect(() =>
      repository.wanted.setStatus(
        "wanted-1",
        legacy as unknown as WantedEpisode["status"],
      ),
    ).toThrow();
  }
  expect(() =>
    repository.jobs.save(job({ state: "waiting" as unknown as AcquisitionJob["state"] })),
  ).toThrow();
  expect(() =>
    repository.jobs.save(job({ state: "failed" as unknown as AcquisitionJob["state"] })),
  ).toThrow();
  expect(repository.jobs.list()).toEqual([]);
  database.close();
});

test("removes a cancelled Wanted record with its open reviews but keeps job audit rows", async () => {
  const directory = await temporaryDirectory();
  const database = openDatabase(directory);
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  repository.jobs.save(job({ state: "cancelled" }));
  repository.reviews.save(review());
  repository.imports.record(completedImport());

  expect(repository.wanted.remove("wanted-1")).toEqual({
    kind: "removed",
    wanted: wanted(),
  });
  expect(repository.wanted.get("wanted-1")).toBeUndefined();
  expect(repository.reviews.listByWanted("wanted-1")).toEqual([]);
  expect(repository.reviews.list()).toEqual([]);
  // The job audit row (partial path, attempts, remote identity) is preserved.
  expect(repository.jobs.listByWanted("wanted-1")).toEqual([
    job({ state: "cancelled" }),
  ]);
  // Completed imports outlive the Wanted entry so a re-add can never re-import.
  expect(repository.imports.get("import-1")).toEqual(completedImport());
  database.close();
});

test("removes an unstarted Wanted record together with its open reviews", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  repository.reviews.save(review());

  expect(repository.wanted.remove("wanted-1")).toEqual({
    kind: "removed",
    wanted: wanted(),
  });
  expect(repository.wanted.list()).toEqual([]);
  expect(repository.reviews.list()).toEqual([]);
  database.close();
});

test("refuses to remove a Wanted record that still has a nonterminal job", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  repository.jobs.save(job({ state: "downloading" }));
  repository.reviews.save(review());

  expect(repository.wanted.remove("wanted-1")).toEqual({
    kind: "active-job",
    job: job({ state: "downloading" }),
  });
  expect(repository.wanted.get("wanted-1")).toEqual(wanted());
  expect(repository.jobs.get("job-1")).toEqual(job({ state: "downloading" }));
  expect(repository.reviews.listByWanted("wanted-1")).toEqual([review()]);
  database.close();
});

test("reports a missing Wanted record as not-found", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);

  expect(repository.wanted.remove("missing-wanted")).toEqual({
    kind: "not-found",
  });
  database.close();
});

test("keeps provider/item/file identity unique for jobs and lets retries reuse the job id", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  repository.jobs.save(job());

  const retry = repository.jobs.save(
    job({
      state: "retry-wait",
      attempt: 1,
      updatedAt: "2026-09-14T12:20:00.000Z",
    }),
  );
  expect(repository.jobs.list()).toEqual([retry]);
  expect(repository.jobs.get("job-1")?.state).toBe("retry-wait");
  expect(() => repository.jobs.save(job({ id: "job-2" }))).toThrow(
    AcquisitionConflictError,
  );
  expect(repository.jobs.list()).toEqual([retry]);
  expect(
    repository.jobs.findRemote("real-debrid", "torrent-1", "file-1")?.id,
  ).toBe("job-1");
  database.close();
});

test("retires the legacy non-unique job index and enforces the unique one", async () => {
  const directory = await temporaryDirectory();
  const database = openDatabase(directory);
  // Reproduce the pre-fix schema shape: no unique job index, only the earlier
  // non-unique lookup index of the same columns.
  database.exec(
    "DROP INDEX IF EXISTS acquisition_jobs_remote_identity_unique;" +
      "CREATE INDEX IF NOT EXISTS acquisition_jobs_remote_identity" +
      " ON acquisition_jobs(provider, remote_item_id, remote_file_id);",
  );
  database.close();

  const reopenedDatabase = openDatabase(directory);
  const indexNames = reopenedDatabase
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'acquisition_jobs'",
    )
    .all()
    .map((row) => (row as { name: string }).name);
  expect(indexNames).toContain("acquisition_jobs_remote_identity_unique");
  expect(indexNames).not.toContain("acquisition_jobs_remote_identity");

  const repository = createAcquisitionRepository(reopenedDatabase);
  repository.wanted.create(wanted());
  repository.jobs.save(job());
  expect(() => repository.jobs.save(job({ id: "job-2" }))).toThrow(
    AcquisitionConflictError,
  );
  reopenedDatabase.close();
});

test("opens a legacy database whose duplicate job rows the earlier schema allowed", async () => {
  const directory = await temporaryDirectory();
  // The pre-fix schema indexed provider/item/file without UNIQUE, so a real
  // database can already hold two job rows with the same remote identity.
  const legacy = createLegacyJobDatabase(join(directory, "marktv.sqlite"), {
    indexName: "acquisition_jobs_remote_identity",
    unique: false,
  });
  for (const id of ["job-legacy-1", "job-legacy-2"]) {
    insertLegacyJob(legacy, job({ id, state: "cancelled" }));
  }
  legacy.close();

  // Building the UNIQUE index without reconciling those rows used to abort
  // `openDatabase`; both historical rows must survive the migration.
  const database = openDatabase(directory);
  const repository = createAcquisitionRepository(database);
  expect(
    repository.jobs.list().map((record) => record.id).sort(),
  ).toEqual(["job-legacy-1", "job-legacy-2"]);

  // A retry of one historical duplicate keeps working, because it reuses the
  // identity that row already has instead of claiming a new one.
  const retriedLegacy = repository.jobs.save(
    job({
      id: "job-legacy-1",
      state: "retry-wait",
      attempt: 1,
      updatedAt: "2026-09-14T12:40:00.000Z",
    }),
  );
  expect(repository.jobs.get("job-legacy-1")).toEqual(retriedLegacy);

  // No new write may add a third row for that same provider/item/file.
  repository.wanted.create(wanted());
  expect(() => repository.jobs.save(job({ id: "job-new" }))).toThrow(
    AcquisitionConflictError,
  );
  // A genuinely new identity is still accepted.
  const fresh = repository.jobs.save(
    job({ id: "job-fresh", remoteItemId: "torrent-2", remoteFileId: "file-2" }),
  );
  expect(repository.jobs.get("job-fresh")).toEqual(fresh);
  expect(repository.jobs.list()).toHaveLength(3);
  database.close();
});

test("upgrades a database that already carries the round-one job index", async () => {
  const directory = await temporaryDirectory();
  const legacy = createLegacyJobDatabase(join(directory, "marktv.sqlite"), {
    indexName: "acquisition_jobs_remote_identity_unique",
    unique: true,
  });
  const first = job({ id: "job-1", state: "cancelled" });
  const second = job({
    id: "job-2",
    wantedId: "wanted-2",
    episodeKey: episodeKey("Star Trek: Discovery", 1, 3),
    remoteItemId: "torrent-2",
    remoteFileId: "file-2",
  });
  insertLegacyJob(legacy, first);
  insertLegacyJob(legacy, second);
  legacy.close();

  const database = openDatabase(directory);
  const repository = createAcquisitionRepository(database);
  expect(repository.jobs.list().map((record) => record.id).sort()).toEqual([
    "job-1",
    "job-2",
  ]);

  const indexNames = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'acquisition_jobs'",
    )
    .all() as Array<{ name: string; sql: string | null }>;
  const identityIndex = indexNames.find(
    (index) => index.name === "acquisition_jobs_remote_identity_unique",
  );
  // The round-one index enforced the raw identity columns, which cannot hold
  // historical duplicates; the upgrade moves uniqueness onto the guard.
  expect(identityIndex?.sql).toContain("remote_identity_guard");
  expect(indexNames.map((index) => index.name)).not.toContain(
    "acquisition_jobs_remote_identity",
  );

  repository.wanted.create(wanted());
  expect(() => repository.jobs.save(job({ id: "job-3" }))).toThrow(
    AcquisitionConflictError,
  );
  expect(repository.jobs.list()).toHaveLength(2);
  database.close();
});

test("validates a job's episode key against its referenced Wanted record", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());

  expect(() =>
    repository.jobs.save(
      job({ episodeKey: episodeKey("Star Trek: Discovery", 1, 9) }),
    ),
  ).toThrow(AcquisitionReferenceError);
  expect(repository.jobs.list()).toEqual([]);

  // A brand new job may never point at a Wanted record that does not exist.
  expect(() =>
    repository.jobs.save(job({ id: "job-9", wantedId: "wanted-unknown" })),
  ).toThrow(AcquisitionReferenceError);

  // A key that does not carry the canonical shape is rejected before SQL, even
  // when no Wanted row could contradict it.
  expect(() =>
    repository.jobs.save(
      job({ id: "job-8", wantedId: "wanted-unknown", episodeKey: "anything" }),
    ),
  ).toThrow();
  expect(repository.jobs.list()).toEqual([]);
  database.close();
});

test("rejects a new orphan job and allows only same-identity updates after Wanted removal", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  repository.jobs.save(job({ state: "cancelled" }));
  expect(repository.wanted.remove("wanted-1")).toEqual({
    kind: "removed",
    wanted: wanted(),
  });

  // The persisted job is now an orphan: a brand new job pointing at the same
  // absent Wanted record is rejected...
  expect(() =>
    repository.jobs.save(job({ id: "job-2", state: "waiting-provider" })),
  ).toThrow(AcquisitionReferenceError);
  // ...and so is any change to the orphan's immutable identity, even though
  // every one of those values still satisfies the loose episode-key shape.
  for (const changed of [
    job({ remoteFileId: "file-2" }),
    job({ remoteItemId: "torrent-2" }),
    job({ provider: "torbox" }),
    job({ wantedId: "wanted-2" }),
    job({ episodeKey: episodeKey("Star Trek: Discovery", 1, 5) }),
  ]) {
    expect(() => repository.jobs.save(changed)).toThrow(
      AcquisitionReferenceError,
    );
  }

  // A same-id retry that keeps the immutable identity is still allowed, so a
  // cancelled orphan can be resolved after its Wanted entry is gone.
  const retried = repository.jobs.save(
    job({
      state: "cancelled",
      attempt: 1,
      updatedAt: "2026-09-14T12:30:00.000Z",
    }),
  );
  expect(repository.jobs.get("job-1")).toEqual(retried);
  expect(retried.attempt).toBe(1);
  expect(repository.jobs.list()).toEqual([retried]);
  database.close();
});

test("validates a completed import's episode key against its referenced Wanted record", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());

  expect(() =>
    repository.imports.record(
      completedImport({
        episodeKey: episodeKey("Star Trek: Discovery", 1, 9),
      }),
    ),
  ).toThrow(AcquisitionReferenceError);
  expect(repository.imports.list()).toEqual([]);

  const orphan = completedImport({
    id: "import-9",
    wantedId: "wanted-unknown",
  });
  expect(repository.imports.record(orphan)).toEqual(orphan);
  database.close();
});

test("rolls back every write when a transaction throws", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());

  expect(() =>
    repository.transaction(() => {
      repository.jobs.save(job());
      repository.reviews.save(review());
      throw new Error("boom");
    }),
  ).toThrow("boom");

  expect(repository.jobs.get("job-1")).toBeUndefined();
  expect(repository.reviews.get("review-1")).toBeUndefined();
  expect(repository.wanted.get("wanted-1")).toEqual(wanted());
  database.close();
});

test("rejects a second Wanted record for the same normalized episode identity", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());

  expect(() => repository.wanted.create(wanted())).toThrow(
    AcquisitionConflictError,
  );
  expect(() =>
    repository.wanted.create(
      wanted({
        id: "wanted-2",
        seriesTitle: "  star   trek: DISCOVERY ",
        season: 1,
        episode: 2,
      }),
    ),
  ).toThrow(AcquisitionConflictError);
  expect(repository.wanted.list()).toEqual([wanted()]);

  repository.wanted.create(wanted({ id: "wanted-3", episode: 3 }));
  expect(repository.wanted.list()).toHaveLength(2);
  expect(
    repository.wanted.findByIdentity("Star Trek: Discovery", 1, 3)?.id,
  ).toBe("wanted-3");
  database.close();
});

test("prevents importing the same provider item and file twice", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);
  repository.wanted.create(wanted());
  repository.imports.record(completedImport());

  expect(() =>
    repository.imports.record(completedImport({ id: "import-2" })),
  ).toThrow(AcquisitionConflictError);
  expect(() =>
    repository.imports.record(
      completedImport({
        id: "import-3",
        remoteItemId: "torrent-9",
        remoteFileId: "file-9",
        mediaId: "media-9",
      }),
    ),
  ).toThrow(AcquisitionConflictError);

  expect(repository.imports.list()).toEqual([completedImport()]);
  expect(
    repository.imports.findByRemote("real-debrid", "torrent-1", "file-1")?.id,
  ).toBe("import-1");
  expect(
    repository.imports.findByEpisode("star trek discovery", 1, 2)?.id,
  ).toBe("import-1");
  database.close();
});

test("rejects unknown fields and non-ISO timestamps before writing", async () => {
  const database = openDatabase(await temporaryDirectory());
  const repository = createAcquisitionRepository(database);

  expect(() =>
    repository.wanted.create({ ...wanted(), token: "nope" } as unknown as WantedEpisode),
  ).toThrow();
  expect(() =>
    repository.wanted.create(
      wanted({ id: "wanted-bad", createdAt: "yesterday" }),
    ),
  ).toThrow();
  expect(() =>
    repository.jobs.save({ ...job(), state: "teleporting" } as unknown as AcquisitionJob),
  ).toThrow();
  // A review candidate without provider/itemType identity cannot be persisted.
  expect(() =>
    repository.reviews.save(
      review({
        candidates: [
          {
            remoteItemId: "torrent-1",
            remoteFileId: "file-1",
            filename: "Star.Trek.Discovery.S01E02.1080p.WEB.mkv",
            sizeBytes: null,
            resolution: null,
            season: 1,
            episode: 2,
          },
        ] as unknown as AcquisitionReview["candidates"],
      }),
    ),
  ).toThrow();
  expect(repository.wanted.list()).toEqual([]);
  expect(repository.jobs.list()).toEqual([]);
  database.close();
});

test("derives one identity for titles that differ only by punctuation and case", () => {
  expect(episodeKey("Star Trek: Discovery", 1, 2)).toBe(
    episodeKey("  star   trek—discovery ", 1, 2),
  );
  expect(episodeKey("Star Trek: Discovery", 1, 2)).not.toBe(
    episodeKey("Star Trek: Discovery", 1, 3),
  );
  expect(episodeKey("Star Trek: Discovery", 1, 2)).not.toBe(
    episodeKey("Star Trek: Discovery", 2, 2),
  );
  expect(episodeKey("Star Trek: Discovery", 1, 2)).not.toBe(
    episodeKey("Star Trek: Picard", 1, 2),
  );
});
