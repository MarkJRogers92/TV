import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import fixturePack from "../fixtures/marktvAutopilotAcceptance.json";
import { openDatabase } from "../../src/db/database.js";
import {
  createAiringLedger,
  type AiringWriteResult,
} from "../../src/autopilot/airingLedger.js";
import type { MediaItem, Pool } from "../../src/domain/models.js";
import { selectCandidate } from "../../src/scheduler/select.js";
import { DateTime } from "luxon";
import {
  assignMovieOccurrences,
  buildMovieRotation,
} from "../../src/scheduler/movieProgramming.js";
import { movieFixture } from "../support/movieFixture.js";
import {
  movieOccurrenceKey,
  rotationMediaId,
  rotationOrdinal,
} from "../../src/domain/movieProgramming.js";
import type { MovieOccurrence } from "../../src/domain/movieProgramming.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function newLedger() {
  const directory = await mkdtemp(join(tmpdir(), "marktv-package-acceptance-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(directory);
  return { directory, database, ledger: createAiringLedger(database) };
}

function accepted<T>(result: AiringWriteResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  return result.value;
}

function refused<T>(result: AiringWriteResult<T>) {
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

function scenario(id: string) {
  const item = fixturePack.scenarios.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing package scenario ${id}`);
  return item;
}

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
