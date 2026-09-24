import type { MarkTvDatabase } from "../db/database.js";
import {
  createAiringLedger,
  type AiringLedger,
  type AiringRefusalReason,
  type SourceInterval,
} from "./airingLedger.js";

/*
 * Producer-only continuation for one occurrence (package F09).
 *
 * A continuation offset is the end of the greatest contiguous source range
 * recorded as published for this occurrence and its reserved source media.
 * These ledger rows are not themselves proof that the underlying HLS segment
 * files remain durably deliverable or join correctly. Before using a plan to
 * drive runtime, the caller must verify retained segment availability and the
 * HLS joins at the continuation boundary. Publication does not say what a
 * viewer watched, whether an ad aired, or that an occurrence is complete from
 * a programming perspective. Those facts require separate evidence and are
 * deliberately outside this module.
 *
 * A worker exit code, playlist metadata, process/session presence, and ad
 * playout time do not contribute to source progress. With no published
 * contiguous coverage this planner refuses to resume; it never restarts at
 * source zero or advances across a gap.
 */

/** Where the producer may continue within the same occurrence. */
export type ContinuationPlan = {
  occurrenceKey: string;
  sourceMediaId: string;
  /** Next source begin: the durable contiguous published source end. */
  requestedSourceOffsetMs: number;
  sourceEndMs: number;
  /** A continuation never rewinds a durable boundary back to source zero. */
  restartAtSourceZero: false;
};

export type ContinuationPlanInput = {
  occurrenceKey: string;
};

export type ContinuationRefusalReason = AiringRefusalReason | "source-fully-published";

/** A producer-only refusal can distinguish exhausted source from aired credit. */
export type ContinuationResult<T> =
  | { ok: true; created: boolean; value: T }
  | {
      ok: false;
      reason: ContinuationRefusalReason;
      detail: string;
    };

/**
 * The greatest end such that `[startMs, end)` is fully covered by the given
 * published source intervals. Coverage is anchored at `startMs`, so the first
 * gap stops it: a later interval that does not touch `startMs` or the current
 * cursor never advances the boundary. Touching endpoints count as joined.
 */
export function durablePublishedContiguousEnd(
  intervals: ReadonlyArray<Pick<SourceInterval, "sourceStartMs" | "sourceEndMs">>,
  startMs: number,
  endMs: number,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return startMs;
  const ordered = intervals
    .map(({ sourceStartMs, sourceEndMs }) => ({ start: sourceStartMs, end: sourceEndMs }))
    .filter(
      ({ start, end }) =>
        Number.isFinite(start) && Number.isFinite(end) && end > start && end > startMs && start < endMs,
    )
    .sort((left, right) => left.start - right.start);
  let cursor = startMs;
  for (const interval of ordered) {
    if (interval.start > cursor) break;
    if (interval.end > cursor) cursor = interval.end;
    if (cursor >= endMs) return endMs;
  }
  return Math.min(cursor, endMs);
}

/**
 * Source-only producer continuation over the durable airing ledger. One
 * instance wraps one database; callers record published intervals and apply
 * the resulting plan through the same connection.
 */
export function createSourceContinuation(database: MarkTvDatabase) {
  const ledger: AiringLedger = createAiringLedger(database);

  /** Durable published intervals for the occurrence's own reserved media. */
  const publishedFor = (occurrenceKey: string): SourceInterval[] => {
    const reservation = ledger.occurrence(occurrenceKey);
    if (!reservation) return [];
    return ledger
      .publishedIntervals(occurrenceKey)
      .filter((interval) => interval.sourceMediaId === reservation.sourceMediaId);
  };

  /** The durable published contiguous source end, or undefined if unknown. */
  const durablePublishedEnd = (occurrenceKey: string): number | undefined => {
    const reservation = ledger.occurrence(occurrenceKey);
    if (!reservation) return undefined;
    return durablePublishedContiguousEnd(
      publishedFor(occurrenceKey),
      reservation.sourceStartMs,
      reservation.sourceEndMs,
    );
  };

  const refusal = <T = never>(
    reason: ContinuationRefusalReason,
    detail: string,
  ): ContinuationResult<T> => ({ ok: false, reason, detail });

  /**
   * Plans the next source request for one occurrence, refusing when there is
   * no durable resume point. This tracks producer publication only; it does
   * not credit viewer playback, ad delivery, or an ad break as aired.
   */
  const planContinuation = (
    input: ContinuationPlanInput,
  ): ContinuationResult<ContinuationPlan> => {
    const reservation = ledger.occurrence(input.occurrenceKey);
    if (!reservation) {
      return refusal("unknown-occurrence", `no occurrence ${input.occurrenceKey}`);
    }
    const requestedSourceOffsetMs = durablePublishedContiguousEnd(
      publishedFor(input.occurrenceKey),
      reservation.sourceStartMs,
      reservation.sourceEndMs,
    );
    if (requestedSourceOffsetMs <= reservation.sourceStartMs) {
      return refusal(
        "insufficient-evidence",
        `no durably published contiguous source coverage for ${input.occurrenceKey}`,
      );
    }
    if (requestedSourceOffsetMs >= reservation.sourceEndMs) {
      return refusal(
        "source-fully-published",
        `source coverage already reaches the end of ${input.occurrenceKey}; no producer continuation remains`,
      );
    }
    const plan: ContinuationPlan = {
      occurrenceKey: reservation.occurrenceKey,
      sourceMediaId: reservation.sourceMediaId,
      requestedSourceOffsetMs,
      sourceEndMs: reservation.sourceEndMs,
      restartAtSourceZero: false,
    };
    return { ok: true, created: false, value: plan };
  };

  return {
    ledger,
    durablePublishedContiguousEnd,
    durablePublishedEnd,
    planContinuation,
  };
}

export type SourceContinuation = ReturnType<typeof createSourceContinuation>;
