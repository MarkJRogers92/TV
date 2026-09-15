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
    acquisitions,
    completeAcquisitionImport,
    close: () => database.close(),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
