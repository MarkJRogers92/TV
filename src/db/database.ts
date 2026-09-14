import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type MarkTvDatabase = Database.Database;

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
  `);

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
