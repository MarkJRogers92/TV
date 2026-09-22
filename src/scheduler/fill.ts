import type { MediaItem, ScheduleEntry } from "../domain/models.js";
import { createSeededRandom } from "./random.js";

export type FillerHistory = { mediaId: string; at: string };
export type FillInput = {
  start: Date;
  boundary: Date;
  items: MediaItem[];
  history?: FillerHistory[];
  cooldownMinutes?: number;
  seed?: string;
  source?: string;
  stationIdsEligible?: boolean;
  /**
   * Interstitials already used elsewhere in the same schedule, so a short pool
   * rotates through itself instead of repeating while unused items exist.
   *
   * The cooldown above cannot do this: it is a rolling window measured back from
   * one break, so it prevents a repeat only while the window still covers the
   * earlier airing. With a pool far larger than a day's slots, an item picked
   * early in the morning is long out of cooldown by the evening and can be drawn
   * again, which is what made a 268-slot day use only ~214 distinct ads. This set
   * is scoped to one generation and is the thing that makes the pool behave as a
   * bag rather than as independent draws.
   *
   * Like recent history, this is a preference rather than a hard filter: the
   * excluded items come back as the last fallback so an exact fill is never lost
   * to variety.
   */
  exclude?: ReadonlySet<string>;
};
export const FILL_STATE_CAP = 50_000;
export type FillResult = {
  entries: ScheduleEntry[];
  stats: { exploredStates: number };
};
const fillerKinds = new Set(["commercial", "filler", "bumper"]);
/**
 * Every eligible item in seeded random order.
 *
 * The ranks are drawn BEFORE any recent/excluded filtering, so removing items
 * cannot shift the permutation of the items that remain. That matters for the
 * fallbacks in `fillToBoundary`: each relaxed pool is then exactly this pool
 * with some items handed back at their original positions, which is what makes
 * "did the preference cost us an exact fit?" a fair comparison.
 */
function rankedEligibleItems(input: FillInput): MediaItem[] {
  const stationIdsEligible =
    input.stationIdsEligible ?? input.boundary.getUTCMinutes() === 0;
  const random = createSeededRandom(input.seed ?? "filler");
  const seen = new Set<string>();
  return input.items
    .filter(
      (item) =>
        item.available &&
        item.durationMs &&
        (fillerKinds.has(item.kind) ||
          (stationIdsEligible && item.kind === "station-id")),
    )
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map((item) => ({ item, rank: random() }))
    .sort((a, b) => a.rank - b.rank || a.item.id.localeCompare(b.item.id))
    .map(({ item }) => item);
}
/**
 * Media IDs still inside their cooldown window at the start of this break.
 *
 * These are a fallback rather than a hard filter: a break that can only be
 * filled by repeating a spot should repeat it instead of leaving dead air.
 */
function recentIds(input: FillInput): ReadonlySet<string> {
  const cutoff = input.start.getTime() - (input.cooldownMinutes ?? 0) * 60_000;
  return new Set(
    (input.history ?? [])
      .filter((entry) => Date.parse(entry.at) > cutoff)
      .map((entry) => entry.mediaId),
  );
}
const totalDurationMs = (items: MediaItem[]) =>
  items.reduce((total, item) => total + (item.durationMs ?? 0), 0);
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
function bestFit(
  items: MediaItem[],
  gapMs: number,
): { items: MediaItem[]; exploredStates: number } {
  for (let first = 0; first < items.length; first++) {
    if (items[first].durationMs === gapMs)
      return { items: [items[first]], exploredStates: 1 };
    for (let second = first + 1; second < items.length; second++)
      if (items[first].durationMs! + items[second].durationMs! === gapMs)
        return { items: [items[first], items[second]], exploredStates: 2 };
  }
  const unit = items.reduce(
    (value, item) => gcd(value, item.durationMs!),
    gapMs,
  );
  const gapUnits = gapMs / unit;
  const durations = items.map((item) => item.durationMs! / unit);
  if (gapUnits <= FILL_STATE_CAP) {
    const previous = new Int32Array(gapUnits + 1).fill(-2);
    const selected = new Int32Array(gapUnits + 1).fill(-1);
    let exploredStates = 1;
    previous[0] = -1;
    for (let index = 0; index < items.length; index++)
      for (let total = gapUnits; total >= durations[index]; total--)
        if (
          previous[total] === -2 &&
          previous[total - durations[index]] !== -2
        ) {
          previous[total] = total - durations[index];
          selected[total] = index;
          exploredStates++;
        }
    for (let total = gapUnits; total >= 0; total--)
      if (previous[total] !== -2) {
        const result: MediaItem[] = [];
        for (let cursor = total; cursor > 0; cursor = previous[cursor])
          result.unshift(items[selected[cursor]]);
        return { items: result, exploredStates };
      }
  }
  const states = new Map<number, { previous: number; itemIndex: number }>([
    [0, { previous: -1, itemIndex: -1 }],
  ]);
  for (
    let index = 0;
    index < items.length && states.size < FILL_STATE_CAP;
    index++
  )
    for (const total of [...states.keys()]) {
      const next = total + items[index].durationMs!;
      if (next <= gapMs && !states.has(next) && states.size < FILL_STATE_CAP)
        states.set(next, { previous: total, itemIndex: index });
    }
  let best = 0;
  for (const total of states.keys()) if (total > best) best = total;
  const result: MediaItem[] = [];
  for (let cursor = best; cursor > 0;) {
    const node = states.get(cursor)!;
    result.unshift(items[node.itemIndex]);
    cursor = node.previous;
  }
  return { items: result, exploredStates: states.size };
}
export function fillToBoundary(input: FillInput): FillResult {
  const gapMs = Math.max(0, input.boundary.getTime() - input.start.getTime());
  const ranked = rankedEligibleItems(input);
  const recent = recentIds(input);
  const exclude = input.exclude;
  // Preference order: unused items first, then recent repeats, then items
  // already used elsewhere in this schedule. Each pool is the previous one with
  // more items handed back at their seeded positions, so a relaxed pool still
  // rotates through everything it can.
  const pools = [
    ranked.filter((item) => !recent.has(item.id) && !exclude?.has(item.id)),
  ];
  const unexcluded = ranked.filter((item) => !exclude?.has(item.id));
  if (unexcluded.length > pools[0].length) pools.push(unexcluded);
  if (ranked.length > unexcluded.length) pools.push(ranked);
  let selected = bestFit(pools[0], gapMs);
  // A repeat is only worth its lost variety when it fills the break strictly
  // better - a residual becomes a flex entry, dead air. Ties keep the earlier,
  // more varied pool, so relaxing can never leave a break emptier than the
  // preference would have.
  for (const pool of pools.slice(1)) {
    if (totalDurationMs(selected.items) >= gapMs) break;
    const relaxed = bestFit(pool, gapMs);
    if (totalDurationMs(relaxed.items) > totalDurationMs(selected.items))
      selected = relaxed;
  }
  const entries: ScheduleEntry[] = [];
  let at = input.start.getTime();
  for (const item of selected.items) {
    const durationMs = item.durationMs!;
    entries.push({
      id: `fill-${at}`,
      start: new Date(at).toISOString(),
      end: new Date(at + durationMs).toISOString(),
      localStart: "",
      localEnd: "",
      durationMs,
      kind: item.kind,
      title: item.title,
      mediaId: item.id,
      path: item.path,
      source: input.source,
    });
    at += durationMs;
  }
  if (at < input.boundary.getTime())
    entries.push({
      id: `flex-${at}`,
      start: new Date(at).toISOString(),
      end: input.boundary.toISOString(),
      localStart: "",
      localEnd: "",
      durationMs: input.boundary.getTime() - at,
      kind: "flex",
      title: "Flexible programming",
      reason: "No fitting interstitial",
    });
  return { entries, stats: { exploredStates: selected.exploredStates } };
}
