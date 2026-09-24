import { expect, test } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

function episodeMidrollFixture() {
  const fixture = demo("UTC");
  fixture.channel.dayparts = [
    {
      id: "all-day",
      name: "All day",
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "00:00",
      priority: 1,
    },
  ];
  fixture.channel.slots = [
    {
      id: "episodes",
      daypartId: "all-day",
      days: [],
      poolIds: ["apartment-4b"],
      kind: "episode",
      fallbackPoolIds: [],
      episodeMidroll: {
        targetMinutes: [7.5, 15],
        searchWindowMinutes: 1.5,
        breakMinutes: 2.5,
        minimumSegmentMinutes: 2,
        tailBufferMinutes: 2,
      },
    },
  ];
  fixture.pools.find((pool) => pool.id === "apartment-4b")!.noRepeatMinutes = 0;
  fixture.media = fixture.media.filter((item) =>
    ["apartment-4b-1", "apartment-4b-2", "ad-1", "bumper-1", "filler-1", "id-1"].includes(
      item.id,
    ),
  );
  fixture.pools.forEach((pool) => {
    pool.mediaIds = pool.mediaIds.filter((id) =>
      fixture.media.some((item) => item.id === id),
    );
  });
  return fixture;
}

test("budgets two episode breaks inside each thirty-minute broadcast block", () => {
  const fixture = episodeMidrollFixture();
  const result = generateSchedule({
    channel: fixture.channel,
    pools: fixture.pools,
    items: fixture.media,
    date: "2026-09-14",
    episodeBreakAnalyses: {
      "apartment-4b-1": {
        offsetsMs: [448_500, 903_500],
        fallbackTargetIndexes: [],
      },
    },
  } as never);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const firstEpisode = result.schedule.entries[0];
  expect(firstEpisode).toMatchObject({
    kind: "episode",
    localStart: "00:00",
    localEnd: "00:28",
    contentDurationMs: 1_380_000,
    durationMs: 1_680_000,
    midrolls: [
      { offsetMs: 448_500, durationMs: 150_000 },
      { offsetMs: 903_500, durationMs: 150_000 },
    ],
  });
  expect(result.schedule.entries[1]).toMatchObject({
    kind: expect.not.stringContaining("episode"),
    start: firstEpisode.end,
  });
  const nextEpisode = result.schedule.entries.find(
    (entry, index) => index > 0 && entry.kind === "episode",
  );
  expect(nextEpisode?.localStart).toBe("00:30");
  expect(nextEpisode?.mediaId).toBe("apartment-4b-2");
  const firstBlockDuration = result.schedule.entries
    .filter(
      (entry) =>
        Date.parse(entry.start) < Date.parse("2026-09-14T00:30:00.000Z"),
    )
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  expect(firstBlockDuration).toBe(1_800_000);
});

test("records a diagnostic for each target that used the deterministic fallback", () => {
  const fixture = episodeMidrollFixture();
  const result = generateSchedule({
    channel: fixture.channel,
    pools: fixture.pools,
    items: fixture.media,
    date: "2026-09-14",
    episodeBreakAnalyses: {
      "apartment-4b-1": {
        offsetsMs: [450_000, 900_000],
        fallbackTargetIndexes: [0, 1],
      },
    },
  } as never);
  expect(result.ok).toBe(true);
  expect(result.ok && result.schedule.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "EPISODE_BREAK_FALLBACK",
        mediaId: "apartment-4b-1",
      }),
    ]),
  );
});

test("rejects duplicate and out-of-range episode break targets", () => {
  const fixture = episodeMidrollFixture();
  fixture.channel.slots[0].episodeMidroll = {
    targetMinutes: [15, 15],
    searchWindowMinutes: 1.5,
    breakMinutes: 2.5,
    minimumSegmentMinutes: 2,
    tailBufferMinutes: 2,
  } as never;
  expect(
    generateSchedule({
      channel: fixture.channel,
      pools: fixture.pools,
      items: fixture.media,
      date: "2026-09-14",
    }),
  ).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_BREAK_POLICY" }),
    ]),
  });

  fixture.channel.slots[0].episodeMidroll = {
    targetMinutes: [0, 15],
    searchWindowMinutes: 1.5,
    breakMinutes: 2.5,
    minimumSegmentMinutes: 2,
    tailBufferMinutes: 2,
  } as never;
  expect(
    generateSchedule({
      channel: fixture.channel,
      pools: fixture.pools,
      items: fixture.media,
      date: "2026-09-14",
    }),
  ).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_BREAK_POLICY" }),
    ]),
  });
});

test("skips episode breaks rather than drift when source timing cannot satisfy safety buffers", () => {
  const fixture = episodeMidrollFixture();
  fixture.media.find((item) => item.kind === "episode")!.durationMs = 950_000;
  const result = generateSchedule({
    channel: fixture.channel,
    pools: fixture.pools,
    items: fixture.media,
    date: "2026-09-14",
    episodeBreakAnalyses: {
      "apartment-4b-1": {
        offsetsMs: [450_000, 900_000],
        fallbackTargetIndexes: [0, 1],
      },
    },
  } as never);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.schedule.entries[0].midrolls).toBeUndefined();
  expect(result.schedule.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "EPISODE_BREAKS_SKIPPED_UNSAFE_OFFSETS",
      mediaId: "apartment-4b-1",
    }),
  );
});

test("omits breaks that would overrun the half-hour and keeps the next show aligned", () => {
  const fixture = episodeMidrollFixture();
  fixture.media.find((item) => item.kind === "episode")!.durationMs = 1_560_000;
  const result = generateSchedule({
    channel: fixture.channel,
    pools: fixture.pools,
    items: fixture.media,
    date: "2026-09-14",
    episodeBreakAnalyses: {
      "apartment-4b-1": {
        offsetsMs: [450_000, 900_000],
        fallbackTargetIndexes: [],
      },
    },
  } as never);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.schedule.entries[0]).toMatchObject({
    kind: "episode",
    durationMs: 1_560_000,
  });
  expect(result.schedule.entries[0].midrolls).toBeUndefined();
  expect(result.schedule.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "EPISODE_BREAKS_SKIPPED_BLOCK_OVERFLOW",
      mediaId: "apartment-4b-1",
    }),
  );
  expect(
    result.schedule.entries.find(
      (entry, index) => index > 0 && entry.kind === "episode",
    )?.localStart,
  ).toBe("00:30");
  expect(result.schedule.entries.find(
    (entry, index) => index > 0 && entry.kind === "episode",
  )?.mediaId).toBe("apartment-4b-2");
});

test("regenerates deterministically with the same detected offsets", () => {
  const fixture = episodeMidrollFixture();
  const input = {
    channel: fixture.channel,
    pools: fixture.pools,
    items: fixture.media,
    date: "2026-09-14",
    now: new Date("2026-09-14T12:00:00.000Z"),
    episodeBreakAnalyses: {
      "apartment-4b-1": {
        offsetsMs: [448_500, 903_500],
        fallbackTargetIndexes: [],
      },
    },
  };
  const first = generateSchedule(input as never);
  const second = generateSchedule(input as never);
  expect(second).toEqual(first);
});
