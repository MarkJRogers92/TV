import { createHash } from "node:crypto";
import type { Repositories } from "../db/repositories.js";
import { normalizedSeriesTitle } from "../acquisition/models.js";
import type { MediaItem, Pool } from "../domain/models.js";

/**
 * Keeps the schedule reachable for series that acquisition imports.
 *
 * An imported episode is useless to the scheduler until some pool holds it and
 * some slot references that pool, but making the user repeat that in Library and
 * Channel for every episode defeats the point of importing through Wanted. This
 * module enrols an imported series into one chronological pool and points the
 * episode slots at it.
 *
 * Enrolment is deliberately a separate, idempotent step rather than part of
 * `completeAcquisitionImport`'s transaction. Coupling it there would let a
 * scheduling-configuration problem roll back an otherwise valid import, which is
 * explicitly not wanted; instead every entry point is safe to repeat, and startup
 * reconciliation sweeps the completion ledger so an episode whose enrolment was
 * skipped can never be permanently forgotten.
 */

/** The only channel automatically enrolled for this milestone. */
export const ENROLLMENT_CHANNEL_ID = "marktv-laughs";
/** Matches the seeded episode pools: twelve hours between repeats. */
export const SERIES_POOL_NO_REPEAT_MINUTES = 720;
export const SERIES_POOL_WEIGHT = 1;
/** Settings key holding the most recent enrolment diagnostics, when any exist. */
export const ENROLLMENT_DIAGNOSTICS_SETTING = "series-enrollment-diagnostics";

export type EnrollmentDiagnostic = {
  code: "CHANNEL_MISSING" | "ENROLLMENT_FAILED";
  message: string;
  series: string;
  mediaId: string;
};

export type EnrollmentOutcome = {
  series: string;
  poolId: string;
  mediaId: string;
  /** True when this call created the pool, false when an existing one was reused. */
  poolCreated: boolean;
  /** Episode slots that gained the pool reference on this call. */
  slotsEnrolled: number;
  diagnostics: EnrollmentDiagnostic[];
};

/**
 * Deterministic pool id for a series.
 *
 * The slug is derived from the normalized title, so punctuation, spacing and
 * casing cannot produce two pools for one series. If an unrelated pool already
 * owns the slug, a hash of the normalized title is appended: still purely a
 * function of the title, so the same series always lands on the same id no matter
 * what else is in the database or what order things are deleted in.
 */
export function seriesPoolId(pools: Pool[], normalized: string): string {
  const base = normalized.replace(/ /g, "-") || "series";
  if (!pools.some((pool) => pool.id === base)) return base;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  let candidate = `${base}-${digest}`;
  for (let attempt = 2; pools.some((pool) => pool.id === candidate); attempt += 1)
    candidate = `${base}-${digest}-${attempt}`;
  return candidate;
}

/** An existing pool already serving this series, if there is one. */
function compatiblePool(pools: Pool[], normalized: string): Pool | undefined {
  return pools.find(
    (pool) =>
      pool.kinds.includes("episode") &&
      normalizedSeriesTitle(pool.name) === normalized,
  );
}

/**
 * Adds one imported episode to its series pool and points the target channel's
 * episode slots at that pool.
 *
 * Returns undefined for media that is not a schedulable episode. Never removes a
 * pool member, reorders a slot's pools, or changes an existing pool's mode,
 * weight or cooldown: the only edits are appending.
 */
export function enrollImportedEpisode(
  repositories: Repositories,
  media: MediaItem,
): EnrollmentOutcome | undefined {
  const series = media.showTitle?.trim();
  if (
    media.kind !== "episode" ||
    !media.available ||
    !media.path ||
    !series
  )
    return undefined;
  const normalized = normalizedSeriesTitle(series);
  if (!normalized) return undefined;

  return repositories.transaction(() => {
    const pools = repositories.pools.list();
    const existing = compatiblePool(pools, normalized);
    const pool: Pool = existing ?? {
      id: seriesPoolId(pools, normalized),
      name: series,
      kinds: ["episode"],
      mediaIds: [],
      mode: "chronological",
      noRepeatMinutes: SERIES_POOL_NO_REPEAT_MINUTES,
      weight: SERIES_POOL_WEIGHT,
    };
    if (!pool.mediaIds.includes(media.id))
      repositories.pools.put({ ...pool, mediaIds: [...pool.mediaIds, media.id] });

    const diagnostics: EnrollmentDiagnostic[] = [];
    let slotsEnrolled = 0;
    const channel = repositories.channels.get(ENROLLMENT_CHANNEL_ID);
    if (!channel) {
      diagnostics.push({
        code: "CHANNEL_MISSING",
        message: `Channel ${ENROLLMENT_CHANNEL_ID} is missing, so "${series}" was pooled but no slot references it yet. Enrolment repeats at startup and will attach it once the channel exists.`,
        series,
        mediaId: media.id,
      });
    } else {
      const slots = channel.slots.map((slot) => {
        if (slot.kind !== "episode" || slot.poolIds.includes(pool.id)) return slot;
        slotsEnrolled += 1;
        return { ...slot, poolIds: [...slot.poolIds, pool.id] };
      });
      if (slotsEnrolled > 0)
        repositories.channels.put({ ...channel, slots });
    }

    return {
      series,
      poolId: pool.id,
      mediaId: media.id,
      poolCreated: existing === undefined,
      slotsEnrolled,
      diagnostics,
    };
  });
}

/**
 * Enrols every episode the acquisition ledger records as imported, in ledger
 * order. Safe to run at any time: it only ever appends, so a repeat writes
 * nothing. This is what closes the window between an import committing and its
 * enrolment happening.
 */
export function reconcileImportedSeries(
  repositories: Repositories,
  options: { now?: Date } = {},
): EnrollmentOutcome[] {
  const outcomes: EnrollmentOutcome[] = [];
  for (const imported of repositories.acquisitions.imports.list()) {
    const media = repositories.media.get(imported.mediaId);
    if (!media || media.kind !== "episode") continue;
    const outcome = enrollImportedEpisode(repositories, media);
    if (outcome) outcomes.push(outcome);
  }
  persistDiagnostics(
    repositories,
    outcomes.flatMap((outcome) => outcome.diagnostics),
    options.now ?? new Date(),
  );
  return outcomes;
}

/**
 * Records why enrolment could not run, so the condition is inspectable instead of
 * only living in a return value the caller may discard.
 */
export function recordEnrollmentFailure(
  repositories: Repositories,
  error: unknown,
  now: Date = new Date(),
): EnrollmentDiagnostic {
  const diagnostic: EnrollmentDiagnostic = {
    code: "ENROLLMENT_FAILED",
    message: `Could not enrol imported series: ${error instanceof Error ? error.message : String(error)}`,
    series: "",
    mediaId: "",
  };
  persistDiagnostics(repositories, [diagnostic], now);
  return diagnostic;
}

/** Keeps the latest diagnostics visible while the condition persists. */
function persistDiagnostics(
  repositories: Repositories,
  diagnostics: EnrollmentDiagnostic[],
  now: Date,
): void {
  if (diagnostics.length === 0) {
    repositories.settings.remove(ENROLLMENT_DIAGNOSTICS_SETTING);
    return;
  }
  repositories.settings.put(ENROLLMENT_DIAGNOSTICS_SETTING, {
    at: now.toISOString(),
    diagnostics,
  });
}
