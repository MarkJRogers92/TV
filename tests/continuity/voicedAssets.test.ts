import { expect, test } from "vitest";
import { voicedAssetRule, voicedAssetTags } from "../../src/continuity/voicedAssets.js";

test("maps Roseanne only to same-series NEXT and emits channel-scoped metadata", () => {
  expect(voicedAssetRule("MARKTV_PROMO_ROSEANNE_001")).toMatchObject({
    role: "next",
    targetSlug: "roseanne",
    requiresSameSeriesAsCurrent: true,
  });
  expect(voicedAssetTags("MARKTV_PROMO_ROSEANNE_001", "exact-title", "marktv-laughs")).toEqual(
    expect.arrayContaining([
      "voiced-continuity",
      "continuity-channel=marktv-laughs",
      "continuity-requires-same-series-as-current=true",
    ]),
  );
});

test("keeps the probably-normal station ID available only in the overnight daypart", () => {
  expect(voicedAssetRule("MARKTV_ID_PROBABLY_NORMAL_001_ALT")).toMatchObject({
    kind: "station-id",
    role: "station-id",
    daypart: "overnight",
    eligibleForHourlyIds: true,
  });
});
