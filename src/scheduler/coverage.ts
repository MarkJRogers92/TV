/**
 * Read-only coverage and horizon assessment for the schedule store.
 *
 * R09 asks for a rolling horizon with *continuous coverage*: every instant in
 * the window must resolve to content, with no gapped or overlapping broadcast
 * timeline. This module answers that question about the schedules that already
 * exist — it plans nothing, writes nothing, and consumes no history, so it is
 * safe to run on the live store.
 *
 * The store keeps every generation (see `schedules.list`), so the first step is
 * to collapse to the newest schedule per broadcast date: an earlier generation
 * of the same date would overlap the newer one by design and is not a defect.
 */
import type { Schedule } from "../domain/models.js";

export type CoverageWindow = { startMs: number; endMs: number };

export type CoverageGap = { fromMs: number; toMs: number };

export type ScheduleCoverage = {
  /** Broadcast dates present, newest generation each, in date order. */
  dates: string[];
  /** First covered instant, or null when nothing covers the window. */
  coverageStartMs: number | null;
  /** One past the last covered instant, or null when nothing covers the window. */
  coverageEndMs: number | null;
  /** Total covered milliseconds inside the window (overlaps counted once). */
  coveredMs: number;
  /** Uncovered sub-intervals of the window, in order. */
  gaps: CoverageGap[];
  /** Count of pairs of entries whose intervals overlapped. */
  overlaps: number;
  /** True only when the window is fully and exactly covered. */
  contiguous: boolean;
};

/** The newest stored generation per broadcast date. */
export function newestByDate(schedules: readonly Schedule[]): Schedule[] {
  const byDate = new Map<string, Schedule>();
  for (const schedule of schedules) {
    const existing = byDate.get(schedule.date);
    if (
      !existing ||
      Date.parse(schedule.generatedAt) >= Date.parse(existing.generatedAt)
    ) {
      byDate.set(schedule.date, schedule);
    }
  }
  return [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

/**
 * Coverage of `window` by the union of the newest schedules' entries.
 *
 * Entries are half-open `[start, end)`, so an entry ending exactly where the
 * next begins is contiguous, not a gap. Any uncovered instant is reported as a
 * gap: a live channel must not have one.
 */
export function assessCoverage(
  schedules: readonly Schedule[],
  window: CoverageWindow,
): ScheduleCoverage {
  const newest = newestByDate(schedules);
  const clipped: Array<{ start: number; end: number }> = [];
  for (const schedule of newest) {
    for (const entry of schedule.entries) {
      const start = Date.parse(entry.start);
      const end = Date.parse(entry.end);
      if (end <= window.startMs || start >= window.endMs) continue;
      clipped.push({
        start: Math.max(start, window.startMs),
        end: Math.min(end, window.endMs),
      });
    }
  }
  clipped.sort((left, right) => left.start - right.start || left.end - right.end);

  let overlaps = 0;
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of clipped) {
    const last = merged.at(-1);
    if (last && interval.start < last.end) {
      overlaps += 1;
      if (interval.end > last.end) last.end = interval.end;
      continue;
    }
    merged.push({ ...interval });
  }

  const gaps: CoverageGap[] = [];
  if (merged.length === 0) {
    gaps.push({ fromMs: window.startMs, toMs: window.endMs });
  } else {
    const first = merged[0]!;
    if (first.start > window.startMs) {
      gaps.push({ fromMs: window.startMs, toMs: first.start });
    }
    for (let index = 1; index < merged.length; index += 1) {
      const previous = merged[index - 1]!;
      const current = merged[index]!;
      if (current.start > previous.end) {
        gaps.push({ fromMs: previous.end, toMs: current.start });
      }
    }
    const last = merged.at(-1)!;
    if (last.end < window.endMs) {
      gaps.push({ fromMs: last.end, toMs: window.endMs });
    }
  }

  const coveredMs = merged.reduce(
    (total, interval) => total + (interval.end - interval.start),
    0,
  );
  return {
    dates: newest.map((schedule) => schedule.date),
    coverageStartMs: merged.length ? merged[0]!.start : null,
    coverageEndMs: merged.length ? merged.at(-1)!.end : null,
    coveredMs,
    gaps,
    overlaps,
    contiguous: gaps.length === 0 && overlaps === 0,
  };
}
