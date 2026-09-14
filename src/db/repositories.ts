import type { MarkTvDatabase } from "./database.js";
import type { Channel, MediaItem, Pool, Schedule } from "../domain/models.js";
import {
  channelSchema,
  mediaSchema,
  poolSchema,
  scheduleSchema,
} from "../domain/models.js";

function collection<T>(
  database: MarkTvDatabase,
  type: string,
  parse: (value: unknown) => T,
) {
  return {
    list: (): T[] =>
      database
        .prepare("SELECT json FROM documents WHERE type = ? ORDER BY id")
        .all(type)
        .map((row: unknown) =>
          parse(JSON.parse((row as { json: string }).json)),
        ),
    get: (id: string): T | undefined => {
      const row = database
        .prepare("SELECT json FROM documents WHERE type = ? AND id = ?")
        .get(type, id) as { json: string } | undefined;
      return row ? parse(JSON.parse(row.json)) : undefined;
    },
    put: (value: T & { id: string }) => {
      const validated = parse(value) as T & { id: string };
      return database
        .prepare(
          "INSERT OR REPLACE INTO documents(type, id, json) VALUES (?, ?, ?)",
        )
        .run(type, validated.id, JSON.stringify(validated));
    },
    remove: (id: string) =>
      database
        .prepare("DELETE FROM documents WHERE type = ? AND id = ?")
        .run(type, id),
    clear: () =>
      database.prepare("DELETE FROM documents WHERE type = ?").run(type),
  };
}

export function createRepositories(database: MarkTvDatabase) {
  const channels = collection<Channel>(database, "channel", (value) =>
    channelSchema.parse(value),
  );
  const media = collection<MediaItem>(database, "media", (value) =>
    mediaSchema.parse(value),
  );
  const pools = collection<Pool>(database, "pool", (value) =>
    poolSchema.parse(value),
  );
  const settings = collection<{ id: string; value: unknown }>(
    database,
    "setting",
    (value) => value as { id: string; value: unknown },
  );
  const parseSchedule = (row: { json: string } | undefined) =>
    row ? scheduleSchema.parse(JSON.parse(row.json)) : undefined;

  return {
    channels,
    media,
    pools,
    schedules: {
      latest: (channelId: string): Schedule | undefined =>
        parseSchedule(
          database
            .prepare(
              "SELECT json FROM schedule_generations WHERE channel_id = ? ORDER BY generation_id DESC LIMIT 1",
            )
            .get(channelId) as { json: string } | undefined,
        ),
      list: (channelId: string): Schedule[] =>
        database
          .prepare(
            "SELECT json FROM schedule_generations WHERE channel_id = ? ORDER BY generation_id",
          )
          .all(channelId)
          .map((row: unknown) =>
            scheduleSchema.parse(JSON.parse((row as { json: string }).json)),
          ),
      historyBefore: (channelId: string, date: string) =>
        database
          .prepare(
            "SELECT json FROM schedule_generations WHERE channel_id = ? ORDER BY generation_id",
          )
          .all(channelId)
          .map((row: unknown) =>
            scheduleSchema.parse(JSON.parse((row as { json: string }).json)),
          )
          .filter((schedule) => schedule.date < date)
          .flatMap((schedule) =>
            schedule.entries
              .filter((entry) => entry.kind !== "flex" && entry.mediaId)
              .map((entry) => ({ mediaId: entry.mediaId!, at: entry.start })),
          ),
      replaceSuccessful: (channelId: string, schedule: Schedule) => {
        const validated = scheduleSchema.parse(schedule);
        if (validated.channelId !== channelId)
          throw new Error("Schedule channel does not match repository channel");
        database.transaction(() =>
          database
            .prepare(
              "INSERT INTO schedule_generations(channel_id, schedule_id, generated_at, json) VALUES (?, ?, ?, ?)",
            )
            .run(
              channelId,
              validated.id,
              validated.generatedAt,
              JSON.stringify(validated),
            ),
        )();
      },
    },
    settings: {
      get: settings.get,
      list: settings.list,
      put: (id: string, value: unknown) => settings.put({ id, value }),
      remove: (id: string) =>
        database
          .prepare("DELETE FROM documents WHERE type = ? AND id = ?")
          .run("setting", id),
    },
    transaction: <T>(operation: () => T): T =>
      database.transaction(operation)(),
    close: () => database.close(),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
