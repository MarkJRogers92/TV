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
 * THE RULE IS A POSITION, AND A RESTART AT THE END.
 *
 * A series works through its episode numbers in order; when nothing is left
 * above the cursor it starts again at its first episode. That much needs only
 * the position - the selector advances from it and never moves backwards, so no
 * episode can air twice before the run runs out.
 *
 * Two things the position alone does not settle, and how they are handled:
 *
 *  - After a restart the series sits BEHIND where it once was, so "the furthest
 *    position ever reached" would drag it back to the old high-water mark and
 *    replay the same opening episodes every day. The floor is therefore the most
 *    RECENT prior date's position, not the furthest.
 *  - The members aired in the current run are still recorded (`playedIds`), as
 *    evidence of what actually went out. They are NOT a licence: a run can begin
 *    mid-pool, in which case it can never list every member, and gating the
 *    restart on that held every sitcom at its last episode forever.
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
 * Series that may start again once their run runs out.
 *
 * The rule is the one the channel is specified by, and it is deliberately
 * simple: work through the episode numbers in order, and when there is nothing
 * left above the cursor, go back to episode one. Nothing can air twice before
 * that, because the selector only ever moves forward from the floor.
 *
 * The only thing consulted here is whether the series HAS a recorded position.
 * A series with none has not begun, and is left to the opener rule rather than
 * being treated as exhausted.
 *
 * This previously also required every member of the pool to have aired once, to
 * stop a torn floor from looking like a finished run. That condition can never
 * be met by a series whose run began mid-pool - and once the cursor passes a
 * member, only a restart can ever play it - so the series was held at its last
 * episode forever. Measured 2026-09-24: every sitcom reached its final episode
 * at once and six days fell back to filler (`EXHAUSTED_POOL` on every slot).
 * Position is the fault the durable, date-keyed floor fixes; completeness was
 * the wrong instrument for it and starved the channel instead.
 */
export function wrapAllowedSeries(
  records: readonly SeriesFloorRecord[],
  date: string,
  seriesKeys: Iterable<string>,
): Set<string> {
  const allowed = new Set<string>();
  for (const seriesKey of seriesKeys) {
    if (priorRecord(records, date, seriesKey) !== undefined)
      allowed.add(seriesKey);
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
 * Safe to run repeatedly: each date keeps the value from its newest generation.
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
  for (const record of stored) {
    merged.set(`${record.seriesKey}@${record.date}`, record);
  }
  for (const record of written.values()) {
    // The plan just recorded is the one that will air for this date, so it is
    // what the day following it has to continue from. This REPLACES any earlier
    // value for the same series and date.
    //
    // An earlier version kept the FURTHER of the two, on the theory that a
    // rebuild reaching less must not walk the floor back. That theory does not
    // hold: a successor date is already built either way, so keeping the further
    // position cannot prevent a repeat - it only preserves the skip. Measured
    // 2026-09-24: the corrected 09-24 plan reached S2E13, the pre-fix record for
    // it said S2E15, the stale value won, and 09-25 started at S2E16 - two
    // episodes that exist, silently never aired.
    merged.set(`${record.seriesKey}@${record.date}`, record);
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
