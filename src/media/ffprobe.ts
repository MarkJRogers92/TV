import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeResult } from './adapter.js';

const executeFile = promisify(execFile);

export const FFPROBE_TIMEOUT_MS = 15_000;
export const FFPROBE_MAX_BUFFER_BYTES = 1_048_576;

export type FfprobeExecResult = { stdout: string; stderr: string };
export type FfprobeExecOptions = { timeout: number; maxBuffer: number; shell: false };
export type FfprobeExecFile = (
  file: string,
  args: readonly string[],
  options: FfprobeExecOptions,
) => Promise<FfprobeExecResult>;

export type ProbeDurationOptions = {
  runner?: FfprobeExecFile;
  timeoutMs?: number;
  maxBufferBytes?: number;
};

const defaultRunner: FfprobeExecFile = (file, args, options) =>
  executeFile(file, [...args], options);

function resolveRunner(options: ProbeDurationOptions): { runner: FfprobeExecFile; timeout: number; maxBuffer: number } {
  return {
    runner: options.runner ?? defaultRunner,
    timeout: options.timeoutMs ?? FFPROBE_TIMEOUT_MS,
    maxBuffer: options.maxBufferBytes ?? FFPROBE_MAX_BUFFER_BYTES,
  };
}

export async function probeDuration(path: string, options: ProbeDurationOptions = {}): Promise<ProbeResult> {
  const { runner, timeout, maxBuffer } = resolveRunner(options);
  try {
    const { stdout } = await runner(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', '--', path],
      { timeout, maxBuffer, shell: false },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: unknown };
      streams?: Array<{ codec_type?: unknown }>;
    };
    const seconds = Number(parsed.format?.duration);
    const hasVideoStream =
      Array.isArray(parsed.streams) && parsed.streams.some((stream) => stream?.codec_type === 'video');
    if (Number.isFinite(seconds) && seconds > 0 && hasVideoStream)
      return { durationMs: Math.round(seconds * 1_000), hasVideoStream: true };
    return {
      durationMs: null,
      hasVideoStream,
      reason: hasVideoStream ? 'ffprobe returned no usable duration' : 'ffprobe returned no readable video stream',
    };
  } catch {
    return { durationMs: null, reason: 'ffprobe unavailable or failed' };
  }
}
