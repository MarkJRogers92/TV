import type { ContinuityCardPlan } from "./director.js";
import { scheduleScopedContinuityTag } from "../domain/models.js";
import { renderCacheKey } from "./render.js";
import type { ContinuityCardType, ContinuityFamily } from "./types.js";

/**
 * Marker tag for offline-rendered schedule-scoped continuity video.
 *
 * Generated media is ordinary catalog media - it plays through the existing
 * adapter and syncs like any other bumper - but the tag marks it as belonging
 * to exactly one completed schedule. Registration never adds it to a filler or
 * station-ID pool, so it cannot leak into another schedule's commercial breaks.
 */
export const GENERATED_CONTINUITY_TAG = scheduleScopedContinuityTag;

const TAG_KEY = "continuity";

export type GeneratedContinuityMetadata = {
  contentHash: string;
  cardType: ContinuityCardType;
  family: ContinuityFamily;
  scheduleRevision: string;
  wordingKey: string;
  durationMs: number;
  targetAiringIds: string[];
};

/**
 * Tag-safe encoding.
 *
 * `+` is part of the alphabet on purpose: it is both the target-id separator
 * and a character the wording key legitimately contains, and mangling it made a
 * rendered card unrecognisable to the very plan that produced it.
 */
const encode = (value: string) => value.replace(/[^A-Za-z0-9._:+-]+/gu, "-");

/** The tag list stored on the registered media item for one plan. */
export function generatedContinuityTags(plan: ContinuityCardPlan): string[] {
  return [
    "continuity",
    "generated",
    "visual-only",
    GENERATED_CONTINUITY_TAG,
    `${TAG_KEY}-hash=${plan.contentHash}`,
    `${TAG_KEY}-card=${plan.cardType}`,
    `${TAG_KEY}-family=${plan.family}`,
    `${TAG_KEY}-revision=${encode(plan.scheduleRevision)}`,
    `${TAG_KEY}-wording=${encode(plan.wordingKey)}`,
    `${TAG_KEY}-duration=${plan.durationMs}`,
    `${TAG_KEY}-targets=${plan.target.airingIds.map(encode).join("+")}`,
  ];
}

const tagValue = (tags: string[], key: string) =>
  tags.find((tag) => tag.startsWith(`${TAG_KEY}-${key}=`))?.slice(`${TAG_KEY}-${key}=`.length);

/** Parse the schedule binding back out of a registered generated asset. */
export function parseGeneratedContinuityTags(
  tags: string[],
): GeneratedContinuityMetadata | undefined {
  if (!tags.includes(GENERATED_CONTINUITY_TAG)) return undefined;
  const contentHash = tagValue(tags, "hash");
  const cardType = tagValue(tags, "card") as ContinuityCardType | undefined;
  const family = tagValue(tags, "family") as ContinuityFamily | undefined;
  const scheduleRevision = tagValue(tags, "revision");
  const wordingKey = tagValue(tags, "wording");
  const durationMs = Number(tagValue(tags, "duration"));
  const targetAiringIds = (tagValue(tags, "targets") ?? "")
    .split("+")
    .filter(Boolean);
  if (
    !contentHash ||
    !cardType ||
    !family ||
    !scheduleRevision ||
    !wordingKey ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return undefined;
  return { contentHash, cardType, family, scheduleRevision, wordingKey, durationMs, targetAiringIds };
}

/** Stable catalog id for a generated plan. */
export function generatedMediaId(plan: ContinuityCardPlan) {
  return `continuity-${renderCacheKey({
    contentHash: plan.contentHash,
    cardType: plan.cardType,
    target: plan.target.airingIds,
    family: plan.family,
    wording: plan.wordingKey,
    durationMs: plan.durationMs,
  }).slice(0, 24)}`;
}

export function generatedFileName(plan: ContinuityCardPlan) {
  const hash = renderCacheKey({
    contentHash: plan.contentHash,
    cardType: plan.cardType,
    target: plan.target.airingIds,
    family: plan.family,
    wording: plan.wordingKey,
    label: plan.label,
    title: plan.title,
    details: plan.details,
    durationMs: plan.durationMs,
  }).slice(0, 20);
  return `${plan.broadcastDate}-${plan.cardType}-${plan.family}-${hash}.mp4`;
}
