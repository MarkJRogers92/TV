import { z } from "zod";
import { DateTime } from "luxon";
import {
  broadcastDateSchema,
  movieRoleSchema,
  type MovieProgramming,
  type MovieRole,
} from "./models.js";

/**
 * The movie-programming feature's own persisted state.
 *
 * Two records, both separate from the sitcom scheduling state:
 *
 * - a ROTATION, which is the bag of movies and the order they are drawn in;
 * - OCCURRENCES, which are dated assignments - this date, this position, this
 *   movie - including the encores that reuse an earlier assignment.
 *
 * They are separated because they answer different questions and change at
 * different rates. A rescan rewrites the rotation when the inventory changed; a
 * regeneration of one day must not. Keeping assignments in their own table is
 * what makes "preview, rescan and restart never consume or reseed the rotation"
 * true rather than merely intended: an assignment is looked up before it is
 * derived, so re-deriving it is idempotent, and the rotation is only rewritten
 * when the set of eligible movies actually changed.
 */

export const moviePositions = [
  "nightly",
  "double-feature-1",
  "double-feature-2",
] as const;
export type MoviePosition = (typeof moviePositions)[number];

export const movieOccurrenceSchema = z.object({
  channelId: z.string().min(1),
  date: broadcastDateSchema,
  position: z.enum(moviePositions),
  role: movieRoleSchema,
  /** Local anchor the assignment is aimed at, e.g. "02:00". */
  anchor: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  mediaId: z.string().min(1),
  /**
   * True when this airing took a slot from the rotation.
   *
   * An encore is `false`: it replays an already-drawn movie, which is why a
   * normal week has eleven starts but only nine new selections.
   */
  consumes: z.boolean(),
  /** Occurrence key of the opener this encore replays, when it is an encore. */
  encoreOf: z.string().min(1).optional(),
  resolvedAt: z.string().min(1),
});
export type MovieOccurrence = z.infer<typeof movieOccurrenceSchema>;

export const movieRotationSchema = z.object({
  channelId: z.string().min(1),
  /**
   * Shuffle seed, persisted with the rotation.
   *
   * A rescan that finds the same movies must not produce a different bag; the
   * seed and the deterministic derivation below are what guarantee that.
   */
  seed: z.string().min(1),
  /**
   * The Sunday the rotation's first cycle starts at.
   *
   * Ordinals are counted from here so they are a pure function of a date rather
   * than of the order days happened to be generated in.
   */
  epochDate: broadcastDateSchema,
  order: z.array(z.string().min(1)),
  /** Fingerprint of the eligible movie set the order was built for. */
  fingerprint: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MovieRotationRecord = z.infer<typeof movieRotationSchema>;

export type MovieOccurrenceSpec = {
  date: string;
  position: MoviePosition;
  role: MovieRole;
  anchor: string;
  consumes: boolean;
  /** Occurrence key this encore replays. */
  encoreOf?: string;
};

export function movieOccurrenceKey(
  date: string,
  position: MoviePosition,
): string {
  return `${date}:${position}`;
}

const calendarDate = (date: string) => DateTime.fromISO(date, { zone: "UTC" });
const weekday = (date: string) => calendarDate(date).weekday % 7;

/** Sunday of the broadcast week containing `date`, as YYYY-MM-DD. */
export function movieWeekStart(date: string): string {
  return calendarDate(date)
    .minus({ days: weekday(date) })
    .toISODate()!;
}

/**
 * Consuming positions in one week, in broadcast order.
 *
 * Sunday 02:00 and Monday 02:00 are absent deliberately: they are encores of the
 * weekend openers and draw nothing new. That leaves nine per week - two from each
 * double feature and five ordinary nightly features - which is what makes a
 * normal week read as eleven starts, nine new, two encores.
 */
const consumingSlotsInWeek: Array<{
  day: number;
  position: MoviePosition;
}> = [
  { day: 0, position: "double-feature-1" },
  { day: 0, position: "double-feature-2" },
  { day: 2, position: "nightly" },
  { day: 3, position: "nightly" },
  { day: 4, position: "nightly" },
  { day: 5, position: "nightly" },
  { day: 6, position: "nightly" },
  { day: 6, position: "double-feature-1" },
  { day: 6, position: "double-feature-2" },
];

/**
 * Which airings start on one broadcast date.
 *
 * Sunday and Monday early-morning features are encores of the previous day's
 * weekend opener, so they resolve to that assignment instead of taking a new
 * one. Saturday and Sunday evenings carry the double feature.
 */
export function movieOccurrenceSpecs(
  date: string,
  programming: MovieProgramming,
): MovieOccurrenceSpec[] {
  const day = weekday(date);
  const previousDate = calendarDate(date).minus({ days: 1 }).toISODate()!;
  const specs: MovieOccurrenceSpec[] = [];
  if ((day === 0 || day === 1) && programming.weekendOpenerEncoreEnabled) {
    specs.push({
      date,
      position: "nightly",
      role: "encore",
      anchor: programming.nightlyAnchor,
      consumes: false,
      encoreOf: movieOccurrenceKey(previousDate, "double-feature-1"),
    });
  } else {
    specs.push({
      date,
      position: "nightly",
      role: "nightly",
      anchor: programming.nightlyAnchor,
      consumes: true,
    });
  }
  if (day === 0 || day === 6) {
    specs.push({
      date,
      position: "double-feature-1",
      role: "weekend-opener",
      anchor: programming.weekendAnchor,
      consumes: true,
    });
    specs.push({
      date,
      position: "double-feature-2",
      role: "weekend-closer",
      anchor: programming.weekendAnchor,
      consumes: true,
    });
  }
  return specs;
}

/**
 * Position of a consuming airing inside its week, or -1 when it consumes none.
 */
function indexWithinWeek(date: string, position: MoviePosition): number {
  const day = weekday(date);
  return consumingSlotsInWeek.findIndex(
    (slot) => slot.day === day && slot.position === position,
  );
}

/**
 * How many movies this airing is past the epoch, as a pure calendar function.
 *
 * Deriving the ordinal from the date rather than from a stored counter is what
 * makes previews and out-of-order generation free: whoever asks, whenever they
 * ask, the same date and position name the same ordinal and therefore the same
 * movie.
 */
export function rotationOrdinal(
  epochDate: string,
  date: string,
  position: MoviePosition,
): number {
  const withinWeek = indexWithinWeek(date, position);
  if (withinWeek < 0)
    throw new Error(`${date} ${position} does not consume a rotation slot`);
  const weeks = Math.round(
    calendarDate(movieWeekStart(date)).diff(
      calendarDate(movieWeekStart(epochDate)),
      "days",
    ).days / 7,
  );
  return weeks * consumingSlotsInWeek.length + withinWeek;
}

/** The movie one consuming airing draws, given the persisted order. */
export function rotationMediaId(
  rotation: MovieRotationRecord,
  date: string,
  position: MoviePosition,
): string | undefined {
  const length = rotation.order.length;
  if (!length) return undefined;
  const ordinal = rotationOrdinal(rotation.epochDate, date, position);
  return rotation.order[((ordinal % length) + length) % length];
}

export function isMovieProgrammingEnabled(
  channel: { movieProgramming?: MovieProgramming },
): boolean {
  return channel.movieProgramming?.enabled === true;
}
