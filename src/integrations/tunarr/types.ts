import { z } from "zod";

export const versionSchema = z
  .object({ tunarr: z.string().min(1), ffmpeg: z.string(), nodejs: z.string() })
  .passthrough();
const healthCheckSchema = z.union([
  z.object({ type: z.literal("healthy") }),
  z.object({
    type: z.enum(["info", "warning", "error"]),
    context: z.string(),
  }),
]);
export const healthSchema = z.record(z.string(), healthCheckSchema);
export const contentSchema = z
  .object({
    type: z.literal("content"),
    id: z.string(),
    duration: z.number().nonnegative(),
    startOffsetMs: z.number().nonnegative().optional(),
  })
  .passthrough();
export const flexSchema = z
  .object({
    type: z.literal("flex"),
    duration: z.number().positive(),
    fillerConfig: z
      .object({
        fillerListIds: z.array(z.uuid()).optional(),
        fillerRepeatCooldownMs: z.number().nonnegative().optional(),
        fillerListCooldownOverrides: z
          .record(z.string(), z.number().nonnegative())
          .optional(),
        origin: z.enum(["flex", "midroll"]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const localLocationSchema = z.object({
  type: z.literal("local"),
  path: z.string(),
});
const remoteLocationSchema = z
  .object({ type: z.literal("remote"), path: z.string() })
  .passthrough();
/**
 * Tunarr's own verdict on whether a program can be played.
 *
 * A library program whose file has been renamed or deleted is still listed by
 * `GET /api/media-libraries/:libraryId/programs`, and it still carries the
 * absolute path MarkTV matches on - which is exactly why it has to survive
 * parsing. Tunarr has declared this as `state: "missing"` on the program, and
 * has exposed the same fields on the nested terminal program or its media item
 * on other builds, so all three places are kept.
 */
const programAvailabilitySchema = {
  state: z.string().optional(),
  available: z.boolean().optional(),
};
const terminalProgramSchema = z
  .object({
    uuid: z.uuid(),
    externalId: z.string().optional(),
    sourceType: z.string().optional(),
    ...programAvailabilitySchema,
    mediaItem: z
      .object({
        ...programAvailabilitySchema,
        locations: z.array(
          z.union([localLocationSchema, remoteLocationSchema]),
        ),
      })
      .optional(),
  })
  .passthrough();
const customLineupSchema = z
  .object({
    type: z.literal("custom"),
    duration: z.number().positive(),
    id: z.string(),
    customShowId: z.string(),
    index: z.number(),
  })
  .passthrough();
const fillerLineupSchema = z
  .object({
    type: z.literal("filler"),
    duration: z.number().positive(),
    id: z.uuid(),
    fillerListId: z.uuid(),
  })
  .passthrough();
const redirectLineupSchema = z
  .object({
    type: z.literal("redirect"),
    duration: z.number().positive(),
    channel: z.string(),
    channelNumber: z.number(),
    channelName: z.string(),
  })
  .passthrough();
export const programmingSchema = z
  .object({
    totalPrograms: z.number(),
    programs: z.record(
      z.string(),
      z.lazy(() => programSchema),
    ),
    lineup: z.array(
      z.union([
        contentSchema,
        flexSchema,
        customLineupSchema,
        fillerLineupSchema,
        redirectLineupSchema,
      ]),
    ),
    startTimeOffsets: z.array(z.number()),
    schedule: z.unknown().optional(),
  })
  .passthrough();
export const programSchema = z
  .object({
    type: z.literal("content"),
    id: z.string(),
    duration: z.number().nonnegative(),
    program: terminalProgramSchema,
  })
  .passthrough();
export const customProgramSchema = z
  .object({
    type: z.literal("custom"),
    id: z.string(),
    duration: z.number().positive(),
    customShowId: z.string(),
    index: z.number(),
    program: programSchema.optional(),
  })
  .passthrough();
export const fillerProgramSchema = z.discriminatedUnion("type", [
  programSchema,
  customProgramSchema,
]);
export const fillerListSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentCount: z.number(),
});
export const transcodeConfigSchema = z
  .object({ id: z.string(), name: z.string().optional() })
  .passthrough();
export const channelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    number: z.number(),
    duration: z.number(),
    groupTitle: z.string(),
    guideMinimumDuration: z.number(),
    icon: z.object({
      path: z.string(),
      width: z.number().nonnegative(),
      duration: z.number(),
      position: z.enum([
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
      ]),
    }),
    startTime: z.number(),
    stealth: z.boolean(),
    offline: z.object({ mode: z.enum(["pic", "clip"]) }).passthrough(),
    onDemand: z.object({ enabled: z.boolean() }),
    streamMode: z.enum([
      "hls",
      "hls_slower",
      "mpegts",
      "hls_direct",
      "hls_direct_v2",
    ]),
    transcodeConfigId: z.uuid(),
    disableFillerOverlay: z.boolean(),
    subtitlesEnabled: z.boolean(),
    programCount: z.number(),
  })
  .passthrough();
export const createdFillerSchema = z.object({ id: z.string() }).passthrough();
/**
 * One of Tunarr's live sessions.
 *
 * The channel identity is read defensively: Tunarr has exposed it as a nested
 * channel object on some versions and as a bare id on others, and a session
 * whose channel cannot be attributed is counted rather than ignored by the
 * sync guard (refusing a safe sync is recoverable; interrupting a viewer is
 * not).
 */
export const mediaSessionSchema = z
  .object({
    numConnections: z.number().nonnegative().optional(),
    /**
     * Who is holding this session. Read so the sync guard can tell a person
     * watching from this deployment's own automation, which reads the same
     * channel over HTTP and is registered by Tunarr as a session just the same.
     */
    connections: z
      .array(z.object({ userAgent: z.string().optional() }).passthrough())
      .optional(),
    channelId: z.string().optional(),
    channel_id: z.string().optional(),
    channel: z
      .union([
        z.string(),
        // The id is optional so a differently-shaped channel object still counts
        // as an unattributed session rather than failing the whole list.
        z.object({ id: z.string().optional() }).passthrough(),
      ])
      .optional(),
  })
  .passthrough();

export type TunarrCapabilities = {
  url: string;
  version: string;
  healthy: boolean;
  supportsChannels: boolean;
  supportsFillerLists: boolean;
  supportsTranscodeConfigs: boolean;
  supportsInventory: boolean;
  supportsProgramming: boolean;
};
export type TunarrContentProgram = z.infer<typeof fillerProgramSchema>;
export type TunarrInventory = Array<{
  id: string;
  path: string;
  program: TunarrContentProgram;
}>;
export type TunarrProgramming = z.infer<typeof programmingSchema>;
export type TunarrLineup = TunarrProgramming["lineup"];
export type TunarrChannel = z.infer<typeof channelSchema>;
export type TunarrFillerList = z.infer<typeof fillerListSchema>;
export type TunarrTranscodeConfig = z.infer<typeof transcodeConfigSchema>;
export type TunarrMediaSession = z.infer<typeof mediaSessionSchema>;
export type TunarrSnapshots = {
  channels: TunarrChannel[];
  fillerLists: TunarrFillerList[];
  fillerPrograms: Record<string, TunarrContentProgram[]>;
  transcodeConfigs: TunarrTranscodeConfig[];
  programming?: TunarrProgramming;
};
export type TunarrMappingInput = {
  /** Update one prepared day, retaining the surrounding imported lineup. */
  preserveExistingLineup?: boolean;
  libraryId: string;
  libraryIds?: string[];
  channelId?: string;
  fillerListId?: string;
  createChannel: boolean;
  transcodeConfigId?: string;
};

export function normalizeLibraryIds(ids: unknown): string[] {
  const list = Array.isArray(ids)
    ? ids
    : ids === undefined || ids === null
      ? []
      : [ids];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function resolveLibraryIds(
  input: { libraryId?: unknown; libraryIds?: unknown } | null | undefined,
): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as { libraryId?: unknown; libraryIds?: unknown };
  const canonical = normalizeLibraryIds(record.libraryIds);
  const legacy = normalizeLibraryIds(record.libraryId);
  if (!canonical.length) return legacy;
  if (!legacy.length) return canonical;
  const seen = new Set(canonical);
  const out = [...canonical];
  for (const id of legacy) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
export type TunarrSnapshotResult = {
  capabilities: TunarrCapabilities;
  inventory: TunarrInventory;
  snapshots: TunarrSnapshots;
};

export function tunarrError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
