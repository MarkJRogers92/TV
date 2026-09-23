#!/usr/bin/env -S npx tsx
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DateTime } from "luxon";
import { openDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { validateChannelConfiguration } from "../src/domain/validation.js";
import type { Channel, MediaItem, Pool, Schedule, ScheduleEntry } from "../src/domain/models.js";
import { TunarrClient } from "../src/integrations/tunarr/client.js";
import { buildTunarrSyncPlan } from "../src/integrations/tunarr/plan.js";
import { readTunarrMappingForChannel } from "../src/server/tunarrAutoSync.js";
import { buildBreakPlacements, continuityBreakClassifier } from "../src/continuity/publish.js";
import { scheduleContentHash } from "../src/continuity/identity.js";

const repoRoot = resolve(process.cwd());
const apply = process.argv.includes("--apply");
const backupDir = resolve(process.argv.find((arg) => arg.startsWith("--backup-dir="))?.split("=")[1]
  ?? "/Users/markrogers/Downloads/MarkTV_Shared_Voiced_Backup_2026-09-22");
const sharedTag = "continuity-shared-channels=marktv-movies,marktv-cult-movies";
const sharedStationMaps = [
  "MARKTV_ID_MAIN_001", "MARKTV_ID_NOSTALGIA_001", "MARKTV_ID_STAY_MARKED_001", "MARKTV_SLOGAN_NATURE_001",
];
const sharedBreakMaps = [
  "MARKTV_BREAK_OUT_001", "MARKTV_RETURN_NOT_YOUR_PROBLEMS_001", "MARKTV_RETURN_APOLOGY_001",
];
const allSharedMaps = [...sharedStationMaps, ...sharedBreakMaps];
const mediaMap = (item: MediaItem) => item.tags.find((tag) => tag.startsWith("continuity-map="))?.slice("continuity-map=".length);
const sorted = (items: string[]) => [...items].sort();
const sameStrings = (left: string[], right: string[]) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const editorial = (entry: ScheduleEntry) => entry.kind === "episode" || entry.kind === "movie";
const localTime = (instant: number, timezone: string) => DateTime.fromMillis(instant).setZone(timezone).toFormat("HH:mm");
const voicedScheduleEntry = (schedule: Schedule, item: MediaItem, start: number): ScheduleEntry => ({
  id: `shared-voiced:${schedule.id}:${item.id}:${start}`,
  start: new Date(start).toISOString(),
  end: new Date(start + item.durationMs!).toISOString(),
  localStart: localTime(start, schedule.timezone),
  localEnd: localTime(start + item.durationMs!, schedule.timezone),
  durationMs: item.durationMs!,
  kind: item.kind,
  title: item.title,
  mediaId: item.id,
  path: item.path,
  source: "continuity:shared-station-id",
  selectionExplanation: "Shared evergreen station identity clip",
});
const withContinuityAppliedHash = (schedule: Schedule, entries: ScheduleEntry[]): Schedule => ({
  ...schedule,
  entries,
  ...(schedule.continuityBinding ? {
    continuityBinding: {
      ...schedule.continuityBinding,
      appliedHash: scheduleContentHash({ ...schedule, entries }),
    },
  } : {}),
});
const verifyExactTiming = (before: Schedule, after: Schedule) => {
  const editorialEvidence = (schedule: Schedule) => schedule.entries.filter(editorial);
  const total = (schedule: Schedule) => schedule.entries.reduce((sum, entry) => sum + entry.durationMs, 0);
  const interstitialWindows = (schedule: Schedule) => {
    const windows: Array<[string, string, number]> = [];
    for (let index = 0; index < schedule.entries.length;) {
      if (editorial(schedule.entries[index]!)) { index += 1; continue; }
      const start = index;
      while (index < schedule.entries.length && !editorial(schedule.entries[index]!)) index += 1;
      const entries = schedule.entries.slice(start, index);
      windows.push([entries[0]!.start, entries.at(-1)!.end, entries.reduce((sum, entry) => sum + entry.durationMs, 0)]);
    }
    return windows;
  };
  return before.id === after.id && before.channelId === after.channelId && before.date === after.date &&
    before.durationMs === after.durationMs && total(before) === total(after) &&
    before.entries[0]?.start === after.entries[0]?.start && before.entries.at(-1)?.end === after.entries.at(-1)?.end &&
    JSON.stringify(editorialEvidence(before)) === JSON.stringify(editorialEvidence(after)) &&
    JSON.stringify(interstitialWindows(before)) === JSON.stringify(interstitialWindows(after));
};

const db = openDatabase(resolve(repoRoot, "data"));
const repositories = createRepositories(db);
try {
  const channels = repositories.channels.list();
  const movies = channels.find((channel) => channel.id === "marktv-movies");
  const cultMovies = channels.find((channel) => channel.id === "marktv-cult-movies");
  if (!movies || movies.number !== 8 || !movies.preservedLineup || !cultMovies || cultMovies.number !== 9)
    throw new Error("Expected channel 8 preserved lineup and channel 9 cult movie channel");

  const catalog = repositories.media.list();
  const selected = new Map<string, MediaItem>();
  for (const map of allSharedMaps) {
    const matches = catalog.filter((item) => mediaMap(item) === map);
    if (matches.length !== 1) throw new Error(`Expected one catalog item for ${map}; found ${matches.length}`);
    const item = matches[0]!;
    const expectedRole = sharedStationMaps.includes(map) ? "station-id"
      : map === "MARKTV_BREAK_OUT_001" ? "break" : "return";
    if (!item.available || !item.path || item.durationStatus !== "ok" || !item.durationMs ||
      item.tags.filter((tag) => tag.startsWith("continuity-channel=")).join() !== "continuity-channel=marktv-laughs" ||
      item.tags.filter((tag) => tag.startsWith("continuity-role=")).join() !== `continuity-role=${expectedRole}` ||
      item.tags.filter((tag) => tag.startsWith("continuity-scope=")).join() !== "continuity-scope=evergreen" ||
      item.tags.some((tag) => tag.startsWith("continuity-shared-channels=")) ||
      item.tags.some((tag) => tag.startsWith("continuity-staged")))
      throw new Error(`${map} is missing, staged, malformed, or already shared inconsistently`);
    selected.set(map, { ...item, tags: [...item.tags, sharedTag] });
  }
  const stationIds = sharedStationMaps.map((map) => selected.get(map)!).filter((item) => item.kind === "station-id");
  if (stationIds.length !== 4) throw new Error("The shared evergreen station-ID allowlist is incomplete");

  const poolsBefore = repositories.pools.list();
  const createPool = (id: string, name: string): Pool => {
    const expected: Pool = { id, name, kinds: ["station-id"], mediaIds: stationIds.map((item) => item.id), mode: "shuffle", noRepeatMinutes: 60, weight: 1 };
    const current = poolsBefore.find((pool) => pool.id === id);
    if (current && (current.name !== expected.name || !sameStrings(current.kinds, expected.kinds) ||
      !sameStrings(current.mediaIds, expected.mediaIds) || current.mode !== expected.mode ||
      current.noRepeatMinutes !== expected.noRepeatMinutes || current.weight !== expected.weight))
      throw new Error(`Existing pool ${id} conflicts; refusing to overwrite it`);
    return current ?? expected;
  };
  const movieIds = createPool("marktv-movies-voiced-ids", "MarkTV Movies Shared Voice IDs");
  const cultIds = createPool("marktv-cult-movies-voiced-ids", "MarkTV Cult Movies Shared Voice IDs");
  const poolsAfter = [...poolsBefore.filter((pool) => pool.id !== movieIds.id && pool.id !== cultIds.id), movieIds, cultIds];
  const updateChannel = (channel: Channel, pool: Pool): Channel => ({
    ...channel,
    breakPolicy: {
      ...channel.breakPolicy,
      stationIdPoolIds: [...new Set([...channel.breakPolicy.stationIdPoolIds, pool.id])],
    },
  });
  const channelsAfter = [updateChannel(movies, movieIds), updateChannel(cultMovies, cultIds)];
  const sharedMedia = sharedStationMaps.map((map) => selected.get(map)!);
  const futureStationBreaks: Array<{ channelId: string; scheduleId: string; map: string; breakStart: string; breakDurationMs: number }> = [];
  const scheduleUpdates: Schedule[] = [];
  const schedulesBefore: Schedule[] = [];
  for (const channel of channelsAfter) {
    const issues = validateChannelConfiguration(channel, poolsAfter, [...catalog, ...selected.values()]);
    if (issues.length) throw new Error(`Invalid ${channel.id} activation config: ${JSON.stringify(issues)}`);
  }

  const now = DateTime.now();
  const planReports: Array<Record<string, unknown>> = [];
  for (const channel of [movies, cultMovies]) {
    const stored = readTunarrMappingForChannel(repositories, channel.id);
    if (!stored?.url) throw new Error(`No Tunarr mapping configured for ${channel.id}`);
    const mapping = {
      preserveExistingLineup: stored.preserveExistingLineup,
      libraryId: stored.libraryId,
      libraryIds: stored.libraryIds,
      channelId: stored.channelId,
      fillerListId: stored.fillerListId,
      createChannel: stored.createChannel,
      transcodeConfigId: stored.transcodeConfigId,
    };
      const snapshot = await new TunarrClient(stored.url).snapshot(mapping);
      const inMemoryMedia = catalog.map((item) => selected.get(mediaMap(item) ?? "") ?? item);
    const dates = [0, 1].map((days) => now.setZone(channel.timezone).plus({ days }).toISODate()!);
    for (const date of dates) {
      const schedule = repositories.schedules.latestForDate(channel.id, date);
      if (!schedule) continue;
      const proposedChannel = channelsAfter.find((candidate) => candidate.id === channel.id)!;
      const { classify } = continuityBreakClassifier(inMemoryMedia);
      const history = repositories.schedules.historyBefore(channel.id, date);
      const usedHours = new Set<string>();
      let candidateIndex = 0;
      const updatedEntries: ScheduleEntry[] = [];
      for (let index = 0; index < schedule.entries.length;) {
        if (editorial(schedule.entries[index]!)) { updatedEntries.push(schedule.entries[index++]!); continue; }
        const start = index;
        while (index < schedule.entries.length && !editorial(schedule.entries[index]!)) index += 1;
        const breakEntries = schedule.entries.slice(start, index);
        if (!breakEntries.length || start === 0 || index >= schedule.entries.length) { updatedEntries.push(...breakEntries); continue; }
        const hasFlex = breakEntries.some((entry) => entry.kind === "flex");
        if (hasFlex) {
          for (const entry of breakEntries) {
            const breakStart = Date.parse(entry.start);
            const hourKey = DateTime.fromMillis(breakStart).setZone(channel.timezone).toFormat("yyyy-LL-dd-HH");
            if (entry.kind !== "flex" || breakStart < Date.now() || usedHours.has(hourKey)) { updatedEntries.push(entry); continue; }
            const candidates = sharedMedia.slice(candidateIndex).concat(sharedMedia.slice(0, candidateIndex));
            const mediaItem = candidates.find((candidate) => candidate.durationMs! < entry.durationMs);
            if (!mediaItem) { updatedEntries.push(entry); continue; }
            const map = mediaMap(mediaItem)!;
            candidateIndex = (sharedMedia.indexOf(mediaItem) + 1) % sharedMedia.length;
            updatedEntries.push(voicedScheduleEntry(schedule, mediaItem, breakStart));
            const remainingMs = entry.durationMs - mediaItem.durationMs!;
            if (remainingMs > 0) updatedEntries.push({
              ...entry,
              id: `${entry.id}:after-${mediaItem.id}`,
              start: new Date(breakStart + mediaItem.durationMs!).toISOString(),
              durationMs: remainingMs,
              localStart: localTime(breakStart + mediaItem.durationMs!, schedule.timezone),
            });
            usedHours.add(hourKey);
            futureStationBreaks.push({ channelId: channel.id, scheduleId: schedule.id, map, breakStart: entry.start, breakDurationMs: entry.durationMs });
          }
          continue;
        }
        const breakStart = Date.parse(breakEntries[0]!.start);
        const hourKey = DateTime.fromMillis(breakStart).setZone(channel.timezone).toFormat("yyyy-LL-dd-HH");
        if (breakStart < Date.now() || usedHours.has(hourKey)) { updatedEntries.push(...breakEntries); continue; }
        const candidates = sharedMedia.slice(candidateIndex).concat(sharedMedia.slice(0, candidateIndex));
        let accepted: { map: string; mediaItem: MediaItem; placements: NonNullable<ReturnType<typeof buildBreakPlacements>> } | undefined;
        for (const mediaItem of candidates) {
          const placements = buildBreakPlacements({
            breakEntries,
            card: { id: `preview:${mediaItem.id}`, durationMs: mediaItem.durationMs!, kind: "continuity", role: "station-id", spoken: true, informational: false },
            classify,
            media: inMemoryMedia,
            environment: { channel: { ...proposedChannel, breakPolicy: { ...proposedChannel.breakPolicy, stationIdPoolIds: [] } }, pools: poolsAfter, fillerHistory: history },
            maximumSpokenElements: 2,
            maximumContinuityMs: 20_000,
            seed: `${schedule.id}:shared-voiced:${breakEntries[0]!.id}`,
            replaceInformational: breakEntries.some((entry) => classify(entry).informational),
          });
          if (placements) { accepted = { map: mediaMap(mediaItem)!, mediaItem, placements }; break; }
        }
        if (!accepted) { updatedEntries.push(...breakEntries); continue; }
        candidateIndex = (sharedMedia.indexOf(accepted.mediaItem) + 1) % sharedMedia.length;
        usedHours.add(hourKey);
        futureStationBreaks.push({ channelId: channel.id, scheduleId: schedule.id, map: accepted.map, breakStart: breakEntries[0]!.start, breakDurationMs: breakEntries.reduce((total, entry) => total + entry.durationMs, 0) });
        let at = breakStart;
        for (const placement of accepted.placements) {
          const old = placement.type === "keep" ? breakEntries[placement.index] : undefined;
          const fill = placement.type === "fill" ? placement.entry : undefined;
          const durationMs = placement.type === "card" ? accepted.mediaItem.durationMs! : old?.durationMs ?? fill?.durationMs ?? 0;
          const startInstant = new Date(at).toISOString();
          at += durationMs;
          const endInstant = new Date(at).toISOString();
          if (old) updatedEntries.push({ ...old, start: startInstant, end: endInstant, localStart: localTime(at - durationMs, schedule.timezone), localEnd: localTime(at, schedule.timezone) });
          else if (fill) updatedEntries.push({ ...fill, start: startInstant, end: endInstant, durationMs, localStart: localTime(at - durationMs, schedule.timezone), localEnd: localTime(at, schedule.timezone) });
          else updatedEntries.push(voicedScheduleEntry(schedule, accepted.mediaItem, at - durationMs));
        }
        if (at !== Date.parse(breakEntries.at(-1)!.end)) throw new Error(`Shared ID refill changed ${schedule.id} break timing`);
      }
      const scheduleAfter = withContinuityAppliedHash(schedule, updatedEntries);
      if (!verifyExactTiming(schedule, scheduleAfter))
        throw new Error(`Shared ID insertion changed editorial timing on ${schedule.id}`);
      if (JSON.stringify(scheduleAfter.entries) !== JSON.stringify(schedule.entries)) {
        scheduleUpdates.push(scheduleAfter);
        schedulesBefore.push(schedule);
      }
      const plan = buildTunarrSyncPlan(scheduleAfter, snapshot.inventory, snapshot.capabilities, mapping, snapshot.snapshots, inMemoryMedia);
      const operation = plan.operations.find((candidate) => candidate.type === "programming");
      const catalogByPath = new Map<string, MediaItem[]>();
      for (const item of inMemoryMedia.filter((candidate) => allSharedMaps.includes(mediaMap(candidate) ?? ""))) {
        if (!item.path) continue;
        const path = item.path.replaceAll("\\", "/");
        catalogByPath.set(path, [...(catalogByPath.get(path) ?? []), item]);
      }
      const known = new Map<string, { map: string; title: string }>();
      for (const item of snapshot.inventory) {
        const matches = catalogByPath.get(item.path.replaceAll("\\", "/")) ?? [];
        if (matches.length === 1)
          known.set(item.id, { map: mediaMap(matches[0]!)!, title: matches[0]!.title });
      }
      const placements: Array<{ map: string; title: string; start: string; durationMs: number; future: boolean }> = [];
      const liveChannel = snapshot.snapshots.channels.find((candidate) => candidate.id === mapping.channelId);
      let at = channel.preservedLineup ? liveChannel?.startTime ?? Number.NaN : Date.parse(schedule.entries[0]?.start ?? "");
      if (operation?.type === "programming") for (const entry of operation.payload) {
        const match = entry.type === "content" && entry.id ? known.get(entry.id) : undefined;
        if (match && Number.isFinite(at)) placements.push({ map: match.map, title: match.title, start: new Date(at).toISOString(), durationMs: entry.duration, future: at >= Date.now() });
        at += entry.duration;
      }
      const expectedDuration = channel.preservedLineup
        ? snapshot.snapshots.programming?.lineup.reduce((sum, entry) => sum + entry.duration, 0)
        : schedule.durationMs;
      const durationPreserved = operation?.type === "programming" && expectedDuration !== undefined &&
        Math.abs(operation.payload.reduce((sum, entry) => sum + entry.duration, 0) - expectedDuration) <= 1;
      planReports.push({
        channelId: channel.id, channelNumber: channel.number, date, scheduleId: schedule.id,
        scheduleMidrollCount: schedule.entries.reduce((total, entry) => total + (entry.midrolls?.length ?? 0), 0),
        preservedLineup: channel.preservedLineup ?? null,
        editorialScheduleChanges: 0,
        syncEligible: plan.syncEligible, blockingErrors: plan.blockingErrors,
        durationPreserved, futureSharedPlacements: placements.filter((placement) => placement.future),
        preCutoffSharedPlacements: placements.filter((placement) => !placement.future).length,
      });
    }
  }

  const report = {
    mode: apply ? "apply-channel8-9-tags-pools-and-future-schedules" : "dry-run",
    channel7ScheduleOrPoolWrites: 0,
    catalogTagsToAdd: [...selected.values()].map((item) => ({ id: item.id, map: mediaMap(item), tag: sharedTag })),
    poolsToCreateOrReuse: [movieIds, cultIds],
    channelPoolChanges: channelsAfter.map((channel) => ({ id: channel.id, number: channel.number, stationIdPoolIds: channel.breakPolicy.stationIdPoolIds, preservedLineup: channel.preservedLineup ?? null })),
    futureStationBreaks,
    scheduleRowsToUpdate: scheduleUpdates.length,
    scheduleWrites: apply ? scheduleUpdates.length : 0,
    scheduleUpdates: scheduleUpdates.map((schedule) => ({ channelId: schedule.channelId, id: schedule.id, date: schedule.date, addedStationIds: futureStationBreaks.filter((placement) => placement.scheduleId === schedule.id).map((placement) => placement.map) })),
    plans: planReports,
  };
  await mkdir(backupDir, { recursive: true });
  const reportPath = resolve(backupDir, `shared-voiced-preview-${Date.now()}.json`);
  (report as { reportPath?: string }).reportPath = reportPath;
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (apply) {
    if (!planReports.length || planReports.some((plan) => plan.syncEligible !== true || plan.durationPreserved !== true))
      throw new Error("At least one stored schedule preview is missing, blocked, or does not preserve exact duration");
    if (!scheduleUpdates.length || !futureStationBreaks.length)
      throw new Error("No future station-ID placements were found; refusing a metadata-only apply");
    const snapshotPath = resolve(backupDir, `shared-voiced-before-${Date.now()}.json`);
    await writeFile(snapshotPath, JSON.stringify({ media: [...selected.keys()].map((map) => catalog.find((item) => mediaMap(item) === map)), pools: poolsBefore.filter((pool) => [movieIds.id, cultIds.id].includes(pool.id)), channels: [movies, cultMovies], schedules: schedulesBefore }, null, 2), { flag: "wx", mode: 0o600 });
    repositories.transaction(() => {
      for (const [, expected] of selected) {
        const current = repositories.media.get(expected.id);
        if (JSON.stringify(current) !== JSON.stringify(catalog.find((item) => item.id === expected.id)))
          throw new Error(`Media changed after preview: ${expected.id}`);
      }
      for (const expected of [movies, cultMovies])
        if (JSON.stringify(repositories.channels.get(expected.id)) !== JSON.stringify(expected))
          throw new Error(`Channel changed after preview: ${expected.id}`);
      for (const id of [movieIds.id, cultIds.id]) {
        const expected = poolsBefore.find((pool) => pool.id === id);
        if (JSON.stringify(repositories.pools.get(id)) !== JSON.stringify(expected))
          throw new Error(`Pool changed after preview: ${id}`);
      }
      for (const expected of schedulesBefore) {
        const current = repositories.schedules.latestForDate(expected.channelId, expected.date);
        if (JSON.stringify(current) !== JSON.stringify(expected))
          throw new Error(`Schedule changed after preview: ${expected.id}`);
      }
      for (const [, item] of selected) repositories.media.put(item);
      repositories.pools.put(movieIds);
      repositories.pools.put(cultIds);
      for (const channel of channelsAfter) repositories.channels.put(channel);
      for (const schedule of scheduleUpdates) repositories.schedules.replaceSuccessful(schedule.channelId, schedule);
    });
    console.log(JSON.stringify({ applied: true, snapshotPath, catalogItemsUpdated: selected.size, schedulesUpdated: scheduleUpdates.length, note: "No Tunarr writes were performed; run the guarded per-channel sync after review." }));
  }
} finally {
  db.close();
}
