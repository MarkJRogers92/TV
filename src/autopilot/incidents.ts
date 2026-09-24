/**
 * Durable incident log (R17).
 *
 * The watchdog and the recovery dispatcher already decide things — buffered
 * idle, an incident, a dispatched repair, a suppressed retry — but only as
 * transient log lines. R17 asks for "the last real error, the current recovery
 * action, and 24-hour starts/failures/automatic recoveries with defined
 * denominators", which needs those decisions to survive a restart.
 *
 * Each enabled channel keeps a bounded ring of its own recent incidents in the
 * settings store, so the log is local, per-channel, and cannot grow without
 * bound. It records operational facts only — channel, kind, reason, time — never
 * prompt text, media bytes, or credentials.
 */
import type { Repositories } from "../db/repositories.js";

export type IncidentKind = "incident" | "dispatched" | "suppressed" | "recovered";

export type IncidentEvent = {
  at: string;
  channelId: string;
  kind: IncidentKind;
  reason: string;
};

/** Newest events kept per channel; older ones are dropped. */
export const INCIDENT_RING = 200;

const key = (channelId: string) => `incidents:${channelId}`;

export function recordIncident(
  repositories: Repositories,
  event: IncidentEvent,
): void {
  const previous = listIncidents(repositories, event.channelId);
  const next = [...previous, event].slice(-INCIDENT_RING);
  repositories.settings.put(key(event.channelId), next);
}

export function listIncidents(
  repositories: Repositories,
  channelId: string,
): IncidentEvent[] {
  const value = repositories.settings.get(key(channelId))?.value;
  return Array.isArray(value) ? (value as IncidentEvent[]) : [];
}

export function recentIncidents(
  repositories: Repositories,
  channelId: string,
  windowMs: number,
  now: Date = new Date(),
): IncidentEvent[] {
  const since = now.getTime() - windowMs;
  return listIncidents(repositories, channelId).filter(
    (event) => Date.parse(event.at) >= since,
  );
}

/**
 * Counts over a window, with defined denominators: `incidents` are confirmed
 * faults, `dispatched` are automatic repairs attempted, `suppressed` are
 * attempts the circuit breaker held back, and `recovered` are repairs that
 * returned to healthy.
 */
export function incidentCounts(
  repositories: Repositories,
  channelId: string,
  windowMs: number,
  now: Date = new Date(),
): { incidents: number; dispatched: number; suppressed: number; recovered: number } {
  const events = recentIncidents(repositories, channelId, windowMs, now);
  return {
    incidents: events.filter((event) => event.kind === "incident").length,
    dispatched: events.filter((event) => event.kind === "dispatched").length,
    suppressed: events.filter((event) => event.kind === "suppressed").length,
    recovered: events.filter((event) => event.kind === "recovered").length,
  };
}
