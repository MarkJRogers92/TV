import { expect, test } from "vitest";
import type { MediaItem, Schedule, ScheduleEntry } from "../../src/domain/models.js";
import { generatedContinuityTags, generatedFileName } from "../../src/continuity/assets.js";
import { planContinuityCards, type ContinuityCardPlan } from "../../src/continuity/director.js";
import { applyContinuityToSchedule, canPlaceCard } from "../../src/continuity/publish.js";
import { defaultContinuityConfig } from "../../src/continuity/types.js";
import { publishedContinuityHash } from "../../src/continuity/identity.js";

const scheduleEntry = (
  id: string,
  startMs: number,
  durationMs: number,
  kind: ScheduleEntry["kind"],
  mediaId?: string,
): ScheduleEntry => ({
  id,
  start: new Date(startMs).toISOString(),
  end: new Date(startMs + durationMs).toISOString(),
  localStart: "",
  localEnd: "",
  durationMs,
  kind,
  title: id,
  mediaId,
  path: mediaId ? `/media/${mediaId}.mp4` : undefined,
});

const media = (
  id: string,
  kind: MediaItem["kind"],
  durationMs: number,
  title = id,
  showTitle?: string,
): MediaItem => ({
  id,
  source: "local-folder",
  path: `/media/${id}.mp4`,
  kind,
  title,
  showTitle,
  durationMs,
  durationStatus: "ok",
  available: true,
  tags: [],
});

const start = Date.parse("2026-09-20T23:00:00.000Z");
const originalEntries = [
  scheduleEntry("roseanne-1", start, 20 * 60_000, "episode", "roseanne-1"),
  scheduleEntry("five-second-id", start + 20 * 60_000, 5_000, "station-id", "five-second-id"),
  scheduleEntry("commercial", start + 20 * 60_000 + 5_000, 25_000, "commercial", "commercial"),
  scheduleEntry("roseanne-2", start + 20 * 60_000 + 30_000, 20 * 60_000, "episode", "roseanne-2"),
];
const fixtureSchedule: Schedule = {
  id: "schedule-1",
  channelId: "marktv-laughs",
  date: "2026-09-20",
  timezone: "America/Chicago",
  seed: "seed",
  revision: "revision-1",
  generatedAt: "2026-09-20T12:00:00.000Z",
  durationMs: originalEntries.reduce((sum, entry) => sum + entry.durationMs, 0),
  entries: originalEntries,
  diagnostics: [],
};
const catalog = [
  media("roseanne-1", "episode", 20 * 60_000, "Pilot", "Roseanne"),
  media("roseanne-2", "episode", 20 * 60_000, "Next", "Roseanne"),
  media("five-second-id", "station-id", 5_000, "marktv-id-primary"),
  media("commercial", "commercial", 25_000),
  media("next-roseanne", "bumper", 5_000, "marktv-up-next-roseanne"),
];

test("replaces complete boundary items with scoped continuity and preserves every timing", () => {
  const result = applyContinuityToSchedule({
    schedule: fixtureSchedule,
    media: catalog,
    config: { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 },
    history: [],
  });

  expect(result.decisions).toHaveLength(1);
  expect(publishedContinuityHash(result.schedule)).toBe(result.contentHash);
  const changed = structuredClone(result.schedule);
  changed.entries[0]!.title = "Changed programme";
  expect(publishedContinuityHash(changed)).toBeUndefined();
  expect(result.decisions[0]).toMatchObject({
    assetId: expect.stringContaining("next-roseanne"),
    targetAiringId: "roseanne-2",
    scheduleRevision: fixtureSchedule.id,
  });
  expect(result.schedule.entries.map((entry) => entry.mediaId)).toEqual([
    "roseanne-1",
    "commercial",
    "next-roseanne",
    "roseanne-2",
  ]);
  expect(result.schedule.entries.reduce((sum, entry) => sum + entry.durationMs, 0)).toBe(
    fixtureSchedule.durationMs,
  );
  for (let index = 1; index < result.schedule.entries.length; index += 1)
    expect(result.schedule.entries[index].start).toBe(result.schedule.entries[index - 1].end);
});

test("leaves the validated break unchanged when continuity cannot fit exactly", () => {
  const result = applyContinuityToSchedule({
    schedule: fixtureSchedule,
    media: catalog.map((item) =>
      item.id === "next-roseanne" ? { ...item, durationMs: 8_000 } : item,
    ),
    config: { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 },
    history: [],
  });
  expect(result.decisions).toEqual([]);
  expect(result.schedule).toEqual(fixtureSchedule);
});

test("checks clock claims against the composed bumper start rather than break start", () => {
  const base = singleBreakSchedule(new Date(start + 20 * 60_000 + 30_000).toISOString());
  const desiredBreakStart = Date.parse("2026-09-21T06:59:35.000Z"); // 01:59:35 local; composed card follows the 25-second commercial
  const delta = desiredBreakStart - (start + 20 * 60_000);
  const schedule: Schedule = {
    ...base,
    entries: base.entries.map((entry) => ({
      ...entry,
      start: new Date(Date.parse(entry.start) + delta).toISOString(),
      end: new Date(Date.parse(entry.end) + delta).toISOString(),
    })),
  };
  const [plan] = planContinuityCards({
    schedule,
    media: generatedCatalog(),
    config: { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 },
  }).plans;
  expect(plan).toBeDefined();
  expect(plan!.insertionInstant).toBe(new Date(desiredBreakStart).toISOString());
  const shared = {
    schedule,
    media: generatedCatalog(),
    plan: plan!,
    config: { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 },
    durationMs: 5_000,
  };
  expect(canPlaceCard(shared)).toBe(true);
  expect(canPlaceCard({ ...shared, requiredLocalTime: "02:00" })).toBe(true);
  expect(canPlaceCard({ ...shared, requiredLocalTime: "01:59" })).toBe(false);
});

test("disabled continuity is a byte-equivalent no-op", () => {
  const result = applyContinuityToSchedule({
    schedule: fixtureSchedule,
    media: catalog,
    config: { ...defaultContinuityConfig, enabled: false },
    history: [],
  });
  expect(result.decisions).toEqual([]);
  expect(result.schedule).toBe(fixtureSchedule);
});

test("applies clip cooldown to continuity already planned in the same schedule", () => {
  const firstBreakStart = start + 20 * 60_000;
  const secondEpisodeStart = firstBreakStart + 30_000;
  const secondBreakStart = secondEpisodeStart + 20 * 60_000;
  const entries = [
    scheduleEntry("roseanne-1", start, 20 * 60_000, "episode", "roseanne-1"),
    scheduleEntry("id-1", firstBreakStart, 5_000, "station-id", "id-1"),
    scheduleEntry("commercial-1", firstBreakStart + 5_000, 25_000, "commercial", "commercial-1"),
    scheduleEntry("roseanne-2", secondEpisodeStart, 20 * 60_000, "episode", "roseanne-2"),
    scheduleEntry("id-2", secondBreakStart, 5_000, "station-id", "id-2"),
    scheduleEntry("commercial-2", secondBreakStart + 5_000, 25_000, "commercial", "commercial-2"),
    scheduleEntry("roseanne-3", secondBreakStart + 30_000, 20 * 60_000, "episode", "roseanne-3"),
  ];
  const schedule: Schedule = {
    ...fixtureSchedule,
    id: "schedule-with-two-breaks",
    entries,
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
  const result = applyContinuityToSchedule({
    schedule,
    media: [
      media("roseanne-1", "episode", 20 * 60_000, "Pilot", "Roseanne"),
      media("roseanne-2", "episode", 20 * 60_000, "Next", "Roseanne"),
      media("roseanne-3", "episode", 20 * 60_000, "Third", "Roseanne"),
      media("id-1", "station-id", 5_000, "marktv-id-primary"),
      media("id-2", "station-id", 5_000, "marktv-id-secondary"),
      media("commercial-1", "commercial", 25_000),
      media("commercial-2", "commercial", 25_000),
      media("next-roseanne", "bumper", 5_000, "marktv-up-next-roseanne"),
    ],
    config: { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 },
    history: [],
  });

  expect(result.decisions).toHaveLength(1);
  expect(result.schedule.entries.filter((entry) => entry.mediaId === "next-roseanne")).toHaveLength(1);
});

const singleBreakSchedule = (nextStart: string): Schedule => {
  const entries = [
    scheduleEntry("roseanne-1", start, 20 * 60_000, "episode", "roseanne-1"),
    scheduleEntry("id-1", start + 20 * 60_000, 5_000, "station-id", "id-1"),
    scheduleEntry("commercial-1", start + 20 * 60_000 + 5_000, 25_000, "commercial", "commercial-1"),
    scheduleEntry("roseanne-2", Date.parse(nextStart), 20 * 60_000, "episode", "roseanne-2"),
  ];
  return {
    ...fixtureSchedule,
    id: "schedule-generated",
    entries,
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
};

const generatedCatalog = () => [
  media("roseanne-1", "episode", 20 * 60_000, "Pilot", "Roseanne"),
  media("roseanne-2", "episode", 20 * 60_000, "Next", "Roseanne"),
  media("id-1", "station-id", 5_000, "marktv-id-primary"),
  media("commercial-1", "commercial", 25_000),
];

const generatedItem = (
  plan: ContinuityCardPlan,
): MediaItem => ({
  id: `continuity-${plan.cardType}-generated`,
  source: "local-folder",
  path: `/generated/${generatedFileName(plan)}`,
  kind: "bumper",
  title: plan.id,
  durationMs: plan.durationMs,
  durationStatus: "ok",
  available: true,
  tags: generatedContinuityTags(plan),
});

test("inserts a registered generated card and retires it when the lineup changes", () => {
  const config = { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 };
  const media = generatedCatalog();
  const scheduleA = singleBreakSchedule("2026-09-20T23:20:30.000Z");
  const [card] = planContinuityCards({ schedule: scheduleA, media, config }).plans;
  expect(card?.cardType).toBe("next");
  const catalogWithCard = [...media, generatedItem(card!)];

  const applied = applyContinuityToSchedule({
    schedule: scheduleA,
    media: catalogWithCard,
    config,
    history: [],
  });
  expect(applied.decisions).toHaveLength(1);
  expect(applied.decisions[0]).toMatchObject({
    cardType: "next",
    family: card!.family,
    contentHash: card!.contentHash,
  });
  expect(applied.schedule.entries.some((entry) => entry.source === "continuity:next")).toBe(true);
  // Every editorial start and the whole break budget survive byte-for-byte.
  for (const original of scheduleA.entries.filter(
    (entry) => entry.kind === "episode" || entry.kind === "movie",
  )) {
    const found = applied.schedule.entries.find((entry) => entry.id === original.id);
    expect(found, original.id).toBeDefined();
    expect(found!.start).toBe(original.start);
    expect(found!.end).toBe(original.end);
  }
  expect(applied.schedule.entries.reduce((sum, item) => sum + item.durationMs, 0)).toBe(
    scheduleA.durationMs,
  );

  // A regenerated lineup mints a new content hash, so the earlier card is no
  // longer a truthful description of the break and is not reused.
  const scheduleB = singleBreakSchedule("2026-09-20T23:25:30.000Z");
  const stale = applyContinuityToSchedule({
    schedule: scheduleB,
    media: catalogWithCard,
    config,
    history: [],
  });
  expect(stale.decisions).toEqual([]);
  expect(stale.schedule).toBe(scheduleB);
});

test("never leaves more than one informational card in a break", () => {
  const config = { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 };
  const media = generatedCatalog();
  const scheduleA = singleBreakSchedule("2026-09-20T23:20:30.000Z");
  const [card] = planContinuityCards({ schedule: scheduleA, media, config }).plans;
  const applied = applyContinuityToSchedule({
    schedule: scheduleA,
    media: [...media, generatedItem(card!)],
    config,
    history: [],
  });
  const informational = applied.schedule.entries.filter(
    (entry) => entry.source?.startsWith("continuity:"),
  );
  expect(informational).toHaveLength(1);
  const firstBreakIndex = applied.schedule.entries.findIndex(
    (entry) => entry.kind !== "episode" && entry.kind !== "movie",
  );
  const breakEntries = [];
  for (let index = firstBreakIndex; index < applied.schedule.entries.length; index += 1) {
    const entry = applied.schedule.entries[index]!;
    if (entry.kind === "episode" || entry.kind === "movie") break;
    breakEntries.push(entry);
  }
  expect(
    breakEntries.filter((entry) => entry.source?.startsWith("continuity:")).length,
  ).toBeLessThanOrEqual(1);
});

test("leaves a break that ends the schedule completely untouched", () => {
  const config = { ...defaultContinuityConfig, enabled: true, promoFrequency: 1 };
  const catalogWithNext = [
    ...generatedCatalog(),
    media("next-roseanne", "bumper", 5_000, "marktv-up-next-roseanne"),
  ];
  const entries = [
    scheduleEntry("roseanne-1", start, 20 * 60_000, "episode", "roseanne-1"),
    scheduleEntry("roseanne-2", start + 20 * 60_000, 20 * 60_000, "episode", "roseanne-2"),
    scheduleEntry("trailing-id", start + 40 * 60_000, 5_000, "station-id", "id-1"),
    scheduleEntry("trailing-ad", start + 40 * 60_000 + 5_000, 25_000, "commercial", "commercial-1"),
  ];
  const trailing: Schedule = {
    ...fixtureSchedule,
    id: "schedule-trailing-break",
    entries,
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
  const applied = applyContinuityToSchedule({
    schedule: trailing,
    media: catalogWithNext,
    config,
    history: [],
  });
  // The schedule ends on a break - the airing after it belongs to the next
  // broadcast day - so its exact ending cannot be re-derived here and it is
  // returned byte-for-byte.
  expect(applied.decisions).toEqual([]);
  expect(applied.schedule).toBe(trailing);
});

const refillChannel = (poolIds: string[]) => ({
  id: "marktv-laughs",
  name: "MarkTV Laughs",
  number: 1,
  timezone: "America/Chicago",
  enabled: true,
  revision: "1",
  dayparts: [],
  slots: [],
  breakPolicy: {
    boundaryMinutes: 30,
    poolIds,
    stationIdPoolIds: [],
    cooldownMinutes: 120,
  },
});

const refillPool = (mediaIds: string[]) => ({
  id: "ads",
  name: "Ads",
  kinds: ["commercial"] as const,
  mediaIds,
  mode: "shuffle" as const,
  noRepeatMinutes: 0,
  weight: 1,
});

/** A break whose only item is a 60s spot: no whole item is exactly 5s or 10s. */
const sixtySecondBreak = (): Schedule => {
  const entries = [
    scheduleEntry("roseanne-1", start, 20 * 60_000, "episode", "roseanne-1"),
    scheduleEntry("big-ad", start + 20 * 60_000, 60_000, "commercial", "big-ad"),
    scheduleEntry("roseanne-2", start + 20 * 60_000 + 60_000, 20 * 60_000, "episode", "roseanne-2"),
  ];
  return {
    ...fixtureSchedule,
    id: "schedule-refill",
    entries,
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
};

const refillMedia = () => [
  media("roseanne-1", "episode", 20 * 60_000, "Pilot", "Roseanne"),
  media("roseanne-2", "episode", 20 * 60_000, "Next", "Roseanne"),
  media("big-ad", "commercial", 60_000),
  media("ad-25", "commercial", 25_000),
  media("ad-30", "commercial", 30_000),
  media("other-channel-ad", "commercial", 30_000),
  media("next-roseanne", "bumper", 5_000, "marktv-up-next-roseanne"),
];

test("reserves the card duration and refills exactly from the channel's own pool", () => {
  const schedule = sixtySecondBreak();
  const applied = applyContinuityToSchedule({
    schedule,
    media: refillMedia(),
    config: { ...defaultContinuityConfig, enabled: true },
    history: [],
    environment: {
      channel: refillChannel([ "ads" ]) as never,
      pools: [refillPool(["ad-25", "ad-30", "big-ad"]) as never],
      fillerHistory: [],
    },
  });

  expect(applied.decisions).toHaveLength(1);
  expect(applied.decisions[0]!.cardType).toBe("next");
  const breakEntries = applied.schedule.entries.filter(
    (entry) => entry.kind !== "episode" && entry.kind !== "movie",
  );
  // The 5s card replaced the 60s spot and the released 55s was filled exactly
  // from the channel's own pool: no dead air, and the break end never moved.
  expect(breakEntries.map((entry) => entry.mediaId).sort()).toEqual([
    "ad-25",
    "ad-30",
    "next-roseanne",
  ]);
  expect(breakEntries.reduce((sum, entry) => sum + entry.durationMs, 0)).toBe(60_000);
  expect(breakEntries.some((entry) => entry.kind === "flex")).toBe(false);
  expect(breakEntries.some((entry) => entry.mediaId === "other-channel-ad")).toBe(false);
  const commercialMs = breakEntries
    .filter((entry) => entry.kind === "commercial")
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  expect(commercialMs * 2).toBeGreaterThan(60_000);
  // Every editorial airing keeps its exact start and end.
  expect(applied.schedule.entries.at(-1)!.start).toBe(schedule.entries.at(-1)!.start);
  expect(applied.schedule.entries.reduce((sum, entry) => sum + entry.durationMs, 0)).toBe(
    schedule.durationMs,
  );
});

test("leaves the break untouched when the channel pool cannot fill it exactly", () => {
  const schedule = sixtySecondBreak();
  const applied = applyContinuityToSchedule({
    schedule,
    media: refillMedia(),
    config: { ...defaultContinuityConfig, enabled: true },
    history: [],
    environment: {
      channel: refillChannel(["ads"]) as never,
      pools: [refillPool(["ad-30"]) as never],
      fillerHistory: [],
    },
  });
  // Removing the 60s spot would leave a 55s gap that the channel's single 30s
  // spot cannot cover; a residual would become dead air, so the break stays.
  expect(applied.decisions).toEqual([]);
  expect(applied.schedule).toBe(schedule);
});

test("refuses a second card when a legacy information bumper already owns the break", () => {
  const base = sixtySecondBreak();
  const opening = base.entries[0]!;
  const trailing = base.entries[2]!;
  const breakStart = Date.parse(opening.end);
  const nextStart = breakStart + 60_000;
  const entries = [
    opening,
    scheduleEntry("legacy-next", breakStart, 5_000, "station-id", "next-roseanne"),
    scheduleEntry("big-ad", breakStart + 5_000, 55_000, "commercial", "big-ad"),
    {
      ...trailing,
      start: new Date(nextStart).toISOString(),
      end: new Date(nextStart + trailing.durationMs).toISOString(),
    },
  ];
  const schedule: Schedule = {
    ...base,
    entries,
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
  const applied = applyContinuityToSchedule({
    schedule,
    media: refillMedia(),
    config: { ...defaultContinuityConfig, enabled: true },
    history: [],
    environment: {
      channel: refillChannel(["ads"]) as never,
      pools: [refillPool(["ad-25", "ad-30", "big-ad"]) as never],
      fillerHistory: [],
    },
  });
  expect(applied.decisions).toEqual([]);
  expect(applied.schedule).toBe(schedule);
  expect(
    applied.schedule.entries.filter((entry) => entry.source?.startsWith("continuity:")),
  ).toEqual([]);
});
