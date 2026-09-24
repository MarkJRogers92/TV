/**
 * Bounded, channel-scoped recovery dispatcher (Stage 4).
 *
 * It consumes the continuity classifier's verdicts and calls ONE injectable
 * action per confirmed incident, under the handoff's two hard limits:
 *
 *  - **Circuit breaker.** At most `maxAttempts` automatic attempts per channel
 *    within `windowMs` (default 2 in 10 minutes). Past that the breaker is open:
 *    the dispatcher records a suppression and stops acting, so a persistent
 *    fault cannot become a restart storm.
 *  - **Single owner per generation.** The action is only dispatched while the
 *    classifier's `recoveryActionPending` is set, and it is acknowledged (cleared)
 *    only after the action reports success — so a still-stalled channel is not
 *    re-dispatched on every sample, and a failed action leaves the incident open.
 *
 * It never restarts the shared service; the action it calls is channel-scoped by
 * construction. What the action actually does is a seam, so the scheduling of
 * recovery is tested independently of the transport it repairs.
 */
import {
  acknowledgeContinuityHealthAction,
  type ContinuityHealthResult,
  type ContinuityHealthState,
} from "./continuityHealth.js";

export type RecoveryOutcome = "no-action" | "dispatched" | "suppressed";

export type ChannelRecoveryLimits = { maxAttempts?: number; windowMs?: number };

export type ChannelRecovery = {
  /**
   * Feed one classifier result. Returns the state the caller must persist and
   * pass to the NEXT classifier call: an acknowledged state once an action was
   * dispatched, otherwise the classifier's own state unchanged. The caller owns
   * the state; the dispatcher must not keep a second copy of it.
   */
  handle(
    result: ContinuityHealthResult,
  ): Promise<{ outcome: RecoveryOutcome; state: ContinuityHealthState }>;
  stateFor(channelId: string): ContinuityHealthState | undefined;
  attemptsInWindow(channelId: string): number;
};

export function createChannelRecovery(options: {
  /** The channel-scoped repair. Returns true only when it was dispatched. */
  recover: (channelId: string, recommendation: string) => Promise<boolean>;
  now?: () => number;
  limits?: ChannelRecoveryLimits;
  onDecision?: (channelId: string, outcome: RecoveryOutcome, reason: string) => void;
}): ChannelRecovery {
  const maxAttempts = options.limits?.maxAttempts ?? 2;
  const windowMs = options.limits?.windowMs ?? 10 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const states = new Map<string, ContinuityHealthState>();
  const attempts = new Map<string, number[]>();

  const recent = (channelId: string) =>
    (attempts.get(channelId) ?? []).filter((at) => now() - at < windowMs);

  return {
    stateFor: (channelId) => states.get(channelId),
    attemptsInWindow: (channelId) => recent(channelId).length,
    async handle(result) {
      const settle = (outcome: RecoveryOutcome, state: ContinuityHealthState) => {
        states.set(result.channelId, state);
        return { outcome, state };
      };
      if (
        !result.incident ||
        result.recommendation === "none" ||
        !result.state.recoveryActionPending
      ) {
        options.onDecision?.(result.channelId, "no-action", result.health);
        return settle("no-action", result.state);
      }
      const history = recent(result.channelId);
      if (history.length >= maxAttempts) {
        options.onDecision?.(
          result.channelId,
          "suppressed",
          `circuit-open:${history.length}/${maxAttempts}`,
        );
        return settle("suppressed", result.state);
      }
      attempts.set(result.channelId, [...history, now()]);
      const dispatched = await options.recover(
        result.channelId,
        result.recommendation,
      );
      if (dispatched) {
        options.onDecision?.(result.channelId, "dispatched", result.recommendation);
        // Acknowledge on the state the caller will persist, so the classifier
        // stops reporting pending for this incident.
        return settle(
          "dispatched",
          acknowledgeContinuityHealthAction(result.state, result.channelId),
        );
      }
      // A failed action leaves the incident open and is still an attempt, so a
      // broken repair cannot itself become the storm.
      options.onDecision?.(result.channelId, "suppressed", "action-failed");
      return settle("suppressed", result.state);
    },
  };
}
