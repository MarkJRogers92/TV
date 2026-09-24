import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MarkTvDatabase } from "../db/database.js";
import {
  preparationIntakeSchema,
  preparationJobSchema,
  preparationSourceVersionSchema,
  type PreparationClassification,
  type PreparationFailureKind,
  type PreparationIntake,
  type PreparationJob,
  type PreparationSourceVersion,
} from "./models.js";

export const PREPARATION_SETTLE_MS = 60_000;

export type PreparationEvidence = Partial<Pick<PreparationJob,
  "metadataEvidence" | "sampleEvidence" | "fullDecodeEvidence" | "airingEvidence"
>>;

export type PreparationRepository = {
  observe(
    input: { sourceMediaId: string; source: PreparationSourceVersion; observedAt: string },
    options?: { outputDirectories?: readonly string[] },
  ): { kind: "ignored" | "observed" | "settled"; intake?: PreparationIntake; job?: PreparationJob };
  intakes: { list(): PreparationIntake[]; get(id: string): PreparationIntake | undefined };
  jobs: { list(): PreparationJob[]; get(id: string): PreparationJob | undefined };
  /** Caller owns serial execution and supplies a fresh stat for each candidate. */
  claimNext(readCurrentSource: (path: string) => PreparationSourceVersion | null, now?: string): PreparationJob | undefined;
  recordEvidence(id: string, evidence: PreparationEvidence, currentSource: PreparationSourceVersion | null, now?: string): { kind: "recorded" | "stale" | "not-running" };
  complete(
    id: string,
    result: PreparationEvidence & { classification: PreparationClassification; failureKind?: PreparationFailureKind; failureDetail?: string | null },
    currentSource: PreparationSourceVersion | null,
    now?: string,
  ): { kind: "completed" | "stale" | "not-running" };
  fail(id: string, detail: string, now?: string): boolean;
  retry(id: string, currentSource: PreparationSourceVersion | null, now?: string): { kind: "queued" | "stale" | "not-retryable" | "not-found" };
  /** Call once on process startup; preserves attempt count and result provenance. */
  recoverInterrupted(now?: string): number;
};

function versionKey(source: PreparationSourceVersion): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function idFor(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex")}`;
}

function parsed<T>(row: { json: string } | undefined, schema: { parse(value: unknown): T }): T | undefined {
  return row ? schema.parse(JSON.parse(row.json)) : undefined;
}

function normalizeSource(source: PreparationSourceVersion): PreparationSourceVersion {
  const validated = preparationSourceVersionSchema.parse(source);
  if (!isAbsolute(validated.path)) throw new TypeError("Preparation source path must be absolute");
  return { ...validated, path: resolve(validated.path) };
}

function isInside(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

const temporarySuffix = /(?:\.part|\.partial|\.tmp|\.temp|\.download|\.crdownload|\.!ut)$/i;

export function isPreparationCandidate(path: string, outputDirectories: readonly string[] = []): boolean {
  const absolute = resolve(path);
  const name = absolute.slice(absolute.lastIndexOf(sep) + 1);
  if (!name || name.startsWith(".") || temporarySuffix.test(name)) return false;
  return !outputDirectories.some((directory) => isInside(absolute, resolve(directory)));
}

function sameVersion(left: PreparationSourceVersion, right: PreparationSourceVersion | null): boolean {
  if (!right) return false;
  const normalized = normalizeSource(right);
  return left.path === normalized.path && left.sizeBytes === normalized.sizeBytes &&
    left.modifiedMs === normalized.modifiedMs && left.deviceId === normalized.deviceId && left.inode === normalized.inode;
}

export function createPreparationRepository(database: MarkTvDatabase): PreparationRepository {
  const intakeGet = database.prepare("SELECT json FROM preparation_intakes WHERE id = ?");
  const intakeUpsert = database.prepare(`INSERT INTO preparation_intakes
    (id, source_media_id, source_path, source_version_key, first_observed_at, last_observed_at, observation_count, settled_at, json)
    VALUES (@id, @sourceMediaId, @sourcePath, @sourceVersionKey, @firstObservedAt, @lastObservedAt, @observationCount, @settledAt, @json)
    ON CONFLICT(id) DO UPDATE SET last_observed_at=excluded.last_observed_at,
      observation_count=excluded.observation_count, settled_at=excluded.settled_at, json=excluded.json`);
  const jobGet = database.prepare("SELECT json FROM preparation_jobs WHERE id = ?");
  const jobUpsert = database.prepare(`INSERT INTO preparation_jobs
    (id, intake_id, source_media_id, source_path, source_version_key, state, created_at, updated_at, json)
    VALUES (@id, @intakeId, @sourceMediaId, @sourcePath, @sourceVersionKey, @state, @createdAt, @updatedAt, @json)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, json=excluded.json`);

  const saveIntake = (intake: PreparationIntake) => {
    const value = preparationIntakeSchema.parse(intake);
    intakeUpsert.run({ id: value.id, sourceMediaId: value.sourceMediaId, sourcePath: value.source.path,
      sourceVersionKey: value.sourceVersionKey, firstObservedAt: value.firstObservedAt,
      lastObservedAt: value.lastObservedAt, observationCount: value.observationCount,
      settledAt: value.settledAt, json: JSON.stringify(value) });
    return value;
  };
  const saveJob = (job: PreparationJob) => {
    const value = preparationJobSchema.parse(job);
    jobUpsert.run({ id: value.id, intakeId: value.intakeId, sourceMediaId: value.sourceMediaId,
      sourcePath: value.source.path, sourceVersionKey: value.sourceVersionKey, state: value.state,
      createdAt: value.createdAt, updatedAt: value.updatedAt, json: JSON.stringify(value) });
    return value;
  };
  const jobFrom = (row: { json: string } | undefined) => parsed(row, preparationJobSchema);
  const intakeFrom = (row: { json: string } | undefined) => parsed(row, preparationIntakeSchema);
  const invalidate = (job: PreparationJob, unavailable: boolean, now: string) => saveJob({
    ...job, state: "stale", classification: unavailable ? "unavailable" : null,
    failureKind: unavailable ? "source_unavailable" : null,
    failureDetail: unavailable ? "Source is unavailable at its recorded path" : null,
    metadataEvidence: null, sampleEvidence: null, fullDecodeEvidence: null, airingEvidence: null,
    updatedAt: now,
  });

  const observe = database.transaction((input: { sourceMediaId: string; source: PreparationSourceVersion; observedAt: string }, options?: { outputDirectories?: readonly string[] }) => {
    if (!input.sourceMediaId.trim()) throw new TypeError("sourceMediaId is required");
    const source = normalizeSource(input.source);
    if (!isPreparationCandidate(source.path, options?.outputDirectories)) return { kind: "ignored" as const };
    const timestamp = Date.parse(input.observedAt);
    if (!Number.isFinite(timestamp)) throw new TypeError("observedAt must be a valid timestamp");
    const key = versionKey(source);
    const intakeId = idFor("preparation-intake", `${input.sourceMediaId}\u001f${key}`);
    const existing = intakeFrom(intakeGet.get(intakeId) as { json: string } | undefined);
    const intake: PreparationIntake = existing
      ? { ...existing, observationCount: existing.observationCount + 1,
          lastObservedAt: input.observedAt,
          settledAt: existing.settledAt ?? (existing.observationCount >= 1 && timestamp - Date.parse(existing.firstObservedAt) >= PREPARATION_SETTLE_MS ? input.observedAt : null) }
      : { id: intakeId, sourceMediaId: input.sourceMediaId, source, sourceVersionKey: key,
          firstObservedAt: input.observedAt, lastObservedAt: input.observedAt, observationCount: 1, settledAt: null };
    saveIntake(intake);

    // A different observed version is a new cache key. Old work and prepared evidence
    // must not be mistaken for this source, while the logical sourceMediaId remains stable.
    const oldJobs = database.prepare("SELECT json FROM preparation_jobs WHERE source_media_id = ? AND source_version_key <> ?")
      .all(input.sourceMediaId, key) as Array<{ json: string }>;
    for (const row of oldJobs) {
      const old = preparationJobSchema.parse(JSON.parse(row.json));
      if (old.state !== "stale") invalidate(old, false, input.observedAt);
    }

    if (!intake.settledAt) return { kind: "observed" as const, intake };
    const jobId = idFor("preparation-job", `${input.sourceMediaId}\u001f${key}`);
    const existingJob = jobFrom(jobGet.get(jobId) as { json: string } | undefined);
    const job = existingJob ?? saveJob({
      id: jobId, intakeId, sourceMediaId: input.sourceMediaId, source, sourceVersionKey: key,
      state: "queued", attempt: 0, classification: null, failureKind: null, failureDetail: null,
      metadataEvidence: null, sampleEvidence: null, fullDecodeEvidence: null, airingEvidence: null,
      createdAt: input.observedAt, updatedAt: input.observedAt,
    });
    return { kind: "settled" as const, intake, job };
  });

  return {
    observe,
    intakes: {
      list: () => (database.prepare("SELECT json FROM preparation_intakes ORDER BY first_observed_at, id").all() as Array<{ json: string }>).map((row) => preparationIntakeSchema.parse(JSON.parse(row.json))),
      get: (id: string) => intakeFrom(intakeGet.get(id) as { json: string } | undefined),
    },
    jobs: {
      list: () => (database.prepare("SELECT json FROM preparation_jobs ORDER BY created_at, id").all() as Array<{ json: string }>).map((row) => preparationJobSchema.parse(JSON.parse(row.json))),
      get: (id: string) => jobFrom(jobGet.get(id) as { json: string } | undefined),
    },
    claimNext: (readCurrentSource, now = new Date().toISOString()) => database.transaction(() => {
      // One durable running claim is the serialization seam, even if two future
      // callers race to drive the queue from separate loops or processes.
      if (database.prepare("SELECT 1 FROM preparation_jobs WHERE state = 'running' LIMIT 1").get()) return undefined;
      const rows = database.prepare("SELECT json FROM preparation_jobs WHERE state = 'queued' ORDER BY created_at, id").all() as Array<{ json: string }>;
      for (const row of rows) {
        const job = preparationJobSchema.parse(JSON.parse(row.json));
        const current = readCurrentSource(job.source.path);
        if (!sameVersion(job.source, current)) {
          invalidate(job, current === null, now);
          continue;
        }
        return saveJob({ ...job, state: "running", attempt: job.attempt + 1, updatedAt: now });
      }
      return undefined;
    })(),
    recordEvidence: (id, evidence, currentSource, now = new Date().toISOString()) => database.transaction(() => {
      const job = jobFrom(jobGet.get(id) as { json: string } | undefined);
      if (!job || job.state !== "running") return { kind: "not-running" as const };
      if (!sameVersion(job.source, currentSource)) { invalidate(job, currentSource === null, now); return { kind: "stale" as const }; }
      saveJob({ ...job, ...evidence, updatedAt: now });
      return { kind: "recorded" as const };
    })(),
    complete: (id, result, currentSource, now = new Date().toISOString()) => database.transaction(() => {
      const job = jobFrom(jobGet.get(id) as { json: string } | undefined);
      if (!job || job.state !== "running") return { kind: "not-running" as const };
      if (!sameVersion(job.source, currentSource)) { invalidate(job, currentSource === null, now); return { kind: "stale" as const }; }
      if (result.classification === "unavailable" && result.failureKind !== "source_unavailable") throw new TypeError("Unavailable results require source_unavailable failure kind");
      if (result.classification === "quarantined" && result.failureKind !== "decode_corruption") throw new TypeError("Quarantined results require decode_corruption failure kind");
      if (result.classification !== "unavailable" && result.classification !== "quarantined" && result.failureKind) throw new TypeError("Only unavailable or quarantined results may carry a failure kind");
      saveJob({ ...job, ...result, state: "completed", failureKind: result.failureKind ?? null,
        failureDetail: result.failureDetail ?? null, updatedAt: now });
      return { kind: "completed" as const };
    })(),
    fail: (id, detail, now = new Date().toISOString()) => database.transaction(() => {
      const job = jobFrom(jobGet.get(id) as { json: string } | undefined);
      if (!job || job.state !== "running") return false;
      saveJob({ ...job, state: "failed", classification: null, failureKind: "processing_error", failureDetail: detail,
        metadataEvidence: null, sampleEvidence: null, fullDecodeEvidence: null, airingEvidence: null, updatedAt: now });
      return true;
    })(),
    retry: (id, currentSource, now = new Date().toISOString()) => database.transaction(() => {
      const job = jobFrom(jobGet.get(id) as { json: string } | undefined);
      if (!job) return { kind: "not-found" as const };
      if (job.state !== "failed" && job.state !== "stale") return { kind: "not-retryable" as const };
      if (!sameVersion(job.source, currentSource)) { invalidate(job, currentSource === null, now); return { kind: "stale" as const }; }
      saveJob({ ...job, state: "queued", classification: null, failureKind: null, failureDetail: null,
        metadataEvidence: null, sampleEvidence: null, fullDecodeEvidence: null, airingEvidence: null, updatedAt: now });
      return { kind: "queued" as const };
    })(),
    recoverInterrupted: (now = new Date().toISOString()) => database.prepare("SELECT json FROM preparation_jobs WHERE state = 'running'").all()
      .map((row: unknown) => {
        const job = preparationJobSchema.parse(JSON.parse((row as { json: string }).json));
        saveJob({ ...job, state: "queued", classification: null, failureKind: null, failureDetail: null,
          metadataEvidence: null, sampleEvidence: null, fullDecodeEvidence: null, airingEvidence: null, updatedAt: now });
        return job.id;
      }).length,
  };
}
