/**
 * Per-creative exposure for a pod that did not finish (SC06 / fixture F16).
 *
 * The fault this answers: "playback stops 45 seconds into a three-by-30-second
 * pod", and the requirement is to "record 30/15/0 seconds for members, not three
 * completed ads". Recording completion per member is the difference between an
 * honest traffic log and one that claims three ads aired when one and a half did.
 *
 * So the unit of record is the MEMBER, not the pod: each member gets the seconds
 * it actually occupied inside the aired interval, and a completion flag that is
 * true only when it aired in full. A member the break never reached is recorded
 * at zero and explicitly not completed, rather than being dropped from the log
 * or assumed to have run.
 *
 * The invariant worth defending, and the one every caller can assert:
 *
 *   sum(member.airedMs) === overlap(aired, pod)
 *
 * i.e. the members collectively account for exactly the pod time that aired. A
 * "three completed ads" log violates it by crediting the full pod, and an
 * implementation that clamps each member independently can violate it by
 * crediting more than aired. Zero-length members are legal (a filler slot may be
 * 0s) and contribute nothing.
 *
 * This module computes the record. Persisting it durably, per channel and per
 * break, is deliberately NOT done here: the airing ledger records per-occurrence
 * media intervals, and giving it a per-creative notion of coverage is a separate
 * change with its own migration. Callers must not read this as an audit trail.
 */

/** One member of a pod, in playback order. Durations lay out the pod from 0. */
export type PodMember = {
  id: string;
  durationMs: number;
};

/** The interval of the pod that actually aired, in pod-relative or absolute ms. */
export type AiredInterval = {
  startMs: number;
  endMs: number;
};

export type MemberExposure = {
  id: string;
  /** Overlap with the aired interval. Zero for a member the break never reached. */
  airedMs: number;
  /** The same value in whole seconds, which is how the record is reported. */
  airedSeconds: number;
  /** True only when the member's whole duration is inside the aired interval. */
  completed: boolean;
};

export type PodExposure = {
  members: MemberExposure[];
  /** Pod time that aired: the aired interval clipped to the pod. */
  podAiredMs: number;
  podAiredSeconds: number;
  /** True only when every member aired in full. */
  podCompleted: boolean;
};

type Options = {
  /** Where the pod begins, when `aired` is expressed in absolute time. */
  podStartMs?: number;
};

const overlapMs = (startA: number, endA: number, startB: number, endB: number) =>
  Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));

/**
 * Records what each member of a pod actually aired.
 *
 * Clamping happens ONCE, against the pod's own span, and the aired interval is
 * clipped to that span before any member is measured. Clamping per member
 * instead is what lets a partially-aired pod report more seconds than it played.
 */
export function recordPartialExposure(
  members: readonly PodMember[],
  aired: AiredInterval,
  options: Options = {},
): PodExposure {
  const podStartMs = options.podStartMs ?? 0;
  const totalMs = members.reduce(
    // A negative member duration would silently shorten the pod; treat it as 0.
    (sum, member) => sum + Math.max(0, member.durationMs),
    0,
  );
  const podEndMs = podStartMs + totalMs;

  // Clip the aired interval to the pod once, before measuring any member.
  const airedStartMs = Math.max(aired.startMs, podStartMs);
  const airedEndMs = Math.min(aired.endMs, podEndMs);
  const podAiredMs = Math.max(0, airedEndMs - airedStartMs);

  let cursor = podStartMs;
  const exposures: MemberExposure[] = members.map((member) => {
    const durationMs = Math.max(0, member.durationMs);
    const memberStartMs = cursor;
    const memberEndMs = cursor + durationMs;
    cursor = memberEndMs;

    const memberAiredMs = overlapMs(
      memberStartMs,
      memberEndMs,
      airedStartMs,
      airedEndMs,
    );
    return {
      id: member.id,
      airedMs: memberAiredMs,
      airedSeconds: Math.round(memberAiredMs / 1000),
      // A zero-length member never "completed": it has nothing that can air.
      completed: durationMs > 0 && memberAiredMs === durationMs,
    };
  });

  return {
    members: exposures,
    podAiredMs,
    podAiredSeconds: Math.round(podAiredMs / 1000),
    podCompleted: exposures.length > 0 && exposures.every((e) => e.completed),
  };
}
