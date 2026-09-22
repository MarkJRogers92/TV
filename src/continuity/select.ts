import { createHash } from "node:crypto";
import { titleSlug } from "./catalog.js";
import type {
  ContinuityAsset,
  ContinuityContext,
  ContinuityHistoryEntry,
  RejectCode,
} from "./types.js";
import { DateTime } from "luxon";

type Options = {
  now: string;
  stagedInterruptionsEnabled?: boolean;
  playbackHealthy?: boolean;
  clipCooldownMinutes?: number;
  targetCooldownMinutes?: number;
  oddPersonaCooldownHours?: number;
  promoFrequency?: number;
};

const elapsedMinutes = (now: string, then: string) =>
  (Date.parse(now) - Date.parse(then)) / 60_000;

/**
 * Every eligible asset for one break, best first.
 *
 * Exposed separately from `selectContinuity` so a caller that has already
 * decided which *kind* of card a break should carry can take the best existing
 * clip of that kind instead of accepting whatever ranks first overall.
 */
export function rankContinuityCandidates(
  context: ContinuityContext,
  assets: ContinuityAsset[],
  history: ContinuityHistoryEntry[],
  options: Options,
) {
  const rejections: Array<{ assetId: string; reason: RejectCode }> = [];
  const candidates: ContinuityAsset[] = [];
  const targetForRole = (asset: ContinuityAsset) => {
    if (asset.role === "return" || asset.role === "break") return context.returnTarget;
    if (asset.role === "tonight") return context.tonight[0] ?? null;
    if (asset.role === "weekend") return context.weekendPair?.[0] ?? null;
    return context.next;
  };
  const informationalRoles = new Set(["next", "next-later", "tonight", "weekend", "after-dark"]);
  const frequency = Math.max(0, Math.min(1, options.promoFrequency ?? 1));
  const frequencyValue = Number.parseInt(
    createHash("sha256")
      .update(`${context.channelId}:${context.scheduleRevision}:${context.insertionInstant}:frequency`)
      .digest("hex")
      .slice(0, 8),
    16,
  ) / 0xffffffff;
  for (const asset of assets) {
    let reason: RejectCode | undefined;
    const target = targetForRole(asset);
    if (!asset.airReady || asset.available === false || !asset.path || !asset.durationMs)
      reason = asset.rejectReason ?? "MISSING_SOURCE";
    else if (asset.channelId && asset.channelId !== context.channelId)
      reason = "TARGET_MISMATCH";
    else if (asset.scheduleRevision && asset.scheduleRevision !== context.scheduleRevision)
      reason = "STALE_SCHEDULE";
    else if (asset.validFrom && options.now < asset.validFrom) reason = "TARGET_NOT_FUTURE";
    else if (asset.validUntil && options.now >= asset.validUntil) reason = "STALE_SCHEDULE";
    else if (asset.role === "interruption" && (!options.stagedInterruptionsEnabled || !options.playbackHealthy))
      reason = "UNHEALTHY_PLAYBACK";
    else if (asset.stagedReason)
      reason = "STAGED_UNSUPPORTED_CONTEXT";
    else if (!context.managedLineup && ["tonight", "weekend", "after-dark"].includes(asset.role))
      reason = "UNMANAGED_LINEUP_LOOP";
    else if (asset.role === "tonight" && (!context.allowTimeRelativePromos || !context.tonight.length))
      reason = "INVALID_TIME_LABEL";
    else if (asset.role === "weekend" && !context.weekendPair)
      reason = "TARGET_NOT_FUTURE";
    else if (asset.role === "next-later" && (!context.next || !context.later))
      reason = "TARGET_NOT_FUTURE";
    else if (informationalRoles.has(asset.role) && frequencyValue >= frequency)
      reason = "FREQUENCY_GATE";
    else if (asset.scope === "schedule" && !asset.scheduleRevision) reason = "STALE_SCHEDULE";
    else if (
      asset.scope === "airing" &&
      (!target || !asset.targetAiringIds?.includes(target.airingId))
    )
      reason = "TARGET_MISMATCH";
    else if (
      asset.scope === "title" &&
      (!target || asset.targetSlug !== titleSlug(target.showTitle ?? target.title))
    )
      reason = "TARGET_MISMATCH";
    else if (asset.targetKind && target?.kind !== asset.targetKind)
      reason = "TARGET_MISMATCH";
    else if (asset.requiresUnstartedTarget && target?.alreadyStarted)
      reason = "TARGET_MISMATCH";
    else if (asset.requiresSameSeriesAsCurrent && !target?.sameSeriesAsCurrent)
      reason = "TARGET_MISMATCH";
    else if (
      asset.requiredTargetLocalTime && target &&
      DateTime.fromISO(target.start, { setZone: true })
        .setZone(context.timezone).toFormat("HH:mm") !== asset.requiredTargetLocalTime
    )
      reason = "INVALID_TIME_LABEL";
    else if (asset.role === "weekend" && context.weekendPair &&
      DateTime.fromISO(context.weekendPair[0].start, { setZone: true }).setZone(context.timezone).toISODate() !==
        DateTime.fromISO(context.weekendPair[1].start, { setZone: true }).setZone(context.timezone).toISODate())
      reason = "TARGET_MISMATCH";
    else if (asset.role === "return" && !context.returnTarget)
      reason = "WRONG_RESUME_TARGET";
    else if (asset.role === "next" && !context.next) reason = "TARGET_NOT_FUTURE";

    const clipCooldown = options.clipCooldownMinutes ?? 60;
    const targetCooldown = options.targetCooldownMinutes ?? 30;
    const oddCooldown = (options.oddPersonaCooldownHours ?? 6) * 60;
    if (!reason && history.some((item) => item.assetId === asset.id && elapsedMinutes(options.now, item.airedAt) < clipCooldown))
      reason = "REPEAT_COOLDOWN";
    if (
      !reason &&
      target &&
      history.some(
        (item) =>
          item.targetAiringId === target.airingId &&
          elapsedMinutes(options.now, item.airedAt) < targetCooldown,
      )
    )
      reason = "REPEAT_COOLDOWN";
    if (
      !reason &&
      asset.personaId === "odd" &&
      history.some(
        (item) => item.personaId === "odd" && elapsedMinutes(options.now, item.airedAt) < oddCooldown,
      )
    )
      reason = "REPEAT_COOLDOWN";

    if (reason) rejections.push({ assetId: asset.id, reason });
    else candidates.push(asset);
  }
  candidates.sort((left, right) => {
    const priority = (asset: ContinuityAsset) =>
      asset.role === "return" && context.returnTarget
        ? 0
        : informationalRoles.has(asset.role)
          ? 1
          : 2;
    const priorityDifference = priority(left) - priority(right);
    if (priorityDifference) return priorityDifference;
    const key = `${context.channelId}:${context.scheduleRevision}:${context.insertionInstant}`;
    return createHash("sha256")
      .update(`${key}:${left.id}`)
      .digest("hex")
      .localeCompare(createHash("sha256").update(`${key}:${right.id}`).digest("hex"));
  });
  return { candidates, rejections };
}

export function selectContinuity(
  context: ContinuityContext,
  assets: ContinuityAsset[],
  history: ContinuityHistoryEntry[],
  options: Options,
) {
  const { candidates, rejections } = rankContinuityCandidates(
    context,
    assets,
    history,
    options,
  );
  return { selected: candidates[0] ?? null, rejections };
}
