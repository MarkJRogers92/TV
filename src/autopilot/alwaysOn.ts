/**
 * Always-on supervisor (R01).
 *
 * Tunarr does not start a channel at boot; a session is created on first
 * request and, for a channel that is NOT on-demand, then persists and keeps
 * producing with no viewers. The missing piece is therefore only the START.
 *
 * This is the "narrowly scoped supervisor" the handoff asks for, not a polling
 * loop that races itself: it requests each enabled channel's master playlist on
 * a slow cadence, and Tunarr's own `getOrCreateSession` makes that idempotent —
 * a channel already producing just returns its existing session, so a repeat
 * request can never create a second producer. The cadence exists only to
 * re-start a session that was lost (e.g. after a Tunarr restart).
 *
 * It performs no scheduling and holds no state; the URL is a seam so the
 * Tunarr integration stays out of this module.
 */
import type { Repositories } from "../db/repositories.js";

export type AlwaysOnOptions = {
  /** The channel's master playlist URL, or null when the channel has no mapping. */
  resolveStreamUrl: (channelId: string) => string | null;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  onResult?: (channelId: string, ok: boolean, status: number) => void;
  onError?: (error: unknown, channelId?: string) => void;
};

export type AlwaysOnSupervisor = {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
};

export function createAlwaysOnSupervisor(
  repositories: Repositories,
  options: AlwaysOnOptions,
): AlwaysOnSupervisor {
  const intervalMs = options.intervalMs ?? 120_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const onResult = options.onResult ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping = false;
  let started = false;

  const schedule = (delay = intervalMs) => {
    if (stopping || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, delay);
    timer.unref();
  };

  const runPass = async () => {
    for (const channel of repositories.channels.list()) {
      if (!channel.enabled) continue;
      const url = options.resolveStreamUrl(channel.id);
      if (!url) continue;
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        // Drain and discard; we only need the request to have reached Tunarr.
        await response.arrayBuffer().catch(() => undefined);
        onResult(channel.id, response.ok, response.status);
      } catch (error) {
        onError(error, channel.id);
      }
    }
  };

  const runOnce = async () => {
    if (stopping) return;
    if (inFlight) return inFlight;
    inFlight = runPass()
      .catch((error) => onError(error))
      .finally(() => {
        inFlight = undefined;
        if (started && !stopping) schedule();
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
