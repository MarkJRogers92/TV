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
 * It performs no scheduling; the URL is a seam so the Tunarr integration stays
 * out of this module. The one thing it remembers is when its last pass ended,
 * so it can tell when the machine slept and resync the channels (see below).
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
  /**
   * Ends a channel's producer session so the next request starts a fresh one
   * at the lineup's wall-clock position. Called for every channel after the
   * machine sleeps; absent means sleep is only reported.
   */
  resetSession?: (channelId: string) => Promise<void>;
  /** A pass this much later than scheduled means the machine was asleep. */
  wakeGapMs?: number;
  now?: () => number;
  onWake?: (gapMs: number) => void;
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
  // A restarted Tunarr drops every producer session. Check often enough to
  // restore them promptly without polling anywhere near the 4-second segment
  // cadence. The request is idempotent for sessions that are already running.
  const intervalMs = options.intervalMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const onResult = options.onResult ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  const wakeGapMs = options.wakeGapMs ?? 120_000;
  const now = options.now ?? (() => Date.now());
  // Timers do not fire while the Mac sleeps, and Tunarr's producers freeze
  // with them. On wake they resume from where they stopped, so every channel
  // airs behind its schedule by the length of the sleep (2026-09-29: about 90
  // minutes after a 98-minute sleep) while its segments look perfectly
  // healthy. A pass that arrives far later than scheduled is the sign.
  let lastPassEndedAt: number | undefined;
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
    const startedAt = now();
    const lateByMs =
      lastPassEndedAt === undefined
        ? 0
        : startedAt - lastPassEndedAt - intervalMs;
    const woke = lateByMs > wakeGapMs;
    if (woke) options.onWake?.(lateByMs);
    for (const channel of repositories.channels.list()) {
      if (!channel.enabled) continue;
      const url = options.resolveStreamUrl(channel.id);
      if (!url) continue;
      if (woke && options.resetSession) {
        try {
          await options.resetSession(channel.id);
        } catch (error) {
          onError(error, channel.id);
        }
      }
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { "user-agent": "marktv-always-on/1.0" },
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
        lastPassEndedAt = now();
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
