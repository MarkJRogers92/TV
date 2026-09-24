/**
 * Playout watch: the checks that only time can produce, inside the app.
 *
 * These four checks existed before, but outside the service - in a script that
 * read the stream directory and Tunarr's served playlist every few minutes and
 * wrote its own log. That script found the original rewind, and it is exactly
 * the kind of thing that should not be a second place to look: a diagnostic
 * bundle that misses them is not the thing you save when something looks wrong.
 *
 * So this samples them on a slow cadence and holds the latest result in memory
 * for the status and diagnostic views:
 *
 *  - the newest segment the PRODUCER has written, and when it last changed.
 *    A producer that stops advancing is the earliest visible symptom of most
 *    faults, and it is invisible from the schedule and from the database;
 *  - the newest segment a VIEWER is served, and how far its own
 *    program-date-time sits from the file's for that same segment. A constant
 *    non-zero difference is the expected monotonic repair after a backwards
 *    tag; the defect shape was the SERVED head falling BELOW the producer's;
 *  - the continuity classifier's latest verdict for the channel.
 *
 * Read-only with respect to serving: it reads a file and fetches a playlist.
 * Every failure is reported, never thrown, and a channel that cannot be sampled
 * reports nulls rather than a fabricated healthy reading.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repositories } from "../db/repositories.js";

export type PlayoutSample = {
  channelId: string;
  checkedAt: string;
  /** Newest segment number the producer had written, or null if unreadable. */
  newestSegment: number | null;
  /** When `newestSegment` last changed, or null before the second sample. */
  advancedAt: string | null;
  /** Whether the producer advanced since the previous sample. */
  advancing: boolean;
  /** Newest segment a viewer is served, or null when it could not be read. */
  servedSegment: number | null;
  /**
   * served minus file program-date-time for the served head, in ms. Non-zero is
   * expected (the monotonic repair); the defect was a served head BELOW the file.
   */
  servedDeltaMs: number | null;
  /** The continuity classifier's latest verdict, when one has been produced. */
  health: string | null;
};

/**
 * A reading that is wrong in a way a person should know about.
 *
 * "Served head below the producer's" is the defect shape that started all of
 * this - a viewer offered a live edge the producer had already passed. It is
 * reported as a condition, not as a number to compare by eye, because the whole
 * point is that nobody was comparing them by eye.
 */
export type PlayoutCondition =
  "served-head-below-producer" | "producer-stalled" | "playlist-unreadable";

export type PlayoutAlert = {
  condition: PlayoutCondition | "recovered";
  channelId: string;
  detail: string;
};

export type PlayoutWatchOptions = {
  streamsRoot: string;
  /** Full path to a channel's stream directory, as the watchdog resolves it. */
  streamsDirectoryFor?: (channel: { id: string }) => string | null;
  /** Where a channel's served variant playlist can be fetched, or null. */
  servedUrlFor?: (channelId: string) => string | null;
  /** The classifier's latest verdict per channel, when the watchdog has one. */
  healthFor?: (channelId: string) => string | null;
  intervalMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Consecutive readable-but-static samples before a stall is called. */
  stallSamples?: number;
  onSample?: (sample: PlayoutSample) => void;
  /**
   * Raised on ENTERING a bad condition and on leaving it - never once per
   * sample. A file that repeats "still stalled" every five minutes is a file
   * nobody reads.
   */
  onAlert?: (alert: PlayoutAlert) => void;
  onError?: (error: unknown, channelId?: string) => void;
};

export type PlayoutWatch = {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
  /** The latest sample per channel, in channel order. */
  snapshot(): PlayoutSample[];
};

const PLAYLIST_NAME = "stream.m3u8";

/** Newest `dataNNNNNN.ts` number in a playlist body, or null. */
export function newestSegmentNumber(text: string): number | null {
  let newest: number | null = null;
  for (const match of text.matchAll(/data(\d+)\.ts/g)) {
    const value = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(value) && (newest === null || value > newest)) {
      newest = value;
    }
  }
  return newest;
}

/**
 * The program-date-time of a specific segment, in epoch ms.
 *
 * Same offset form FFmpeg writes (`-0500`, no colon), parsed by hand because
 * Date.parse is not portable on it and a silently misparsed timestamp would
 * report a two-minute rewind that never happened.
 */
export function segmentStartMs(text: string, segment: number): number | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const uri = lines[index];
    if (
      uri === undefined ||
      !uri.includes(`data${String(segment).padStart(6, "0")}.ts`)
    ) {
      continue;
    }
    for (let back = index - 1; back >= 0 && index - back <= 3; back -= 1) {
      const tag = lines[back]?.trim() ?? "";
      if (tag.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
        return parseProgramDateTimeMs(
          tag.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim(),
        );
      }
    }
    return null;
  }
  return null;
}

export function parseProgramDateTimeMs(text: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([+-])(\d{2})(\d{2})$/.exec(
      text,
    );
  if (!match) return null;
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
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fraction ? Number(fraction.padEnd(3, "0")) : 0,
  );
  const offsetMs = (Number(offHour) * 60 + Number(offMinute)) * 60_000;
  return sign === "+" ? utc - offsetMs : utc + offsetMs;
}

/**
 * Is this reading a condition worth telling someone about?
 *
 * Pure and exported so the decision is testable without a filesystem, and so the
 * precedence is explicit: the served-head defect is reported ahead of a stall,
 * because it is the more specific fault and the one a viewer actually feels.
 */
export function evaluatePlayout(
  sample: PlayoutSample,
  previous: PlayoutSample | undefined,
  options: { stalls: number; stallSamples: number },
): PlayoutCondition | null {
  if (
    sample.servedSegment !== null &&
    sample.newestSegment !== null &&
    sample.servedSegment < sample.newestSegment
  ) {
    return "served-head-below-producer";
  }
  // A playlist that WAS readable and now is not is a fault; a channel that has
  // never produced one is simply not started yet.
  if (
    sample.newestSegment === null &&
    (previous?.newestSegment ?? null) !== null
  ) {
    return "playlist-unreadable";
  }
  if (sample.newestSegment !== null && options.stalls >= options.stallSamples) {
    return "producer-stalled";
  }
  return null;
}

/** The line a person reads. Says what was observed, not just which rule fired. */
export function describePlayoutCondition(
  condition: PlayoutCondition | null,
  sample: PlayoutSample,
  previous: PlayoutSample | undefined,
): string {
  switch (condition) {
    case "served-head-below-producer":
      return `viewers are being served segment ${sample.servedSegment} while the producer is already at ${sample.newestSegment}`;
    case "producer-stalled":
      return `the producer has not advanced past segment ${sample.newestSegment} since ${sample.advancedAt ?? "an earlier sample"}`;
    case "playlist-unreadable":
      return `the channel playlist could not be read (last seen at segment ${previous?.newestSegment ?? "unknown"})`;
    default:
      return `serving and production are healthy again (segment ${sample.newestSegment ?? "unknown"})`;
  }
}

export function createPlayoutWatch(
  repositories: Repositories,
  options: PlayoutWatchOptions,
): PlayoutWatch {
  const intervalMs = options.intervalMs ?? 300_000;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const stallSamples = options.stallSamples ?? 2;
  const onSample = options.onSample ?? (() => undefined);
  const onAlert = options.onAlert ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  const samples = new Map<string, PlayoutSample>();
  /** Consecutive readable-but-static samples per channel. */
  const stallCounts = new Map<string, number>();
  /** The condition last announced per channel, so alerts are edge-triggered. */
  const announcedConditions = new Map<string, PlayoutCondition | null>();
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

  const sampleChannel = async (channel: {
    id: string;
  }): Promise<PlayoutSample> => {
    const checkedAt = now().toISOString();
    const previous = samples.get(channel.id);
    const base: PlayoutSample = {
      channelId: channel.id,
      checkedAt,
      newestSegment: null,
      advancedAt: previous?.advancedAt ?? null,
      advancing: false,
      servedSegment: null,
      servedDeltaMs: null,
      health: options.healthFor?.(channel.id) ?? previous?.health ?? null,
    };

    const directory = options.streamsDirectoryFor
      ? options.streamsDirectoryFor(channel)
      : join(options.streamsRoot, `stream_${channel.id}`);
    if (directory === null) {
      // No mapping means no playlist to read: report nulls, never a healthy guess.
      return base;
    }

    let fileText: string | null = null;
    try {
      fileText = await readFile(join(directory, PLAYLIST_NAME), "utf-8");
    } catch {
      onError(new Error(`no playlist at ${directory}`), channel.id);
      return base;
    }

    const newest = newestSegmentNumber(fileText);
    base.newestSegment = newest;
    if (newest !== null && (previous?.newestSegment ?? null) !== newest) {
      base.advancedAt = checkedAt;
    }
    base.advancing =
      previous?.newestSegment !== null &&
      previous?.newestSegment !== undefined &&
      newest !== null &&
      newest > previous.newestSegment;

    const servedUrl = options.servedUrlFor?.(channel.id) ?? null;
    if (servedUrl !== null) {
      try {
        const response = await fetchImpl(servedUrl, {
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { "user-agent": "marktv-playout-watch/1.0" },
        });
        if (response.ok) {
          const servedText = await response.text();
          const served = newestSegmentNumber(servedText);
          base.servedSegment = served;
          if (served !== null) {
            const servedAt = segmentStartMs(servedText, served);
            const fileAt = segmentStartMs(fileText, served);
            if (servedAt !== null && fileAt !== null) {
              base.servedDeltaMs = servedAt - fileAt;
            }
          }
        } else {
          onError(
            new Error(`served playlist returned ${response.status}`),
            channel.id,
          );
        }
      } catch (error) {
        onError(error, channel.id);
      }
    }

    return base;
  };

  const pass = async () => {
    for (const channel of repositories.channels.list()) {
      if (!channel.enabled) continue;
      try {
        const previous = samples.get(channel.id);
        const sample = await sampleChannel(channel);
        samples.set(channel.id, sample);
        onSample(sample);

        // Detection, edge-triggered. The counters live here rather than in the
        // sample so the sample stays a statement of fact about the channel.
        //
        // `advancing` is necessarily false on the FIRST sample - there is nothing
        // to compare against - so requiring a previous reading is what stops a
        // brand-new channel from being announced as stalled. Found by a test that
        // expected silence from a healthy first sample.
        const hadPrevious = (previous?.newestSegment ?? null) !== null;
        const state = stallCounts.get(channel.id) ?? 0;
        stallCounts.set(
          channel.id,
          hadPrevious && sample.newestSegment !== null && !sample.advancing
            ? state + 1
            : 0,
        );
        const condition = evaluatePlayout(sample, previous, {
          stalls: stallCounts.get(channel.id) ?? 0,
          stallSamples,
        });
        const announced = announcedConditions.get(channel.id) ?? null;
        if (condition !== announced) {
          announcedConditions.set(channel.id, condition);
          // Leaving a bad condition is worth knowing too: it is how you learn
          // that the thing you were told about fixed itself.
          onAlert({
            condition: condition ?? "recovered",
            channelId: channel.id,
            detail: describePlayoutCondition(condition, sample, previous),
          });
        }
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
    snapshot() {
      return repositories.channels
        .list()
        .map((channel) => samples.get(channel.id))
        .filter((sample): sample is PlayoutSample => sample !== undefined);
    },
  };
}
