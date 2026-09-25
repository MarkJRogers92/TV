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
  wrapAllowedSeries,
  type SeriesFloorRecord,
} from "../../src/scheduler/seriesFloors.js";

/*
 * The scheduler's cursor is derived from `historyBefore`, which is rebuilt from
 * the RETAINED schedule generations. Two live faults broke that table and both
 * produced repeat airings (measured 2026-09-24):
 *
 *   - 2026-09-16 had no retained generation at all, so every later day computed
 *     its floor from 09-15 and replayed what 09-16 should have moved past;
 *   - days were regenerated out of order (`... 09-25 ... 09-29`, then 09-21 four
 *     times, then 09-22 four times), so a day rebuilt after its successors was
 *     derived from an older position than the days following it.
 *
 * In the schedule: The Wonder Years played S1E1..S1E6, S2E1..S2E5 and restarted at
 * S1E1 - 11 of its 23 episodes - with S1E1..S1E5 each airing twice as the same
 * media file, and "According to Jim" repeated S2E6.
 *
 * The durable floor closes those. It also carries the CYCLE, because a finished
 * pool must start again at episode one rather than leave the series off the air -
 * and a series that is NOT finished must never be treated as if it were.
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

/** Six first-season episodes: a pool small enough to finish. */
const episodes = Array.from({ length: 6 }, (_, index) =>
  series(`s1e${index + 1}`, 1, index + 1),
);
const pool: Pool = {
  id: "series",
  name: "Series",
  kinds: ["episode"],
  mediaIds: episodes.map(({ id }) => id),
  mode: "chronological",
  noRepeatMinutes: 0,
  weight: 1,
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

const schedule = (ids: string[]) => ({
  entries: ids.map((mediaId) => ({ kind: "episode", mediaId })),
});

test("[EP] a missing prior date no longer restarts the series at its first episode", () => {
  // The floor says the series had reached S1E4 by 09-15. 09-16 onwards have no
  // retained generations at all - the live fault - so `historyBefore` sees
  // nothing. Without the floor the series restarts; with it, it continues.
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-15",
      season: 1,
      episode: 4,
      mediaId: "s1e4",
      playedIds: ["s1e1", "s1e2", "s1e3", "s1e4"],
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
  // The defect, reproduced: no history at all means S1E1 all over again.
  expect(blind.item?.id).toBe("s1e1");

  const withFloor = selectCandidate({
    pool,
    items: episodes,
    kind: "episode",
    history: floorHistory(records, "2026-09-20"),
    at: "2026-09-20T20:00:00.000Z",
    seed: "s",
  });
  expect(withFloor.item?.id).toBe("s1e5");
});

test("[EP] a later date never advances an earlier one", () => {
  // Regenerating 09-21 must not be moved forward by what 09-25 has scheduled;
  // that would skip episodes into the past.
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-25",
      season: 1,
      episode: 6,
      mediaId: "s1e6",
      playedIds: ["s1e6"],
    },
  ];
  expect(floorHistory(records, "2026-09-21")).toEqual([]);
  expect(
    floorHistory(records, "2026-09-26").map((play) => play.mediaId),
  ).toEqual(["s1e6"]);
});

test("[EP] the floor is where the series got to on the most recent prior date", () => {
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-10",
      season: 1,
      episode: 6,
      mediaId: "s1e6",
      playedIds: ["s1e1", "s1e6"],
    },
    // The pool finished on 09-14 and started again, so where it GOT TO is S1E2 -
    // behind the earlier date. Taking the furthest instead would send the next
    // day back to S1E6 and repeat the same opening run every day.
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-14",
      season: 1,
      episode: 2,
      mediaId: "s1e2",
      playedIds: ["s1e1", "s1e2"],
    },
  ];
  expect(
    floorHistory(records, "2026-09-15").map((play) => play.mediaId),
  ).toEqual(["s1e2"]);
});

test("[EP] a series with a recorded position may start again once its run ends", () => {
  // S1E2 never aired, but the cursor is past it - and once past, only a restart
  // can ever play it. Withholding the restart here does not protect S1E2, it
  // holds the series at its last episode permanently and the slot falls to
  // filler. So the member is not what decides; the position is.
  const records: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-19",
      season: 1,
      episode: 6,
      mediaId: "s1e6",
      playedIds: ["s1e1", "s1e3", "s1e4", "s1e5", "s1e6"],
    },
  ];
  expect(wrapAllowedSeries(records, "2026-09-20", ["show"])).toEqual(
    new Set(["show"]),
  );

  // A series with no record has not begun: the opener rule decides, not a wrap.
  expect(wrapAllowedSeries(records, "2026-09-20", ["other"])).toEqual(
    new Set(),
  );
  // Neither has one whose only record is for a LATER date.
  expect(wrapAllowedSeries(records, "2026-09-10", ["show"])).toEqual(new Set());
});

test("[EP] a spent pool starts again at its first episode, and holds without the licence", () => {
  const spent: SeriesFloorRecord[] = [
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-19",
      season: 1,
      episode: 6,
      mediaId: "s1e6",
      playedIds: episodes.map(({ id }) => id),
    },
  ];
  const wrapped = selectCandidate({
    pool,
    items: episodes,
    kind: "episode",
    history: floorHistory(spent, "2026-09-20"),
    wrapAllowed: wrapAllowedSeries(spent, "2026-09-20", ["show"]),
    at: "2026-09-20T20:00:00.000Z",
    seed: "s",
  });
  expect(wrapped.item?.id).toBe("s1e1");

  // The same floor with no licence - EP03's requirement - and it holds instead.
  const held = selectCandidate({
    pool,
    items: episodes,
    kind: "episode",
    history: floorHistory(spent, "2026-09-20"),
    at: "2026-09-20T20:00:00.000Z",
    seed: "s",
  });
  expect(held.item).toBeUndefined();
});

test("[EP] the recorded cycle accumulates across days and resets when it wraps", () => {
  const { repositories } = repositoriesWithSettings();

  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-20",
    schedule(["s1e1", "s1e2"]),
    identify,
  );
  let record = readSeriesFloors(repositories, "c")[0]!;
  expect(record).toMatchObject({ season: 1, episode: 2, mediaId: "s1e2" });
  expect(record.playedIds).toEqual(["s1e1", "s1e2"]);

  // The next day continues the same cycle, so the played set accumulates.
  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-21",
    schedule(["s1e3", "s1e4"]),
    identify,
  );
  record = readSeriesFloors(repositories, "c").find(
    (entry) => entry.date === "2026-09-21",
  )!;
  expect(record).toMatchObject({ season: 1, episode: 4 });
  expect(record.playedIds).toEqual(["s1e1", "s1e2", "s1e3", "s1e4"]);

  // Then it runs off the end and starts again IN THE SAME DAY: the cycle resets,
  // and the recorded position is where it got to rather than the furthest reached.
  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-22",
    schedule(["s1e5", "s1e6", "s1e1"]),
    identify,
  );
  record = readSeriesFloors(repositories, "c").find(
    (entry) => entry.date === "2026-09-22",
  )!;
  expect(record).toMatchObject({ season: 1, episode: 1, mediaId: "s1e1" });
  expect(record.playedIds).toEqual(["s1e1"]);

  // The series has a recorded position, so a later date may start it again.
  expect(
    wrapAllowedSeries(readSeriesFloors(repositories, "c"), "2026-09-23", [
      "show",
    ]),
  ).toEqual(new Set(["show"]));
});

test("[EP] a regenerated day's floor follows the plan that will air", () => {
  const { repositories } = repositoriesWithSettings();
  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-20",
    schedule(["s1e4"]),
    identify,
  );
  // The day is regenerated and now reaches only S1E2. The floor must follow the
  // new plan, not the old, further one: the successor day is built from
  // whatever is recorded here, so keeping the stale S1E4 would make it start at
  // S1E5 and silently skip two episodes that exist.
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
    episode: 2,
    mediaId: "s1e2",
  });

  // And a regeneration that reaches further advances just the same.
  recordSeriesFloors(
    repositories,
    "c",
    "2026-09-20",
    schedule(["s1e4", "s1e5"]),
    identify,
  );
  expect(readSeriesFloors(repositories, "c")[0]).toMatchObject({
    episode: 5,
    mediaId: "s1e5",
  });
});

test("[EP] duplicate and non-episode entries do not distort the floor", () => {
  const { repositories } = repositoriesWithSettings();
  const mixed = {
    entries: [
      { kind: "episode", mediaId: "s1e2" },
      { kind: "episode", mediaId: "s1e2" },
      { kind: "commercial", mediaId: "ad" },
      { kind: "episode", mediaId: "unknown-media" },
      { kind: "episode", mediaId: "s1e5" },
    ],
  };
  expect(
    recordSeriesFloors(repositories, "c", "2026-09-20", mixed, identify),
  ).toBe(1);
  expect(readSeriesFloors(repositories, "c")).toEqual([
    {
      channelId: "c",
      seriesKey: "show",
      date: "2026-09-20",
      season: 1,
      episode: 5,
      mediaId: "s1e5",
      playedIds: ["s1e2", "s1e5"],
    },
  ]);
});

test("[EP] the backfill seeds floors from the schedules that already exist", () => {
  const { repositories } = repositoriesWithSettings();
  const source = (date: string, generatedAt: string, ids: string[]) => ({
    date,
    generatedAt,
    entries: ids.map((mediaId) => ({ kind: "episode", mediaId })),
  });

  const written = backfillSeriesFloors(
    repositories,
    "c",
    [
      source("2026-09-10", "2026-09-09T00:00:00.000Z", ["s1e2"]),
      // The NEWER generation of the same date is the one that counts.
      source("2026-09-10", "2026-09-10T00:00:00.000Z", ["s1e5"]),
      source("2026-09-12", "2026-09-11T00:00:00.000Z", ["s1e6"]),
    ],
    identify,
  );

  expect(written).toBe(2);
  const records = readSeriesFloors(repositories, "c");
  expect(records.map((record) => `${record.date}:${record.episode}`)).toEqual([
    "2026-09-10:5",
    "2026-09-12:6",
  ]);
  // Seeded oldest-first, so 09-12 continues 09-10's cycle rather than restarting it.
  expect(
    records.find((record) => record.date === "2026-09-12")?.playedIds,
  ).toEqual(["s1e5", "s1e6"]);
});

test("[EP] floors are retained for a bounded window of dates", () => {
  const { repositories } = repositoriesWithSettings();
  const days = seriesFloorLimits.retainDays + 10;
  for (let index = 0; index < days; index += 1) {
    const date = new Date(Date.UTC(2026, 5, 1) + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    recordSeriesFloors(repositories, "c", date, schedule(["s1e1"]), identify);
  }

  const retained = readSeriesFloors(repositories, "c");
  expect(retained.length).toBe(seriesFloorLimits.retainDays);
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
