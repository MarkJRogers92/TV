import type { MediaItem, Pool } from '../domain/models.js';
import { createSeededRandom } from './random.js';

export type Played = { mediaId: string; at: string };
export type SelectionInput = {
  pool: Pool;
  items: MediaItem[];
  kind: 'episode' | 'movie';
  history: Played[];
  at: string;
  seed: string;
  allowCooldownRelaxation?: boolean;
};
export type SelectionResult = { item: MediaItem | undefined; relaxed: boolean };

function chronologicalOrder(left: MediaItem, right: MediaItem) {
  return (left.showTitle ?? left.title).localeCompare(right.showTitle ?? right.title)
    || (left.season ?? 0) - (right.season ?? 0)
    || (left.episode ?? 0) - (right.episode ?? 0)
    || left.id.localeCompare(right.id);
}

function chooseChronological(candidates: MediaItem[], all: MediaItem[], history: Played[]) {
  const ordered = [...all].sort(chronologicalOrder);
  const eligibleIds = new Set(candidates.map((item) => item.id));
  const lastPlayed = [...history]
    .filter((play) => ordered.some((item) => item.id === play.mediaId))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  const lastIndex = lastPlayed ? ordered.findIndex((item) => item.id === lastPlayed.mediaId) : -1;
  for (let offset = 1; offset <= ordered.length; offset += 1) {
    const candidate = ordered[(lastIndex + offset) % ordered.length];
    if (eligibleIds.has(candidate.id)) return candidate;
  }
  return undefined;
}

function chooseShuffle(candidates: MediaItem[], seed: string) {
  const random = createSeededRandom(seed);
  return [...candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({ item, rank: random() }))
    .sort((left, right) => left.rank - right.rank || left.item.id.localeCompare(right.item.id))[0]?.item;
}

export function selectCandidate(input: SelectionInput): SelectionResult {
  const available = input.items.filter((item) =>
    input.pool.kinds.includes(input.kind)
    && input.pool.mediaIds.includes(item.id)
    && item.kind === input.kind
    && item.available
    && item.durationMs,
  );
  const cutoff = Date.parse(input.at) - input.pool.noRepeatMinutes * 60_000;
  let candidates = available.filter((item) => !input.history.some((play) => play.mediaId === item.id && Date.parse(play.at) > cutoff));
  let relaxed = false;
  if (!candidates.length && input.allowCooldownRelaxation && available.length) {
    candidates = available;
    relaxed = true;
  }
  if (!candidates.length) return { item: undefined, relaxed: false };
  const item = input.pool.mode === 'chronological'
    ? chooseChronological(candidates, available, input.history)
    : chooseShuffle(candidates, input.seed);
  return { item, relaxed };
}
