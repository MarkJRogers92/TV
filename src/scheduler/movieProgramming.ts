import { DateTime } from "luxon";
import type { Repositories } from "../db/repositories.js";
import type {
  Channel,
  MediaItem,
  MovieProgramming,
  MovieProgrammingBreakPolicy,
  MovieRole,
} from "../domain/models.js";
import {
  movieOccurrenceKey,
  movieOccurrenceSpecs,
  movieRotationSchema,
  movieWeekStart,
  rotationMediaId,
  rotationOrdinal,
  type MovieOccurrence,
  type MovieOccurrenceSpec,
  type MoviePosition,
  type MovieRotationRecord,
} from "../domain/movieProgramming.js";
import { createSeededRandom, fingerprint } from "./random.js";
import { withinMovieRoot } from "../media/movieEnrollment.js";

/**
 * The movie-programming engine.
 *
 * Everything in this module is a pure function of the catalog, the persisted
 * rotation, and the persisted occurrence ledger, apart from the two `ensure*`
 * helpers at the bottom that write what the pure functions derived. That split
 * is deliberate: generation, preview, and the status API all call the same
 * derivation, so they cannot disagree, and only the ledger write is stateful.
 */

/** Filler kinds a movie break or bridge may use. */
const wholeSpotKinds = new Set(["commercial", "filler", "bumper"]);

/**
 * Spacing policy for the sitcom channel's ordinary nightly feature.
 *
 * The rotation bag is fair, but its own cadence is fast: nine consuming slots a
 * week means a twenty-film bag comes back to the same ordinary night long before
 * three weeks are up - the plain modulo draw repeated a nightly feature after
 * about sixteen days. These two numbers apply to those nights and nothing else.
 * The Sunday and Monday overnight airings are linked encores, the weekend double
 * features are an approved stream of their own, and the all-day channels keep
 * their own pool cadence (nominally 24 hours hard, 72 preferred) without ever
 * reaching this path.
 *
 * Twenty-one days is the floor, held whenever the inventory can hold it: five
 * nights a week needs fifteen movies to keep every night three weeks apart.
 * Thirty days is the goal, and a bag of roughly thirty-eight films already
 * spaces its own rotation that far apart, so the correction only has to act when
 * the cadence would break the floor.
 *
 * The correction is opt-in and evidence-driven, because a plan is not an airing.
 * It runs only when the caller passes the verified airing ledger
 * (`actualExposure`); stored reservations and generated slots are the plan, and
 * treating either as exposure is exactly the mistake this policy must not make.
 * Without that evidence the assignment keeps the plain rotation draw.
 */
export const movieNightlyMinSpacingDays = 21;
export const movieNightlyTargetSpacingDays = 30;

export type WholeSpotSelection = {
  items: MediaItem[];
  durationMs: number;
  /**
   * `detected` when a combination of real spots makes the exact duration,
   * `estimated` when no such combination exists locally and the configured
   * target is used as a deterministic fallback.
   */
  source: "detected" | "estimated";
};

/**
 * The longest combination of whole spots that fits in `[minMs, maxMs]`.
 *
 * Exact only by construction: this is the same guarantee the materialized
 * mid-roll adapter enforces downstream, computed locally first so a break never
 * asks Tunarr for a duration the library cannot actually fill.
 */
export function wholeSpotCombination(
  items: MediaItem[],
  options: {
    minMs: number;
    maxMs: number;
    exclude?: ReadonlySet<string>;
    seed?: string;
  },
): { items: MediaItem[]; durationMs: number } | undefined {
  const usable = items.filter(
    (item) =>
      item.available &&
      wholeSpotKinds.has(item.kind) &&
      (item.durationMs ?? 0) > 0 &&
      !options.exclude?.has(item.id),
  );
  if (!usable.length || options.maxMs < options.minMs) return undefined;
  // Ranks are drawn once for the whole pool and the exclusion is applied after,
  // so the same break is picked whether or not some other item is excluded.
  const random = createSeededRandom(options.seed ?? "whole-spots");
  const ordered = usable
    .map((item) => ({
      item,
      rank: random(),
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank || left.item.id.localeCompare(right.item.id),
    )
    .map(({ item }) => item);

  const max = Math.floor(options.maxMs);
  const reachable = new Int32Array(max + 1).fill(-1);
  const picked = new Int32Array(max + 1).fill(-1);
  reachable[0] = 0;
  for (const [index, item] of ordered.entries()) {
    const duration = item.durationMs!;
    if (duration > max) continue;
    for (let total = max - duration; total >= 0; total -= 1) {
      if (reachable[total] !== 0 || reachable[total + duration] === 0) continue;
      reachable[total + duration] = 0;
      picked[total + duration] = index;
    }
  }
  // The best sum inside the window, preferring a longer break; ties are broken
  // by walking down from the maximum, which is deterministic.
  let best = -1;
  for (let total = max; total >= options.minMs; total -= 1) {
    if (reachable[total] === 0) {
      best = total;
      break;
    }
  }
  if (best < 0) return undefined;
  const selected: MediaItem[] = [];
  let cursor = best;
  while (cursor > 0) {
    const index = picked[cursor];
    if (index < 0) break;
    const item = ordered[index];
    selected.unshift(item);
    cursor -= item.durationMs!;
  }
  const durationMs = selected.reduce(
    (total, item) => total + item.durationMs!,
    0,
  );
  if (!selected.length || durationMs < options.minMs) return undefined;
  return { items: selected, durationMs };
}

/**
 * The duration of one movie break.
 *
 * Two minutes is the target and 2.5 minutes is a hard ceiling - the live sitcom
 * policy - so the choice is the longest real combination that does not exceed
 * it, with the plain target used only when the local library cannot make any
 * combination at all. The returned `source` is reported as a diagnostic, so an
 * estimated break is visible rather than silently indistinguishable from a
 * measured one.
 */
export function selectMovieBreak(
  items: MediaItem[],
  policy: MovieProgrammingBreakPolicy,
  options: { seed?: string } = {},
): WholeSpotSelection {
  const targetMs = Math.round(policy.targetMinutes * 60_000);
  const maxMs = Math.round(policy.maxMinutes * 60_000);
  // Exact target first: two minutes is what the feature asks for, and a library
  // that can make it exactly should not be stretched to the 2.5-minute ceiling
  // just because it also can.
  for (const window of [
    { minMs: targetMs, maxMs: targetMs },
    { minMs: targetMs + 1, maxMs },
    { minMs: 30_000, maxMs: Math.max(30_000, targetMs - 1) },
  ]) {
    const detected = wholeSpotCombination(items, { ...window, seed: options.seed });
    if (detected)
      return {
        items: detected.items,
        durationMs: detected.durationMs,
        source: "detected",
      };
  }
  return { items: [], durationMs: Math.min(targetMs, maxMs), source: "estimated" };
}

export type MovieMidroll = { offsetMs: number; durationMs: number };

/**
 * Where a movie's breaks land.
 *
 * Up to 110 minutes gets three breaks at a quarter, half and three quarters;
 * anything longer gets four at a fifth through four fifths. The first and last
 * `protectionMinutes` of the feature are never interrupted, and no two breaks
 * may leave a content segment shorter than `minimumSegmentMs`, so a short
 * feature simply gets fewer breaks instead of unusable ones.
 */
export function movieMidrollLayout(
  durationMs: number,
  breakDurationMs: number,
  policy: MovieProgrammingBreakPolicy,
): MovieMidroll[] {
  const shortMs = Math.round(policy.shortMaxMinutes * 60_000);
  const shares =
    durationMs <= shortMs ? [0.25, 0.5, 0.75] : [0.2, 0.4, 0.6, 0.8];
  const protectionMs = Math.round(policy.protectionMinutes * 60_000);
  const minimumSegmentMs = 5 * 60_000;
  const layout: MovieMidroll[] = [];
  for (const share of shares) {
    const offsetMs = Math.round((durationMs * share) / 1000) * 1000;
    if (offsetMs - protectionMs < minimumSegmentMs) continue;
    if (durationMs - offsetMs - protectionMs < minimumSegmentMs) continue;
    const previous = layout.at(-1)?.offsetMs ?? protectionMs;
    if (offsetMs - previous < minimumSegmentMs) continue;
    layout.push({ offsetMs, durationMs: breakDurationMs });
  }
  return layout;
}

/** Break offsets of a movie, rebased for a continuation that starts mid-film. */
export function continuationMidrolls(
  layout: MovieMidroll[],
  sourceOffsetMs: number,
): MovieMidroll[] {
  return layout
    // A break that sits exactly on the resume offset has NOT aired: the previous
    // broadcast day truncates content before the break, so dropping it here lost
    // one break of the film entirely. It is rebased to offset zero and played
    // before the resumed content.
    .filter((breakAt) => breakAt.offsetMs >= sourceOffsetMs)
    .map((breakAt) => ({
      offsetMs: breakAt.offsetMs - sourceOffsetMs,
      durationMs: breakAt.durationMs,
    }));
}

/**
 * The 60-120 second bridge between the two halves of a weekend double feature.
 *
 * Built from whole compatible interstitials so Tunarr can play it exactly, and
 * excluding spots already used elsewhere in the same day when that still leaves
 * a usable bridge - the same bag discipline the day's breaks use.
 */
export function selectMovieBridge(
  items: MediaItem[],
  programming: MovieProgramming,
  options: { seed?: string; exclude?: ReadonlySet<string> } = {},
): WholeSpotSelection | undefined {
  const minMs = Math.round(programming.bridgeMinSeconds * 1000);
  const maxMs = Math.round(programming.bridgeMaxSeconds * 1000);
  if (options.exclude?.size) {
    const excluded = wholeSpotCombination(items, {
      minMs,
      maxMs,
      exclude: options.exclude,
      seed: options.seed,
    });
    if (excluded)
      return { items: excluded.items, durationMs: excluded.durationMs, source: "detected" };
  }
  const selection = wholeSpotCombination(items, { minMs, maxMs, seed: options.seed });
  return selection
    ? { items: selection.items, durationMs: selection.durationMs, source: "detected" }
    : undefined;
}

/** Movies the rotation may draw: playable local movies in the configured pools. */
export function eligibleMovieIds(
  programming: MovieProgramming,
  pools: Array<{ id: string; mediaIds: string[] }>,
  items: MediaItem[],
): string[] {
  const configured = new Set(programming.poolIds);
  const memberIds = new Set(
    pools
      .filter((pool) => configured.has(pool.id))
      .flatMap((pool) => pool.mediaIds),
  );
  return items
    .filter(
      (item) =>
        item.kind === "movie" &&
        item.available &&
        (item.durationMs ?? 0) > 0 &&
        // Only the configured folder: a film from another root, or one left at
        // the folder this channel used before the root moved, is not eligible.
        withinMovieRoot(programming.rootPath, item.path) &&
        memberIds.has(item.id),
    )
    .map((item) => item.id)
    .sort();
}

/**
 * The rotation bag for a movie set.
 *
 * The order is a permutation of the eligible movies: every cycle plays all of
 * them once before any repeats, and because consecutive ordinals name adjacent
 * positions the same movie can never follow itself - including across the cycle
 * boundary, where the last and first entries are distinct by construction.
 *
 * An existing order is preserved in place and only extended, so a rescan that
 * finds the same library cannot reshuffle what is still to come; new movies are
 * appended in a deterministic shuffle of their own.
 */
export function buildMovieRotation(input: {
  channelId: string;
  eligibleIds: string[];
  existing?: MovieRotationRecord;
  epochDate: string;
  now: Date;
}): MovieRotationRecord {
  const eligible = [...new Set(input.eligibleIds)].sort();
  const seed =
    input.existing?.seed ?? `movie-rotation:${input.channelId}:${fingerprint(eligible)}`;
  const eligibleSet = new Set(eligible);
  const retained = (input.existing?.order ?? []).filter((id) =>
    eligibleSet.has(id),
  );
  const known = new Set(retained);
  const added = eligible.filter((id) => !known.has(id));
  const random = createSeededRandom(`${seed}:${added.join("|")}`);
  const shuffledAdded = [...added]
    .map((id) => ({ id, rank: random() }))
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
    .map(({ id }) => id);
  return movieRotationSchema.parse({
    channelId: input.channelId,
    seed,
    // The epoch is kept once set: moving it would renumber every unassigned
    // occurrence and quietly reshuffle the future.
    epochDate: input.existing?.epochDate ?? movieWeekStart(input.epochDate),
    order: [...retained, ...shuffledAdded],
    fingerprint: fingerprint(eligible),
    updatedAt: input.now.toISOString(),
  });
}

export type MovieAssignmentDiagnostic = {
  code:
    | "MOVIE_ROTATION_EMPTY"
    | "MOVIE_ROTATION_SHORT"
    | "MOVIE_ENCORE_SOURCE_MISSING"
    | "MOVIE_ENCORE_FALLBACK"
    | "MOVIE_ASSIGNMENT_REPAIRED"
    | "MOVIE_NIGHTLY_SPACING_BELOW_TARGET"
    | "MOVIE_NIGHTLY_SPACING_SHORTAGE";
  message: string;
  mediaId?: string;
  date?: string;
  position?: MoviePosition;
};

/**
 * One movie drawn for an encore slot whose earlier opener never aired.
 *
 * The fallback consumes the nearest preceding calendar reservation: the missed
 * source day's double-feature closer.  That reservation could not have aired
 * when the source opener itself was outside the activation window, and using it
 * makes the fallback the ordinal immediately before the next normal draw.  The
 * result is deterministic out of order, persists through the occurrence ledger,
 * and cannot randomly collide with Tuesday's movie when the bag has 2+ entries.
 */
export function fallbackRotationMediaId(
  rotation: MovieRotationRecord,
  encoreDate: string,
): string | undefined {
  const sourceDate = DateTime.fromISO(encoreDate, { zone: "UTC" })
    .minus({ days: 1 })
    .toISODate()!;
  return rotationMediaId(rotation, sourceDate, "double-feature-2");
}

/** Local calendar days from one broadcast date to a later one. */
function localCalendarDaysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  );
}

/**
 * One airing that really happened, as opposed to one that was planned.
 *
 * The spacing policy is fed these and nothing else. A stored occurrence row is
 * a reservation and a derived calendar slot is a plan: neither proves a movie
 * reached a viewer, and a cancelled reservation must not suppress a later pick.
 */
export type MovieExposureEvent = {
  mediaId: string;
  /** Broadcast date the airing actually started on. */
  date: string;
  /**
   * Occurrence key of the opener this airing replayed, when it was an encore.
   *
   * An encore is real exposure - the movie really aired that night - but it is
   * not a new draw from the bag.
   */
  encoreOf?: string;
};

export type MovieExposureIndex = {
  /** Latest broadcast date each movie actually aired, as exposure. */
  lastExposedOn: ReadonlyMap<string, string>;
  /**
   * Rotation slots the supplied airings really consumed.
   *
   * A linked opener and its encore replay one draw, so the pair counts once: an
   * encore is counted as exposure without consumption. That is what keeps a
   * stored reservation or an inferred slot from being mistaken for either.
   */
  cycleConsumption: number;
};

/**
 * Fold a list of actual airings into the history the spacing policy reads.
 *
 * Only the events handed in count. The caller is responsible for having
 * observed them; nothing here infers an airing from a date, a rotation ordinal,
 * or a persisted reservation.
 */
export function movieExposureIndex(
  events: readonly MovieExposureEvent[],
): MovieExposureIndex {
  const lastExposedOn = new Map<string, string>();
  let cycleConsumption = 0;
  for (const event of events) {
    const previous = lastExposedOn.get(event.mediaId);
    if (!previous || previous < event.date)
      lastExposedOn.set(event.mediaId, event.date);
    // An encore replays its opener's draw rather than taking one of its own.
    if (!event.encoreOf) cycleConsumption += 1;
  }
  return { lastExposedOn, cycleConsumption };
}

export type MovieNightlySpacingChoice = {
  mediaId: string;
  /** Local calendar days since that movie's last actual airing. */
  gapDays: number;
  /** True when the 21-day floor holds. */
  legal: boolean;
  /** True when the 30-day goal holds. */
  target: boolean;
  /** True when the rotation's own pick had to be replaced. */
  substituted: boolean;
};

/**
 * The ordinary nightly feature for one date.
 *
 * The rotation's own pick keeps the night whenever it already holds the goal, so
 * a channel whose bag is big enough airs exactly what it aired before: the
 * correction is invisible until a repeat would land inside three weeks. When the
 * pick falls inside the goal, the most rested movie that clears the goal takes
 * the night; when only the floor is reachable, the pick keeps the night if it
 * clears the floor and the most rested floor-clearer does otherwise. When no
 * movie is legal, the least recently aired one does and the caller reports the
 * scarcity instead of pretending the rule held.
 *
 * Candidates are scanned from the same rotation ordinal the plain draw used, so
 * equal rest is broken by the rotation's own order and the result stays
 * deterministic. A movie with a prospective reservation close ahead is capped
 * to the days until that reservation: a reservation can only shorten the rest
 * the policy sees, never invent exposure.
 */
export function spacedNightlyMovie(input: {
  order: readonly string[];
  ordinal: number;
  date: string;
  /** Latest actual airing of each movie, strictly before `date`. */
  lastExposedOn: ReadonlyMap<string, string>;
  /**
   * Prospective reservations by movie, mapped to the date they are reserved
   * for. Optional: absent means the caller has no future-reservation view.
   */
  reservedOn?: ReadonlyMap<string, string>;
  /** Movies the rotation may draw right now; empty means "not known yet". */
  eligible?: ReadonlySet<string>;
}): MovieNightlySpacingChoice | undefined {
  const size = input.order.length;
  if (!size) return undefined;
  const allowed = (mediaId: string) =>
    !input.eligible?.size || input.eligible.has(mediaId);
  const gapDays = (mediaId: string) => {
    const last = input.lastExposedOn.get(mediaId);
    const rested = last
      ? localCalendarDaysBetween(last, input.date)
      : Number.POSITIVE_INFINITY;
    const reserved = input.reservedOn?.get(mediaId);
    if (reserved === undefined) return rested;
    return Math.min(rested, localCalendarDaysBetween(input.date, reserved));
  };
  const start = ((input.ordinal % size) + size) % size;
  const plain = input.order[start]!;
  const plainAllowed = allowed(plain);
  const plainGap = gapDays(plain);
  // The rotation's own pick keeps the night whenever it already meets the goal.
  if (plainAllowed && plainGap >= movieNightlyTargetSpacingDays)
    return {
      mediaId: plain,
      gapDays: plainGap,
      legal: true,
      target: true,
      substituted: false,
    };
  type Candidate = { mediaId: string; gapDays: number };
  let restedTarget: Candidate | undefined;
  let restedFloor: Candidate | undefined;
  let restedAny: Candidate | undefined;
  for (let step = 0; step < size; step += 1) {
    const mediaId = input.order[(start + step) % size]!;
    if (!allowed(mediaId)) continue;
    const gap = gapDays(mediaId);
    if (!restedAny || gap > restedAny.gapDays)
      restedAny = { mediaId, gapDays: gap };
    if (gap < movieNightlyMinSpacingDays) continue;
    if (!restedFloor || gap > restedFloor.gapDays)
      restedFloor = { mediaId, gapDays: gap };
    if (gap < movieNightlyTargetSpacingDays) continue;
    if (!restedTarget || gap > restedTarget.gapDays)
      restedTarget = { mediaId, gapDays: gap };
  }
  // The goal is reachable, so take it even when the rotation's own pick was
  // merely legal: a night inside the goal is the bug this policy exists to fix.
  if (restedTarget)
    return {
      mediaId: restedTarget.mediaId,
      gapDays: restedTarget.gapDays,
      legal: true,
      target: true,
      substituted: restedTarget.mediaId !== plain,
    };
  if (plainAllowed && plainGap >= movieNightlyMinSpacingDays)
    return {
      mediaId: plain,
      gapDays: plainGap,
      legal: true,
      target: false,
      substituted: false,
    };
  if (restedFloor)
    return {
      mediaId: restedFloor.mediaId,
      gapDays: restedFloor.gapDays,
      legal: true,
      target: false,
      substituted: true,
    };
  if (!restedAny) return undefined;
  return {
    mediaId: restedAny.mediaId,
    gapDays: restedAny.gapDays,
    legal: false,
    target: false,
    substituted: true,
  };
}

export type MovieAssignmentResult = {
  /** Every occurrence resolved, including any the encore had to trigger itself. */
  occurrences: MovieOccurrence[];
  /** Just the occurrences that start on the requested date. */
  forDate: MovieOccurrence[];
  diagnostics: MovieAssignmentDiagnostic[];
};

/**
 * Resolve one date's movie assignments against the persisted ledger.
 *
 * Exist rows are returned untouched - that is the idempotence guarantee - and a
 * missing encore source is resolved on demand, which is what makes generating
 * Monday before Sunday work: the link is derived from the same calendar and
 * rotation the missing day would have used, so whichever order the days arrive
 * in the assignment is identical.
 */
export function assignMovieOccurrences(input: {
  channelId: string;
  date: string;
  programming: MovieProgramming;
  rotation: MovieRotationRecord;
  existing: (date: string, position: MoviePosition) => MovieOccurrence | undefined;
  resolvedAt: string;
  /**
   * Local broadcast date the feature became active, when it is known.
   *
   * An encore may only reach back to an opener the feature actually scheduled.
   * Before this date there is nothing to replay, so the slot takes a normal draw
   * and says so instead of inventing an airing that never happened.
   */
  activationDate?: string;
  /**
   * Exact instant the feature was enabled, plus the broadcast timezone.
   *
   * `activationDate` remains for configurations created before this timestamp
   * existed.  When the instant is present, a same-date weekend opener is only
   * a valid encore source if its scheduled anchor had not already passed.
   */
  activatedAt?: string;
  timezone?: string;
  /**
   * Media the rotation can draw right now.
   *
   * Non-empty means "the library was visible and these are the eligible films",
   * which is what makes a stored assignment that is no longer in the set
   * recognisable as stale. Empty means the library could not be seen - an
   * unmounted share, a failed probe - and never means "nothing is playable", so
   * nothing is rewritten against it.
   */
  eligibleMediaIds?: ReadonlySet<string>;
  /** Whether a stored assignment for this date may be replaced. */
  repairable?: (date: string) => boolean;
  /**
   * Shadow-only opt-in: the verified airing ledger the spacing policy reads.
   *
   * Absent - as every production call is today - the ordinary nightly feature
   * keeps the plain rotation draw, because there is no evidence of what a
   * viewer actually saw. Present means the caller has observed these airings and
   * the nightly draw may be corrected so a repeat cannot land inside
   * `movieNightlyMinSpacingDays`. Scope it to the airings of the nights this
   * policy governs - the nightly slot, its overnight encores included. Stored
   * reservations and generated slots are plans, never exposure, so they never
   * appear here.
   */
  actualExposure?: readonly MovieExposureEvent[];
  /**
   * Prospective reservation conflicts, kept separate from exposure.
   *
   * A movie already reserved shortly after a candidate night cannot also take
   * that night without repeating itself too soon, so a reservation caps the rest
   * the policy sees. Optional, and only ever a constraint: it never stands in for
   * an airing.
   */
  prospectiveReservations?: ReadonlyMap<string, string>;
}): MovieAssignmentResult {
  const diagnostics: MovieAssignmentDiagnostic[] = [];
  const resolved = new Map<string, MovieOccurrence>();
  const specs = movieOccurrenceSpecs(input.date, input.programming);
  const emptyRotation = input.rotation.order.length === 0;
  if (emptyRotation)
    diagnostics.push({
      code: "MOVIE_ROTATION_EMPTY",
      message: "No eligible movies are available for the movie rotation",
      date: input.date,
    });
  else if (input.rotation.order.length < 2)
    diagnostics.push({
      code: "MOVIE_ROTATION_SHORT",
      message:
        "Only one movie is eligible, so consecutive movie airings must repeat it",
      date: input.date,
    });

  const specFor = (date: string, position: MoviePosition) =>
    movieOccurrenceSpecs(date, input.programming).find(
      (spec) => spec.position === position,
    );

  const isStale = (occurrence: MovieOccurrence) =>
    (input.eligibleMediaIds?.size ?? 0) > 0 &&
    !input.eligibleMediaIds!.has(occurrence.mediaId) &&
    (input.repairable?.(occurrence.date) ?? false);

  /**
   * Whether the opener an encore names was ever actually scheduled: it is on the
   * ledger, or it falls on a broadcast date the feature covers and can still be
   * derived (generation out of order, as the rolling pass does). A date alone is
   * not enough for a feature enabled mid-day: Sunday at 21:56 must not
   * manufacture the Sunday 19:00 opener and then replay it on Monday. The exact
   * activation instant gates both derivation *and* a stored row, since an older
   * buggy run may have persisted that synthetic pre-activation opener.
   */
  const openerCovered = (
    sourceSpec: MovieOccurrenceSpec | undefined,
    sourceDate: string,
  ): boolean => {
    if (!input.activatedAt || !input.timezone)
      return !input.activationDate || sourceDate >= input.activationDate;
    const activatedAt = DateTime.fromISO(input.activatedAt).setZone(
      input.timezone,
    );
    const sourceAt = sourceSpec
      ? DateTime.fromISO(`${sourceSpec.date}T${sourceSpec.anchor}`, {
          zone: input.timezone,
        })
      : undefined;
    // Fail closed if persisted metadata is malformed.  A later normal fallback
    // is safer than claiming an opener aired when it could not.
    return Boolean(
      activatedAt.isValid &&
        sourceAt?.isValid &&
        sourceAt.toMillis() >= activatedAt.toMillis(),
    );
  };

  /**
   * The verified airing ledger, when the caller supplied one.
   *
   * Built only from observed airings. Nothing here walks the calendar or the
   * occurrence ledger to guess what a night "would have" aired: a reservation
   * that was cancelled, or a slot that was never generated, produced no exposure
   * and must not push a later pick around.
   */
  // A full verified ledger can contain airings after the date being resolved.
  // Build each night's view from earlier events only: later exposure must never
  // rewrite a past decision or hide an older airing of the same movie.
  const exposureBefore = input.actualExposure
    ? (date: string) =>
        movieExposureIndex(input.actualExposure!.filter((event) => event.date < date))
    : undefined;

  const resolveSpec = (spec: MovieOccurrenceSpec): MovieOccurrence | undefined => {
    const key = movieOccurrenceKey(spec.date, spec.position);
    const already = resolved.get(key);
    if (already) return already;
    const stored = input.existing(spec.date, spec.position);
    // A stored assignment whose film has left the eligible set can never air as
    // written. Future, unpublished dates are re-derived from the rotation (or
    // from a repaired opener); anything already broadcast is left alone.
    const staleStored =
      stored !== undefined && isStale(stored);
    if (stored && !staleStored) {
      resolved.set(key, stored);
      return stored;
    }
    if (stored && staleStored)
      diagnostics.push({
        code: "MOVIE_ASSIGNMENT_REPAIRED",
        message: `${stored.mediaId} is no longer an eligible movie; ${key} was re-derived from the current rotation`,
        mediaId: stored.mediaId,
        date: spec.date,
        position: spec.position,
      });
    let mediaId: string | undefined;
    let encoreFallback = false;
    if (spec.consumes) {
      // The ordinary nightly feature is the one draw the spacing rule owns, and
      // only when the caller handed in verified exposure. The weekend double
      // features stay on the rotation verbatim.
      const choice =
        spec.position === "nightly" && exposureBefore
          ? spacedNightlyMovie({
              order: input.rotation.order,
              ordinal: rotationOrdinal(
                input.rotation.epochDate,
                spec.date,
                spec.position,
              ),
              date: spec.date,
              lastExposedOn: exposureBefore(spec.date).lastExposedOn,
              reservedOn: input.prospectiveReservations,
              eligible: input.eligibleMediaIds,
            })
          : undefined;
      mediaId =
        choice?.mediaId ??
        rotationMediaId(input.rotation, spec.date, spec.position);
      // The diagnostic reports the night's actual status: a shortage when not
      // even the floor was reachable, below-target when the floor held but the
      // goal did not. A substitution that clears the goal is not a problem and
      // is not reported as one.
      if (choice && !choice.legal)
        diagnostics.push({
          code: "MOVIE_NIGHTLY_SPACING_SHORTAGE",
          message: `No eligible movie had been off the ordinary nightly feature for ${movieNightlyMinSpacingDays} days on ${spec.date}; ${choice.mediaId} is the most rested at ${choice.gapDays} days`,
          mediaId: choice.mediaId,
          date: spec.date,
          position: spec.position,
        });
      else if (choice && !choice.target)
        diagnostics.push({
          code: "MOVIE_NIGHTLY_SPACING_BELOW_TARGET",
          message: choice.substituted
            ? `The rotation's next movie for ${spec.date} had aired too recently; ${choice.mediaId} was the most rested at ${choice.gapDays} days, short of the ${movieNightlyTargetSpacingDays}-day goal`
            : `${choice.mediaId} last aired ${choice.gapDays} days before ${spec.date} and no eligible movie reached the ${movieNightlyTargetSpacingDays}-day goal, so the rotation's own pick held`,
          mediaId: choice.mediaId,
          date: spec.date,
          position: spec.position,
        });
    } else if (spec.encoreOf) {
      const [sourceDate, sourcePosition] = spec.encoreOf.split(":") as [
        string,
        MoviePosition,
      ];
      const sourceSpec = specFor(sourceDate, sourcePosition);
      const sourceCovered = openerCovered(sourceSpec, sourceDate);
      if (sourceCovered) {
        const source = sourceSpec ? resolveSpec(sourceSpec) : undefined;
        if (source) mediaId = source.mediaId;
      }
      if (!mediaId && sourceCovered)
        mediaId = input.existing(sourceDate, sourcePosition)?.mediaId;
      if (!mediaId) {
        mediaId = fallbackRotationMediaId(
          input.rotation,
          spec.date,
        );
        encoreFallback = Boolean(mediaId);
        if (encoreFallback)
          diagnostics.push({
            code: "MOVIE_ENCORE_FALLBACK",
            message: `No weekend opener was scheduled for ${key}, so a normal movie was drawn from the rotation instead of replaying one that never aired`,
            date: spec.date,
            position: spec.position,
          });
        else
          diagnostics.push({
            code: "MOVIE_ENCORE_SOURCE_MISSING",
            message: `No weekend opener is available to replay for ${key}`,
            date: spec.date,
            position: spec.position,
          });
      }
    }
    if (!mediaId) return undefined;
    const occurrence: MovieOccurrence = {
      channelId: input.channelId,
      date: spec.date,
      position: spec.position,
      // A fallback draw is not an encore: it consumed a slot from the bag.
      role: encoreFallback ? "nightly" : spec.role,
      anchor: spec.anchor,
      mediaId,
      consumes: encoreFallback ? true : spec.consumes,
      encoreOf: encoreFallback ? undefined : spec.encoreOf,
      resolvedAt: input.resolvedAt,
    };
    resolved.set(key, occurrence);
    return occurrence;
  };

  const forDate = specs
    .map((spec) => resolveSpec(spec))
    .filter((occurrence): occurrence is MovieOccurrence => Boolean(occurrence));
  return {
    occurrences: [...resolved.values()],
    forDate,
    diagnostics,
  };
}

/**
 * The rotation the channel is using now, derived but NOT written.
 *
 * Shared by the persisting path and the preview, which must be able to answer
 * "what would air?" before a rotation has ever been stored without creating one.
 */
export function currentMovieRotation(
  repositories: Repositories,
  channel: Channel,
  options: { epochDate: string; now: Date },
): MovieRotationRecord {
  const programming = channel.movieProgramming!;
  const existing = repositories.movieRotations.get(channel.id);
  const eligible = eligibleMovieIds(
    programming,
    repositories.pools.list(),
    repositories.media.list(),
  );
  // Nothing eligible is not evidence that the library is empty - it is what a
  // failed mount, an unmounted share, or a library-wide probe failure looks like
  // from here. Pruning the bag to nothing would then destroy the rotation, so an
  // empty sweep keeps what is stored; a genuinely emptied library is reset by an
  // operator, not by a scan that could not see it.
  if (!eligible.length && existing?.order.length)
    return existing;
  return buildMovieRotation({
    channelId: channel.id,
    eligibleIds: eligible,
    existing,
    epochDate: options.epochDate,
    now: options.now,
  });
}

/** The rotation the channel should be using now, persisted when it changed. */
export function ensureMovieRotation(
  repositories: Repositories,
  channel: Channel,
  options: { epochDate: string; now: Date },
): { rotation: MovieRotationRecord; changed: boolean } {
  const existing = repositories.movieRotations.get(channel.id);
  const rebuilt = currentMovieRotation(repositories, channel, options);
  const changed =
    !existing ||
    existing.fingerprint !== rebuilt.fingerprint ||
    existing.order.join("\u001f") !== rebuilt.order.join("\u001f");
  const rotation = changed
    ? repositories.movieRotations.put(rebuilt)
    : existing!;
  return { rotation, changed };
}

export type MovieAiringsForDate = {
  occurrences: MovieOccurrence[];
  diagnostics: MovieAssignmentDiagnostic[];
  /** Assignments resolved away from the requested date to satisfy an encore. */
  dependencies: MovieOccurrence[];
};

/** Where a date's assignments are read from and written to. */
export type MovieLedger = {
  get: (date: string, position: MoviePosition) => MovieOccurrence | undefined;
  put: (occurrence: MovieOccurrence) => void;
};

/** Local broadcast date of an instant, in the channel's own zone. */
export function broadcastDateAt(channel: Channel, at: Date): string {
  return DateTime.fromJSDate(at, { zone: channel.timezone }).toISODate()!;
}

/**
 * First broadcast date the feature covers, when it was enabled mid-flight.
 *
 * Undefined on channels enabled before this metadata existed, whose encores keep
 * the old linking behaviour.
 */
export function movieActivationDate(
  channel: Channel,
  timezone: string,
): string | undefined {
  const activatedAt = channel.movieProgramming?.activatedAt;
  if (!activatedAt) return undefined;
  return (
    DateTime.fromISO(activatedAt)
      .setZone(timezone)
      .toISODate() ?? undefined
  );
}

function resolveMovieDate(input: {
  channel: Channel;
  date: string;
  rotation: MovieRotationRecord;
  ledger: MovieLedger;
  now: Date;
  eligibleMediaIds: ReadonlySet<string>;
  persist: boolean;
}): MovieAiringsForDate {
  const programming = input.channel.movieProgramming!;
  const today = broadcastDateAt(input.channel, input.now);
  // Only days that have not been broadcast yet may be rewritten, and never
  // against an empty eligible set - that is an unmounted library, not an
  // instruction to throw the saved assignments away.
  const repairable = (date: string) => date >= today;
  const result = assignMovieOccurrences({
    channelId: input.channel.id,
    date: input.date,
    programming,
    rotation: input.rotation,
    existing: input.ledger.get,
    resolvedAt: input.now.toISOString(),
    activationDate: movieActivationDate(input.channel, input.channel.timezone),
    activatedAt: programming.activatedAt,
    timezone: input.channel.timezone,
    eligibleMediaIds: input.eligibleMediaIds,
    repairable,
  });
  const dependencies = result.occurrences.filter(
    (occurrence) => occurrence.date !== input.date,
  );
  const writes = [...dependencies, ...result.forDate];
  for (const occurrence of writes) input.ledger.put(occurrence);

  // An encore is a reference to an opener, not a copy chosen independently, so a
  // repaired opener has to take its encores with it - otherwise the next day
  // replays a film that no longer exists. Same transaction, same pass: a ledger
  // that agreed with itself only halfway through would be worse than either.
  for (const occurrence of writes) {
    if (occurrence.position !== "double-feature-1") continue;
    const encoreDate = DateTime.fromISO(occurrence.date)
      .plus({ days: 1 })
      .toISODate();
    if (!encoreDate) continue;
    const encore = input.ledger.get(encoreDate, "nightly");
    if (
      !encore?.encoreOf ||
      encore.encoreOf !== movieOccurrenceKey(occurrence.date, occurrence.position) ||
      encore.mediaId === occurrence.mediaId ||
      !repairable(encore.date)
    )
      continue;
    input.ledger.put({
      ...encore,
      mediaId: occurrence.mediaId,
      resolvedAt: input.now.toISOString(),
    });
  }
  return {
    occurrences: result.forDate,
    diagnostics: result.diagnostics,
    dependencies,
  };
}

/**
 * A read-only view of the feature for one horizon.
 *
 * Derived assignments accumulate in memory - so a later day's encore still sees
 * an earlier day's opener - but nothing is written: no rotation, no occurrence,
 * no schedule. The preview and the status API use this, which is what makes them
 * genuinely non-mutating.
 */
export type MovieProjection = {
  rotation: MovieRotationRecord;
  eligibleMediaIds: ReadonlySet<string>;
  resolve: (date: string) => MovieAiringsForDate;
};

export function openMovieProjection(
  repositories: Repositories,
  channel: Channel,
  options: { date: string; now: Date },
): MovieProjection | undefined {
  const programming = channel.movieProgramming;
  if (!programming?.enabled) return undefined;
  const rotation = currentMovieRotation(repositories, channel, {
    epochDate: options.date,
    now: options.now,
  });
  const eligibleMediaIds = new Set(
    eligibleMovieIds(
      programming,
      repositories.pools.list(),
      repositories.media.list(),
    ),
  );
  const overlay = new Map<string, MovieOccurrence>();
  const ledger: MovieLedger = {
    get: (date, position) =>
      overlay.get(movieOccurrenceKey(date, position)) ??
      repositories.movieOccurrences.get(channel.id, date, position),
    put: (occurrence) =>
      overlay.set(
        movieOccurrenceKey(occurrence.date, occurrence.position),
        occurrence,
      ),
  };
  return {
    rotation,
    eligibleMediaIds,
    resolve: (date) =>
      resolveMovieDate({
        channel,
        date,
        rotation,
        ledger,
        now: options.now,
        eligibleMediaIds,
        persist: false,
      }),
  };
}

/**
 * Assignments for one broadcast date, persisting whatever was newly derived.
 *
 * Called by every path that needs a day: generation, the rolling coverage pass,
 * and after a movie configuration change.
 */
export function ensureMovieOccurrencesForDate(
  repositories: Repositories,
  channel: Channel,
  date: string,
  now: Date,
): MovieAiringsForDate | undefined {
  const programming = channel.movieProgramming;
  if (!programming?.enabled) return undefined;
  const eligibleMediaIds = new Set(
    eligibleMovieIds(
      programming,
      repositories.pools.list(),
      repositories.media.list(),
    ),
  );
  // The rotation and every occurrence it implies are one write: a rotation
  // rewritten without the assignments it produced (or the reverse) would leave
  // the ledger disagreeing with the bag it was drawn from.
  return repositories.transaction(() => {
    const rotation = ensureMovieRotation(repositories, channel, {
      epochDate: date,
      now,
    }).rotation;
    const ledger: MovieLedger = {
      get: (sourceDate, position) =>
        repositories.movieOccurrences.get(channel.id, sourceDate, position),
      put: (occurrence) => {
        repositories.movieOccurrences.put(occurrence);
      },
    };
    return resolveMovieDate({
      channel,
      date,
      rotation,
      ledger,
      now,
      eligibleMediaIds,
      persist: true,
    });
  });
}

/** Local anchor instant of an airing on its broadcast date. */
export function anchorInstant(
  date: string,
  anchor: string,
  timezone: string,
): DateTime {
  const [hour, minute] = anchor.split(":").map(Number);
  return DateTime.fromObject(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour,
      minute,
    },
    { zone: timezone },
  );
}

/** Tail of a feature that stopped at a broadcast-day boundary. */
export type MovieContinuationTail = {
  mediaId: string;
  sourceOffsetMs: number;
  occurrenceKey?: string;
  role?: MovieRole;
};

/** A closer an interrupted weekend double feature still owes. */
export type MoviePendingCloser = {
  occurrenceKey: string;
  mediaId: string;
  role: MovieRole;
  encore: boolean;
  bridgeOwed: boolean;
};

/**
 * What one broadcast day inherits from the day before.
 *
 * Either half may stand alone: an ordinary feature that crossed midnight owes
 * only its own tail, while a double feature whose opener finished at the
 * boundary owes the closer (and maybe the bridge) with no tail at all.
 */
export type MovieContinuationPlan = {
  continuation?: MovieContinuationTail;
  pendingCloser?: MoviePendingCloser;
};

export type MovieAiringPlan = {
  occurrenceKey: string;
  date: string;
  position: MoviePosition;
  role: MovieRole;
  anchor: string;
  mediaId: string;
  encore: boolean;
  /** Shared by the two movies of one weekend double feature. */
  pairId?: string;
};

/**
 * The generator-facing plan for one broadcast date.
 *
 * Derived entirely from persisted assignments, so it is the same on a preview, a
 * regeneration, and a restart.
 */
export function movieProgrammingPlan(input: {
  channel: Channel;
  date: string;
  occurrences: MovieOccurrence[];
  continuations?: MovieContinuationPlan[];
}): {
  airings: MovieAiringPlan[];
  continuations: MovieContinuationPlan[];
} | undefined {
  const programming = input.channel.movieProgramming;
  if (!programming?.enabled) return undefined;
  const airings = input.occurrences
    .map((occurrence): MovieAiringPlan => ({
      occurrenceKey: movieOccurrenceKey(occurrence.date, occurrence.position),
      date: occurrence.date,
      position: occurrence.position,
      role: occurrence.role,
      anchor: occurrence.anchor,
      mediaId: occurrence.mediaId,
      encore: !occurrence.consumes,
      pairId: occurrence.position.startsWith("double-feature")
        ? `${occurrence.date}:double-feature`
        : undefined,
    }))
    .sort(
      (left, right) =>
        anchorInstant(left.date, left.anchor, input.channel.timezone).toMillis() -
          anchorInstant(right.date, right.anchor, input.channel.timezone).toMillis() ||
        left.position.localeCompare(right.position),
    );
  return { airings, continuations: input.continuations ?? [] };
}
