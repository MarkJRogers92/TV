/** Evidence sampled by one watchdog owner for one channel. Unknown values stay null. */
export interface ContinuityHealthObservation {
  channelId: string;
  /** Unique supervisor lifetime; monotonic sample time is scoped to this session. */
  watchdogSessionId: string;
  /** Unique identifier for this watchdog snapshot, retained to reject replay. */
  sampleId: string;
  /** Monotonic time in the watchdog process/session that produced this sample. */
  observedAtMs: number;
  workerProcessCount: number | null;
  contiguousPublishedRunwaySeconds: number | null;
  /** Required to distinguish a planned producer rest from a missed continuation. */
  scheduledWakeBeforeDepletion: boolean | null;
  nextRequiredIntervalAvailable: boolean | null;
  progressDeadlineExceeded: boolean | null;
}

export interface ContinuityHealthState {
  channelId: string | null;
  watchdogSessionId: string | null;
  lastSampleId: string | null;
  lastObservedAtMs: number | null;
  consecutiveFailureSamples: number;
  consecutiveStableSamples: number;
  incidentOpen: boolean;
  /** Remains set until a caller acknowledges successful dispatch or health clears. */
  recoveryActionPending: boolean;
}

export interface ContinuityHealthPolicy {
  /** Below this runway, the channel is considered at risk. */
  healthyRunwaySeconds: number;
  /** An idle worker is normal when this much published runway remains. */
  bufferedIdleRunwaySeconds: number;
  /** A failure needs this many consecutive complete observations. */
  failureConfirmationSamples: number;
  /** A confirmed incident clears only after this many stable observations. */
  stableSamplesToClear: number;
}

export type ContinuityHealth = "healthy" | "buffered_idle" | "at_risk" | "stalled" | "unknown";
export type ContinuityRecommendation =
  | "none"
  | "wake_or_repair_continuation_then_fallback_or_channel_recovery";

export interface ContinuityHealthResult {
  channelId: string;
  health: ContinuityHealth;
  incident: boolean;
  recommendation: ContinuityRecommendation;
  /** Shared Tunarr restarts require a separate proven shared-process failure gate. */
  sharedServiceRestart: false;
  sampleAccepted: boolean;
  state: ContinuityHealthState;
}

export const DEFAULT_CONTINUITY_HEALTH_POLICY: Readonly<ContinuityHealthPolicy> = {
  healthyRunwaySeconds: 30,
  bufferedIdleRunwaySeconds: 120,
  failureConfirmationSamples: 2,
  stableSamplesToClear: 2,
};

const EMPTY_STATE: ContinuityHealthState = {
  channelId: null,
  watchdogSessionId: null,
  lastSampleId: null,
  lastObservedAtMs: null,
  consecutiveFailureSamples: 0,
  consecutiveStableSamples: 0,
  incidentOpen: false,
  recoveryActionPending: false,
};

function validPolicy(policy: ContinuityHealthPolicy): boolean {
  return (
    Number.isFinite(policy.healthyRunwaySeconds) &&
    policy.healthyRunwaySeconds >= 0 &&
    Number.isFinite(policy.bufferedIdleRunwaySeconds) &&
    policy.bufferedIdleRunwaySeconds >= policy.healthyRunwaySeconds &&
    Number.isInteger(policy.failureConfirmationSamples) &&
    policy.failureConfirmationSamples > 0 &&
    Number.isInteger(policy.stableSamplesToClear) &&
    policy.stableSamplesToClear > 0
  );
}

function validState(state: ContinuityHealthState): boolean {
  return (
    (state.channelId === null || (typeof state.channelId === "string" && state.channelId.length > 0)) &&
    (state.watchdogSessionId === null ||
      (typeof state.watchdogSessionId === "string" && state.watchdogSessionId.length > 0)) &&
    (state.lastSampleId === null || (typeof state.lastSampleId === "string" && state.lastSampleId.length > 0)) &&
    (state.lastObservedAtMs === null || Number.isFinite(state.lastObservedAtMs)) &&
    Number.isInteger(state.consecutiveFailureSamples) &&
    state.consecutiveFailureSamples >= 0 &&
    Number.isInteger(state.consecutiveStableSamples) &&
    state.consecutiveStableSamples >= 0 &&
    typeof state.incidentOpen === "boolean" &&
    typeof state.recoveryActionPending === "boolean"
  );
}

/** Acknowledge only after the caller has successfully dispatched the pending action. */
export function acknowledgeContinuityHealthAction(
  state: ContinuityHealthState,
  channelId: string,
): ContinuityHealthState {
  if (!validState(state) || state.channelId !== channelId || !state.recoveryActionPending) {
    return state;
  }
  return { ...state, recoveryActionPending: false };
}

/**
 * Classify one channel and advance its small hysteresis state. This is a pure
 * decision gate: callers must persist the returned state per channel, use a
 * fresh session ID after watchdog restart, and use unique sample IDs with
 * increasing monotonic timestamps within each session. A pending recommendation
 * repeats until the caller successfully dispatches and acknowledges it; failed
 * dispatches must leave the pending state intact.
 */
export function evaluateContinuityHealth(
  observation: ContinuityHealthObservation,
  previousState: ContinuityHealthState = EMPTY_STATE,
  policy: ContinuityHealthPolicy = DEFAULT_CONTINUITY_HEALTH_POLICY,
): ContinuityHealthResult {
  const channelId = observation.channelId;
  const observationValid =
    typeof channelId === "string" &&
    channelId.trim().length > 0 &&
    typeof observation.watchdogSessionId === "string" &&
    observation.watchdogSessionId.trim().length > 0 &&
    typeof observation.sampleId === "string" &&
    observation.sampleId.trim().length > 0 &&
    Number.isFinite(observation.observedAtMs) &&
    Number.isInteger(observation.workerProcessCount) &&
    observation.workerProcessCount !== null &&
    observation.workerProcessCount >= 0 &&
    Number.isFinite(observation.contiguousPublishedRunwaySeconds) &&
    observation.contiguousPublishedRunwaySeconds !== null &&
    observation.contiguousPublishedRunwaySeconds >= 0 &&
    (observation.scheduledWakeBeforeDepletion === null ||
      typeof observation.scheduledWakeBeforeDepletion === "boolean") &&
    (observation.nextRequiredIntervalAvailable === null ||
      typeof observation.nextRequiredIntervalAvailable === "boolean") &&
    (observation.progressDeadlineExceeded === null ||
      typeof observation.progressDeadlineExceeded === "boolean");

  const priorStateValid = validState(previousState);
  const previousChannelMismatch =
    priorStateValid && previousState.channelId !== null && previousState.channelId !== channelId;
  if (!priorStateValid || !validPolicy(policy) || previousChannelMismatch) {
    return {
      channelId,
      health: "unknown",
      incident: false,
      recommendation: "none",
      sharedServiceRestart: false,
      sampleAccepted: false,
      state: { ...EMPTY_STATE, channelId },
    };
  }

  if (!observationValid) {
    return {
      channelId,
      health: "unknown",
      incident: previousState.incidentOpen,
      recommendation: previousState.recoveryActionPending
        ? "wake_or_repair_continuation_then_fallback_or_channel_recovery"
        : "none",
      sharedServiceRestart: false,
      sampleAccepted: false,
      state: previousState,
    };
  }

  const newWatchdogSession =
    previousState.watchdogSessionId !== null &&
    previousState.watchdogSessionId !== observation.watchdogSessionId;
  const sameSessionState = newWatchdogSession
    ? {
        ...previousState,
        watchdogSessionId: observation.watchdogSessionId,
        lastSampleId: null,
        lastObservedAtMs: null,
        consecutiveFailureSamples: 0,
        consecutiveStableSamples: 0,
      }
    : previousState;
  const replayedOrOutOfOrder =
    (sameSessionState.lastSampleId !== null &&
      observation.sampleId === sameSessionState.lastSampleId) ||
    (sameSessionState.lastObservedAtMs !== null &&
      observation.observedAtMs <= sameSessionState.lastObservedAtMs);

  const runway = observation.contiguousPublishedRunwaySeconds;
  const workers = observation.workerProcessCount;
  let health: ContinuityHealth = "unknown";

  if (runway !== null && workers !== null) {
    if (workers === 0 && runway >= policy.bufferedIdleRunwaySeconds) {
      // Without a known timely wake, high runway is not proof of healthy idling.
      health =
        observation.scheduledWakeBeforeDepletion === true
          ? "buffered_idle"
          : observation.scheduledWakeBeforeDepletion === false
            ? "at_risk"
            : "unknown";
    } else if (
      workers > 0 &&
      runway >= policy.healthyRunwaySeconds &&
      observation.nextRequiredIntervalAvailable !== false
    ) {
      health = "healthy";
    } else {
      health = "at_risk";
    }
  }

  const failureEvidenceComplete =
    runway !== null &&
    workers !== null &&
    runway < policy.healthyRunwaySeconds &&
    observation.nextRequiredIntervalAvailable === false &&
    observation.progressDeadlineExceeded === true;

  const stable = health === "healthy" || health === "buffered_idle";
  if (replayedOrOutOfOrder) {
    return {
      channelId,
      health: sameSessionState.incidentOpen ? "stalled" : health === "unknown" ? "unknown" : "at_risk",
      incident: sameSessionState.incidentOpen,
      recommendation: sameSessionState.recoveryActionPending
        ? "wake_or_repair_continuation_then_fallback_or_channel_recovery"
        : "none",
      sharedServiceRestart: false,
      sampleAccepted: false,
      state: sameSessionState,
    };
  }

  const nextState: ContinuityHealthState = {
    ...sameSessionState,
    channelId,
    watchdogSessionId: observation.watchdogSessionId,
    lastSampleId: observation.sampleId,
    lastObservedAtMs: observation.observedAtMs,
  };
  let recommendation: ContinuityRecommendation = "none";

  if (health === "unknown") {
    // Unknown observations break a candidate streak; missing data never confirms failure.
    nextState.consecutiveFailureSamples = 0;
    nextState.consecutiveStableSamples = 0;
  } else if (failureEvidenceComplete) {
    nextState.consecutiveFailureSamples += 1;
    nextState.consecutiveStableSamples = 0;
    if (nextState.consecutiveFailureSamples >= policy.failureConfirmationSamples) {
      const newlyConfirmed = !nextState.incidentOpen;
      nextState.incidentOpen = true;
      if (newlyConfirmed) nextState.recoveryActionPending = true;
      health = "stalled";
    }
  } else if (stable) {
    nextState.consecutiveFailureSamples = 0;
    if (nextState.incidentOpen) {
      nextState.consecutiveStableSamples += 1;
      if (nextState.consecutiveStableSamples >= policy.stableSamplesToClear) {
        nextState.incidentOpen = false;
        nextState.consecutiveStableSamples = 0;
        nextState.recoveryActionPending = false;
      }
    } else {
      nextState.consecutiveStableSamples = 0;
    }
  } else {
    nextState.consecutiveFailureSamples = 0;
    nextState.consecutiveStableSamples = 0;
  }

  if (nextState.recoveryActionPending) {
    recommendation = "wake_or_repair_continuation_then_fallback_or_channel_recovery";
  }

  return {
    channelId,
    health,
    incident: nextState.incidentOpen,
    recommendation,
    sharedServiceRestart: false,
    sampleAccepted: true,
    state: nextState,
  };
}
