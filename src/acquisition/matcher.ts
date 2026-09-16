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
  | { readonly kind: "season-pack"; readonly wantedSelections: readonly MatchSelection[]; readonly packPreview: PackPreview }
  | {
      /**
       * A full-series collection may contain several safe requested-season
       * offers. These are deliberately never auto-selected: the user chooses
       * the provider collection and then explicitly imports that season.
      */
      readonly kind: "season-packs";
      readonly offers: readonly { readonly wantedId: string; readonly packPreview: PackPreview }[];
      /** Every Wanted entry covered by a requested-season collection offer. */
      readonly coveredWantedIds: readonly string[];
      /** Unrelated automatic matches remain eligible in the same poll. */
      readonly selections: readonly MatchSelection[];
      /** Unrelated ambiguity remains a review; it is never silently dropped. */
      readonly review: Extract<MatchPlan, { kind: "review" }> | null;
    };

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

/**
 * A series title with a trailing year removed, for *matching* only.
 *
 * Providers routinely decorate a series with its year -- a wanted "Night court"
 * arrives as "Night Court (1984)" -- and the year is not part of the identity, so
 * treating it as significant sent an otherwise exact episode to manual review and
 * hid its season pack. Deliberately separate from `normalizedSeriesTitle`, which
 * keys stored episode identity and must not change; anything that is only a year
 * is left alone so a title like "1923" does not canonicalise to nothing.
 */
function canonicalSeriesTitle(title: string): string {
  const normalized = normalizedSeriesTitle(title);
  const withoutYear = normalized.replace(/\s+(?:19|20)\d{2}$/, "");
  return withoutYear || normalized;
}

function candidateFor(item: RemoteItem, parsed: ParsedVideoCandidate, wanted: WantedEpisode): Candidate | null {
  if (parsed.bytes !== null && parsed.bytes < minimumPlausibleBytes) return null;
  if (parsed.season !== wanted.season || (parsed.episodeEnd === null ? parsed.episode !== wanted.episode : wanted.episode < parsed.episode || wanted.episode > parsed.episodeEnd)) return null;
  const target = canonicalSeriesTitle(wanted.seriesTitle);
  const own = parsed.seriesTitle === null ? "" : canonicalSeriesTitle(parsed.seriesTitle);
  const fallbackTitle = itemSeriesTitle(item.originalName);
  const fallback = fallbackTitle === null ? "" : canonicalSeriesTitle(fallbackTitle);
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

/** One reviewed file per episode, selected by the stable provider identity order. */
function oneFilePerEpisode(files: readonly ParsedVideoCandidate[]): readonly ParsedVideoCandidate[] {
  const selected = new Map<number, ParsedVideoCandidate>();
  for (const file of [...files].sort((left, right) => order(left, right))) {
    if (!selected.has(file.episode)) selected.set(file.episode, file);
  }
  return [...selected.values()].sort((left, right) => left.episode - right.episode || order(left, right));
}

/**
 * Finds manually selectable requested-season slices in completed collections
 * that contain more than one season. We require exact parsed filenames for
 * the requested series and an episode that is actually Wanted, so an item
 * cannot become a collection offer merely because its display name resembles
 * a show title.
 */
function fullSeriesSeasonOffers(
  wanted: readonly WantedEpisode[],
  parsed: readonly { readonly item: RemoteItem; readonly parsed: ParsedVideoCandidate }[],
  doneKeys: ReadonlySet<string>,
  doneRemote: ReadonlySet<string>,
): readonly { readonly wantedId: string; readonly packPreview: PackPreview }[] {
  const byItem = new Map<string, { item: RemoteItem; files: ParsedVideoCandidate[] }>();
  for (const value of parsed) {
    const key = itemKeyOf(value.item);
    const current = byItem.get(key);
    if (current) current.files.push(value.parsed);
    else byItem.set(key, { item: value.item, files: [value.parsed] });
  }
  const offers: Array<{ wantedId: string; packPreview: PackPreview }> = [];
  for (const entry of [...wanted].sort((left, right) => episodeKey(left.seriesTitle, left.season, left.episode).localeCompare(episodeKey(right.seriesTitle, right.season, right.episode)))) {
    if (doneKeys.has(episodeKey(entry.seriesTitle, entry.season, entry.episode))) continue;
    const target = canonicalSeriesTitle(entry.seriesTitle);
    for (const { item, files } of byItem.values()) {
      const matchingSeries = files
        .filter((file) => !file.multiEpisode && file.seriesTitle !== null)
        .filter((file) => canonicalSeriesTitle(file.seriesTitle!) === target)
        .filter((file) => file.bytes === null || file.bytes >= minimumPlausibleBytes);
      const completeSeasons = new Map<number, Set<number>>();
      for (const file of matchingSeries) {
        const episodes = completeSeasons.get(file.season) ?? new Set<number>();
        episodes.add(file.episode);
        completeSeasons.set(file.season, episodes);
      }
      if ([...completeSeasons.values()].filter((episodes) => episodes.size >= 3).length < 2) continue;
      const requested = oneFilePerEpisode(matchingSeries
        .filter((file) => file.season === entry.season)
        .filter((file) => !doneRemote.has(`${file.provider}\0${file.remoteItemId}\0${file.remoteFileId}`)));
      if (requested.length < 3 || !requested.some((file) => file.episode === entry.episode)) continue;
      const totalBytes = requested.some((file) => file.bytes === null)
        ? null
        : requested.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
      offers.push({
        wantedId: entry.id,
        packPreview: {
          provider: item.provider,
          itemType: item.itemType,
          remoteItemId: item.remoteItemId,
          seriesTitle: entry.seriesTitle,
          season: entry.season,
          recognizedEpisodeCount: requested.length,
          totalBytes,
          fileLocators: requested.map(packLocator),
        },
      });
    }
  }
  const seen = new Set<string>();
  return offers
    .sort((left, right) =>
      left.packPreview.provider.localeCompare(right.packPreview.provider) ||
      left.packPreview.itemType.localeCompare(right.packPreview.itemType) ||
      left.packPreview.remoteItemId.localeCompare(right.packPreview.remoteItemId) ||
      left.wantedId.localeCompare(right.wantedId),
    )
    .filter((offer) => {
      const key = `${offer.packPreview.provider}\0${offer.packPreview.itemType}\0${offer.packPreview.remoteItemId}\0${normalizedSeriesTitle(offer.packPreview.seriesTitle)}\0${offer.packPreview.season}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function matchCompletedFiles(wanted: readonly WantedEpisode[], remoteItems: readonly RemoteItem[], completed: readonly CompletedImport[]): MatchPlan {
  const doneKeys = new Set(completed.map((x) => x.episodeKey));
  const doneRemote = new Set(completed.map((x) => `${x.provider}\0${x.remoteItemId}\0${x.remoteFileId}`));
  const parsed = remoteItems
    .filter(completedItem)
    .flatMap((item) => item.files.map((file) => ({ item, parsed: parseVideoCandidate(file) })).filter((value): value is { item: RemoteItem; parsed: ParsedVideoCandidate } => value.parsed !== null));
  const collectionOffers = fullSeriesSeasonOffers(wanted, parsed, doneKeys, doneRemote);
  const collectionEpisodeKeys = new Set(
    collectionOffers.flatMap((offer) => offer.packPreview.fileLocators
      .filter((locator) => locator.episode !== null)
      .map((locator) => `${canonicalSeriesTitle(offer.packPreview.seriesTitle)}\0${offer.packPreview.season}\0${locator.episode}`)),
  );
  const selectionList: MatchSelection[] = [];
  const reviews: Array<{ rank: number; reason: "ambiguous" | "multi-episode" | "uncertain-title"; wantedId: string; episodeKey: string; candidates: ReviewCandidate[] }> = [];
  for (const entry of [...wanted].sort((a, b) => episodeKey(a.seriesTitle,a.season,a.episode).localeCompare(episodeKey(b.seriesTitle,b.season,b.episode)))) {
    const key = episodeKey(entry.seriesTitle, entry.season, entry.episode);
    if (doneKeys.has(key)) continue;
    if (collectionEpisodeKeys.has(`${canonicalSeriesTitle(entry.seriesTitle)}\0${entry.season}\0${entry.episode}`)) continue;
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
  const review = reviews.length
    ? (() => {
        const next = reviews.sort((a,b) => b.rank-a.rank || order(a.candidates[0], b.candidates[0]))[0]!;
        return { kind: "review" as const, reason: next.reason, wantedId: next.wantedId, episodeKey: next.episodeKey, candidates: next.candidates };
      })()
    : null;
  const selections = selectionList.sort((a,b) => a.episodeKey.localeCompare(b.episodeKey) || order(a,b));
  if (collectionOffers.length) {
    const coveredWantedIds = [...wanted]
      .filter((entry) => collectionEpisodeKeys.has(`${canonicalSeriesTitle(entry.seriesTitle)}\0${entry.season}\0${entry.episode}`))
      .map((entry) => entry.id)
      .sort();
    return { kind: "season-packs", offers: collectionOffers, coveredWantedIds, selections, review };
  }
  if (review) return review;
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
