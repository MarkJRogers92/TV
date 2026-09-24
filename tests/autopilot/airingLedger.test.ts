import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase, type MarkTvDatabase } from "../../src/db/database.js";
import {
  airingLedgerTables,
  createAiringLedger,
  seriesTrackKey,
  type AiringLedger,
  type AiringWriteResult,
} from "../../src/autopilot/airingLedger.js";

/*
 * Acceptance fixtures for the Stage 1 durable airing ledger.
 *
 * The handoff package names its episode/airing cases `EP01`, `EP07`, `EP09`
 * and `EP14` and its failure fixtures `F01`, `F02`, `F10` and `F18`. The supplied
 * synthetic fixture data is copied intact under tests/fixtures; this file
 * exercises those behaviours through MarkTV's SQLite API, while
 * packageAcceptance.test.ts reads the fixture data directly for selector F02:
 * contiguous coverage plus an explicit aired interval for completion,
 * idempotent duplicate callbacks, gap-aware predecessor ordering, restart
 * recovery of the active occurrence and source offset, one logical floor per
 * series shared across channels, and holding a track whose position is missing
 * or ambiguous instead of resetting it.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function dataDir() {
  const path = await mkdtemp(join(tmpdir(), "marktv-airing-ledger-"));
  directories.push(path);
  return path;
}

const CHANNEL = "marktv-laughs";
const SERIES = "Home Improvement";
const SOURCE_START = 0;
const SOURCE_END = 1_440_000;
const AT = "2026-09-23T05:00:00.000Z";

function ok<T>(result: AiringWriteResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  return result.value;
}

function refused<T>(result: AiringWriteResult<T>) {
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

/** Registers the track plus a contiguous run of season 1 episodes. */
function trackWithEpisodes(ledger: AiringLedger, episodes: Array<[string, number]>) {
  const track = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: SERIES, at: AT }),
  );
  for (const [episodeKey, episode] of episodes) {
    ok(
      ledger.ensureEpisodeIdentity({
        episodeKey,
        trackKey: track.trackKey,
        title: `${SERIES} ${episode}`,
        season: 1,
        episode,
        at: AT,
      }),
    );
  }
  return track;
}

function reserve(
  ledger: AiringLedger,
  trackKey: string,
  occurrenceKey: string,
  episodeKey: string,
  channelId: string = CHANNEL,
) {
  return ledger.reserveOccurrence({
    occurrenceKey,
    trackKey,
    episodeKey,
    channelId,
    broadcastDate: "2026-09-23",
    plannedStart: "2026-09-23T05:00:00.000Z",
    plannedEnd: "2026-09-23T05:24:00.000Z",
    sourceMediaId: `${episodeKey}-file`,
    sourceStartMs: SOURCE_START,
    sourceEndMs: SOURCE_END,
    at: AT,
  });
}

/** Credits one episode end to end and returns the resulting floor episode key. */
function creditEpisode(
  ledger: AiringLedger,
  trackKey: string,
  occurrenceKey: string,
  episodeKey: string,
  channelId: string = CHANNEL,
) {
  ok(reserve(ledger, trackKey, occurrenceKey, episodeKey, channelId));
  recordFullEvidence(ledger, occurrenceKey);
  return ok(ledger.completeOccurrence({ occurrenceKey, at: AT }));
}

/** Records contiguous published coverage and an explicit aired interval. */
function recordFullEvidence(
  ledger: AiringLedger,
  occurrenceKey: string,
  options: { published?: Array<[number, number]>; aired?: Array<[number, number]> } = {},
) {
  const published = options.published ?? [[SOURCE_START, SOURCE_END]];
  const aired = options.aired ?? [[SOURCE_START, SOURCE_END]];
  published.forEach(([start, end], index) => {
    ok(
      ledger.recordPublishedInterval({
        intervalId: `${occurrenceKey}-pub-${index}`,
        occurrenceKey,
        sourceStartMs: start,
        sourceEndMs: end,
        publishedAt: AT,
        evidence: "hls-publisher-ack",
      }),
    );
  });
  aired.forEach(([start, end], index) => {
    ok(
      ledger.recordAiredInterval({
        intervalId: `${occurrenceKey}-air-${index}`,
        occurrenceKey,
        sourceStartMs: start,
        sourceEndMs: end,
        airedAt: AT,
        evidence: "player-observed",
      }),
    );
  });
}

test("the ledger schema is additive and leaves existing rows untouched", async () => {
  const dir = await dataDir();
  const first = openDatabase(dir);
  first
    .prepare("INSERT INTO documents(type, id, json) VALUES (?, ?, ?)")
    .run("setting", "existing", JSON.stringify({ id: "existing", value: 1 }));
  first
    .prepare(
      "INSERT INTO schedule_generations(channel_id, schedule_id, generated_at, json) VALUES (?, ?, ?, ?)",
    )
    .run(CHANNEL, "schedule-1", AT, JSON.stringify({ id: "schedule-1" }));
  first.close();

  // Reopening runs the additive migration a second time; it must be idempotent.
  const second = openDatabase(dir);
  const tables = (second
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'airing\\_%' ESCAPE '\\' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
  const preserved = second
    .prepare("SELECT json FROM documents WHERE type = 'setting' AND id = 'existing'")
    .get() as { json: string } | undefined;
  const generations = second
    .prepare("SELECT COUNT(*) AS count FROM schedule_generations")
    .get() as { count: number };
  second.close();

  expect(tables).toEqual([...airingLedgerTables].sort());
  expect(JSON.parse(preserved!.json)).toEqual({ id: "existing", value: 1 });
  expect(generations.count).toBe(1);
});

test("a series track keeps one identity across spelling, case, channel and trailing-year renames", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const original = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: "Home Improvement (1991)", at: AT }),
  );
  const renamed = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: "home improvement", at: AT }),
  );
  // Same series on another channel shares the one logical track, so the two
  // channels contend for a single floor instead of each holding a partial one.
  const otherChannel = ok(
    ledger.ensureSeriesTrack({
      channelId: "marktv-movies",
      seriesTitle: "Home Improvement",
      at: AT,
    }),
  );
  // An explicit discriminator is the only way to get a deliberate second track.
  const separate = ok(
    ledger.ensureSeriesTrack({
      channelId: "marktv-movies",
      seriesTitle: "Home Improvement",
      separateTrack: "marktv-movies",
      at: AT,
    }),
  );
  const other = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: "Night Court", at: AT }),
  );

  expect(renamed.trackKey).toBe(original.trackKey);
  expect(otherChannel.trackKey).toBe(original.trackKey);
  expect(separate.trackKey).not.toBe(original.trackKey);
  expect(other.trackKey).not.toBe(original.trackKey);
  expect(ledger.seriesTrack(original.trackKey)?.trackKey).toBe(original.trackKey);
  expect(seriesTrackKey("Home Improvement (1991)")).toBe(seriesTrackKey("home improvement"));
  expect(seriesTrackKey("Home Improvement")).not.toBe(
    seriesTrackKey("Home Improvement", "marktv-movies"),
  );
});

test("[EP07] duplicate occurrence, attempt and interval callbacks are idempotent", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);

  const first = ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  const replay = ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  expect(first.occurrenceKey).toBe("occ-1");
  expect(replay.occurrenceKey).toBe("occ-1");
  expect(ledger.occurrencesForTrack(track.trackKey)).toHaveLength(1);

  const attempt = {
    attemptId: "attempt-1",
    occurrenceKey: "occ-1",
    startedAt: AT,
    outcome: "started" as const,
    sourceOffsetMs: 0,
    at: AT,
  };
  ok(ledger.recordAttempt(attempt));
  ok(ledger.recordAttempt(attempt));
  ok(ledger.recordAttempt({ ...attempt, at: "2026-09-23T05:05:00.000Z" }));
  expect(ledger.attemptsFor("occ-1")).toHaveLength(1);

  const published = {
    intervalId: "pub-0",
    occurrenceKey: "occ-1",
    sourceStartMs: SOURCE_START,
    sourceEndMs: SOURCE_END,
    publishedAt: AT,
    evidence: "hls-publisher-ack",
  };
  const aired = {
    intervalId: "air-0",
    occurrenceKey: "occ-1",
    sourceStartMs: SOURCE_START,
    sourceEndMs: SOURCE_END,
    airedAt: AT,
    evidence: "player-observed",
  };
  ok(ledger.recordPublishedInterval(published));
  ok(ledger.recordPublishedInterval(published));
  ok(ledger.recordAiredInterval(aired));
  ok(ledger.recordAiredInterval({ ...aired, at: "2026-09-23T05:06:00.000Z" }));
  expect(ledger.publishedIntervals("occ-1")).toHaveLength(1);
  expect(ledger.airedIntervals("occ-1")).toHaveLength(1);

  // A reused id carrying different evidence is a conflict, not a silent overwrite.
  expect(
    refused(
      ledger.recordAiredInterval({
        ...aired,
        sourceStartMs: 60_000,
        sourceEndMs: 120_000,
      }),
    ).reason,
  ).toBe("id-conflict");
});

test("[F18] schedule generation history alone credits no airing", async () => {
  const database = openDatabase(await dataDir());
  const ledger = createAiringLedger(database);
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  const occurrence = ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));

  // The database already records that this episode was scheduled many times.
  for (let index = 0; index < 5; index += 1) {
    database
      .prepare(
        "INSERT INTO schedule_generations(channel_id, schedule_id, generated_at, json) VALUES (?, ?, ?, ?)",
      )
      .run(CHANNEL, `schedule-${index}`, AT, JSON.stringify({ id: `schedule-${index}` }));
  }

  const evaluation = ledger.evaluateOccurrence(occurrence.occurrenceKey)!;
  expect(evaluation.contiguousPublished).toBe(false);
  expect(evaluation.explicitAiredInterval).toBe(false);
  expect(evaluation.complete).toBe(false);
  expect(refused(ledger.completeOccurrence({ occurrenceKey: occurrence.occurrenceKey, at: AT })).reason)
    .toBe("insufficient-evidence");
  expect(ledger.completionFloor(track.trackKey)).toBeUndefined();
});

test("[F03] a gap in published coverage withholds completion", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  recordFullEvidence(ledger, "occ-1", {
    published: [
      [0, 600_000],
      [660_000, SOURCE_END],
    ],
  });

  const evaluation = ledger.evaluateOccurrence("occ-1")!;
  expect(evaluation.contiguousPublished).toBe(false);
  expect(evaluation.contiguousAired).toBe(true);
  expect(evaluation.complete).toBe(false);
  expect(refused(ledger.completeOccurrence({ occurrenceKey: "occ-1", at: AT })).reason)
    .toBe("insufficient-evidence");
  expect(ledger.completionFloor(track.trackKey)).toBeUndefined();
});

test("[F04] contiguous publication without an explicit aired interval withholds completion", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  ok(
    ledger.recordPublishedInterval({
      intervalId: "pub-0",
      occurrenceKey: "occ-1",
      sourceStartMs: SOURCE_START,
      sourceEndMs: SOURCE_END,
      publishedAt: AT,
      evidence: "hls-publisher-ack",
    }),
  );

  const evaluation = ledger.evaluateOccurrence("occ-1")!;
  expect(evaluation.contiguousPublished).toBe(true);
  expect(evaluation.explicitAiredInterval).toBe(false);
  expect(evaluation.complete).toBe(false);
  expect(ledger.completionFloor(track.trackKey)).toBeUndefined();
});

test("[EP01] contiguous publication plus an explicit aired interval credits the track floor", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  recordFullEvidence(ledger, "occ-1");

  const credited = ok(ledger.completeOccurrence({ occurrenceKey: "occ-1", at: AT }));
  expect(credited.credited).toBe(true);
  expect(credited.floor.episode).toBe(1);
  expect(credited.floor.completedEpisodeKey).toBe("S01E01");
  expect(ledger.occurrence("occ-1")?.state).toBe("completed");
  expect(ledger.completionFloor(track.trackKey)?.completedOccurrenceKey).toBe("occ-1");

  // Crediting the same occurrence again is idempotent rather than an error.
  const replay = ok(ledger.completeOccurrence({ occurrenceKey: "occ-1", at: AT }));
  expect(replay.credited).toBe(true);
  expect(ledger.completionFloor(track.trackKey)?.completedEpisodeKey).toBe("S01E01");
});

test("[F10] a later successor cannot be credited before its predecessor", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [
    ["S01E01", 1],
    ["S01E02", 2],
    ["S01E03", 3],
  ]);
  for (const [occurrenceKey, episodeKey] of [
    ["occ-1", "S01E01"],
    ["occ-2", "S01E02"],
    ["occ-3", "S01E03"],
  ] as const) {
    ok(reserve(ledger, track.trackKey, occurrenceKey, episodeKey));
    recordFullEvidence(ledger, occurrenceKey);
  }

  expect(refused(ledger.completeOccurrence({ occurrenceKey: "occ-3", at: AT })).reason)
    .toBe("predecessor-incomplete");
  expect(ledger.completionFloor(track.trackKey)).toBeUndefined();

  ok(ledger.completeOccurrence({ occurrenceKey: "occ-1", at: AT }));
  expect(refused(ledger.completeOccurrence({ occurrenceKey: "occ-3", at: AT })).reason)
    .toBe("predecessor-incomplete");
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(1);

  ok(ledger.completeOccurrence({ occurrenceKey: "occ-2", at: AT }));
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(2);
  ok(ledger.completeOccurrence({ occurrenceKey: "occ-3", at: AT }));
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(3);
});

test("[EP09] a restart reopens the same active occurrence at the same source offset", async () => {
  const dir = await dataDir();
  const first = openDatabase(dir);
  const firstLedger = createAiringLedger(first);
  const track = trackWithEpisodes(firstLedger, [["S01E01", 1]]);
  ok(reserve(firstLedger, track.trackKey, "occ-1", "S01E01"));
  ok(
    firstLedger.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey: "occ-1",
      attemptId: "attempt-1",
      sourceMediaId: "S01E01-file",
      sourceOffsetMs: 0,
      at: AT,
    }),
  );
  ok(firstLedger.advanceOccurrenceOffset({ trackKey: track.trackKey, sourceOffsetMs: 540_000, at: AT }));
  ok(firstLedger.interruptOccurrence({ trackKey: track.trackKey, sourceOffsetMs: 540_000, at: AT }));
  first.close();

  const second = openDatabase(dir);
  const secondLedger = createAiringLedger(second);
  const active = secondLedger.activeOccurrence(track.trackKey)!;
  expect(active.occurrenceKey).toBe("occ-1");
  expect(active.sourceOffsetMs).toBe(540_000);
  expect(active.state).toBe("interrupted");

  const resumed = ok(secondLedger.resumeActiveOccurrence({ trackKey: track.trackKey, at: AT }));
  expect(resumed.occurrenceKey).toBe("occ-1");
  expect(resumed.sourceOffsetMs).toBe(540_000);
  expect(resumed.state).toBe("active");
  expect(refused(secondLedger.advanceOccurrenceOffset({ trackKey: track.trackKey, sourceOffsetMs: 60_000, at: AT })).reason)
    .toBe("offset-regression");
  second.close();
});

test("[EP14] a missing or ambiguous track position is held instead of resetting the floor", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  recordFullEvidence(ledger, "occ-1");
  ok(ledger.completeOccurrence({ occurrenceKey: "occ-1", at: AT }));
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(1);

  // The incoming episode carries no position at all.
  const missing = refused(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01EXX",
      trackKey: track.trackKey,
      title: "Home Improvement bonus",
      at: AT,
    }),
  );
  expect(missing.reason).toBe("missing-position");
  expect(ledger.trackHold(track.trackKey)?.reason).toBe("missing-position");
  expect(refused(reserve(ledger, track.trackKey, "occ-2", "S01EXX")).reason).toBe("track-held");

  // A different episode claiming an already-taken position is ambiguous, too.
  const ambiguous = refused(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01E01-duplicate",
      trackKey: track.trackKey,
      title: "Home Improvement 1 (rescan)",
      season: 1,
      episode: 1,
      at: AT,
    }),
  );
  expect(ambiguous.reason).toBe("ambiguous-position");
  expect(ledger.episodeIdentities(track.trackKey)).toHaveLength(1);

  // Held, not reset: the established floor survives the disruption.
  expect(ledger.completionFloor(track.trackKey)?.completedEpisodeKey).toBe("S01E01");
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(1);
});

test("a held track can be released once the position is resolved", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  refused(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01EXX",
      trackKey: track.trackKey,
      title: "Home Improvement bonus",
      at: AT,
    }),
  );
  expect(ledger.trackHold(track.trackKey)?.reason).toBe("missing-position");

  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01E02",
      trackKey: track.trackKey,
      title: "Home Improvement 2",
      season: 1,
      episode: 2,
      at: AT,
    }),
  );
  expect(ledger.releaseTrackHold(track.trackKey, AT)).toBe(true);
  expect(ledger.trackHold(track.trackKey)).toBeUndefined();
  expect(ok(reserve(ledger, track.trackKey, "occ-2", "S01E02")).occurrenceKey).toBe("occ-2");
});

test("an occurrence cannot be reserved for an unknown track or episode", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  expect(refused(reserve(ledger, "missing-track", "occ-x", "S01E01")).reason).toBe("unknown-track");
  expect(refused(reserve(ledger, track.trackKey, "occ-y", "S09E99")).reason).toBe("unknown-episode");
  expect(
    refused(
      ledger.reserveOccurrence({
        occurrenceKey: "occ-z",
        trackKey: track.trackKey,
        episodeKey: "S01E01",
        channelId: CHANNEL,
        plannedStart: AT,
        plannedEnd: AT,
        sourceMediaId: "S01E01-file",
        sourceStartMs: 100,
        sourceEndMs: 100,
        at: AT,
      }),
    ).reason,
  ).toBe("invalid-interval");
});

test("ledger reads survive a restart with the same identities and state", async () => {
  const dir = await dataDir();
  const first: MarkTvDatabase = openDatabase(dir);
  const firstLedger = createAiringLedger(first);
  const track = trackWithEpisodes(firstLedger, [["S01E01", 1]]);
  ok(reserve(firstLedger, track.trackKey, "occ-1", "S01E01"));
  recordFullEvidence(firstLedger, "occ-1");
  ok(firstLedger.completeOccurrence({ occurrenceKey: "occ-1", at: AT }));
  const seriesKey = firstLedger.seriesTrack(track.trackKey)?.seriesKey;
  first.close();

  const second = createAiringLedger(openDatabase(dir));
  expect(second.seriesTrack(track.trackKey)?.seriesKey).toBe(seriesKey);
  expect(second.episodeIdentity("S01E01")?.episode).toBe(1);
  expect(second.completionFloor(track.trackKey)?.completedOccurrenceKey).toBe("occ-1");
  expect(second.airedIntervals("occ-1")).toHaveLength(1);
  expect(second.publishedIntervals("occ-1")).toHaveLength(1);
});

test("[F01] restart/reconnect keeps the active occurrence and its furthest source offset", async () => {
  const dir = await dataDir();
  const first = openDatabase(dir);
  const firstLedger = createAiringLedger(first);
  const track = trackWithEpisodes(
    firstLedger,
    Array.from({ length: 13 }, (_, index) => [`S01E${String(index + 1).padStart(2, "0")}`, index + 1] as [string, number]),
  );
  for (let episode = 1; episode <= 9; episode += 1) {
    const key = `S01E${String(episode).padStart(2, "0")}`;
    creditEpisode(firstLedger, track.trackKey, `occ-${key}`, key);
  }
  expect(firstLedger.completionFloor(track.trackKey)?.episode).toBe(9);

  // Reservations 11-13 exist as future plans while a10 is mid-airing.
  for (let episode = 10; episode <= 13; episode += 1) {
    const key = `S01E${String(episode).padStart(2, "0")}`;
    ok(reserve(firstLedger, track.trackKey, `occ-${key}`, key));
  }
  ok(
    firstLedger.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey: "occ-S01E10",
      attemptId: "attempt-10",
      sourceMediaId: "S01E10-file",
      sourceOffsetMs: 0,
      at: AT,
    }),
  );
  ok(
    firstLedger.advanceOccurrenceOffset({
      trackKey: track.trackKey,
      sourceOffsetMs: 600_000,
      at: AT,
    }),
  );
  first.close();

  // A restart/reconnect replays "start at 0" for the same occurrence and must
  // not reset the playhead or start a different occurrence.
  const second = openDatabase(dir);
  const secondLedger = createAiringLedger(second);
  const reopened = secondLedger.activeOccurrence(track.trackKey)!;
  expect(reopened.occurrenceKey).toBe("occ-S01E10");
  expect(reopened.sourceOffsetMs).toBe(600_000);

  const replay = ok(
    secondLedger.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey: "occ-S01E10",
      sourceOffsetMs: 0,
      at: "2026-09-23T05:30:00.000Z",
    }),
  );
  expect(replay.occurrenceKey).toBe("occ-S01E10");
  expect(replay.sourceOffsetMs).toBe(600_000);
  expect(replay.state).toBe("active");

  // Trying to start E11 while E10 is still active is refused.
  expect(
    refused(
      secondLedger.beginOccurrence({
        trackKey: track.trackKey,
        occurrenceKey: "occ-S01E11",
        at: AT,
      }),
    ).reason,
  ).toBe("occurrence-in-progress");
  expect(secondLedger.activeOccurrence(track.trackKey)?.occurrenceKey).toBe("occ-S01E10");
  expect(secondLedger.completionFloor(track.trackKey)?.episode).toBe(9);
  second.close();
});

test("[F01] a duplicate start preserves a recorded interruption", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  ok(
    ledger.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey: "occ-1",
      attemptId: "attempt-1",
      sourceMediaId: "S01E01-file",
      sourceOffsetMs: 0,
      at: AT,
    }),
  );
  ok(ledger.interruptOccurrence({ trackKey: track.trackKey, sourceOffsetMs: 300_000, at: AT }));

  const duplicate = ok(
    ledger.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey: "occ-1",
      sourceOffsetMs: 0,
      at: "2026-09-23T05:10:00.000Z",
    }),
  );
  expect(duplicate.occurrenceKey).toBe("occ-1");
  expect(duplicate.sourceOffsetMs).toBe(300_000);
  expect(duplicate.state).toBe("interrupted");
  expect(duplicate.interruptedAt).not.toBeNull();
});

test("[F01] a competing occurrence is refused until the active one is cleared", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [
    ["S01E01", 1],
    ["S01E02", 2],
  ]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  ok(reserve(ledger, track.trackKey, "occ-2", "S01E02"));
  ok(ledger.beginOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-1", at: AT }));

  expect(
    refused(ledger.beginOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-2", at: AT }))
      .reason,
  ).toBe("occurrence-in-progress");
  // Clearing a different occurrence than the one that is active is refused.
  expect(
    refused(
      ledger.clearActiveOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-2", at: AT }),
    ).reason,
  ).toBe("active-occurrence-mismatch");
  expect(ledger.activeOccurrence(track.trackKey)?.occurrenceKey).toBe("occ-1");

  // An explicit clear releases the track so the next occurrence can start.
  ok(ledger.clearActiveOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-1", at: AT }));
  expect(ledger.occurrence("occ-1")?.state).toBe("abandoned");
  expect(
    ok(ledger.beginOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-2", at: AT }))
      .occurrenceKey,
  ).toBe("occ-2");
});

test("a completed occurrence cannot reopen and source offsets stay inside its reservation", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(ledger, [["S01E01", 1]]);
  ok(reserve(ledger, track.trackKey, "occ-1", "S01E01"));
  expect(refused(ledger.beginOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-1", sourceOffsetMs: -1, at: AT })).reason).toBe("invalid-interval");
  ok(ledger.beginOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-1", at: AT }));
  expect(refused(ledger.advanceOccurrenceOffset({ trackKey: track.trackKey, sourceOffsetMs: Number.NaN, at: AT })).reason).toBe("invalid-interval");
  expect(refused(ledger.interruptOccurrence({ trackKey: track.trackKey, sourceOffsetMs: SOURCE_END + 1, at: AT })).reason).toBe("invalid-interval");
  expect(ledger.activeOccurrence(track.trackKey)?.sourceOffsetMs).toBe(0);
  recordFullEvidence(ledger, "occ-1");
  ok(ledger.completeOccurrence({ occurrenceKey: "occ-1", at: AT }));
  expect(refused(ledger.beginOccurrence({ trackKey: track.trackKey, occurrenceKey: "occ-1", at: AT })).reason).toBe("already-credited");
  expect(ledger.activeOccurrence(track.trackKey)).toBeUndefined();
});

test("[F02] a missing E11 does not let E12 jump the floor, and another series stays eligible", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = trackWithEpisodes(
    ledger,
    Array.from({ length: 10 }, (_, index) => [`S01E${String(index + 1).padStart(2, "0")}`, index + 1] as [string, number]),
  );
  for (let episode = 1; episode <= 10; episode += 1) {
    const key = `S01E${String(episode).padStart(2, "0")}`;
    creditEpisode(ledger, track.trackKey, `occ-${key}`, key);
  }
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(10);

  // E11 is genuinely absent from the library; only E12 is registered.
  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01E12",
      trackKey: track.trackKey,
      title: "Home Improvement 12",
      season: 1,
      episode: 12,
      at: AT,
    }),
  );
  ok(reserve(ledger, track.trackKey, "occ-12", "S01E12"));
  recordFullEvidence(ledger, "occ-12");
  expect(
    refused(ledger.completeOccurrence({ occurrenceKey: "occ-12", at: AT })).reason,
  ).toBe("predecessor-incomplete");
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(10);

  // A different series is a different track and remains eligible.
  const other = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: "Night Court", at: AT }),
  );
  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "NC-S01E01",
      trackKey: other.trackKey,
      title: "Night Court 1",
      season: 1,
      episode: 1,
      at: AT,
    }),
  );
  const credited = creditEpisode(ledger, other.trackKey, "occ-nc-1", "NC-S01E01");
  expect(credited.floor.completedEpisodeKey).toBe("NC-S01E01");
  expect(ledger.completionFloor(other.trackKey)?.episode).toBe(1);
});

test("the same series on two channels contends for one floor; an explicit track is independent", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const channelA = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: SERIES, at: AT }),
  );
  const channelB = ok(
    ledger.ensureSeriesTrack({
      channelId: "marktv-movies",
      seriesTitle: "home improvement (1991)",
      at: AT,
    }),
  );
  expect(channelB.trackKey).toBe(channelA.trackKey);

  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01E01",
      trackKey: channelA.trackKey,
      title: "Home Improvement 1",
      season: 1,
      episode: 1,
      at: AT,
    }),
  );
  creditEpisode(ledger, channelA.trackKey, "occ-a", "S01E01", CHANNEL);

  // The second channel re-reserves the same episode and cannot credit it again:
  // both channels share the one floor.
  ok(reserve(ledger, channelB.trackKey, "occ-b", "S01E01", "marktv-movies"));
  recordFullEvidence(ledger, "occ-b");
  expect(refused(ledger.completeOccurrence({ occurrenceKey: "occ-b", at: AT })).reason).toBe(
    "already-credited",
  );
  expect(ledger.completionFloor(channelA.trackKey)?.completedOccurrenceKey).toBe("occ-a");

  // An explicit separate track keeps its own independent floor.
  const separate = ok(
    ledger.ensureSeriesTrack({
      channelId: "marktv-movies",
      seriesTitle: SERIES,
      separateTrack: "marktv-movies",
      at: AT,
    }),
  );
  expect(separate.trackKey).not.toBe(channelA.trackKey);
  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "MOVIES-S01E01",
      trackKey: separate.trackKey,
      title: "Home Improvement 1",
      season: 1,
      episode: 1,
      at: AT,
    }),
  );
  creditEpisode(ledger, separate.trackKey, "occ-sep", "MOVIES-S01E01", "marktv-movies");
  expect(ledger.completionFloor(separate.trackKey)?.completedEpisodeKey).toBe("MOVIES-S01E01");
  expect(ledger.completionFloor(channelA.trackKey)?.completedEpisodeKey).toBe("S01E01");
});

test("an intentionally non-consecutive series advances only by explicit ordinal position", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));

  // Without ordinals, a jump from numbered E01 to E03 is a gap and is held.
  const numbered = trackWithEpisodes(ledger, [
    ["S01E01", 1],
    ["S01E03", 3],
  ]);
  creditEpisode(ledger, numbered.trackKey, "occ-n1", "S01E01");
  ok(reserve(ledger, numbered.trackKey, "occ-n3", "S01E03"));
  recordFullEvidence(ledger, "occ-n3");
  expect(refused(ledger.completeOccurrence({ occurrenceKey: "occ-n3", at: AT })).reason).toBe(
    "predecessor-incomplete",
  );
  expect(ledger.completionFloor(numbered.trackKey)?.episode).toBe(1);

  // Ordinals are the explicit position metadata for a genuinely non-consecutive
  // series; contiguity is then by ordinal, not by episode number.
  const anthology = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: "Anthology", at: AT }),
  );
  for (const [index, episodeNumber] of [4, 9, 15].entries()) {
    const ordinal = index + 1;
    ok(
      ledger.ensureEpisodeIdentity({
        episodeKey: `ANTH-${episodeNumber}`,
        trackKey: anthology.trackKey,
        title: `Anthology ${episodeNumber}`,
        ordinal,
        at: AT,
      }),
    );
  }
  for (const episodeNumber of [4, 9, 15]) {
    const credited = creditEpisode(
      ledger,
      anthology.trackKey,
      `occ-anth-${episodeNumber}`,
      `ANTH-${episodeNumber}`,
    );
    expect(credited.floor.completedEpisodeKey).toBe(`ANTH-${episodeNumber}`);
  }
  expect(ledger.completionFloor(anthology.trackKey)?.ordinal).toBe(3);
});

test("a late-registered episode cannot open a track without an explicit initial position", async () => {
  const ledger = createAiringLedger(openDatabase(await dataDir()));
  const track = ok(
    ledger.ensureSeriesTrack({ channelId: CHANNEL, seriesTitle: SERIES, at: AT }),
  );
  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01E12",
      trackKey: track.trackKey,
      title: "Home Improvement 12",
      season: 1,
      episode: 12,
      at: AT,
    }),
  );
  ok(reserve(ledger, track.trackKey, "occ-12", "S01E12"));
  recordFullEvidence(ledger, "occ-12");

  // E12 is the only registered identity, but "first registered" is not a
  // trustworthy start.
  expect(
    refused(ledger.completeOccurrence({ occurrenceKey: "occ-12", at: AT })).reason,
  ).toBe("predecessor-incomplete");
  expect(ledger.completionFloor(track.trackKey)).toBeUndefined();

  // A migrated/explicit initial position makes the legitimate start trustworthy.
  ok(ledger.establishInitialPosition({ trackKey: track.trackKey, season: 1, episode: 12, at: AT }));
  const credited = ok(ledger.completeOccurrence({ occurrenceKey: "occ-12", at: AT }));
  expect(credited.floor.completedEpisodeKey).toBe("S01E12");
  expect(ledger.completionFloor(track.trackKey)?.episode).toBe(12);
});
