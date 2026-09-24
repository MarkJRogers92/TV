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
  assignMovieOccurrences,
  buildMovieRotation,
  movieNightlyMinSpacingDays,
  spacedNightlyMovie,
} from "../../src/scheduler/movieProgramming.js";
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
});
