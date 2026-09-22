import { expect, test } from "vitest";
import { DateTime } from "luxon";
import { generateSchedule } from "../../src/scheduler/generate.js";
import {
  assignMovieOccurrences,
  buildMovieRotation,
  continuationMidrolls,
  movieMidrollLayout,
  movieProgrammingPlan,
  selectMovieBreak,
  selectMovieBridge,
  wholeSpotCombination,
} from "../../src/scheduler/movieProgramming.js";
import {
  movieOccurrenceKey,
  rotationMediaId,
} from "../../src/domain/movieProgramming.js";
import type { MovieOccurrence } from "../../src/domain/movieProgramming.js";
import { movieFixture } from "../support/movieFixture.js";
import type { MediaItem } from "../../src/domain/models.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** The rotation a first run builds for a fixture's movies. */
function rotationFor(count = 30) {
  const { movies } = movieFixture({ movieCount: count });
  return buildMovieRotation({
    channelId: "marktv-laughs",
    eligibleIds: movies.map((movie) => movie.id),
    epochDate: "2026-09-06",
    now: NOW,
  });
}

test("a cycle plays every movie once before any repeats", () => {
  const { channel } = movieFixture({ movieCount: 30 });
  const rotation = rotationFor(30);
  const drawn: string[] = [];
  // Ten weeks of consuming positions - nightly features and both double-feature
  // slots - is well past one cycle of thirty.
  for (let week = 0; week < 10; week += 1) {
    const sunday = DateTime.fromISO("2026-09-06", { zone: "UTC" }).plus({
      weeks: week,
    });
    for (const [dayOffset, position] of [
      [0, "double-feature-1"],
      [0, "double-feature-2"],
      [2, "nightly"],
      [3, "nightly"],
      [4, "nightly"],
      [5, "nightly"],
      [6, "nightly"],
      [6, "double-feature-1"],
      [6, "double-feature-2"],
    ] as const) {
      const date = sunday.plus({ days: dayOffset }).toISODate()!;
      const occurrences = assignMovieOccurrences({
        channelId: channel.id,
        date,
        programming: channel.movieProgramming!,
        rotation,
        existing: () => undefined,
        resolvedAt: NOW.toISOString(),
      });
      const occurrence = occurrences.forDate.find(
        (candidate) =>
          candidate.position === position && candidate.consumes,
      )!;
      drawn.push(occurrence.mediaId);
    }
  }
  // Nine draws a week for ten weeks: the first thirty are all distinct, which is
  // the bag promise, and the refill starts with the second cycle.
  expect(new Set(drawn.slice(0, 30)).size).toBe(30);
  expect(drawn[30]).toBe(drawn[0]);
  for (let index = 1; index < drawn.length; index += 1)
    expect(drawn[index]).not.toBe(drawn[index - 1]);
});

test("rotation order is stable across rebuilds and extends rather than reseeds", () => {
  const { movies } = movieFixture({ movieCount: 30 });
  const ids = movies.map((movie) => movie.id);
  const first = buildMovieRotation({
    channelId: "marktv-laughs",
    eligibleIds: ids,
    epochDate: "2026-09-06",
    now: NOW,
  });
  const again = buildMovieRotation({
    channelId: "marktv-laughs",
    eligibleIds: ids,
    epochDate: "2026-09-06",
    now: new Date("2026-09-20T12:00:00.000Z"),
    existing: first,
  });
  expect(again.order).toEqual(first.order);
  expect(again.epochDate).toBe(first.epochDate);

  const extended = buildMovieRotation({
    channelId: "marktv-laughs",
    eligibleIds: [...ids, "movie-31"],
    epochDate: "2026-09-06",
    now: NOW,
    existing: first,
  });
  expect(extended.order.slice(0, 30)).toEqual(first.order);
  expect(extended.order).toContain("movie-31");
  expect(extended.order).toHaveLength(31);

  const pruned = buildMovieRotation({
    channelId: "marktv-laughs",
    eligibleIds: ids.filter((id) => id !== "movie-03"),
    epochDate: "2026-09-06",
    now: NOW,
    existing: first,
  });
  expect(pruned.order).toHaveLength(29);
  expect(pruned.order).not.toContain("movie-03");
});

test("a single eligible movie is reported instead of silently repeating", () => {
  const { channel } = movieFixture({ movieCount: 1 });
  const rotation = rotationFor(1);
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-08",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
  });
  expect(result.forDate).toHaveLength(1);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "MOVIE_ROTATION_SHORT",
  );
});

test("an empty rotation yields no occurrences and a diagnostic", () => {
  const { channel } = movieFixture({ movieCount: 0 });
  const rotation = rotationFor(0);
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-08",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
  });
  expect(result.forDate).toEqual([]);
  expect(result.diagnostics[0].code).toBe("MOVIE_ROTATION_EMPTY");
});

test("weekend encores replay the adjacent opener and consume nothing new", () => {
  const { channel } = movieFixture();
  const rotation = rotationFor();
  const ledger = new Map<string, MovieOccurrence>();
  const existing = (date: string, position: MovieOccurrence["position"]) =>
    ledger.get(movieOccurrenceKey(date, position));
  const resolve = (date: string) => {
    const result = assignMovieOccurrences({
      channelId: channel.id,
      date,
      programming: channel.movieProgramming!,
      rotation,
      existing,
      resolvedAt: NOW.toISOString(),
    });
    for (const occurrence of result.occurrences)
      ledger.set(
        movieOccurrenceKey(occurrence.date, occurrence.position),
        occurrence,
      );
    return result;
  };
  // Saturday 2026-09-12 opens the weekend; Sunday 02:00 replays it, Monday 02:00
  // replays Sunday's opener.
  const saturday = resolve("2026-09-12");
  const sunday = resolve("2026-09-13");
  const monday = resolve("2026-09-14");
  const saturdayOpener = saturday.forDate.find(
    (occurrence) => occurrence.position === "double-feature-1",
  )!;
  const sundayOpener = sunday.forDate.find(
    (occurrence) => occurrence.position === "double-feature-1",
  )!;
  const sundayEncore = sunday.forDate.find(
    (occurrence) => occurrence.position === "nightly",
  )!;
  const mondayEncore = monday.forDate.find(
    (occurrence) => occurrence.position === "nightly",
  )!;
  expect(sundayEncore).toMatchObject({
    role: "encore",
    mediaId: saturdayOpener.mediaId,
    consumes: false,
    encoreOf: movieOccurrenceKey("2026-09-12", "double-feature-1"),
  });
  expect(mondayEncore).toMatchObject({
    role: "encore",
    mediaId: sundayOpener.mediaId,
    consumes: false,
  });
  // Nine consuming positions across the week, 11 airings in total.
  const week = [
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
    "2026-09-14",
  ].flatMap((date) => resolve(date).occurrences);
  const starts = [
    ...new Map(week.map((item) => [movieOccurrenceKey(item.date, item.position), item])).values(),
  ].filter((item) => item.date >= "2026-09-08" && item.date <= "2026-09-14");
  expect(starts).toHaveLength(11);
  expect(starts.filter((item) => item.consumes)).toHaveLength(9);
  expect(starts.filter((item) => !item.consumes)).toHaveLength(2);
});

test("generating Sunday before Saturday still lands the same encore link", () => {
  const { channel } = movieFixture();
  const rotation = rotationFor();
  const inOrder = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-12",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
  });
  const opener = inOrder.forDate.find(
    (occurrence) => occurrence.position === "double-feature-1",
  )!;
  const outOfOrder = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-13",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
  });
  const encore = outOfOrder.forDate.find(
    (occurrence) => occurrence.position === "nightly",
  )!;
  expect(encore.mediaId).toBe(opener.mediaId);
  // The dependency is returned so the caller can persist it with the encore.
  expect(
    outOfOrder.occurrences.some(
      (occurrence) =>
        occurrence.date === "2026-09-12" &&
        occurrence.position === "double-feature-1",
    ),
  ).toBe(true);
});

test("an assignment already in the ledger is reused verbatim", () => {
  const { channel } = movieFixture();
  const rotation = rotationFor();
  const stored: MovieOccurrence = {
    channelId: channel.id,
    date: "2026-09-08",
    position: "nightly",
    role: "nightly",
    anchor: "02:00",
    mediaId: "movie-29",
    consumes: true,
    resolvedAt: "2026-01-01T00:00:00.000Z",
  };
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-08",
    programming: channel.movieProgramming!,
    rotation,
    existing: (date, position) =>
      date === "2026-09-08" && position === "nightly" ? stored : undefined,
    resolvedAt: NOW.toISOString(),
  });
  expect(result.forDate[0]).toEqual(stored);
});

test("movie break counts follow the 110-minute rule and protect both ends", () => {
  const breakMs = 120_000;
  const policy = movieFixture().channel.movieProgramming!.breakPolicy;
  const layout = (minutes: number) =>
    movieMidrollLayout(minutes * 60_000, breakMs, policy);
  expect(layout(90).map((breakAt) => breakAt.offsetMs)).toHaveLength(3);
  expect(layout(110).map((breakAt) => breakAt.offsetMs)).toHaveLength(3);
  expect(layout(120).map((breakAt) => breakAt.offsetMs)).toHaveLength(4);
  const long = layout(120).map((breakAt) => breakAt.offsetMs / 60_000);
  // 20/40/60/80 per cent, and never inside the first or last fifteen minutes.
  expect(long).toEqual([24, 48, 72, 96]);
  const short = layout(90).map((breakAt) => breakAt.offsetMs / 60_000);
  expect(short).toEqual([22.5, 45, 67.5]);
  // A feature too short to protect both ends gets no breaks at all.
  expect(layout(20)).toEqual([]);
});

test("breaks are timed from real whole spots and fall back deterministically", () => {
  const { media } = movieFixture();
  const policy = movieFixture().channel.movieProgramming!.breakPolicy;
  const ads = media.filter((item) => item.kind === "commercial");
  const detected = selectMovieBreak(ads, policy, { seed: "one" });
  expect(detected.source).toBe("detected");
  expect(detected.durationMs).toBe(120_000);
  expect(detected.durationMs).toBeLessThanOrEqual(150_000);

  const odd = selectMovieBreak(
    ads.map((item) => ({ ...item, durationMs: 200_000 })),
    policy,
    { seed: "one" },
  );
  expect(odd.source).toBe("estimated");
  expect(odd.durationMs).toBe(120_000);

  // Spots that cannot make two minutes exactly are still used when they can make
  // something inside the ceiling: a real break beats an estimated one.
  const near = selectMovieBreak(
    Array.from({ length: 18 }, (_, index) => ({
      ...ads[index % ads.length],
      id: `seven-${index}`,
      durationMs: 7_000,
    })),
    policy,
    { seed: "one" },
  );
  expect(near.source).toBe("detected");
  expect(near.durationMs).toBe(126_000);
});

test("whole spot combinations respect exclusions and the maximum", () => {
  const { media } = movieFixture({ adSeconds: [30, 30, 60] });
  const ads = media.filter((item) => item.kind === "commercial");
  const combination = wholeSpotCombination(ads, { minMs: 60_000, maxMs: 120_000 });
  expect(combination?.durationMs).toBe(120_000);
  const excluded = wholeSpotCombination(ads, {
    minMs: 60_000,
    maxMs: 120_000,
    exclude: new Set(["ad-1", "ad-2"]),
  });
  expect(excluded?.durationMs).toBe(60_000);
});

test("the weekend bridge is a whole-spot block inside 60-120 seconds", () => {
  const { channel, media } = movieFixture();
  const bridge = selectMovieBridge(
    media.filter((item) => item.kind === "commercial"),
    channel.movieProgramming!,
    { seed: "bridge" },
  );
  expect(bridge?.durationMs).toBeGreaterThanOrEqual(60_000);
  expect(bridge?.durationMs).toBeLessThanOrEqual(120_000);
  for (const item of bridge!.items) expect(item.durationMs).toBeGreaterThan(0);
});

test("continuation mid-rolls keep their position in the source file", () => {
  const layout = movieMidrollLayout(120 * 60_000, 120_000, movieFixture().channel.movieProgramming!.breakPolicy);
  const rebased = continuationMidrolls(layout, 72 * 60_000);
  // The break that sat exactly at the resume point has NOT aired - the previous
  // day stopped its content before it - so it opens the continuation at offset
  // zero and the one after it is rebased behind it.
  expect(layout.map((breakAt) => breakAt.offsetMs / 60_000)).toEqual([24, 48, 72, 96]);
  expect(rebased.map((breakAt) => breakAt.offsetMs)).toEqual([0, 24 * 60_000]);
});

test("plan sorting keeps the nightly feature ahead of the double feature", () => {
  const { channel } = movieFixture();
  const occurrences: MovieOccurrence[] = [
    {
      channelId: channel.id,
      date: "2026-09-12",
      position: "double-feature-1",
      role: "weekend-opener",
      anchor: "19:00",
      mediaId: "movie-01",
      consumes: true,
      resolvedAt: NOW.toISOString(),
    },
    {
      channelId: channel.id,
      date: "2026-09-12",
      position: "nightly",
      role: "nightly",
      anchor: "02:00",
      mediaId: "movie-02",
      consumes: true,
      resolvedAt: NOW.toISOString(),
    },
  ];
  const plan = movieProgrammingPlan({
    channel,
    date: "2026-09-12",
    occurrences,
  });
  expect(plan?.airings.map((airing) => airing.position)).toEqual([
    "nightly",
    "double-feature-1",
  ]);
});

test("generation places the nightly movie at 02:00 local", () => {
  const { channel, pools, media } = movieFixture({ movieCount: 5 });
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-09",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-09:nightly",
          date: "2026-09-09",
          position: "nightly",
          role: "nightly",
          anchor: "02:00",
          mediaId: "movie-01",
          encore: false,
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const movie = result.schedule.entries.find(
    (entry) => entry.kind === "movie",
  )!;
  expect(movie.localStart).toBe("02:00");
  expect(movie.mediaId).toBe("movie-01");
  expect(movie.movieRole).toBe("nightly");
  expect(movie.midrolls).toHaveLength(3);
  expect(
    movie.midrolls!.every((breakAt) => breakAt.durationMs <= 150_000),
  ).toBe(true);
  expect(
    result.schedule.diagnostics.some(
      (diagnostic) => diagnostic.code === "MOVIE_BREAK_POD_FILL_DETECTED",
    ),
  ).toBe(true);
  // The break LOCATION is not detected by anything: no black, fade, audio or
  // chapter analysis is run over the film, so it never claims to be.
  expect(
    result.schedule.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "MOVIE_BREAK_ESTIMATED" &&
        diagnostic.message.includes("estimated from percentage targets"),
    ),
  ).toBe(true);
  expect(
    result.schedule.diagnostics.some(
      (diagnostic) =>
        /DETECTED/.test(diagnostic.code) &&
        diagnostic.message.toLowerCase().includes("location"),
    ),
  ).toBe(false);
});

test("a program boundary at 02:03 starts the feature there, not later", () => {
  const { channel, pools, media } = movieFixture({ movieCount: 5 });
  // A 23-minute sitcom that begins at 01:40 ends at 02:03, which is inside the
  // soft anchor window and must not be treated as a missed anchor.
  const episode = media.find((item) => item.kind === "episode")!;
  for (const item of media) if (item.kind === "episode") item.durationMs = 1_380_000;
  expect(episode.durationMs).toBe(1_380_000);
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-09",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-09:nightly",
          date: "2026-09-09",
          position: "nightly",
          role: "nightly",
          anchor: "02:00",
          mediaId: "movie-01",
          encore: false,
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const movie = result.schedule.entries.find((entry) => entry.kind === "movie")!;
  // The feature starts at a real program boundary within +15 minutes of 02:00.
  const anchorMs = DateTime.fromISO("2026-09-09T02:00", {
    zone: channel.timezone,
  }).toMillis();
  const startMs = Date.parse(movie.start);
  expect(startMs - anchorMs).toBeGreaterThanOrEqual(-15 * 60_000);
  expect(startMs - anchorMs).toBeLessThanOrEqual(15 * 60_000);
  expect(
    result.schedule.diagnostics.some(
      (diagnostic) => diagnostic.code === "MOVIE_ANCHOR_LATE",
    ),
  ).toBe(false);
});

test("the weekend double feature is movie, bridge, movie, then sitcoms", () => {
  const { channel, pools, media } = movieFixture({ movieCount: 5 });
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-12",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-12:nightly",
          date: "2026-09-12",
          position: "nightly",
          role: "nightly",
          anchor: "02:00",
          mediaId: "movie-01",
          encore: false,
        },
        {
          occurrenceKey: "2026-09-12:double-feature-1",
          date: "2026-09-12",
          position: "double-feature-1",
          role: "weekend-opener",
          anchor: "19:00",
          mediaId: "movie-02",
          encore: false,
          pairId: "2026-09-12:double-feature",
        },
        {
          occurrenceKey: "2026-09-12:double-feature-2",
          date: "2026-09-12",
          position: "double-feature-2",
          role: "weekend-closer",
          anchor: "19:00",
          mediaId: "movie-03",
          encore: false,
          pairId: "2026-09-12:double-feature",
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const block = result.schedule.entries.filter(
    (entry) =>
      entry.movieOccurrenceKey?.startsWith("2026-09-12") ||
      entry.source === "movie-bridge",
  );
  const openerIndex = result.schedule.entries.findIndex(
    (entry) => entry.movieOccurrenceKey === "2026-09-12:double-feature-1",
  );
  const closerIndex = result.schedule.entries.findIndex(
    (entry) => entry.movieOccurrenceKey === "2026-09-12:double-feature-2",
  );
  expect(openerIndex).toBeGreaterThan(-1);
  expect(closerIndex).toBeGreaterThan(openerIndex);
  const bridge = result.schedule.entries.slice(openerIndex + 1, closerIndex);
  expect(bridge.length).toBeGreaterThan(0);
  for (const spot of bridge) expect(spot.source).toBe("movie-bridge");
  const bridgeMs = bridge.reduce((total, spot) => total + spot.durationMs, 0);
  expect(bridgeMs).toBeGreaterThanOrEqual(60_000);
  expect(bridgeMs).toBeLessThanOrEqual(120_000);
  expect(
    result.schedule.entries.filter((entry) => entry.kind === "movie"),
  ).toHaveLength(3);
  // Nothing else is a movie: no third feature.
  expect(block.filter((entry) => entry.kind === "movie")).toHaveLength(3);
  // Content after the block is a sitcom again.
  expect(result.schedule.entries[closerIndex + 1].kind).not.toBe("movie");
});

test("a closer waits until tomorrow when its intact bridge cannot fit tonight", () => {
  const { channel, pools, media } = movieFixture({
    movieCount: 2,
    // 291 minutes of content plus four two-minute breaks ends at 23:59 when
    // the opener starts on its 19:00 anchor.
    movieMinutes: 291,
    adSeconds: [60, 60],
    programming: { bridgeMinSeconds: 120, bridgeMaxSeconds: 120 },
  });
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-12",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-12:double-feature-1",
          date: "2026-09-12",
          position: "double-feature-1",
          role: "weekend-opener",
          anchor: "19:00",
          mediaId: "movie-01",
          encore: false,
          pairId: "2026-09-12:double-feature",
        },
        {
          occurrenceKey: "2026-09-12:double-feature-2",
          date: "2026-09-12",
          position: "double-feature-2",
          role: "weekend-closer",
          anchor: "19:00",
          mediaId: "movie-02",
          encore: false,
          pairId: "2026-09-12:double-feature",
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.schedule.entries.some(
      (entry) => entry.movieOccurrenceKey === "2026-09-12:double-feature-2",
    ),
  ).toBe(false);
  expect(
    result.schedule.entries.some((entry) => entry.source === "movie-bridge"),
  ).toBe(false);
  expect(result.schedule.movieCarry).toEqual({
    closer: {
      occurrenceKey: "2026-09-12:double-feature-2",
      mediaId: "movie-02",
      role: "weekend-closer",
      encore: false,
      bridgeOwed: true,
    },
  });
});

test("a movie that would cross midnight continues with its source offset", () => {
  const { channel, pools, media } = movieFixture({
    movieCount: 2,
    movieMinutes: 150,
  });
  const national = media.find((item) => item.id === "movie-01") as MediaItem;
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-12",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-12:double-feature-1",
          date: "2026-09-12",
          position: "double-feature-1",
          role: "weekend-opener",
          anchor: "19:00",
          mediaId: "movie-01",
          encore: false,
          pairId: "2026-09-12:double-feature",
        },
        {
          occurrenceKey: "2026-09-12:double-feature-2",
          date: "2026-09-12",
          position: "double-feature-2",
          role: "weekend-closer",
          anchor: "19:00",
          mediaId: "movie-02",
          encore: false,
          pairId: "2026-09-12:double-feature",
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const last = result.schedule.entries.at(-1)!;
  expect(last.kind).toBe("movie");
  expect(last.localEnd).toBe("00:00");
  const consumedMs =
    (last.sourceOffsetMs ?? 0) + (last.contentDurationMs ?? last.durationMs);
  expect(consumedMs).toBeLessThan(national.durationMs!);
  expect(
    result.schedule.diagnostics.some(
      (diagnostic) => diagnostic.code === "MOVIE_CONTINUES_NEXT_DAY",
    ),
  ).toBe(true);
});

test("the next day resumes the film where it stopped", () => {
  const { channel, pools, media } = movieFixture({ movieCount: 2, movieMinutes: 150 });
  const target = media.find((item) => item.id === "movie-01")!;
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-13",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [],
      continuations: [
        {
          continuation: { mediaId: "movie-01", sourceOffsetMs: 120 * 60_000 },
        },
      ],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const continuation = result.schedule.entries[0];
  expect(continuation).toMatchObject({
    kind: "movie",
    mediaId: "movie-01",
    localStart: "00:00",
    sourceOffsetMs: 120 * 60_000,
  });
  // The 120-minute mark happens to be one of the film's breaks. The break did not
  // air before the day boundary, so it opens the continuation - rather than being
  // silently lost - and the rest of the film follows it.
  expect(continuation.midrolls).toEqual([{ offsetMs: 0, durationMs: 120_000 }]);
  expect(continuation.contentDurationMs).toBe(target.durationMs! - 120 * 60_000);
  expect(continuation.durationMs).toBe(
    target.durationMs! - 120 * 60_000 + 120_000,
  );
  expect(continuation.localEnd).toBe("00:32");
});

test("an unavailable movie is diagnosed instead of silently dropped", () => {
  const { channel, pools, media } = movieFixture({ movieCount: 2 });
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-09",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-09:nightly",
          date: "2026-09-09",
          position: "nightly",
          role: "nightly",
          anchor: "02:00",
          mediaId: "movie-99",
          encore: false,
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.schedule.entries.some((entry) => entry.kind === "movie"),
  ).toBe(false);
  expect(
    result.schedule.diagnostics.some(
      (diagnostic) => diagnostic.code === "MOVIE_MEDIA_UNAVAILABLE",
    ),
  ).toBe(true);
});

test("a first-run Sunday draws a normal movie instead of inventing a Saturday opener", () => {
  const { channel } = movieFixture();
  const rotation = rotationFor();
  // The feature was switched on this Sunday: nothing aired on the Saturday before
  // it, so the 02:00 slot has no opener to replay.
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-13",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
    activationDate: "2026-09-13",
  });
  const airing = result.forDate.find(
    (occurrence) => occurrence.position === "nightly",
  )!;
  expect(airing).toMatchObject({
    role: "nightly",
    consumes: true,
    encoreOf: undefined,
  });
  expect(rotation.order).toContain(airing.mediaId);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "MOVIE_ENCORE_FALLBACK",
  );
  // The past opener is NOT synthesised onto the ledger.
  expect(
    result.occurrences.some((occurrence) => occurrence.date === "2026-09-12"),
  ).toBe(false);
});

test("Monday after a post-opener Sunday activation does not reuse a synthetic Sunday source", () => {
  const { channel } = movieFixture();
  // Two entries make an ordinal collision maximally likely: adjacent draws must
  // still differ even at the smallest viable no-repeat bag size.
  const rotation = rotationFor(2);
  const syntheticSundayOpener: MovieOccurrence = {
    channelId: channel.id,
    date: "2026-09-20",
    position: "double-feature-1",
    role: "weekend-opener",
    anchor: "19:00",
    mediaId: rotation.order[0],
    consumes: true,
    resolvedAt: NOW.toISOString(),
  };
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-21",
    programming: channel.movieProgramming!,
    rotation,
    // This represents an opener persisted by the old bug.  It cannot be a
    // source because activation was 21:56 Chicago, after the 19:00 anchor.
    existing: (date, position) =>
      date === syntheticSundayOpener.date && position === syntheticSundayOpener.position
        ? syntheticSundayOpener
        : undefined,
    resolvedAt: NOW.toISOString(),
    activationDate: "2026-09-20",
    activatedAt: "2026-09-21T02:56:16.475Z",
    timezone: "America/Chicago",
  });
  const monday = result.forDate.find((item) => item.position === "nightly")!;
  expect(monday).toMatchObject({
    role: "nightly",
    consumes: true,
    encoreOf: undefined,
  });
  expect(result.occurrences.some((item) => item.date === "2026-09-20")).toBe(false);
  expect(result.diagnostics.map((item) => item.code)).toContain(
    "MOVIE_ENCORE_FALLBACK",
  );
  // The fallback reserves the immediately preceding ordinal, rather than making
  // an unrelated seeded pick that can collide with Tuesday's normal draw.
  expect(monday.mediaId).toBe(
    rotationMediaId(rotation, "2026-09-20", "double-feature-2"),
  );
  const tuesday = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-22",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
    activationDate: "2026-09-20",
    activatedAt: "2026-09-21T02:56:16.475Z",
    timezone: "America/Chicago",
  }).forDate.find((item) => item.position === "nightly")!;
  expect(tuesday.mediaId).toBe(
    rotationMediaId(rotation, "2026-09-22", "nightly"),
  );
  expect(tuesday.mediaId).not.toBe(monday.mediaId);
  // Re-derivation remains pure and therefore identical out of order.
  const mondayAgain = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-21",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
    activationDate: "2026-09-20",
    activatedAt: "2026-09-21T02:56:16.475Z",
    timezone: "America/Chicago",
  }).forDate.find((item) => item.position === "nightly")!;
  expect(mondayAgain.mediaId).toBe(monday.mediaId);
});

test("Monday generation before the Sunday opener anchor derives its linked encore", () => {
  const { channel } = movieFixture();
  const rotation = rotationFor();
  const result = assignMovieOccurrences({
    channelId: channel.id,
    date: "2026-09-21",
    programming: channel.movieProgramming!,
    rotation,
    existing: () => undefined,
    resolvedAt: NOW.toISOString(),
    activationDate: "2026-09-20",
    // 18:00 Chicago: the 19:00 Sunday opener is covered even though Monday is
    // generated first, so its encore remains a real link.
    activatedAt: "2026-09-20T23:00:00.000Z",
    timezone: "America/Chicago",
  });
  const sundayOpener = result.occurrences.find(
    (item) => item.date === "2026-09-20" && item.position === "double-feature-1",
  )!;
  const monday = result.forDate.find((item) => item.position === "nightly")!;
  expect(monday).toMatchObject({
    role: "encore",
    consumes: false,
    encoreOf: movieOccurrenceKey("2026-09-20", "double-feature-1"),
    mediaId: sundayOpener.mediaId,
  });
});

test("out-of-order generation inside the activation window still links the encore", () => {
  const { channel } = movieFixture();
  const rotation = rotationFor();
  const assign = (date: string) =>
    assignMovieOccurrences({
      channelId: channel.id,
      date,
      programming: channel.movieProgramming!,
      rotation,
      existing: () => undefined,
      resolvedAt: NOW.toISOString(),
      // The feature has been running since well before this weekend.
      activationDate: "2026-08-01",
    });
  // Monday first: its 02:00 encore replays Sunday's opener, which is a future
  // date the feature does cover, so the link is derived rather than invented.
  const monday = assign("2026-09-14");
  const sunday = assign("2026-09-13");
  expect(monday.forDate.find((item) => item.position === "nightly")).toMatchObject(
    {
      consumes: false,
      encoreOf: movieOccurrenceKey("2026-09-13", "double-feature-1"),
      mediaId: sunday.forDate.find(
        (item) => item.position === "double-feature-1",
      )!.mediaId,
    },
  );
  expect(
    monday.diagnostics.map((diagnostic) => diagnostic.code),
  ).not.toContain("MOVIE_ENCORE_FALLBACK");
});

test("a break that no whole-spot combination can make never reports a detected fill", () => {
  const { channel, pools, media } = movieFixture({
    movieCount: 5,
    adSeconds: [200],
  });
  // Only the single 200-second spot is available to breaks and bridges, so no
  // combination can make the two-minute target.
  channel.breakPolicy.poolIds = ["ads"];
  channel.movieProgramming!.bridgePoolIds = ["ads"];
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-09",
    movieProgramming: {
      programming: channel.movieProgramming!,
      airings: [
        {
          occurrenceKey: "2026-09-09:nightly",
          date: "2026-09-09",
          position: "nightly",
          role: "nightly",
          anchor: "02:00",
          mediaId: "movie-01",
          encore: false,
        },
      ],
      continuations: [],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const codes = result.schedule.diagnostics.map((diagnostic) => diagnostic.code);
  expect(codes).toContain("MOVIE_BREAK_POD_FILL_ESTIMATED");
  expect(codes).not.toContain("MOVIE_BREAK_POD_FILL_DETECTED");
});

test("movie programming is inert when the feature is off", () => {
  const { channel, pools, media } = movieFixture();
  channel.movieProgramming = { ...channel.movieProgramming!, enabled: false };
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-09",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.schedule.entries.some((entry) => entry.source === "movie-programming"),
  ).toBe(false);
});
