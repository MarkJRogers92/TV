import { z } from "zod";
import { DateTime } from "luxon";

export const mediaKinds = [
  "episode",
  "movie",
  "commercial",
  "filler",
  "station-id",
  "bumper",
] as const;
export type MediaKind = (typeof mediaKinds)[number];

/**
 * Marker tag for offline-rendered, schedule-scoped continuity video.
 *
 * The tag is the contract that keeps a generated card out of ordinary filler
 * and station-ID rotation: it may only ever be placed by the continuity pass,
 * for the one completed schedule its binding names.
 */
export const scheduleScopedContinuityTag = "schedule-scoped-continuity";

const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const instantSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO instant");
export const broadcastDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => DateTime.fromISO(value, { zone: "UTC" }).isValid,
    "Invalid calendar date",
  );
const timezoneSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone");

export const mediaSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["placeholder", "local-folder"]),
  path: z.string().optional(),
  /**
   * Stable filesystem identity of the scanned file, as decimal strings.
   *
   * `stat`'s `dev`+`ino` are what survives a same-filesystem rename, so the
   * catalog can recognize a moved file as the one it already knows instead of
   * minting a second logical entry that forks its exposure history. Additive and
   * optional: entries written before this field existed, and non-local sources,
   * simply have none and are left alone by the reconciler.
   */
  deviceId: z.string().optional(),
  inode: z.string().optional(),
  fileSizeBytes: z.string().optional(),
  fileModifiedMs: z.string().optional(),
  fileBirthMs: z.string().optional(),
  /** Explicit provenance for a prepared rendition derived from another movie. */
  sourceMediaId: z.string().min(1).optional(),
  kind: z.enum(mediaKinds),
  title: z.string().min(1),
  durationMs: z.number().int().positive().nullable(),
  durationStatus: z.enum(["ok", "missing"]).default("ok"),
  showTitle: z.string().optional(),
  season: z.number().int().nonnegative().optional(),
  episode: z.number().int().nonnegative().optional(),
  available: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  tunarrProgramId: z.string().optional(),
  revision: z.string().optional(),
});
export type MediaItem = z.infer<typeof mediaSchema>;

export const poolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kinds: z.array(z.enum(mediaKinds)).min(1),
  mediaIds: z.array(z.string()),
  mode: z.enum(["chronological", "shuffle"]).default("chronological"),
  noRepeatMinutes: z.number().nonnegative().default(0),
  weight: z.number().positive().default(1),
});
export type Pool = z.infer<typeof poolSchema>;

/**
 * A channel whose lineup is a preserved import rather than a generated one.
 *
 * Some channels exist to mirror a lineup somebody else already programmed - an
 * imported movie channel whose exact film order and start instants the operator
 * approved. For those, ordinary pool selection is not a fallback but a different
 * product, so the binding below replaces generation entirely: the day is sliced
 * from an immutable normalized archive (see `src/scheduler/preservedLineup.ts`)
 * instead of being selected, and a missing, invalid, or exhausted archive fails
 * the generation closed rather than quietly airing a scheduled-from-scratch day.
 *
 * The archive itself is never stored here. This is the *binding*: it names the
 * `settings` row (`preserved-lineup:<sourceId>`) the parent writes the normalized
 * archive into, optionally pins the archive digest the channel was approved
 * against, and declares what a day past the archive's coverage may do.
 */
export const preservedLineupSourceSchema = z.object({
  /** Identity of the imported lineup; the archive lives under this key suffix. */
  sourceId: z.string().min(1),
  /**
   * Advertised archive digest.
   *
   * When set, a stored archive whose content does not hash to this value is
   * refused. The digest is also part of the generated schedule's identity, so
   * re-importing a different archive mints a different schedule revision instead
   * of silently reinterpreting the approved one.
   */
  digest: z.string().min(1).optional(),
  /**
   * What a broadcast day outside the archive's coverage means.
   *
   * `once` (the default) is fail-closed: the day is refused rather than derived
   * from anything else. `repeat` tiles the archive by its exact total span, which
   * is only useful for a deliberately looped lineup.
   */
  cycle: z.enum(["once", "repeat"]).default("once"),
});
export type PreservedLineupSource = z.infer<typeof preservedLineupSourceSchema>;

export const daypartSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  days: z.array(z.number().int().min(0).max(6)),
  start: localTimeSchema,
  end: localTimeSchema,
  priority: z.number().int(),
});
export type Daypart = z.infer<typeof daypartSchema>;

export const movieMidrollSchema = z.object({
  intervalMinutes: z.number().positive(),
  breakMinutes: z.number().positive(),
  minimumMinutes: z.number().nonnegative(),
  maxBreaks: z.number().int().nonnegative(),
  tailBufferMinutes: z.number().nonnegative().default(0),
  strategy: z.enum(["lazy", "eager"]),
});

/**
 * Break rules for the movie-programming feature.
 *
 * Deliberately its own record rather than a reuse of `movieMidrollSchema`, which
 * belongs to the scheduled movie *slots*: the feature protects the first and last
 * minutes of a feature, targets two minutes, and may never exceed the live
 * 2.5-minute sitcom policy. The break COUNT is a rule rather than a knob - three
 * for a feature up to `shortMaxMinutes`, four above it - so a configuration edit
 * cannot quietly turn a two-hour film into eleven interruptions.
 */
export const movieProgrammingBreakSchema = z.object({
  targetMinutes: z.number().positive().default(2),
  maxMinutes: z.number().positive().default(2.5),
  /** Content kept break-free at each end of the feature. */
  protectionMinutes: z.number().nonnegative().default(15),
  shortMaxMinutes: z.number().positive().default(110),
});
export type MovieProgrammingBreakPolicy = z.infer<
  typeof movieProgrammingBreakSchema
>;

/**
 * The single control for the movie-programming feature.
 *
 * Present but `enabled: false` by default, so an existing channel keeps exactly
 * the programming it has until an operator turns the feature on.
 */
export const movieProgrammingSchema = z.object({
  enabled: z.boolean().default(false),
  /** Movie pools the rotation draws from. */
  poolIds: z.array(z.string()).default([]),
  /** Absolute folder the movies are scanned from, reported by the status API. */
  rootPath: z.string().min(1).optional(),
  /**
   * Instant the feature was (re)enabled.
   *
   * A first run has no earlier weekend opener to replay, and inventing one would
   * write an airing that never happened. The scheduler uses this instant to tell
   * "the opener was scheduled under this feature" from "the feature did not exist
   * yet", so a Sunday or Monday that starts the feature draws a normal movie
   * instead of synthesising a past one. Absent on installs enabled before this
   * field existed, which keeps their linking behaviour unchanged.
   */
  activatedAt: instantSchema.optional(),
  /** Nightly feature anchor, soft within +/- 15 minutes of a program boundary. */
  nightlyAnchor: localTimeSchema.default("02:00"),
  /** Weekend double-feature anchor, soft within +/- 15 minutes. */
  weekendAnchor: localTimeSchema.default("19:00"),
  /** Pools the 60-120 second between-features bridge draws whole spots from. */
  bridgePoolIds: z.array(z.string()).default([]),
  bridgeMinSeconds: z.number().positive().default(60),
  bridgeMaxSeconds: z.number().positive().default(120),
  /** Rolling preview/coverage horizon; never shorter than a week. */
  lookaheadDays: z.number().int().min(7).max(30).default(8),
  /**
   * Whether a weekend opening film repeats in the following overnight slot.
   *
   * R05: "Sunday 2 AM repeats Saturday's opener" (and Monday repeats Sunday's) is
   * the one pre-approved ordinary-program exception. It is a visible, reversible
   * setting rather than a hidden rule; turning it off affects only uncommitted
   * future reservations.
   */
  weekendOpenerEncoreEnabled: z.boolean().default(true),
  breakPolicy: movieProgrammingBreakSchema.default({
    targetMinutes: 2,
    maxMinutes: 2.5,
    protectionMinutes: 15,
    shortMaxMinutes: 110,
  }),
});
export type MovieProgramming = z.infer<typeof movieProgrammingSchema>;

/**
 * Where a movie airing sits in the weekly movie programme.
 *
 * `encore` carries no new selection: it replays the opener of the adjacent
 * weekend double feature.
 */
export const movieRoleSchema = z.enum([
  "nightly",
  "weekend-opener",
  "weekend-closer",
  "encore",
]);
export type MovieRole = z.infer<typeof movieRoleSchema>;

/**
 * The piece of a movie programme that did not fit in one broadcast day.
 *
 * A weekend double feature is one block - opener, between-features bridge,
 * closer - but a long enough pair reaches midnight in the middle of it. The
 * schedule for the day it started in cannot hold the rest, and the next day's
 * schedule cannot always be derived from the last entry: a soft anchor means the
 * block may have started at 19:04, and a closer that could not start leaves the
 * last entry a sitcom. The state is therefore written down on the schedule that
 * owns the airing, and read back by the day that continues it.
 */
export const movieCarrySchema = z.object({
  /** Tail of a movie that stopped at the day boundary, from its source offset. */
  continuation: z
    .object({
      mediaId: z.string().min(1),
      sourceOffsetMs: z.number().int().nonnegative(),
      occurrenceKey: z.string().min(1).optional(),
      role: movieRoleSchema.optional(),
      /** The ordinary movie slot that selected a movie crossing midnight. */
      slotId: z.string().min(1).optional(),
      /** Mid-rolls still owed, measured from the carried source offset. */
      midrolls: z
        .array(
          z.object({
            offsetMs: z.number().int().nonnegative(),
            durationMs: z.number().int().positive(),
          }),
        )
        .optional(),
    })
    .optional(),
  /**
   * A double feature whose opener was interrupted: the closer is still owed, and
   * `bridgeOwed` says whether the between-features bridge has aired yet, so it is
   * never played twice and never skipped.
   */
  closer: z
    .object({
      occurrenceKey: z.string().min(1),
      mediaId: z.string().min(1),
      role: movieRoleSchema,
      encore: z.boolean(),
      bridgeOwed: z.boolean(),
    })
    .optional(),
});
export type MovieCarry = z.infer<typeof movieCarrySchema>;

export const episodeMidrollSchema = z
  .object({
    targetMinutes: z.tuple([z.number().positive(), z.number().positive()]),
    searchWindowMinutes: z.number().positive(),
    breakMinutes: z.number().positive(),
    minimumSegmentMinutes: z.number().positive(),
    tailBufferMinutes: z.number().positive(),
  })
  .superRefine((policy, context) => {
    if (policy.targetMinutes[0] >= policy.targetMinutes[1]) {
      context.addIssue({
        code: "custom",
        path: ["targetMinutes"],
        message: "Episode break targets must be unique and increasing",
      });
    }
    if (
      policy.targetMinutes[0] < policy.minimumSegmentMinutes ||
      policy.targetMinutes[1] - policy.targetMinutes[0] <
        policy.minimumSegmentMinutes
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetMinutes"],
        message: "Episode break targets must preserve minimum content segments",
      });
    }
  });
export type EpisodeMidrollPolicy = z.infer<typeof episodeMidrollSchema>;

export const slotSchema = z.object({
  id: z.string().min(1),
  daypartId: z.string().optional(),
  days: z.array(z.number().int().min(0).max(6)).default([]),
  time: localTimeSchema.optional(),
  poolIds: z.array(z.string()).min(1),
  kind: z.enum(["episode", "movie"]),
  fallbackPoolIds: z.array(z.string()).default([]),
    allowCooldownRelaxation: z.boolean().optional(),
    movieMidroll: movieMidrollSchema.optional(),
    episodeMidroll: episodeMidrollSchema.optional(),
  });
export type SlotRule = z.infer<typeof slotSchema>;

export const breakSchema = z.object({
  boundaryMinutes: z.number().int().positive().default(30),
  poolIds: z.array(z.string()).default([]),
  stationIdPoolIds: z.array(z.string()).default([]),
  cooldownMinutes: z.number().nonnegative().default(120),
});
export type BreakPolicy = z.infer<typeof breakSchema>;

export const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  number: z.number().int(),
  timezone: timezoneSchema,
  enabled: z.boolean().default(true),
  revision: z.string().default("1"),
  dayparts: z.array(daypartSchema),
  slots: z.array(slotSchema),
  movieProgramming: movieProgrammingSchema.optional(),
  /**
   * Present only on a channel that airs a preserved imported lineup.
   *
   * When set, `ScheduleService` slices the day from the bound archive instead of
   * running ordinary slot selection; the channel's dayparts/slots are then simply
   * unused by generation (the channel's own config still has to be valid enough
   * to save). Absent - the default - keeps exactly the previous behaviour for
   * every existing channel.
   */
  preservedLineup: preservedLineupSourceSchema.optional(),
  breakPolicy: breakSchema.default({
    boundaryMinutes: 30,
    poolIds: [],
    stationIdPoolIds: [],
    cooldownMinutes: 120,
  }),
});
export type Channel = z.infer<typeof channelSchema>;

export const scheduleDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  mediaId: z.string().optional(),
});
export type ScheduleDiagnostic = z.infer<typeof scheduleDiagnosticSchema>;

export const scheduleEntrySchema = z
  .object({
    id: z.string().min(1),
    start: instantSchema,
    end: instantSchema,
    localStart: localTimeSchema,
    localEnd: localTimeSchema,
    durationMs: z.number().int().positive(),
    contentDurationMs: z.number().int().positive().optional(),
    /**
     * Offset into the media file where this entry starts.
     *
     * Non-zero only for the tail of a movie that crossed a broadcast day
     * boundary: the next day's schedule continues the same source rather than
     * dropping it, and Tunarr is told where in the file to resume.
     */
    sourceOffsetMs: z.number().int().nonnegative().optional(),
    /** Which movie-programming position produced this entry, when any. */
    movieRole: movieRoleSchema.optional(),
    movieOccurrenceKey: z.string().min(1).optional(),
    kind: z.union([z.enum(mediaKinds), z.literal("flex")]),
    title: z.string().min(1),
    mediaId: z.string().optional(),
    path: z.string().optional(),
    source: z.string().optional(),
    sourceDaypartId: z.string().optional(),
    sourceSlotId: z.string().optional(),
    selectionExplanation: z.string().min(1).optional(),
    reason: z.string().optional(),
    midrolls: z
      .array(
        z.object({
          /**
           * Zero is legal for exactly one case: a movie resumed at the exact
           * offset of one of its breaks, which must air rather than be lost
           * because the previous broadcast day ended on it.
           */
          offsetMs: z.number().int().nonnegative(),
          durationMs: z.number().int().positive(),
        }),
      )
      .optional(),
  })
  .superRefine((entry, context) => {
    const actualDuration = Date.parse(entry.end) - Date.parse(entry.start);
    if (actualDuration <= 0 || actualDuration !== entry.durationMs) {
      context.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: "Entry duration must match its start and end instants",
      });
    }
    if (entry.kind !== "flex" && !entry.mediaId) {
      context.addIssue({
        code: "custom",
        path: ["mediaId"],
        message: "Program entries require a media ID",
      });
    }
    if (entry.midrolls?.length) {
      if (entry.kind !== "episode" && entry.kind !== "movie") {
        context.addIssue({
          code: "custom",
          path: ["midrolls"],
          message: "Only episode and movie entries may have mid-rolls",
        });
      }
      const breakDurationMs = entry.midrolls.reduce(
        (total, midroll) => total + midroll.durationMs,
        0,
      );
      if (
        entry.contentDurationMs !== undefined &&
        entry.contentDurationMs + breakDurationMs !== entry.durationMs
      ) {
        context.addIssue({
          code: "custom",
          path: ["durationMs"],
          message: "Mid-roll broadcast duration must equal content plus breaks",
        });
      }
      const sourceDurationMs = entry.contentDurationMs ?? entry.durationMs;
      let previousOffset = -1;
      entry.midrolls.forEach((midroll, index) => {
        if (
          midroll.offsetMs <= previousOffset ||
          midroll.offsetMs >= sourceDurationMs
        ) {
          context.addIssue({
            code: "custom",
            path: ["midrolls", index, "offsetMs"],
            message:
              "Mid-roll offsets must be unique, increasing, and inside the source content",
          });
        }
        previousOffset = midroll.offsetMs;
      });
    } else if (
      entry.contentDurationMs !== undefined &&
      entry.contentDurationMs !== entry.durationMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentDurationMs"],
        message: "Content duration may differ only when mid-rolls are present",
      });
    }
  });
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

export const scheduleSchema = z
  .object({
    id: z.string().min(1),
    channelId: z.string().min(1),
    date: broadcastDateSchema,
    timezone: timezoneSchema,
    seed: z.string().min(1),
    revision: z.string().min(1),
    generatedAt: instantSchema,
    durationMs: z.number().int().positive(),
    entries: z.array(scheduleEntrySchema).min(1),
    diagnostics: z.array(scheduleDiagnosticSchema),
    continuityBinding: z.object({
      contentHash: z.string(),
      appliedHash: z.string(),
      adjacent: z.array(z.object({ date: broadcastDateSchema, hash: z.string() })),
    }).optional(),
    /**
     * Movie programme that crossed this broadcast day's boundary.
     *
     * Persisted with the schedule rather than re-derived from its last entry: a
     * double feature interrupted at midnight leaves its closer owed, and the block
     * has to be resumed exactly where the film stopped even after a restart.
     */
    movieCarry: movieCarrySchema.optional(),
    channelName: z.string().optional(),
    channelNumber: z.number().int().optional(),
    breakPolicy: breakSchema.optional(),
  })
  .superRefine((schedule, context) => {
    for (let index = 1; index < schedule.entries.length; index += 1) {
      if (
        Date.parse(schedule.entries[index].start) <
        Date.parse(schedule.entries[index - 1].end)
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "start"],
          message: "Schedule entries must be chronological and non-overlapping",
        });
      }
    }
  });
export type Schedule = z.infer<typeof scheduleSchema>;
