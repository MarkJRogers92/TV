import { createHash } from "node:crypto";
import type { Schedule } from "../domain/models.js";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

export const stableHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** A deterministic integer in `[0, range)` derived from a stable seed. */
export function seededIndex(seed: string, range: number) {
  if (!Number.isInteger(range) || range <= 0) return 0;
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % range;
}

/**
 * Identity of the *completed* schedule a card is bound to.
 *
 * The schedule id alone is not enough: two regenerated lineups can share an id
 * while airing different media, and a card that says "NEXT Roseanne" must be
 * invalidated the moment the lineup behind it changes. The hash therefore
 * covers every editorial and interstitial entry, the movie carry, the date and
 * the channel, but deliberately ignores the diagnostics list so a purely
 * explanatory note cannot invalidate already-rendered video.
 */
export function scheduleContentHash(schedule: Schedule): string {
  return stableHash({
    channelId: schedule.channelId,
    date: schedule.date,
    timezone: schedule.timezone,
    revision: schedule.revision,
    entries: schedule.entries.map((entry) => ({
      id: entry.id,
      start: entry.start,
      end: entry.end,
      durationMs: entry.durationMs,
      kind: entry.kind,
      mediaId: entry.mediaId ?? null,
      title: entry.title,
      movieOccurrenceKey: entry.movieOccurrenceKey ?? null,
      movieRole: entry.movieRole ?? null,
    })),
    movieCarry: schedule.movieCarry ?? null,
  });
}

/**
 * Identity of a continuity plan's evidence.
 *
 * The primary schedule is always covered. When a post-midnight card promotes a
 * film that actually started on the previous broadcast day, that adjacent
 * schedule's content is part of the claim the card makes, so it must be part of
 * the binding too - otherwise editing yesterday's lineup would leave today's
 * card looking valid.
 */
export function continuityPlanContentHash(
  schedule: Schedule,
  adjacentSchedules: Schedule[] = [],
): string {
  const primary = scheduleContentHash(schedule);
  if (!adjacentSchedules.length) return primary;
  return stableHash(
    [primary, ...adjacentSchedules.map((item) => scheduleContentHash(item))].sort(),
  );
}

/** A published card binding is valid only while all of its evidence is unchanged. */
export function publishedContinuityHash(
  schedule: Schedule,
  adjacentSchedules: Schedule[] = [],
): string | undefined {
  const binding = schedule.continuityBinding;
  if (!binding || binding.appliedHash !== scheduleContentHash(schedule)) return undefined;
  if (binding.adjacent.some((dependency) => {
    const adjacent = adjacentSchedules.find((item) => item.date === dependency.date);
    return !adjacent || scheduleContentHash(adjacent) !== dependency.hash;
  })) return undefined;
  return binding.contentHash;
}
