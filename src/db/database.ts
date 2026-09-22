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
