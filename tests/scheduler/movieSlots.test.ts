import { expect, test } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

test("places the Friday movie at 8 PM local time with lazy mid-roll preview", () => {
  const { channel, pools, media } = demo("America/Chicago");
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });

  expect(result.ok).toBe(true);
  const movie = result.ok
    ? result.schedule.entries.find((entry) => entry.kind === "movie")
    : undefined;
  expect(movie).toMatchObject({
    localStart: "20:00",
    mediaId: "wacky-weekend",
  });
  expect(movie?.midrolls).toEqual([
    { offsetMs: 1_800_000, durationMs: 180_000 },
    { offsetMs: 3_600_000, durationMs: 180_000 },
  ]);
});

test("uses station IDs in the demo when filling toward a top-of-hour boundary", () => {
  const { channel, pools, media } = demo("America/Chicago");
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });

  expect(
    result.ok &&
      result.schedule.entries.some((entry) => entry.kind === "station-id"),
  ).toBe(true);
});

test("does not trigger a fixed 20:00 movie slot at 20:00:45", () => {
  const { channel, pools, media } = demo("America/Chicago");
  channel.dayparts = [
    {
      id: "evening",
      name: "Evening",
      days: [5],
      start: "19:00",
      end: "23:59",
      priority: 1,
    },
  ];
  channel.slots = [
    {
      id: "movie",
      days: [5],
      time: "20:00",
      poolIds: ["movies"],
      kind: "movie",
      fallbackPoolIds: [],
    },
    {
      id: "episodes",
      daypartId: "evening",
      days: [],
      poolIds: ["apartment-4b"],
      kind: "episode",
      fallbackPoolIds: [],
    },
  ];
  media.find((item) => item.kind === "episode")!.durationMs = 3_600_045;
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });
  expect(
    result.ok &&
      result.schedule.entries.some((entry) => entry.source === "movie"),
  ).toBe(false);
});

test("keeps movie mid-rolls out of the configured tail buffer", () => {
  const { channel, pools, media } = demo("America/Chicago");
  const movie = media.find((item) => item.kind === "movie")!;
  movie.durationMs = 7_800_000;
  channel.slots[0].movieMidroll = {
    intervalMinutes: 30,
    breakMinutes: 3,
    minimumMinutes: 60,
    maxBreaks: 4,
    tailBufferMinutes: 45,
    strategy: "lazy",
  };
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });
  const scheduled = result.ok
    ? result.schedule.entries.find((entry) => entry.kind === "movie")
    : undefined;
  expect(scheduled?.midrolls).toEqual([
    { offsetMs: 1_800_000, durationMs: 180_000 },
    { offsetMs: 3_600_000, durationMs: 180_000 },
  ]);
});

test("returns validation issues for malformed movie mid-roll policies", () => {
  const { channel, pools, media } = demo("America/Chicago");
  channel.slots[0].movieMidroll = {
    intervalMinutes: 0,
    breakMinutes: 0,
    minimumMinutes: -1,
    maxBreaks: -1,
    tailBufferMinutes: -1,
    strategy: "lazy",
  };
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });
  expect(result).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_BREAK_POLICY" }),
    ]),
  });
});

test("rejects fractional maxBreaks instead of emitting a rounded-up break", () => {
  const { channel, pools, media } = demo("America/Chicago");
  channel.slots[0].movieMidroll = {
    intervalMinutes: 30,
    breakMinutes: 3,
    minimumMinutes: 60,
    maxBreaks: 1.5,
    tailBufferMinutes: 0,
    strategy: "lazy",
  };
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });
  expect(result).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_BREAK_POLICY" }),
    ]),
  });
});
