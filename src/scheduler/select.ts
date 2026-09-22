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

/**
 * The series a title belongs to, as far as selection order is concerned.
 *
 * One series arrives spelled several ways: files carry "Home Improvement
 * (1991)" while a pool, a rescan, or an import may hold "home improvement".
 * Those are one series, and ordering them by raw title interleaves them
 * instead: "show" sorts before "Show (2019)" because it is a prefix of it, so
 * season 2 can land ahead of season 1 and the chronological cursor jumps
 * backwards whenever the spelling changes.
 *
 * Case, punctuation, spacing and an optional trailing four-digit year are
 * folded away. This is a scheduling view only: it neither changes nor
 * re-derives stored identity, and media that collapse to one key stay separate
 * items.
 */
function seriesOrderKey(item: MediaItem) {
  const title = item.showTitle ?? item.title;
  if (item.kind !== "episode") return title;
  return title
    .normalize("NFKC")
    .replace(/\(\s*\d{4}\s*\)\s*$/, " ")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function chronologicalOrder(left: MediaItem, right: MediaItem) {
  return seriesOrderKey(left).localeCompare(seriesOrderKey(right))
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
