/**
 * The durable per-series floor: where each show has actually got to.
 *
 * The scheduler's cursor is derived from `historyBefore(channel, date)`, which is
 * rebuilt from the RETAINED `schedule_generations` rows for that channel. That
 * makes the cursor only as reliable as that table, and the live install shows two
 * ways it fails - both measured on 2026-09-24, both producing repeat airings:
 *
 *  1. A MISSING DATE. `2026-09-16` had no retained generation at all, so every
 *     later day computed its floor from `09-15` and replayed what `09-16` (or the
 *     episodes it should have carried) had already covered.
 *  2. OUT-OF-ORDER REGENERATION. The retained order was `... 09-23 09-24 09-25
 *     ... 09-29`, and then `09-21` was rebuilt four times, then `09-22` four
 *     times, then `09-22` and `09-23` again. A day regenerated after later days
 *     exist re-derives its floor from earlier days only, while those later days
 *     were built from its OLD content - so the chain tears and the same episodes
 *     appear on both sides of the tear.
 *
 * Measured consequence: The Wonder Years played `S1E1..S1E6, S2E1..S2E5` and then
 * restarted at `S1E1` having covered 11 of its 23 episodes, with `S1E1..S1E5` each
 * airing twice as the SAME media file. "According to Jim" repeated `S2E6`.
 *
 * `historyBefore` itself is fine - it reads the newest generation per prior date,
 * which is the right rule. What it cannot do is see a date that is not there. So
 * the floor is recorded HERE, keyed by the broadcast date it was scheduled for,
 * and consulted as one more source of history:
 *
 *  - keyed by DATE, not by generation order, so regenerating any day is
 *    order-independent and deterministic;
 *  - monotonic: a record only ever moves forward within its date, so the floor
 *    can never be dragged backwards by a missing, pruned or rebuilt neighbour;
 *  - a floor is not a plan. It records only where a series HAD got to, so it
 *    cannot make an episode air - it can only stop one airing twice.
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
  season: number;
  episode: number;
  mediaId: string;
};

/** How long a floor stays useful. Generous: the records are tiny. */
export const seriesFloorLimits = {
  retainDays: 45,
};

const key = (channelId: string) => `series-floors:${channelId}`;

/**
 * Seed the floors from schedules that already exist.
 *
 * Without this the fix is inert until enough new days have been generated to
 * rebuild the chain, which is days of the very repeats it prevents. The retained
 * generations ARE the data the old path used, so seeding from them adds no new
 * information - it only makes it durable and date-keyed, which is what stops a
 * missing or rebuilt neighbour from dragging it backwards.
 *
 * Safe to run repeatedly: `recordSeriesFloors` keeps the furthest position per
 * series and date, so a backfill can raise a floor but never lower one.
 */
export function backfillSeriesFloors(
  repositories: Repositories,
  channelId: string,
  schedules: ReadonlyArray<FloorSourceSchedule>,
  seriesKeyOf: (
    mediaId: string,
  ) => { seriesKey: string; season: number; episode: number } | undefined,
): number {
  const newestPerDate = new Map<string, FloorSourceSchedule>();
  for (const schedule of schedules) {
    const current = newestPerDate.get(schedule.date);
    if (current === undefined || schedule.generatedAt > current.generatedAt) {
      newestPerDate.set(schedule.date, schedule);
    }
  }
  let written = 0;
  for (const schedule of newestPerDate.values()) {
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
      Number.isFinite(record.episode)
    );
  });
}

/**
 * The floor for one date, as history entries the selector already understands.
 *
 * Returned as ordinary `Played` entries on purpose: `select.ts` computes its
 * floors as the highest position per series over resolved history, so a
 * synthetic entry needs no change to that logic at all - and a rule expressed
 * once is a rule that cannot disagree with itself.
 */
export function floorHistory(
  records: readonly SeriesFloorRecord[],
  date: string,
): Played[] {
  const highest = new Map<string, SeriesFloorRecord>();
  for (const record of records) {
    // Strictly earlier dates only: a day must not be advanced by its own, or a
    // later, scheduled position - that would skip episodes into the past.
    if (record.date >= date) continue;
    const current = highest.get(record.seriesKey);
    if (
      current === undefined ||
      record.season > current.season ||
      (record.season === current.season && record.episode > current.episode)
    ) {
      highest.set(record.seriesKey, record);
    }
  }
  return [...highest.values()].map((record) => ({
    mediaId: record.mediaId,
    // Dated at the start of the day it was scheduled for, so it orders before
    // anything real that aired that day.
    at: `${record.date}T00:00:00.000Z`,
  }));
}

/**
 * Record where each series got to on this date. Called only after the schedule
 * is persisted, so a floor never outruns a schedule that exists.
 */
export function recordSeriesFloors(
  repositories: Repositories,
  channelId: string,
  date: string,
  schedule: Pick<FloorSourceSchedule, "entries">,
  seriesKeyOf: (
    mediaId: string,
  ) => { seriesKey: string; season: number; episode: number } | undefined,
): number {
  const highest = new Map<string, SeriesFloorRecord>();
  for (const entry of schedule.entries) {
    if (entry.kind !== "episode" || !entry.mediaId) continue;
    const identity = seriesKeyOf(entry.mediaId);
    if (identity === undefined) continue;
    const current = highest.get(identity.seriesKey);
    if (
      current === undefined ||
      identity.season > current.season ||
      (identity.season === current.season && identity.episode > current.episode)
    ) {
      highest.set(identity.seriesKey, {
        channelId,
        seriesKey: identity.seriesKey,
        date,
        season: identity.season,
        episode: identity.episode,
        mediaId: entry.mediaId,
      });
    }
  }
  if (highest.size === 0) return 0;

  // Merge with what is already known: same series and date keeps the FURTHER
  // position, so a rebuild of a day can raise its own floor but never lower it.
  const merged = new Map<string, SeriesFloorRecord>();
  for (const record of readSeriesFloors(repositories, channelId)) {
    merged.set(`${record.seriesKey}@${record.date}`, record);
  }
  for (const record of highest.values()) {
    const id = `${record.seriesKey}@${record.date}`;
    const existing = merged.get(id);
    if (
      existing === undefined ||
      record.season > existing.season ||
      (record.season === existing.season && record.episode > existing.episode)
    ) {
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
  return highest.size;
}
