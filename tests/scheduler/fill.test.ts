import { expect, test } from 'vitest';
import type { MediaItem } from '../../src/domain/models.js';
import { fillToBoundary } from '../../src/scheduler/fill.js';

const start = new Date('2026-09-18T12:52:00.000Z');
const item = (id: string, kind: MediaItem['kind'], durationMs: number): MediaItem => ({
  id,
  source: 'placeholder',
  kind,
  title: id,
  durationMs,
  durationStatus: 'ok',
  available: true,
  tags: [],
});

const fill = (overrides: Partial<Parameters<typeof fillToBoundary>[0]> = {}) => fillToBoundary({
  start,
  boundary: new Date('2026-09-18T13:00:00.000Z'),
  items: [item('commercial-180', 'commercial', 180_000), item('bumper-120', 'bumper', 120_000), item('filler-60', 'filler', 60_000)],
  seed: 'repeatable-seed',
  history: [],
  cooldownMinutes: 120,
  ...overrides,
});

test('uses a deterministic best fit without exceeding its boundary', () => {
  const result = fill({
    boundary: new Date('2026-09-18T13:00:00.000Z'),
    items: [item('commercial-300', 'commercial', 300_000), item('bumper-180', 'bumper', 180_000), item('filler-120', 'filler', 120_000)],
  });

  expect(result.entries.map((entry) => entry.mediaId)).toEqual(['commercial-300', 'bumper-180']);
  expect(result.entries.at(-1)?.end).toBe('2026-09-18T13:00:00.000Z');
});

test('uses the seeded order to break equal best fits', () => {
  const input = { items: [item('a', 'commercial', 240_000), item('b', 'commercial', 240_000)], boundary: new Date('2026-09-18T12:56:00.000Z') };
  expect(fill(input).entries.map((entry) => entry.mediaId)).toEqual(fill(input).entries.map((entry) => entry.mediaId));
});

test('rotates filler instead of repeating an item inside its cooldown', () => {
  const result = fill({
    start: new Date('2026-09-18T12:56:00.000Z'),
    items: [item('commercial-a', 'commercial', 60_000), item('commercial-b', 'commercial', 60_000), item('bumper', 'bumper', 60_000)],
  });

  const ids = result.entries.flatMap((entry) => entry.mediaId ? [entry.mediaId] : []);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(3);
});

test('does not select station IDs except at a top-of-hour boundary', () => {
  const id = item('station-id', 'station-id', 60_000);
  expect(fill({ items: [id], boundary: new Date('2026-09-18T12:53:00.000Z') }).entries[0]?.kind).toBe('flex');
  expect(fill({ items: [id] }).entries[0]).toMatchObject({ kind: 'station-id', mediaId: 'station-id' });
});

test('accepts commercials, bumpers, and general filler roles', () => {
  const result = fill({
    start: new Date('2026-09-18T12:57:00.000Z'),
    items: [item('commercial', 'commercial', 60_000), item('bumper', 'bumper', 60_000), item('general', 'filler', 60_000)],
  });

  expect(result.entries.map((entry) => entry.kind).sort()).toEqual(['bumper', 'commercial', 'filler']);
});

test('emits one flex entry for a positive residual', () => {
  const result = fill({ items: [item('short', 'commercial', 180_000)] });
  expect(result.entries.filter((entry) => entry.kind === 'flex')).toHaveLength(1);
  expect(result.entries.at(-1)).toMatchObject({ kind: 'flex', durationMs: 300_000 });
});

test('allows an item played exactly at the cooldown boundary', () => {
  const result = fill({items:[item('equal-cooldown','commercial',480_000)],history:[{mediaId:'equal-cooldown',at:'2026-09-18T10:52:00.000Z'}]});
  expect(result.entries[0]).toMatchObject({mediaId:'equal-cooldown'});
});

test('fits a 60-minute gap with 300 items within a practical bound',()=>{
  const began=performance.now();
  const result=fillToBoundary({start:new Date('2026-09-18T12:00:00.000Z'),boundary:new Date('2026-09-18T13:00:00.000Z'),items:Array.from({length:300},(_,index)=>item(`large-${index}`,'commercial',(index%59+1)*60_000)),cooldownMinutes:120,seed:'large-pool'});
  expect(performance.now()-began).toBeLessThan(1_000);
  expect(result.entries.reduce((total,entry)=>total+entry.durationMs,0)).toBe(3_600_000);
},2_000);

test('bounds sparse best-fit state for 600 GCD-1 millisecond durations',()=>{
  const result=fillToBoundary({start:new Date('2026-09-18T12:00:00.000Z'),boundary:new Date('2026-09-18T13:00:00.000Z'),items:Array.from({length:600},(_,index)=>item(`gcd-one-${index}`,'commercial',index+1)),cooldownMinutes:120,seed:'gcd-one'});
  expect(result.entries.reduce((total,entry)=>total+entry.durationMs,0)).toBeLessThanOrEqual(3_600_000);
  expect(result.stats?.exploredStates).toBeLessThanOrEqual(50_000);
});

test('selects an exact 60-minute item before capped sparse search',()=>{
  const exact=item('exact-hour','commercial',3_600_000);
  const result=fillToBoundary({start:new Date('2026-09-18T12:00:00.000Z'),boundary:new Date('2026-09-18T13:00:00.000Z'),items:[...Array.from({length:599},(_,index)=>item(`near-${index}`,'commercial',index+1)),exact],cooldownMinutes:120,seed:'reviewer-exact'});
  expect(result.entries.map(entry=>entry.mediaId)).toEqual(['exact-hour']);
  expect(result.stats.exploredStates).toBeLessThanOrEqual(50_000);
});

test('preserves the absolute path of an eligible local commercial',()=>{
  const local: MediaItem = { ...item('local-commercial', 'commercial', 480_000), source: 'local-folder', path: '/media/spots/acme-15s.mp4' };
  const result = fill({ items: [local] });
  expect(result.entries.map((entry) => entry.mediaId)).toEqual(['local-commercial']);
  expect(result.entries[0].path).toBe('/media/spots/acme-15s.mp4');
});

test('skips an excluded interstitial when an unused one fits instead', () => {
  const result = fillToBoundary({
    start: new Date('2026-09-18T12:59:00.000Z'),
    boundary: new Date('2026-09-18T13:00:00.000Z'),
    items: [item('used', 'commercial', 60_000), item('unused', 'commercial', 60_000)],
    cooldownMinutes: 120,
    seed: 'bag',
    exclude: new Set(['used']),
  });

  expect(result.entries.map((entry) => entry.mediaId)).toEqual(['unused']);
});

test('prefers a repeat over dead air when nothing unused can fill the gap', () => {
  const result = fillToBoundary({
    start: new Date('2026-09-18T12:55:00.000Z'),
    boundary: new Date('2026-09-18T13:00:00.000Z'),
    items: [item('only', 'commercial', 300_000)],
    cooldownMinutes: 120,
    seed: 'bag',
    exclude: new Set(['only']),
  });

  expect(result.entries.map((entry) => entry.mediaId)).toEqual(['only']);
  expect(result.entries.filter((entry) => entry.kind === 'flex')).toHaveLength(0);
});

test('does not repeat an item across breaks once its cooldown has expired', () => {
  const items = [
    item('early', 'commercial', 60_000),
    item('other', 'commercial', 60_000),
  ];
  const morning = fillToBoundary({
    start: new Date('2026-09-18T09:59:00.000Z'),
    boundary: new Date('2026-09-18T10:00:00.000Z'),
    items,
    cooldownMinutes: 120,
    seed: 'morning',
  });
  const aired = morning.entries.flatMap((entry) =>
    entry.mediaId ? [entry.mediaId] : [],
  );
  expect(aired).toHaveLength(1);

  // Eleven hours later the cooldown no longer covers the morning airing, so only
  // the exclusion set can stop this break from drawing the same item again.
  const evening = fillToBoundary({
    start: new Date('2026-09-18T20:59:00.000Z'),
    boundary: new Date('2026-09-18T21:00:00.000Z'),
    items,
    history: [{ mediaId: aired[0], at: '2026-09-18T10:00:00.000Z' }],
    cooldownMinutes: 120,
    seed: 'evening',
    exclude: new Set(aired),
  });

  expect(
    evening.entries.flatMap((entry) => (entry.mediaId ? [entry.mediaId] : [])),
  ).not.toContain(aired[0]);
});

test('stays deterministic when an exclusion set is supplied', () => {
  const input = {
    start,
    boundary: new Date('2026-09-18T13:00:00.000Z'),
    items: [
      item('commercial-180', 'commercial', 180_000),
      item('commercial-120', 'commercial', 120_000),
      item('filler-60', 'filler', 60_000),
    ],
    cooldownMinutes: 120,
    seed: 'bag-deterministic',
    exclude: new Set(['commercial-180']),
  };

  expect(fillToBoundary(input).entries.map((entry) => entry.mediaId)).toEqual(
    fillToBoundary(input).entries.map((entry) => entry.mediaId),
  );
});
