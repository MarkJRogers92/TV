import { expect, test } from "vitest";
import { recordPartialExposure } from "../../src/continuity/podExposure.js";

/*
 * SC06 — "Playback stops 45 seconds into a three-by-30-second pod.
 * Record 30/15/0 seconds for members, not three completed ads." (fixture F16)
 *
 * F16 gives the pod as three creatives laid out 0-30, 30-60, 60-90 with an
 * actually-aired pod interval of [0, 45], and expects 30 / 15 / 0 with the third
 * member explicitly not completed.
 */

const threeBy30 = [
  { id: "ad_a", durationMs: 30_000 },
  { id: "ad_b", durationMs: 30_000 },
  { id: "ad_c", durationMs: 30_000 },
];

const secondsOf = (exposure: ReturnType<typeof recordPartialExposure>) =>
  exposure.members.map((member) => member.airedSeconds);

test("[SC06] fixture F16: a pod that stops 45s into three 30s members records 30/15/0", () => {
  const exposure = recordPartialExposure(threeBy30, { startMs: 0, endMs: 45_000 });

  expect(secondsOf(exposure)).toEqual([30, 15, 0]);
  expect(exposure.members.map((member) => member.id)).toEqual([
    "ad_a",
    "ad_b",
    "ad_c",
  ]);
  expect(exposure.members.map((member) => member.completed)).toEqual([
    true,
    false,
    // The break never reached the third creative, so it is recorded at zero and
    // NOT as completed. Recording it as completed is exactly the "three
    // completed ads" fault this case is about.
    false,
  ]);

  // The whole point: the members account for the 45s that aired, not the 90s the
  // pod would have taken had it finished.
  expect(exposure.podAiredSeconds).toBe(45);
  expect(exposure.podCompleted).toBe(false);
  expect(
    exposure.members.reduce((sum, member) => sum + member.airedMs, 0),
  ).toBe(exposure.podAiredMs);
});

test("[SC06] members collectively account for exactly the pod time that aired", () => {
  // A break joined late: 15s of the first member, a full second, nothing after.
  const exposure = recordPartialExposure(threeBy30, {
    startMs: 15_000,
    endMs: 45_000,
  });

  expect(secondsOf(exposure)).toEqual([15, 15, 0]);
  expect(exposure.podAiredSeconds).toBe(30);
  expect(
    exposure.members.reduce((sum, member) => sum + member.airedMs, 0),
  ).toBe(exposure.podAiredMs);

  // An aired interval reaching past the end of the pod is clipped to the pod, so
  // it cannot credit more than the members actually contain.
  const overshooting = recordPartialExposure(threeBy30, {
    startMs: 0,
    endMs: 120_000,
  });
  expect(secondsOf(overshooting)).toEqual([30, 30, 30]);
  expect(overshooting.podAiredSeconds).toBe(90);
  expect(overshooting.podCompleted).toBe(true);
  expect(
    overshooting.members.reduce((sum, member) => sum + member.airedMs, 0),
  ).toBe(overshooting.podAiredMs);
});

test("[SC06] a pod that never started credits nothing and completes nothing", () => {
  const exposure = recordPartialExposure(threeBy30, {
    startMs: 45_000,
    endMs: 45_000,
  });

  expect(secondsOf(exposure)).toEqual([0, 0, 0]);
  expect(exposure.members.every((member) => !member.completed)).toBe(true);
  expect(exposure.podAiredSeconds).toBe(0);
  expect(exposure.podCompleted).toBe(false);
});

test("[SC06] an aired interval outside the pod credits nothing", () => {
  // After the pod (the break was skipped entirely and the next item ran).
  const after = recordPartialExposure(threeBy30, {
    startMs: 90_000,
    endMs: 120_000,
  });
  expect(secondsOf(after)).toEqual([0, 0, 0]);
  expect(after.podAiredSeconds).toBe(0);

  // Before the pod.
  const before = recordPartialExposure(threeBy30, {
    startMs: -60_000,
    endMs: -10_000,
  });
  expect(secondsOf(before)).toEqual([0, 0, 0]);
  expect(before.podAiredMs).toBe(0);
});

test("[SC06] whole-second reporting does not drop a partial second of coverage", () => {
  // A 45.5s exposure still reports the precise ms, and the seconds are the
  // rounded view of it - the sum invariant is asserted on ms, not on seconds.
  const exposure = recordPartialExposure(
    [
      { id: "ad_a", durationMs: 30_000 },
      { id: "ad_b", durationMs: 30_000 },
    ],
    { startMs: 0, endMs: 45_500 },
  );

  expect(exposure.members[1]?.airedMs).toBe(15_500);
  expect(exposure.members[1]?.airedSeconds).toBe(16);
  expect(
    exposure.members.reduce((sum, member) => sum + member.airedMs, 0),
  ).toBe(45_500);
});

test("[SC06] a pod expressed in absolute time uses its own start", () => {
  // The caller has an aired interval from the schedule, in absolute ms. This is
  // fixture F16 again, moved to an absolute clock: the pod starts at
  // 1_000_000_000 and the aired interval covers its first 45 seconds.
  const exposure = recordPartialExposure(
    threeBy30,
    { startMs: 1_000_000_000, endMs: 1_000_045_000 },
    { podStartMs: 1_000_000_000 },
  );

  expect(secondsOf(exposure)).toEqual([30, 15, 0]);
  expect(exposure.podAiredSeconds).toBe(45);

  // And joining the same pod at +30s is measured from the pod, not from zero.
  const late = recordPartialExposure(
    threeBy30,
    { startMs: 1_000_030_000, endMs: 1_000_075_000 },
    { podStartMs: 1_000_000_000 },
  );
  expect(secondsOf(late)).toEqual([0, 30, 15]);
});

test("[SC06] a zero-length member is never completed", () => {
  const exposure = recordPartialExposure(
    [
      { id: "ad_a", durationMs: 30_000 },
      { id: "empty-slot", durationMs: 0 },
      { id: "ad_c", durationMs: 30_000 },
    ],
    { startMs: 0, endMs: 60_000 },
  );

  expect(secondsOf(exposure)).toEqual([30, 0, 30]);
  expect(exposure.members.map((member) => member.completed)).toEqual([
    true,
    false,
    true,
  ]);
  expect(exposure.podCompleted).toBe(false);
  expect(exposure.podAiredMs).toBe(60_000);
});
