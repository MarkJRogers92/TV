import { expect, test } from "vitest";
import { evaluateContinuityHealth } from "../../src/autopilot/continuityHealth.js";
import { buildObservation, parsePlaylist } from "../../src/autopilot/healthShadow.js";

test("[PL17] parsePlaylist counts segments and reads the target duration", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:4",
    "#EXTINF:4.000,",
    "data000001.ts",
    "#EXTINF:4.000,",
    "data000002.ts",
  ].join("\n");
  expect(parsePlaylist(playlist)).toEqual({ segments: 2, targetDurationSeconds: 4 });
  expect(parsePlaylist("")).toEqual({ segments: 0, targetDurationSeconds: 0 });
});

test("[PL02] an advancing channel is healthy; a stopped one is flagged, never a shared restart", () => {
  const now = 1_000_000_000;
  const fresh = buildObservation({
    channelId: "c",
    watchdogSessionId: "s",
    sampleId: "1",
    nowMs: now,
    sessionActive: true,
    sample: { segments: 10, targetDurationSeconds: 4, lastAdvanceMs: now - 1_000 },
    stalledAfterSeconds: 90,
  });
  const healthy = evaluateContinuityHealth(fresh);
  expect(healthy.health).toBe("healthy");
  expect(healthy.recommendation).toBe("none");

  const stalled = buildObservation({
    channelId: "c",
    watchdogSessionId: "s",
    sampleId: "2",
    nowMs: now,
    sessionActive: false,
    sample: { segments: 10, targetDurationSeconds: 4, lastAdvanceMs: now - 200_000 },
    stalledAfterSeconds: 90,
  });
  const flagged = evaluateContinuityHealth(stalled, healthy.state);
  expect(flagged.health).not.toBe("healthy");
  // A single channel's symptom can never recommend restarting shared Tunarr.
  expect(flagged.sharedServiceRestart).toBe(false);
});
