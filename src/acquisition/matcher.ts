import { episodeKey, normalizedSeriesTitle, type AcquisitionReviewCandidate, type CompletedImport, type WantedEpisode } from "./models.js";
import { parseVideoCandidate, type ParsedVideoCandidate, type VideoResolution } from "./filename.js";
import type { RemoteItem } from "./providerTypes.js";

export const minimumPlausibleBytes = 50 * 1024 * 1024;

export interface MatchSelection {
  readonly wantedId: string;
  readonly episodeKey: string;
  readonly seriesTitle: string;
  readonly season: number;
  readonly episode: number;
  readonly provider: ParsedVideoCandidate["provider"];
  readonly itemType: ParsedVideoCandidate["itemType"];
  readonly remoteItemId: string;
  readonly remoteFileId: string;
  readonly originalFilename: string;
  readonly resolution: VideoResolution | null;
  readonly bytes: number | null;
}
/**
 * A persist-safe locator for one remote file. It widens the persisted review
 * candidate with the parser's resolution vocabulary, so extending
 * `AcquisitionReviewCandidate` keeps every matcher candidate persistable
 * verbatim.
 */
export interface ReviewCandidate extends AcquisitionReviewCandidate {
  readonly resolution: VideoResolution | null;
}
/** Provider-scoped summary of a season pack plus its whole recognized file list. */
export interface PackPreview {
  readonly provider: MatchSelection["provider"];
  readonly itemType: MatchSelection["itemType"];
  readonly remoteItemId: string;
  /**
   * Series/season snapshot every recognized file shares. The coordinator
   * persists this on the durable season-pack offer so a later manual import can
   * re-list the exact pack and verify the stored identity.
   */
  readonly seriesTitle: string;
  readonly season: number;
  /** Unique recognized eligible episodes in the pack, Wanted or not. */
  readonly recognizedEpisodeCount: number;
  /**
   * Required bytes for every recognized eligible file in the pack; `null`
   * when any recognized size is unknown. The coordinator re-lists and
   * rechecks duplicates and free space immediately before manual import.
   */
  readonly totalBytes: number | null;
  /**
   * Every recognized eligible single-episode file in the pack — not only the
   * currently Wanted selections — so a later manual season import can re-list
   * and revalidate the exact pack.
   */
  readonly fileLocators: readonly ReviewCandidate[];
}
export type MatchPlan =
  | { readonly kind: "none" }
  | { readonly kind: "automatic"; readonly selections: readonly MatchSelection[] }
  | {
      readonly kind: "review";
      readonly reason: "ambiguous" | "multi-episode" | "uncertain-title";
      /**
       * Target Wanted record and episode identity for the persisted review.
       * A review only ever belongs to the one episode it was found for.
       */
      readonly wantedId: string;
      readonly episodeKey: string;
      readonly candidates: readonly ReviewCandidate[];
    }
  | { readonly kind: "season-pack"; readonly wantedSelections: readonly MatchSelection[]; readonly packPreview: PackPreview };

interface Candidate { readonly parsed: ParsedVideoCandidate; readonly item: RemoteItem; readonly titleState: "exact" | "missing" | "uncertain"; }
/**
 * Remote ids are only unique inside a provider, so identity ordering starts
 * with provider and item type: two providers reporting the same item/file ids
 * must never sort (or de-duplicate) as one file.
 */
const order = <T extends { provider: string; itemType: string; remoteItemId: string; remoteFileId: string }>(a: T, b: T) =>
  a.provider.localeCompare(b.provider) || a.itemType.localeCompare(b.itemType) || a.remoteItemId.localeCompare(b.remoteItemId) || a.remoteFileId.localeCompare(b.remoteFileId);
const itemKeyOf = (value: { provider: string; itemType: string; remoteItemId: string }) => `${value.provider}\0${value.itemType}\0${value.remoteItemId}`;

function completedItem(item: RemoteItem): boolean {
  return typeof item.completedAt === "string" && item.completedAt.trim().length > 0 && Number.isFinite(Date.parse(item.completedAt));
}

/** Extract a title from a provider item name without using a prefix guess. */
function itemSeriesTitle(originalName: string): string | null {
  const beforeSeason = originalName.split(/(?:^|[ ._-])s\d{1,3}(?:e\d{1,4})?(?=$|[ ._-])/i, 1)[0] ?? "";
  const normalized = normalizedSeriesTitle(beforeSeason);
  return normalized || null;
}

function candidateFor(item: RemoteItem, parsed: ParsedVideoCandidate, wanted: WantedEpisode): Candidate | null {
  if (parsed.bytes !== null && parsed.bytes < minimumPlausibleBytes) return null;
  if (parsed.season !== wanted.season || (parsed.episodeEnd === null ? parsed.episode !== wanted.episode : wanted.episode < parsed.episode || wanted.episode > parsed.episodeEnd)) return null;
  const target = normalizedSeriesTitle(wanted.seriesTitle);
  const own = parsed.seriesTitle === null ? "" : normalizedSeriesTitle(parsed.seriesTitle);
  const fallback = itemSeriesTitle(item.originalName);
  const titleState = own === target || (!own && fallback === target)
    ? "exact"
    : own && (own.includes(target) || target.includes(own))
      ? "uncertain"
      : "missing";
  return titleState === "missing" ? null : { parsed, item, titleState };
}
function selectionFor(wanted: WantedEpisode, candidate: Candidate): MatchSelection {
  const p = candidate.parsed;
  return { wantedId: wanted.id, episodeKey: episodeKey(wanted.seriesTitle, wanted.season, wanted.episode), seriesTitle: wanted.seriesTitle, season: wanted.season, episode: wanted.episode, provider: p.provider, itemType: p.itemType, remoteItemId: p.remoteItemId, remoteFileId: p.remoteFileId, originalFilename: p.originalFilename, resolution: p.resolution, bytes: p.bytes };
}
function reviewCandidate(candidate: Candidate, wanted: WantedEpisode): ReviewCandidate {
  const p = candidate.parsed;
  return { provider: p.provider, itemType: p.itemType, remoteItemId: p.remoteItemId, remoteFileId: p.remoteFileId, filename: p.originalFilename, sizeBytes: p.bytes, resolution: p.resolution, season: p.season, episode: wanted.episode };
}
function packLocator(parsed: ParsedVideoCandidate): ReviewCandidate {
  return { provider: parsed.provider, itemType: parsed.itemType, remoteItemId: parsed.remoteItemId, remoteFileId: parsed.remoteFileId, filename: parsed.originalFilename, sizeBytes: parsed.bytes, resolution: parsed.resolution, season: parsed.season, episode: parsed.episode };
}
function preferred(candidates: Candidate[]): Candidate[] {
  const known = candidates.filter((c) => c.parsed.resolutionHeight !== null);
  if (!known.length) return [...candidates].sort((a, b) => order(a.parsed, b.parsed));
  const pool = known;
  const under = pool.filter((c) => (c.parsed.resolutionHeight ?? -1) <= 720);
  const score = under.length ? Math.max(...under.map((c) => c.parsed.resolutionHeight ?? -1)) : Math.min(...pool.map((c) => c.parsed.resolutionHeight ?? Number.MAX_SAFE_INTEGER));
  return pool.filter((c) => c.parsed.resolutionHeight === score).sort((a, b) => order(a.parsed, b.parsed));
}

export function matchCompletedFiles(wanted: readonly WantedEpisode[], remoteItems: readonly RemoteItem[], completed: readonly CompletedImport[]): MatchPlan {
  const doneKeys = new Set(completed.map((x) => x.episodeKey));
  const doneRemote = new Set(completed.map((x) => `${x.provider}\0${x.remoteItemId}\0${x.remoteFileId}`));
  const parsed = remoteItems
    .filter(completedItem)
    .flatMap((item) => item.files.map((file) => ({ item, parsed: parseVideoCandidate(file) })).filter((value): value is { item: RemoteItem; parsed: ParsedVideoCandidate } => value.parsed !== null));
  const selectionList: MatchSelection[] = [];
  const reviews: Array<{ rank: number; reason: "ambiguous" | "multi-episode" | "uncertain-title"; wantedId: string; episodeKey: string; candidates: ReviewCandidate[] }> = [];
  for (const entry of [...wanted].sort((a, b) => episodeKey(a.seriesTitle,a.season,a.episode).localeCompare(episodeKey(b.seriesTitle,b.season,b.episode)))) {
    const key = episodeKey(entry.seriesTitle, entry.season, entry.episode);
    if (doneKeys.has(key)) continue;
    const candidates = parsed.map(({ item, parsed }) => candidateFor(item, parsed, entry)).filter((candidate): candidate is Candidate => candidate !== null).filter((candidate) => !doneRemote.has(`${candidate.parsed.provider}\0${candidate.parsed.remoteItemId}\0${candidate.parsed.remoteFileId}`));
    const multi = candidates.filter((c) => c.parsed.multiEpisode);
    if (multi.length) { reviews.push({ rank: 3, reason: "multi-episode", wantedId: entry.id, episodeKey: key, candidates: multi.map((c) => reviewCandidate(c, entry)).sort(order) }); continue; }
    const uncertain = candidates.filter((c) => c.titleState === "uncertain");
    const exact = candidates.filter((c) => c.titleState === "exact");
    if (uncertain.length && !exact.length) { reviews.push({ rank: 2, reason: "uncertain-title", wantedId: entry.id, episodeKey: key, candidates: uncertain.map((c) => reviewCandidate(c, entry)).sort(order) }); continue; }
    if (!exact.length) continue;
    const best = preferred(exact);
    if (best.length !== 1) { reviews.push({ rank: 1, reason: "ambiguous", wantedId: entry.id, episodeKey: key, candidates: best.map((c) => reviewCandidate(c, entry)).sort((a,b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || order(a,b)) }); continue; }
    selectionList.push(selectionFor(entry, best[0]));
  }
  if (reviews.length) { const review = reviews.sort((a,b) => b.rank-a.rank || order(a.candidates[0], b.candidates[0]))[0]; return { kind: "review", reason: review.reason, wantedId: review.wantedId, episodeKey: review.episodeKey, candidates: review.candidates }; }
  const selections = selectionList.sort((a,b) => a.episodeKey.localeCompare(b.episodeKey) || order(a,b));
  // A completed item with a large set of recognized episodes is a pack. Only expose
  // it as a pack when all remaining automatic choices come from it.
  const byItem = new Map<string, ParsedVideoCandidate[]>();
  for (const { item, parsed: p } of parsed) { const key = itemKeyOf(item); byItem.set(key, [...(byItem.get(key) ?? []), p]); }
  for (const [itemKey, files] of byItem) {
    const itemSelections = selections.filter((s) => itemKeyOf(s) === itemKey);
    const first = itemSelections[0];
    if (first === undefined) continue;
    // Every recognized eligible single-episode file in the pack, in a stable
    // order, so a manual season import can re-list the whole pack later.
    const recognized = files
      .filter((p) => p.bytes === null || p.bytes >= minimumPlausibleBytes)
      .filter((p) => !p.multiEpisode && p.seriesTitle !== null)
      .filter((p) => normalizedSeriesTitle(p.seriesTitle!) === normalizedSeriesTitle(first.seriesTitle) && p.season === first.season)
      .sort((a, b) => order(a, b));
    const recognizedEpisodeCount = new Set(recognized.map((p) => `${normalizedSeriesTitle(p.seriesTitle!)}|s${p.season}|e${p.episode}`)).size;
    if (recognizedEpisodeCount >= 3 && itemSelections.length === selections.length) {
      const totalBytes = recognized.some((file) => file.bytes === null)
        ? null
        : recognized.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
      return { kind: "season-pack", wantedSelections: itemSelections, packPreview: { provider: first.provider, itemType: first.itemType, remoteItemId: first.remoteItemId, seriesTitle: first.seriesTitle, season: first.season, recognizedEpisodeCount, totalBytes, fileLocators: recognized.map(packLocator) } };
    }
  }
  return selections.length ? { kind: "automatic", selections } : { kind: "none" };
}
