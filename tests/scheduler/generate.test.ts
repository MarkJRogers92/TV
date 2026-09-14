import { expect, test } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

test("produces identical decisions and identity from identical snapshots", () => {
  const { channel, pools, media } = demo();
  const input = {
    channel,
    pools,
    items: media,
    date: "2026-09-14",
    history: [{ mediaId: media[0].id, at: "2026-09-13T12:00:00.000Z" }],
  };
  const first = generateSchedule({
    ...input,
    now: new Date("2026-09-13T13:00:00.000Z"),
  });
  const second = generateSchedule({
    ...input,
    now: new Date("2026-09-13T14:00:00.000Z"),
  });

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (first.ok && second.ok) {
    expect(first.schedule.id).toBe(second.schedule.id);
    expect(first.schedule.seed).toBe(second.schedule.seed);
    expect(first.schedule.entries).toEqual(second.schedule.entries);
    expect(first.schedule.generatedAt).not.toBe(second.schedule.generatedAt);
  }
});

test("fingerprints configuration, media metadata, and history snapshots", () => {
  const base = demo();
  const generated = generateSchedule({
    ...base,
    items: base.media,
    date: "2026-09-14",
    now: new Date(0),
  });
  expect(generated.ok).toBe(true);
  if (!generated.ok) return;

  const revisedConfiguration = demo();
  revisedConfiguration.pools[0].noRepeatMinutes += 1;
  const configurationResult = generateSchedule({
    ...revisedConfiguration,
    items: revisedConfiguration.media,
    date: "2026-09-14",
    now: new Date(0),
  });

  const revisedMedia = demo();
  revisedMedia.media[0].durationMs! += 1_000;
  const mediaResult = generateSchedule({
    ...revisedMedia,
    items: revisedMedia.media,
    date: "2026-09-14",
    now: new Date(0),
  });

  const historyResult = generateSchedule({
    ...base,
    items: base.media,
    date: "2026-09-14",
    history: [{ mediaId: base.media[0].id, at: "2026-09-14T04:59:00.000Z" }],
    now: new Date(0),
  });
  for (const result of [configurationResult, mediaResult, historyResult]) {
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.id).not.toBe(generated.schedule.id);
  }
});

test("uses fallback pools in listed order and records the fallback decision", () => {
  const { channel, pools, media } = demo();
  channel.dayparts = [
    {
      id: "all-day",
      name: "All day",
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "00:00",
      priority: 1,
    },
  ];
  channel.slots = [
    {
      id: "fallback-rule",
      daypartId: "all-day",
      days: [],
      poolIds: ["empty-primary"],
      fallbackPoolIds: ["empty-fallback", "apartment-4b"],
      kind: "episode",
    },
  ];
  pools.push(
    {
      id: "empty-primary",
      name: "Empty primary",
      kinds: ["episode"],
      mediaIds: [],
      mode: "chronological",
      noRepeatMinutes: 0,
      weight: 1,
    },
    {
      id: "empty-fallback",
      name: "Empty fallback",
      kinds: ["episode"],
      mediaIds: [],
      mode: "chronological",
      noRepeatMinutes: 0,
      weight: 1,
    },
  );
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-14",
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(
      result.schedule.entries.find((entry) => entry.kind === "episode")
        ?.mediaId,
    ).toBe("apartment-4b-1");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "FALLBACK_POOL" }),
    );
  }
});

test("invalid regeneration returns issues without requiring a schedule replacement", () => {
  const { channel, pools, media } = demo();
  channel.slots[0].poolIds = ["missing"];
  expect(
    generateSchedule({ channel, pools, items: media, date: "2026-09-14" }),
  ).toEqual(
    expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_POOL" }),
      ]),
    }),
  );
});

test("rejects impossible calendar dates without emitting a NaN schedule", () => {
  const base = demo();
  expect(
    generateSchedule({ ...base, items: base.media, date: "2026-02-31" }),
  ).toEqual(
    expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_DATE" }),
      ]),
    }),
  );
});

test("uses deterministic configured weights across eligible primary show pools", () => {
  const selected: string[] = [];
  for (let day = 1; day <= 12; day += 1) {
    const base = demo();
    base.channel.dayparts = [
      {
        id: "all-day",
        name: "All day",
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "00:00",
        end: "00:00",
        priority: 1,
      },
    ];
    base.channel.slots = [
      {
        id: "weighted",
        daypartId: "all-day",
        days: [],
        poolIds: ["apartment-4b", "space-neighbors"],
        kind: "episode",
        fallbackPoolIds: [],
      },
    ];
    base.pools.find((pool) => pool.id === "apartment-4b")!.weight = 1;
    base.pools.find((pool) => pool.id === "space-neighbors")!.weight = 100;
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    const result = generateSchedule({ ...base, items: base.media, date });
    expect(result.ok).toBe(true);
    if (result.ok)
      selected.push(
        result.schedule.entries.find((entry) => entry.kind === "episode")!
          .mediaId!,
      );
  }
  expect(
    selected.filter((id) => id.startsWith("space-neighbors")).length,
  ).toBeGreaterThanOrEqual(11);

  const repeated = demo();
  repeated.channel.dayparts = [
    {
      id: "all-day",
      name: "All day",
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "00:00",
      priority: 1,
    },
  ];
  repeated.channel.slots = [
    {
      id: "weighted",
      daypartId: "all-day",
      days: [],
      poolIds: ["apartment-4b", "space-neighbors"],
      kind: "episode",
      fallbackPoolIds: [],
    },
  ];
  repeated.pools.find((pool) => pool.id === "apartment-4b")!.weight = 1;
  repeated.pools.find((pool) => pool.id === "space-neighbors")!.weight = 100;
  const again = generateSchedule({
    ...repeated,
    items: repeated.media,
    date: "2026-09-01",
  });
  expect(
    again.ok &&
      again.schedule.entries.find((entry) => entry.kind === "episode")?.mediaId,
  ).toBe(selected[0]);
});

test("fills periods without an active slot and a final overrun with safe flex", () => {
  const base = demo();
  base.channel.dayparts = [
    {
      id: "late",
      name: "Late",
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "23:00",
      end: "00:00",
      priority: 1,
    },
  ];
  base.channel.slots = [
    {
      id: "late",
      daypartId: "late",
      days: [],
      poolIds: ["apartment-4b"],
      kind: "episode",
      fallbackPoolIds: [],
    },
  ];
  const pool = base.pools.find((entry) => entry.id === "apartment-4b")!;
  pool.mediaIds = [base.media[0].id];
  pool.noRepeatMinutes = 0;
  base.media[0].durationMs = 90 * 60_000;
  const result = generateSchedule({
    ...base,
    items: base.media,
    date: "2026-09-13",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.schedule.entries[0]).toMatchObject({
    kind: "flex",
    localStart: "00:00",
    selectionExplanation: "No active programming slot",
  });
  expect(result.schedule.entries.at(-1)).toMatchObject({
    kind: "flex",
    localEnd: "00:00",
    sourceDaypartId: "late",
    sourceSlotId: "late",
    selectionExplanation: "Selected program exceeds broadcast day",
  });
  expect(
    result.schedule.entries.some(
      (entry) => entry.end > "2026-09-14T05:00:00.000Z",
    ),
  ).toBe(false);
});

test("records source daypart, source slot, and selection explanation", () => {
  const base = demo();
  const result = generateSchedule({
    ...base,
    items: base.media,
    date: "2026-09-14",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const episode = result.schedule.entries.find(
    (entry) => entry.kind === "episode",
  )!;
  expect(episode).toMatchObject({
    sourceDaypartId: "overnight",
    sourceSlotId: "overnight-shows",
    selectionExplanation: expect.stringMatching(
      /weighted pool .*chronological next episode/i,
    ),
  });
});
