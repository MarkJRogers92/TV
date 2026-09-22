import { describe, expect, test } from "vitest";
import type { MediaItem, MovieRole, Schedule, ScheduleEntry } from "../../src/domain/models.js";
import {
  frequencyDailyCap,
  frequencyIntervalMinutes,
  planContinuityCards,
} from "../../src/continuity/director.js";
import { defaultContinuityConfig, type ContinuityConfig } from "../../src/continuity/types.js";

const BREAK_ID = "break-id";
const COMMERCIAL = "commercial";

const entry = (
  id: string,
  start: string,
  minutes: number,
  kind: ScheduleEntry["kind"],
  mediaId: string,
  extra: Partial<ScheduleEntry> = {},
): ScheduleEntry => {
  const startMs = Date.parse(start);
  const durationMs = Math.round(minutes * 60_000);
  return {
    id,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + durationMs).toISOString(),
    localStart: "",
    localEnd: "",
    durationMs,
    kind,
    title: id,
    mediaId,
    path: `/media/${mediaId}.mp4`,
    ...extra,
  };
};

const breakEntries = (start: string): ScheduleEntry[] => [
  entry(BREAK_ID, start, 0.0833, "station-id", "id-primary"),
  entry(COMMERCIAL, new Date(Date.parse(start) + 5_000).toISOString(), 0.4167, "commercial", "commercial"),
];

const schedule = (entries: ScheduleEntry[], date = "2026-09-20"): Schedule => ({
  id: `schedule-${date}`,
  channelId: "marktv-laughs",
  date,
  timezone: "America/Chicago",
  seed: "seed",
  revision: "revision-1",
  generatedAt: "2026-09-20T12:00:00.000Z",
  durationMs: entries.reduce((sum, item) => sum + item.durationMs, 0),
  entries,
  diagnostics: [],
});

const episode = (id: string, show: string, minutes = 30): MediaItem => ({
  id,
  source: "local-folder",
  path: `/media/${id}.mp4`,
  kind: "episode",
  title: `${show} episode`,
  showTitle: show,
  durationMs: minutes * 60_000,
  durationStatus: "ok",
  available: true,
  tags: [],
});

const movie = (id: string, title: string, minutes = 120): MediaItem => ({
  id,
  source: "local-folder",
  path: `/media/${id}.mp4`,
  kind: "movie",
  title,
  durationMs: minutes * 60_000,
  durationStatus: "ok",
  available: true,
  tags: [],
});

const filler = (): MediaItem[] => [
  {
    id: "id-primary",
    source: "local-folder",
    path: "/media/id-primary.mp4",
    kind: "station-id",
    title: "marktv-id-primary",
    durationMs: 5_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  },
  {
    id: "commercial",
    source: "local-folder",
    path: "/media/commercial.mp4",
    kind: "commercial",
    title: "commercial",
    durationMs: 25_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  },
];

const config = (overrides: Partial<ContinuityConfig> = {}): ContinuityConfig => ({
  ...defaultContinuityConfig,
  ...overrides,
});

describe("planContinuityCards", () => {
  test("names the immediate next episode by series and the next movie by title", () => {
    const media = [
      episode("a", "Roseanne"),
      episode("b", "Night Court"),
      movie("film", "Tremors"),
      ...filler(),
    ];
    const scheduleEntries = [
      entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
      ...breakEntries("2026-09-20T23:30:00.000Z"),
      entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
    ];
    const planned = planContinuityCards({
      schedule: schedule(scheduleEntries),
      media,
      config: config(),
    });
    expect(planned.plans).toHaveLength(1);
    expect(planned.plans[0]).toMatchObject({
      cardType: "next",
      title: "Night Court",
      durationMs: 5_000,
      target: { airingIds: ["b-1"], titles: ["Night Court"] },
    });

    const movieSchedule = [
      entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
      ...breakEntries("2026-09-20T23:30:00.000Z"),
      entry("film-1", "2026-09-20T23:30:30.000Z", 120, "movie", "film"),
    ];
    const plannedMovie = planContinuityCards({
      schedule: schedule(movieSchedule),
      media,
      config: config(),
    });
    // A film that is immediately next is still the right TONIGHT target: the
    // brief promotes the evening movie window ahead of the ordinary NEXT card.
    expect(plannedMovie.plans[0]).toMatchObject({
      cardType: "tonight",
      title: "Tremors",
      details: ["STARTS 6:30 PM"],
    });
  });

  test("says MORE {SHOW} NEXT when the next episode is the same series, never NEXT {same show}", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Roseanne"), ...filler()];
    const planned = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
      ]),
      media,
      config: config(),
    });
    const card = planned.plans[0]!;
    expect(card.cardType).toBe("next");
    expect(card.title).toBe("Roseanne");
    expect(["MORE", "STILL MORE", "MORE FROM", "STILL AHEAD"]).toContain(card.label);
    expect(card.label).not.toBe("NEXT");
    expect(card.details.join(" ")).toMatch(/NEXT|MORE/);
  });

  test("prefers a distinct NEXT/LATER programme and falls back to NEXT when there is none", () => {
    const media = [
      episode("a", "Roseanne"),
      episode("b", "Night Court"),
      episode("c", "Cheers"),
      ...filler(),
    ];
    const withLater = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
        entry("c-1", "2026-09-21T00:00:30.000Z", 30, "episode", "c"),
      ]),
      media,
      config: config(),
    });
    expect(withLater.plans[0]).toMatchObject({
      cardType: "next-later",
      title: "Night Court",
      durationMs: 10_000,
      target: { titles: ["Night Court", "Cheers"] },
    });
    expect(withLater.plans[0]!.details.join(" ")).toContain("Cheers");

    const withoutLater = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
        entry("c-1", "2026-09-21T00:00:30.000Z", 30, "episode", "c"),
      ]),
      media,
      config: config(),
      // No NEXT/LATER card is registered yet, so the break keeps a NEXT card.
      isAvailable: (card) => card.cardType === "next",
    });
    expect(withoutLater.plans[0]!.cardType).toBe("next");
    expect(withoutLater.rejections.some((item) => item.reason === "NO_ASSET")).toBe(true);
  });

  test("promotes TONIGHT with the real channel time, including after midnight", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Night Court"), movie("film", "Tremors"), ...filler()];
    const late = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
        entry("film-1", "2026-09-21T07:07:00.000Z", 120, "movie", "film"),
      ]),
      media,
      // NEXT cards off so the one break can only be a TONIGHT card.
      config: config({ nextCards: false }),
    });
    const lateCard = late.plans.find((card) => card.title === "Tremors")!;
    expect(lateCard.cardType).toBe("tonight");
    expect(lateCard.details).toContain("STARTS 2:07 AM");

    const evening = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
        entry("film-1", "2026-09-21T00:30:00.000Z", 120, "movie", "film"),
      ]),
      media,
      config: config(),
    });
    expect(evening.plans[0]).toMatchObject({ cardType: "tonight", title: "Tremors" });
    expect(evening.plans[0]!.details).toContain("STARTS 7:30 PM");
  });

  test("promotes both films of a weekend double feature with the actual first start", () => {
    const media = [
      episode("a", "Roseanne"),
      episode("b", "Night Court"),
      movie("film-1", "Tremors"),
      movie("film-2", "The Blob"),
      ...filler(),
    ];
    const roles: MovieRole[] = ["weekend-opener", "weekend-closer"];
    const planned = planContinuityCards({
      schedule: schedule(
        [
          entry("a-1", "2026-09-19T23:00:00.000Z", 30, "episode", "a"),
          ...breakEntries("2026-09-19T23:30:00.000Z"),
          entry("b-1", "2026-09-19T23:30:30.000Z", 29.5, "episode", "b"),
          entry("film-1", "2026-09-20T00:00:00.000Z", 120, "movie", "film-1", {
            movieRole: roles[0],
            movieOccurrenceKey: "2026-09-19:weekend-opener",
          }),
          entry("film-2", "2026-09-20T02:30:00.000Z", 120, "movie", "film-2", {
            movieRole: roles[1],
            movieOccurrenceKey: "2026-09-19:weekend-closer",
          }),
        ],
        "2026-09-19",
      ),
      media,
      config: config(),
    });
    const card = planned.plans[0]!;
    expect(card).toMatchObject({
      cardType: "weekend",
      title: "Tremors",
      durationMs: 10_000,
      target: { titles: ["Tremors", "The Blob"] },
    });
    expect(card.details.join(" ")).toContain("STARTS 7:00 PM");
    expect(card.details.join(" ")).toContain("The Blob");
  });

  test("is deterministic for the same completed schedule", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Night Court"), ...filler()];
    const input = {
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
      ]),
      media,
      config: config(),
    };
    expect(planContinuityCards(input)).toEqual(planContinuityCards(input));
  });

  test("changes the schedule identity when the lineup changes", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Night Court"), ...filler()];
    const first = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
      ]),
      media,
      config: config(),
    });
    const second = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        ...breakEntries("2026-09-20T23:30:00.000Z"),
        entry("b-1", "2026-09-20T23:35:30.000Z", 30, "episode", "b"),
      ]),
      media,
      config: config(),
    });
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  test("holds the configured cadence and daily ceiling", () => {
    for (const [frequency, low, high] of [
      ["low", 90, 120],
      ["normal", 60, 90],
      ["high", 30, 60],
    ] as const) {
      const values = new Set<string>();
      for (let index = 0; index < 40; index += 1) {
        const minutes = frequencyIntervalMinutes(frequency, `seed-${index}`);
        expect(minutes).toBeGreaterThanOrEqual(low);
        expect(minutes).toBeLessThanOrEqual(high);
        values.add(`${minutes}`);
      }
      expect(values.size).toBeGreaterThan(1);
    }
    expect(frequencyDailyCap("low")).toBe(2);
    expect(frequencyDailyCap("normal")).toBe(5);
    expect(frequencyDailyCap("high")).toBe(8);
  });

  test("caps an ordinary target at two promotions per day across breaks", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Night Court"), ...filler()];
    const targetSchedule = schedule([
      entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
      ...breakEntries("2026-09-20T23:30:00.000Z"),
      entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
    ]);
    const history = ["2026-09-20T20:00:00.000Z", "2026-09-20T21:30:00.000Z"].map(
      (airedAt, index) => ({
        assetId: `existing:promo-${index}`,
        targetAiringId: "b-1",
        targetKey: "b-1",
        personaId: "local" as const,
        cardType: "next" as const,
        family: "syndication" as const,
        airedAt,
      }),
    );
    const planned = planContinuityCards({
      schedule: targetSchedule,
      media,
      config: config(),
      history,
    });
    expect(planned.rejections).toContainEqual(
      expect.objectContaining({ cardType: "next", reason: "TARGET_CAP" }),
    );
    expect(planned.plans).toEqual([]);

    // A target promoted minutes ago is inside its repeat cooldown instead. The
    // record carries no card type, as a legacy row would not, so the cadence
    // gate passes and the per-target cooldown is what refuses the card.
    const cooled = planContinuityCards({
      schedule: targetSchedule,
      media,
      config: config(),
      history: [
        {
          assetId: "existing:promo",
          targetAiringId: "b-1",
          targetKey: "b-1",
          personaId: "local",
          family: "syndication",
          airedAt: "2026-09-20T23:25:00.000Z",
        },
      ],
    });
    expect(cooled.rejections).toContainEqual(
      expect.objectContaining({ cardType: "next", reason: "REPEAT_COOLDOWN" }),
    );
  });

  test("never plans a card into a flex break", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Night Court"), ...filler()];
    const planned = planContinuityCards({
      schedule: schedule([
        entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
        entry("flex-1", "2026-09-20T23:30:00.000Z", 0.25, "flex", "flex"),
        entry("b-1", "2026-09-20T23:30:15.000Z", 30, "episode", "b"),
      ]),
      media,
      config: config(),
    });
    expect(planned.plans).toEqual([]);
  });

  test("never promotes a programme that has already begun", () => {
    const media = [movie("film", "Tremors"), episode("b", "Night Court"), ...filler()];
    const planned = planContinuityCards({
      schedule: schedule([
        entry("film-1", "2026-09-20T23:00:00.000Z", 120, "movie", "film"),
        ...breakEntries("2026-09-21T00:30:00.000Z"),
        entry("b-1", "2026-09-21T01:00:00.000Z", 30, "episode", "b"),
      ]),
      media,
      config: config(),
    });
    // The film is mid-air when the break happens: it is the resume target, not
    // news, so the break is filled by NEXT instead.
    expect(planned.plans.map((card) => card.cardType)).toEqual(["next"]);
    for (const card of planned.plans) {
      expect(Date.parse(card.target.times[0]!)).toBeGreaterThanOrEqual(
        Date.parse(card.insertionInstant),
      );
      expect(card.target.airingIds).not.toContain("film-1");
    }
  });

  test("does not silence NEXT with a five-a-day cap", () => {
    const media = [episode("a", "Roseanne"), episode("b", "Night Court"), ...filler()];
    const targetSchedule = schedule([
      entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
      ...breakEntries("2026-09-20T23:30:00.000Z"),
      entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
    ]);
    const history = [
      "2026-09-20T15:00:00.000Z",
      "2026-09-20T15:30:00.000Z",
      "2026-09-20T16:00:00.000Z",
      "2026-09-20T16:30:00.000Z",
      "2026-09-20T17:00:00.000Z",
      "2026-09-20T17:30:00.000Z",
    ].map((airedAt, index) => ({
      assetId: `existing:promo-${index}`,
      targetAiringId: `other-${index}`,
      targetKey: `other-${index}`,
      personaId: "local" as const,
      cardType: "next" as const,
      family: "syndication" as const,
      airedAt,
    }));
    const planned = planContinuityCards({
      schedule: targetSchedule,
      media,
      config: config(),
      history,
    });
    // Six earlier NEXT insertions today do not spend a daily ceiling, because
    // NEXT is the fallback on any suitable transition.
    expect(planned.plans.map((card) => card.cardType)).toEqual(["next"]);
  });

  test("limits NEXT/LATER by interval only, not by a five-a-day cap", () => {
    const media = [
      episode("a", "Roseanne"),
      episode("b", "Night Court"),
      episode("c", "Cheers"),
      ...filler(),
    ];
    const targetSchedule = schedule([
      entry("a-1", "2026-09-20T15:00:00.000Z", 30, "episode", "a"),
      ...breakEntries("2026-09-20T15:30:00.000Z"),
      entry("b-1", "2026-09-20T15:30:30.000Z", 30, "episode", "b"),
      entry("c-1", "2026-09-20T17:00:00.000Z", 30, "episode", "c"),
    ]);
    const history = [
      "2026-09-20T05:10:00.000Z",
      "2026-09-20T05:30:00.000Z",
      "2026-09-20T05:50:00.000Z",
      "2026-09-20T06:10:00.000Z",
      "2026-09-20T06:30:00.000Z",
      "2026-09-20T06:50:00.000Z",
    ].map((airedAt, index) => ({
      assetId: `existing:later-${index}`,
      targetAiringId: `other-${index}`,
      targetKey: `other-${index}`,
      personaId: "local" as const,
      cardType: "next-later" as const,
      family: "local-cable" as const,
      airedAt,
    }));
    const planned = planContinuityCards({
      schedule: targetSchedule,
      media,
      config: config(),
      history,
    });
    expect(planned.plans.map((card) => card.cardType)).toEqual(["next-later"]);
  });

  test("counts TONIGHT and the weekend pair against one daily bucket", () => {
    const media = [
      episode("a", "Roseanne"),
      episode("b", "Night Court"),
      movie("film", "Tremors"),
      ...filler(),
    ];
    const targetSchedule = schedule([
      entry("a-1", "2026-09-20T23:00:00.000Z", 30, "episode", "a"),
      ...breakEntries("2026-09-20T23:30:00.000Z"),
      entry("b-1", "2026-09-20T23:30:30.000Z", 30, "episode", "b"),
      entry("film-1", "2026-09-21T00:30:00.000Z", 120, "movie", "film"),
    ]);
    const history = [
      ...["2026-09-20T15:00:00.000Z", "2026-09-20T16:00:00.000Z", "2026-09-20T17:00:00.000Z"].map(
        (airedAt, index) => ({
          assetId: `existing:tonight-${index}`,
          targetAiringId: `t-${index}`,
          targetKey: `t-${index}`,
          personaId: "network" as const,
          cardType: "tonight" as const,
          family: "prime-time" as const,
          airedAt,
        }),
      ),
      {
        assetId: "existing:weekend-1",
        targetAiringId: "w-1",
        targetKey: "w-1",
        personaId: "network" as const,
        cardType: "weekend" as const,
        family: "prime-time" as const,
        airedAt: "2026-09-20T18:00:00.000Z",
      },
      {
        assetId: "existing:weekend-2",
        targetAiringId: "w-2",
        targetKey: "w-2",
        personaId: "network" as const,
        cardType: "weekend" as const,
        family: "prime-time" as const,
        airedAt: "2026-09-20T19:00:00.000Z",
      },
    ];
    const capped = planContinuityCards({
      schedule: targetSchedule,
      media,
      config: config(),
      history,
    });
    // The TONIGHT/weekend bucket is spent; a distinct NEXT/LATER card may still
    // take the break, but no TONIGHT card is planned.
    expect(capped.plans.map((card) => card.cardType)).not.toContain("tonight");
    expect(capped.rejections.some((item) => item.reason === "DAILY_CAP")).toBe(true);

    const under = planContinuityCards({
      schedule: targetSchedule,
      media,
      config: config(),
      history: history.slice(0, 4),
    });
    expect(under.plans.map((card) => card.cardType)).toEqual(["tonight"]);
  });

  test("labels a future overnight film with its exact start time", () => {
    const media = [episode("a", "Roseanne"), movie("film", "Tremors"), ...filler()];
    const planned = planContinuityCards({
      schedule: schedule(
        [
          entry("a-1", "2026-09-21T06:30:00.000Z", 30, "episode", "a"),
          ...breakEntries("2026-09-21T07:00:00.000Z"),
          entry("film-1", "2026-09-21T07:07:00.000Z", 120, "movie", "film"),
        ],
        "2026-09-20",
      ),
      media,
      config: config(),
    });
    const card = planned.plans[0]!;
    expect(card.cardType).toBe("tonight");
    expect(["THE 2 AM MOVIE", "THE LATE MOVIE", "LATE NIGHT MOVIE"]).toContain(card.label);
    expect(card.details).toContain("STARTS 2:07 AM");
  });
});
