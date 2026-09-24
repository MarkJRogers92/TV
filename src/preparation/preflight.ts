import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PreparationSourceVersion } from "./models.js";
import { readSourceVersion, sourceVersionsEqual } from "./sourceVersion.js";

const execFileAsync = promisify(execFile);

export const PREFLIGHT_TIMEOUT_MS = 30_000;
export const PREFLIGHT_MAX_BUFFER_BYTES = 256 * 1024;
export const PREFLIGHT_SAMPLE_COUNT = 3;
export const PREFLIGHT_SAMPLE_SECONDS = 2;

export type PreflightRunnerOptions = { timeout: number; maxBuffer: number; shell: false };
export type PreflightRunner = (
  file: string,
  args: readonly string[],
  options: PreflightRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;
export type PreflightLevel = "metadata" | "sampled" | "full";
export type EvidenceStatus = "passed" | "failed" | "unavailable" | "deferred";

export type PreflightTrack = {
  index: number;
  type: "video" | "audio";
  codec: string | null;
  selected: boolean;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  startTimeSeconds: number | null;
  durationSeconds: number | null;
};

export type PreflightMetadata = {
  status: EvidenceStatus;
  durationSeconds: number | null;
  tracks: PreflightTrack[];
  selectedVideoTrackIndex: number | null;
  selectedAudioTrackIndex: number | null;
  reason?: string;
};

export type DecodeEvidence = {
  status: EvidenceStatus;
  testedRanges: Array<{ startSeconds: number; durationSeconds: number }>;
  reason?: string;
};

export type PreflightEvidence = {
  requestedLevel: PreflightLevel;
  result: "metadata_only" | "sampled" | "fully_decoded" | "decode_error" | "unavailable" | "stale_source";
  sourceBefore: PreparationSourceVersion | null;
  sourceAfter: PreparationSourceVersion | null;
  sourceUnchanged: boolean | null;
  metadata: PreflightMetadata;
  sampledDecode: DecodeEvidence;
  fullDecode: DecodeEvidence;
};

export type PreflightOptions = {
  level?: PreflightLevel;
  runner?: PreflightRunner;
  statFile?: (path: string) => Promise<PreparationSourceVersion>;
  timeoutMs?: number;
  maxBufferBytes?: number;
};

type ProbePayload = {
  format?: { duration?: unknown };
  streams?: Array<{
    index?: unknown;
    codec_type?: unknown;
    codec_name?: unknown;
    width?: unknown;
    height?: unknown;
    sample_rate?: unknown;
    channels?: unknown;
    start_time?: unknown;
    duration?: unknown;
    disposition?: { default?: unknown; attached_pic?: unknown };
  }>;
};

const runInstalled = (file: string, args: readonly string[], options: PreflightRunnerOptions) =>
  execFileAsync(file, [...args], options);

function numeric(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorReason(error: unknown): string {
  if (error && typeof error === "object") {
    const code = "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return "media_or_tool_unavailable";
    if (code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "probe_or_decode_limit";
    if ("killed" in error && error.killed) return "probe_or_decode_limit";
  }
  return "probe_or_decode_failed";
}

function unavailableReason(reason: string) {
  return reason === "media_or_tool_unavailable" || reason === "probe_or_decode_limit";
}

function buildTracks(payload: ProbePayload): PreflightTrack[] {
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const typed = streams.flatMap((stream, ordinal) => {
    if (stream.codec_type !== "video" && stream.codec_type !== "audio") return [];
    const type: PreflightTrack["type"] = stream.codec_type;
    const index = numeric(stream.index);
    // Embedded cover art (`attached_pic`) is a still picture, not a video track.
    // Without this an audio-only file with artwork passes metadata as having a
    // readable video stream and can even "decode" cleanly.
    if (type === "video" && numeric(stream.disposition?.attached_pic) === 1) return [];
    return [{
      index: index === null ? ordinal : index,
      type,
      codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
      selected: false,
      ...(numeric(stream.width) !== null ? { width: numeric(stream.width)! } : {}),
      ...(numeric(stream.height) !== null ? { height: numeric(stream.height)! } : {}),
      ...(numeric(stream.sample_rate) !== null ? { sampleRate: numeric(stream.sample_rate)! } : {}),
      ...(numeric(stream.channels) !== null ? { channels: numeric(stream.channels)! } : {}),
      startTimeSeconds: numeric(stream.start_time),
      durationSeconds: numeric(stream.duration),
      default: numeric(stream.disposition?.default) === 1,
    }];
  });
  for (const type of ["video", "audio"] as const) {
    const candidates = typed.filter((track) => track.type === type);
    const chosen = candidates.find((track) => track.default) ?? candidates[0];
    if (chosen) chosen.selected = true;
  }
  return typed.map(({ default: _default, ...track }) => track);
}

function sampleRanges(durationSeconds: number): Array<{ startSeconds: number; durationSeconds: number }> {
  const rangeDuration = Math.min(PREFLIGHT_SAMPLE_SECONDS, durationSeconds);
  if (durationSeconds <= rangeDuration) return [{ startSeconds: 0, durationSeconds: rangeDuration }];
  const starts = [0, Math.max(0, durationSeconds / 2 - rangeDuration / 2), durationSeconds - rangeDuration];
  return [...new Set(starts.map((start) => Math.round(start * 1_000) / 1_000))]
    .slice(0, PREFLIGHT_SAMPLE_COUNT)
    .map((startSeconds) => ({ startSeconds, durationSeconds: rangeDuration }));
}

function deferredDecode(): DecodeEvidence {
  return { status: "deferred", testedRanges: [] };
}

/** Collects graded read-only validation evidence. Passing metadata or sampled checks never means full decode health. */
export async function collectPreflightEvidence(path: string, options: PreflightOptions = {}): Promise<PreflightEvidence> {
  const requestedLevel = options.level ?? "metadata";
  const runner = options.runner ?? runInstalled;
  const timeout = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? PREFLIGHT_MAX_BUFFER_BYTES;
  const runOptions: PreflightRunnerOptions = { timeout, maxBuffer, shell: false };
  let sourceBefore: PreparationSourceVersion | null = null;
  let sourceAfter: PreparationSourceVersion | null = null;
  let sourceUnchanged: boolean | null = null;
  let sourceRecheckFailed = false;
  const metadata: PreflightMetadata = {
    status: "unavailable", durationSeconds: null, tracks: [],
    selectedVideoTrackIndex: null, selectedAudioTrackIndex: null, reason: "source_unavailable",
  };
  let sampledDecode = deferredDecode();
  let fullDecode = deferredDecode();
  let result: PreflightEvidence["result"] = "unavailable";

  try {
    sourceBefore = await (options.statFile ?? readSourceVersion)(path);
    const { stdout } = await runner("ffprobe", [
      "-v", "error", "-show_entries",
      "format=duration:stream=index,codec_type,codec_name,width,height,sample_rate,channels,start_time,duration:stream_disposition=default:stream_disposition=attached_pic",
      "-of", "json", "--", path,
    ], runOptions);
    const payload = JSON.parse(stdout) as ProbePayload;
    const tracks = buildTracks(payload);
    // Container duration is preferred, but fragmented/MPEG-TS sources can omit
    // it while still reporting per-stream durations, so fall back to the longest
    // known stream rather than declaring the file unusable.
    let durationSeconds = numeric(payload.format?.duration);
    if (durationSeconds === null || durationSeconds <= 0) {
      const streamDurations = tracks
        .map((track) => track.durationSeconds)
        .filter((value): value is number => value !== null && value > 0);
      if (streamDurations.length) durationSeconds = Math.max(...streamDurations);
    }
    const video = tracks.find((track) => track.type === "video" && track.selected);
    const audio = tracks.find((track) => track.type === "audio" && track.selected);
    if (durationSeconds === null || durationSeconds <= 0 || !video) {
      metadata.status = "unavailable";
      metadata.reason = !video ? "no_readable_video_track" : "no_usable_duration";
    } else {
      metadata.status = "passed";
      metadata.reason = undefined;
    }
    metadata.durationSeconds = durationSeconds;
    metadata.tracks = tracks;
    metadata.selectedVideoTrackIndex = video?.index ?? null;
    metadata.selectedAudioTrackIndex = audio?.index ?? null;

    if (metadata.status === "passed" && requestedLevel !== "metadata") {
      const ranges = requestedLevel === "sampled" ? sampleRanges(durationSeconds!) : [];
      if (requestedLevel === "sampled") {
        sampledDecode = { status: "passed", testedRanges: [] };
        for (const range of ranges) {
          const args = ["-v", "error", "-xerror", "-ss", range.startSeconds.toFixed(3), "-i", path,
            "-t", range.durationSeconds.toFixed(3), "-map", `0:${video!.index}`];
          if (audio) args.push("-map", `0:${audio.index}`);
          args.push("-f", "null", "-");
          try {
            await runner("ffmpeg", args, runOptions);
            sampledDecode.testedRanges.push(range);
          } catch (error) {
            const reason = errorReason(error);
            sampledDecode = { status: unavailableReason(reason) ? "unavailable" : "failed", testedRanges: [...sampledDecode.testedRanges, range], reason };
            break;
          }
        }
      }
      if (requestedLevel === "full") {
        fullDecode = { status: "passed", testedRanges: [{ startSeconds: 0, durationSeconds: durationSeconds! }] };
        const args = ["-v", "error", "-xerror", "-i", path, "-map", `0:${video!.index}`];
        if (audio) args.push("-map", `0:${audio.index}`);
        args.push("-f", "null", "-");
        try {
          await runner("ffmpeg", args, runOptions);
        } catch (error) {
          const reason = errorReason(error);
          fullDecode = { status: unavailableReason(reason) ? "unavailable" : "failed", testedRanges: fullDecode.testedRanges, reason };
        }
      }
    }
  } catch (error) {
    const reason = errorReason(error);
    metadata.reason = reason;
    metadata.status = unavailableReason(reason) ? "unavailable" : "failed";
  }

  if (sourceBefore) {
    try {
      sourceAfter = await (options.statFile ?? readSourceVersion)(path);
      sourceUnchanged = sourceVersionsEqual(sourceBefore, sourceAfter);
    } catch {
      // Could not re-stat to confirm the source did not change. That is an
      // inability to verify, not evidence the file changed, so fail closed as
      // unavailable rather than reporting a spurious stale_source.
      sourceUnchanged = null;
      sourceRecheckFailed = true;
    }
  }

  if (sourceRecheckFailed) result = "unavailable";
  else if (sourceBefore && sourceUnchanged === false) result = "stale_source";
  else if (metadata.status === "failed" || sampledDecode.status === "failed" || fullDecode.status === "failed") result = "decode_error";
  else if (metadata.status !== "passed" || sampledDecode.status === "unavailable" || fullDecode.status === "unavailable") result = "unavailable";
  else if (fullDecode.status === "passed") result = "fully_decoded";
  else if (sampledDecode.status === "passed") result = "sampled";
  else result = "metadata_only";

  return { requestedLevel, result, sourceBefore, sourceAfter, sourceUnchanged, metadata, sampledDecode, fullDecode };
}
