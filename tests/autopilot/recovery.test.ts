import { expect, test } from "vitest";
import { evaluateContinuityHealth } from "../../src/autopilot/continuityHealth.js";
import { createChannelRecovery } from "../../src/autopilot/recovery.js";

function stalled(sampleId: string, observedAtMs: number) {
  return {
    channelId: "c",
    watchdogSessionId: "s",
    sampleId,
    observedAtMs,
    workerProcessCount: 1,
    contiguousPublishedRunwaySeconds: 0,
    scheduledWakeBeforeDepletion: true,
    nextRequiredIntervalAvailable: false,
    progressDeadlineExceeded: true,
  };
}

/** A confirmed incident: two consecutive complete failure observations. */
function confirmedIncident() {
  const first = evaluateContinuityHealth(stalled("1", 1_000));
  return evaluateContinuityHealth(stalled("2", 2_000), first.state);
}

test("[PL06] a confirmed incident dispatches once and is then acknowledged", async () => {
  const incident = confirmedIncident();
  expect(incident.incident).toBe(true);
  expect(incident.recommendation).not.toBe("none");

  const calls: string[] = [];
  const recovery = createChannelRecovery({
    recover: async (channelId) => {
      calls.push(channelId);
      return true;
    },
    now: () => 5_000,
  });

  const first = await recovery.handle(incident);
  expect(first.outcome).toBe("dispatched");
  expect(calls).toEqual(["c"]);
  // Success acknowledges on the state the caller persists, so the next
  // classifier call sees no pending action and does not re-dispatch.
  expect(first.state.recoveryActionPending).toBe(false);
  const next = evaluateContinuityHealth(stalled("3", 3_000), first.state);
  expect((await recovery.handle(next)).outcome).toBe("no-action");
});

test("[PL06] the circuit breaker opens after the attempt limit and stops acting", async () => {
  const incident = confirmedIncident();
  const recovery = createChannelRecovery({
    // A repair that never succeeds: the incident stays open, so the breaker is
    // what has to stop the storm.
    recover: async () => false,
    now: () => 5_000,
    limits: { maxAttempts: 2, windowMs: 600_000 },
  });

  expect((await recovery.handle(incident)).outcome).toBe("suppressed"); // action-failed
  expect((await recovery.handle(incident)).outcome).toBe("suppressed"); // action-failed
  expect((await recovery.handle(incident)).outcome).toBe("suppressed"); // circuit-open
  expect(recovery.attemptsInWindow("c")).toBe(2);

  // Healthy channels never trigger an action at all.
  const healthy = evaluateContinuityHealth({
    ...stalled("3", 3_000),
    workerProcessCount: 1,
    contiguousPublishedRunwaySeconds: 600,
    progressDeadlineExceeded: false,
  });
  expect((await recovery.handle(healthy)).outcome).toBe("no-action");
});
