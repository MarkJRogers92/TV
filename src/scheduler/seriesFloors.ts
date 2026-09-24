/**
 * The durable per-series floor: where each show has actually got to.
 *
 * The scheduler's cursor is derived from `historyBefore(channel, date)`, which is
 * rebuilt from the RETAINED `schedule_generations` rows for that channel. That
 * makes the cursor only as reliable as that table, and the live install shows two
 * ways it fails - both measured on 2026-09-24, both producing repeat airings:
 *
 *  1. A MISSING DATE. `2026-09-16` had no retained generation at all, so every
 *     later day computed its floor from `09-15` and replayed what `09-16` should
 *     have moved past.
 *  2. OUT-OF-ORDER REGENERATION. The retained order was `... 09-23 09-24 09-25
 *     ... 09-29`, and then `09-21` was rebuilt four times, then `09-22` four
 *     times, then `09-22` and `09-23` again. A day rebuilt after later days exist
 *     re-derives its floor from earlier days only, while those later days were
 *     built from its OLD content - so the chain tears and the same episodes
 *     appear on both sides of the tear.
 *
 * Measured consequence: The Wonder Years played `S1E1..S1E6, S2E1..S2E5` and then
 * restarted at `S1E1` having covered 11 of its 23 episodes, with `S1E1..S1E5` each
 * airing twice as the SAME media file. "According to Jim" repeated `S2E6`.
 *
 * So the floor is recorded HERE, keyed by the broadcast date it was scheduled
 * for, and consulted as one more source of history. Keyed by DATE rather than by
 * generation order, regenerating any day is order-independent, and a missing or
 * rebuilt neighbour cannot move it.
 *
 * THE FLOOR IS A POSITION *AND* A CYCLE.
 *
 * A position alone is not enough once a series is allowed to start again when its
 * pool is spent: after a wrap the series sits BEHIND where it once was, so "the
 * furthest position ever reached" would send it back to the old high-water mark
 * and replay the same opening episodes every day. The floor therefore also
 * records which members have aired in the CURRENT cycle, which is what makes both
 * of these true at once:
 *
 *  - an episode cannot air twice before its pool is spent (`floorHistory` gives
 *    the position to advance from, and the selector only ever moves forward), and
 *  - a spent pool starts again at its first episode (`wrapAllowedSeries` says so,
 *    and only then) - while a series with a member it has NOT played, such as an
 *    earlier episode that appeared later, is held rather than wrapped. That is
 *    the difference between cycling and the EP03/EP05 defects.
 *
 * The floor is not a plan: it records only where a series had got to, so it
 * cannot make an episode air - it can only stop one airing twice.
 */
import type { Repositories } from "../db/repositories.js";
import type { Played } from "./select.js";

/**
 * The shape these functions actually read. Declared structurally rather than as
 * a full `Schedule`, so a caller can hand in exactly what it has - and so the
 * dependency on the schedule's 20 other fields is visible as the non-dependency
 * it is.
 */
export type FloorSourceSchedule = {
  date: string;
  generatedAt: string;
  entries: ReadonlyArray<{ kind: string; mediaId?: string | null }>;
};

export type SeriesFloorRecord = {
  channelId: string;
  /** Same key `select.ts` groups series by, so the two agree by construction. */
  seriesKey: string;
  /** The broadcast date this position was scheduled for. */
  date: string;
  /** Where the series got to on that date. */
  season: number;
  episode: number;
  mediaId: string;
  /**
   * Members of this series aired in the CURRENT cycle as of that date, sorted.
   * The cycle restarts whenever a day's episodes do not advance - see
   * `recordSeriesFloors`.
   */
  playedIds: string[];
};

export type SeriesIdentity = {
  seriesKey: string;
  season: number;
  episode: number;
};

/** How long a floor stays useful. Generous: the records are tiny. */
export const seriesFloorLimits = {
  retainDays: 45,
};

const key = (channelId: string) => `series-floors:${channelId}`;

const positionOf = (record: { season: number; episode: number }) => ({
  season: record.season,
  episode: record.episode,
});

const comparePositions = (
  left: { season: number; episode: number },
  right: { season: number; episode: number },
) => left.season - right.season || left.episode - right.episode;

export function readSeriesFloors(
  repositories: Repositories,
  channelId: string,
): SeriesFloorRecord[] {
  const value = repositories.settings.get(key(channelId))?.value;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SeriesFloorRecord => {
    if (entry === null || typeof entry !== "object") return false;
    const record = entry as Partial<SeriesFloorRecord>;
    return (
      typeof record.seriesKey === "string" &&
      typeof record.date === "string" &&
      typeof record.mediaId === "string" &&
      Number.isFinite(record.season) &&
      Number.isFinite(record.episode) &&
      Array.isArray(record.playedIds) &&
      record.playedIds.every((id) => typeof id === "string")
    );
  });
}

/** The most recent record for a series strictly before `date`, if any. */
export function priorRecord(
  records: readonly SeriesFloorRecord[],
  date: string,
  seriesKey: string,
): SeriesFloorRecord | undefined {
  let best: SeriesFloorRecord | undefined;
  for (const record of records) {
    if (record.date >= date || record.seriesKey !== seriesKey) continue;
    if (best === undefined || record.date > best.date) best = record;
  }
  return best;
}

/**
 * The floor for one date, as history entries the selector already understands.
 *
 * Returned as ordinary `Played` entries on purpose: `select.ts` computes its
 * floors from resolved history, so a synthetic entry needs no change to that
 * logic at all - and a rule expressed once cannot disagree with itself.
 *
 * The record chosen per series is the one from the MOST RECENT prior date, not
 * the furthest position ever reached. Once a spent pool may start again, a later
 * day legitimately sits behind an earlier one, and taking the maximum would drag
 * it back to wherever it once got furthest.
 */
export function floorHistory(
  records: readonly SeriesFloorRecord[],
  date: string,
): Played[] {
  const seriesKeys = new Set(records.map((record) => record.seriesKey));
  return [...seriesKeys].flatMap((seriesKey) => {
    const record = priorRecord(records, date, seriesKey);
    if (record === undefined) return [];
    return [
      {
        mediaId: record.mediaId,
        // Dated at the start of the day it was scheduled for, so it orders before
        // anything real that aired that day.
        at: `${record.date}T00:00:00.000Z`,
      },
    ];
  });
}

/**
 * Series whose pool has been fully aired and may therefore start again.
 *
 * This is the ONLY licence to repeat an episode, and it is deliberately
 * conservative: a series qualifies only when every member of its pool appears in
 * the current cycle's played set. Anything else - a member not yet aired, an
 * earlier episode that appeared after the series moved on, a pool with no members
 * - leaves the series held, which is the EP03/EP05 behaviour.
 */
export function wrapAllowedSeries(
  records: readonly SeriesFloorRecord[],
  date: string,
  poolMembersBySeries: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const allowed = new Set<string>();
  for (const [seriesKey, members] of poolMembersBySeries) {
    if (members.size === 0) continue;
    const record = priorRecord(records, date, seriesKey);
    if (record === undefined) continue;
    const played = new Set(record.playedIds);
    let complete = true;
    for (const memberId of members) {
      if (!played.has(memberId)) {
        complete = false;
        break;
      }
    }
    if (complete) allowed.add(seriesKey);
  }
  return allowed;
}

/**
 * Seed the floors from schedules that already exist.
 *
 * Without this the fix is inert until enough new days have been generated to
 * rebuild the chain, which is days of the very repeats it prevents. The retained
 * generations ARE the data the old path used, so seeding from them adds no new
 * information - it only makes it durable and date-keyed, which is what stops a
 * missing or rebuilt neighbour from dragging it backwards.
 *
 * Safe to run repeatedly: `recordSeriesFloors` keeps the further position per
 * series and date, so a backfill can raise a floor but never lower one.
 */
export function backfillSeriesFloors(
  repositories: Repositories,
  channelId: string,
  schedules: ReadonlyArray<FloorSourceSchedule>,
  seriesKeyOf: (mediaId: string) => SeriesIdentity | undefined,
): number {
  const newestPerDate = new Map<string, FloorSourceSchedule>();
  for (const schedule of schedules) {
    const current = newestPerDate.get(schedule.date);
    if (current === undefined || schedule.generatedAt > current.generatedAt) {
      newestPerDate.set(schedule.date, schedule);
    }
  }
  // Oldest first, so each date's cycle state is built on the one before it.
  const ordered = [...newestPerDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  let written = 0;
  for (const schedule of ordered) {
    written += recordSeriesFloors(
      repositories,
      channelId,
      schedule.date,
      schedule,
      seriesKeyOf,
    );
  }
  return written;
}

/**
 * Record where each series got to on this date, and which members its current
 * cycle has played. Called only after the schedule is persisted, so a floor never
 * outruns a schedule that exists.
 *
 * A cycle ends when the next episode is not an ADVANCE over the one placed
 * before it. That single rule covers both boundaries without special cases: a
 * series that runs off the end of its pool within a day starts a new cycle
 * mid-day, and a series whose day begins at or below where it finished yesterday
 * starts a new cycle at the day boundary.
 */
export function recordSeriesFloors(
  repositories: Repositories,
  channelId: string,
  date: string,
  schedule: Pick<FloorSourceSchedule, "entries">,
  seriesKeyOf: (mediaId: string) => SeriesIdentity | undefined,
): number {
  const stored = readSeriesFloors(repositories, channelId);
  const cycles = new Map<
    string,
    {
      played: Set<string>;
      previous: { season: number; episode: number } | undefined;
    }
  >();
  const written = new Map<string, SeriesFloorRecord>();

  for (const entry of schedule.entries) {
    if (entry.kind !== "episode" || !entry.mediaId) continue;
    const identity = seriesKeyOf(entry.mediaId);
    if (identity === undefined) continue;

    let cycle = cycles.get(identity.seriesKey);
    if (cycle === undefined) {
      const prior = priorRecord(stored, date, identity.seriesKey);
      cycle = {
        // Carrying the prior cycle's members forward is what lets a pool be
        // recognised as complete across several days.
        played: new Set(prior?.playedIds ?? []),
        previous: prior ? positionOf(prior) : undefined,
      };
      cycles.set(identity.seriesKey, cycle);
    }

    const position = { season: identity.season, episode: identity.episode };
    if (
      cycle.previous !== undefined &&
      comparePositions(position, cycle.previous) <= 0
    ) {
      // Not an advance: the pool ran out and the series began again.
      cycle.played = new Set();
    }
    cycle.played.add(entry.mediaId);
    cycle.previous = position;

    written.set(identity.seriesKey, {
      channelId,
      seriesKey: identity.seriesKey,
      date,
      season: identity.season,
      episode: identity.episode,
      mediaId: entry.mediaId,
      // Sorted so the stored value is stable whatever order the day aired in.
      playedIds: [...cycle.played].sort(),
    });
  }

  if (written.size === 0) return 0;

  const merged = new Map<string, SeriesFloorRecord>();
  for (const record of readSeriesFloors(repositories, channelId)) {
    merged.set(`${record.seriesKey}@${record.date}`, record);
  }
  for (const record of written.values()) {
    const id = `${record.seriesKey}@${record.date}`;
    const existing = merged.get(id);
    // Same series and date keeps the FURTHER position, with its own cycle: a
    // rebuild of a day may raise its own floor but must not lower it.
    if (existing === undefined || comparePositions(record, existing) > 0) {
      merged.set(id, record);
    }
  }

  // Bound it: keep the most recent dates only.
  const dates = [...new Set([...merged.values()].map((record) => record.date))]
    .sort()
    .reverse();
  const keep = new Set(dates.slice(0, seriesFloorLimits.retainDays));
  const retained = [...merged.values()].filter((record) =>
    keep.has(record.date),
  );
  repositories.settings.put(key(channelId), retained);
  return written.size;
}
