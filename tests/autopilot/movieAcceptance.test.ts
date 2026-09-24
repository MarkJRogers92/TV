/**
 * Acceptance cases MV01-MV16 (movie rotation and clock rules) from the
 * MarkTV_Autopilot_Handoff_2026-09-23 package, mapped onto the real movie
 * programming engine. Each case id is named in its test title so the
 * acceptance index can be matched to a result.
 */
import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";
import type { MovieOccurrence } from "../../src/domain/movieProgramming.js";
import { movieOccurrenceKey } from "../../src/domain/movieProgramming.js";
import {
  anchorInstant,
  assignMovieOccurrences,
  buildMovieRotation,
  movieExposureIndex,
  movieNightlyMinSpacingDays,
  selectMovieBreak,
  spacedNightlyMovie,
} from "../../src/scheduler/movieProgramming.js";
import { eligibleMovieMediaIds } from "../../src/media/movieEnrollment.js";
import { movieFixture } from "../support/movieFixture.js";

describe("movie acceptance (MV)", () => {
  test("MV01 two months of ordinary nightly picks never repeat inside the minimum spacing", () => {
    const { channel, movies } = movieFixture({ movieCount: 30 });
    const order = buildMovieRotation({
      channelId: channel.id,
      eligibleIds: movies.map((movie) => movie.id),
      epochDate: "2026-01-05",
      now: new Date("2026-01-05T00:00:00.000Z"),
    }).order;

    const lastExposedOn = new Map<string, string>();
    let date = DateTime.fromISO("2026-01-05", { zone: channel.timezone });
    const picks: string[] = [];
    for (let night = 0; night < 60; night += 1) {
      const iso = date.toISODate()!;
      const choice = spacedNightlyMovie({ order, ordinal: night, date: iso, lastExposedOn });
      expect(choice).toBeDefined();
      // With 30 ready titles there is always a legal candidate, so an ordinary
      // night must never violate the floor.
      expect(choice!.legal).toBe(true);
      expect(choice!.gapDays).toBeGreaterThanOrEqual(movieNightlyMinSpacingDays);
      picks.push(choice!.mediaId);
      lastExposedOn.set(choice!.mediaId, iso);
      date = date.plus({ days: 1 });
    }
    expect(new Set(picks).size).toBe(30);
  });

  test("MV02 rebuilding the rotation from the same set keeps the bag, order and epoch", () => {
    const { channel, movies } = movieFixture({ movieCount: 12 });
    const eligibleIds = movies.map((movie) => movie.id);
    const first = buildMovieRotation({
      channelId: channel.id,
      eligibleIds,
      epochDate: "2026-09-21",
      now: new Date("2026-09-24T00:00:00.000Z"),
    });
    const again = buildMovieRotation({
      channelId: channel.id,
      eligibleIds,
      existing: first,
      epochDate: "2026-09-21",
      now: new Date("2026-09-24T01:00:00.000Z"),
    });
    expect(again.order).toEqual(first.order);
    expect(again.seed).toBe(first.seed);
    expect(again.epochDate).toBe(first.epochDate);
  });

  const resolvePair = (
    saturday: string,
    sunday: string,
  ): { opener: MovieOccurrence | undefined; encore: MovieOccurrence | undefined; encores: MovieOccurrence[] } => {
    const { channel, movies } = movieFixture();
    const rotation = buildMovieRotation({
      channelId: channel.id,
      eligibleIds: movies.map((movie) => movie.id),
      epochDate: saturday,
      now: new Date(`${saturday}T12:00:00.000Z`),
    });
    const ledger = new Map<string, MovieOccurrence>();
    const resolve = (date: string, completed: boolean) => {
      const openerKey = movieOccurrenceKey(saturday, "double-feature-1");
      const openerExposure = ledger.get(openerKey);
      const result = assignMovieOccurrences({
        channelId: channel.id,
        date,
        programming: channel.movieProgramming!,
        rotation,
        existing: (d, position) => ledger.get(movieOccurrenceKey(d, position)),
        resolvedAt: new Date(`${saturday}T12:00:00.000Z`).toISOString(),
        actualExposure:
          completed && openerExposure
            ? [{ mediaId: openerExposure.mediaId, date: saturday }]
            : [],
        verifiedCompletedOccurrences:
          completed ? new Set([openerKey]) : new Set(),
      });
      for (const occurrence of result.occurrences)
        ledger.set(movieOccurrenceKey(occurrence.date, occurrence.position), occurrence);
      return result;
    };
    const opener = resolve(saturday, false).forDate.find(
      ({ position }) => position === "double-feature-1",
    );
    const encore = resolve(sunday, true).forDate.find(
      ({ position }) => position === "nightly",
    );
    return {
      opener,
      encore,
      encores: [...ledger.values()].filter(({ role }) => role === "encore"),
    };
  };

  test("MV04 a completed Saturday opener yields exactly one linked Sunday overnight encore", () => {
    const { opener, encore, encores } = resolvePair("2026-09-26", "2026-09-27");
    expect(opener?.role).toBe("weekend-opener");
    expect(encore?.role).toBe("encore");
    expect(encore?.mediaId).toBe(opener?.mediaId);
    expect(encore?.consumes).toBe(false);
    expect(encores).toHaveLength(1);
  });

  test("MV05 a completed Sunday opener maps to the NEXT calendar date's overnight slot", () => {
    // 2026-09-27 is a Sunday; its encore lands on Monday 2026-09-28, not the
    // same Sunday morning.
    const { opener, encore, encores } = resolvePair("2026-09-27", "2026-09-28");
    expect(encore?.role).toBe("encore");
    expect(encore?.mediaId).toBe(opener?.mediaId);
    expect(encore?.date).toBe("2026-09-28");
    expect(encores).toHaveLength(1);
  });

  test("MV11 when every candidate is inside cooldown the least recently aired title is chosen", () => {
    const choice = spacedNightlyMovie({
      order: ["a", "b", "c"],
      ordinal: 0,
      date: "2026-09-25",
      lastExposedOn: new Map([
        ["a", "2026-09-23"],
        ["b", "2026-09-24"],
        ["c", "2026-09-22"],
      ]),
    });
    expect(choice).toBeDefined();
    expect(choice!.legal).toBe(false);
    expect(choice!.mediaId).toBe("c");
  });

  test("MV03 a prepared rendition is not a second movie; only the original is eligible", () => {
    const { movies } = movieFixture({ movieCount: 3 });
    const rendition = {
      ...movies[0]!,
      id: `${movies[0]!.id}-normalized`,
      sourceMediaId: movies[0]!.id,
      path: movies[0]!.path!.replace(/\.mkv$/, ".normalized.mkv"),
    };
    const ids = eligibleMovieMediaIds(
      [...movies, rendition],
      "/Volumes/SSK Drive /MarkTV/Movies",
    );
    expect(ids).toEqual(movies.map((movie) => movie.id).sort());
  });

  test("MV12 a new title joins and a quarantined cycle member is dropped, not deadlocked", () => {
    const { channel, movies } = movieFixture({ movieCount: 3 });
    const first = buildMovieRotation({
      channelId: channel.id,
      eligibleIds: movies.map((movie) => movie.id),
      epochDate: "2026-09-21",
      now: new Date("2026-09-21T00:00:00.000Z"),
    });
    const next = buildMovieRotation({
      channelId: channel.id,
      eligibleIds: [movies[0]!.id, movies[2]!.id, "movie-new"],
      existing: first,
      epochDate: "2026-09-21",
      now: new Date("2026-09-22T00:00:00.000Z"),
    });
    expect(next.order).not.toContain(movies[1]!.id);
    expect(next.order).toContain("movie-new");
    // Survivors keep their relative order; the new title is appended.
    expect(next.order.slice(0, 2)).toEqual([movies[0]!.id, movies[2]!.id]);
  });

  test("MV14 the nonexistent spring-forward 2 AM resolves once, forward", () => {
    // 2027-03-14: US DST begins; local 02:00 does not exist that morning.
    const instant = anchorInstant("2027-03-14", "02:00", "America/Chicago");
    expect(instant.hour).toBe(3);
    expect(instant.toUTC().hour).toBe(8); // 03:00 CDT == 08:00Z
  });

  test("MV15 the fall-back overnight target is one token for the local date", () => {
    // 2027-11-07: US DST ends; 02:00 occurs once, as 02:00 CST.
    const instant = anchorInstant("2027-11-07", "02:00", "America/Chicago");
    expect(instant.hour).toBe(2);
    expect(instant.toUTC().hour).toBe(8); // 02:00 CST == 08:00Z
  });

  test("MV09 a small library still plays a diverse cycle and is not starved by the floor", () => {
    const order = ["m1", "m2", "m3", "m4", "m5"];
    const lastExposedOn = new Map<string, string>();
    let date = DateTime.fromISO("2026-09-21", { zone: "America/Chicago" });
    const picks: string[] = [];
    for (let night = 0; night < 10; night += 1) {
      const iso = date.toISODate()!;
      const choice = spacedNightlyMovie({ order, ordinal: night, date: iso, lastExposedOn });
      expect(choice).toBeDefined(); // never leaves a dead night
      picks.push(choice!.mediaId);
      lastExposedOn.set(choice!.mediaId, iso);
      date = date.plus({ days: 1 });
    }
    // Every title is used inside the first cycle rather than deadlocking.
    expect(new Set(picks.slice(0, 5)).size).toBe(5);
  });

  test("MV10 a prospective reservation caps a title's rest so it cannot be double-booked nearby", () => {
    const choice = spacedNightlyMovie({
      order: ["a", "b"],
      ordinal: 0,
      date: "2026-09-25",
      // 'a' aired long ago and would otherwise be the obvious pick...
      lastExposedOn: new Map([["a", "2026-08-01"]]),
      // ...but it is already reserved for tomorrow, so its effective rest is
      // one day and it must not take tonight as well.
      reservedOn: new Map([["a", "2026-09-26"]]),
    });
    expect(choice?.mediaId).toBe("b");
  });

  test("SC05 a break is built from unique whole spots with an exact duration", () => {
    const { channel, media } = movieFixture();
    const selection = selectMovieBreak(
      media,
      channel.movieProgramming!.breakPolicy,
      { seed: "sc05" },
    );
    const ids = selection.items.map((item) => item.id);
    // Hard intra-pod uniqueness: no creative appears twice in one break.
    expect(new Set(ids).size).toBe(ids.length);
    // A break is never empty; there is always some approved spot to air.
    expect(selection.items.length).toBeGreaterThan(0);
    // The advertised duration is exactly the sum of the chosen spots.
    expect(selection.durationMs).toBe(
      selection.items.reduce((total, item) => total + (item.durationMs ?? 0), 0),
    );
  });

  test("MV08 a committed date is not rewritten by a later pass", () => {
    const { channel, movies } = movieFixture({ movieCount: 6 });
    const date = "2026-09-26";
    const rotation = buildMovieRotation({
      channelId: channel.id,
      eligibleIds: movies.map((movie) => movie.id),
      epochDate: "2026-09-21",
      now: new Date("2026-09-21T00:00:00.000Z"),
    });
    const stored: MovieOccurrence = {
      channelId: channel.id,
      date,
      position: "double-feature-1",
      role: "weekend-opener",
      anchor: channel.movieProgramming!.weekendAnchor,
      mediaId: "movie-committed-elsewhere",
      consumes: true,
      resolvedAt: "2026-09-20T00:00:00.000Z",
    };
    const result = assignMovieOccurrences({
      channelId: channel.id,
      date,
      programming: channel.movieProgramming!,
      rotation,
      existing: (d, position) =>
        d === date && position === "double-feature-1" ? stored : undefined,
      resolvedAt: "2026-09-24T00:00:00.000Z",
      // The date is already committed, so nothing may replace it.
      repairable: (d) => d !== date,
    });
    const kept = result.forDate.find(
      ({ position }) => position === "double-feature-1",
    );
    expect(kept).toEqual(stored);
  });

  test("MV06 a failed weekend opener is not encored; the overnight slot takes an ordinary draw", () => {
    const { channel, movies } = movieFixture({ movieCount: 6 });
    const saturday = "2026-09-26";
    const sunday = "2026-09-27";
    const rotation = buildMovieRotation({
      channelId: channel.id,
      eligibleIds: movies.map((movie) => movie.id),
      epochDate: saturday,
      now: new Date(`${saturday}T12:00:00.000Z`),
    });
    const opener: MovieOccurrence = {
      channelId: channel.id,
      date: saturday,
      position: "double-feature-1",
      role: "weekend-opener",
      anchor: channel.movieProgramming!.weekendAnchor,
      mediaId: movies[0]!.id,
      consumes: true,
      resolvedAt: `${saturday}T12:00:00.000Z`,
    };
    const result = assignMovieOccurrences({
      channelId: channel.id,
      date: sunday,
      programming: channel.movieProgramming!,
      rotation,
      existing: (date, position) =>
        date === saturday && position === "double-feature-1" ? opener : undefined,
      resolvedAt: `${sunday}T07:00:00.000Z`,
      actualExposure: [], // the opener failed before airing
      verifiedCompletedOccurrences: new Set(),
    });
    const nightly = result.forDate.find(({ position }) => position === "nightly");
    expect(nightly?.encoreOf).toBeUndefined();
    expect(nightly?.mediaId).not.toBe(opener.mediaId);
    expect(nightly?.consumes).toBe(true);
  });

  test("MV07 an opener and its encore are two exposures but one rotation draw", () => {
    const opener = { mediaId: "movie-01", date: "2026-09-26" };
    const encore = {
      mediaId: "movie-01",
      date: "2026-09-27",
      encoreOf: movieOccurrenceKey("2026-09-26", "double-feature-1"),
    };
    const index = movieExposureIndex([opener, encore]);
    expect(index.cycleConsumption).toBe(1);
    // The later airing is the one that counts as the movie's last exposure.
    expect(index.lastExposedOn.get("movie-01")).toBe("2026-09-27");
    // Two genuinely separate airings DO consume two draws.
    expect(
      movieExposureIndex([opener, { mediaId: "movie-01", date: "2026-09-29" }])
        .cycleConsumption,
    ).toBe(2);
  });

  test("MV16 nothing is credited from a plan, and an encore never adds a second draw", () => {
    const empty = movieExposureIndex([]);
    expect(empty.cycleConsumption).toBe(0);
    expect(empty.lastExposedOn.size).toBe(0);

    const pair = movieExposureIndex([
      { mediaId: "movie-01", date: "2026-09-26" },
      {
        mediaId: "movie-01",
        date: "2026-09-27",
        encoreOf: movieOccurrenceKey("2026-09-26", "double-feature-1"),
      },
    ]);
    expect(pair.cycleConsumption).toBe(1);
  });
});
