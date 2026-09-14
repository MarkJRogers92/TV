import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeResult } from './adapter.js';

const executeFile = promisify(execFile);

export async function probeDuration(path: string): Promise<ProbeResult> {
  try {
    const { stdout } = await executeFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      '--', path,
    ]);
    const seconds = Number((JSON.parse(stdout) as { format?: { duration?: unknown } }).format?.duration);
    if (Number.isFinite(seconds) && seconds > 0) return { durationMs: Math.round(seconds * 1_000) };
    return { durationMs: null, reason: 'ffprobe returned no usable duration' };
  } catch {
    return { durationMs: null, reason: 'ffprobe unavailable or failed' };
  }
}
