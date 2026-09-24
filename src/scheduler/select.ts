import type { MediaItem, Pool } from "../domain/models.js";
import { createSeededRandom } from "./random.js";

export type Played = { mediaId: string; at: string };
export type SelectionInput = {
  pool: Pool;
  items: MediaItem[];
  kind: "episode" | "movie";
  history: Played[];
  at: string;
  seed: string;
  allowCooldownRelaxation?: boolean;
  /**
   * Series whose pool has been fully aired and may therefore start again. Absent
   * (or missing a series), an exhausted series is held instead of wrapped - which
   * is what keeps a member it has never played, such as an earlier episode that
   * appeared later, from being mistaken for a restart.
   */
  wrapAllowed?: ReadonlySet<string>;
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
/** Exported so a durable floor and the selector cannot disagree about identity. */
export function seriesOrderKey(item: MediaItem) {
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
  return (
    seriesOrderKey(left).localeCompare(seriesOrderKey(right)) ||
    (left.season ?? 0) - (right.season ?? 0) ||
    (left.episode ?? 0) - (right.episode ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function chooseChronological(
  candidates: MediaItem[],
  all: MediaItem[],
  history: Played[],
) {
  const ordered = [...all].sort(chronologicalOrder);
  const eligibleIds = new Set(candidates.map((item) => item.id));
  const lastPlayed = [...history]
    .filter((play) => ordered.some((item) => item.id === play.mediaId))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  const lastIndex = lastPlayed
    ? ordered.findIndex((item) => item.id === lastPlayed.mediaId)
    : -1;
  for (let offset = 1; offset <= ordered.length; offset += 1) {
    const candidate = ordered[(lastIndex + offset) % ordered.length];
    if (eligibleIds.has(candidate.id)) return candidate;
  }
  return undefined;
}

type EpisodePosition = { season: number; episode: number };

function episodePosition(item: MediaItem): EpisodePosition {
  return { season: item.season ?? 0, episode: item.episode ?? 0 };
}

function compareEpisodePosition(left: EpisodePosition, right: EpisodePosition) {
  return left.season - right.season || left.episode - right.episode;
}

function isImmediateSuccessor(floorItem: MediaItem, nextItem: MediaItem) {
  if (floorItem.season === undefined || floorItem.episode === undefined)
    return false;
  if (nextItem.season === undefined || nextItem.episode === undefined)
    return false;
  if (nextItem.season === floorItem.season) {
    return nextItem.episode === floorItem.episode + 1;
  }
  if (nextItem.season === floorItem.season + 1) {
    return nextItem.episode === 1;
  }
  return false;
}

function chooseEpisodeChronological(
  candidates: MediaItem[],
  available: MediaItem[],
  allItems: MediaItem[],
  pool: Pool,
  history: Played[],
  wrapAllowed: ReadonlySet<string> | undefined,
) {
  const eligibleIds = new Set(candidates.map((item) => item.id));
  const byId = new Map(allItems.map((item) => [item.id, item]));
  const poolIds = new Set(pool.mediaIds);
  const resolvedHistory = history
    .filter((play) => {
      const item = byId.get(play.mediaId);
      return (
        Boolean(item) && item?.kind === "episode" && poolIds.has(play.mediaId)
      );
    })
    .map((play) => ({ play, item: byId.get(play.mediaId)! }))
    .sort(
      (left, right) => Date.parse(left.play.at) - Date.parse(right.play.at),
    );
  // An old media ID that vanished from this pool has no trustworthy position.
  // A rename must not silently restart the track at its first available file.
  if (
    history.some((play) => poolIds.has(play.mediaId) && !byId.has(play.mediaId))
  )
    return undefined;
  if (
    resolvedHistory.some(
      ({ item }) => item.season === undefined || item.episode === undefined,
    )
  )
    return undefined;
  const floors = new Map<
    string,
    { item: MediaItem; position: EpisodePosition }
  >();
  for (const entry of resolvedHistory) {
    const key = seriesOrderKey(entry.item);
    const position = episodePosition(entry.item);
    const current = floors.get(key);
    if (!current || compareEpisodePosition(position, current.position) > 0) {
      floors.set(key, { item: entry.item, position });
    }
  }
  const activeSeries = resolvedHistory.length
    ? seriesOrderKey(resolvedHistory[resolvedHistory.length - 1].item)
    : undefined;
  const grouped = new Map<string, MediaItem[]>();
  for (const item of available) {
    if (item.season === undefined || item.episode === undefined) continue;
    const key = seriesOrderKey(item);
    const list = grouped.get(key);
    if (list) list.push(item);
    else grouped.set(key, [item]);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) =>
      compareEpisodePosition(episodePosition(left), episodePosition(right)),
    );
  }
  const seriesNext = new Map<string, MediaItem>();
  for (const [key, list] of grouped) {
    const floor = floors.get(key);
    if (!floor) {
      // A new series starts only at an unambiguous opener. If it is missing or
      // unavailable, hold the series instead of jumping to the first ready file.
      const next = list[0];
      if (next?.season !== 1 || next.episode !== 1) continue;
      if (next && eligibleIds.has(next.id)) seriesNext.set(key, next);
      continue;
    }
    const above = list.filter(
      (item) =>
        compareEpisodePosition(episodePosition(item), floor.position) > 0,
    );
    if (!above.length) {
      // Nothing above the floor: the series has reached the end of its pool.
      // Start the next cycle - but only when the pool is demonstrably spent
      // (`wrapAllowed`, from the durable per-series cycle record). Otherwise the
      // series is held, exactly as a brand-new one is when its opener is missing,
      // so an unplayed member cannot be passed over as though it had aired.
      if (!wrapAllowed?.has(key)) continue;
      const first = list[0];
      if (first && eligibleIds.has(first.id)) seriesNext.set(key, first);
      continue;
    }
    const next = above[0];
    if (!eligibleIds.has(next.id)) continue;
    if (!isImmediateSuccessor(floor.item, next)) continue;
    seriesNext.set(key, next);
  }
  const activeNext = activeSeries ? seriesNext.get(activeSeries) : undefined;
  if (activeNext) return activeNext;
  const fallbacks = [...seriesNext.values()].sort(chronologicalOrder);
  if (fallbacks.length) return fallbacks[0];
  return undefined;
}

function chooseShuffle(candidates: MediaItem[], seed: string) {
  const random = createSeededRandom(seed);
  return [...candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({ item, rank: random() }))
    .sort(
      (left, right) =>
        left.rank - right.rank || left.item.id.localeCompare(right.item.id),
    )[0]?.item;
}

export function selectCandidate(input: SelectionInput): SelectionResult {
  const available = input.items.filter(
    (item) =>
      input.pool.kinds.includes(input.kind) &&
      input.pool.mediaIds.includes(item.id) &&
      item.kind === input.kind &&
      item.available &&
      item.durationMs,
  );
  const cutoff = Date.parse(input.at) - input.pool.noRepeatMinutes * 60_000;
  let candidates = available.filter(
    (item) =>
      !input.history.some(
        (play) => play.mediaId === item.id && Date.parse(play.at) > cutoff,
      ),
  );
  let relaxed = false;
  if (!candidates.length && input.allowCooldownRelaxation && available.length) {
    candidates = available;
    relaxed = true;
  }
  if (!candidates.length) return { item: undefined, relaxed: false };
  if (input.pool.mode !== "chronological") {
    return { item: chooseShuffle(candidates, input.seed), relaxed };
  }
  if (input.kind !== "episode") {
    return {
      item: chooseChronological(candidates, available, input.history),
      relaxed,
    };
  }
  const item = chooseEpisodeChronological(
    candidates,
    available,
    input.items,
    input.pool,
    input.history,
    input.wrapAllowed,
  );
  return { item, relaxed: Boolean(item) && relaxed };
}
