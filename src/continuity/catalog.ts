import { createHash } from "node:crypto";
import type { MediaItem } from "../domain/models.js";
import { parseGeneratedContinuityTags } from "./assets.js";
import type { ContinuityAsset, ContinuityPersona, ContinuityRole } from "./types.js";

export const titleSlug = (value: string) =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const personaFor = (title: string): ContinuityPersona => {
  if (title.includes("late-night-317am")) return "odd";
  if (title.includes("late-night") || title.includes("sign-off")) return "overnight";
  if (title.includes("primary") || title.includes("city-brighter")) return "network";
  if (title.includes("id-") || title.includes("couch") || title.includes("transition")) return "local";
  return "existing-unclassified";
};

const roleFor = (title: string, kind: MediaItem["kind"]): ContinuityRole => {
  if (title.includes("technical-difficulties") || title.includes("please-stand-by")) return "interruption";
  if (title.includes("return-from-commercial") || title.includes("back-to-the-show")) return "return";
  if (title.includes("well-be-right-back")) return "break";
  if (title.startsWith("marktv-up-next-")) return "next";
  return kind === "station-id" ? "station-id" : "break";
};

const tagValue = (tags: string[], name: string) =>
  tags.find((tag) => tag.startsWith(`${name}=`))?.slice(name.length + 1);
const uniqueTagValue = (tags: string[], name: string) => {
  const matches = tags.filter((tag) => tag.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : undefined;
};
const validVoicedRole = (value: string | undefined): value is ContinuityRole =>
  Boolean(value && ["next", "next-later", "tonight", "weekend", "after-dark", "break", "return", "station-id", "interruption"].includes(value));
const validContinuityScope = (value: string | undefined): value is ContinuityAsset["scope"] =>
  Boolean(value && ["evergreen", "title", "airing", "schedule"].includes(value));

export function classifyExistingContinuityAssets(media: MediaItem[]): ContinuityAsset[] {
  return media
    .filter((item) => item.kind === "bumper" || item.kind === "station-id")
    .map((item) => {
      const slug = titleSlug(item.title);
      const role = roleFor(slug, item.kind);
      const clockClaim = slug.includes("317am");
      const staged = role === "interruption";
      const visualOnly = item.tags.includes("visual-only");
      const inferredTarget = role === "next" ? slug.replace(/^marktv-up-next-/, "") : undefined;
      const targetSlug = inferredTarget === "generic" ? undefined : inferredTarget;
      const declaredRole = tagValue(item.tags, "continuity-role") as ContinuityRole | undefined;
      const declaredScope = tagValue(item.tags, "continuity-scope") as ContinuityAsset["scope"] | undefined;
      const voiced = item.tags.includes("voiced-continuity");
      const voicedChannel = uniqueTagValue(item.tags, "continuity-channel");
      const voicedRole = uniqueTagValue(item.tags, "continuity-role");
      const voicedScope = uniqueTagValue(item.tags, "continuity-scope");
      const invalidVoicedMetadata = voiced && (
        !voicedChannel || !/^marktv-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(voicedChannel) ||
        !validVoicedRole(voicedRole) || !validContinuityScope(voicedScope)
      );
      const stagedReason = tagValue(item.tags, "continuity-staged-reason");
      const ready = Boolean(
        item.available &&
          item.path &&
          item.durationStatus === "ok" &&
          item.durationMs &&
          !clockClaim &&
          !staged &&
          !stagedReason &&
          !invalidVoicedMetadata,
      );
      return {
        id: `existing:${item.id}`,
        mediaId: item.id,
        origin: "existing" as const,
        contentHash: createHash("sha256")
          .update(JSON.stringify([item.id, item.path, item.durationMs, item.revision]))
          .digest("hex"),
        path: item.path,
        durationMs: item.durationMs ?? undefined,
        role: declaredRole ?? role,
        personaId: personaFor(slug),
        lifecycle: "registered" as const,
        scope: declaredScope ?? (targetSlug ? ("title" as const) : ("evergreen" as const)),
        targetSlug: tagValue(item.tags, "continuity-target") ?? targetSlug,
        targetKind: tagValue(item.tags, "continuity-target-kind") as "episode" | "movie" | undefined,
        requiredLocalTime: tagValue(item.tags, "continuity-local-time"),
        requiredTargetLocalTime: tagValue(item.tags, "continuity-target-local-time"),
        lastBeforeTarget: item.tags.includes("continuity-last-before-target=true"),
        requiresUnstartedTarget: item.tags.includes("continuity-requires-unstarted-target=true"),
        requiresSameSeriesAsCurrent: item.tags.includes("continuity-requires-same-series-as-current=true"),
        requiresSameLocalDateAsTarget: item.tags.includes("continuity-requires-same-local-date-as-target=true"),
        channelId: tagValue(item.tags, "continuity-channel"),
        ...(stagedReason ? { stagedReason } : {}),
        available: item.available,
        voicePresent: !visualOnly,
        airReady: ready,
        ...(clockClaim ? { rejectReason: "UNSCOPED_CLOCK_CLAIM" as const } : {}),
        ...(staged ? { rejectReason: "UNHEALTHY_PLAYBACK" as const } : {}),
        ...(stagedReason ? { rejectReason: "STAGED_UNSUPPORTED_CONTEXT" as const } : {}),
        ...(invalidVoicedMetadata ? { rejectReason: "INVALID_ASSET_METADATA" as const } : {}),
      };
    });
}

export const isScopedContinuityMedia = (item: MediaItem) =>
  item.kind === "bumper" && titleSlug(item.title).startsWith("marktv-up-next-");

const personaForFamily = (family: string): ContinuityPersona =>
  family === "overnight"
    ? "overnight"
    : family === "local-cable"
      ? "local"
      : "network";

/**
 * Classify offline-rendered, schedule-scoped continuity video.
 *
 * These are ordinary catalog items, so nothing outside continuity needs to know
 * they exist. The binding to the completed schedule lives in their tags: a
 * regenerated lineup mints a different content hash, which makes every earlier
 * card stale rather than silently reusable.
 */
export function classifyGeneratedContinuityAssets(media: MediaItem[]): ContinuityAsset[] {
  return media.flatMap((item) => {
    const metadata = parseGeneratedContinuityTags(item.tags);
    if (!metadata) return [];
    const ready = Boolean(
      item.available &&
        item.path &&
        item.durationStatus === "ok" &&
        item.durationMs === metadata.durationMs,
    );
    return [
      {
        id: `generated:${item.id}`,
        mediaId: item.id,
        origin: "generated" as const,
        contentHash: metadata.contentHash,
        path: item.path,
        durationMs: item.durationMs ?? undefined,
        role: metadata.cardType as ContinuityRole,
        personaId: personaForFamily(metadata.family),
        lifecycle: "registered" as const,
        scope: "schedule" as const,
        scheduleRevision: metadata.scheduleRevision,
        targetAiringIds: metadata.targetAiringIds,
        family: metadata.family,
        wordingKey: metadata.wordingKey,
        available: item.available,
        // Offline cards use the existing silent AAC behaviour; they add no voice.
        voicePresent: false,
        airReady: ready,
      },
    ];
  });
}
