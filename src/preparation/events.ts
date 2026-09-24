/**
 * Structured lifecycle events for the preparation pipeline.
 *
 * The intake scanner and the executor are background loops, so without an
 * explicit event seam their work is invisible: a file can be observed, settled,
 * queued, and classified (or quarantined) with nothing written anywhere a human
 * would look. These events are emitted through an injected observer — the app
 * wires it to `logInfo`, tests collect it — and carry the identifiers needed to
 * follow one file end to end. Nothing here performs I/O.
 */
import type { PreparationClassification } from "./models.js";

export type PreparationEvent =
  /** A new, not-yet-catalogued candidate was observed for the first time. */
  | { event: "intake.observed"; path: string; sourceMediaId: string }
  /** A candidate stayed stable for the settle window, was probed, catalogued, and queued. */
  | { event: "intake.settled"; path: string; sourceMediaId: string }
  /** A queued job was claimed, probed, and classified. */
  | {
      event: "job.classified";
      path: string;
      classification: PreparationClassification;
      reason?: string;
    }
  /** A job could not be processed at all (executor fault, not a media verdict). */
  | { event: "job.failed"; path: string; reason: string };

export type PreparationObserver = (event: PreparationEvent) => void;

/** A stable, log-friendly one-line rendering of an event. */
export function describePreparationEvent(event: PreparationEvent): {
  message: string;
  context: Record<string, unknown>;
} {
  switch (event.event) {
    case "intake.observed":
      return { message: "Intake observed new candidate", context: { path: event.path, sourceMediaId: event.sourceMediaId } };
    case "intake.settled":
      return { message: "Intake settled and queued", context: { path: event.path, sourceMediaId: event.sourceMediaId } };
    case "job.classified":
      return {
        message: "Preparation job classified",
        context: { path: event.path, classification: event.classification, ...(event.reason ? { reason: event.reason } : {}) },
      };
    case "job.failed":
      return { message: "Preparation job failed", context: { path: event.path, reason: event.reason } };
  }
}
