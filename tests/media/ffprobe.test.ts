import { describe, expect, test, vi } from 'vitest';
import {
  FFPROBE_MAX_BUFFER_BYTES,
  FFPROBE_TIMEOUT_MS,
  probeDuration,
  type FfprobeExecFile,
} from '../../src/media/ffprobe.js';

function jsonRunner(stdout: string): FfprobeExecFile {
  return vi.fn(async () => ({ stdout, stderr: '' }));
}

function videoJson(duration: unknown): string {
  return JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video' }] });
}

describe('probeDuration', () => {
  test('returns duration plus video flag for a valid probe', async () => {
    const result = await probeDuration('/media/episode.mkv', { runner: jsonRunner(videoJson('123.456')) });
    expect(result).toEqual({ durationMs: 123456, hasVideoStream: true });
  });

  test('rejects audio-only output as unavailable without a video stream', async () => {
    const stdout = JSON.stringify({ format: { duration: '60' }, streams: [{ codec_type: 'audio' }] });
    const result = await probeDuration('/media/audio.mkv', { runner: jsonRunner(stdout) });
    expect(result.durationMs).toBeNull();
    expect(result.hasVideoStream).toBe(false);
    expect(result.reason).toBe('ffprobe returned no readable video stream');
  });

  test('rejects missing duration while keeping the video flag', async () => {
    const stdout = JSON.stringify({ format: {}, streams: [{ codec_type: 'video' }] });
    const result = await probeDuration('/media/no-duration.mkv', { runner: jsonRunner(stdout) });
    expect(result).toMatchObject({ durationMs: null, hasVideoStream: true });
    expect(result.reason).toBe('ffprobe returned no usable duration');
  });

  test('rejects zero, negative, and non-finite durations', async () => {
    for (const duration of ['0', '-5', 'Infinity', 'NaN']) {
      const result = await probeDuration('/media/bad.mkv', { runner: jsonRunner(videoJson(duration)) });
      expect(result.durationMs).toBeNull();
      expect(result.reason).toBe('ffprobe returned no usable duration');
    }
  });

  test('returns safe unavailable result for malformed JSON without reflecting output', async () => {
    const evil = 'SECRET-OUTPUT-/media/evil.mkv';
    const result = await probeDuration('/media/evil.mkv', { runner: jsonRunner(`not json ${evil}{`) });
    expect(result).toEqual({ durationMs: null, reason: 'ffprobe unavailable or failed' });
    expect(JSON.stringify(result)).not.toContain(evil);
    expect(JSON.stringify(result)).not.toContain('/media/evil.mkv');
  });

  test('returns safe unavailable result for nonzero exit without reflecting process output', async () => {
    const runner: FfprobeExecFile = vi.fn(async () => {
      const error = new Error('SECRET-STDERR-/media/fail.mkv');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    });
    const result = await probeDuration('/media/fail.mkv', { runner });
    expect(result).toEqual({ durationMs: null, reason: 'ffprobe unavailable or failed' });
    expect(JSON.stringify(result)).not.toContain('SECRET-STDERR');
    expect(JSON.stringify(result)).not.toContain('/media/fail.mkv');
  });

  test('returns safe unavailable result for timeout without reflecting the path', async () => {
    const runner: FfprobeExecFile = vi.fn(async () => {
      const error = new Error('ffprobe timed out SECRET');
      (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      throw error;
    });
    const result = await probeDuration('/media/slow.mkv', { runner });
    expect(result).toEqual({ durationMs: null, reason: 'ffprobe unavailable or failed' });
    expect(JSON.stringify(result)).not.toContain('/media/slow.mkv');
  });

  test('returns safe unavailable result for oversized output without reflecting the path', async () => {
    const runner: FfprobeExecFile = vi.fn(async () => {
      const error = new Error('maxBuffer exceeded SECRET');
      (error as NodeJS.ErrnoException).code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      throw error;
    });
    const result = await probeDuration('/media/huge.mkv', { runner });
    expect(result).toEqual({ durationMs: null, reason: 'ffprobe unavailable or failed' });
    expect(JSON.stringify(result)).not.toContain('/media/huge.mkv');
  });

  test('invokes ffprobe with duration plus codec entries, path delimiter, timeout, buffer, and no shell', async () => {
    const runner: FfprobeExecFile = vi.fn(async () => ({ stdout: videoJson('10'), stderr: '' }));
    await probeDuration('/media/episode.mkv', { runner });
    expect(runner).toHaveBeenCalledOnce();
    const [file, args, options] = vi.mocked(runner).mock.calls[0];
    expect(file).toBe('ffprobe');
    expect(args).toContain('-show_entries');
    const showEntries = args[args.indexOf('-show_entries') + 1];
    expect(showEntries).toContain('format=duration');
    expect(showEntries).toContain('stream=codec_type');
    expect(args).toContain('-of');
    expect(args[args.indexOf('-of') + 1]).toBe('json');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('/media/episode.mkv');
    expect(options).toMatchObject({ timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_BUFFER_BYTES, shell: false });
    expect(FFPROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FFPROBE_MAX_BUFFER_BYTES).toBeGreaterThan(0);
  });

  test('honors injected timeout and buffer overrides', async () => {
    const runner: FfprobeExecFile = vi.fn(async () => ({ stdout: videoJson('10'), stderr: '' }));
    await probeDuration('/media/episode.mkv', { runner, timeoutMs: 5_000, maxBufferBytes: 65_536 });
    const [, , options] = vi.mocked(runner).mock.calls[0];
    expect(options).toMatchObject({ timeout: 5_000, maxBuffer: 65_536, shell: false });
  });
});
