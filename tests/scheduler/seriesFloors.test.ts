import { expect, test } from "vitest";
import type { MediaItem, Pool } from "../../src/domain/models.js";
import type { Repositories } from "../../src/db/repositories.js";
import { selectCandidate, seriesOrderKey } from "../../src/scheduler/select.js";
import {
  backfillSeriesFloors,
  floorHistory,
  readSeriesFloors,
  recordSeriesFloors,
  seriesFloorLimits,
  type SeriesFloorRecord,
} from "../../src/scheduler/seriesFloors.js";

/*
 * The scheduler's cursor is derived from `historyBefore`, which is rebuilt from
 * the RETAINED schedule generations. Measured on the live install on 2026-09-24,
 * two things break that table and both produced repeat airings:
 *
 *   - 2026-09-16 simply had no retained generation, so every later day computed
 *     its floor from 09-15 and replayed what 09-16 should have moved past;
 *   - days were regenerated out of order (`... 09-25 ... 09-29`, then 09-21 four
 *     times, then 09-22 four times), so a day rebuilt after its successors was
 *     derived from an older position than the days that follow it.
 *
 * The consequence in the schedule: The Wonder Years played S1E1..S1E6, S2E1..S2E5
 * and then restarted at S1E1 - 11 of its 23 episodes - with S1E1..S1E5 each
 * airing twice as the same media file, and "According to Jim" repeated S2E6.
 *
 * These tests pin the closure: a durable, date-keyed floor that the selection
 * consults as one more source of history.
 */

const item = (id: string, overrides: Partial<MediaItem> = {}): MediaItem => ({
  id,
  source: "placeholder",
  kind: "episode",
  title: id,
  durationMs: 60_000,
  durationStatus: "ok",
  available: true,
  tags: [],
  ...overrides,
});

const series = (id: string, season: number, episode: number): MediaItem =>
  item(id, { showTitle: "Show", season, episode });

/** One series, six first-season episodes and two second-season ones. */
const episodes = [
  ...Array.from({ length: 6 }, (_, index) =>
    series(`s1e${index + 1}`, 1, index + 1),
  ),
  series("s2e1", 2, 1),
  series("s2e2", 2, 2),
];
const pool: Pool = {
  id: "series",
  name: "Series",
  kinds: ["episode"],
  mediaIds: episodes.map(({ id }) => id),
  mode: "chronological",
  noRepeatMinutes: 0,
  weight: 1,
};

function repositoriesWithSettings() {
  const store = new Map<string, { value: unknown }>();
  const repositories = {
    settings: {
      get: (id: string) => store.get(id),
      // The real collection API is put(id, value), not put({id, value}).
      put: (id: string, value: unknown) => {
        store.set(id, { value });
        return { id, value };
      },
    },
  } as unknown as Repositories;
  return { repositories, store };
}

test("[EP] a missing prior date no longer restarts the series at its first episode", () => {
  // The floor says the series had reached S2E1 on 09-15. 09-16 onwards have no
  // retained generations at all - the live fault - so `historyBefore` sees
  // nothing. Without the floor the series restarts; with it, it continues.
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-15",
      season: 2,
      episode: 1,
      mediaId: "s2e1",
    },
  ];

  const blind = selectCandidate({
    pool,
    items: episodes,
    kind: "episode",
    history: [],
    at: "2026-09-20T20:00:00.000Z",
    seed: "s",
  });
  // This is the defect, reproduced: no history at all means S1E1 all over again.
  expect(blind.item?.id).toBe("s1e1");

  const withFloor = selectCandidate({
    pool,
    items: episodes,
    kind: "episode",
    history: floorHistory(records, "2026-09-20"),
    at: "2026-09-20T20:00:00.000Z",
    seed: "s",
  });
  expect(withFloor.item?.id).toBe("s2e2");
});

test("[EP] a later date never advances an earlier one", () => {
  // Regenerating 09-21 must not be moved forward by what 09-25 has scheduled;
  // that would skip episodes into the past.
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-25",
      season: 2,
      episode: 2,
      mediaId: "s2e2",
    },
  ];
  expect(floorHistory(records, "2026-09-21")).toEqual([]);
  expect(
    floorHistory(records, "2026-09-26").map((play) => play.mediaId),
  ).toEqual(["s2e2"]);
});

test("[EP] the floor for a date is the furthest position before it, per series", () => {
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-10",
      season: 1,
      episode: 4,
      mediaId: "s1e4",
    },
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-12",
      season: 1,
      episode: 2,
      mediaId: "s1e2",
    },
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-14",
      season: 1,
      episode: 6,
      mediaId: "s1e6",
    },
  ];
  // The furthest, not the most recent date: a rebuild of an earlier day that
  // moved a series BACK would otherwise drag the whole chain back with it.
  expect(
    floorHistory(records, "2026-09-15").map((play) => play.mediaId),
  ).toEqual(["s1e6"]);
});

test("[EP] rebuilding a day can raise its floor, never lower it", () => {
  const { repositories } = repositoriesWithSettings();
  const schedule = (ids: string[]) => ({
    entries: ids.map((mediaId) => ({ kind: "episode", mediaId })),
  });
  const identify = (mediaId: string) => {
    const found = episodes.find((candidate) => candidate.id === mediaId);
    return found === undefined
      ? undefined
      : {
          seriesKey: seriesOrderKey(found),
          season: found.season!,
          episode: found.episode!,
        };
  };

  expect(
    recordSeriesFloors(
      repositories,
      "c",
      "2026-09-20",
      schedule(["s1e4"]),
      identify,
    ),
  ).toBe(1);
  // A rebuild of the same day that only reaches S1E2 must not walk it back.
  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-20",
    schedule(["s1e2"]),
    identify,
  );
  const recorded = readSeriesFloors(repositories, "c");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    date: "2026-09-20",
    season: 1,
    episode: 4,
    mediaId: "s1e4",
  });

  // And a rebuild that gets FURTHER does advance, so the chain keeps moving.
  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-20",
    schedule(["s1e2", "s2e1"]),
    identify,
  );
  expect(readSeriesFloors(repositories, "c")[0]).toMatchObject({
    season: 2,
    episode: 1,
    mediaId: "s2e1",
  });
});

test("[EP] duplicate and non-episode entries do not distort the floor", () => {
  const { repositories } = repositoriesWithSettings();
  const schedule = {
    entries: [
      { kind: "episode", mediaId: "s1e2" },
      { kind: "episode", mediaId: "s1e2" },
      { kind: "commercial", mediaId: "ad" },
      { kind: "episode", mediaId: "unknown-media" },
      { kind: "episode", mediaId: "s1e5" },
    ],
  };
  const identify = (mediaId: string) => {
    const found = episodes.find((candidate) => candidate.id === mediaId);
    return found === undefined
      ? undefined
      : {
          seriesKey: seriesOrderKey(found),
          season: found.season!,
          episode: found.episode!,
        };
  };

  expect(
    recordSeriesFloors(repositories, "c", "2026-09-20", schedule, identify),
  ).toBe(1);
  // One record per series per date, at the furthest position reached.
  expect(readSeriesFloors(repositories, "c")).toEqual([
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-20",
      season: 1,
      episode: 5,
      mediaId: "s1e5",
    },
  ]);
});

test("[EP] floors are retained for a bounded window of dates", () => {
  const { repositories } = repositoriesWithSettings();
  const identify = (mediaId: string) => {
    const found = episodes.find((candidate) => candidate.id === mediaId);
    return found === undefined
      ? undefined
      : {
          seriesKey: seriesOrderKey(found),
          season: found.season!,
          episode: found.episode!,
        };
  };
  const schedule = { entries: [{ kind: "episode", mediaId: "s1e1" }] };

  const days = seriesFloorLimits.retainDays + 10;
  for (let index = 0; index < days; index += 1) {
    const date = new Date(Date.UTC(2026, 5, 1) + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    recordSeriesFloors(repositories, "c", date, schedule, identify);
  }

  const retained = readSeriesFloors(repositories, "c");
  expect(retained.length).toBe(seriesFloorLimits.retainDays);
  // The newest dates are the ones kept: they are the ones a rebuild consults.
  const newest = new Date(Date.UTC(2026, 5, 1) + (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  expect(retained.some((record) => record.date === newest)).toBe(true);
});

test("[EP] reading floors tolerates a missing or malformed store", () => {
  const { repositories } = repositoriesWithSettings();
  expect(readSeriesFloors(repositories, "c")).toEqual([]);
  repositories.settings.put("series-floors:c", [{ nonsense: true }, "junk", 7]);
  expect(readSeriesFloors(repositories, "c")).toEqual([]);
});

test("[EP] the backfill seeds floors from the schedules that already exist", () => {
  const { repositories } = repositoriesWithSettings();
  const identify = (mediaId: string) => {
    const found = episodes.find((candidate) => candidate.id === mediaId);
    return found === undefined
      ? undefined
      : {
          seriesKey: seriesOrderKey(found),
          season: found.season!,
          episode: found.episode!,
        };
  };
  const schedule = (date: string, generatedAt: string, ids: string[]) => ({
    date,
    generatedAt,
    entries: ids.map((mediaId) => ({ kind: "episode", mediaId })),
  });

  const written = backfillSeriesFloors(
    repositories,
    "c",
    [
      schedule("2026-09-10", "2026-09-09T00:00:00.000Z", ["s1e2"]),
      // The NEWER generation of the same date is the one that counts.
      schedule("2026-09-10", "2026-09-10T00:00:00.000Z", ["s1e5"]),
      schedule("2026-09-12", "2026-09-11T00:00:00.000Z", ["s2e1"]),
    ],
    identify,
  );

  expect(written).toBe(2);
  const records = readSeriesFloors(repositories, "c");
  expect(records.map((record) => `${record.date}:${record.episode}`)).toEqual([
    "2026-09-10:5",
    "2026-09-12:1",
  ]);
  // And the seeded floors are immediately usable: the next day continues.
  expect(
    floorHistory(records, "2026-09-13").map((play) => play.mediaId),
  ).toEqual(["s2e1"]);
});
