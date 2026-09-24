#!/usr/bin/env node
/** Passive, append-only MarkTV producer observation. Never starts a stream. */
import { readFile, stat, mkdir, appendFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const tunarr = 'http://127.0.0.1:8000';
const streamsRoot = join(os.homedir(), 'Library/Preferences/tunarr/streams');
const logRoot = join(os.homedir(), 'marktv-ops/autopilot-soak');

export function parsePlaylist(body) {
  const lines = body.split(/\r?\n/);
  const segments = [];
  let duration = null;
  let programDateTime = null;
  let discontinuity = false;
  for (const line of lines) {
    if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) programDateTime = Date.parse(line.slice(25));
    else if (line && !line.startsWith('#')) {
      if (Number.isFinite(duration) && Number.isFinite(programDateTime))
        segments.push({ uri: line, duration, startMs: programDateTime, discontinuity });
      duration = null;
      programDateTime = null;
      discontinuity = false;
    }
  }
  return { segments, endlist: lines.includes('#EXT-X-ENDLIST') };
}

export function summarizePlaylist(parsed, nowMs) {
  const segments = parsed.segments;
  const recent = segments.slice(-30);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].discontinuity) continue;
    const delta = recent[i].startMs - (recent[i - 1].startMs + recent[i - 1].duration * 1000);
    if (Math.abs(delta) > 600) gaps.push({ after: recent[i - 1].uri, deltaMs: Math.round(delta) });
  }
  const last = segments.at(-1);
  return {
    segmentCount: segments.length,
    lastUri: last?.uri ?? null,
    lastProgramDateTime: last ? new Date(last.startMs).toISOString() : null,
    producerRunwaySeconds: last ? Math.round((last.startMs + last.duration * 1000 - nowMs) / 1000) : null,
    recentTimelineGaps: gaps,
    endlist: parsed.endlist,
  };
}

function sessionCount(value) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((count, session) => count + (session.numConnections ?? session.connections?.length ?? 0), 0);
}

async function getJson(path) {
  const response = await fetch(`${tunarr}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function observeChannel(channel, sessions, nowMs) {
  const connections = sessionCount(sessions[channel.id]);
  const base = { channelId: channel.id, number: channel.number, name: channel.name, connections, streamMode: channel.streamMode };
  if (!connections) return { ...base, state: 'idle_unobserved' };
  const directory = join(streamsRoot, `stream_${channel.id}`);
  let body;
  try { body = await readFile(join(directory, 'stream.m3u8'), 'utf8'); }
  catch (error) { return { ...base, state: 'playlist_unavailable', error: String(error) }; }
  const parsed = parsePlaylist(body);
  const summary = summarizePlaylist(parsed, nowMs);
  const missingRecent = [];
  for (const segment of parsed.segments.slice(-30)) {
    const filename = basename(segment.uri);
    if (!/^data\d+\.(ts|mp4)$/.test(filename)) continue;
    try {
      const file = await stat(join(directory, filename));
      if (!file.isFile() || file.size === 0) missingRecent.push(filename);
    } catch { missingRecent.push(filename); }
  }
  return { ...base, state: missingRecent.length || summary.endlist || summary.recentTimelineGaps.length ? 'degraded' : 'producing', ...summary, missingRecent };
}

export async function recordOnce(now = new Date()) {
  const record = { at: now.toISOString(), source: 'raw_local_hls_playlist', activeProbe: false, channels: [], host: { loadavg: os.loadavg() } };
  try {
    const [channels, sessions] = await Promise.all([getJson('/api/channels'), getJson('/api/sessions')]);
    if (!Array.isArray(channels) || typeof sessions !== 'object' || sessions === null)
      throw new Error('Unexpected Tunarr channels or sessions response');
    record.channels = await Promise.all(channels.map((channel) => observeChannel(channel, sessions, now.getTime())));
  } catch (error) {
    record.error = String(error);
  }
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  const path = join(logRoot, `${record.at.slice(0, 10)}.jsonl`);
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const record = await recordOnce();
  process.stdout.write(`${JSON.stringify({ at: record.at, error: record.error, channels: record.channels.map(({ number, state, connections }) => ({ number, state, connections })) })}\n`);
}
