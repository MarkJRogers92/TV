/**
 * Shadow watchdog: sample each channel and report the continuity classifier's
 * verdict WITHOUT acting on it.
 *
 * Stage 4 asks for the watchdog to run in observe-only mode first, so its
 * thresholds can be calibrated against the real host before any restart is
 * allowed. This module does exactly that: it reads each channel's published HLS
 * playlist, turns it into one `ContinuityHealthObservation`, runs the existing
 * classifier, and hands the result to a sink (the app logs it). It never
 * restarts, wakes, or falls back — the recommendation is recorded, not executed.
 *
 * It is deliberately read-only: a missing playlist is reported as unknown rather
 * than as a stalled channel.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Repositories } from "../db/repositories.js";
import {
  evaluateContinuityHealth,
  type ContinuityHealthResult,
  type ContinuityHealthState,
  type ContinuityHealthObservation,
} from "./continuityHealth.js";

export type PlaylistSample = {
  segments: number;
  targetDurationSeconds: number;
  lastAdvanceMs: number;
};

/** Segment count and target duration from an HLS media playlist. */
export function parsePlaylist(text: string): {
  segments: number;
  targetDurationSeconds: number;
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const segments = lines.filter((line) => !line.startsWith("#")).length;
  const target = lines.find((line) => line.startsWith("#EXT-X-TARGETDURATION:"));
  const parsed = target ? Number(target.slice(target.indexOf(":") + 1)) : 0;
  return {
    segments,
    targetDurationSeconds: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
  };
}

/**
 * One observation from the sampled signals. Published runway is the served
 * window (segments x target duration); a producer that stopped advancing past
 * the stall threshold is reported as a missed progress deadline, which is what
 * the classifier uses to tell a planned rest from a stuck worker.
 */
export function buildObservation(input: {
  channelId: string;
  watchdogSessionId: string;
  sampleId: string;
  nowMs: number;
  sessionActive: boolean;
  sample: PlaylistSample;
  stalledAfterSeconds: number;
}): ContinuityHealthObservation {
  return {
    channelId: input.channelId,
    watchdogSessionId: input.watchdogSessionId,
    sampleId: input.sampleId,
    observedAtMs: input.nowMs,
    workerProcessCount: input.sessionActive ? 1 : 0,
    contiguousPublishedRunwaySeconds:
      input.sample.segments * input.sample.targetDurationSeconds,
    scheduledWakeBeforeDepletion: true,
    nextRequiredIntervalAvailable: null,
    progressDeadlineExceeded:
      input.nowMs - input.sample.lastAdvanceMs > input.stalledAfterSeconds * 1_000,
  };
}

export type HealthShadowOptions = {
  /** Root of the per-channel HLS stream directories. */
  streamsRoot: string;
  /**
   * The stream directory for a channel. Defaults to `stream_<channel.id>`, but a
   * MarkTV channel id is NOT its Tunarr channel UUID, so production must map it.
   */
  streamsDirectoryFor?: (channel: { id: string }) => string | null;
  intervalMs?: number;
  stalledAfterSeconds?: number;
  now?: () => Date;
  onResult?: (result: ContinuityHealthResult) => void;
  onError?: (error: unknown, channelId?: string) => void;
};

export type HealthShadow = { start(): Promise<void>; stop(): Promise<void>; runOnce(): Promise<void> };

/** Reads a channel's published media playlist, or null when it does not exist. */
export async function sampleStreams(directory: string): Promise<PlaylistSample | null> {
  const path = join(directory, "stream.m3u8");
  try {
    const [text, stats] = await Promise.all([readFile(path, "utf-8"), stat(path)]);
    const { segments, targetDurationSeconds } = parsePlaylist(text);
    return { segments, targetDurationSeconds, lastAdvanceMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

export function createHealthShadow(
  repositories: Repositories,
  options: HealthShadowOptions,
): HealthShadow {
  const intervalMs = options.intervalMs ?? 60_000;
  const stalledAfterSeconds = options.stalledAfterSeconds ?? 90;
  const now = options.now ?? (() => new Date());
  const onResult = options.onResult ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  const states = new Map<string, ContinuityHealthState>();
  const sessionId = `shadow-${Date.now()}`;
  let sequence = 0;
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
    const nowMs = now().getTime();
    for (const channel of repositories.channels.list()) {
      if (!channel.enabled) continue;
      try {
        const directory = options.streamsDirectoryFor
          ? options.streamsDirectoryFor(channel)
          : join(options.streamsRoot, `stream_${channel.id}`);
        if (!directory) continue;
        const sample = await sampleStreams(directory);
        if (!sample) continue; // no published playlist: nothing to judge yet
        sequence += 1;
        const observation = buildObservation({
          channelId: channel.id,
          watchdogSessionId: sessionId,
          sampleId: `${sessionId}-${sequence}`,
          nowMs,
          sessionActive: nowMs - sample.lastAdvanceMs < stalledAfterSeconds * 1_000,
          sample,
          stalledAfterSeconds,
        });
        const result = evaluateContinuityHealth(
          observation,
          states.get(channel.id),
        );
        states.set(channel.id, result.state);
        onResult(result);
      } catch (error) {
        onError(error, channel.id);
      }
    }
  };

  const runOnce = async () => {
    if (stopping) return;
    if (inFlight) return inFlight;
    inFlight = runPass().catch((error) => onError(error)).finally(() => {
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
