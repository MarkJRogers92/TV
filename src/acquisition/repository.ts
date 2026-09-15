import { remoteIdentityGuard, type MarkTvDatabase } from "../db/database.js";
import {
  acquisitionJobSchema,
  acquisitionProviderSchema,
  acquisitionReviewSchema,
  completedImportSchema,
  episodeKey,
  wantedEpisodeSchema,
  type AcquisitionJob,
  type AcquisitionJobState,
  type AcquisitionProviderId,
  type AcquisitionReview,
  type CompletedImport,
  type WantedEpisode,
  type WantedStatus,
} from "./models.js";

/**
 * Raised when a durable acquisition record would duplicate an existing
 * identity. The coordinator maps this to a safe "already imported" or
 * "already wanted" outcome instead of surfacing a driver error.
 */
export class AcquisitionConflictError extends Error {
  readonly code = "ACQUISITION_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "AcquisitionConflictError";
  }
}

/**
 * Raised when a record's episode identity contradicts the Wanted record it
 * points at. Callers treat this as a programming error (not a user conflict):
 * the durable key must always agree with the Wanted episode it belongs to.
 */
export class AcquisitionReferenceError extends Error {
  readonly code = "ACQUISITION_IDENTITY_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "AcquisitionReferenceError";
  }
}

/**
 * Job states that no longer block Wanted deletion. `cancelled` is the state a
 * user reaches by cancelling first, and `imported` is a finished workflow whose
 * ledger row (not the job row) is what prevents a second import. Every other
 * state — including `needs-review` — is nonterminal and must be resolved first.
 */
export const terminalJobStates = [
  "imported",
  "cancelled",
] as const satisfies readonly AcquisitionJobState[];

function isTerminalJobState(state: AcquisitionJobState): boolean {
  return (terminalJobStates as readonly string[]).includes(state);
}

/**
 * Outcome of `wanted.remove`, discriminated so callers can map it to
 * `409 ACTIVE_JOB`, a 404, or success without guessing from a boolean.
 */
export type WantedRemovalResult =
  | { readonly kind: "removed"; readonly wanted: WantedEpisode }
  | { readonly kind: "active-job"; readonly job: AcquisitionJob }
  | { readonly kind: "not-found" };

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code } = error as { code?: unknown };
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function asConflict(error: unknown, message: string): never {
  if (isConstraintViolation(error)) throw new AcquisitionConflictError(message);
  throw error;
}

function parseJson<T>(
  row: { json: string } | undefined,
  parse: (value: unknown) => T,
): T | undefined {
  return row ? parse(JSON.parse(row.json)) : undefined;
}

export type AcquisitionRepository = {
  wanted: {
    list(): WantedEpisode[];
    listByStatus(status: WantedStatus): WantedEpisode[];
    get(id: string): WantedEpisode | undefined;
    findByIdentity(
      seriesTitle: string,
      season: number,
      episode: number,
    ): WantedEpisode | undefined;
    create(record: WantedEpisode): WantedEpisode;
    save(record: WantedEpisode): WantedEpisode;
    setStatus(
      id: string,
      status: WantedStatus,
      options?: { detail?: string | null; now?: string },
    ): WantedEpisode | undefined;
    /**
     * Removes only the Wanted record and its open reviews, and only when no
     * nonterminal job exists. Job audit rows, completed imports, and local paths
     * are always preserved.
     */
    remove(id: string): WantedRemovalResult;
  };
  jobs: {
    list(): AcquisitionJob[];
    listByWanted(wantedId: string): AcquisitionJob[];
    get(id: string): AcquisitionJob | undefined;
    findRemote(
      provider: AcquisitionProviderId,
      remoteItemId: string,
      remoteFileId: string,
    ): AcquisitionJob | undefined;
    save(record: AcquisitionJob): AcquisitionJob;
    remove(id: string): boolean;
  };
  reviews: {
    list(): AcquisitionReview[];
    listByWanted(wantedId: string): AcquisitionReview[];
    get(id: string): AcquisitionReview | undefined;
    save(record: AcquisitionReview): AcquisitionReview;
    remove(id: string): boolean;
  };
  imports: {
    list(): CompletedImport[];
    get(id: string): CompletedImport | undefined;
    findByEpisode(
      seriesTitle: string,
      season: number,
      episode: number,
    ): CompletedImport | undefined;
    findByRemote(
      provider: AcquisitionProviderId,
      remoteItemId: string,
      remoteFileId: string,
    ): CompletedImport | undefined;
    record(record: CompletedImport): CompletedImport;
    remove(id: string): boolean;
  };
  transaction<T>(operation: () => T): T;
};

export function createAcquisitionRepository(
  database: MarkTvDatabase,
): AcquisitionRepository {
  const selectWanted = database.prepare(
    "SELECT json FROM wanted_episodes WHERE id = ?",
  );
  const insertWanted = database.prepare(
    `INSERT INTO wanted_episodes
       (id, episode_key, series_title, season, episode, status, created_at, updated_at, json)
     VALUES (@id, @episodeKey, @seriesTitle, @season, @episode, @status, @createdAt, @updatedAt, @json)`,
  );
  const upsertWanted = database.prepare(
    `INSERT INTO wanted_episodes
       (id, episode_key, series_title, season, episode, status, created_at, updated_at, json)
     VALUES (@id, @episodeKey, @seriesTitle, @season, @episode, @status, @createdAt, @updatedAt, @json)
     ON CONFLICT(id) DO UPDATE SET
       episode_key = excluded.episode_key,
       series_title = excluded.series_title,
       season = excluded.season,
       episode = excluded.episode,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       json = excluded.json`,
  );

  const wantedColumns = (record: WantedEpisode) => ({
    id: record.id,
    episodeKey: episodeKey(record.seriesTitle, record.season, record.episode),
    seriesTitle: record.seriesTitle,
    season: record.season,
    episode: record.episode,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    json: JSON.stringify(record),
  });

  const selectJob = database.prepare(
    "SELECT json FROM acquisition_jobs WHERE id = ?",
  );
  const selectJobIdentity = database.prepare(
    `SELECT id, wanted_id, episode_key, provider, remote_item_id, remote_file_id
       FROM acquisition_jobs WHERE id = ?`,
  );
  const selectRemoteIdentityOwner = database.prepare(
    `SELECT id FROM acquisition_jobs
      WHERE provider = ? AND remote_item_id = ? AND remote_file_id = ? AND id <> ?
      ORDER BY created_at, id LIMIT 1`,
  );
  const upsertJob = database.prepare(
    `INSERT INTO acquisition_jobs
       (id, wanted_id, episode_key, provider, remote_item_id, remote_file_id, state, created_at, updated_at, remote_identity_guard, json)
     VALUES (@id, @wantedId, @episodeKey, @provider, @remoteItemId, @remoteFileId, @state, @createdAt, @updatedAt, @remoteIdentityGuard, @json)
     ON CONFLICT(id) DO UPDATE SET
       wanted_id = excluded.wanted_id,
       episode_key = excluded.episode_key,
       provider = excluded.provider,
       remote_item_id = excluded.remote_item_id,
       remote_file_id = excluded.remote_file_id,
       state = excluded.state,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       remote_identity_guard = excluded.remote_identity_guard,
       json = excluded.json`,
  );
  const jobColumns = (record: AcquisitionJob, guard: string | null) => ({
    id: record.id,
    wantedId: record.wantedId,
    episodeKey: record.episodeKey,
    provider: record.provider,
    remoteItemId: record.remoteItemId,
    remoteFileId: record.remoteFileId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    remoteIdentityGuard: guard,
    json: JSON.stringify(record),
  });

  const selectReview = database.prepare(
    "SELECT json FROM acquisition_reviews WHERE id = ?",
  );
  const upsertReview = database.prepare(
    `INSERT INTO acquisition_reviews
       (id, wanted_id, kind, created_at, updated_at, json)
     VALUES (@id, @wantedId, @kind, @createdAt, @updatedAt, @json)
     ON CONFLICT(id) DO UPDATE SET
       wanted_id = excluded.wanted_id,
       kind = excluded.kind,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       json = excluded.json`,
  );
  const reviewColumns = (record: AcquisitionReview) => ({
    id: record.id,
    wantedId: record.wantedId,
    kind: record.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    json: JSON.stringify(record),
  });

  const selectImport = database.prepare(
    "SELECT json FROM completed_imports WHERE id = ?",
  );
  const insertImport = database.prepare(
    `INSERT INTO completed_imports
       (id, wanted_id, episode_key, provider, remote_item_id, remote_file_id, imported_at, json)
     VALUES (@id, @wantedId, @episodeKey, @provider, @remoteItemId, @remoteFileId, @importedAt, @json)`,
  );
  const importColumns = (record: CompletedImport) => ({
    id: record.id,
    wantedId: record.wantedId,
    episodeKey: record.episodeKey,
    provider: record.provider,
    remoteItemId: record.remoteItemId,
    remoteFileId: record.remoteFileId,
    importedAt: record.importedAt,
    json: JSON.stringify(record),
  });

  const parseWanted = (value: unknown) => wantedEpisodeSchema.parse(value);
  const parseJob = (value: unknown) => acquisitionJobSchema.parse(value);
  const parseReview = (value: unknown) => acquisitionReviewSchema.parse(value);
  const parseImport = (value: unknown) => completedImportSchema.parse(value);

  /**
   * The episode key owned by the referenced Wanted record, or `undefined` when
   * no such record exists. Imports legitimately outlive the Wanted entry they
   * came from, so callers decide what a missing record means.
   */
  const wantedEpisodeKey = (wantedId: string): string | undefined => {
    const row = selectWanted.get(wantedId) as { json: string } | undefined;
    if (!row) return undefined;
    const owner = parseWanted(JSON.parse(row.json));
    return episodeKey(owner.seriesTitle, owner.season, owner.episode);
  };

  /**
   * Rejects a key that contradicts the Wanted record it points at.
   */
  const assertEpisodeKeyMatchesWanted = (wantedId: string, key: string) => {
    const expected = wantedEpisodeKey(wantedId);
    if (expected !== undefined && expected !== key) {
      throw new AcquisitionReferenceError(
        `Episode key "${key}" does not match Wanted record ${wantedId} ("${expected}")`,
      );
    }
  };

  type JobIdentityRow = {
    id: string;
    wanted_id: string;
    episode_key: string;
    provider: string;
    remote_item_id: string;
    remote_file_id: string;
  };

  /**
   * Every job must belong to a Wanted record whose episode identity it matches.
   * A missing Wanted row is only tolerated for a job that already exists and
   * that keeps its immutable identity (wantedId, episodeKey, provider, item,
   * file) byte-for-byte: a cancelled or imported job must stay updatable after
   * its Wanted entry is removed, but no new orphan may be created and nothing
   * may re-point an existing row at a different episode or remote file.
   */
  const assertJobReference = (
    record: AcquisitionJob,
    current: JobIdentityRow | undefined,
  ) => {
    const ownedKey = wantedEpisodeKey(record.wantedId);
    if (ownedKey !== undefined) {
      if (ownedKey !== record.episodeKey) {
        throw new AcquisitionReferenceError(
          `Job ${record.id} claims episode key "${record.episodeKey}" but Wanted record ${record.wantedId} owns "${ownedKey}"`,
        );
      }
      return;
    }
    if (!current) {
      throw new AcquisitionReferenceError(
        `Job ${record.id} references missing Wanted record ${record.wantedId}`,
      );
    }
    const keepsIdentity =
      current.wanted_id === record.wantedId &&
      current.episode_key === record.episodeKey &&
      current.provider === record.provider &&
      current.remote_item_id === record.remoteItemId &&
      current.remote_file_id === record.remoteFileId;
    if (!keepsIdentity) {
      throw new AcquisitionReferenceError(
        `Job ${record.id} cannot take a new identity because Wanted record ${record.wantedId} no longer exists`,
      );
    }
  };

  const transaction = <T>(operation: () => T): T =>
    database.transaction(operation)();

  const listJson = (sql: string, ...parameters: unknown[]) =>
    database.prepare(sql).all(...parameters) as Array<{ json: string }>;

  return {
    wanted: {
      list: () =>
        listJson("SELECT json FROM wanted_episodes ORDER BY created_at, id").map(
          (row) => parseWanted(JSON.parse(row.json)),
        ),
      listByStatus: (status) =>
        listJson(
          "SELECT json FROM wanted_episodes WHERE status = ? ORDER BY created_at, id",
          status,
        ).map((row) => parseWanted(JSON.parse(row.json))),
      get: (id) =>
        parseJson(selectWanted.get(id) as { json: string } | undefined, parseWanted),
      findByIdentity: (seriesTitle, season, episode) =>
        parseJson(
          database
            .prepare("SELECT json FROM wanted_episodes WHERE episode_key = ?")
            .get(episodeKey(seriesTitle, season, episode)) as
            | { json: string }
            | undefined,
          parseWanted,
        ),
      create: (record) => {
        const validated = parseWanted(record);
        try {
          insertWanted.run(wantedColumns(validated));
        } catch (error) {
          asConflict(
            error,
            `A Wanted record already exists for ${validated.seriesTitle} S${validated.season}E${validated.episode}`,
          );
        }
        return validated;
      },
      save: (record) => {
        const validated = parseWanted(record);
        try {
          upsertWanted.run(wantedColumns(validated));
        } catch (error) {
          asConflict(
            error,
            `A different Wanted record already claims ${validated.seriesTitle} S${validated.season}E${validated.episode}`,
          );
        }
        return validated;
      },
      setStatus: (id, status, options = {}) =>
        transaction(() => {
          const current = parseJson(
            selectWanted.get(id) as { json: string } | undefined,
            parseWanted,
          );
          if (!current) return undefined;
          const next = parseWanted({
            ...current,
            status,
            statusDetail:
              options.detail === undefined ? current.statusDetail : options.detail,
            updatedAt: options.now ?? new Date().toISOString(),
          });
          upsertWanted.run(wantedColumns(next));
          return next;
        }),
      remove: (id) =>
        transaction(() => {
          const row = selectWanted.get(id) as { json: string } | undefined;
          if (!row) return { kind: "not-found" } as WantedRemovalResult;
          const wantedRecord = parseWanted(JSON.parse(row.json));
          const activeJob = listJson(
            "SELECT json FROM acquisition_jobs WHERE wanted_id = ? ORDER BY created_at, id",
            id,
          )
            .map((jobRow) => parseJob(JSON.parse(jobRow.json)))
            .find((candidate) => !isTerminalJobState(candidate.state));
          if (activeJob) {
            return { kind: "active-job", job: activeJob } as WantedRemovalResult;
          }
          // Only the Wanted row and its open reviews are removed here: a
          // cancelled job's partial file and audit row, completed imports, and
          // finished local files all remain on disk and in the database.
          database
            .prepare("DELETE FROM acquisition_reviews WHERE wanted_id = ?")
            .run(id);
          database.prepare("DELETE FROM wanted_episodes WHERE id = ?").run(id);
          return { kind: "removed", wanted: wantedRecord } as WantedRemovalResult;
        }),
    },
    jobs: {
      list: () =>
        listJson("SELECT json FROM acquisition_jobs ORDER BY created_at, id").map(
          (row) => parseJob(JSON.parse(row.json)),
        ),
      listByWanted: (wantedId) =>
        listJson(
          "SELECT json FROM acquisition_jobs WHERE wanted_id = ? ORDER BY created_at, id",
          wantedId,
        ).map((row) => parseJob(JSON.parse(row.json))),
      get: (id) =>
        parseJson(selectJob.get(id) as { json: string } | undefined, parseJob),
      findRemote: (provider, remoteItemId, remoteFileId) => {
        acquisitionProviderSchema.parse(provider);
        return parseJson(
          database
            .prepare(
              `SELECT json FROM acquisition_jobs
               WHERE provider = ? AND remote_item_id = ? AND remote_file_id = ?
               ORDER BY created_at, id LIMIT 1`,
            )
            .get(provider, remoteItemId, remoteFileId) as
            | { json: string }
            | undefined,
          parseJob,
        );
      },
      save: (record) => {
        const validated = parseJob(record);
        const current = selectJobIdentity.get(validated.id) as
          | JobIdentityRow
          | undefined;
        assertJobReference(validated, current);
        // A retry reuses the row it already owns, so only a write that claims
        // an identity another row holds is a conflict. The lookup excludes the
        // row itself, so a historical duplicate keeps its own identity.
        const otherOwner = selectRemoteIdentityOwner.get(
          validated.provider,
          validated.remoteItemId,
          validated.remoteFileId,
          validated.id,
        ) as { id: string } | undefined;
        const ownsIdentity =
          current !== undefined &&
          current.provider === validated.provider &&
          current.remote_item_id === validated.remoteItemId &&
          current.remote_file_id === validated.remoteFileId;
        if (otherOwner && !ownsIdentity) {
          throw new AcquisitionConflictError(
            `A job already tracks ${validated.provider} item ${validated.remoteItemId} file ${validated.remoteFileId}`,
          );
        }
        try {
          upsertJob.run(
            jobColumns(
              validated,
              // Rows that share an identity with a historical duplicate stay
              // NULL so the guard index keeps admitting both of them.
              otherOwner
                ? null
                : remoteIdentityGuard(
                    validated.provider,
                    validated.remoteItemId,
                    validated.remoteFileId,
                  ),
            ),
          );
        } catch (error) {
          // One provider item/file pair maps to exactly one job row, so a
          // duplicate identity (rather than a retry of the same job id) is a
          // conflict instead of a raw driver error.
          asConflict(
            error,
            `A job already tracks ${validated.provider} item ${validated.remoteItemId} file ${validated.remoteFileId}`,
          );
        }
        return validated;
      },
      remove: (id) =>
        database.prepare("DELETE FROM acquisition_jobs WHERE id = ?").run(id)
          .changes > 0,
    },
    reviews: {
      list: () =>
        listJson("SELECT json FROM acquisition_reviews ORDER BY created_at, id").map(
          (row) => parseReview(JSON.parse(row.json)),
        ),
      listByWanted: (wantedId) =>
        listJson(
          "SELECT json FROM acquisition_reviews WHERE wanted_id = ? ORDER BY created_at, id",
          wantedId,
        ).map((row) => parseReview(JSON.parse(row.json))),
      get: (id) =>
        parseJson(selectReview.get(id) as { json: string } | undefined, parseReview),
      save: (record) => {
        const validated = parseReview(record);
        upsertReview.run(reviewColumns(validated));
        return validated;
      },
      remove: (id) =>
        database.prepare("DELETE FROM acquisition_reviews WHERE id = ?").run(id)
          .changes > 0,
    },
    imports: {
      list: () =>
        listJson("SELECT json FROM completed_imports ORDER BY imported_at, id").map(
          (row) => parseImport(JSON.parse(row.json)),
        ),
      get: (id) =>
        parseJson(selectImport.get(id) as { json: string } | undefined, parseImport),
      findByEpisode: (seriesTitle, season, episode) =>
        parseJson(
          database
            .prepare("SELECT json FROM completed_imports WHERE episode_key = ?")
            .get(episodeKey(seriesTitle, season, episode)) as
            | { json: string }
            | undefined,
          parseImport,
        ),
      findByRemote: (provider, remoteItemId, remoteFileId) => {
        acquisitionProviderSchema.parse(provider);
        return parseJson(
          database
            .prepare(
              `SELECT json FROM completed_imports
               WHERE provider = ? AND remote_item_id = ? AND remote_file_id = ?`,
            )
            .get(provider, remoteItemId, remoteFileId) as
            | { json: string }
            | undefined,
          parseImport,
        );
      },
      record: (record) => {
        const validated = parseImport(record);
        assertEpisodeKeyMatchesWanted(validated.wantedId, validated.episodeKey);
        try {
          insertImport.run(importColumns(validated));
        } catch (error) {
          asConflict(
            error,
            `Provider item ${validated.remoteItemId} file ${validated.remoteFileId} was already imported`,
          );
        }
        return validated;
      },
      remove: (id) =>
        database.prepare("DELETE FROM completed_imports WHERE id = ?").run(id)
          .changes > 0,
    },
    transaction,
  };
}
