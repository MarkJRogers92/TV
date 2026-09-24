import { z } from "zod";

/** Stable filesystem facts captured before work is queued or accepted. */
export const preparationSourceVersionSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.string().regex(/^\d+$/),
  modifiedMs: z.string().min(1),
  deviceId: z.string().optional(),
  inode: z.string().optional(),
});
export type PreparationSourceVersion = z.infer<typeof preparationSourceVersionSchema>;

export const preparationClassifications = [
  "ready_original",
  "needs_remux",
  "needs_normalize",
  "quarantined",
  "unavailable",
] as const;
export type PreparationClassification = (typeof preparationClassifications)[number];
export type PreparationFailureKind =
  | "source_unavailable"
  | "decode_corruption"
  | "processing_error";
export type PreparationJobState = "queued" | "running" | "completed" | "failed" | "stale";

export const preparationIntakeSchema = z.object({
  id: z.string().min(1),
  sourceMediaId: z.string().min(1),
  source: preparationSourceVersionSchema,
  sourceVersionKey: z.string().min(1),
  firstObservedAt: z.string().min(1),
  lastObservedAt: z.string().min(1),
  observationCount: z.number().int().positive(),
  settledAt: z.string().nullable(),
});
export type PreparationIntake = z.infer<typeof preparationIntakeSchema>;

export const preparationJobSchema = z.object({
  id: z.string().min(1),
  intakeId: z.string().min(1),
  sourceMediaId: z.string().min(1),
  source: preparationSourceVersionSchema,
  sourceVersionKey: z.string().min(1),
  state: z.enum(["queued", "running", "completed", "failed", "stale"]),
  attempt: z.number().int().nonnegative(),
  classification: z.enum(preparationClassifications).nullable(),
  failureKind: z.enum(["source_unavailable", "decode_corruption", "processing_error"]).nullable(),
  failureDetail: z.string().nullable(),
  metadataEvidence: z.unknown().nullable(),
  sampleEvidence: z.unknown().nullable(),
  fullDecodeEvidence: z.unknown().nullable(),
  airingEvidence: z.unknown().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type PreparationJob = z.infer<typeof preparationJobSchema>;
