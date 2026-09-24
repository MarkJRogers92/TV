import { expect, test } from "vitest";
import {
  acknowledgeContinuityHealthAction,
  evaluateContinuityHealth,
  type ContinuityHealthObservation,
  type ContinuityHealthState,
} from "../../src/autopilot/continuityHealth.js";

const baseObservation: ContinuityHealthObservation = {
  channelId: "channel-7",
  watchdogSessionId: "unit-test-session",
  sampleId: "base-sample",
  observedAtMs: 0,
  workerProcessCount: 1,
  contiguousPublishedRunwaySeconds: 120,
  scheduledWakeBeforeDepletion: null,
  nextRequiredIntervalAvailable: true,
  progressDeadlineExceeded: false,
};

let sampleNumber = 0;

function tick(
  observation: ContinuityHealthObservation,
  state?: ContinuityHealthState,
) {
  sampleNumber += 1;
  return evaluateContinuityHealth({
    ...observation,
    sampleId: `tick-${sampleNumber}`,
    observedAtMs: sampleNumber * 1_000,
  }, state);
}

test("[PL01] classifies a resting producer as buffered idle when published runway covers its scheduled wake", () => {
  const observation = {
    ...baseObservation,
    workerProcessCount: 0,
    contiguousPublishedRunwaySeconds: 240,
    scheduledWakeBeforeDepletion: true,
  };

  const first = tick(observation);
  const second = tick(observation, first.state);

  expect(first.health).toBe("buffered_idle");
  expect(second.health).toBe("buffered_idle");
  expect(second.incident).toBe(false);
  expect(second.recommendation).toBe("none");
  expect(second.sharedServiceRestart).toBe(false);
});

test("[PL15] the classifier consumes no image, silence or viewer-count signal", () => {
  // PL15 forbids a false restart based on image motion, silence, or one client
  // alone. The guarantee here is structural, not heuristic: recovery can only be
  // recommended from continuity evidence, and nothing about the picture, the
  // audio, or how many viewers are connected is an input. Pinning the input
  // contract keeps a future field (frame motion, audio level, connected viewers)
  // from silently becoming a restart trigger.
  expect(Object.keys(baseObservation).sort()).toEqual([
    "channelId",
    "contiguousPublishedRunwaySeconds",
    "nextRequiredIntervalAvailable",
    "observedAtMs",
    "progressDeadlineExceeded",
    "sampleId",
    "scheduledWakeBeforeDepletion",
    "watchdogSessionId",
    "workerProcessCount",
  ]);
});

test("marks a resting producer at risk when its known wake is after runway depletion", () => {
  const result = tick({
    ...baseObservation,
    workerProcessCount: 0,
    contiguousPublishedRunwaySeconds: 240,
    scheduledWakeBeforeDepletion: false,
  });

  expect(result.health).toBe("at_risk");
  expect(result.recommendation).toBe("none");
  expect(result.sharedServiceRestart).toBe(false);
});

test("[PL15] requires repeated deadline-expired evidence before recommending channel-scoped recovery", () => {
  const observation: ContinuityHealthObservation = {
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };

  const first = tick(observation);
  const second = tick(observation, first.state);
  const third = tick(observation, second.state);

  expect(first.health).toBe("at_risk");
  expect(first.incident).toBe(false);
  expect(first.recommendation).toBe("none");
  expect(second.health).toBe("stalled");
  expect(second.incident).toBe(true);
  expect(second.recommendation).toBe(
    "wake_or_repair_continuation_then_fallback_or_channel_recovery",
  );
  expect(second.channelId).toBe("channel-7");
  expect(second.sharedServiceRestart).toBe(false);
  expect(third.health).toBe("stalled");
  expect(third.incident).toBe(true);
  expect(third.recommendation).toBe(second.recommendation);
});

test("does not count a replayed watchdog snapshot as a second failure sample", () => {
  const observation = {
    ...baseObservation,
    sampleId: "same-snapshot",
    observedAtMs: 20_000,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };
  const first = evaluateContinuityHealth(observation);
  const replay = evaluateContinuityHealth(observation, first.state);
  const next = evaluateContinuityHealth({
    ...observation,
    sampleId: "later-snapshot",
    observedAtMs: 25_000,
  }, replay.state);

  expect(first.sampleAccepted).toBe(true);
  expect(replay.sampleAccepted).toBe(false);
  expect(replay.state.consecutiveFailureSamples).toBe(1);
  expect(replay.incident).toBe(false);
  expect(next.incident).toBe(true);
});

test("resets failure hysteresis when a new watchdog session begins", () => {
  const candidate = tick({
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  });
  const restartedSession = evaluateContinuityHealth({
    ...baseObservation,
    watchdogSessionId: "new-supervisor-session",
    sampleId: "new-session-sample-1",
    observedAtMs: 1,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  }, candidate.state);

  expect(restartedSession.sampleAccepted).toBe(true);
  expect(restartedSession.incident).toBe(false);
  expect(restartedSession.state.consecutiveFailureSamples).toBe(1);
  expect(restartedSession.state.watchdogSessionId).toBe("new-supervisor-session");
});

test("rejects health state from another channel", () => {
  const channel7 = tick({ ...baseObservation, channelId: "channel-7" });
  const channel8 = evaluateContinuityHealth({
    ...baseObservation,
    channelId: "channel-8",
    sampleId: "channel-8-first",
    observedAtMs: 50_000,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  }, channel7.state);

  expect(channel8.sampleAccepted).toBe(false);
  expect(channel8.health).toBe("unknown");
  expect(channel8.incident).toBe(false);
  expect(channel8.state.channelId).toBe("channel-8");
  expect(channel8.state.consecutiveFailureSamples).toBe(0);
});

test("missing or uncertain evidence fails closed and clears an unconfirmed failure streak", () => {
  const failure: ContinuityHealthObservation = {
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };
  const candidate = tick(failure);
  const uncertain = tick({ ...failure, nextRequiredIntervalAvailable: null }, candidate.state);

  expect(uncertain.health).toBe("at_risk");
  expect(uncertain.incident).toBe(false);
  expect(uncertain.recommendation).toBe("none");
  expect(tick(failure, uncertain.state).health).toBe("at_risk");
});

test("does not recommend recovery when a next interval is merely late but its deadline remains open", () => {
  const result = tick({
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: false,
  });

  expect(result.health).toBe("at_risk");
  expect(result.recommendation).toBe("none");
  expect(result.sharedServiceRestart).toBe(false);
});

test("keeps a confirmed incident open until two stable observations", () => {
  const failed: ContinuityHealthObservation = {
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };
  const first = tick(failed);
  const confirmed = tick(failed, first.state);
  const recovered: ContinuityHealthObservation = {
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 120,
    nextRequiredIntervalAvailable: true,
    progressDeadlineExceeded: false,
  };
  const stableOnce = tick(recovered, confirmed.state);
  const stableTwice = tick(recovered, stableOnce.state);

  expect(stableOnce.incident).toBe(true);
  expect(stableTwice.incident).toBe(false);
});

test("retries an unacknowledged recovery recommendation and stops after successful dispatch", () => {
  const failure: ContinuityHealthObservation = {
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };
  const candidate = tick(failure);
  const confirmed = tick(failure, candidate.state);
  const retry = tick(failure, confirmed.state);
  const rejectedAck = acknowledgeContinuityHealthAction(retry.state, "channel-8");
  const retryAfterRejectedAck = tick(failure, rejectedAck);
  const acknowledged = acknowledgeContinuityHealthAction(retryAfterRejectedAck.state, "channel-7");
  const afterAck = tick(failure, acknowledged);
  const persistentFailureAfterAck = tick(failure, afterAck.state);

  expect(confirmed.recommendation).not.toBe("none");
  expect(retry.recommendation).toBe(confirmed.recommendation);
  expect(retryAfterRejectedAck.recommendation).toBe(confirmed.recommendation);
  expect(acknowledged.recoveryActionPending).toBe(false);
  expect(afterAck.recommendation).toBe("none");
  expect(persistentFailureAfterAck.recommendation).toBe("none");
});

test("missing critical telemetry does not erase an open incident or its pending action", () => {
  const failure: ContinuityHealthObservation = {
    ...baseObservation,
    contiguousPublishedRunwaySeconds: 2,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };
  const candidate = tick(failure);
  const confirmed = tick(failure, candidate.state);
  const missingTelemetry = tick({
    ...failure,
    contiguousPublishedRunwaySeconds: null,
  }, confirmed.state);

  expect(missingTelemetry.health).toBe("unknown");
  expect(missingTelemetry.incident).toBe(true);
  expect(missingTelemetry.recommendation).toBe(confirmed.recommendation);
  expect(missingTelemetry.state.recoveryActionPending).toBe(true);
});
