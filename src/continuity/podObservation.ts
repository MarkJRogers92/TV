/**
 * Observing how far a pod actually got (SC06, activation half).
 *
 * `recordPartialExposure` computes 30/15/0 from a pod layout and the interval
 * that aired. This is where that interval comes from - and the only place it may
 * come from is an OBSERVATION of the channel, never the schedule.
 *
 * Why that distinction is the whole point: the schedule says the pod was three
 * 30-second ads. Recording the schedule as exposure would log every pod as
 * complete, 30/30/30 - which is precisely the fault SC06 exists to prevent
 * ("not three completed ads"). The airing ledger's own doctrine is that a plan is
 * not exposure, and this module holds to it: if the channel's advertised output
 * does not show time inside the pod, NOTHING is recorded for that pod.
 *
 * The observation available without touching the playout path is the channel's
 * own HLS playlist, which MarkTV already reads for the continuity watchdog. Every
 * segment in it carries a PROGRAM-DATE-TIME, in real wall-clock terms, so
 * intersecting those segments with a pod's window answers "how much of the pod
 * went out" directly.
 *
 * THE ERROR DIRECTION IS DELIBERATE. Coverage is the greatest CONTIGUOUS
 * advertised run anchored at the pod's start: the first gap ends it. A segment
 * with no usable timestamp is skipped rather than guessed, and an anchored run
 * that never covers the pod's start yields null - "not observed" - instead of a
 * fabricated interval. So every failure mode under-reports airtime, and none can
 * credit airtime that was not advertised.
 */
import type { AiredInterval, PodMember } from "./podExposure.js";

export type AdvertisedSegment = {
  /** Position in the playlist, used only for stable ordering. */
  sequence: number;
  startMs: number;
  durationMs: number;
};

/** A pod as the schedule lays it out: members in order, with its own window. */
export type ScheduledPod = {
  podId: string;
  channelId: string;
  startMs: number;
  endMs: number;
  members: PodMember[];
};

const PDT_PREFIX = "#EXT-X-PROGRAM-DATE-TIME:";

/**
 * Parse a media playlist into (start, duration) segments.
 *
 * Deliberately strict: a segment is only emitted when it has BOTH a duration and
 * a parseable program-date-time. Anything else is skipped, which can only shorten
 * the observed run - see the module note on error direction.
 */
export function parseAdvertisedSegments(text: string): AdvertisedSegment[] {
  const segments: AdvertisedSegment[] = [];
  let pendingDurationMs: number | undefined;
  let pendingStartMs: number | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const value = Number.parseFloat(
        line.slice("#EXTINF:".length).replace(",", ""),
      );
      pendingDurationMs =
        Number.isFinite(value) && value > 0
          ? Math.round(value * 1000)
          : undefined;
      continue;
    }
    if (line.startsWith(PDT_PREFIX)) {
      pendingStartMs = parseProgramDateTimeMs(
        line.slice(PDT_PREFIX.length).trim(),
      );
      continue;
    }
    if (line.startsWith("#")) continue;
    // A URI line closes the entry.
    if (pendingDurationMs !== undefined && pendingStartMs !== undefined) {
      segments.push({
        sequence: segments.length,
        startMs: pendingStartMs,
        durationMs: pendingDurationMs,
      });
    }
    pendingDurationMs = undefined;
    pendingStartMs = undefined;
  }
  return segments;
}

/**
 * '2026-09-24T12:13:49.793-0500' -> epoch ms, or undefined when unparseable.
 *
 * Written by hand rather than via Date.parse because the offset form FFmpeg
 * emits (-0500, no colon) is not portable across engines, and a silently
 * misparsed timestamp would shift an exposure by hours.
 */
export function parseProgramDateTimeMs(text: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([+-])(\d{2})(\d{2})$/.exec(
      text,
    );
  if (!match) return undefined;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    sign,
    offHour,
    offMinute,
  ] = match;
  const millis = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis,
  );
  const offsetMs = (Number(offHour) * 60 + Number(offMinute)) * 60_000;
  return sign === "+" ? utc - offsetMs : utc + offsetMs;
}

/**
 * The part of a pod the channel advertised, or null when we did not observe the
 * pod's start at all.
 *
 * Anchored at the pod start, exactly like the ledger's contiguous-coverage rule:
 * coverage that begins after the pod did cannot vouch for the beginning, and
 * coverage that stops is where airtime stops. `toleranceMs` absorbs the
 * sub-second difference between the schedule's boundary and the segment that
 * straddles it.
 */
export function observedPodInterval(
  pod: { startMs: number; endMs: number },
  advertised: readonly AdvertisedSegment[],
  options: { toleranceMs?: number } = {},
): AiredInterval | null {
  if (pod.endMs <= pod.startMs) return null;
  const toleranceMs = options.toleranceMs ?? 1_000;

  const covering = advertised
    .filter((segment) => segment.startMs < pod.endMs)
    .filter((segment) => segment.startMs + segment.durationMs > pod.startMs)
    .sort((left, right) => left.startMs - right.startMs);

  const first = covering[0];
  if (first === undefined) return null;
  // The pod's start must be inside the first segment, within tolerance: a run
  // that begins mid-pod says nothing about the part we did not see.
  if (pod.startMs - first.startMs > toleranceMs) return null;

  let cursor = Math.max(pod.startMs, first.startMs + first.durationMs);
  for (const segment of covering.slice(1)) {
    // A gap between advertised segments ends the observed run.
    if (segment.startMs > cursor + toleranceMs) break;
    const end = segment.startMs + segment.durationMs;
    if (end > cursor) cursor = end;
    if (cursor >= pod.endMs) break;
  }

  const endMs = Math.min(cursor, pod.endMs);
  if (endMs <= pod.startMs) return null;
  return { startMs: pod.startMs, endMs };
}

/**
 * Groups consecutive non-programme schedule entries into pods.
 *
 * A pod is a run of adjacent filler/commercial/continuity entries - the schedule
 * already lays breaks out in order, so grouping is adjacency, not inference.
 * Entries of an unknown kind split runs rather than joining them, since joining
 * across an unseen kind would invent a pod that was never scheduled.
 */
export function scheduledPods(
  entries: ReadonlyArray<{
    id: string;
    kind: string;
    start: string;
    end: string;
  }>,
  options: {
    channelId: string;
    breakKinds?: readonly string[];
    minDurationMs?: number;
  },
): ScheduledPod[] {
  // The four kinds that are break CONTENT - everything in `mediaKinds` except the
  // programme kinds episode and movie. `station-id` and `bumper` matter here: the
  // live schedules put both inside breaks, so leaving them out would split one pod
  // into two at every station id. `flex` is a programme placeholder and is
  // deliberately excluded, which splits a run rather than swallowing it.
  const breakKinds = new Set(
    options.breakKinds ?? ["commercial", "filler", "station-id", "bumper"],
  );
  const minDurationMs = options.minDurationMs ?? 1_000;
  const pods: ScheduledPod[] = [];
  let run: ScheduledPod | undefined;

  const ordered = [...entries].sort(
    (left, right) => Date.parse(left.start) - Date.parse(right.start),
  );

  for (const entry of ordered) {
    const startMs = Date.parse(entry.start);
    const endMs = Date.parse(entry.end);
    const durationMs = endMs - startMs;
    if (
      !breakKinds.has(entry.kind) ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      run = undefined;
      continue;
    }
    if (run === undefined) {
      run = {
        podId: `${options.channelId}:${entry.start}`,
        channelId: options.channelId,
        startMs,
        endMs,
        members: [],
      };
      pods.push(run);
    }
    run.endMs = endMs;
    run.members.push({ id: entry.id, durationMs });
  }

  return pods.filter((pod) => pod.endMs - pod.startMs >= minDurationMs);
}
