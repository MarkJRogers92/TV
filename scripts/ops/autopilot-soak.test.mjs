import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, summarizePlaylist } from './autopilot-soak.mjs';

const segment = (time, id) => `#EXTINF:4.000,\n#EXT-X-PROGRAM-DATE-TIME:${time}\n/stream/channels/c/hls/data${id}.ts\n`;

test('continuous segments keep a zero gap count and no end marker', () => {
  const playlist = '#EXTM3U\n' + segment('2026-09-24T00:00:00.000Z', '000001') + segment('2026-09-24T00:00:04.000Z', '000002');
  const summary = summarizePlaylist(parsePlaylist(playlist), Date.parse('2026-09-24T00:00:02.000Z'));
  assert.equal(summary.segmentCount, 2);
  assert.deepEqual(summary.recentTimelineGaps, []);
  assert.deepEqual(summary.recentDiscontinuities, []);
  assert.equal(summary.producerRunwaySeconds, 6);
  assert.equal(summary.endlist, false);
});

test('detects a missing interval inside the recent timeline', () => {
  const playlist = '#EXTM3U\n' + segment('2026-09-24T00:00:00.000Z', '000001') + segment('2026-09-24T00:00:12.000Z', '000002');
  const summary = summarizePlaylist(parsePlaylist(playlist), Date.parse('2026-09-24T00:00:12.000Z'));
  assert.equal(summary.recentTimelineGaps.length, 1);
  assert.equal(summary.recentTimelineGaps[0].deltaMs, 8000);
});

test('an explicit discontinuity starts a new timeline comparison', () => {
  const playlist = '#EXTM3U\n' + segment('2026-09-24T00:00:00.000Z', '000001') + '#EXT-X-DISCONTINUITY\n' + segment('2026-09-24T00:01:00.000Z', '000002') + '#EXT-X-ENDLIST\n';
  const summary = summarizePlaylist(parsePlaylist(playlist), Date.parse('2026-09-24T00:01:00.000Z'));
  assert.deepEqual(summary.recentTimelineGaps, []);
  assert.deepEqual(summary.recentDiscontinuities, [{ after: '/stream/channels/c/hls/data000001.ts', deltaMs: 56000 }]);
  assert.equal(summary.totalDiscontinuities, 1);
  assert.equal(summary.endlist, true);
});
