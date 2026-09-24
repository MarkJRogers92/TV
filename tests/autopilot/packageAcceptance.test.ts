import { access, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import fixturePack from "../fixtures/marktvAutopilotAcceptance.json";
import { openDatabase } from "../../src/db/database.js";
import {
  createAiringLedger,
  type AiringWriteResult,
} from "../../src/autopilot/airingLedger.js";
import {
  createSourceContinuation,
  durablePublishedContiguousEnd,
  type ContinuationResult,
} from "../../src/autopilot/sourceContinuation.js";
import type { MediaItem, Pool } from "../../src/domain/models.js";
import { selectCandidate } from "../../src/scheduler/select.js";
import { DateTime } from "luxon";
import {
  assignMovieOccurrences,
  buildMovieRotation,
  movieExposureIndex,
  movieNightlyMinSpacingDays,
  spacedNightlyMovie,
} from "../../src/scheduler/movieProgramming.js";
import { movieFixture } from "../support/movieFixture.js";
import { LocalFolderAdapter } from "../../src/media/localFolder.js";
import { persistScannedMedia } from "../../src/media/catalogReconcile.js";
import { createRepositories } from "../../src/db/repositories.js";
import { ensureMovieProgrammingPool } from "../../src/media/movieEnrollment.js";
import {
  decideEmergencyFallback,
  loadVerifiedEmergencyFallbackPool,
} from "../../src/autopilot/emergencyFallback.js";
import {
  movieOccurrenceKey,
  rotationMediaId,
  rotationOrdinal,
} from "../../src/domain/movieProgramming.js";
import type { MovieOccurrence } from "../../src/domain/movieProgramming.js";
import { evaluateContinuityHealth } from "../../src/autopilot/continuityHealth.js";
import {
  cleanupRepositoryFixtures,
  makeScheduleService,
  openMovieRepositories,
} from "../support/repositoryFixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await cleanupRepositoryFixtures();
});

async function newLedger() {
  const directory = await mkdtemp(join(tmpdir(), "marktv-package-acceptance-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(directory);
  return { directory, database, ledger: createAiringLedger(database) };
}

type PackageWriteResult<T> = AiringWriteResult<T> | ContinuationResult<T>;

function accepted<T>(result: PackageWriteResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  return result.value;
}

function refused<T>(result: PackageWriteResult<T>) {
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

function scenario(id: string) {
  const item = fixturePack.scenarios.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing package scenario ${id}`);
  return item;
}

async function compileDstMovieScenario(
  scenarioId: "F14" | "F15",
  override?: {
    date?: string;
    resolvedTarget?: string;
    nowInstants?: [string, string, string];
  },
) {
  const fixtureScenario = scenario(scenarioId);
  const given = fixtureScenario.given as {
    timezone: string;
    nightly_slot_local_date: string;
    target: string;
  };
  const fixtureExpected = fixtureScenario.expected as {
    resolved_target: string;
    slot_count: number;
  };
  const date = override?.date ?? given.nightly_slot_local_date;
  const resolvedTarget = DateTime.fromISO(
    override?.resolvedTarget ?? fixtureExpected.resolved_target,
    { setZone: true },
  );
  const expectedStart = resolvedTarget.toUTC().toISO();
  const expectedLocalStart = resolvedTarget
    .setZone(given.timezone)
    .toFormat("HH:mm");
  const localDayStart = DateTime.fromISO(date, { zone: given.timezone }).startOf("day");
  const expectedDayDurationMs = localDayStart
    .plus({ days: 1 })
    .diff(localDayStart)
    .as("milliseconds");
  const defaultNow = `${date}T12:00:00.000Z`;
  const nowInstants = override?.nowInstants ?? [defaultNow, defaultNow, defaultNow];
  let nowIndex = 0;
  const now = () => new Date(nowInstants[nowIndex]);
  const fixture = await openMovieRepositories({
    timezone: given.timezone,
    programming: { nightlyAnchor: given.target },
    now,
  });
  const channel = fixture.fixture.channel;
  let closeRepositories = fixture.close;
  try {
    if (override?.nowInstants) {
      const beforeRollback = DateTime.fromISO(nowInstants[0], { setZone: true })
        .setZone(given.timezone);
      const afterRollback = DateTime.fromISO(nowInstants[1], { setZone: true })
        .setZone(given.timezone);
      expect(beforeRollback.toFormat("HH:mm")).toBe("01:55");
      expect(beforeRollback.offset).toBe(-300);
      expect(afterRollback.toFormat("HH:mm")).toBe("01:05");
      expect(afterRollback.offset).toBe(-360);
    }

    const assertNightly = (result: Awaited<ReturnType<typeof fixture.service.generate>>) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return undefined;
      expect(result.schedule.durationMs).toBe(expectedDayDurationMs);
      const nightly = result.schedule.entries.filter(
        (entry) => entry.movieOccurrenceKey === `${date}:nightly`,
      );
      expect(nightly).toHaveLength(fixtureExpected.slot_count);
      expect(nightly[0]).toMatchObject({
        start: expectedStart,
        localStart: expectedLocalStart,
      });
      return nightly[0];
    };

    const first = await fixture.service.generate(channel, date);
    const firstNightly = assertNightly(first);
    if (!firstNightly) return;

    const assignment = fixture.repositories.movieOccurrences.get(
      channel.id,
      date,
      "nightly",
    );
    expect(assignment?.date).toBe(date);
    expect(firstNightly.mediaId).toBe(assignment?.mediaId);

    // F15's supplied events cross the repeated 01:00 hour. Recompile once
    // after the wall clock moves backward without closing the repository.
    nowIndex = 1;
    const afterRollback = await fixture.service.generate(channel, date);
    const afterRollbackNightly = assertNightly(afterRollback);
    expect(afterRollbackNightly?.mediaId).toBe(assignment?.mediaId);
    expect(
      fixture.repositories.movieOccurrences
        .listForDate(channel.id, date)
        .filter((occurrence) => occurrence.position === "nightly"),
    ).toHaveLength(fixtureExpected.slot_count);

    // Closing and reopening the repository models scheduler restart. Recompile
    // after the rollback through the persisted occurrence ledger.
    nowIndex = 2;
    const reopened = fixture.reopen();
    closeRepositories = () => reopened.close();
    const restarted = await makeScheduleService(
      reopened,
      fixture.dataDir,
      now,
    ).generate(channel, date);
    const restartedNightly = assertNightly(restarted);
    expect(restartedNightly?.mediaId).toBe(assignment?.mediaId);
    expect(
      reopened.movieOccurrences
        .listForDate(channel.id, date)
        .filter((occurrence) => occurrence.position === "nightly"),
    ).toHaveLength(fixtureExpected.slot_count);
  } finally {
    closeRepositories();
  }
}

test("package F14: spring 02:00 fixture target is scheduled once at its first valid instant", async () => {
  await compileDstMovieScenario("F14");
});

test("package F15: fall fixture creates one overnight movie through scheduler restart", async () => {
  await compileDstMovieScenario("F15", {
    nowInstants: [
      "2026-11-01T06:55:00.000Z",
      "2026-11-01T07:05:00.000Z",
      "2026-11-01T07:05:00.000Z",
    ],
  });
});

test("2027 spring 02:00 movie airs once at the first valid instant", async () => {
  await compileDstMovieScenario("F14", {
    date: "2027-03-14",
    resolvedTarget: "2027-03-14T03:00:00-05:00",
  });
});

test("2027 fall transition does not duplicate the overnight movie after restart", async () => {
  await compileDstMovieScenario("F15", {
    date: "2027-11-07",
    resolvedTarget: "2027-11-07T02:00:00-06:00",
    nowInstants: [
      "2027-11-07T06:55:00.000Z",
      "2027-11-07T07:05:00.000Z",
      "2027-11-07T07:05:00.000Z",
    ],
  });
});

test("package F01: restart restores fixture active occurrence, offset, and ordered reservations", async () => {
  const fixture = scenario("F01");
  const given = fixture.given as {
    track: string;
    completed_through: number;
    active: { occurrence: string; episode: number; source_offset_seconds: number };
    reserved: number[];
  };
  const expected = fixture.expected as {
    same_active_occurrence: string;
    next_episode: number;
    completed_through_before_more_airing: number;
  };
  const { directory, database, ledger: first } = await newLedger();
  const track = accepted(
    first.ensureSeriesTrack({ channelId: "package-f01-channel", seriesTitle: given.track }),
  );
  const episodeKey = (episode: number) => `package-f01-${given.track}-episode-${episode}`;
  const occurrenceKey = (episode: number) =>
    episode === given.active.episode ? given.active.occurrence : `a${episode}`;

  for (let episode = 1; episode <= Math.max(given.completed_through, ...given.reserved); episode += 1) {
    accepted(
      first.ensureEpisodeIdentity({
        episodeKey: episodeKey(episode),
        trackKey: track.trackKey,
        title: `${given.track} ${episode}`,
        season: 1,
        episode,
      }),
    );
  }
  for (let episode = 1; episode <= given.completed_through; episode += 1) {
    const key = episodeKey(episode);
    const occurrence = occurrenceKey(episode);
    accepted(
      first.reserveOccurrence({
        occurrenceKey: occurrence,
        trackKey: track.trackKey,
        episodeKey: key,
        channelId: "package-f01-channel",
        plannedStart: "2026-09-23T00:00:00.000Z",
        plannedEnd: "2026-09-23T00:24:00.000Z",
        sourceMediaId: `${key}-source`,
        sourceStartMs: 0,
        sourceEndMs: 1_440_000,
      }),
    );
    accepted(
      first.recordPublishedInterval({
        intervalId: `${occurrence}-published`,
        occurrenceKey: occurrence,
        sourceStartMs: 0,
        sourceEndMs: 1_440_000,
        publishedAt: "2026-09-23T00:24:00.000Z",
        evidence: "fixture-publisher-ack",
      }),
    );
    accepted(
      first.recordAiredInterval({
        intervalId: `${occurrence}-aired`,
        occurrenceKey: occurrence,
        sourceStartMs: 0,
        sourceEndMs: 1_440_000,
        airedAt: "2026-09-23T00:24:00.000Z",
        evidence: "fixture-player-observation",
      }),
    );
    accepted(first.completeOccurrence({ occurrenceKey: occurrence }));
  }

  accepted(
    first.reserveOccurrence({
      occurrenceKey: occurrenceKey(given.active.episode),
      trackKey: track.trackKey,
      episodeKey: episodeKey(given.active.episode),
      channelId: "package-f01-channel",
      plannedStart: "2026-09-24T00:00:00.000Z",
      plannedEnd: "2026-09-24T00:24:00.000Z",
      sourceMediaId: `${episodeKey(given.active.episode)}-source`,
      sourceStartMs: 0,
      sourceEndMs: 1_440_000,
    }),
  );
  for (const episode of given.reserved) {
    accepted(
      first.reserveOccurrence({
        occurrenceKey: occurrenceKey(episode),
        trackKey: track.trackKey,
        episodeKey: episodeKey(episode),
        channelId: "package-f01-channel",
        plannedStart: "2026-09-24T00:00:00.000Z",
        plannedEnd: "2026-09-24T00:24:00.000Z",
        sourceMediaId: `${episodeKey(episode)}-source`,
        sourceStartMs: 0,
        sourceEndMs: 1_440_000,
      }),
    );
  }
  accepted(
    first.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey: occurrenceKey(given.active.episode),
      attemptId: "package-f01-active-attempt",
      sourceMediaId: `${episodeKey(given.active.episode)}-source`,
      sourceOffsetMs: 0,
    }),
  );
  accepted(
    first.advanceOccurrenceOffset({
      trackKey: track.trackKey,
      sourceOffsetMs: given.active.source_offset_seconds * 1_000,
    }),
  );
  // Re-open the same SQLite directory to exercise durable state after scheduler restart.
  database.close();
  const restartedDatabase = openDatabase(directory);
  const restarted = createAiringLedger(restartedDatabase);
  const active = restarted.activeOccurrence(track.trackKey);
  expect(active?.occurrenceKey).toBe(expected.same_active_occurrence);
  expect(active?.sourceOffsetMs).toBe(given.active.source_offset_seconds * 1_000);
  expect(restarted.completionFloor(track.trackKey)?.episode).toBe(expected.completed_through_before_more_airing);
  expect(restarted.occurrence(occurrenceKey(given.reserved[0]))?.episodeKey).toBe(
    episodeKey(expected.next_episode),
  );
  expect(restarted.occurrencesForTrack(track.trackKey).filter(({ state }) => state === "reserved"))
    .toHaveLength(given.reserved.length);
  expect(
    refused(
      restarted.beginOccurrence({
        trackKey: track.trackKey,
        occurrenceKey: occurrenceKey(expected.next_episode),
      }),
    ).reason,
  ).toBe("occurrence-in-progress");
  restartedDatabase.close();
});

test("package F03: render-ahead publication reserves a movie without airing credit", async () => {
  const fixture = scenario("F03");
  const given = fixture.given as { planned_movie: string; planned_start: string; now: string };
  const expected = fixture.expected as {
    movie_actual_air_count: number;
    episode_cursor_advance: boolean;
  };
  const { database, ledger } = await newLedger();
  // The ledger models movies with its generic episode identity so this adapter
  // can verify the same durable reservation and airing-credit boundary.
  const track = accepted(
    ledger.ensureSeriesTrack({ channelId: "package-f03-channel", seriesTitle: given.planned_movie }),
  );
  accepted(
    ledger.ensureEpisodeIdentity({
      episodeKey: `package-f03-${given.planned_movie}`,
      trackKey: track.trackKey,
      title: given.planned_movie,
      ordinal: 1,
    }),
  );
  const occurrenceKey = "package-f03-movie-occurrence";
  accepted(
    ledger.reserveOccurrence({
      occurrenceKey,
      trackKey: track.trackKey,
      episodeKey: `package-f03-${given.planned_movie}`,
      channelId: "package-f03-channel",
      plannedStart: new Date(given.planned_start).toISOString(),
      plannedEnd: new Date(new Date(given.planned_start).getTime() + 90 * 60_000).toISOString(),
      sourceMediaId: given.planned_movie,
      sourceStartMs: 0,
      sourceEndMs: 90 * 60_000,
      at: new Date(given.now).toISOString(),
    }),
  );
  accepted(
    ledger.recordPublishedInterval({
      intervalId: `${occurrenceKey}-rendered-future-segment`,
      occurrenceKey,
      sourceStartMs: 0,
      sourceEndMs: 90 * 60_000,
      publishedAt: new Date(given.now).toISOString(),
      evidence: "fixture-future-segment-published",
    }),
  );

  expect(ledger.occurrence(occurrenceKey)).toBeDefined();
  expect(ledger.airedIntervals(occurrenceKey)).toHaveLength(expected.movie_actual_air_count);
  expect(ledger.evaluateOccurrence(occurrenceKey)?.complete).toBe(false);
  expect(refused(ledger.completeOccurrence({ occurrenceKey })).reason).toBe("insufficient-evidence");
  expect(ledger.completionFloor(track.trackKey) !== undefined).toBe(expected.episode_cursor_advance);
  database.close();
});

test("package F11: missing external media produces a source-only fallback plan", async ({ skip }) => {
  const fixture = scenario("F11");
  const given = fixture.given as {
    media_volume_present: boolean;
    internal_emergency_pool_ready: boolean;
    trusted_history_present: boolean;
  };
  const expected = fixture.expected as {
    playout: string;
    create_empty_external_mount_path: boolean;
    reset_histories: boolean;
    delete_missing_catalog_items: boolean;
  };
  const internalRoot = join(homedir(), "Library/Application Support/MarkTV/emergency-assets/v1-20260923");
  try {
    await access(join(internalRoot, "manifest.json"));
  } catch {
    skip();
    return;
  }
  const pool = await loadVerifiedEmergencyFallbackPool(internalRoot);
  expect(given.internal_emergency_pool_ready).toBe(true);
  expect(pool.ok).toBe(true);
  const plan = decideEmergencyFallback({
    externalVolumePresent: given.media_volume_present,
    pool,
    enabledChannels: [
      { id: "38fec30b-1534-4520-9a51-2e39c925cddc" },
      { id: "95c24cf1-4c7e-42e8-8814-8bbd5173f0b8" },
      { id: "3d3861ae-b913-4848-9512-1180e631732a" },
    ],
  });

  expect(given.trusted_history_present).toBe(true);
  expect(
    plan.channels.every(({ action }) => action === "internal-emergency-loop")
      ? "internal_emergency"
      : "unavailable",
  ).toBe(expected.playout);
  expect(plan.activation).toBe("not-activated");
  expect(plan.channels.map(({ action }) => action)).toEqual([
    "internal-emergency-loop",
    "internal-emergency-loop",
    "internal-emergency-loop",
  ]);
  expect(plan.channels.map(({ channelId }) => channelId)).toEqual([
    "38fec30b-1534-4520-9a51-2e39c925cddc",
    "95c24cf1-4c7e-42e8-8814-8bbd5173f0b8",
    "3d3861ae-b913-4848-9512-1180e631732a",
  ]);
  expect(plan.assetIds).toEqual([
    "marktv-technical-difficulties",
    "764cc42abbec91c9e1a9-02-more-television-shortly",
  ]);
  expect(plan.preservation.externalMountPathCreated)
    .toBe(expected.create_empty_external_mount_path);
  expect(plan.preservation.historyReset).toBe(expected.reset_histories);
  expect(plan.preservation.catalogChanged).toBe(expected.delete_missing_catalog_items);
});

test("package F02: an absent successor holds only its series", () => {
  const fixture = scenario("F02");
  const given = fixture.given as {
    series_a_completed: number;
    series_a_next: number;
    series_a_available_episodes: number[];
    series_b_next: number;
  };
  const episode = (series: "a" | "b", number: number): MediaItem => ({
    id: `series_${series}_episode_${number}`,
    source: "placeholder",
    kind: "episode",
    title: `Episode ${number}`,
    showTitle: `Series ${series.toUpperCase()}`,
    season: 1,
    episode: number,
    durationMs: 30 * 60_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  });
  const a = given.series_a_available_episodes.map((number) => episode("a", number));
  const b = [episode("b", given.series_b_next)];
  const items = [...a, episode("b", given.series_b_next - 1), ...b];
  const pool: Pool = {
    id: "package-f02",
    name: "Package F02",
    kinds: ["episode"],
    mediaIds: items.map(({ id }) => id),
    mode: "chronological",
    noRepeatMinutes: 0,
    weight: 1,
  };
  const history = [
    { mediaId: `series_a_episode_${given.series_a_completed}`, at: "2026-09-23T02:00:00.000Z" },
    { mediaId: `series_b_episode_${given.series_b_next - 1}`, at: "2026-09-23T01:00:00.000Z" },
  ];
  const selected = selectCandidate({
    pool,
    items,
    kind: "episode",
    history,
    at: "2026-09-23T03:00:00.000Z",
    seed: "package-f02",
  });
  expect(selected.item?.id).toBe(fixture.expected.select);
  for (const excluded of fixture.expected.must_not_select as string[]) {
    expect(selected.item?.id).not.toBe(excluded);
  }
  expect(given.series_a_available_episodes).not.toContain(given.series_a_next);
});

test("package F04: a scheduled Saturday opener links one stable overnight encore", () => {
  const fixture = scenario("F04");
  const given = fixture.given as {
    evening_opener_occurrence: string;
    content_id: string;
    evening_start: string;
    evening_completed_successfully: boolean;
  };
  const expected = fixture.expected as {
    encore_start_target: string;
    encore_parent: string;
    encore_occurrence_count: number;
  };
  const { channel, movies } = movieFixture();
  const date = DateTime.fromISO(given.evening_start, { setZone: true })
    .setZone(channel.timezone)
    .toISODate()!;
  const baseRotation = buildMovieRotation({
    channelId: channel.id,
    eligibleIds: [given.content_id, ...movies.slice(1).map(({ id }) => id)],
    epochDate: date,
    now: new Date(given.evening_start),
  });
  const openerOrdinal = rotationOrdinal(
    date,
    date,
    "double-feature-1",
  );
  const rotation = {
    ...baseRotation,
    order: baseRotation.order.map((id, index) =>
      index === openerOrdinal ? given.content_id : id,
    ),
  };
  const ledger = new Map<string, MovieOccurrence>();
  const resolve = (targetDate: string) => {
    const result = assignMovieOccurrences({
      channelId: channel.id,
      date: targetDate,
      programming: channel.movieProgramming!,
      rotation,
      existing: (sourceDate, position) =>
        ledger.get(movieOccurrenceKey(sourceDate, position)),
      resolvedAt: new Date(given.evening_start).toISOString(),
      actualExposure:
        targetDate > date && given.evening_completed_successfully
          ? [{ mediaId: given.content_id, date }]
          : [],
      verifiedCompletedOccurrences:
        targetDate > date && given.evening_completed_successfully
          ? new Set([movieOccurrenceKey(date, "double-feature-1")])
          : new Set(),
    });
    for (const occurrence of result.occurrences)
      ledger.set(movieOccurrenceKey(occurrence.date, occurrence.position), occurrence);
    return result;
  };

  const opener = resolve(date).forDate.find(
    ({ position }) => position === "double-feature-1",
  );
  expect(given.evening_completed_successfully).toBe(true);
  expect(opener?.mediaId).toBe(given.content_id);
  const encoreDate = DateTime.fromISO(date, { zone: channel.timezone })
    .plus({ days: 1 })
    .toISODate()!;
  const encore = resolve(encoreDate).forDate.find(
    ({ position }) => position === "nightly",
  );
  const encoreInstant = DateTime.fromISO(
    `${encore?.date}T${encore?.anchor}`,
    { zone: channel.timezone },
  );
  expect(encoreInstant.toISO()).toBe(
    DateTime.fromISO(expected.encore_start_target, { setZone: true })
      .setZone(channel.timezone)
      .toISO(),
  );
  expect(encore).toMatchObject({
    role: "encore",
    mediaId: given.content_id,
    consumes: false,
  });
  const fixtureOccurrenceId = new Map([
    [movieOccurrenceKey(date, "double-feature-1"), given.evening_opener_occurrence],
  ]);
  expect(fixtureOccurrenceId.get(encore?.encoreOf ?? "")).toBe(expected.encore_parent);

  // A repeated refresh/restart resolves the persisted key without adding another
  // occurrence. The API models the link and draw semantics; it has no separate
  // exception-reason or completion-proof fields to assert here.
  resolve(encoreDate);
  const matchingEncores = [...ledger.values()].filter(
    ({ encoreOf }) =>
      fixtureOccurrenceId.get(encoreOf ?? "") === expected.encore_parent,
  );
  expect(matchingEncores).toHaveLength(expected.encore_occurrence_count);
  expect(encore?.consumes).toBe(false);
});

test("package F05: a failed opener cannot become an encore instead of the ordinary alternative", () => {
  const fixture = scenario("F05");
  const given = fixture.given as {
    opener: string;
    opener_state: string;
    ordinary_alternative: string;
    alternative_ready: boolean;
  };
  const expected = fixture.expected as {
    select: string;
    must_not_select: string;
    ordinary_spacing_checks_required: boolean;
  };
  const { channel } = movieFixture();
  const saturday = "2026-09-26";
  const sunday = "2026-09-27";
  const rotation = buildMovieRotation({
    channelId: channel.id,
    eligibleIds: [given.opener, given.ordinary_alternative],
    epochDate: saturday,
    now: new Date("2026-09-26T12:00:00.000Z"),
  });
  const opener: MovieOccurrence = {
    channelId: channel.id,
    date: saturday,
    position: "double-feature-1",
    role: "weekend-opener",
    anchor: channel.movieProgramming!.weekendAnchor,
    mediaId: given.opener,
    consumes: true,
    resolvedAt: "2026-09-26T12:00:00.000Z",
  };
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: sunday,
    programming: channel.movieProgramming!,
    rotation,
    existing: (date, position) =>
      date === saturday && position === "double-feature-1" ? opener : undefined,
    resolvedAt: "2026-09-27T07:00:00.000Z",
    actualExposure: [],
    verifiedCompletedOccurrences: new Set(),
  });
  const selected = result.forDate.find(({ position }) => position === "nightly");

  expect(given.opener_state).toBe("failed_before_air");
  expect(given.alternative_ready).toBe(true);
  expect(selected?.mediaId).toBe(expected.select);
  expect(selected?.mediaId).not.toBe(expected.must_not_select);
  expect(selected?.encoreOf).toBeUndefined();
  expect(selected?.consumes).toBe(true);
  expect(expected.ordinary_spacing_checks_required).toBe(true);
  const scarce = assignMovieOccurrences({
    channelId: channel.id,
    date: sunday,
    programming: channel.movieProgramming!,
    rotation,
    existing: (date, position) =>
      date === saturday && position === "double-feature-1" ? opener : undefined,
    resolvedAt: "2026-09-27T07:00:00.000Z",
    actualExposure: [{ mediaId: given.ordinary_alternative, date: saturday }],
    verifiedCompletedOccurrences: new Set(),
  });
  expect(scarce.forDate.find(({ position }) => position === "nightly")?.mediaId)
    .toBe(expected.select);
  expect(scarce.diagnostics.map(({ code }) => code))
    .toContain("MOVIE_NIGHTLY_SPACING_SHORTAGE");

  // With a three-film bag, the Sunday opener's failed Monday encore takes the
  // reserved closer's film. Filtering the bad opener must not shift that draw
  // onto Tuesday's normal film.
  const threeFilmRotation = {
    ...rotation,
    epochDate: "2026-09-21",
    order: [given.opener, given.ordinary_alternative, "movie_c"],
  };
  const sundayOpener = { ...opener, date: sunday };
  const mondayReplacement = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-28",
    programming: channel.movieProgramming!,
    rotation: threeFilmRotation,
    existing: (date, position) =>
      date === sunday && position === "double-feature-1" ? sundayOpener : undefined,
    resolvedAt: "2026-09-28T07:00:00.000Z",
    actualExposure: [],
    verifiedCompletedOccurrences: new Set(),
  }).forDate.find(({ position }) => position === "nightly");
  expect(mondayReplacement?.mediaId).toBe(given.ordinary_alternative);
  expect(rotationMediaId(threeFilmRotation, "2026-09-29", "nightly"))
    .toBe("movie_c");
});

test("package F06: a same-filesystem rename keeps the movie's catalog identity and repeat history", async () => {
  const fixture = scenario("F06");
  const given = fixture.given as {
    content_id: string;
    last_nightly_air: string;
    now: string;
    ordinary_alternative: string;
  };
  const expected = fixture.expected as {
    logical_movie_count_for_a: number;
    next_ordinary_nightly_pick: string;
    movie_a_still_recent: boolean;
  };
  const { database } = await newLedger();
  const repositories = createRepositories(database);

  // Drive the real catalog path: scan a library, persist it, rename the source
  // on the same filesystem, and rescan. The scanner mints IDs from the path, so
  // without a stable file identity the rename would fork a second logical movie
  // and lose the first one's exposure history.
  //
  // The root is resolved because the adapter records `realpath`d paths, and on
  // macOS `tmpdir()` is itself a symlink (`/var` -> `/private/var`).
  const library = await realpath(
    await mkdtemp(join(tmpdir(), "marktv-package-f06-media-")),
  );
  temporaryDirectories.push(library);
  const moviesDirectory = join(library, "Movies");
  const renditionDirectory = join(moviesDirectory, "renditions");
  await mkdir(renditionDirectory, { recursive: true });
  const originalPath = join(moviesDirectory, "Movie A Original.mkv");
  const alternativePath = join(moviesDirectory, "Movie B.mkv");
  await Promise.all([
    writeFile(originalPath, "fixture"),
    writeFile(alternativePath, "fixture"),
  ]);

  const adapter = new LocalFolderAdapter(async () => 120_000);
  const firstScan = await adapter.scan(library);
  persistScannedMedia(repositories, firstScan.items);
  const original = repositories.media.list().find(({ path }) => path === originalPath)!;
  const alternative = repositories.media.list().find(({ path }) => path === alternativePath)!;
  expect(original.kind).toBe("movie");
  expect(alternative.kind).toBe("movie");
  // The recorded identity is the file's dev+ino, which is what survives a rename.
  expect(original.deviceId).toBeTruthy();
  expect(original.inode).toBeTruthy();

  const timezone = "America/Chicago";
  const airDate = DateTime.fromISO(given.last_nightly_air, { setZone: true })
    .setZone(timezone)
    .toISODate()!;
  const pickDate = DateTime.fromISO(given.now, { setZone: true })
    .setZone(timezone)
    .toISODate()!;
  const exposure = movieExposureIndex([
    { mediaId: original.id, date: airDate },
  ]);

  // The rename keeps the inode; the normalized rendition is a *different* file
  // under the same title, which must never be auto-merged by name or bytes.
  const normalizedPath = join(moviesDirectory, "Movie A Normalized.mkv");
  const renditionPath = join(renditionDirectory, "Movie A Normalized.mkv");
  await rename(originalPath, normalizedPath);
  await writeFile(renditionPath, "fixture");

  const rescan = await adapter.scan(library);
  const scannedOriginal = rescan.items.find(({ path }) => path === normalizedPath)!;
  const scannedRendition = rescan.items.find(({ path }) => path === renditionPath)!;
  // The scanner itself stays path-derived; reconciliation is what joins the move.
  expect(scannedOriginal.id).not.toBe(original.id);
  expect(scannedOriginal.deviceId).toBe(original.deviceId);
  expect(scannedOriginal.inode).toBe(original.inode);

  // Simulate the old state where a rendition was already enrolled before its
  // explicit provenance was registered. A raw scan never infers provenance.
  persistScannedMedia(repositories, rescan.items);
  const movieSetup = movieFixture({ movieCount: 0 });
  const moviePool = movieSetup.pools.find(({ id }) => id === "movies")!;
  repositories.channels.put({
    ...movieSetup.channel,
    movieProgramming: {
      ...movieSetup.channel.movieProgramming!,
      rootPath: moviesDirectory,
    },
  });
  repositories.pools.put({ ...moviePool, mediaIds: [] });
  const movieChannel = repositories.channels.get(movieSetup.channel.id)!;
  ensureMovieProgrammingPool(repositories, movieChannel);
  expect(repositories.pools.get("movies")?.mediaIds).toEqual(
    [alternative.id, original.id, scannedRendition.id].sort(),
  );

  // The normalization workflow explicitly registers provenance; catalog scans
  // alone never infer it from the shared title, bytes, or renditions folder.
  persistScannedMedia(
    repositories,
    rescan.items.map((item) =>
      item.id === scannedRendition.id
        ? { ...item, sourceMediaId: original.id }
        : item,
    ),
  );

  const renamed = repositories.media.get(original.id)!;
  expect(renamed.path).toBe(normalizedPath);
  expect(renamed.deviceId).toBe(original.deviceId);
  expect(renamed.inode).toBe(original.inode);
  // One logical movie A: the moved file adopts its prior ID and the old path is
  // gone rather than left as a second catalog entry. Nothing reset its history.
  expect(
    repositories.media.list().filter(
      ({ title, sourceMediaId }) =>
        title === "Movie A Normalized" && !sourceMediaId,
    ),
  ).toHaveLength(expected.logical_movie_count_for_a);
  expect(repositories.media.list().some(({ path }) => path === originalPath)).toBe(false);
  // The same-titled rendition stays its own entry: no title-only or byte-merge.
  const sameTitle = repositories.media
    .list()
    .filter(({ title }) => title === "Movie A Normalized");
  expect(sameTitle).toHaveLength(2);
  expect(sameTitle.filter(({ id }) => id === original.id)).toHaveLength(1);
  expect(repositories.media.get(scannedRendition.id)?.id).not.toBe(original.id);
  expect(repositories.media.get(scannedRendition.id)?.sourceMediaId).toBe(original.id);
  // The unrenamed neighbour keeps its own ID and path.
  expect(alternative.deviceId).toBeTruthy();
  expect(repositories.media.get(alternative.id)?.path).toBe(alternativePath);

  // A further scan with nothing changed must not fork the moved file again: the
  // record that already owns the path keeps the prior ID instead of letting a
  // fresh path-derived entry appear beside it.
  persistScannedMedia(repositories, (await adapter.scan(library)).items);
  expect(
    repositories.media.list().filter(({ path }) => path === normalizedPath),
  ).toHaveLength(1);
  expect(repositories.media.get(renamed.id)?.path).toBe(normalizedPath);
  expect(repositories.media.get(scannedRendition.id)?.sourceMediaId).toBe(original.id);
  expect(
    repositories.media.list().filter(({ kind }) => kind === "movie"),
  ).toHaveLength(3);

  ensureMovieProgrammingPool(repositories, movieChannel);
  expect(repositories.pools.get("movies")?.mediaIds).toEqual(
    [alternative.id, renamed.id].sort(),
  );
  expect(repositories.pools.get("movies")?.mediaIds).not.toContain(scannedRendition.id);

  const enrolledMovieIds = repositories.pools.get("movies")!.mediaIds;
  const pick = spacedNightlyMovie({
    order: enrolledMovieIds,
    ordinal: 0,
    date: pickDate,
    lastExposedOn: exposure.lastExposedOn,
  });
  const logicalIds = new Map([
    [given.content_id, renamed.id],
    [given.ordinary_alternative, alternative.id],
  ]);
  const lastMovieADate = exposure.lastExposedOn.get(renamed.id)!;
  const movieAGapDays = DateTime.fromISO(pickDate, { zone: timezone })
    .startOf("day")
    .diff(DateTime.fromISO(lastMovieADate, { zone: timezone }).startOf("day"), "days")
    .days;

  expect(renamed.id).toBe(original.id);
  expect(pick?.mediaId).toBe(logicalIds.get(expected.next_ordinary_nightly_pick));
  expect(pick?.mediaId).not.toBe(renamed.id);
  expect(movieAGapDays < movieNightlyMinSpacingDays).toBe(expected.movie_a_still_recent);
  database.close();
});

test("package F17: a finished series does not wrap to episode one", () => {
  const fixture = scenario("F17");
  const given = fixture.given as {
    series_a_final_episode: number;
    series_a_completed_through: number;
    series_b_next: number;
    series_b_ready: boolean;
  };
  const expected = fixture.expected as {
    select: string;
    series_a_episode_one_replay: boolean;
  };
  const episode = (series: "a" | "b", number: number): MediaItem => ({
    id: `series_${series}_episode_${number}`,
    source: "placeholder",
    kind: "episode",
    title: `Episode ${number}`,
    showTitle: `Series ${series.toUpperCase()}`,
    season: 1,
    episode: number,
    durationMs: 30 * 60_000,
    durationStatus: "ok",
    available:
      series !== "b" || number !== given.series_b_next || given.series_b_ready,
    tags: [],
  });
  const items = [
    ...Array.from({ length: given.series_a_final_episode }, (_, index) =>
      episode("a", index + 1),
    ),
    ...Array.from({ length: given.series_b_next }, (_, index) =>
      episode("b", index + 1),
    ),
  ];
  const pool: Pool = {
    id: "package-f17",
    name: "Package F17",
    kinds: ["episode"],
    mediaIds: items.map(({ id }) => id),
    mode: "chronological",
    noRepeatMinutes: 0,
    weight: 1,
  };
  const selected = selectCandidate({
    pool,
    items,
    kind: "episode",
    history: [
      {
        mediaId: `series_b_episode_${given.series_b_next - 1}`,
        at: "2026-09-23T01:00:00.000Z",
      },
      {
        mediaId: `series_a_episode_${given.series_a_completed_through}`,
        at: "2026-09-23T02:00:00.000Z",
      },
    ],
    at: "2026-09-23T03:00:00.000Z",
    seed: "package-f17",
  });

  expect(selected.item?.id).toBe(expected.select);
  expect(selected.item?.id === "series_a_episode_1").toBe(
    expected.series_a_episode_one_replay,
  );
});

test("package F18: committed future runway does not credit either episode as aired", async () => {
  const fixture = scenario("F18");
  const given = fixture.given as {
    episode_10_source_fully_produced_and_contiguously_committed: boolean;
    episode_10_wall_clock_air_end_in_seconds: number;
    episode_11_reserved_successor: boolean;
  };
  const expected = fixture.expected as {
    may_produce_episode_11_after_committed_episode_10: boolean;
    episode_10_actual_completed_before_due: boolean;
    episode_11_actual_completed: boolean;
  };
  const { database, ledger } = await newLedger();
  const now = "2026-09-24T00:00:00.000Z";
  const sourceEndMs = 24 * 60_000;
  const plannedEnd = new Date(
    Date.parse(now) + given.episode_10_wall_clock_air_end_in_seconds * 1_000,
  ).toISOString();
  const track = accepted(
    ledger.ensureSeriesTrack({
      channelId: "package-f18-channel",
      seriesTitle: "Package F18 Series",
      at: now,
    }),
  );
  for (const episode of [10, 11]) {
    accepted(
      ledger.ensureEpisodeIdentity({
        episodeKey: `package-f18-episode-${episode}`,
        trackKey: track.trackKey,
        title: `Episode ${episode}`,
        season: 1,
        episode,
        at: now,
      }),
    );
  }
  const reserve = (
    episode: number,
    occurrenceKey: string,
    plannedStart: string,
    plannedEnd: string,
  ) =>
    accepted(
      ledger.reserveOccurrence({
        occurrenceKey,
        trackKey: track.trackKey,
        episodeKey: `package-f18-episode-${episode}`,
        channelId: "package-f18-channel",
        plannedStart,
        plannedEnd,
        sourceMediaId: `package-f18-source-${episode}`,
        sourceStartMs: 0,
        sourceEndMs,
        at: now,
      }),
    );
  const episode10 = reserve(
    10,
    "package-f18-occurrence-10",
    now,
    plannedEnd,
  );
  if (given.episode_10_source_fully_produced_and_contiguously_committed) {
    accepted(
      ledger.recordPublishedInterval({
        intervalId: "package-f18-episode-10-committed",
        occurrenceKey: episode10.occurrenceKey,
        sourceStartMs: 0,
        sourceEndMs,
        publishedAt: now,
        evidence: "fixture-contiguous-publication-commit",
        at: now,
      }),
    );
  }
  const successorEnd = new Date(Date.parse(plannedEnd) + sourceEndMs).toISOString();
  const episode11 = given.episode_11_reserved_successor
    ? reserve(
        11,
        "package-f18-occurrence-11",
        plannedEnd,
        successorEnd,
      )
    : undefined;

  expect(ledger.occurrence("package-f18-occurrence-11")?.state).toBe(
    expected.may_produce_episode_11_after_committed_episode_10 ? "reserved" : undefined,
  );
  expect(ledger.evaluateOccurrence(episode10.occurrenceKey)?.contiguousPublished)
    .toBe(given.episode_10_source_fully_produced_and_contiguously_committed);
  expect(ledger.evaluateOccurrence(episode10.occurrenceKey)?.complete)
    .toBe(expected.episode_10_actual_completed_before_due);
  expect(ledger.evaluateOccurrence(episode11?.occurrenceKey ?? "missing")?.complete ?? false)
    .toBe(expected.episode_11_actual_completed);
  expect(ledger.airedIntervals(episode10.occurrenceKey)).toHaveLength(0);
  expect(ledger.airedIntervals(episode11?.occurrenceKey ?? "missing")).toHaveLength(0);
  expect(ledger.completionFloor(track.trackKey)).toBeUndefined();
  expect(refused(ledger.completeOccurrence({ occurrenceKey: episode10.occurrenceKey, at: now })).reason)
    .toBe("insufficient-evidence");
  database.close();
});

test("package F07: two watchdog ticks preserve healthy buffered idle", () => {
  const fixture = scenario("F07");
  const given = fixture.given as {
    ffmpeg_process_count: number;
    contiguous_published_runway_seconds: number;
    scheduled_wake_before_depletion: boolean;
  };
  const observation = {
    channelId: "package-f07-channel",
    watchdogSessionId: "package-f07-session",
    sampleId: "package-f07-tick-1",
    observedAtMs: 1_000,
    workerProcessCount: given.ffmpeg_process_count,
    contiguousPublishedRunwaySeconds: given.contiguous_published_runway_seconds,
    scheduledWakeBeforeDepletion: given.scheduled_wake_before_depletion,
    nextRequiredIntervalAvailable: null,
    progressDeadlineExceeded: false,
  };
  const firstTick = evaluateContinuityHealth(observation);
  const secondTick = evaluateContinuityHealth({
    ...observation,
    sampleId: "package-f07-tick-2",
    observedAtMs: 2_000,
  }, firstTick.state);
  const expected = fixture.expected as { channel_state: string; incident: boolean; restart_count: number };

  expect(secondTick.health).toBe(expected.channel_state);
  expect(secondTick.incident).toBe(expected.incident);
  expect(secondTick.recommendation).toBe("none");
  expect([firstTick, secondTick].filter(({ sharedServiceRestart }) => sharedServiceRestart)).toHaveLength(
    expected.restart_count,
  );
});

test("package F08: confirmed stuck continuation recommends recovery for the affected channel", () => {
  const fixture = scenario("F08");
  const given = fixture.given as {
    ffmpeg_process_count: number;
    contiguous_published_runway_seconds: number;
    next_required_interval_unavailable: boolean;
    progress_deadline_exceeded: boolean;
    healthy_other_channel: boolean;
  };
  const observation = {
    channelId: "package-f08-channel",
    watchdogSessionId: "package-f08-session",
    sampleId: "package-f08-confirmation-1",
    observedAtMs: 1_000,
    workerProcessCount: given.ffmpeg_process_count,
    contiguousPublishedRunwaySeconds: given.contiguous_published_runway_seconds,
    scheduledWakeBeforeDepletion: null,
    nextRequiredIntervalAvailable: !given.next_required_interval_unavailable,
    progressDeadlineExceeded: given.progress_deadline_exceeded,
  };
  // The fixture event is a confirmed-failure tick; the first sample is its
  // preceding watchdog observation, required by the hysteresis contract.
  const priorTick = evaluateContinuityHealth(observation);
  const confirmed = evaluateContinuityHealth({
    ...observation,
    sampleId: "package-f08-confirmation-2",
    observedAtMs: 2_000,
  }, priorTick.state);
  const expected = fixture.expected as {
    action: string;
    other_channel_restart: boolean;
    wait_until_next_program_slot: boolean;
  };
  const actualAction = confirmed.recommendation ===
    "wake_or_repair_continuation_then_fallback_or_channel_recovery"
    ? "affected_channel_recovery_or_ready_fallback"
    : "wait_until_next_program_slot";
  const otherChannel = evaluateContinuityHealth({
    ...observation,
    channelId: "package-f08-healthy-other-channel",
    sampleId: "package-f08-other-channel",
    observedAtMs: 1_000,
    contiguousPublishedRunwaySeconds: given.healthy_other_channel ? 120 : 2,
    nextRequiredIntervalAvailable: given.healthy_other_channel,
    progressDeadlineExceeded: false,
  });

  expect(confirmed.health).toBe("stalled");
  expect(confirmed.recommendation).not.toBe("none");
  expect(confirmed.channelId).toBe("package-f08-channel");
  expect(confirmed.sharedServiceRestart).toBe(expected.other_channel_restart);
  expect(otherChannel.recommendation).toBe("none");
  expect(otherChannel.sharedServiceRestart).toBe(expected.other_channel_restart);
  expect(otherChannel.health === "healthy").toBe(given.healthy_other_channel);
  expect(actualAction).toBe(expected.action);
  expect(actualAction === "wait_until_next_program_slot").toBe(
    expected.wait_until_next_program_slot,
  );
});

/** Registers one occurrence of a single-source item for the continuation tests. */
function continuationFixture(
  ledger: ReturnType<typeof createAiringLedger>,
  options: {
    channelId: string;
    scope: string;
    itemKey: string;
    occurrenceKey: string;
    sourceMediaId: string;
    sourceEndMs: number;
  },
) {
  const track = accepted(
    ledger.ensureSeriesTrack({
      channelId: options.channelId,
      seriesTitle: options.scope,
      separateTrack: options.scope,
    }),
  );
  accepted(
    ledger.ensureEpisodeIdentity({
      episodeKey: options.itemKey,
      trackKey: track.trackKey,
      title: options.scope,
      ordinal: 1,
    }),
  );
  accepted(
    ledger.reserveOccurrence({
      occurrenceKey: options.occurrenceKey,
      trackKey: track.trackKey,
      episodeKey: options.itemKey,
      channelId: options.channelId,
      plannedStart: "2026-09-24T00:00:00.000Z",
      plannedEnd: "2026-09-24T01:30:00.000Z",
      sourceMediaId: options.sourceMediaId,
      sourceStartMs: 0,
      sourceEndMs: options.sourceEndMs,
    }),
  );
  return track;
}

test("package F09: chunk completion continues the same film at its durable published boundary", async () => {
  const fixture = scenario("F09");
  const given = fixture.given as {
    occurrence: string;
    film_source_duration_seconds: number;
    last_contiguous_published_source_end_seconds: number;
    chunk_source_begin_seconds: number;
    chunk_source_end_seconds: number;
    worker_exit_code: number;
  };
  const expected = fixture.expected as {
    next_requested_source_begin_seconds: number;
    same_occurrence: string;
    film_completed: boolean;
    restart_at_source_zero: boolean;
  };
  expect(given.occurrence).toBe(expected.same_occurrence);
  expect(given.last_contiguous_published_source_end_seconds)
    .toBe(expected.next_requested_source_begin_seconds);

  const { database } = await newLedger();
  const continuation = createSourceContinuation(database);
  const ledger = continuation.ledger;
  const occurrenceKey = expected.same_occurrence;
  const track = continuationFixture(ledger, {
    channelId: "package-f09-channel",
    scope: "Package F09 Feature",
    itemKey: "package-f09-feature",
    occurrenceKey,
    sourceMediaId: "package-f09-feature-source",
    sourceEndMs: given.film_source_duration_seconds * 1_000,
  });
  accepted(
    ledger.beginOccurrence({
      trackKey: track.trackKey,
      occurrenceKey,
      attemptId: "package-f09-attempt",
      sourceMediaId: "package-f09-feature-source",
      sourceOffsetMs: 0,
    }),
  );

  // The worker exited zero, but a worker exit proves nothing about content. With
  // no durable publication the continuation holds instead of restarting the film
  // at source zero.
  expect(given.worker_exit_code).toBe(0);
  expect(refused(continuation.planContinuation({ occurrenceKey })).reason)
    .toBe("insufficient-evidence");
  expect(ledger.activeOccurrence(track.trackKey)?.occurrenceKey).toBe(expected.same_occurrence);
  expect(ledger.activeOccurrence(track.trackKey)?.sourceOffsetMs).toBe(0);

  // Two durably published contiguous chunks place the boundary at the end of the
  // whole contiguous run, not at the last chunk's start.
  accepted(
    ledger.recordPublishedInterval({
      intervalId: "package-f09-chunk-1",
      occurrenceKey,
      sourceStartMs: 0,
      sourceEndMs: given.chunk_source_begin_seconds * 1_000,
      publishedAt: "2026-09-24T00:02:00.000Z",
      evidence: "fixture-chunk-1-durably-published",
    }),
  );
  accepted(
    ledger.recordPublishedInterval({
      intervalId: "package-f09-chunk-2",
      occurrenceKey,
      sourceStartMs: given.chunk_source_begin_seconds * 1_000,
      sourceEndMs: given.chunk_source_end_seconds * 1_000,
      publishedAt: "2026-09-24T00:03:00.000Z",
      evidence: "fixture-chunk-2-durably-published",
    }),
  );

  const plan = accepted(continuation.planContinuation({ occurrenceKey }));
  expect(plan.occurrenceKey).toBe(expected.same_occurrence);
  expect(plan.requestedSourceOffsetMs).toBe(expected.next_requested_source_begin_seconds * 1_000);
  expect(plan.requestedSourceOffsetMs).not.toBe(0);
  expect(plan.requestedSourceOffsetMs).toBeLessThan(given.film_source_duration_seconds * 1_000);
  expect(ledger.evaluateOccurrence(occurrenceKey)?.complete).toBe(expected.film_completed);
  expect(ledger.evaluateOccurrence(occurrenceKey)?.complete).toBe(false);
  expect(plan.restartAtSourceZero).toBe(expected.restart_at_source_zero);
  expect(plan.restartAtSourceZero).toBe(false);

  // Applying the plan keeps the same occurrence and advances that occurrence's
  // source offset; no other occurrence is started.
  accepted(
    ledger.advanceOccurrenceOffset({
      trackKey: track.trackKey,
      sourceOffsetMs: plan.requestedSourceOffsetMs,
    }),
  );
  const active = ledger.activeOccurrence(track.trackKey);
  expect(active?.occurrenceKey).toBe(expected.same_occurrence);
  expect(active?.sourceOffsetMs).toBe(expected.next_requested_source_begin_seconds * 1_000);
  database.close();
});

test("source continuation stops at the last published gap and never counts an aired-only interval", async () => {
  const { database } = await newLedger();
  const continuation = createSourceContinuation(database);
  const ledger = continuation.ledger;
  const occurrenceKey = "package-gap-occurrence";
  continuationFixture(ledger, {
    channelId: "package-gap-channel",
    scope: "Package Gap Feature",
    itemKey: "package-gap-feature",
    occurrenceKey,
    sourceMediaId: "package-gap-source",
    sourceEndMs: 1_800_000,
  });
  accepted(
    ledger.recordPublishedInterval({
      intervalId: "package-gap-published-a",
      occurrenceKey,
      sourceStartMs: 0,
      sourceEndMs: 120_000,
      evidence: "fixture-chunk-published",
    }),
  );
  accepted(
    ledger.recordPublishedInterval({
      intervalId: "package-gap-published-b",
      occurrenceKey,
      sourceStartMs: 240_000,
      sourceEndMs: 360_000,
      evidence: "fixture-chunk-published",
    }),
  );
  // An aired observation is not published coverage and cannot bridge the gap.
  accepted(
    ledger.recordAiredInterval({
      intervalId: "package-gap-aired",
      occurrenceKey,
      sourceStartMs: 120_000,
      sourceEndMs: 240_000,
      evidence: "fixture-player-observation",
    }),
  );

  const plan = accepted(continuation.planContinuation({ occurrenceKey }));
  expect(plan.requestedSourceOffsetMs).toBe(120_000);
  expect(plan.restartAtSourceZero).toBe(false);

  database.close();
});

test("source continuation requires matching published coverage and does not credit aired completion", async () => {
  const { database } = await newLedger();
  const continuation = createSourceContinuation(database);
  const ledger = continuation.ledger;
  const occurrenceKey = "package-media-occurrence";
  continuationFixture(ledger, {
    channelId: "package-media-channel",
    scope: "Package Media Feature",
    itemKey: "package-media-feature",
    occurrenceKey,
    sourceMediaId: "package-media-source",
    sourceEndMs: 1_800_000,
  });

  expect(refused(continuation.planContinuation({ occurrenceKey: "package-absent" })).reason)
    .toBe("unknown-occurrence");

  // Publication for a different source media is not coverage of this occurrence.
  accepted(
    ledger.recordPublishedInterval({
      intervalId: "package-media-other",
      occurrenceKey,
      sourceMediaId: "package-media-other-source",
      sourceStartMs: 0,
      sourceEndMs: 600_000,
      evidence: "fixture-other-media-published",
    }),
  );
  expect(refused(continuation.planContinuation({ occurrenceKey })).reason)
    .toBe("insufficient-evidence");

  // Full contiguous publication of this occurrence's own media covers its source.
  accepted(
    ledger.recordPublishedInterval({
      intervalId: "package-media-full",
      occurrenceKey,
      sourceStartMs: 0,
      sourceEndMs: 1_800_000,
      evidence: "fixture-full-published",
    }),
  );
  const result = refused(continuation.planContinuation({ occurrenceKey }));
  expect(result.reason).toBe("source-fully-published");
  // Full producer publication alone is not proof that anyone aired the source,
  // and source exhaustion must not produce an empty-input worker request.
  expect(ledger.evaluateOccurrence(occurrenceKey)?.complete).toBe(false);
  database.close();
});

test("durablePublishedContiguousEnd joins touching intervals, clips, and stops at gaps", () => {
  const intervals = [
    { sourceStartMs: 240_000, sourceEndMs: 360_000 },
    { sourceStartMs: 0, sourceEndMs: 120_000 },
    { sourceStartMs: 120_000, sourceEndMs: 240_000 },
  ];
  expect(durablePublishedContiguousEnd(intervals, 0, 1_800_000)).toBe(360_000);
  expect(durablePublishedContiguousEnd(intervals, 0, 200_000)).toBe(200_000);
  expect(durablePublishedContiguousEnd(intervals, 100_000, 1_800_000)).toBe(360_000);
  expect(durablePublishedContiguousEnd([{ sourceStartMs: 0, sourceEndMs: 5_000_000 }], 0, 1_800_000))
    .toBe(1_800_000);
  expect(durablePublishedContiguousEnd([{ sourceStartMs: 60_000, sourceEndMs: 90_000 }], 0, 1_800_000))
    .toBe(0);
  expect(durablePublishedContiguousEnd([], 0, 1_800_000)).toBe(0);
  expect(durablePublishedContiguousEnd(intervals, 0, 0)).toBe(0);
});
