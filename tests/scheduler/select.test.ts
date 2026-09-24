import {expect,test} from 'vitest';
import type {MediaItem,Pool} from '../../src/domain/models.js';
import {selectCandidate} from '../../src/scheduler/select.js';

const item=(id:string,kind:MediaItem['kind']):MediaItem=>({id,source:'placeholder',kind,title:id,durationMs:60_000,durationStatus:'ok',available:true,tags:[]});
const select=(pool:Pool,items:MediaItem[],kind:'episode'|'movie')=>selectCandidate({pool,items,kind,history:[],at:'2026-09-18T20:00:00.000Z',seed:'selection'}).item;

test('does not select an episode from a movie slot or a mismatched pool',()=>{
  const moviePool:Pool={id:'movie-pool',name:'Movie pool',kinds:['movie'],mediaIds:['episode'],mode:'chronological',noRepeatMinutes:0,weight:1};
  expect(select(moviePool,[item('episode','episode')],'movie')).toBeUndefined();
});

test('allows a movie only when both the slot and pool allow movies',()=>{
  const movie=item('movie','movie');
  const moviePool:Pool={id:'movie-pool',name:'Movie pool',kinds:['movie'],mediaIds:['movie'],mode:'chronological',noRepeatMinutes:0,weight:1};
  expect(select(moviePool,[movie],'movie')?.id).toBe('movie');
});

test('advances episodes in season and episode order after the last chronological play', () => {
  const episodes = [3, 1, 2].map((episode) => ({ ...item(`episode-${episode}`, 'episode'), showTitle: 'Show', season: 1, episode }));
  const pool: Pool = { id: 'episodes', name: 'Episodes', kinds: ['episode'], mediaIds: episodes.map(({ id }) => id), mode: 'chronological', noRepeatMinutes: 0, weight: 1 };
  const first = selectCandidate({ pool, items: episodes, kind: 'episode', history: [], at: '2026-09-18T20:00:00.000Z', seed: 'selection' });
  const second = selectCandidate({ pool, items: episodes, kind: 'episode', history: [{ mediaId: first.item!.id, at: '2026-09-18T19:00:00.000Z' }], at: '2026-09-18T20:00:00.000Z', seed: 'selection' });
  expect([first.item?.episode, second.item?.episode]).toEqual([1, 2]);
});

test('shuffle selection is stable for the same seed regardless of input item order', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => item(id, 'episode'));
  const pool: Pool = { id: 'shuffle', name: 'Shuffle', kinds: ['episode'], mediaIds: items.map(({ id }) => id), mode: 'shuffle', noRepeatMinutes: 0, weight: 1 };
  const forward = selectCandidate({ pool, items, kind: 'episode', history: [], at: '2026-09-18T20:00:00.000Z', seed: 'stable' });
  const reversed = selectCandidate({ pool, items: [...items].reverse(), kind: 'episode', history: [], at: '2026-09-18T20:00:00.000Z', seed: 'stable' });
  expect(forward.item?.id).toBe(reversed.item?.id);
});

test('orders season 1 before season 2 when a show title only differs by case, spacing, and a trailing year', () => {
  // The same series is spelled three ways by the files it arrived from: season 2
  // sorts before season 1 under a raw title comparison, because "show" and
  // "Show" are prefixes of "Show (2019)".
  const episodes: MediaItem[] = [
    { ...item('episode-s2e1', 'episode'), showTitle: 'show', season: 2, episode: 1 },
    { ...item('episode-s1e1', 'episode'), showTitle: 'Show (2019)', season: 1, episode: 1 },
    { ...item('episode-s1e2', 'episode'), showTitle: 'Show', season: 1, episode: 2 },
  ];
  const pool: Pool = { id: 'episodes', name: 'Episodes', kinds: ['episode'], mediaIds: episodes.map(({ id }) => id), mode: 'chronological', noRepeatMinutes: 0, weight: 1 };
  const at = '2026-09-18T20:00:00.000Z';
  const playedIds: string[] = [];
  const pickedIds: string[] = [];
  for (let slot = 0; slot < episodes.length; slot += 1) {
    const history = playedIds.map((mediaId, index) => ({ mediaId, at: `2026-09-18T19:0${index}:00.000Z` }));
    const selection = selectCandidate({ pool, items: episodes, kind: 'episode', history, at, seed: 'selection' });
    pickedIds.push(selection.item!.id);
    playedIds.push(selection.item!.id);
  }
  expect(pickedIds).toEqual(['episode-s1e1', 'episode-s1e2', 'episode-s2e1']);
});

test('keeps distinct movie remake years in title order', () => {
  const movies: MediaItem[] = [
    { ...item('a-new-remake', 'movie'), title: 'Dune (2021)' },
    { ...item('z-old-original', 'movie'), title: 'Dune (1984)' },
  ];
  const pool: Pool = { id: 'movies', name: 'Movies', kinds: ['movie'], mediaIds: movies.map(({ id }) => id), mode: 'chronological', noRepeatMinutes: 0, weight: 1 };

  expect(select(pool, movies, 'movie')?.id).toBe('z-old-original');
});

test('enforces cooldown unless relaxation is explicitly enabled', () => {
  const movie = item('movie', 'movie');
  const pool: Pool = { id: 'movies', name: 'Movies', kinds: ['movie'], mediaIds: [movie.id], mode: 'chronological', noRepeatMinutes: 120, weight: 1 };
  const input = { pool, items: [movie], kind: 'movie' as const, history: [{ mediaId: movie.id, at: '2026-09-18T19:00:00.000Z' }], at: '2026-09-18T20:00:00.000Z', seed: 'selection' };
  expect(selectCandidate(input)).toEqual({ item: undefined, relaxed: false });
  expect(selectCandidate({ ...input, allowCooldownRelaxation: true })).toEqual({ item: movie, relaxed: true });
});

test('episode cooldown relaxation cannot replay a completed episode', () => {
  const episode = ep('completed', 'Show', 1, 1);
  const pool = episodePool('show', [episode.id]);
  pool.noRepeatMinutes = 120;
  expect(selectCandidate({ pool, items: [episode], kind: 'episode', history: [{ mediaId: episode.id, at: '2026-09-18T19:00:00.000Z' }], at: AT, seed: 'selection', allowCooldownRelaxation: true }))
    .toEqual({ item: undefined, relaxed: false });
});

test('another encode of a completed episode cannot replay the same season and episode', () => {
  const original = ep('original', 'Show', 1, 1);
  const alternate = ep('alternate', 'Show', 1, 1);
  const second = ep('second', 'Show', 1, 2);
  const pool = episodePool('show', [original.id, alternate.id, second.id]);
  expect(selectCandidate({ pool, items: [original, alternate, second], kind: 'episode', history: [{ mediaId: original.id, at: '2026-09-18T19:00:00.000Z' }], at: AT, seed: 'selection' }).item?.id)
    .toBe(second.id);
});

test('unknown episode position holds that series instead of guessing a successor', () => {
  const unknown = { ...item('unknown', 'episode'), showTitle: 'Show' };
  const numbered = ep('numbered', 'Show', 1, 2);
  const pool = episodePool('show', [unknown.id, numbered.id]);
  expect(selectCandidate({ pool, items: [unknown, numbered], kind: 'episode', history: [{ mediaId: unknown.id, at: '2026-09-18T19:00:00.000Z' }], at: AT, seed: 'selection' }).item)
    .toBeUndefined();
});

const ep = (id: string, show: string, season: number, episode: number, available = true): MediaItem => ({
  ...item(id, 'episode'),
  showTitle: show,
  season,
  episode,
  available,
});
const episodePool = (id: string, mediaIds: string[]): Pool => ({
  id,
  name: id,
  kinds: ['episode'],
  mediaIds,
  mode: 'chronological',
  noRepeatMinutes: 0,
  weight: 1,
});
const AT = '2026-09-18T20:00:00.000Z';
const historyAt = (mediaIds: string[]) => mediaIds.map((mediaId, index) => ({ mediaId, at: `2026-09-18T19:0${index}:00.000Z` }));

test('EP03 does not wrap after the last episode of a series (F02)', () => {
  const episodes = [1, 2, 3].map((n) => ep(`f02-e${n}`, 'F02 Show', 1, n));
  const pool = episodePool('f02', episodes.map(({ id }) => id));
  const exhausted = selectCandidate({ pool, items: episodes, kind: 'episode', history: historyAt(['f02-e1', 'f02-e2', 'f02-e3']), at: AT, seed: 'selection' });
  expect(exhausted.item).toBeUndefined();
});

test('EP03 falls back to another series instead of wrapping the exhausted one', () => {
  const alpha = [1, 2].map((n) => ep(`alpha-e${n}`, 'Alpha', 1, n));
  const beta = ep('beta-e1', 'Beta', 1, 1);
  const items = [...alpha, beta];
  const pool = episodePool('mixed', items.map(({ id }) => id));
  const selection = selectCandidate({ pool, items, kind: 'episode', history: historyAt(['alpha-e1', 'alpha-e2']), at: AT, seed: 'selection' });
  expect(selection.item?.id).toBe('beta-e1');
});

test('EP04 does not skip over a missing or unavailable next episode (F02)', () => {
  const missing = [ep('f02-e1', 'F02 Show', 1, 1), ep('f02-e3', 'F02 Show', 1, 3)];
  const missingPool = episodePool('f02-missing', missing.map(({ id }) => id));
  expect(
    selectCandidate({ pool: missingPool, items: missing, kind: 'episode', history: historyAt(['f02-e1']), at: AT, seed: 'selection' }).item,
  ).toBeUndefined();
  const unavailable = [ep('f02-e1', 'F02 Show', 1, 1), ep('f02-e2', 'F02 Show', 1, 2, false), ep('f02-e3', 'F02 Show', 1, 3)];
  const unavailablePool = episodePool('f02-unavailable', unavailable.map(({ id }) => id));
  expect(
    selectCandidate({ pool: unavailablePool, items: unavailable, kind: 'episode', history: historyAt(['f02-e1']), at: AT, seed: 'selection' }).item,
  ).toBeUndefined();
});

test('EP05 does not select an earlier newly discovered episode below the history floor', () => {
  const episodes = [1, 2, 3, 4].map((n) => ep(`floor-e${n}`, 'Floor Show', 1, n));
  const pool = episodePool('floor', episodes.map(({ id }) => id));
  const forward = selectCandidate({ pool, items: episodes, kind: 'episode', history: historyAt(['floor-e2', 'floor-e3']), at: AT, seed: 'selection' });
  expect(forward.item?.id).toBe('floor-e4');
  const exhausted = selectCandidate({ pool, items: episodes, kind: 'episode', history: historyAt(['floor-e2', 'floor-e3', 'floor-e4']), at: AT, seed: 'selection' });
  expect(exhausted.item).toBeUndefined();
});

test('EP06 crosses seasons deterministically and stops when the season opener is missing (F17)', () => {
  const season = [ep('f17-s1e1', 'F17 Show', 1, 1), ep('f17-s1e2', 'F17 Show', 1, 2), ep('f17-s2e1', 'F17 Show', 2, 1), ep('f17-s2e2', 'F17 Show', 2, 2)];
  const shuffled = [season[2], season[0], season[3], season[1]];
  const pool = episodePool('f17', season.map(({ id }) => id));
  expect(
    selectCandidate({ pool, items: shuffled, kind: 'episode', history: historyAt(['f17-s1e2']), at: AT, seed: 'selection' }).item?.id,
  ).toBe('f17-s2e1');
  const gapItems = [season[0], season[1], season[3]];
  const gapPool = episodePool('f17-gap', gapItems.map(({ id }) => id));
  expect(
    selectCandidate({ pool: gapPool, items: gapItems, kind: 'episode', history: historyAt(['f17-s1e2']), at: AT, seed: 'selection' }).item,
  ).toBeUndefined();
});
