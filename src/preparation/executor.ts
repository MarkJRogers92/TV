import type { Repositories } from "../db/repositories.js";
import type { PreparationSourceVersion } from "./models.js";
import { collectPreflightEvidence, type PreflightEvidence, type PreflightLevel } from "./preflight.js";
import type { PreparationObserver } from "./events.js";
import type { PreparationClassification } from "./models.js";
import { readSourceVersionSync } from "./sourceVersion.js";

/** A finalising preflight depth. `metadata` alone is not enough to classify a source. */
export type ExecutorLevel = Exclude<PreflightLevel, "metadata">;

export type PreparationExecutorOptions = {
  intervalMs?: number;
  /** Preflight depth to request. Conversion is not implemented, so this only grades evidence. */
  level?: ExecutorLevel;
  now?: () => Date;
  collect?: typeof collectPreflightEvidence;
  readSource?: (path: string) => PreparationSourceVersion | null;
  onError?: (error: unknown) => void;
  onEvent?: PreparationObserver;
};

export type PreparationExecutor = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for deterministic tests and controlled maintenance runs. */
  runOnce(): Promise<void>;
};

function safeRead(read: (path: string) => PreparationSourceVersion | null, path: string): PreparationSourceVersion | null {
  try {
    return read(path);
  } catch {
    // An unavailable volume or a file that vanished is "source unavailable",
    // which the repository records as such; it is never corruption evidence.
    return null;
  }
}

/**
 * Runs one preparation job at a time: claim, collect read-only preflight
 * evidence, and record the graded result. It never converts, moves, or rewrites
 * the original — classification is `ready_original` when the source is playable
 * as-is, `quarantined` on decode corruption, and `unavailable` when the source
 * cannot be read.
 */
export function createPreparationExecutor(
  repositories: Repositories,
  options: PreparationExecutorOptions = {},
): PreparationExecutor {
  const intervalMs = options.intervalMs ?? 30_000;
  const level = options.level ?? "sampled";
  const now = options.now ?? (() => new Date());
  const collect = options.collect ?? collectPreflightEvidence;
  const readSource = options.readSource ?? readSourceVersionSync;
  const onError = options.onError ?? (() => undefined);
  const onEvent = options.onEvent ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping = false;
  let started = false;
  let rerunRequested = false;

  const schedule = (delay = intervalMs) => {
    if (stopping || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, delay);
    timer.unref();
  };

  const finalize = (lease: { id: string; attempt: number }, evidence: PreflightEvidence, at: string) => {
    const graded = {
      metadataEvidence: evidence.metadata,
      sampleEvidence: evidence.sampledDecode,
      fullDecodeEvidence: evidence.fullDecode,
    };
    if (evidence.result === "stale_source") {
      // Hand the repository the changed version so it fences this attempt and
      // leaves the job stale; the source is a new version, not a bad one.
      return repositories.preparation.complete(lease, {
        ...graded, classification: "unavailable", failureKind: "source_unavailable",
        failureDetail: "Source changed during preflight",
      }, evidence.sourceAfter, at);
    }
    const current = safeRead(readSource, evidence.sourceBefore?.path ?? "");
    if (evidence.result === "sampled" || evidence.result === "fully_decoded") {
      return repositories.preparation.complete(lease, { ...graded, classification: "ready_original" }, current, at);
    }
    if (evidence.result === "decode_error") {
      return repositories.preparation.complete(lease, {
        ...graded, classification: "quarantined", failureKind: "decode_corruption",
        failureDetail: evidence.metadata.reason ?? evidence.sampledDecode.reason ?? evidence.fullDecode.reason ?? null,
      }, current, at);
    }
    // "unavailable" (and any unexpected metadata-only result) is not usable, but
    // it is not corruption either: record it as a source-availability failure.
    return repositories.preparation.complete(lease, {
      ...graded, classification: "unavailable", failureKind: "source_unavailable",
      failureDetail: evidence.metadata.reason ?? "source unavailable",
    }, current, at);
  };

  /** The classification a completed job carries, plus a short reason, for the event. */
  const outcomeOf = (evidence: PreflightEvidence): { classification: PreparationClassification; reason?: string } => {
    if (evidence.result === "sampled" || evidence.result === "fully_decoded") return { classification: "ready_original" };
    if (evidence.result === "decode_error") {
      return {
        classification: "quarantined",
        reason: evidence.metadata.reason ?? evidence.sampledDecode.reason ?? evidence.fullDecode.reason,
      };
    }
    return { classification: "unavailable", reason: evidence.metadata.reason ?? "source unavailable" };
  };

  const runPass = async () => {
    const at = now().toISOString();
    const claimed = repositories.preparation.claimNext((path) => safeRead(readSource, path), at);
    if (!claimed) return;
    const lease = { id: claimed.id, attempt: claimed.attempt };
    let evidence: PreflightEvidence;
    try {
      evidence = await collect(claimed.source.path, { level });
    } catch (error) {
      // An unexpected executor fault is a processing error, not a media verdict.
      const reason = error instanceof Error ? error.message : "preflight failed";
      repositories.preparation.fail(lease, reason, now().toISOString());
      onEvent({ event: "job.failed", path: claimed.source.path, reason });
      onError(error);
      return;
    }
    const completed = finalize(lease, evidence, now().toISOString());
    // A stale result is a fenced attempt, not a classification; skip the event.
    if (completed.kind === "completed") {
      onEvent({ event: "job.classified", path: claimed.source.path, ...outcomeOf(evidence) });
    }
  };

  const runOnce = async () => {
    if (stopping) return;
    if (inFlight) { rerunRequested = true; return inFlight; }
    inFlight = runPass().catch((error) => onError(error)).finally(() => {
      inFlight = undefined;
      if (rerunRequested && !stopping) {
        rerunRequested = false;
        schedule(0);
      } else if (started && !stopping) schedule();
    });
    return inFlight;
  };

  return {
    async start() {
      if (started || stopping) return;
      started = true;
      await runOnce();
    },
    async stop() {
      stopping = true;
      started = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
    runOnce,
  };
}
