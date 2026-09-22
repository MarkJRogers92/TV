import { afterEach, expect, test } from "vitest";
import { DateTime } from "luxon";
import {
  cleanupRepositoryFixtures,
  openMovieRepositories,
} from "../support/repositoryFixture.js";
import { movieWeekStart } from "../../src/domain/movieProgramming.js";
import type { Schedule } from "../../src/domain/models.js";

afterEach(async () => {
  await cleanupRepositoryFixtures();
});

const now = () => new Date("2026-09-06T12:00:00.000Z");

function assertContiguous(schedule: Schedule) {
  const start = DateTime.fromISO(schedule.date, { zone: schedule.timezone })
    .startOf("day")
    .toUTC()
    .toISO()!;
  expect(schedule.entries[0].start).toBe(start);
  for (let index = 1; index < schedule.entries.length; index += 1)
    expect(schedule.entries[index].start).toBe(schedule.entries[index - 1].end);
  const last = schedule.entries.at(-1)!;
  const end = DateTime.fromISO(schedule.date, { zone: schedule.timezone })
    .plus({ days: 1 })
    .startOf("day")
    .toUTC()
    .toISO()!;
  expect(last.end).toBe(end);
  expect(
    schedule.entries.reduce((total, entry) => total + entry.durationMs, 0),
  ).toBe(schedule.durationMs);
}

// 45 generated days, each validated by the schedule schema on the way to the
// table, so this is a deliberately long-running integration test.
test("45 days of generation keep the 11/9/2 week, close every gap, and stay fair", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  const start = DateTime.fromISO("2026-09-06", { zone: "UTC" });
  const schedules: Schedule[] = [];
  for (let offset = 0; offset < 45; offset += 1) {
    const date = start.plus({ days: offset }).toISODate()!;
    const generated = await fixture.service.generate(channel, date);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    schedules.push(generated.schedule);
    assertContiguous(generated.schedule);
  }

  const occurrences = fixture.repositories.movieOccurrences.listForChannel(
    channel.id,
  );
  const byWeek = new Map<string, typeof occurrences>();
  for (const occurrence of occurrences) {
    const week = movieWeekStart(occurrence.date);
    byWeek.set(week, [...(byWeek.get(week) ?? []), occurrence]);
  }
  const completeWeeks = [...byWeek.entries()].filter(
    ([, items]) => items.length === 11,
  );
  expect(completeWeeks.length).toBeGreaterThanOrEqual(6);
  for (const [, items] of completeWeeks) {
    expect(items.filter((item) => item.consumes)).toHaveLength(9);
    expect(items.filter((item) => !item.consumes)).toHaveLength(2);
    // Five ordinary nightly features: Sunday and Monday nights are encores.
    expect(items.filter((item) => item.role === "nightly")).toHaveLength(5);
    expect(items.filter((item) => item.role === "weekend-opener")).toHaveLength(2);
    expect(items.filter((item) => item.role === "weekend-closer")).toHaveLength(2);
    expect(items.filter((item) => item.role === "encore")).toHaveLength(2);
  }

  // Fairness: the bag refills, so no movie runs away with the schedule.
  const draws = occurrences.filter((occurrence) => occurrence.consumes);
  const counts = new Map<string, number>();
  for (const occurrence of draws)
    counts.set(occurrence.mediaId, (counts.get(occurrence.mediaId) ?? 0) + 1);
  expect(counts.size).toBe(30);
  const values = [...counts.values()];
  expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);

  // Every movie airing in every stored schedule has a break inside the live
  // 2.5-minute policy and never interrupts the protected ends.
  for (const schedule of schedules) {
    for (const entry of schedule.entries) {
      if (entry.kind !== "movie") continue;
      const durationMs = entry.contentDurationMs ?? entry.durationMs;
      for (const midroll of entry.midrolls ?? []) {
        expect(midroll.durationMs).toBeLessThanOrEqual(150_000);
        expect(midroll.offsetMs).toBeGreaterThanOrEqual(15 * 60_000);
        expect(durationMs - midroll.offsetMs).toBeGreaterThanOrEqual(15 * 60_000);
      }
    }
  }
  fixture.close();
}, 60_000);

test("a movie crossing midnight is continued with its source offset intact", async () => {
  const fixture = await openMovieRepositories({
    now,
    movieCount: 3,
    movieMinutes: 150,
  });
  const channel = fixture.fixture.channel;
  const saturday = await fixture.service.generate(channel, "2026-09-12");
  expect(saturday.ok).toBe(true);
  if (!saturday.ok) return;
  const tail = saturday.schedule.entries.at(-1)!;
  expect(tail.kind).toBe("movie");
  expect(tail.localEnd).toBe("00:00");
  const consumedMs =
    (tail.sourceOffsetMs ?? 0) + (tail.contentDurationMs ?? tail.durationMs);

  const sunday = await fixture.service.generate(channel, "2026-09-13");
  expect(sunday.ok).toBe(true);
  if (!sunday.ok) return;
  const head = sunday.schedule.entries[0]!;
  expect(head).toMatchObject({
    kind: "movie",
    mediaId: tail.mediaId,
    localStart: "00:00",
    sourceOffsetMs: consumedMs,
  });
  const movie = fixture.repositories.media.get(tail.mediaId!)!;
  expect(
    (head.sourceOffsetMs ?? 0) + (head.contentDurationMs ?? head.durationMs),
  ).toBe(movie.durationMs);
  expect(sunday.schedule.entries[1].start).toBe(head.end);
  fixture.close();
});

test("spring forward keeps the 02:00 feature at the first real boundary", async () => {
  const fixture = await openMovieRepositories({
    now: () => new Date("2026-03-08T12:00:00.000Z"),
  });
  const channel = fixture.fixture.channel;
  const result = await fixture.service.generate(channel, "2026-03-08");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The day is 23 hours long and the 02:00 wall clock does not exist, so the
  // feature airs at the first real boundary - 03:00 local.
  expect(result.schedule.durationMs).toBe(23 * 3_600_000);
  const nightly = result.schedule.entries.find(
    (entry) => entry.movieOccurrenceKey === "2026-03-08:nightly",
  )!;
  expect(nightly.localStart).toBe("03:00");
  expect(
    result.schedule.entries.filter(
      (entry) => entry.movieRole === "weekend-opener",
    ),
  ).toHaveLength(1);
  assertContiguous(result.schedule);
  fixture.close();
});

/**
 * A double feature longer than a day is one block, and the day boundary runs
 * straight through the middle of it. The opener's tail is resumed, the bridge is
 * played once, and the closer airs - across as many midnights as it takes -
 * without a sitcom, a dropped feature, or a half-played commercial in between.
 */
test("an extreme double feature crosses midnight as one coherent block", async () => {
  const fixture = await openMovieRepositories({
    now,
    movieCount: 3,
    movieMinutes: 400,
  });
  const channel = fixture.fixture.channel;
  const saturday = await fixture.service.generate(channel, "2026-09-12");
  expect(saturday.ok).toBe(true);
  if (!saturday.ok) return;
  assertContiguous(saturday.schedule);

  const sunday = await fixture.service.generate(channel, "2026-09-13");
  expect(sunday.ok).toBe(true);
  if (!sunday.ok) return;
  assertContiguous(sunday.schedule);

  const monday = await fixture.service.generate(channel, "2026-09-14");
  expect(monday.ok).toBe(true);
  if (!monday.ok) return;
  assertContiguous(monday.schedule);

  // The closer was owed by Saturday and is written down as such rather than
  // inferred from the last entry.
  expect(saturday.schedule.movieCarry?.closer).toMatchObject({
    occurrenceKey: "2026-09-12:double-feature-2",
    bridgeOwed: true,
  });
  expect(sunday.schedule.movieCarry?.closer?.occurrenceKey).not.toBe(
    "2026-09-12:double-feature-2",
  );

  const checkBlock = (
    entries: Schedule["entries"],
    date: string,
    minutes: number,
  ) => {
    const airings = entries;
    const openerFirst = airings.findIndex(
      (entry) => entry.movieOccurrenceKey === `${date}:double-feature-1`,
    );
    const closerFirst = airings.findIndex(
      (entry) => entry.movieOccurrenceKey === `${date}:double-feature-2`,
    );
    const closerParts = airings
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) => entry.movieOccurrenceKey === `${date}:double-feature-2`,
      );
    const closerLast = closerParts[closerParts.length - 1]?.index ?? -1;
    expect(openerFirst).toBeGreaterThan(-1);
    expect(closerFirst).toBeGreaterThan(openerFirst);

    const block = airings.slice(openerFirst, closerLast + 1);
    // Nothing else is inside the block: no sitcom between the two features, and
    // no third feature started.
    expect(block.filter((entry) => entry.kind === "episode")).toEqual([]);
    expect(
      new Set(
        block
          .filter((entry) => entry.kind === "movie")
          .map((entry) => entry.movieOccurrenceKey),
      ),
    ).toEqual(
      new Set([`${date}:double-feature-1`, `${date}:double-feature-2`]),
    );

    // Exactly one bridge, and it is a whole block of spots inside the policy.
    const bridges = block.filter((entry) => entry.source === "movie-bridge");
    const bridgeIndexes = block
      .map((entry, index) => (entry.source === "movie-bridge" ? index : -1))
      .filter((index) => index >= 0);
    const bridgeRuns = bridgeIndexes.filter(
      (index, position) => index !== (bridgeIndexes[position - 1] ?? -2) + 1,
    );
    expect(bridgeRuns).toHaveLength(1);
    const bridgeMs = bridges.reduce(
      (total, entry) => total + entry.durationMs,
      0,
    );
    expect(bridgeMs).toBeGreaterThanOrEqual(60_000);
    expect(bridgeMs).toBeLessThanOrEqual(120_000);

    // Both features aired exactly once, in full, from the right source offsets:
    // the truncation is a split, never a loss of content.
    for (const key of [
      `${date}:double-feature-1`,
      `${date}:double-feature-2`,
    ]) {
      const parts = airings.filter((entry) => entry.movieOccurrenceKey === key);
      expect(parts.length).toBeGreaterThanOrEqual(1);
      const contentMs = parts.reduce(
        (total, entry) => total + (entry.contentDurationMs ?? entry.durationMs),
        0,
      );
      expect(contentMs).toBe(minutes * 60_000);
      let offset = 0;
      for (const part of parts) {
        expect(part.sourceOffsetMs ?? 0).toBe(offset);
        offset += part.contentDurationMs ?? part.durationMs;
      }
      // The break plan survives the split verbatim: every break of a 400-minute
      // feature is still at 20/40/60/80 per cent of the SOURCE file, whether it
      // aired before or after a midnight.
      expect(
        parts.flatMap((part) =>
          (part.midrolls ?? []).map(
            (midroll) => (part.sourceOffsetMs ?? 0) + midroll.offsetMs,
          ),
        ),
      ).toEqual([80, 160, 240, 320].map((minute) => minute * 60_000));
    }
  };

  checkBlock(
    [...saturday.schedule.entries, ...sunday.schedule.entries],
    "2026-09-12",
    400,
  );
  // Sunday's own pair is carried the same way into Monday, so the mechanism is
  // not a one-off: the block is resumed, bridged and closed again.
  checkBlock(
    [...sunday.schedule.entries, ...monday.schedule.entries],
    "2026-09-13",
    400,
  );
  fixture.close();
}, 60_000);

test("fall back is a 25-hour day and the feature still airs at 02:00", async () => {
  const fixture = await openMovieRepositories({
    now: () => new Date("2026-11-01T12:00:00.000Z"),
  });
  const channel = fixture.fixture.channel;
  const result = await fixture.service.generate(channel, "2026-11-01");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.schedule.durationMs).toBe(25 * 3_600_000);
  const nightly = result.schedule.entries.find(
    (entry) => entry.movieOccurrenceKey === "2026-11-01:nightly",
  )!;
  expect(nightly.localStart).toBe("02:00");
  const opener = result.schedule.entries.find(
    (entry) => entry.movieRole === "weekend-opener",
  )!;
  expect(opener.localStart).toBe("19:00");
  assertContiguous(result.schedule);
  fixture.close();
});
