import { expect, test } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

/**
 * A linear channel is a 24h loop, so the midnight seam is not a corner case --
 * it is the join the player crosses every day. Two properties matter and are
 * easy to lose silently:
 *
 *   1. a day fills exactly 24 hours, with no dead air and no overlap anywhere;
 *   2. one day begins at the instant the previous one ends, so the loop has no
 *      gap or repeated content at the wrap.
 */
const generate = (date: string) => {
  const { channel, pools, media } = demo();
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date,
    now: new Date(`${date}T00:00:00.000Z`),
  });
  if (!result.ok) throw new Error(`schedule generation failed for ${date}`);
  return result.schedule;
};

const DAY_MS = 86_400_000;

test("[PL16] a generated day fills exactly 24 hours with no gaps or overlaps", () => {
  const schedule = generate("2026-09-14");
  const entries = [...schedule.entries].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );

  expect(entries.length).toBeGreaterThan(0);

  const first = Date.parse(entries[0].start);
  const last = Date.parse(entries[entries.length - 1].end);
  expect(last - first).toBe(DAY_MS);

  for (let index = 1; index < entries.length; index += 1) {
    const previousEnd = Date.parse(entries[index - 1].end);
    const currentStart = Date.parse(entries[index].start);
    // Contiguity is exact: any drift here becomes dead air or a skipped moment
    // at the join, which is precisely what a viewer notices.
    expect(currentStart).toBe(previousEnd);
  }
});

test("consecutive days meet exactly at midnight", () => {
  const today = generate("2026-09-14");
  const tomorrow = generate("2026-09-15");

  const firstOfTomorrow = Date.parse(
    [...tomorrow.entries].sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start),
    )[0].start,
  );
  const lastOfToday = Date.parse(
    [...today.entries].sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start),
    )[today.entries.length - 1].end,
  );

  // The wrap is where the channel loops, so the join must be seamless both ways.
  expect(firstOfTomorrow).toBe(lastOfToday);

  const localMidnight = tomorrow.entries[0].localStart;
  expect(firstOfTomorrow).toBe(Date.parse(tomorrow.entries[0].start));
  expect(localMidnight).toBe("00:00");
});

test("the day boundary holds in the channel's own timezone, not UTC", () => {
  const schedule = generate("2026-09-14");
  const start = Date.parse(schedule.entries[0].start);
  // America/Chicago is UTC-5 in September, so local midnight is 05:00Z. A
  // schedule anchored to UTC midnight would start the day at the wrong instant.
  expect(new Date(start).toISOString()).toBe("2026-09-14T05:00:00.000Z");
});
