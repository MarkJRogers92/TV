import { describe, expect, test } from "vitest";
import type { MediaItem, Schedule, ScheduleEntry } from "../../src/domain/models.js";
import { deriveContinuityContext } from "../../src/continuity/context.js";

const entry = (
  id: string,
  start: string,
  minutes: number,
  kind: ScheduleEntry["kind"],
  title: string,
  mediaId = id,
  extra: Partial<ScheduleEntry> = {},
): ScheduleEntry => {
  const startMs = Date.parse(start);
  const durationMs = minutes * 60_000;
  const end = new Date(startMs + durationMs);
  return {
    id,
    start: new Date(startMs).toISOString(),
    end: end.toISOString(),
    localStart: new Date(startMs).toISOString().slice(11, 16),
    localEnd: end.toISOString().slice(11, 16),
    durationMs,
    kind,
    title,
    mediaId,
    ...extra,
  };
};

const schedule = (entries: ScheduleEntry[]): Schedule => ({
  id: "schedule-2026-09-20",
  channelId: "marktv-laughs",
  date: "2026-09-20",
  timezone: "America/Chicago",
  seed: "seed",
  revision: "revision-7",
  generatedAt: "2026-09-20T12:00:00.000Z",
  durationMs: entries.reduce((sum, item) => sum + item.durationMs, 0),
  entries,
  diagnostics: [],
});

const media = (
  id: string,
  title: string,
  showTitle?: string,
): MediaItem => ({
  id,
  source: "local-folder",
  path: `/media/${id}.mp4`,
  kind: showTitle ? "episode" : "movie",
  title,
  showTitle,
  durationMs: 1_320_000,
  durationStatus: "ok",
  available: true,
  tags: [],
});

describe("deriveContinuityContext", () => {
  test("a break inside an episode returns to that airing and NEXT skips its remaining segments", () => {
    const roseanne12 = entry(
      "roseanne-12",
      "2026-09-20T01:00:00.000Z",
      30,
      "episode",
      "The Monday Thru Friday Show",
      "roseanne-s01e12",
      {
        contentDurationMs: 20 * 60_000,
        midrolls: [{ offsetMs: 10 * 60_000, durationMs: 10 * 60_000 }],
      },
    );
    const ad = entry("ad", roseanne12.end, 2, "commercial", "Commercial");
    const roseanne13 = entry(
      "roseanne-13",
      ad.end,
      30,
      "episode",
      "Bridge Over Troubled Sonny",
      "roseanne-s01e13",
    );
    const nightCourt = entry(
      "night-court-1",
      roseanne13.end,
      30,
      "episode",
      "All You Need Is Love",
      "night-court-s01e01",
    );

    const result = deriveContinuityContext({
      schedules: [schedule([roseanne12, ad, roseanne13, nightCourt])],
      media: [
        media("roseanne-s01e12", "The Monday Thru Friday Show", "Roseanne"),
        media("roseanne-s01e13", "Bridge Over Troubled Sonny", "Roseanne"),
        media("night-court-s01e01", "All You Need Is Love", "Night Court"),
      ],
      insertionInstant: "2026-09-20T01:12:00.000Z",
      managedLineup: true,
    });

    expect(result.returnTarget?.airingId).toBe("roseanne-12");
    expect(result.scheduleRevision).toBe(schedule([roseanne12, ad, roseanne13, nightCourt]).id);
    expect(result.next?.airingId).toBe("roseanne-13");
    expect(result.next?.sameSeriesAsCurrent).toBe(true);
    expect(result.later?.airingId).toBe("night-court-1");
  });

  test("movie segments keep one logical airing identity", () => {
    const movie = entry(
      "movie-entry",
      "2026-09-20T07:00:00.000Z",
      150,
      "movie",
      "Tremors",
      "movie-tremors",
      {
        movieOccurrenceKey: "2026-09-20:nightly",
        contentDurationMs: 120 * 60_000,
        midrolls: [
          { offsetMs: 30 * 60_000, durationMs: 10 * 60_000 },
          { offsetMs: 60 * 60_000, durationMs: 10 * 60_000 },
          { offsetMs: 90 * 60_000, durationMs: 10 * 60_000 },
        ],
      },
    );
    const result = deriveContinuityContext({
      schedules: [schedule([movie])],
      media: [media("movie-tremors", "Tremors")],
      insertionInstant: "2026-09-20T08:05:00.000Z",
      managedLineup: true,
    });

    expect(result.current?.airingId).toBe("2026-09-20:nightly");
    expect(result.returnTarget?.airingId).toBe("2026-09-20:nightly");
    expect(result.next).toBeNull();
  });

  test("midnight presentation says overnight and distinguishes fall-back instants", () => {
    const first = entry(
      "first-130",
      "2026-11-01T06:30:00.000Z",
      30,
      "episode",
      "First 1:30",
      "first",
    );
    const second = entry(
      "second-130",
      "2026-11-01T07:30:00.000Z",
      30,
      "episode",
      "Second 1:30",
      "second",
    );
    const result = deriveContinuityContext({
      schedules: [schedule([first, second])],
      media: [media("first", "First 1:30", "Roseanne"), media("second", "Second 1:30", "Night Court")],
      insertionInstant: "2026-11-01T06:45:00.000Z",
      managedLineup: true,
    });

    expect(result.presentationLabel).toBe("OVERNIGHT");
    // Overnight promos stay on, but they are future-only and over a 6 AM
    // horizon, so the 2 AM movie window is not silently emptied.
    expect(result.allowTimeRelativePromos).toBe(true);
    expect(result.tonight.map((airing) => airing.airingId)).toEqual(["second-130"]);
    expect(result.current?.start).toBe("2026-11-01T06:30:00.000Z");
    expect(result.next?.start).toBe("2026-11-01T07:30:00.000Z");
  });

  test("preserves movie occurrence and role identity for replay-safe promotion", () => {
    const movie = entry(
      "movie-entry",
      "2026-09-20T23:00:00.000Z",
      120,
      "movie",
      "Tremors",
      "movie-tremors",
      { movieOccurrenceKey: "2026-09-20:weekend-opener", movieRole: "weekend-opener" },
    );
    const result = deriveContinuityContext({
      schedules: [schedule([movie])],
      media: [media("movie-tremors", "Tremors")],
      insertionInstant: "2026-09-20T23:10:00.000Z",
      managedLineup: true,
    });

    expect(result.current).toMatchObject({
      airingId: "2026-09-20:weekend-opener",
      movieOccurrenceKey: "2026-09-20:weekend-opener",
      movieRole: "weekend-opener",
    });
  });

  test("unmanaged looping lineups suppress all time-relative promotion", () => {
    const show = entry(
      "show",
      "2026-09-20T23:00:00.000Z",
      30,
      "episode",
      "Pilot",
      "show-1",
    );
    const result = deriveContinuityContext({
      schedules: [schedule([show])],
      media: [media("show-1", "Pilot", "Roseanne")],
      insertionInstant: "2026-09-20T23:05:00.000Z",
      managedLineup: false,
    });

    expect(result.allowTimeRelativePromos).toBe(false);
    expect(result.tonight).toEqual([]);
    expect(result.weekendPair).toBeNull();
  });

  test("never steps over an unusable immediate airing to advertise a later one as NEXT", () => {
    const current = entry(
      "current-show",
      "2026-09-20T23:00:00.000Z",
      30,
      "episode",
      "Current Episode",
      "current-media",
    );
    const next = entry(
      "missing-show",
      current.end,
      30,
      "episode",
      "Missing Episode",
      "missing-media",
    );
    const after = entry(
      "available-show",
      next.end,
      30,
      "episode",
      "Available Episode",
      "available-media",
    );
    const missing = media("missing-media", "Missing Episode", "Missing Show");
    missing.available = false;
    const result = deriveContinuityContext({
      schedules: [schedule([current, next, after])],
      media: [
        media("current-media", "Current Episode", "Roseanne"),
        missing,
        media("available-media", "Available Episode", "Night Court"),
      ],
      insertionInstant: next.start,
      managedLineup: true,
    });
    // The slot that will actually air next is unusable, so there is no truthful
    // NEXT to name; advertising the programme after it would be a lie.
    expect(result.next).toBeNull();
    expect(result.tonight.every((airing) => airing.airingId !== "missing-show")).toBe(true);
  });

  test("promotes a film from the previous evening's completed schedule after midnight", () => {
    const movie = entry(
      "film-1",
      "2026-09-20T07:07:00.000Z",
      120,
      "movie",
      "Tremors",
      "film",
      { movieOccurrenceKey: "2026-09-19:nightly", movieRole: "nightly" },
    );
    const result = deriveContinuityContext({
      schedules: [{ ...schedule([movie]), date: "2026-09-19", id: "schedule-2026-09-19" }],
      media: [media("film", "Tremors")],
      insertionInstant: "2026-09-20T07:00:00.000Z",
      managedLineup: true,
    });
    // 2:00 AM local in America/Chicago: the 2:07 AM film is genuinely ahead.
    expect(result.presentationLabel).toBe("OVERNIGHT");
    expect(result.allowTimeRelativePromos).toBe(true);
    expect(result.tonight.map((airing) => airing.airingId)).toEqual([
      "2026-09-19:nightly",
    ]);
  });

  test("derives the weekend pair from movie roles and dedupes a split feature", () => {
    const opener = entry(
      "opener-1",
      "2026-09-19T00:00:00.000Z",
      60,
      "movie",
      "Tremors",
      "film-1",
      { movieOccurrenceKey: "2026-09-18:weekend-opener", movieRole: "weekend-opener" },
    );
    const openerTail = entry(
      "opener-2",
      "2026-09-19T01:00:00.000Z",
      60,
      "movie",
      "Tremors",
      "film-1",
      {
        movieOccurrenceKey: "2026-09-18:weekend-opener",
        movieRole: "weekend-opener",
        sourceOffsetMs: 3_600_000,
      },
    );
    const stranger = entry(
      "stranger",
      "2026-09-19T02:00:00.000Z",
      60,
      "movie",
      "Random Feature",
      "film-3",
    );
    const closer = entry(
      "closer-1",
      "2026-09-19T03:00:00.000Z",
      60,
      "movie",
      "The Blob",
      "film-2",
      { movieOccurrenceKey: "2026-09-18:weekend-closer", movieRole: "weekend-closer" },
    );
    const result = deriveContinuityContext({
      schedules: [
        {
          ...schedule([opener, openerTail, stranger, closer]),
          date: "2026-09-18",
          id: "schedule-2026-09-18",
        },
      ],
      media: [
        media("film-1", "Tremors"),
        media("film-2", "The Blob"),
        media("film-3", "Random Feature"),
      ],
      insertionInstant: "2026-09-18T23:59:00.000Z",
      managedLineup: true,
    });
    // The pair is the configured opener/closer, not the two films that merely
    // happen to follow one another; the split segment is one logical airing.
    expect(result.weekendPair?.map((airing) => airing.title)).toEqual([
      "Tremors",
      "The Blob",
    ]);
    expect(
      result.tonight.filter(
        (airing) => airing.airingId === "2026-09-18:weekend-opener",
      ),
    ).toHaveLength(1);
    expect(
      result.tonight.filter(
        (airing) => airing.airingId === "2026-09-18:weekend-opener",
      ),
    ).toHaveLength(1);
  });

  test("names a film by its title even when a show title is present", () => {
    const filmEntry = entry(
      "film-1",
      "2026-09-20T23:30:00.000Z",
      120,
      "movie",
      "InternalLabel",
      "film",
    );
    const result = deriveContinuityContext({
      schedules: [schedule([filmEntry])],
      media: [
        {
          ...media("film", "Tremors"),
          showTitle: "Late Night Movie Block",
        },
      ],
      insertionInstant: "2026-09-20T23:00:00.000Z",
      managedLineup: true,
    });
    expect(result.next?.title).toBe("Tremors");
    expect(result.next?.showTitle).toBeUndefined();
  });
});
