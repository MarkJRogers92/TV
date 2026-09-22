#!/usr/bin/env -S npx tsx
import { basename, dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DateTime } from "luxon";
import type { MediaItem, Schedule } from "../src/domain/models.js";
import { parseGeneratedContinuityTags } from "../src/continuity/assets.js";
import { inspectCanonicalLogo } from "../src/continuity/branding.js";
import { readContinuityHistoryForPlanning } from "../src/continuity/history.js";
import { runFfmpeg, selectFfmpegBinary } from "../src/continuity/offline.js";
import { prepareContinuityMedia } from "../src/continuity/prepare.js";
import { applyContinuityToSchedule } from "../src/continuity/publish.js";
import { readContinuityConfig } from "../src/continuity/status.js";
import {
  parseArgs,
  verifyExactTiming,
  writeManifest,
} from "./support/continuityOffline.js";
import { openReadOnlyRepositories } from "./support/continuityDatabase.js";

/**
 * Offline real-day verifier.
 *
 * Point it at a COPY of the live SQLite file (never the live file, never a
 * running service). It runs the *actual* automatic pipeline - the same
 * `prepareContinuityMedia` the schedule service calls, then the same
 * `applyContinuityToSchedule` - against the stored schedule, writing every
 * rendered card into its own temp output directory instead of the library, and
 * registering nothing. It then proves the applied schedule keeps every
 * editorial airing and every break byte-identical and saves the real rendered
 * frames plus MP4s plus a manifest for human review. It makes no network call
 * and never syncs Tunarr.
 */
const { values, required } = parseArgs(process.argv.slice(2));
const databasePath = resolve(required("db"));
const output = resolve(required("out"));
const repoRoot = resolve(values.get("repo-root") ?? ".");
const channelId = values.get("channel") ?? "marktv-laughs";
const ffmpeg = values.get("ffmpeg") ?? (await selectFfmpegBinary());
const ffprobe = values.get("ffprobe") ?? "ffprobe";
const font = values.get("font") ?? "font=Arial";
const now = values.get("now") ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(now))) throw new Error("--now must be an ISO instant");
if (!ffmpeg)
  throw new Error(
    "No installed ffmpeg build can render card text; pass --ffmpeg <path> to one that has drawtext",
  );

  const framesDir = join(output, "frames");
  const cardsDir = join(output, "cards");

const { repositories, close } = openReadOnlyRepositories(databasePath);
try {
  const channel = repositories.channels.get(channelId);
  if (!channel) throw new Error(`Channel ${channelId} is not in ${basename(databasePath)}`);
  const date =
    values.get("date") ??
    DateTime.fromISO(now, { setZone: true }).setZone(channel.timezone).toISODate();
  if (!date) throw new Error("Could not resolve a broadcast date");
  const schedule = repositories.schedules.latestForDate(channel.id, date);
  if (!schedule)
    throw new Error(
      `No completed schedule for ${channel.id} on ${date}; generate it before verifying continuity`,
    );
  const media = repositories.media.list();
  const storedConfig = readContinuityConfig(repositories, channel.id);
  // The verifier evaluates the director as if it were switched on, because the
  // snapshot may record the operator's off choice; the stored value is reported
  // separately and never changed.
  const config = { ...storedConfig, enabled: true };
  const history = readContinuityHistoryForPlanning(repositories, channel.id, {
    before: now,
    excludeScheduleRevision: schedule.id,
  });
  const previousDate = DateTime.fromISO(date, { zone: channel.timezone })
    .minus({ days: 1 })
    .toISODate();
  const previous = previousDate
    ? repositories.schedules.latestForDate(channel.id, previousDate)
    : undefined;
  const adjacentSchedules: Schedule[] = previous ? [previous] : [];
  const pools = repositories.pools.list();

  const prepared = await prepareContinuityMedia({
    repositories,
    channel,
    schedule,
    media,
    pools,
    config,
    history,
    adjacentSchedules,
    repoRoot,
    outputRoot: cardsDir,
    // The snapshot database is opened read-only and query_only; registration is
    // deliberately off so the run cannot write live state.
    register: false,
    ffmpeg,
    ffprobe,
    font,
    now: new Date(now),
    log: (message) => console.log(message),
  });

  const applied = applyContinuityToSchedule({
    schedule,
    media: prepared.media,
    config,
    history,
    environment: {
      channel,
      pools,
      fillerHistory: repositories.schedules.historyBefore(channel.id, date),
      adjacentSchedules,
    },
  });
  const timing = verifyExactTiming(schedule, applied.schedule);
  const branding = await inspectCanonicalLogo(repoRoot);

  // A frame extracted from the *actual* rendered MP4, so the reviewed still and
  // the delivery file are the same visual.
  await mkdir(framesDir, { recursive: true });
  const frames: Array<{ mediaId: string; path: string }> = [];
  for (const item of prepared.prepared) {
    if (!item.path) continue;
    const framePath = join(framesDir, `${basename(item.path).replace(/\.mp4$/u, "")}.png`);
    try {
      await runFfmpeg(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-i",
        item.path,
        "-frames:v",
        "1",
        "-update",
        "1",
        framePath,
      ]);
      frames.push({ mediaId: item.id, path: framePath });
    } catch (error) {
      console.warn(
        `Could not extract a frame for ${item.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const describeCard = (item: MediaItem) => {
    const metadata = parseGeneratedContinuityTags(item.tags);
    return {
      mediaId: item.id,
      path: item.path,
      durationMs: item.durationMs,
      cardType: metadata?.cardType ?? null,
      family: metadata?.family ?? null,
      contentHash: metadata?.contentHash ?? null,
      targetAiringIds: metadata?.targetAiringIds ?? [],
    };
  };

  // The stored schedule may already carry cards from an earlier generation (the
  // parent's snapshot does). "Inserted" therefore means an entry this run added,
  // not every continuity-sourced entry in the resulting lineup.
  const originalEntryIds = new Set(schedule.entries.map((entry) => entry.id));
  const insertedEntries = applied.schedule.entries.filter(
    (entry) => entry.source?.startsWith("continuity:") && !originalEntryIds.has(entry.id),
  );

  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    purpose:
      "offline verification of the automatic continuity prepare+apply pipeline on one real broadcast day; no live writes, no sync",
    source: {
      database: basename(databasePath),
      databaseDirectory: dirname(databasePath),
      channelId: channel.id,
      channelName: channel.name,
      timezone: channel.timezone,
      broadcastDate: date,
      scheduleId: schedule.id,
      scheduleRevision: schedule.revision,
      contentHash: applied.contentHash,
      insertionInstant: now,
      storedEnabled: storedConfig.enabled,
      storedSettings: storedConfig,
      planningHistoryEntries: history.length,
      adjacentScheduleIds: adjacentSchedules.map((item) => item.id),
    },
    schedule: {
      entries: schedule.entries.length,
      durationMs: schedule.durationMs,
      editorialEntries: schedule.entries.filter(
        (entry) => entry.kind === "episode" || entry.kind === "movie",
      ).length,
    },
    prepare: {
      outputRoot: prepared.outputRoot,
      prepared: prepared.prepared.map(describeCard),
      diagnostics: prepared.diagnostics,
    },
    applied: {
      plannedCards: applied.planned,
      insertedCards: applied.decisions.length,
      insertions: applied.decisions.map((decision) => ({
        assetId: decision.assetId,
        cardType: decision.cardType,
        family: decision.family,
        targetKey: decision.targetKey,
        targetAiringId: decision.targetAiringId ?? null,
        insertionInstant: decision.insertionInstant,
      })),
      insertedEntries: insertedEntries.map((entry) => ({
          id: entry.id,
          mediaId: entry.mediaId ?? null,
          title: entry.title,
          start: entry.start,
          end: entry.end,
          durationMs: entry.durationMs,
          source: entry.source ?? null,
          generated: prepared.prepared.some((item) => item.id === entry.mediaId),
        })),
      existingContinuityEntries: applied.schedule.entries.filter(
        (entry) => entry.source?.startsWith("continuity:") && originalEntryIds.has(entry.id),
      ).length,
      totalDurationMs: applied.schedule.entries.reduce((sum, entry) => sum + entry.durationMs, 0),
    },
    timing,
    branding,
    ffmpeg,
    frames,
  };
  await writeManifest(output, manifest);

  console.log(
    `\nVerifier: prepared ${prepared.prepared.length} card(s), inserted ${applied.decisions.length} exact-fit continuation card(s).`,
  );
  for (const decision of applied.decisions)
    console.log(`  inserted ${decision.cardType} at ${decision.insertionInstant} -> ${decision.targetKey}`);
  console.log(
    `Timing: ${timing.ok ? "unchanged" : `${timing.issues.length} issue(s)`}; breaks checked: ${timing.breaks.length}.`,
  );
  console.log(`Frames: ${frames.length}; cards: ${cardsDir}`);
  console.log(`Manifest: ${resolve(output, "manifest.json")}`);
  if (!prepared.prepared.length)
    console.error(
      "No card could be prepared for this day; check the recorded prepare diagnostics.",
    );
  if (!timing.ok) {
    for (const issue of timing.issues) console.error(`TIMING ${issue.breakEntryId}: ${issue.message}`);
    process.exitCode = 1;
  }
} finally {
  close();
}
