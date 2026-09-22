import { expect } from "vitest";
import { DateTime } from "luxon";
import type { MediaKind } from "../../src/domain/models.js";
import {
  normalizePreservedLineup,
  preservedLineupStartTimes,
  type PreservedLineupArchive,
} from "../../src/scheduler/preservedLineup.js";

export const preservedZone = "America/Chicago";

export type PreservedEntrySpec = {
  mediaId: string;
  kind: MediaKind;
  durationMs: number;
  sourceOffsetMs?: number;
  title?: string;
};

export function dayStart(date: string, zone = preservedZone): number {
  return DateTime.fromISO(date, { zone }).startOf("day").toMillis();
}

export function dayEnd(date: string, zone = preservedZone): number {
  return DateTime.fromISO(date, { zone })
    .plus({ days: 1 })
    .startOf("day")
    .toMillis();
}

/**
 * Build a normalized archive from an ordered airing list.
 *
 * Start instants come from the exported cumulative-boundary helper - the same
 * contract a real converter satisfies - so the fixture can never accidentally
 * encode a timeline the validator would reject.
 */
export function archiveOf(
  baseMs: number,
  entries: PreservedEntrySpec[],
  sourceId = "channel-8-movies",
): PreservedLineupArchive {
  const raw = rawArchiveOf(baseMs, entries, sourceId);
  const normalized = normalizePreservedLineup(raw);
  expect(
    normalized.ok ? "" : JSON.stringify(normalized.issues),
  ).toBe("");
  if (!normalized.ok) throw new Error("fixture archive did not normalize");
  return normalized.archive;
}

/** The unnormalized shape a converter would import, digest not yet computed. */
export function rawArchiveOf(
  baseMs: number,
  entries: PreservedEntrySpec[],
  sourceId = "channel-8-movies",
) {
  const starts = preservedLineupStartTimes(baseMs, entries);
  return {
    schemaVersion: 1,
    sourceId,
    entries: entries.map((entry, index) => ({
      ...entry,
      startTime: starts[index],
    })),
  };
}

/** Repeat a pattern the given number of times, giving each cycle unique ids. */
export function repeatSpecs(
  pattern: PreservedEntrySpec[],
  cycles: number,
): PreservedEntrySpec[] {
  const entries: PreservedEntrySpec[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1)
    for (const spec of pattern)
      entries.push({ ...spec, mediaId: `${spec.mediaId}-${cycle + 1}` });
  return entries;
}

/** Repeat a pattern until the archive spans at least `minimumMs`. */
export function coveringSpecs(
  pattern: PreservedEntrySpec[],
  minimumMs: number,
): PreservedEntrySpec[] {
  const cycleMs = pattern.reduce((total, spec) => total + spec.durationMs, 0);
  return repeatSpecs(pattern, Math.ceil(minimumMs / cycleMs));
}

/** The movie/commercial pattern the service tests import. */
export const moviePattern: PreservedEntrySpec[] = [
  { mediaId: "movie-a", kind: "movie", durationMs: 120 * 60_000 },
  { mediaId: "ad-a", kind: "commercial", durationMs: 30_000.5 },
  { mediaId: "movie-b", kind: "movie", durationMs: 95 * 60_000 },
  { mediaId: "ad-b", kind: "commercial", durationMs: 29_500.4 },
];
