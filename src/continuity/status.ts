import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Repositories } from "../db/repositories.js";
import { inspectCanonicalLogo } from "./branding.js";
import { classifyExistingContinuityAssets, classifyGeneratedContinuityAssets } from "./catalog.js";
import { deriveContinuityContext } from "./context.js";
import { planContinuityCards } from "./director.js";
import { publishedContinuityHash } from "./identity.js";
import { readContinuityHistoryForPlanning } from "./history.js";
import { defaultContinuityConfig, type ContinuityConfig } from "./types.js";

const frequency = z.enum(["low", "normal", "high"]);
const weirdness = z.enum(["off", "low", "normal"]);

const configSchema = z.object({
  enabled: z.boolean(),
  nextCards: z.boolean(),
  nextLaterFrequency: frequency,
  tonightFrequency: frequency,
  overnightWeirdness: weirdness,
  stagedInterruptionsEnabled: z.boolean(),
  promoFrequency: z.number().min(0).max(1),
  clipCooldownMinutes: z.number().nonnegative(),
  targetCooldownMinutes: z.number().nonnegative(),
  oddPersonaCooldownHours: z.number().nonnegative(),
  maximumSpokenElementsPerBreak: z.number().int().min(0).max(2),
  maximumContinuitySecondsPerBreak: z.number().min(0).max(20),
});
export const continuityConfigUpdateSchema = configSchema.partial();

const configId = (channelId: string) => `continuity:${channelId}:config`;

/**
 * Resolve the effective configuration.
 *
 * The director is on by default and an explicit stored `enabled: false` is a
 * deliberate operator choice, so an install that already switched continuity
 * off stays off while a fresh install starts from the approved defaults.
 */
export function readContinuityConfig(
  repositories: Repositories,
  channelId: string,
): ContinuityConfig {
  try {
    const stored = repositories.settings.get(configId(channelId))?.value;
    const storedConfig =
      stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    return configSchema.parse({ ...defaultContinuityConfig, ...storedConfig });
  } catch {
    // Fail open. A corrupt or hand-edited setting must not be able to stop an
    // ordinary schedule from being generated - it just means the director runs
    // on the approved defaults.
    return { ...defaultContinuityConfig };
  }
}

export function writeContinuityConfig(
  repositories: Repositories,
  channelId: string,
  patch: z.infer<typeof continuityConfigUpdateSchema>,
) {
  const config = configSchema.parse({ ...readContinuityConfig(repositories, channelId), ...patch });
  repositories.settings.put(configId(channelId), config);
  return config;
}

async function starterScriptCount(repoRoot: string) {
  const path = join(repoRoot, "assets", "continuity", "content", "scripts.json");
  try {
    await access(path);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed)
      ? parsed.length
      : Array.isArray(parsed.lines)
        ? parsed.lines.length
        : Array.isArray(parsed.scripts)
          ? parsed.scripts.length
          : 0;
  } catch {
    return 0;
  }
}

export async function continuityStatus(input: {
  repositories: Repositories;
  channelId: string;
  now: Date;
  repoRoot?: string;
}) {
  const repoRoot = input.repoRoot ?? process.cwd();
  const channel = input.repositories.channels.get(input.channelId);
  if (!channel) return undefined;
  const config = readContinuityConfig(input.repositories, channel.id);
  const media = input.repositories.media.list();
  const existing = classifyExistingContinuityAssets(media);
  const generated = classifyGeneratedContinuityAssets(media);
  const assets = [...existing, ...generated];
  const branding = await inspectCanonicalLogo(repoRoot);
  const localNow = DateTime.fromJSDate(input.now, { zone: channel.timezone });
  const date = localNow.toISODate()!;
  // Status and preview are reads. Opening the control panel must not generate
  // or persist a schedule, advance episode history, render or register a card,
  // or start media analysis.
  const schedule = input.repositories.schedules.latestForDate(channel.id, date);
  const adjacentSchedules = [-1, 1].flatMap((days) => {
    const adjacentDate = localNow.plus({ days }).toISODate();
    const adjacent = adjacentDate
      ? input.repositories.schedules.latestForDate(channel.id, adjacentDate)
      : undefined;
    return adjacent ? [adjacent] : [];
  });
  const history = readContinuityHistoryForPlanning(input.repositories, channel.id, {
    before: input.now.toISOString(),
    excludeScheduleRevision: schedule?.id,
  });
  let context: ReturnType<typeof deriveContinuityContext> | undefined;
  let plan: ReturnType<typeof planContinuityCards> | undefined;
  if (schedule) {
    try {
      context = deriveContinuityContext({
        schedules: [schedule, ...adjacentSchedules],
        media,
        insertionInstant: input.now.toISOString(),
        managedLineup: true,
      });
      plan = planContinuityCards({ schedule, media, config, history, adjacentSchedules });
    } catch {
      // A read-only surface never fails closed over a malformed schedule.
      context = undefined;
      plan = undefined;
    }
  }
  const voiceCount = (personaId: string) =>
    assets.filter(
      (asset) => asset.personaId === personaId && asset.path && asset.voicePresent,
    ).length;
  /**
   * Readiness is a statement about the *current* lineup.
   *
   * Any generated card in the catalog says nothing about whether the schedule
   * on screen has one - a card rendered for a lineup that has since changed is
   * stale and must not read as ready. Only assets bound to this schedule's exact
   * content hash count.
   */
  const currentContentHash = (schedule && publishedContinuityHash(schedule, adjacentSchedules))
    || plan?.contentHash || null;
  const boundAssets = currentContentHash
    ? generated.filter(
        (asset) =>
          asset.contentHash === currentContentHash &&
          asset.airReady &&
          asset.available !== false &&
          Boolean(asset.path) &&
          Boolean(asset.durationMs),
      )
    : [];
  const ready = branding.state === "bound" && Boolean(schedule) && boundAssets.length > 0;
  return {
    channelId: channel.id,
    config,
    activation: {
      state: config.enabled ? ("enabled" as const) : ("disabled" as const),
      ready,
      canEnable: ready,
      reason: config.enabled
        ? null
        : ready
          ? "Continuity is off. Turn it back on to resume planned cards."
          : branding.state !== "bound"
            ? "Canonical logo validation is required before cards are eligible"
            : !schedule
              ? "A generated schedule is required before cards can be planned"
              : "No prepared continuity asset is bound to the current schedule",
    },
    branding,
    assets: {
      discovered: assets.length,
      airReady: assets.filter((asset) => asset.airReady).length,
      generated: generated.length,
      scriptOnly: await starterScriptCount(repoRoot),
      quarantined: assets.filter((asset) => !asset.airReady).length,
      boundToSchedule: boundAssets.length,
    },
    voices: {
      network: voiceCount("network"),
      local: voiceCount("local"),
      overnight: voiceCount("overnight"),
      odd: voiceCount("odd"),
      unclassified: voiceCount("existing-unclassified"),
    },
    director: {
      scheduleRevision: context?.scheduleRevision ?? "unavailable",
      contentHash: plan?.contentHash ?? null,
      label: context?.presentationLabel ?? "COMING UP",
      current: context?.current?.showTitle ?? context?.current?.title ?? null,
      next: context?.next?.showTitle ?? context?.next?.title ?? null,
      later: context?.later?.showTitle ?? context?.later?.title ?? null,
      cards:
        plan?.plans.map((card) => ({
          cardType: card.cardType,
          family: card.family,
          label: card.label,
          title: card.title,
          details: card.details,
          durationMs: card.durationMs,
          insertionInstant: card.insertionInstant,
          targetTitles: card.target.titles,
          targetTimes: card.target.times,
          assetRegistered: generated.some(
            (asset) =>
              asset.contentHash === card.contentHash &&
              asset.family === card.family &&
              asset.role === card.cardType &&
              asset.wordingKey === card.wordingKey,
          ),
        })) ?? [],
      skippedReason: plan && plan.plans.length ? null : plan?.rejections[0]?.reason ?? "NO_ELIGIBLE_PLAN",
    },
    preview: {
      scheduleRevision: context?.scheduleRevision ?? "unavailable",
      insertionInstant: input.now.toISOString(),
      label: context?.presentationLabel ?? "COMING UP",
      current: context?.current?.showTitle ?? context?.current?.title ?? null,
      next: context?.next?.showTitle ?? context?.next?.title ?? null,
      later: context?.later?.showTitle ?? context?.later?.title ?? null,
      selectedAsset: plan?.plans[0]?.id ?? null,
      skippedReason: plan?.plans.length ? null : plan?.rejections[0]?.reason ?? "NO_ELIGIBLE_ASSET",
    },
  };
}
