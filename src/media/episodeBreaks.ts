import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat as fileStat } from "node:fs/promises";
import { promisify } from "node:util";
import type { EpisodeMidrollPolicy, MediaItem } from "../domain/models.js";

const executeFile = promisify(execFile);
const ANALYZER_VERSION = 1;
const MINIMUM_BLACK_MS = 120;
const MAXIMUM_BLACK_MS = 3_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const FFMPEG_MAX_BUFFER_BYTES = 1_048_576;

export type EpisodeBreakAnalysis = {
  offsetsMs: number[];
  fallbackTargetIndexes: number[];
};

export function episodeBreakAnalysisKey(
  mediaId: string,
  policy: EpisodeMidrollPolicy,
) {
  return `${mediaId}:${createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex")}`;
}

export type BlackInterval = { startMs: number; endMs: number };

export type SelectEpisodeBreakOffsetsInput = {
  durationMs: number;
  targetsMs: number[];
  searchWindowMs: number;
  minimumSegmentMs: number;
  tailBufferMs: number;
  candidates: BlackInterval[];
};

export function selectEpisodeBreakOffsets(
  input: SelectEpisodeBreakOffsetsInput,
): EpisodeBreakAnalysis {
  const offsetsMs: number[] = [];
  const fallbackTargetIndexes: number[] = [];
  let previousOffset = 0;
  input.targetsMs.forEach((targetMs, targetIndex) => {
    const candidates = input.candidates
      .map((candidate) => ({
        ...candidate,
        durationMs: candidate.endMs - candidate.startMs,
        offsetMs: Math.round((candidate.startMs + candidate.endMs) / 2),
      }))
      .filter(
        (candidate) =>
          candidate.durationMs >= MINIMUM_BLACK_MS &&
          candidate.durationMs <= MAXIMUM_BLACK_MS &&
          Math.abs(candidate.offsetMs - targetMs) <= input.searchWindowMs &&
          candidate.offsetMs - previousOffset >= input.minimumSegmentMs &&
          input.durationMs - candidate.offsetMs >= input.tailBufferMs,
      )
      .sort(
        (left, right) =>
          Math.abs(left.offsetMs - targetMs) -
            Math.abs(right.offsetMs - targetMs) ||
          left.offsetMs - right.offsetMs,
      );
    const selected = candidates[0]?.offsetMs ?? targetMs;
    if (!candidates.length) fallbackTargetIndexes.push(targetIndex);
    offsetsMs.push(selected);
    previousOffset = selected;
  });
  return { offsetsMs, fallbackTargetIndexes };
}

export type EpisodeBreakRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; shell: false },
) => Promise<{ stdout: string; stderr: string }>;

export type EpisodeBreakCache = {
  get(key: string): unknown;
  put(key: string, value: EpisodeBreakAnalysis): unknown;
};

type EpisodeBreakAnalyzerOptions = {
  runner?: EpisodeBreakRunner;
  stat?: (path: string) => Promise<{
    size: number;
    mtimeMs: number;
    dev?: number | bigint;
    ino?: number | bigint;
  }>;
  cache: EpisodeBreakCache;
};

const defaultRunner: EpisodeBreakRunner = (file, args, options) =>
  executeFile(file, [...args], options);

function parseBlackIntervals(stderr: string, windowStartMs: number) {
  const intervals: BlackInterval[] = [];
  const pattern = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g;
  for (const match of stderr.matchAll(pattern)) {
    const startMs = windowStartMs + Math.round(Number(match[1]) * 1_000);
    const endMs = windowStartMs + Math.round(Number(match[2]) * 1_000);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)
      intervals.push({ startMs, endMs });
  }
  return intervals;
}

function validCachedAnalysis(value: unknown): value is EpisodeBreakAnalysis {
  if (!value || typeof value !== "object") return false;
  const analysis = value as EpisodeBreakAnalysis;
  return (
    Array.isArray(analysis.offsetsMs) &&
    analysis.offsetsMs.length === 2 &&
    analysis.offsetsMs.every(
      (offset) => Number.isInteger(offset) && offset > 0,
    ) &&
    Array.isArray(analysis.fallbackTargetIndexes) &&
    new Set(analysis.fallbackTargetIndexes).size ===
      analysis.fallbackTargetIndexes.length &&
    analysis.fallbackTargetIndexes.every(
      (index) => Number.isInteger(index) && index >= 0 && index < 2,
    )
  );
}

export class EpisodeBreakAnalyzer {
  private readonly runner: EpisodeBreakRunner;
  private readonly stat: (path: string) => Promise<{
    size: number;
    mtimeMs: number;
    dev?: number | bigint;
    ino?: number | bigint;
  }>;
  private readonly cache: EpisodeBreakCache;

  constructor(options: EpisodeBreakAnalyzerOptions) {
    this.runner = options.runner ?? defaultRunner;
    this.stat = options.stat ?? fileStat;
    this.cache = options.cache;
  }

  async analyze(
    item: MediaItem,
    policy: EpisodeMidrollPolicy,
  ): Promise<EpisodeBreakAnalysis> {
    const targetsMs = policy.targetMinutes.map((minutes) =>
      Math.round(Number(minutes) * 60_000),
    );
    const fallback = (): EpisodeBreakAnalysis => ({
      offsetsMs: targetsMs,
      fallbackTargetIndexes: targetsMs.map((_, index) => index),
    });
    if (!item.path || !item.durationMs) return fallback();

    let identity;
    try {
      const metadata = await this.stat(item.path);
      identity = {
        analyzerVersion: ANALYZER_VERSION,
        mediaId: item.id,
        path: item.path,
        durationMs: item.durationMs,
        revision: item.revision ?? null,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        dev: metadata.dev?.toString() ?? null,
        ino: metadata.ino?.toString() ?? null,
        policy,
      };
    } catch {
      return fallback();
    }
    const cacheKey = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    const cached = this.cache.get(cacheKey);
    if (validCachedAnalysis(cached)) return cached;

    const searchWindowMs = Math.round(policy.searchWindowMinutes * 60_000);
    const candidates: BlackInterval[] = [];
    let executionFailed = false;
    for (const targetMs of targetsMs) {
      const windowStartMs = Math.max(0, targetMs - searchWindowMs);
      const windowEndMs = Math.min(item.durationMs, targetMs + searchWindowMs);
      try {
        const { stderr } = await this.runner(
          "ffmpeg",
          [
            "-hide_banner",
            "-nostats",
            "-nostdin",
            "-ss",
            String(windowStartMs / 1_000),
            "-t",
            String((windowEndMs - windowStartMs) / 1_000),
            "-i",
            item.path,
            "-vf",
            "setpts=PTS-STARTPTS,blackdetect=d=0.05:pic_th=0.90:pix_th=0.10",
            "-an",
            "-f",
            "null",
            "-",
          ],
          {
            timeout: FFMPEG_TIMEOUT_MS,
            maxBuffer: FFMPEG_MAX_BUFFER_BYTES,
            shell: false,
          },
        );
        candidates.push(...parseBlackIntervals(stderr, windowStartMs));
      } catch {
        executionFailed = true;
      }
    }
    const analysis = selectEpisodeBreakOffsets({
      durationMs: item.durationMs,
      targetsMs,
      searchWindowMs,
      minimumSegmentMs: Math.round(policy.minimumSegmentMinutes * 60_000),
      tailBufferMs: Math.round(policy.tailBufferMinutes * 60_000),
      candidates,
    });
    if (!executionFailed) this.cache.put(cacheKey, analysis);
    return analysis;
  }
}
