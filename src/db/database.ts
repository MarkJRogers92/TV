import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type MarkTvDatabase = Database.Database;

/**
 * Canonical `remote_identity_guard` value for one provider/item/file identity.
 * It is stored next to a job row so SQLite's UNIQUE index sees at most one
 * enforced row per remote identity.
 */
export function remoteIdentityGuard(
  provider: string,
  remoteItemId: string,
  remoteFileId: string,
): string {
  return [provider, remoteItemId, remoteFileId].join("\u001f");
}

function migrate(database: MarkTvDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY(type, id)
    );
    CREATE TABLE IF NOT EXISTS schedule_generations (
      generation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_generations_channel_latest
      ON schedule_generations(channel_id, generation_id DESC);
    CREATE TABLE IF NOT EXISTS wanted_episodes (
      id TEXT PRIMARY KEY,
      episode_key TEXT NOT NULL,
      series_title TEXT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS wanted_episodes_episode_identity
      ON wanted_episodes(episode_key);
    CREATE INDEX IF NOT EXISTS wanted_episodes_status
      ON wanted_episodes(status);
    CREATE TABLE IF NOT EXISTS wanted_movies (
      id TEXT PRIMARY KEY,
      movie_key TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS wanted_movies_movie_identity
      ON wanted_movies(movie_key);
    CREATE INDEX IF NOT EXISTS wanted_movies_status
      ON wanted_movies(status);
    CREATE TABLE IF NOT EXISTS acquisition_jobs (
      id TEXT PRIMARY KEY,
      wanted_id TEXT NOT NULL,
      episode_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_item_id TEXT NOT NULL,
      remote_file_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      remote_identity_guard TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS acquisition_jobs_wanted
      ON acquisition_jobs(wanted_id);
    CREATE INDEX IF NOT EXISTS acquisition_jobs_state
      ON acquisition_jobs(state);
    CREATE TABLE IF NOT EXISTS acquisition_reviews (
      id TEXT PRIMARY KEY,
      wanted_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS acquisition_reviews_wanted
      ON acquisition_reviews(wanted_id);
    CREATE TABLE IF NOT EXISTS preparation_intakes (
      id TEXT PRIMARY KEY,
      source_media_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_version_key TEXT NOT NULL,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      observation_count INTEGER NOT NULL,
      settled_at TEXT,
      json TEXT NOT NULL,
      UNIQUE(source_media_id, source_version_key)
    );
    CREATE INDEX IF NOT EXISTS preparation_intakes_source
      ON preparation_intakes(source_media_id, first_observed_at);
    CREATE TABLE IF NOT EXISTS preparation_jobs (
      id TEXT PRIMARY KEY,
      intake_id TEXT NOT NULL,
      source_media_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_version_key TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      UNIQUE(intake_id)
    );
    CREATE INDEX IF NOT EXISTS preparation_jobs_queue
      ON preparation_jobs(state, created_at, id);
    CREATE INDEX IF NOT EXISTS preparation_jobs_source
      ON preparation_jobs(source_media_id, source_version_key);
    CREATE TABLE IF NOT EXISTS completed_imports (
      id TEXT PRIMARY KEY,
      wanted_id TEXT NOT NULL,
      episode_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_item_id TEXT NOT NULL,
      remote_file_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS completed_imports_episode_identity
      ON completed_imports(episode_key);
    CREATE UNIQUE INDEX IF NOT EXISTS completed_imports_remote_identity
      ON completed_imports(provider, remote_item_id, remote_file_id);
    /*
     * Movie programming state.
     *
     * Its own tables rather than rows in the documents table, because both are
     * read by exact key on the generation path and the occurrence ledger grows
     * one row per airing forever - the assignments are the audit trail that
     * proves a rescan cannot silently re-shuffle what already aired.
     */
    CREATE TABLE IF NOT EXISTS movie_rotation (
      channel_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS movie_occurrences (
      channel_id TEXT NOT NULL,
      broadcast_date TEXT NOT NULL,
      position TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY(channel_id, broadcast_date, position)
    );
    CREATE INDEX IF NOT EXISTS movie_occurrences_channel_date
      ON movie_occurrences(channel_id, broadcast_date);
  `);

  /*
   * Durable airing ledger (Stage 1, additive).
   *
   * These tables are the only durable record of what MarkTV actually published
   * and aired. They are deliberately separate from `schedule_generations` and
   * from Tunarr's play history, both of which record planning/calculation rather
   * than a completed airing, and they are created with IF NOT EXISTS only so an
   * existing database keeps every row it already holds.
   *
   * `airing_series_tracks` and `airing_episode_identities` give a series and its
   * episodes a stable identity that survives a respelled filename. A series is
   * one logical track shared by every channel that airs it, so two channels
   * contend for one completion floor; `track_scope` carries an explicit
   * discriminator only when a caller intentionally wants a separate track.
   * `airing_occurrence_reservations` reserves one airing of one episode;
   * `airing_occurrence_attempts` records playout attempts;
   * `airing_published_source_intervals` and `airing_aired_source_intervals`
   * record, in source coordinates, the contiguous spans the publisher emitted
   * and the spans an explicit aired observation saw. `airing_active_occurrences`
   * keeps the in-progress occurrence and its source offset so a restart resumes
   * the same position. `airing_completion_floors` holds the monotonic per-track
   * high-water mark. `airing_track_holds` records a track whose position is
   * missing or ambiguous so it is held rather than reset.
   */
  database.exec(`
    CREATE TABLE IF NOT EXISTS airing_series_tracks (
      track_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      series_key TEXT NOT NULL,
      track_scope TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS airing_episode_identities (
      episode_key TEXT PRIMARY KEY,
      track_key TEXT NOT NULL,
      title TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      ordinal INTEGER,
      position_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS airing_episode_identities_track
      ON airing_episode_identities(track_key);
    CREATE UNIQUE INDEX IF NOT EXISTS airing_episode_identities_position
      ON airing_episode_identities(track_key, position_key);
    CREATE TABLE IF NOT EXISTS airing_track_holds (
      track_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      detail TEXT,
      occurrence_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS airing_occurrence_reservations (
      occurrence_key TEXT PRIMARY KEY,
      track_key TEXT NOT NULL,
      episode_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      broadcast_date TEXT,
      planned_start TEXT NOT NULL,
      planned_end TEXT NOT NULL,
      source_media_id TEXT NOT NULL,
      source_start_ms INTEGER NOT NULL,
      source_end_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS airing_occurrence_reservations_track
      ON airing_occurrence_reservations(track_key, state);
    CREATE TABLE IF NOT EXISTS airing_occurrence_attempts (
      attempt_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL,
      attempt_index INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      outcome TEXT NOT NULL,
      source_offset_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS airing_occurrence_attempts_index
      ON airing_occurrence_attempts(occurrence_key, attempt_index);
    CREATE TABLE IF NOT EXISTS airing_published_source_intervals (
      interval_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL,
      attempt_id TEXT,
      source_media_id TEXT NOT NULL,
      source_start_ms INTEGER NOT NULL,
      source_end_ms INTEGER NOT NULL,
      published_at TEXT NOT NULL,
      evidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS airing_published_source_intervals_occurrence
      ON airing_published_source_intervals(occurrence_key, source_start_ms);
    CREATE TABLE IF NOT EXISTS airing_aired_source_intervals (
      interval_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL,
      attempt_id TEXT,
      source_media_id TEXT NOT NULL,
      source_start_ms INTEGER NOT NULL,
      source_end_ms INTEGER NOT NULL,
      aired_at TEXT NOT NULL,
      evidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS airing_aired_source_intervals_occurrence
      ON airing_aired_source_intervals(occurrence_key, source_start_ms);
    CREATE TABLE IF NOT EXISTS airing_active_occurrences (
      track_key TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL,
      attempt_id TEXT,
      source_media_id TEXT NOT NULL,
      source_offset_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      interrupted_at TEXT,
      resumed_at TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS airing_completion_floors (
      track_key TEXT PRIMARY KEY,
      season INTEGER,
      episode INTEGER,
      ordinal INTEGER,
      position_key TEXT NOT NULL,
      completed_episode_key TEXT NOT NULL,
      completed_occurrence_key TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
  `);

  /*
   * One logical series track now serves every channel, so uniqueness moved from
   * `(channel_id, series_key)` to `(series_key, track_scope)`, where an empty
   * scope is the shared default track. `track_scope` is added in place for a
   * database that already created the earlier Stage 1 shape; no rows are moved
   * or rewritten, so existing progress (including any channel-scoped rows)
   * stays exactly as recorded. The superseded channel-scoped index is dropped
   * only because it would otherwise reject a legitimate second channel sharing
   * the same series.
   */
  const seriesTrackColumns = database.pragma("table_info(airing_series_tracks)") as Array<{
    name: string;
  }>;
  if (!seriesTrackColumns.some((column) => column.name === "track_scope")) {
    database.exec(
      "ALTER TABLE airing_series_tracks ADD COLUMN track_scope TEXT NOT NULL DEFAULT ''",
    );
  }
  database.transaction(() => {
    database.exec("DROP INDEX IF EXISTS airing_series_tracks_identity;");
    const duplicates = database
      .prepare(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM airing_series_tracks GROUP BY series_key, track_scope HAVING COUNT(*) > 1)",
      )
      .get() as { count: number };
    if (duplicates.count > 0) {
      throw new Error("airing series tracks have duplicate logical identities; reconcile copied state before migration");
    }
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS airing_series_tracks_logical ON airing_series_tracks(series_key, track_scope);",
    );
  })();

  const jobColumns = database.pragma("table_info(acquisition_jobs)") as Array<{
    name: string;
  }>;
  if (!jobColumns.some((column) => column.name === "remote_identity_guard")) {
    database.exec(
      "ALTER TABLE acquisition_jobs ADD COLUMN remote_identity_guard TEXT",
    );
  }

  // One provider item/file pair owns at most one job row, but the original
  // schema indexed those columns without UNIQUE, so an existing database can
  // already hold duplicate rows. A plain UNIQUE index cannot be built over
  // them and deleting them would destroy audit data, so uniqueness is enforced
  // through the nullable `remote_identity_guard` column instead: SQLite treats
  // NULLs as distinct, so historical duplicates stay NULL and survive, while
  // every row whose identity is known to be unique carries its canonical
  // identity and is therefore limited to one row. Rows that are already
  // duplicated keep NULL rather than fabricating a winner.
  database.transaction(() => {
    database.exec(`
      DROP INDEX IF EXISTS acquisition_jobs_remote_identity;
      DROP INDEX IF EXISTS acquisition_jobs_remote_identity_unique;
      UPDATE acquisition_jobs
         SET remote_identity_guard =
             provider || char(31) || remote_item_id || char(31) || remote_file_id
       WHERE remote_identity_guard IS NULL
         AND id IN (
           SELECT id FROM acquisition_jobs
            GROUP BY provider, remote_item_id, remote_file_id
           HAVING COUNT(*) = 1
         );
      CREATE UNIQUE INDEX IF NOT EXISTS acquisition_jobs_remote_identity_unique
        ON acquisition_jobs(remote_identity_guard);
    `);
  })();

  database.transaction(() => {
    const legacy = database.prepare("SELECT json FROM documents WHERE type = 'schedule' ORDER BY rowid").all() as Array<{ json: string }>;
    const insert = database.prepare('INSERT INTO schedule_generations(channel_id, schedule_id, generated_at, json) VALUES (?, ?, ?, ?)');
    for (const row of legacy) {
      const value = JSON.parse(row.json) as { id: string; channelId: string; generatedAt: string };
      insert.run(value.channelId, value.id, value.generatedAt, row.json);
    }
    if (legacy.length) database.prepare("DELETE FROM documents WHERE type = 'schedule'").run();
  })();
}

export function openDatabase(dataDir: string): MarkTvDatabase {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, 'marktv.sqlite'));
  migrate(database);
  return database;
}
