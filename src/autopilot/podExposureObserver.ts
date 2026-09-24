/**
 * Activates SC06: records per-creative pod exposure from what the channel
 * actually advertised.
 *
 * The ledger has the durable store and `recordPartialExposure` has the
 * arithmetic; neither of them runs during playout on its own. This is the thing
 * that does - and the point of it is the source of the evidence. It reads the
 * channel's own HLS playlist (the file MarkTV already reads for the continuity
 * watchdog), intersects the advertised segments with each finished pod's window,
 * and records what it finds. It never reads the schedule as evidence: a plan
 * recorded as exposure would log every pod as three completed ads, which is the
 * exact fault SC06 exists to prevent.
 *
 * The other deliberate choice is WHICH pods it records: only those whose window
 * has fully passed. Recording a pod still in progress would freeze a partial
 * figure that a later pass could only contradict, and the ledger correctly
 * refuses contradicting rewrites - so a mid-pod write would leave the record
 * stuck at whatever it caught. Waiting for the window to pass costs only latency
 * and makes the write once.
 *
 * Read-only with respect to serving: it opens playlist files and writes ledger
 * rows. It never touches the producer, the session, or the playlist.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiringLedger } from "./airingLedger.js";
import type { Repositories } from "../db/repositories.js";
import {
  observedPodInterval,
  parseAdvertisedSegments,
  scheduledPods,
  type AdvertisedSegment,
  type ScheduledPod,
} from "../continuity/podObservation.js";
import type { PodExposureRecord } from "./airingLedger.js";
import type { AiredInterval } from "../continuity/podExposure.js";
import type { Schedule } from "../domain/models.js";

export type PodExposureOutcome =
  | "recorded"
  | "already-recorded"
  /** The pod's start was never advertised, or nothing covered it: write NOTHING. */
  | "not-observed"
  /** The ledger refused the write (a conflict, or an unreadable existing row). */
  | "refused"
  /** The playlist could not be read at all. */
  | "no-playlist";

export type PodExposureDecision = {
  podId: string;
  channelId: string;
  outcome: PodExposureOutcome;
  observed?: AiredInterval;
  record?: PodExposureRecord;
  detail?: string;
};

/**
 * Records one pod's exposure from an already-parsed playlist.
 *
 * Pure decision + one ledger write, so a caller can test the whole path without
 * a filesystem or a timer.
 */
export function recordObservedPod(input: {
  ledger: AiringLedger;
  pod: ScheduledPod;
  advertised: readonly AdvertisedSegment[];
  observedAt?: string;
  toleranceMs?: number;
}): PodExposureDecision {
  const observed = observedPodInterval(
    { startMs: input.pod.startMs, endMs: input.pod.endMs },
    input.advertised,
    { toleranceMs: input.toleranceMs },
  );
  if (observed === null) {
    // No evidence the pod's start ever went out. Recording anything here would
    // be inventing airtime, so the honest outcome is to record nothing at all.
    return {
      podId: input.pod.podId,
      channelId: input.pod.channelId,
      outcome: "not-observed",
      detail: "the pod's start was not covered by any advertised segment",
    };
  }

  const result = input.ledger.recordPodExposure({
    // Stable per pod occurrence, so every later pass is a replay rather than a
    // second record.
    exposureId: input.pod.podId,
    podId: input.pod.podId,
    channelId: input.pod.channelId,
    members: input.pod.members,
    aired: observed,
    // `observed` is in absolute time, so the pod's own start is what the member
    // layout must be measured against.
    podStartMs: input.pod.startMs,
    at: input.observedAt,
  });

  if (!result.ok) {
    return {
      podId: input.pod.podId,
      channelId: input.pod.channelId,
      outcome: "refused",
      observed,
      detail: `${result.reason}: ${result.detail}`,
    };
  }
  return {
    podId: input.pod.podId,
    channelId: input.pod.channelId,
    outcome: result.created ? "recorded" : "already-recorded",
    observed,
    record: result.value,
  };
}

/**
 * What one pass saw, per channel. An observer that reports nothing when it finds
 * nothing is indistinguishable from one that is not running, and "no pods were
 * observable" is the likely outcome on a playlist that only spans the current
 * session - so every pass says what it looked at.
 */
export type PodExposurePassSummary = {
  channelId: string;
  podsConsidered: number;
  recorded: number;
  alreadyRecorded: number;
  notObserved: number;
  refused: number;
  noPlaylist: number;
};

export type PodExposureObserverOptions = {
  /** Root of the per-channel HLS stream directories. */
  streamsRoot: string;
  /**
   * The stream directory for a channel. Defaults to `stream_<channel.id>`, but a
   * MarkTV channel id is NOT its Tunarr channel UUID, so production must map it.
   */
  streamsDirectoryFor?: (channel: { id: string }) => string | null;
  /** Name of the media playlist inside the stream directory. */
  playlistName?: string;
  intervalMs?: number;
  /**
   * How far back a pod is still worth evaluating. The evidence is the channel's
   * playlist, which only reaches back over the current session, so walking every
   * stored generation of every date would build and discard a large amount of
   * "not observed" work for pods that cannot be evidenced. Two days is generous
   * against a playlist that spans hours.
   */
  lookbackMs?: number;
  now?: () => Date;
  onDecision?: (decision: PodExposureDecision) => void;
  /** Called once per channel per pass, whatever the outcome, for auditability. */
  onPass?: (summary: PodExposurePassSummary) => void;
  onError?: (error: unknown, channelId?: string) => void;
};

export type PodExposureObserver = {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
};

export function createPodExposureObserver(
  repositories: Repositories,
  ledger: AiringLedger,
  options: PodExposureObserverOptions,
): PodExposureObserver {
  const intervalMs = options.intervalMs ?? 300_000;
  const lookbackMs = options.lookbackMs ?? 48 * 3_600_000;
  const playlistName = options.playlistName ?? "stream.m3u8";
  const now = options.now ?? (() => new Date());
  const onDecision = options.onDecision ?? (() => undefined);
  const onPass = options.onPass ?? (() => undefined);
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

  const pass = async () => {
    const at = now();
    for (const channel of repositories.channels.list()) {
      if (!channel.enabled) continue;
      try {
        const pods = newestSchedulePerDate(repositories, channel.id)
          .flatMap(({ date, schedule }) =>
            scheduledPods(schedule.entries, { channelId: channel.id }).map(
              (pod) => ({
                ...pod,
                // Keep the broadcast date in the id: the same wall-clock instant can
                // legitimately carry different content on different days, and a pod
                // is per occurrence, not per clock reading.
                podId: `${pod.podId}@${date}`,
              }),
            ),
          )
          // Only pods whose window has fully passed - see the module note on why
          // an in-progress pod must not be frozen into a record - and only recent
          // ones, since the playlist cannot evidence anything older.
          .filter((pod) => pod.endMs <= at.getTime())
          .filter((pod) => pod.endMs >= at.getTime() - lookbackMs);
        if (pods.length === 0) continue;

        const directory = options.streamsDirectoryFor
          ? options.streamsDirectoryFor(channel)
          : `stream_${channel.id}`;
        if (directory === null) continue;

        const counts: PodExposurePassSummary = {
          channelId: channel.id,
          podsConsidered: pods.length,
          recorded: 0,
          alreadyRecorded: 0,
          notObserved: 0,
          refused: 0,
          noPlaylist: 0,
        };
        const tally = (decision: PodExposureDecision) => {
          if (decision.outcome === "recorded") counts.recorded += 1;
          else if (decision.outcome === "already-recorded")
            counts.alreadyRecorded += 1;
          else if (decision.outcome === "not-observed") counts.notObserved += 1;
          else if (decision.outcome === "refused") counts.refused += 1;
          else counts.noPlaylist += 1;
          onDecision(decision);
        };

        let advertised: AdvertisedSegment[] | undefined;
        for (const pod of pods) {
          if (advertised === undefined) {
            try {
              const text = await readFile(
                join(options.streamsRoot, directory, playlistName),
                "utf-8",
              );
              advertised = parseAdvertisedSegments(text);
            } catch {
              tally({
                podId: pod.podId,
                channelId: channel.id,
                outcome: "no-playlist",
                detail: `${directory}/${playlistName} could not be read`,
              });
              // One unreadable playlist is the whole channel's answer for this pass.
              counts.podsConsidered = 1;
              break;
            }
          }
          tally(
            recordObservedPod({
              ledger,
              pod,
              advertised,
              observedAt: at.toISOString(),
            }),
          );
        }
        onPass(counts);
      } catch (error) {
        onError(error, channel.id);
      }
    }
  };

  const runOnce = async () => {
    if (stopping) return;
    if (inFlight) return inFlight;
    inFlight = pass()
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

/**
 * The newest stored generation of each broadcast date a channel has.
 *
 * Per DATE, not the most recently written row: `schedules.latest` is insertion
 * order, and the quiet-hours pass writes tomorrow's schedule, so "the newest row"
 * is often not the one a channel is airing. `latestForDate` is the accessor that
 * means "the schedule for a given day", which is what a pod belongs to.
 */
function newestSchedulePerDate(
  repositories: Repositories,
  channelId: string,
): Array<{ date: string; schedule: Schedule }> {
  const byDate = new Map<string, Schedule>();
  for (const schedule of repositories.schedules.list(channelId)) {
    const existing = byDate.get(schedule.date);
    if (existing === undefined || schedule.generatedAt > existing.generatedAt) {
      byDate.set(schedule.date, schedule);
    }
  }
  return [...byDate.entries()].map(([date, schedule]) => ({ date, schedule }));
}
