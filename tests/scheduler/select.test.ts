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
  const episode = item('episode', 'episode');
  const pool: Pool = { id: 'episodes', name: 'Episodes', kinds: ['episode'], mediaIds: [episode.id], mode: 'chronological', noRepeatMinutes: 120, weight: 1 };
  const input = { pool, items: [episode], kind: 'episode' as const, history: [{ mediaId: episode.id, at: '2026-09-18T19:00:00.000Z' }], at: '2026-09-18T20:00:00.000Z', seed: 'selection' };
  expect(selectCandidate(input)).toEqual({ item: undefined, relaxed: false });
  expect(selectCandidate({ ...input, allowCooldownRelaxation: true })).toEqual({ item: episode, relaxed: true });
});
