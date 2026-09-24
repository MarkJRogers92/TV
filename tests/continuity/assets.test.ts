import { expect, test } from "vitest";
import type { MediaItem } from "../../src/domain/models.js";
import {
  GENERATED_CONTINUITY_TAG,
  generatedContinuityTags,
  generatedFileName,
  generatedMediaId,
  parseGeneratedContinuityTags,
} from "../../src/continuity/assets.js";
import { classifyGeneratedContinuityAssets } from "../../src/continuity/catalog.js";
import type { ContinuityCardPlan } from "../../src/continuity/director.js";

const plan = (overrides: Partial<ContinuityCardPlan> = {}): ContinuityCardPlan => ({
  id: "marktv-laughs:2026-09-20:next:b-1:syndication",
  channelId: "marktv-laughs",
  broadcastDate: "2026-09-20",
  scheduleRevision: "schedule-2026-09-20",
  contentHash: "abcdef0123456789",
  cardType: "next",
  role: "next",
  family: "syndication",
  label: "NEXT",
  title: "Night Court",
  details: ["COMING UP ON MARKTV"],
  footer: "MARKTV",
  durationMs: 5_000,
  insertionInstant: "2026-09-20T23:30:00.000Z",
  breakEntryId: "break-id",
  target: {
    airingIds: ["b-1"],
    titles: ["Night Court"],
    times: ["2026-09-20T23:30:30.000Z"],
  },
  wordingKey: "marktv-laughs:2026-09-20:abcdef:next:b-1",
  ...overrides,
});

const generatedMedia = (value: ContinuityCardPlan, overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: generatedMediaId(value),
  source: "local-folder",
  path: `/generated/${generatedFileName(value)}`,
  kind: "bumper",
  title: value.id,
  durationMs: value.durationMs,
  durationStatus: "ok",
  available: true,
  tags: generatedContinuityTags(value),
  ...overrides,
});

test("carries the full schedule binding in tags and reads it back", () => {
  const value = plan();
  const parsed = parseGeneratedContinuityTags(generatedContinuityTags(value));
  expect(parsed).toEqual({
    contentHash: value.contentHash,
    cardType: "next",
    family: "syndication",
    scheduleRevision: value.scheduleRevision,
    wordingKey: value.wordingKey,
    durationMs: 5_000,
    targetAiringIds: ["b-1"],
  });
  expect(generatedContinuityTags(value)).toContain(GENERATED_CONTINUITY_TAG);
  expect(parseGeneratedContinuityTags(["bumper"])).toBeUndefined();
});

test("names and ids are stable and differ across schedules and targets", () => {
  expect(generatedFileName(plan())).toBe(generatedFileName(plan()));
  expect(generatedMediaId(plan())).toBe(generatedMediaId(plan()));
  expect(generatedFileName(plan({ contentHash: "other" }))).not.toBe(generatedFileName(plan()));
  expect(
    generatedMediaId(plan({ target: { airingIds: ["c-1"], titles: ["Cheers"], times: [] } })),
  ).not.toBe(generatedMediaId(plan()));
});

test("[SC07] classifies generated cards as schedule scoped and air ready only when measured", () => {
  const value = plan();
  const [asset] = classifyGeneratedContinuityAssets([generatedMedia(value)]);
  expect(asset).toMatchObject({
    origin: "generated",
    role: "next",
    scope: "schedule",
    scheduleRevision: value.scheduleRevision,
    contentHash: value.contentHash,
    family: "syndication",
    voicePresent: false,
    airReady: true,
  });
  expect(asset!.targetAiringIds).toEqual(["b-1"]);

  const [mismatched] = classifyGeneratedContinuityAssets([
    generatedMedia(value, { durationMs: 8_000 }),
  ]);
  expect(mismatched!.airReady).toBe(false);
});
