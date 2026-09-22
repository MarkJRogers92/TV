import type { MediaItem } from "../domain/models.js";
import { titleSlug } from "./catalog.js";

export type VoicedAssetRule = {
  kind: Extract<MediaItem["kind"], "bumper" | "station-id">;
  role: string;
  scope: "evergreen" | "title";
  targetSlug?: string;
  targetKind?: "episode" | "movie";
  localTime?: string;
  targetLocalTime?: string;
  lastBeforeTarget?: boolean;
  requiresUnstartedTarget?: boolean;
  requiresSameSeriesAsCurrent?: boolean;
  requiresSameLocalDateAsTarget?: boolean;
  daypart?: string;
  stagedReason?: string;
  eligibleForHourlyIds: boolean;
};

const titleTargets: Record<string, string> = {
  MARKTV_PROMO_GRACE_UNDER_FIRE_001: "Grace Under Fire",
  MARKTV_PROMO_HOME_IMPROVEMENT_001: "Home Improvement",
  MARKTV_PROMO_THE_WONDER_YEARS_001: "The Wonder Years",
  MARKTV_PROMO_PETE_AND_PETE_001: "The Adventures of Pete & Pete",
  MARKTV_PROMO_THAT_70S_SHOW_001: "That '70s Show",
  MARKTV_PROMO_ROSEANNE_001: "Roseanne",
};

const evergreenIds = new Set([
  "MARKTV_ID_MAIN_001",
  "MARKTV_ID_NOSTALGIA_001",
  "MARKTV_ID_STAY_MARKED_001",
  "MARKTV_SLOGAN_NATURE_001",
]);

/**
 * Truth conditions for each voiced clip. Unhandled claims stay staged so a
 * catalog scan cannot silently turn them into ordinary interstitials.
 */
export function voicedAssetRule(baseName: string): VoicedAssetRule {
  const show = titleTargets[baseName];
  if (show)
    return {
      kind: "bumper",
      role: "next",
      scope: "title",
      targetSlug: titleSlug(show),
      targetKind: "episode",
      ...(baseName === "MARKTV_PROMO_ROSEANNE_001" ? { requiresSameSeriesAsCurrent: true } : {}),
      eligibleForHourlyIds: false,
    };

  if (evergreenIds.has(baseName))
    return {
      kind: "station-id",
      role: "station-id",
      scope: "evergreen",
      eligibleForHourlyIds: true,
    };

  if (baseName === "MARKTV_ID_PROBABLY_NORMAL_001_ALT")
    return {
      kind: "station-id", role: "station-id", scope: "evergreen", daypart: "overnight",
      eligibleForHourlyIds: true,
    };

  switch (baseName) {
    case "MARKTV_PROMO_DOUBLE_FEATURE_001":
      return {
        kind: "bumper", role: "weekend", scope: "evergreen", targetKind: "movie",
        requiresSameLocalDateAsTarget: true,
        targetLocalTime: "19:00", eligibleForHourlyIds: false,
      };
    case "MARKTV_PROMO_2AM_MOVIE_001_ALT":
      return {
        kind: "bumper", role: "tonight", scope: "evergreen", targetKind: "movie",
        localTime: "02:00", eligibleForHourlyIds: false,
      };
    case "MARKTV_PROMO_MOVIE_GENERIC_001":
      return {
        kind: "bumper", role: "next", scope: "evergreen", targetKind: "movie",
        eligibleForHourlyIds: false,
      };
    case "MARKTV_PROMO_LATE_NIGHT_HORROR_001":
      return {
        kind: "bumper", role: "next", scope: "evergreen", targetKind: "movie",
        stagedReason: "NO_VERIFIED_HORROR_GENRE", eligibleForHourlyIds: false,
      };
    case "MARKTV_PROMO_COMEDY_GENERIC_001":
      return {
        kind: "bumper", role: "next", scope: "evergreen", targetKind: "episode",
        stagedReason: "NO_VERIFIED_COMEDY_GENRE", eligibleForHourlyIds: false,
      };
    case "MARKTV_ID_OVERNIGHT_001_ALT":
    case "MARKTV_ID_OVERNIGHT_WEIRD_001":
      return {
        kind: "station-id", role: "station-id", scope: "evergreen", daypart: "overnight",
        eligibleForHourlyIds: true,
      };
    case "MARKTV_DAYPART_MORNING_001":
      return {
        kind: "station-id", role: "station-id", scope: "evergreen", daypart: "morning",
        eligibleForHourlyIds: true,
      };
    case "MARKTV_DAYPART_PRIMETIME_001":
      return {
        kind: "station-id", role: "station-id", scope: "evergreen", daypart: "primetime",
        eligibleForHourlyIds: true,
      };
    case "MARKTV_DAYPART_AFTER_HOURS_001":
      return {
        kind: "station-id", role: "station-id", scope: "evergreen", daypart: "after-hours",
        eligibleForHourlyIds: true,
      };
    case "MARKTV_BREAK_OUT_001":
      return {
        kind: "bumper", role: "break", scope: "evergreen",
        eligibleForHourlyIds: false,
      };
    case "MARKTV_RETURN_NOT_YOUR_PROBLEMS_001":
    case "MARKTV_RETURN_APOLOGY_001":
      return {
        kind: "bumper", role: "return", scope: "evergreen",
        eligibleForHourlyIds: false,
      };
    case "MARKTV_MOVIE_FEATURE_001":
      return {
        kind: "bumper", role: "next", scope: "evergreen", targetKind: "movie",
        lastBeforeTarget: true, requiresUnstartedTarget: true, eligibleForHourlyIds: false,
      };
    default:
      return {
        kind: "bumper", role: "next", scope: "evergreen",
        stagedReason: "UNCLASSIFIED_VOICED_ASSET", eligibleForHourlyIds: false,
      };
  }
}

export function voicedAssetTags(baseName: string, matchType: string, channelId: string): string[] {
  const rule = voicedAssetRule(baseName);
  return [
    "voiced-continuity",
    `continuity-channel=${channelId}`,
    `continuity-role=${rule.role}`,
    `continuity-scope=${rule.scope}`,
    ...(rule.targetSlug ? [`continuity-target=${rule.targetSlug}`] : []),
    ...(rule.targetKind ? [`continuity-target-kind=${rule.targetKind}`] : []),
    ...(rule.localTime ? [`continuity-local-time=${rule.localTime}`] : []),
    ...(rule.targetLocalTime ? [`continuity-target-local-time=${rule.targetLocalTime}`] : []),
    ...(rule.lastBeforeTarget ? ["continuity-last-before-target=true"] : []),
    ...(rule.requiresUnstartedTarget ? ["continuity-requires-unstarted-target=true"] : []),
    ...(rule.requiresSameSeriesAsCurrent ? ["continuity-requires-same-series-as-current=true"] : []),
    ...(rule.requiresSameLocalDateAsTarget ? ["continuity-requires-same-local-date-as-target=true"] : []),
    ...(rule.daypart ? [`continuity-daypart=${rule.daypart}`] : []),
    ...(rule.eligibleForHourlyIds ? ["continuity-hourly-ids-eligible"] : []),
    ...(rule.stagedReason ? [`continuity-staged-reason=${rule.stagedReason}`] : []),
    `continuity-map=${baseName}`,
    `continuity-match=${matchType}`,
  ];
}
