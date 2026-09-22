import { DateTime } from "luxon";
import type {
  Channel,
  MediaItem,
  Pool,
  Schedule,
  ScheduleEntry,
} from "../domain/models.js";
import { fillToBoundary, type FillerHistory } from "../scheduler/fill.js";
import {
  classifyExistingContinuityAssets,
  classifyGeneratedContinuityAssets,
} from "./catalog.js";
import {
  composeContinuityBreak,
  reserveRemovalPlans,
  type BreakEntry,
} from "./compose.js";
import { deriveContinuityContext } from "./context.js";
import { planContinuityCards, type ContinuityCardPlan } from "./director.js";
import { continuityPlanContentHash, scheduleContentHash } from "./identity.js";
import { rankContinuityCandidates } from "./select.js";
import type {
  ContinuityAsset,
  ContinuityCardType,
  ContinuityConfig,
  ContinuityFamily,
  ContinuityHistoryEntry,
  ContinuityRole,
} from "./types.js";

export type Decision = ContinuityHistoryEntry & {
  scheduleRevision: string;
  insertionInstant: string;
  role: ContinuityRole;
  cardType: ContinuityCardType;
  targetKey: string;
  family: ContinuityFamily;
  contentHash: string;
  status: "planned";
};

/**
 * The evidence a continuity pass may draw on beyond the schedule itself.
 *
 * `channel`/`pools`/`fillerHistory` are what make the bounded exact refill use
 * the same commercial pool, cooldown and bag the ordinary schedule used.
 * `adjacentSchedules` are completed schedules (in practice yesterday's) whose
 * airings a post-midnight card may legitimately name.
 */
export type ContinuityEnvironment = {
  channel?: Channel;
  pools?: Pool[];
  fillerHistory?: FillerHistory[];
  adjacentSchedules?: Schedule[];
  /** Media already used elsewhere in this schedule, so refill rotates. */
  exclude?: ReadonlySet<string>;
};

const editorial = (entry: ScheduleEntry) =>
  entry.kind === "episode" || entry.kind === "movie";

const informationalRoles = new Set<ContinuityRole>([
  "next",
  "next-later",
  "tonight",
  "weekend",
  "after-dark",
]);

const localTime = (instant: string, timezone: string) =>
  DateTime.fromISO(instant, { setZone: true }).setZone(timezone).toFormat("HH:mm");

type Placement =
  | { type: "keep"; index: number }
  | { type: "fill"; entry: ScheduleEntry }
  | { type: "card" };

function placedCardStartMs(placements: Placement[], breakEntries: ScheduleEntry[], startMs = Date.parse(breakEntries[0]?.start ?? "")) {
  const cardIndex = placements.findIndex((placement) => placement.type === "card");
  if (cardIndex < 0) return undefined;
  let start = startMs;
  for (const placement of placements.slice(0, cardIndex)) {
    start += placement.type === "keep"
      ? breakEntries[placement.index]?.durationMs ?? 0
      : placement.type === "fill" ? placement.entry.durationMs : 0;
  }
  return Number.isFinite(start) ? start : undefined;
}

function breakFillItems(input: {
  environment?: ContinuityEnvironment;
  media: MediaItem[];
  stationIdsEligible: boolean;
}): MediaItem[] {
  const channel = input.environment?.channel;
  if (!channel) return [];
  const poolIds = [
    ...channel.breakPolicy.poolIds,
    ...(input.stationIdsEligible ? channel.breakPolicy.stationIdPoolIds : []),
  ];
  const pools = input.environment?.pools ?? [];
  const mediaById = new Map(input.media.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const poolId of poolIds) {
    const pool = pools.find((candidate) => candidate.id === poolId);
    if (!pool) continue;
    for (const mediaId of pool.mediaIds) {
      if (seen.has(mediaId)) continue;
      const item = mediaById.get(mediaId);
      if (!item || !pool.kinds.includes(item.kind)) continue;
      seen.add(mediaId);
      items.push(item);
    }
  }
  return items;
}

/**
 * Build the exact replacement for one break, or refuse.
 *
 * Two whole-item paths, cheapest first:
 *   1. the tested exact swap - a set of complete items whose total is exactly
 *      the card's duration;
 *   2. a bounded refill - remove the smallest set of whole items that still
 *      covers the card, then fill the released remainder from the *channel's
 *      own* interstitial pool so the break keeps its exact end instant.
 *
 * Either way nothing is trimmed or retimed, the break never gains dead air, and
 * a break that already carries an information card (including a legacy bumper)
 * is left alone rather than given a second one.
 */
export function buildBreakPlacements(input: {
  breakEntries: ScheduleEntry[];
  card: BreakEntry;
  classify: (entry: ScheduleEntry) => BreakEntry;
  media: MediaItem[];
  environment?: ContinuityEnvironment;
  maximumSpokenElements: number;
  maximumContinuityMs: number;
  seed: string;
  replaceInformational?: boolean;
}): Placement[] | undefined {
  const original = input.breakEntries.map(input.classify);
  if (!original.length) return undefined;
  const totalMs = original.reduce((sum, entry) => sum + entry.durationMs, 0);
  const cardMs = input.card.durationMs;
  if (cardMs <= 0 || cardMs >= totalMs) return undefined;
  // Refuse a second information card, including a legacy information bumper
  // that means the break is already spent.
  if (
    original.some((entry) => entry.kind === "continuity" && entry.informational) &&
    !input.replaceInformational
  )
    return undefined;
  const originalCommercialMs = original
    .filter((entry) => entry.kind === "commercial")
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  const commercialsAreMajority = (commercialMs: number) =>
    commercialMs * 2 > totalMs || commercialMs >= originalCommercialMs;

  // Path 1: the cheapest valid swap, reusing the already-tested composer.
  const composed = composeContinuityBreak({
    original,
    promo: input.card,
    maximumSpokenElements: input.maximumSpokenElements,
    maximumContinuityMs: input.maximumContinuityMs,
  });
  if (composed.usedContinuity) {
    const placements: Placement[] = [];
    for (const entry of composed.entries) {
      if (entry === input.card) {
        placements.push({ type: "card" });
        continue;
      }
      const index = original.indexOf(entry);
      if (index === -1) {
        placements.length = 0;
        break;
      }
      placements.push({ type: "keep", index });
    }
    const commercialMs = placements.reduce((sum, placement) => {
      if (placement.type !== "keep") return sum;
      const entry = original[placement.index]!;
      return sum + (entry.kind === "commercial" ? entry.durationMs : 0);
    }, 0);
    if (placements.length === composed.entries.length && commercialsAreMajority(commercialMs))
      return placements;
  }

  // Path 2: bounded refill from the channel's own interstitial pool.
  const environment = input.environment;
  if (!environment?.channel) return undefined;
  const breakStart = Date.parse(input.breakEntries[0]!.start);
  const stationIdsEligible =
    DateTime.fromISO(input.breakEntries[0]!.start, { setZone: true }).setZone(
      environment.channel.timezone,
    ).minute === 0;
  const fillItems = breakFillItems({
    environment,
    media: input.media,
    stationIdsEligible,
  });
  if (!fillItems.length) return undefined;
  for (const plan of reserveRemovalPlans(original, cardMs)) {
    const removed = new Set(plan.indexes);
    const keptIndexes = original
      .map((_, index) => index)
      .filter((index) => !removed.has(index));
    const kept = keptIndexes.map((index) => original[index]!);
    const continuityMs =
      kept
        .filter((entry) => entry.kind === "continuity")
        .reduce((sum, entry) => sum + entry.durationMs, 0) + cardMs;
    const spoken =
      kept.filter((entry) => entry.kind === "continuity" && entry.spoken).length +
      (input.card.spoken ? 1 : 0);
    const informational =
      kept.filter((entry) => entry.kind === "continuity" && entry.informational).length +
      (input.card.informational ? 1 : 0);
    if (
      continuityMs > input.maximumContinuityMs ||
      spoken > input.maximumSpokenElements ||
      informational > 1
    )
      continue;
    const keptDuration = kept.reduce((sum, entry) => sum + entry.durationMs, 0);
    const gapMs = plan.total - cardMs;
    let fillEntries: ScheduleEntry[] = [];
    if (gapMs > 0) {
      const fillStart = breakStart + keptDuration;
      const filled = fillToBoundary({
        start: new Date(fillStart),
        boundary: new Date(fillStart + gapMs),
        items: fillItems,
        history: environment.fillerHistory,
        cooldownMinutes: environment.channel.breakPolicy.cooldownMinutes,
        seed: `${input.seed}:refill:${fillStart}`,
        source: "continuity-refill",
        stationIdsEligible,
        timezone: environment.channel.timezone,
        channelId: environment.channel.id,
        exclude: environment.exclude,
      });
      if (filled.entries.some((entry) => entry.kind === "flex")) continue;
      if (filled.entries.reduce((sum, entry) => sum + entry.durationMs, 0) !== gapMs)
        continue;
      fillEntries = filled.entries;
    }
    const commercialMs =
      kept
        .filter((entry) => entry.kind === "commercial")
        .reduce((sum, entry) => sum + entry.durationMs, 0) +
      fillEntries
        .filter((entry) => entry.kind === "commercial")
        .reduce((sum, entry) => sum + entry.durationMs, 0);
    if (!commercialsAreMajority(commercialMs)) continue;
    return [
      ...keptIndexes.map((index): Placement => ({ type: "keep", index })),
      ...fillEntries.map((entry): Placement => ({ type: "fill", entry })),
      { type: "card" },
    ];
  }
  return undefined;
}

/**
 * The break a plan belongs to, located by its first interstitial entry.
 *
 * Each plan names a distinct break, so an earlier replacement in the same pass
 * cannot move a later plan's anchor.
 */
function locateBreak(entries: ScheduleEntry[], breakEntryId: string) {
  const anchor = entries.findIndex((entry) => entry.id === breakEntryId);
  if (anchor === -1 || editorial(entries[anchor]!)) return undefined;
  let start = anchor;
  while (start > 0 && !editorial(entries[start - 1]!)) start -= 1;
  let end = anchor;
  while (end < entries.length && !editorial(entries[end]!)) end += 1;
  if (start === 0 || end >= entries.length) return undefined;
  return { start, end };
}

/**
 * The generated card that exactly matches a plan's schedule binding.
 *
 * The full content hash, the card class, the family, the wording and every
 * target id have to agree: an asset rendered for a different lineup, a
 * different target or a different wording is not reused.
 */
function matchGenerated(plan: ContinuityCardPlan, assets: ContinuityAsset[]) {
  return assets.find(
    (asset) =>
      asset.contentHash === plan.contentHash &&
      asset.role === plan.cardType &&
      asset.scheduleRevision === plan.scheduleRevision &&
      asset.family === plan.family &&
      asset.wordingKey === plan.wordingKey &&
      asset.targetAiringIds?.length === plan.target.airingIds.length &&
      plan.target.airingIds.every((id) => asset.targetAiringIds?.includes(id)),
  );
}

export type ApplyContinuityInput = {
  schedule: Schedule;
  media: MediaItem[];
  config: ContinuityConfig;
  history: ContinuityHistoryEntry[];
  environment?: ContinuityEnvironment;
};

/** The break classifier for one media catalog: continuity, commercial or filler. */
export function continuityBreakClassifier(media: MediaItem[]) {
  const continuity = [
    ...classifyExistingContinuityAssets(media),
    ...classifyGeneratedContinuityAssets(media),
  ];
  const byMediaId = new Map(
    continuity.flatMap((asset) =>
      asset.mediaId ? [[asset.mediaId, asset] as const] : [],
    ),
  );
  const classify = (entry: ScheduleEntry): BreakEntry => {
    const asset = entry.mediaId ? byMediaId.get(entry.mediaId) : undefined;
    return {
      id: entry.id,
      durationMs: entry.durationMs,
      kind: asset ? "continuity" : entry.kind === "commercial" ? "commercial" : "filler",
      role: asset?.role === "interruption" ? undefined : asset?.role,
      spoken: Boolean(asset?.voicePresent),
      informational: Boolean(asset && informationalRoles.has(asset.role)),
    };
  };
  return { classify, assets: continuity };
}

/**
 * Whether one plan's break can be rebuilt exactly, before any asset exists.
 *
 * The planner uses this as part of its acceptance predicate, and the offline
 * preparer uses the same function to decide which cards are worth rendering, so
 * a card is never rendered for a break it could not be inserted into.
 */
export function canPlaceCard(input: {
  schedule: Schedule;
  media: MediaItem[];
  plan: ContinuityCardPlan;
  environment?: ContinuityEnvironment;
  config: ContinuityConfig;
  /** Actual duration of the asset that will be inserted; defaults to the plan's. */
  durationMs?: number;
  spoken?: boolean;
  requiredLocalTime?: string;
  requiresSameLocalDateAsTarget?: boolean;
}): boolean {
  const { classify } = continuityBreakClassifier(input.media);
  const located = locateBreak(input.schedule.entries, input.plan.breakEntryId);
  if (!located) return false;
  const breakEntries = input.schedule.entries.slice(located.start, located.end);
  const targetTitle = input.plan.target.titles[0];
  const replaceInformational = input.plan.cardType === "next" && breakEntries.some(
    (entry) => entry.source === "continuity:next" &&
      entry.selectionExplanation === `Schedule-scoped next continuity for ${targetTitle}`,
  );
  const placements = buildBreakPlacements({
      breakEntries,
      card: {
        id: `continuity:${input.plan.id}`,
        durationMs: input.durationMs ?? input.plan.durationMs,
        kind: "continuity",
        role: input.plan.role,
        spoken: input.spoken ?? false,
        informational: true,
      },
      classify,
      media: input.media,
      environment: input.environment,
      maximumSpokenElements: input.config.maximumSpokenElementsPerBreak,
      maximumContinuityMs: input.config.maximumContinuitySecondsPerBreak * 1_000,
      seed: `${input.schedule.id}:${input.plan.breakEntryId}`,
      replaceInformational,
    });
  if (!placements) return false;
  const cardStart = placedCardStartMs(placements, breakEntries, Date.parse(input.plan.insertionInstant));
  if (cardStart === undefined) return false;
  if (input.requiredLocalTime &&
    DateTime.fromMillis(cardStart).setZone(input.schedule.timezone).toFormat("HH:mm") !== input.requiredLocalTime)
    return false;
  if (input.requiresSameLocalDateAsTarget) {
    const targetStart = Date.parse(input.plan.target.times[0] ?? "");
    if (!Number.isFinite(targetStart) ||
      DateTime.fromMillis(cardStart).setZone(input.schedule.timezone).toISODate() !==
      DateTime.fromMillis(targetStart).setZone(input.schedule.timezone).toISODate()) return false;
  }
  if (input.requiresSameLocalDateAsTarget && input.plan.cardType === "weekend" && input.plan.target.times.length > 1) {
    const firstDate = DateTime.fromISO(input.plan.target.times[0]!, { setZone: true }).setZone(input.schedule.timezone).toISODate();
    const secondDate = DateTime.fromISO(input.plan.target.times[1]!, { setZone: true }).setZone(input.schedule.timezone).toISODate();
    if (firstDate !== secondDate) return false;
  }
  return true;
}

/**
 * Replace complete boundary items with validated local continuity.
 *
 * This is deliberately a post-process over a finalized schedule: NEXT targets
 * cannot be truthful until the editorial lineup and movie occurrences are
 * fixed. The director decides which card each break should carry, the composer
 * only ever swaps whole existing items or refills from the channel's own pool
 * for the exact same duration, and cadence only advances for a card that is
 * actually inserted. If either step cannot succeed, the original validated
 * break is left untouched - the whole pass fails open.
 */
export function applyContinuityToSchedule(input: ApplyContinuityInput): {
  schedule: Schedule;
  decisions: Decision[];
  contentHash: string;
  planned: number;
} {
  if (!input.config.enabled)
    return {
      schedule: input.schedule,
      decisions: [],
      contentHash: continuityPlanContentHash(
        input.schedule,
        input.environment?.adjacentSchedules,
      ),
      planned: 0,
    };
  const generated = classifyGeneratedContinuityAssets(input.media);
  const existing = classifyExistingContinuityAssets(input.media);
  // Both catalogues describe what is already sitting in a break, so a second
  // pass over an already-processed schedule still sees the earlier card.
  const mediaById = new Map(input.media.map((item) => [item.id, item]));
  const { classify } = continuityBreakClassifier(input.media);
  const contextCache = new Map<string, ReturnType<typeof deriveContinuityContext>>();
  const contextAt = (insertionInstant: string) => {
    const cached = contextCache.get(insertionInstant);
    if (cached) return cached;
    const context = deriveContinuityContext({
      schedules: [input.schedule, ...(input.environment?.adjacentSchedules ?? [])],
      media: input.media,
      insertionInstant,
      managedLineup: true,
    });
    contextCache.set(insertionInstant, context);
    return context;
  };
  /**
   * Fall back to an existing station clip when no generated card is registered.
   *
   * The legacy catalog only has NEXT material, and it goes through the original
   * selection contract - staleness, unmanaged-lineup suppression, title scoping,
   * repeat cooldowns and interruption gating all still apply.
   */
  const matchExisting = (plan: ContinuityCardPlan) => {
    if (!["next", "tonight", "weekend"].includes(plan.cardType)) return undefined;
    const context = contextAt(plan.insertionInstant);
    const { candidates } = rankContinuityCandidates(context, existing, input.history, {
      now: plan.insertionInstant,
      stagedInterruptionsEnabled: false,
      playbackHealthy: false,
      clipCooldownMinutes: input.config.clipCooldownMinutes,
      targetCooldownMinutes: input.config.targetCooldownMinutes,
      oddPersonaCooldownHours: input.config.oddPersonaCooldownHours,
      promoFrequency: 1,
    });
    const compatible = candidates.filter(
      (asset) =>
        asset.role === plan.cardType &&
        asset.airReady &&
        asset.available !== false &&
        Boolean(asset.path) &&
        Boolean(asset.durationMs),
    );
    // Explicitly title-scoped spoken promos should win over a silent generated
    // card for the same exact NEXT airing. Generic assets remain a later choice.
    compatible.sort((left, right) => Number(right.scope === "title") - Number(left.scope === "title"));
    return compatible.find((asset) => {
      if (!asset.lastBeforeTarget) return true;
      const targetId = plan.target.airingIds[0];
      const targetEntry = input.schedule.entries.find((entry) =>
        entry.id === targetId || entry.movieOccurrenceKey === targetId,
      );
      const placementConstraintsHold = (
        plan.cardType === "next" &&
        targetEntry?.kind === "movie" &&
        (targetEntry.sourceOffsetMs ?? 0) === 0
      );
      if (asset.lastBeforeTarget && !placementConstraintsHold) return false;
      return canPlaceCard({
        schedule: input.schedule,
        media: input.media,
        plan,
        environment,
        config: input.config,
        durationMs: asset.durationMs,
        spoken: Boolean(asset.voicePresent),
        requiredLocalTime: asset.requiredLocalTime,
        requiresSameLocalDateAsTarget: asset.requiresSameLocalDateAsTarget,
      });
    });
  };
  const matchAsset = (plan: ContinuityCardPlan) => {
    const voiced = matchExisting(plan);
    return (plan.cardType === "next" && voiced) || matchGenerated(plan, generated) || voiced;
  };

  const entries = [...input.schedule.entries];
  const usedMediaIds = new Set(
    entries.flatMap((entry) =>
      !editorial(entry) && entry.mediaId ? [entry.mediaId] : [],
    ),
  );
  const environment: ContinuityEnvironment = {
    ...input.environment,
    exclude: new Set([...(input.environment?.exclude ?? []), ...usedMediaIds]),
  };
  /** A plan is accepted only when its asset exists and its break can be rebuilt exactly. */
  const accept = (plan: ContinuityCardPlan) => {
    const asset = matchAsset(plan);
    if (!asset) return false;
    const assetMedia = asset.mediaId ? mediaById.get(asset.mediaId) : undefined;
    const durationMs = asset.durationMs ?? assetMedia?.durationMs;
    if (!durationMs) return false;
    return canPlaceCard({
      schedule: input.schedule,
      media: input.media,
      plan,
      environment,
      config: input.config,
      durationMs,
      spoken: Boolean(asset.voicePresent),
      requiredLocalTime: asset.requiredLocalTime,
      requiresSameLocalDateAsTarget: asset.requiresSameLocalDateAsTarget,
    });
  };

  const plan = planContinuityCards({
    schedule: input.schedule,
    media: input.media,
    config: input.config,
    history: input.history,
    adjacentSchedules: input.environment?.adjacentSchedules,
    isAvailable: accept,
  });
  const { contentHash } = plan;
  const decisions: Decision[] = [];

  for (const card of plan.plans) {
    const located = locateBreak(entries, card.breakEntryId);
    if (!located) continue;
    const originalEntries = entries.slice(located.start, located.end);
    if (!originalEntries.length) continue;
    const asset = matchAsset(card);
    const assetMedia = asset?.mediaId ? mediaById.get(asset.mediaId) : undefined;
    const durationMs = asset?.durationMs ?? assetMedia?.durationMs;
    if (!asset || !assetMedia || !durationMs) continue;
    const targetTitle = card.target.titles[0];
    const replaceInformational = card.cardType === "next" && originalEntries.some(
      (entry) => entry.source === "continuity:next" &&
        entry.selectionExplanation === `Schedule-scoped next continuity for ${targetTitle}`,
    );
    const placements = buildBreakPlacements({
      breakEntries: originalEntries,
      card: {
        id: `continuity:${asset.id}:${card.insertionInstant}`,
        durationMs,
        kind: "continuity",
        role: card.role,
        spoken: Boolean(asset.voicePresent),
        informational: true,
      },
      classify,
      media: input.media,
      environment,
      maximumSpokenElements: input.config.maximumSpokenElementsPerBreak,
      maximumContinuityMs: input.config.maximumContinuitySecondsPerBreak * 1_000,
      seed: `${input.schedule.id}:${card.breakEntryId}`,
      replaceInformational,
    });
    if (!placements) continue;
    if (asset.lastBeforeTarget) {
      const targetStart = Date.parse(card.target.times[0] ?? "");
      const breakEnd = Date.parse(originalEntries.at(-1)!.end);
      if (
        card.cardType !== "next" ||
        !input.schedule.entries.some((entry) =>
          (entry.id === card.target.airingIds[0] || entry.movieOccurrenceKey === card.target.airingIds[0]) &&
          entry.kind === "movie" && (entry.sourceOffsetMs ?? 0) === 0,
        ) ||
        targetStart !== breakEnd
      ) continue;
      const cardPlacement = placements.findIndex((placement) => placement.type === "card");
      if (cardPlacement < 0) continue;
      const [lastCard] = placements.splice(cardPlacement, 1);
      placements.push(lastCard!);
    }

    const actualCardStart = placedCardStartMs(placements, originalEntries, Date.parse(card.insertionInstant));
    if (actualCardStart === undefined) continue;
    if (asset.requiredLocalTime &&
      DateTime.fromMillis(actualCardStart).setZone(input.schedule.timezone).toFormat("HH:mm") !== asset.requiredLocalTime)
      continue;
    if (asset.requiresSameLocalDateAsTarget &&
      DateTime.fromMillis(actualCardStart).setZone(input.schedule.timezone).toISODate() !==
      DateTime.fromISO(card.target.times[0]!, { setZone: true }).setZone(input.schedule.timezone).toISODate())
      continue;
    if (card.cardType === "weekend" && card.target.times.length > 1 &&
      DateTime.fromISO(card.target.times[0]!, { setZone: true }).setZone(input.schedule.timezone).toISODate() !==
      DateTime.fromISO(card.target.times[1]!, { setZone: true }).setZone(input.schedule.timezone).toISODate())
      continue;

    let at = Date.parse(card.insertionInstant);
    const replacement = placements.map((placement): ScheduleEntry => {
      const originalEntry =
        placement.type === "keep" ? originalEntries[placement.index] : undefined;
      const fillEntry = placement.type === "fill" ? placement.entry : undefined;
      const entryDurationMs =
        placement.type === "card"
          ? durationMs
          : (originalEntry?.durationMs ?? fillEntry?.durationMs ?? 0);
      const startInstant = new Date(at).toISOString();
      at += entryDurationMs;
      const endInstant = new Date(at).toISOString();
      if (originalEntry)
        return {
          ...originalEntry,
          start: startInstant,
          end: endInstant,
          localStart: localTime(startInstant, input.schedule.timezone),
          localEnd: localTime(endInstant, input.schedule.timezone),
        };
      if (fillEntry)
        return {
          ...fillEntry,
          start: startInstant,
          end: endInstant,
          localStart: localTime(startInstant, input.schedule.timezone),
          localEnd: localTime(endInstant, input.schedule.timezone),
          source: fillEntry.source ?? "continuity-refill",
        };
      return {
        id: `continuity:${asset.id}:${card.insertionInstant}`,
        start: startInstant,
        end: endInstant,
        localStart: localTime(startInstant, input.schedule.timezone),
        localEnd: localTime(endInstant, input.schedule.timezone),
        durationMs: entryDurationMs,
        kind: assetMedia.kind,
        title: assetMedia.title,
        mediaId: assetMedia.id,
        path: assetMedia.path,
        source: `continuity:${card.cardType}`,
        selectionExplanation: `Schedule-scoped ${card.cardType} continuity for ${
          card.target.titles[0] ?? "the next airing"
        }`,
      };
    });
    if (at !== Date.parse(originalEntries.at(-1)!.end)) continue;
    entries.splice(located.start, originalEntries.length, ...replacement);
    decisions.push({
      assetId: asset.id,
      targetAiringId: card.target.airingIds[0],
      personaId: asset.personaId,
      airedAt: card.insertionInstant,
      cardType: card.cardType,
      targetKey: card.target.airingIds.join("+"),
      family: card.family,
      scheduleRevision: input.schedule.id,
      insertionInstant: card.insertionInstant,
      role: card.cardType,
      contentHash: card.contentHash,
      status: "planned",
      state: "planned",
    });
  }

  if (!decisions.length)
    return { schedule: input.schedule, decisions, contentHash, planned: plan.plans.length };
  return {
    schedule: {
      ...input.schedule,
      entries,
      continuityBinding: {
        contentHash,
        appliedHash: scheduleContentHash({ ...input.schedule, entries }),
        adjacent: (input.environment?.adjacentSchedules ?? []).map((schedule) => ({
          date: schedule.date,
          hash: scheduleContentHash(schedule),
        })),
      },
      diagnostics: [
        ...input.schedule.diagnostics,
        {
          code: "CONTINUITY_PLANNED",
          message: `Planned ${decisions.length} exact-fit continuity insertion${
            decisions.length === 1 ? "" : "s"
          }`,
        },
      ],
    },
    decisions,
    contentHash,
    planned: plan.plans.length,
  };
}
