import type { MarkTvDatabase } from "./database.js";
import { AcquisitionConflictError, AcquisitionReferenceError, createAcquisitionRepository } from "../acquisition/repository.js";
import { acquisitionJobSchema, completedImportSchema, episodeKey, wantedEpisodeSchema, type AcquisitionJob, type CompletedImport } from "../acquisition/models.js";
import { basename } from "node:path";
import type { Channel, MediaItem, Pool, Schedule } from "../domain/models.js";
import {
  channelSchema,
  mediaSchema,
  poolSchema,
  scheduleSchema,
} from "../domain/models.js";
import {
  movieOccurrenceSchema,
  movieRotationSchema,
  type MovieOccurrence,
  type MoviePosition,
  type MovieRotationRecord,
} from "../domain/movieProgramming.js";
import { createPreparationRepository } from "../preparation/repository.js";

export type AcquisitionImportCompletion = {
  media: MediaItem;
  completedImport: CompletedImport;
  importedJob: AcquisitionJob;
};

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

/**
 * Retention for stored schedule generations.
 *
 * Nothing previously ever deleted from `schedule_generations`, and `historyBefore`
 * reads every row for a channel and parses each one, so an unattended install grew
 * the table - and the cost of that call - without limit.
 *
 * Counted rather than time-based: a count cannot be defeated by the scheduler
 * running more often than expected, which is exactly the case that would make a
 * time window grow. The limit is generous (roughly a quarter of daily generations)
 * because history exists to stop recently-aired content repeating, and pruning too
 * aggressively would cause that. Mutable so tests can shrink it.
 */
export const scheduleLimits = {
  historyPerChannel: 90,
};

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
  const acquisitions = createAcquisitionRepository(database);
  const preparation = createPreparationRepository(database);

  const completeAcquisitionImport = (input: AcquisitionImportCompletion): CompletedImport =>
    database.transaction(() => {
      const media = mediaSchema.parse(input.media);
      const completed = completedImportSchema.parse(input.completedImport);
      const imported = acquisitionJobSchema.parse(input.importedJob);
      if (imported.state !== "imported")
        throw new AcquisitionReferenceError("Completion job must be imported");
      if (
        imported.wantedId !== completed.wantedId ||
        imported.episodeKey !== completed.episodeKey ||
        imported.provider !== completed.provider ||
        imported.remoteItemId !== completed.remoteItemId ||
        imported.remoteFileId !== completed.remoteFileId ||
        imported.destinationPath !== completed.destinationPath ||
        media.id !== completed.mediaId ||
        media.path !== completed.destinationPath
      ) throw new AcquisitionReferenceError("Completion records do not share one import identity");
      if (
        completed.canonicalName !== basename(completed.destinationPath) ||
        media.source !== "local-folder" || media.kind !== "episode" || !media.available ||
        !media.showTitle || media.season === undefined || media.episode === undefined ||
        episodeKey(media.showTitle, media.season, media.episode) !== completed.episodeKey
      ) throw new AcquisitionReferenceError("Completion media is not canonical episode media");

      const currentJobRow = database.prepare("SELECT json FROM acquisition_jobs WHERE id = ?").get(imported.id) as { json: string } | undefined;
      if (!currentJobRow) throw new AcquisitionReferenceError("Completion job does not exist");
      const currentJob = acquisitionJobSchema.parse(JSON.parse(currentJobRow.json));
      if (
        currentJob.wantedId !== imported.wantedId || currentJob.episodeKey !== imported.episodeKey ||
        currentJob.provider !== imported.provider || currentJob.remoteItemId !== imported.remoteItemId || currentJob.remoteFileId !== imported.remoteFileId
      ) throw new AcquisitionReferenceError("Completion cannot change a job identity");

      const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      const semanticLedgerEqual = (left: CompletedImport, right: CompletedImport) =>
        left.wantedId === right.wantedId && left.episodeKey === right.episodeKey &&
        left.provider === right.provider && left.remoteItemId === right.remoteItemId &&
        left.remoteFileId === right.remoteFileId && left.mediaId === right.mediaId &&
        left.canonicalName === right.canonicalName && left.destinationPath === right.destinationPath;

      const episodeRow = database.prepare("SELECT json FROM completed_imports WHERE episode_key = ?").get(completed.episodeKey) as { json: string } | undefined;
      const remoteRow = database.prepare("SELECT json FROM completed_imports WHERE provider = ? AND remote_item_id = ? AND remote_file_id = ?").get(completed.provider, completed.remoteItemId, completed.remoteFileId) as { json: string } | undefined;
      const episodeLedger = episodeRow ? completedImportSchema.parse(JSON.parse(episodeRow.json)) : undefined;
      const remoteLedger = remoteRow ? completedImportSchema.parse(JSON.parse(remoteRow.json)) : undefined;
      if (episodeLedger && remoteLedger && episodeLedger.id !== remoteLedger.id)
        throw new AcquisitionConflictError("Episode and provider identity point to different completion rows");
      const existingLedger = episodeLedger ?? remoteLedger;
      if (existingLedger && !semanticLedgerEqual(existingLedger, completed))
        throw new AcquisitionConflictError("Episode or provider item/file is already imported");

      if (existingLedger) {
        if (currentJob.state !== "imported" || imported.state !== "imported")
          throw new AcquisitionReferenceError("Only an imported job can replay a completion ledger");
        const replayMedia = database.prepare("SELECT json FROM documents WHERE type = 'media' AND id = ?").get(existingLedger.mediaId) as { json: string } | undefined;
        if (!replayMedia || !same(mediaSchema.parse(JSON.parse(replayMedia.json)), media))
          throw new AcquisitionConflictError("Completion ledger media does not exactly match stored media");
        return existingLedger;
      }

      if (
        currentJob.state !== "placing" || currentJob.cancelRequested || imported.cancelRequested ||
        currentJob.partPath === null || imported.partPath === null ||
        currentJob.destinationPath !== imported.destinationPath || currentJob.partPath !== imported.partPath ||
        currentJob.expectedBytes !== imported.expectedBytes || currentJob.receivedBytes !== imported.receivedBytes ||
        !currentJob.verifiedSha256 || currentJob.verifiedSha256 !== imported.verifiedSha256
      ) throw new AcquisitionReferenceError("First completion must continue one uncancelled placing job");

      const wantedRow = database.prepare("SELECT json FROM wanted_episodes WHERE id = ?").get(completed.wantedId) as { json: string } | undefined;
      if (wantedRow) {
        const wanted = wantedEpisodeSchema.parse(JSON.parse(wantedRow.json));
        if (wanted.status !== "placing" || episodeKey(wanted.seriesTitle, wanted.season, wanted.episode) !== completed.episodeKey)
          throw new AcquisitionReferenceError("Wanted episode does not own completion identity");
      } else throw new AcquisitionReferenceError("First completion requires its Wanted episode");

      const mediaRows = database.prepare("SELECT id, json FROM documents WHERE type = 'media'").all() as Array<{ id: string; json: string }>;
      const existingMedia = mediaRows.find((row) => row.id === media.id);
      const pathOwner = mediaRows.map((row) => mediaSchema.parse(JSON.parse(row.json))).find((candidate) => candidate.path === media.path && candidate.id !== media.id);
      if (pathOwner || (existingMedia && !same(mediaSchema.parse(JSON.parse(existingMedia.json)), media)))
        throw new AcquisitionConflictError("Media id or destination path already belongs to different media");

      if (!existingMedia)
        database.prepare("INSERT INTO documents(type, id, json) VALUES ('media', ?, ?)").run(media.id, JSON.stringify(media));
      database.prepare(`INSERT INTO completed_imports (id, wanted_id, episode_key, provider, remote_item_id, remote_file_id, imported_at, json)
          VALUES (@id, @wantedId, @episodeKey, @provider, @remoteItemId, @remoteFileId, @importedAt, @json)`).run({
          id: completed.id, wantedId: completed.wantedId, episodeKey: completed.episodeKey, provider: completed.provider,
          remoteItemId: completed.remoteItemId, remoteFileId: completed.remoteFileId, importedAt: completed.importedAt, json: JSON.stringify(completed),
        });
      database.prepare("UPDATE acquisition_jobs SET state = ?, updated_at = ?, json = ? WHERE id = ?").run(imported.state, imported.updatedAt, JSON.stringify(imported), imported.id);
      // Direct statements stay inside this outer transaction; do not invoke
      // wanted.remove(), which would open another public transaction.
      // A season-pack offer is durable: its `wanted_id` is only the anchor
      // episode that first surfaced the pack, so importing that episode must
      // not consume a manual Import Season offer for the rest of the pack.
      database.prepare("DELETE FROM acquisition_reviews WHERE wanted_id = ? AND kind <> 'season-pack'").run(completed.wantedId);
      database.prepare("DELETE FROM wanted_episodes WHERE id = ?").run(completed.wantedId);
      return completed;
    })();

  return {
    channels,
    media,
    pools,
    schedules: {
      /**
       * The most recently WRITTEN schedule - insertion order, not broadcast order.
       *
       * These are not the same question. The quiet-hours pass writes TOMORROW's
       * schedule into this table, so immediately afterwards the newest row is not
       * today's. Anything that means "the schedule for a given day" must ask by
       * date; `latest` is only right for "whatever was generated most recently".
       */
      latest: (channelId: string): Schedule | undefined =>
        parseSchedule(
          database
            .prepare(
              "SELECT json FROM schedule_generations WHERE channel_id = ? ORDER BY generation_id DESC LIMIT 1",
            )
            .get(channelId) as { json: string } | undefined,
        ),
      /**
       * The newest schedule generated for one specific broadcast date.
       *
       * This is the question the refresh actually means to ask. Asking it with
       * `latest` is what made the refresh regenerate a schedule it already had:
       * pre-generating tomorrow moved `latest` off today, so the next pass read
       * tomorrow's row, concluded today was missing, and rebuilt it - which moved
       * `latest` back to today, so the pass after that rebuilt tomorrow again.
       * Filters on the schedule's own `date` field, since the table stores the
       * schedule as a document with no date column.
       */
      latestForDate: (channelId: string, date: string): Schedule | undefined =>
        parseSchedule(
          database
            .prepare(
              "SELECT json FROM schedule_generations WHERE channel_id = ? AND json_extract(json, '$.date') = ? ORDER BY generation_id DESC LIMIT 1",
            )
            .get(channelId, date) as { json: string } | undefined,
        ),
      /** A specific generation, so a sync can be aimed at the schedule it means. */
      byId: (channelId: string, scheduleId: string): Schedule | undefined =>
        parseSchedule(
          database
            .prepare(
              "SELECT json FROM schedule_generations WHERE channel_id = ? AND schedule_id = ? ORDER BY generation_id DESC LIMIT 1",
            )
            .get(channelId, scheduleId) as { json: string } | undefined,
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
      /**
       * Drops the stored schedules for broadcast dates AFTER `date`.
       *
       * The quiet-hours pass pre-generates tomorrow, so a configuration change
       * leaves a stored future day that plans the old programming. Rebuilding it
       * is the fix; deleting it is what makes the rebuild happen. Scoped to dates
       * strictly after the caller's cutoff, so the day being broadcast right now
       * - and every day already aired - is untouched.
       */
      removeAfterDate: (channelId: string, date: string): number =>
        database
          .prepare(
            "DELETE FROM schedule_generations WHERE channel_id = ? AND json_extract(json, '$.date') > ?",
          )
          .run(channelId, date).changes,
      /**
       * What actually aired on the broadcast dates before `date`.
       *
       * Only the newest generation of each prior date counts. A date is
       * routinely generated more than once - a media rescan, a configuration
       * edit, or the quiet-hours pass replacing a schedule it already wrote -
       * and a regeneration supersedes the schedule it replaced rather than
       * adding a second airing of the same window. Counting the superseded rows
       * as well double-counts every slot they shared, which is not merely
       * wasteful: selection walks its chronological cursor forward from the
       * newest play, so a superseded generation that ended earlier in a series
       * drags that cursor backwards and the next day replays episodes that
       * already aired.
       *
       * Rows are ordered by `generation_id`, so the last row seen for a date is
       * that date's newest generation.
       */
      historyBefore: (channelId: string, date: string) => {
        const rows = database
          .prepare(
            "SELECT json FROM schedule_generations WHERE channel_id = ? ORDER BY generation_id",
          )
          .all(channelId) as Array<{ json: string }>;
        const newestPerDate = new Map<string, Schedule>();
        for (const row of rows) {
          const schedule = scheduleSchema.parse(JSON.parse(row.json));
          if (schedule.date >= date) continue;
          newestPerDate.set(schedule.date, schedule);
        }
        return [...newestPerDate.values()].flatMap((schedule) =>
          schedule.entries
            .filter((entry) => entry.kind !== "flex" && entry.mediaId)
            .map((entry) => ({ mediaId: entry.mediaId!, at: entry.start })),
        );
      },
      replaceSuccessful: (channelId: string, schedule: Schedule) => {
        const validated = scheduleSchema.parse(schedule);
        if (validated.channelId !== channelId)
          throw new Error("Schedule channel does not match repository channel");
        database.transaction(() => {
          database
            .prepare(
              "INSERT INTO schedule_generations(channel_id, schedule_id, generated_at, json) VALUES (?, ?, ?, ?)",
            )
            .run(
              channelId,
              validated.id,
              validated.generatedAt,
              JSON.stringify(validated),
            );
          // Pruned in the same transaction as the insert, so the table can never
          // be observed holding more than the limit. Uses the existing
          // (channel_id, generation_id DESC) index.
          database
            .prepare(
              `DELETE FROM schedule_generations
               WHERE channel_id = ?
                 AND generation_id NOT IN (
                   SELECT generation_id FROM schedule_generations
                   WHERE channel_id = ?
                   ORDER BY generation_id DESC
                   LIMIT ?
                 )`,
            )
            .run(channelId, channelId, scheduleLimits.historyPerChannel);
        })();
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
      /**
       * Drops the least recently inserted entries under a prefix.
       *
       * The episode-break cache is keyed by content identity - path, size, mtime,
       * dev/ino and policy - so every re-import or changed file mints a NEW entry,
       * and nothing ever removed them. An install that re-imports media therefore
       * grew the `documents` table without bound, and `settings.list()` scans more
       * rows for every caller.
       *
       * Ordered by rowid because `documents` has no timestamp column. For these
       * entries insertion order is a good enough stand-in for recency precisely
       * because a changed file produces a new key rather than updating an old one.
       *
       * `prefix` is a literal, not a LIKE pattern: it is interpolated with `%`
       * appended, so it must not contain `%` or `_`.
       */
      pruneByPrefix: (prefix: string, keep: number) =>
        database
          .prepare(
            `DELETE FROM documents
             WHERE type = 'setting'
               AND id LIKE ?
               AND rowid NOT IN (
                 SELECT rowid FROM documents
                 WHERE type = 'setting' AND id LIKE ?
                 ORDER BY rowid DESC
                 LIMIT ?
               )`,
          )
          .run(`${prefix}%`, `${prefix}%`, keep),
    },
    /**
     * The movie-programming feature's rotation bag, one row per channel.
     *
     * Kept out of `documents` because it is read on every generation and written
     * only when the eligible movie set changes.
     */
    movieRotations: {
      get: (channelId: string): MovieRotationRecord | undefined => {
        const row = database
          .prepare("SELECT json FROM movie_rotation WHERE channel_id = ?")
          .get(channelId) as { json: string } | undefined;
        return row ? movieRotationSchema.parse(JSON.parse(row.json)) : undefined;
      },
      put: (rotation: MovieRotationRecord): MovieRotationRecord => {
        const validated = movieRotationSchema.parse(rotation);
        database
          .prepare(
            "INSERT OR REPLACE INTO movie_rotation(channel_id, updated_at, json) VALUES (?, ?, ?)",
          )
          .run(validated.channelId, validated.updatedAt, JSON.stringify(validated));
        return validated;
      },
      remove: (channelId: string) =>
        database
          .prepare("DELETE FROM movie_rotation WHERE channel_id = ?")
          .run(channelId),
    },
    /**
     * Dated movie assignments, including the encores that reuse an earlier one.
     *
     * Written once per (channel, date, position) and never rewritten, so a
     * preview, a rescan or a restart reads the same assignment instead of
     * consuming the rotation a second time.
     */
    movieOccurrences: {
      get: (
        channelId: string,
        date: string,
        position: MoviePosition,
      ): MovieOccurrence | undefined => {
        const row = database
          .prepare(
            "SELECT json FROM movie_occurrences WHERE channel_id = ? AND broadcast_date = ? AND position = ?",
          )
          .get(channelId, date, position) as { json: string } | undefined;
        return row
          ? movieOccurrenceSchema.parse(JSON.parse(row.json))
          : undefined;
      },
      listForDate: (channelId: string, date: string): MovieOccurrence[] =>
        database
          .prepare(
            "SELECT json FROM movie_occurrences WHERE channel_id = ? AND broadcast_date = ? ORDER BY position",
          )
          .all(channelId, date)
          .map((row: unknown) =>
            movieOccurrenceSchema.parse(
              JSON.parse((row as { json: string }).json),
            ),
          ),
      listForChannel: (channelId: string): MovieOccurrence[] =>
        database
          .prepare(
            "SELECT json FROM movie_occurrences WHERE channel_id = ? ORDER BY broadcast_date, position",
          )
          .all(channelId)
          .map((row: unknown) =>
            movieOccurrenceSchema.parse(
              JSON.parse((row as { json: string }).json),
            ),
          ),
      put: (occurrence: MovieOccurrence): MovieOccurrence => {
        const validated = movieOccurrenceSchema.parse(occurrence);
        database
          .prepare(
            `INSERT OR REPLACE INTO movie_occurrences(channel_id, broadcast_date, position, json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            validated.channelId,
            validated.date,
            validated.position,
            JSON.stringify(validated),
          );
        return validated;
      },
      /**
       * Drops the assignments for broadcast dates AFTER `date`.
       *
       * A movie-programming change rewrites the future - a new anchor, a different
       * pool, the feature switched off - so future assignments derived from the old
       * configuration are stale even though the rotation they came from is not.
       * Aired and currently-airing dates are left exactly as they were.
       */
      removeAfterDate: (channelId: string, date: string): number =>
        database
          .prepare(
            "DELETE FROM movie_occurrences WHERE channel_id = ? AND broadcast_date > ?",
          )
          .run(channelId, date).changes,
    },
    transaction: <T>(operation: () => T): T =>
      database.transaction(operation)(),
    acquisitions,
    preparation,
    completeAcquisitionImport,
    close: () => database.close(),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
