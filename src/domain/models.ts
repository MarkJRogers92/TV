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
          offsetMs: z.number().int().positive(),
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
