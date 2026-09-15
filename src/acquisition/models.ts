import { z } from "zod";
import type { ProviderName, RemoteItemType } from "./providerTypes.js";

/**
 * Canonical timestamps for acquisition state. Every record that persists a
 * moment in time stores it as an ISO-8601 string so SQLite rows stay diffable
 * and comparable with the rest of the MarkTV schema.
 */
export const isoInstantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    "Timestamps must be ISO-8601 strings",
  )
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Invalid ISO-8601 timestamp",
  );

/**
 * `providerTypes.ts` owns the provider-neutral locator vocabulary; these
 * persisted enums mirror it so a record can never be stored against a provider
 * or item type the adapters cannot resolve.
 */
export const acquisitionProviders = [
  "real-debrid",
  "torbox",
] as const satisfies readonly ProviderName[];
export type AcquisitionProviderId = (typeof acquisitionProviders)[number];
export const acquisitionProviderSchema = z.enum(acquisitionProviders);

/** Item kinds a persisted locator may reference. Extend only with an adapter. */
export const acquisitionItemTypes = ["torrent"] as const satisfies readonly RemoteItemType[];
export type AcquisitionItemType = (typeof acquisitionItemTypes)[number];
export const acquisitionItemTypeSchema = z.enum(acquisitionItemTypes);

/**
 * The plan defines exactly one durable technical vocabulary, shared by Wanted
 * records and acquisition jobs, so persisted rows, the API, and the UI
 * projection cannot drift. The UI maps `waiting-provider`/`retry-wait` to
 * "Waiting for provider", `placing` to "Verifying", and permanent failures to
 * "Needs review"; `cancelled` is shown explicitly.
 */
export const technicalStates = [
  "wanted",
  "waiting-provider",
  "match-found",
  "retry-wait",
  "downloading",
  "verifying",
  "placing",
  "imported",
  "needs-review",
  "cancelled",
] as const;
export type TechnicalState = (typeof technicalStates)[number];
export const technicalStateSchema = z.enum(technicalStates);

/** Wanted-scoped alias for the shared technical vocabulary. */
export const wantedStatuses = technicalStates;
export type WantedStatus = TechnicalState;

/** Job-scoped alias for the shared technical vocabulary. */
export const acquisitionJobStates = technicalStates;
export type AcquisitionJobState = TechnicalState;

export const acquisitionReviewKinds = [
  "ambiguous",
  "season-pack",
  "multi-episode",
  "uncertain-title",
] as const;
export type AcquisitionReviewKind = (typeof acquisitionReviewKinds)[number];

/**
 * Episode identity is `normalized series title + season + episode`. The
 * normalization keeps meaningful title words while folding punctuation, case,
 * separators, and Unicode width so two spellings of one episode share a key.
 * Task 2's `identity.ts` re-exports this function as `episodeKey`.
 */
export function normalizedSeriesTitle(seriesTitle: string): string {
  return seriesTitle
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function episodeKey(
  seriesTitle: string,
  season: number,
  episode: number,
): string {
  return `${normalizedSeriesTitle(seriesTitle)}|s${season}|e${episode}`;
}

/**
 * Persisted episode keys must carry the canonical `title|sN|eN` suffix shape
 * produced by {@link episodeKey}; the referenced Wanted record is validated
 * separately so a free-form string can never become durable identity.
 */
export const episodeKeySchema = z
  .string()
  .regex(/^.*\|s\d+\|e\d+$/, "Episode keys look like `title|s1|e2`");

export const wantedEpisodeSchema = z.strictObject({
  id: z.string().min(1),
  seriesTitle: z.string().min(1),
  season: z.number().int().nonnegative(),
  episode: z.number().int().nonnegative(),
  episodeTitle: z.string().min(1).nullable().default(null),
  status: technicalStateSchema.default("wanted"),
  statusDetail: z.string().min(1).nullable().default(null),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type WantedEpisode = z.infer<typeof wantedEpisodeSchema>;

export const acquisitionJobSchema = z.strictObject({
  id: z.string().min(1),
  wantedId: z.string().min(1),
  episodeKey: episodeKeySchema,
  provider: acquisitionProviderSchema,
  remoteItemId: z.string().min(1),
  remoteFileId: z.string().min(1),
  originalFilename: z.string().min(1),
  expectedBytes: z.number().int().nonnegative().nullable().default(null),
  receivedBytes: z.number().int().nonnegative().default(0),
  state: technicalStateSchema,
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  cancelRequested: z.boolean().default(false),
  partPath: z.string().min(1).nullable().default(null),
  destinationPath: z.string().min(1).nullable().default(null),
  verifiedSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  lastError: z.string().min(1).nullable().default(null),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type AcquisitionJob = z.infer<typeof acquisitionJobSchema>;

/**
 * A persist-safe review candidate / pack-file locator. Provider and item type
 * are part of the identity because remote item/file ids are only unique inside
 * one provider: two providers can legitimately report identical ids for
 * different files, and a later manual import must re-list the exact pack from
 * the exact provider. Never add a download URL or token here.
 */
export const acquisitionReviewCandidateSchema = z.strictObject({
  provider: acquisitionProviderSchema,
  itemType: acquisitionItemTypeSchema,
  remoteItemId: z.string().min(1),
  remoteFileId: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  resolution: z.string().min(1).nullable().default(null),
  season: z.number().int().nonnegative().nullable().default(null),
  episode: z.number().int().nonnegative().nullable().default(null),
});
export type AcquisitionReviewCandidate = z.infer<
  typeof acquisitionReviewCandidateSchema
>;

export const acquisitionReviewSchema = z.strictObject({
  id: z.string().min(1),
  wantedId: z.string().min(1),
  kind: z.enum(acquisitionReviewKinds),
  message: z.string().min(1),
  /**
   * Ambiguity/multi-episode candidates for `kind: "review"`, or the whole
   * recognized eligible pack for `kind: "season-pack"` — one locator per
   * recognized single-episode file, not only the currently Wanted episodes.
   */
  candidates: z.array(acquisitionReviewCandidateSchema).default([]),
  /** Unique recognized eligible episodes in the pack, Wanted or not. */
  packEpisodeCount: z.number().int().nonnegative().nullable().default(null),
  /**
   * Required bytes for every recognized eligible file in the pack; `null`
   * when any recognized size is unknown. This preview is revalidated before
   * manual import because provider listings and duplicate state can change.
   */
  packTotalBytes: z.number().int().nonnegative().nullable().default(null),
  /**
   * Durable season-pack snapshot identity. A `kind: "season-pack"` review is a
   * durable offer whose `wantedId` is only the episode that first surfaced the
   * pack, so the offer outlives that anchor being imported or removed. The
   * stored series/season is what a later manual Import Season re-lists and
   * revalidates against safe locators; every other review kind leaves both
   * fields null.
   */
  packSeriesTitle: z.string().min(1).nullable().default(null),
  packSeason: z.number().int().nonnegative().nullable().default(null),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type AcquisitionReview = z.infer<typeof acquisitionReviewSchema>;

/**
 * Deterministic durable identity for one provider item's season-pack offer:
 * provider + item type + remote item + normalized series title + season.
 * Re-polling the same pack therefore upserts a single offer instead of
 * accumulating duplicates, and the identity does not depend on the anchor
 * Wanted row.
 */
export function seasonPackReviewId(
  provider: string,
  itemType: string,
  remoteItemId: string,
  seriesTitle: string,
  season: number,
): string {
  return [
    "season-pack",
    provider,
    itemType,
    remoteItemId,
    normalizedSeriesTitle(seriesTitle),
    `s${season}`,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export const completedImportSchema = z.strictObject({
  id: z.string().min(1),
  wantedId: z.string().min(1),
  episodeKey: episodeKeySchema,
  provider: acquisitionProviderSchema,
  remoteItemId: z.string().min(1),
  remoteFileId: z.string().min(1),
  mediaId: z.string().min(1),
  canonicalName: z.string().min(1),
  destinationPath: z.string().min(1),
  importedAt: isoInstantSchema,
});
export type CompletedImport = z.infer<typeof completedImportSchema>;
