import { createHash } from "node:crypto";
import type { MediaItem, Schedule, ScheduleEntry } from "../../domain/models.js";
import { normalizeLocalPath } from "./client.js";
import { assertPreservedMovies, splicePreservedLineup } from "./preserveLineup.js";
import type {
  TunarrCapabilities,
  TunarrChannel,
  TunarrContentProgram,
  TunarrInventory,
  TunarrLineup,
  TunarrMappingInput,
  TunarrSnapshots,
} from "./types.js";

type Diagnostic = { code: string; message: string };
type ChannelCreateOperation = {
  type: "channel-create";
  payload: { type: "new"; channel: Record<string, unknown> };
};
type ChannelUpdateOperation = {
  type: "channel-update";
  channelId: string;
  payload: Record<string, unknown>;
};
type FillerCreateOperation = {
  type: "filler-create";
  payload: { name: string; programs: TunarrContentProgram[] };
};
type FillerUpdateOperation = {
  type: "filler-update";
  fillerListId: string;
  payload: { name: string; programs: TunarrContentProgram[] };
};
type ProgrammingOperation = {
  type: "programming";
  channelId?: string;
  payload: TunarrLineup;
};
export type TunarrOperation =
  | ChannelCreateOperation
  | ChannelUpdateOperation
  | FillerCreateOperation
  | FillerUpdateOperation
  | ProgrammingOperation;

export type TunarrSyncPlan = {
  fingerprint: string;
  createdAt: string;
  url: string;
  mapping: TunarrMappingInput;
  syncEligible: boolean;
  blockingErrors: Diagnostic[];
  warnings: Diagnostic[];
  matchCounts: {
    matched: number;
    unmatched: number;
    ambiguous: number;
    placeholder: number;
  };
  operations: TunarrOperation[];
  capabilities: TunarrCapabilities;
  snapshots: TunarrSnapshots;
  inventorySnapshot: TunarrInventory;
  scheduleSnapshot: Schedule;
};

export const PENDING_FILLER_ID = "__MARKTV_FILLER_ID__";
const fillerKinds = new Set(["commercial", "filler", "bumper"]);
type MidrollCandidate = { id: string; duration: number };
type VoicedCandidate = MidrollCandidate & {
  role: "break" | "return";
};
const voicedCooldownMs = 60 * 60_000;
const maxVoicedDurationPerPodMs = 20_000;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fillerName = (schedule: Schedule) =>
  `MarkTV - ${schedule.channelName ?? schedule.channelId} (${schedule.channelId})`;

function stableChannelId(schedule: Schedule) {
  const id = hash(schedule.channelId).slice(0, 32);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20)}`;
}

function channelIdentity(schedule: Schedule) {
  return {
    name: schedule.channelName ?? schedule.channelId,
    number: schedule.channelNumber ?? 1,
    duration: schedule.durationMs,
    startTime: Date.parse(schedule.entries[0]?.start ?? "") || 0,
  };
}

function newChannel(schedule: Schedule, transcodeConfigId: string) {
  return {
    id: stableChannelId(schedule),
    ...channelIdentity(schedule),
    groupTitle: "MarkTV",
    guideMinimumDuration: 30_000,
    icon: { path: "", width: 0, duration: 0, position: "bottom-right" },
    stealth: false,
    offline: { mode: "pic" },
    onDemand: { enabled: false },
    streamMode: "hls",
    transcodeConfigId,
    disableFillerOverlay: false,
    subtitlesEnabled: false,
  };
}

function saveableExisting(channel: TunarrChannel, schedule: Schedule) {
  const saveable: Record<string, unknown> = { ...channel };
  delete saveable.fallback;
  delete saveable.programCount;
  delete saveable.transcoding;
  delete saveable.sessions;
  return { ...saveable, ...channelIdentity(schedule) };
}

/**
 * The states in which Tunarr can be asked to play a program.
 *
 * Fail closed: a program that declares any other state is treated as unplayable.
 * An unrecognized state is not evidence that the file is there, and the two
 * mistakes are not symmetric - refusing a plan costs a retry, while programming
 * something Tunarr cannot play is dead air on a channel nobody is watching at
 * the time.
 */
const playableProgramStates = new Set([
  "ok",
  "ready",
  "available",
  "present",
  "healthy",
  "scanned",
]);

type DeclaredAvailability = {
  state?: unknown;
  available?: unknown;
  program?: {
    state?: unknown;
    available?: unknown;
    mediaItem?: { state?: unknown; available?: unknown };
  };
};

/**
 * Why Tunarr itself says this inventory program cannot be played, if it does.
 *
 * `GET /api/media-libraries/:libraryId/programs` keeps listing a program whose
 * file has been renamed or deleted, still carrying the absolute path that
 * MarkTV matches against, and reports it with a state of `missing`. A plan built
 * on one of those looks eligible and is not, which is the failure this catches.
 */
export function unusableInventoryReason(
  item: TunarrInventory[number],
): string | undefined {
  const wrapper = (item.program ?? {}) as DeclaredAvailability;
  const terminal = (wrapper.program ?? {}) as NonNullable<
    DeclaredAvailability["program"]
  >;
  const mediaItem = (terminal.mediaItem ?? {}) as {
    state?: unknown;
    available?: unknown;
  };
  if (
    [wrapper.available, terminal.available, mediaItem.available].some(
      (value) => value === false,
    )
  )
    return "unavailable";
  for (const value of [wrapper.state, terminal.state, mediaItem.state]) {
    if (typeof value !== "string") continue;
    const state = value.trim().toLowerCase();
    if (state && !playableProgramStates.has(state)) return state;
  }
  return undefined;
}

function matchEntry(
  entry: ScheduleEntry,
  inventory: TunarrInventory,
  blockingErrors: Diagnostic[],
  counts: TunarrSyncPlan["matchCounts"],
) {
  if (!entry.path) {
    counts.placeholder += 1;
    blockingErrors.push({
      code: "PLACEHOLDER_MEDIA",
      message: `${entry.title} is preview-only`,
    });
    return;
  }
  const path = normalizeLocalPath(entry.path);
  const candidates = inventory.filter((item) => item.path === path);
  // A program Tunarr says it cannot play never satisfies the match. MarkTV only
  // knows the absolute path, so a renamed or deleted file still matches it
  // exactly; Tunarr knows the file is gone, and a lineup built on that program
  // airs as offline time instead of failing where someone would notice.
  const matches = candidates.filter(
    (item) => unusableInventoryReason(item) === undefined,
  );
  if (!matches.length) {
    // Counted as a miss rather than a match: nothing playable answers the path.
    counts.unmatched += 1;
    const reasons = [
      ...new Set(
        candidates.map((item) => unusableInventoryReason(item) ?? "unusable"),
      ),
    ];
    blockingErrors.push(
      reasons.length
        ? {
            code: "UNUSABLE_MEDIA_STATE",
            message: `${path} is in Tunarr's library but cannot be played (${reasons.join(", ")})`,
          }
        : { code: "UNMATCHED_MEDIA_PATH", message: path },
    );
    return;
  }
  if (matches.length !== 1) {
    counts.ambiguous += 1;
    blockingErrors.push({ code: "AMBIGUOUS_MEDIA_PATH", message: path });
    return;
  }
  counts.matched += 1;
  return matches[0];
}

function validMidrollLayout(entry: ScheduleEntry) {
  const breaks = entry.midrolls ?? [];
  if (!breaks.length) return true;
  if (entry.kind !== "episode" && entry.kind !== "movie") return false;
  if (!entry.contentDurationMs || entry.contentDurationMs <= 0) return false;
  if (
    entry.contentDurationMs +
      breaks.reduce((total, midroll) => total + midroll.durationMs, 0) !==
    entry.durationMs
  )
    return false;
  // -1 rather than 0: a film that resumes exactly on one of its breaks opens its
  // continuation with that break, at offset zero.
  let previousOffset = -1;
  for (const midroll of breaks) {
    if (
      !Number.isInteger(midroll.offsetMs) ||
      !Number.isInteger(midroll.durationMs) ||
      midroll.durationMs <= 0 ||
      midroll.offsetMs <= previousOffset ||
      midroll.offsetMs >= entry.contentDurationMs
    )
      return false;
    previousOffset = midroll.offsetMs;
  }
  return true;
}

function splitContent(
  entry: ScheduleEntry,
  contentId: string,
  midrollPods: Array<TunarrLineup | undefined>,
): TunarrLineup {
  const breaks = entry.midrolls ?? [];
  // A movie that crossed a broadcast day boundary resumes partway through the
  // file, so every content segment is quoted at its offset in the SOURCE rather
  // than at its offset in this entry. Tunarr plays the file from there instead of
  // restarting it.
  const sourceBase = entry.sourceOffsetMs ?? 0;
  if (!breaks.length)
    return [
      {
        type: "content",
        id: contentId,
        duration: entry.durationMs,
        ...(sourceBase ? { startOffsetMs: sourceBase } : {}),
      },
    ];
  const contentDurationMs = entry.contentDurationMs!;
  const lineup: TunarrLineup = [];
  let offset = 0;
  for (const [index, midroll] of breaks.entries()) {
    if (midroll.offsetMs < offset) continue;
    if (midroll.offsetMs > offset)
      lineup.push({
        type: "content",
        id: contentId,
        duration: midroll.offsetMs - offset,
        startOffsetMs: sourceBase + offset,
      });
    lineup.push(
      ...(midrollPods[index] ?? [
        { type: "flex" as const, duration: midroll.durationMs },
      ]),
    );
    offset = midroll.offsetMs;
  }
  if (offset < contentDurationMs) {
    lineup.push({
      type: "content",
      id: contentId,
      duration: contentDurationMs - offset,
      startOffsetMs: sourceBase + offset,
    });
  }
  return lineup;
}

function selectExactMidrollFill(
  candidates: MidrollCandidate[],
  targetDuration: number,
  seed: string,
  exclude?: ReadonlySet<string>,
): TunarrLineup | undefined {
  // Ranked before the exclusion is applied, so adding the exclusion changes which
  // spots are available but never reshuffles the ranking they are drawn from.
  const ordered = [...candidates]
    .sort((left, right) =>
      hash(`${seed}:${left.id}`).localeCompare(hash(`${seed}:${right.id}`)),
    )
    .filter((candidate) => !exclude?.has(candidate.id));

  const byDuration = new Map<number, MidrollCandidate[]>();
  for (const candidate of ordered) {
    const group = byDuration.get(candidate.duration) ?? [];
    group.push(candidate);
    byDuration.set(candidate.duration, group);
  }
  for (const [duration, group] of byDuration) {
    const count = targetDuration / duration;
    if (Number.isInteger(count) && count > 0 && group.length >= count) {
      return group.slice(0, count).map((candidate) => ({
        type: "content" as const,
        id: candidate.id,
        duration: candidate.duration,
      }));
    }
  }

  const combinations = new Map<number, MidrollCandidate[]>([[0, []]]);
  for (const candidate of ordered) {
    const reachable = [...combinations.entries()].sort(
      ([left], [right]) => right - left,
    );
    for (const [duration, selected] of reachable) {
      const nextDuration = duration + candidate.duration;
      if (nextDuration > targetDuration || combinations.has(nextDuration))
        continue;
      const next = [...selected, candidate];
      if (nextDuration === targetDuration) {
        return next.map((item) => ({
          type: "content" as const,
          id: item.id,
          duration: item.duration,
        }));
      }
      combinations.set(nextDuration, next);
    }
  }
  return undefined;
}

function tagValues(item: MediaItem, prefix: string) {
  return item.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length));
}

function isInsideVoicedAssetRoot(path: string | undefined) {
  if (!path) return false;
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const parts = normalized.split("/");
  return parts.some(
    (part, index) =>
      part === "generated" && /^voiced-canon-[^/]+$/.test(parts[index + 1] ?? ""),
  );
}

function isImportedVoicedItem(item: MediaItem | undefined, path?: string) {
  return (
    item?.tags.includes("voiced-continuity") === true ||
    isInsideVoicedAssetRoot(item?.path ?? path)
  );
}

function makeVoicedCandidates(
  catalog: readonly MediaItem[],
  inventory: TunarrInventory,
  channelId: string,
): VoicedCandidate[] {
  const candidates: VoicedCandidate[] = [];
  const seenPaths = new Set<string>();
  for (const item of catalog) {
    const roles = tagValues(item, "continuity-role=");
    const scopes = tagValues(item, "continuity-scope=");
    const maps = tagValues(item, "continuity-map=");
    const channels = tagValues(item, "continuity-channel=");
    if (
      !item.tags.includes("voiced-continuity") ||
      item.tags.some((tag) => tag.startsWith("continuity-staged")) ||
      !item.available ||
      item.durationStatus !== "ok" ||
      !item.durationMs ||
      !Number.isInteger(item.durationMs) ||
      !item.path ||
      roles.length !== 1 ||
      (roles[0] !== "break" && roles[0] !== "return") ||
      scopes.length !== 1 ||
      scopes[0] !== "evergreen" ||
      maps.length !== 1 ||
      !/^MARKTV_[A-Z0-9_]+$/.test(maps[0]!) ||
      channels.length !== 1 ||
      channels[0] !== channelId
    )
      continue;
    let normalizedPath: string;
    try {
      normalizedPath = normalizeLocalPath(item.path);
    } catch {
      continue;
    }
    if (seenPaths.has(normalizedPath)) continue;
    const matches = inventory.filter((candidate) => {
      try {
        return (
          normalizeLocalPath(candidate.path) === normalizedPath &&
          unusableInventoryReason(candidate) === undefined
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) continue;
    // Catalog durations use integer milliseconds; Tunarr may retain a
    // fractional millisecond from a 30-fps container duration.
    if (Math.round(matches[0]!.program.duration) !== item.durationMs) continue;
    seenPaths.add(normalizedPath);
    candidates.push({
      id: matches[0]!.id,
      duration: item.durationMs,
      role: roles[0],
    });
  }
  return candidates;
}

function selectVoicedMidrollFill(
  voicedCandidates: readonly VoicedCandidate[],
  commercialCandidates: MidrollCandidate[],
  targetDuration: number,
  seed: string,
  usedWithinEntry: ReadonlySet<string>,
  broadcastTime: number,
  placements: Map<string, number[]>,
): TunarrLineup | undefined {
  const eligible = (candidate: VoicedCandidate) =>
    (placements.get(candidate.id) ?? []).every(
      (placedAt) => broadcastTime - placedAt >= voicedCooldownMs,
    );
  const rank = (role: VoicedCandidate["role"]) =>
    voicedCandidates
      .filter((candidate) => candidate.role === role && eligible(candidate))
      .sort((left, right) =>
        hash(`${seed}:${role}:${left.id}`).localeCompare(
          hash(`${seed}:${role}:${right.id}`),
        ),
      );
  const breaks = rank("break");
  const returns = rank("return");
  for (const breakClip of breaks) {
    for (const returnClip of returns) {
      if (breakClip.id === returnClip.id) continue;
      const voicedDuration = breakClip.duration + returnClip.duration;
      if (
        voicedDuration > maxVoicedDurationPerPodMs ||
        voicedDuration * 2 >= targetDuration
      )
        continue;
      const commercialDuration = targetDuration - voicedDuration;
      const commercials =
        selectExactMidrollFill(
          commercialCandidates,
          commercialDuration,
          `${seed}:commercials`,
          usedWithinEntry,
        ) ??
        selectExactMidrollFill(
          commercialCandidates,
          commercialDuration,
          `${seed}:commercials`,
        );
      if (!commercials) continue;
      return [
        { type: "content", id: breakClip.id, duration: breakClip.duration },
        ...commercials,
        { type: "content", id: returnClip.id, duration: returnClip.duration },
      ];
    }
  }
  return undefined;
}

export function resolveFillerId(lineup: TunarrLineup, fillerListId: string) {
  return lineup.map((item) =>
    item.type === "flex" && item.fillerConfig?.fillerListIds
      ? {
          ...item,
          fillerConfig: {
            ...item.fillerConfig,
            fillerListIds: item.fillerConfig.fillerListIds.map((id) =>
              id === PENDING_FILLER_ID ? fillerListId : id,
            ),
          },
        }
      : item,
  ) as TunarrLineup;
}

export function buildTunarrSyncPlan(
  schedule: Schedule,
  inventory: TunarrInventory,
  capabilities: TunarrCapabilities,
  mapping: TunarrMappingInput,
  snapshots: TunarrSnapshots,
  catalog: readonly MediaItem[] = [],
): TunarrSyncPlan {
  const blockingErrors: Diagnostic[] = [];
  const matchCounts = {
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    placeholder: 0,
  };
  if (!capabilities.healthy)
    blockingErrors.push({
      code: "TUNARR_UNHEALTHY",
      message: "Tunarr reported an unhealthy subsystem",
    });
  if (!capabilities.supportsChannels)
    blockingErrors.push({
      code: "CHANNELS_UNAVAILABLE",
      message: "Tunarr channel administration is unavailable",
    });
  if (!capabilities.supportsFillerLists)
    blockingErrors.push({
      code: "FILLER_LISTS_UNAVAILABLE",
      message: "Tunarr filler lists are unavailable",
    });
  if (!capabilities.supportsTranscodeConfigs)
    blockingErrors.push({
      code: "TRANSCODE_CONFIGS_UNAVAILABLE",
      message: "Tunarr transcode configurations are unavailable",
    });
  if (!capabilities.supportsInventory)
    blockingErrors.push({
      code: "INVENTORY_UNAVAILABLE",
      message: "Tunarr media inventory is unavailable",
    });
  if (!capabilities.supportsProgramming)
    blockingErrors.push({
      code: "PROGRAMMING_UNAVAILABLE",
      message: "Tunarr manual programming is unavailable",
    });

  const operations: TunarrOperation[] = [];
  let resolvedChannelId = mapping.channelId;
  if (mapping.createChannel) {
    if (!mapping.transcodeConfigId) {
      blockingErrors.push({
        code: "TRANSCODE_CONFIG_REQUIRED",
        message: "Choose a Tunarr transcode configuration before creation",
      });
    } else if (
      !snapshots.transcodeConfigs.some(
        (config) => config.id === mapping.transcodeConfigId,
      )
    ) {
      blockingErrors.push({
        code: "TRANSCODE_CONFIG_NOT_FOUND",
        message: "The selected Tunarr transcode configuration was not found",
      });
    } else {
      operations.push({
        type: "channel-create",
        payload: {
          type: "new",
          channel: newChannel(schedule, mapping.transcodeConfigId),
        },
      });
      resolvedChannelId = undefined;
    }
  } else {
    const channel = snapshots.channels.find(
      (candidate) => candidate.id === mapping.channelId,
    );
    if (!mapping.channelId || !channel) {
      blockingErrors.push({
        code: "CHANNEL_NOT_FOUND",
        message: "The mapped Tunarr channel was not found",
      });
    } else {
      operations.push({
        type: "channel-update",
        channelId: mapping.channelId,
        payload: saveableExisting(channel, schedule),
      });
    }
  }

  const name = fillerName(schedule);
  const knownFiller = snapshots.fillerLists.find(
    (list) => list.id === mapping.fillerListId || list.name === name,
  );
  const matches = new Map<string, TunarrContentProgram>();
  const entryMatches = new Map<string, TunarrInventory[number]>();
  const midrollCandidates = new Map<string, MidrollCandidate>();
  const commercialMidrollCandidates = new Map<string, MidrollCandidate>();
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const voicedCandidates = makeVoicedCandidates(
    catalog,
    inventory,
    schedule.channelId,
  );
  const voicedPlacements = new Map<string, number[]>();
  for (const entry of schedule.entries) {
    if (entry.kind === "flex") continue;
    const match = matchEntry(entry, inventory, blockingErrors, matchCounts);
    if (!match) continue;
    entryMatches.set(entry.id, match);
    const catalogItem =
      catalogById.get(entry.mediaId ?? "") ??
      catalog.find((item) => item.path === entry.path);
    // These cards describe one exact airing. Keep their explicit lineup slot,
    // but never let the ordinary mid-roll/filler bag replay them elsewhere.
    const scheduleBoundCard = entry.id.startsWith("continuity:generated:")
      || entry.path?.replaceAll("\\", "/").includes("/generated/continuity/");
    const importedVoice = isImportedVoicedItem(catalogItem, entry.path);
    if (
      !scheduleBoundCard &&
      !importedVoice &&
      fillerKinds.has(entry.kind) &&
      match.program.duration > 0
    ) {
      matches.set(match.id, match.program);
      midrollCandidates.set(match.id, {
        id: match.id,
        duration: entry.durationMs,
      });
      if (entry.kind === "commercial")
        commercialMidrollCandidates.set(match.id, {
          id: match.id,
          duration: entry.durationMs,
        });
    }
  }
  const lineup: TunarrLineup = [];
  let hasMidroll = false;
  for (const entry of schedule.entries) {
    if (entry.kind === "flex") {
      lineup.push({ type: "flex", duration: entry.durationMs });
      continue;
    }
    const match = entryMatches.get(entry.id);
    if (!match) continue;
    let midrollPods: Array<TunarrLineup | undefined> = [];
    if (entry.midrolls?.length) {
      hasMidroll = true;
      if (!validMidrollLayout(entry)) {
        blockingErrors.push({
          code: "INVALID_MIDROLL_LAYOUT",
          message: `${entry.title} has unsafe or inconsistent mid-roll timing`,
        });
        continue;
      }
      // One programme's breaks are drawn like a bag: a spot used in its first
      // break is not offered again in its second while anything else can make the
      // exact duration, so a film with four breaks does not play the same
      // commercial four times. Episodes get the same treatment.
      const usedWithinEntry = new Set<string>();
      const entryStart = Date.parse(entry.start);
      midrollPods = entry.midrolls.map((midroll, index) => {
        const candidates = [...midrollCandidates.values()];
        const commercials = [...commercialMidrollCandidates.values()];
        const seed = `${schedule.seed}:${entry.id}:${index}`;
        const priorPodDuration = entry.midrolls!
          .slice(0, index)
          .reduce((total, prior) => total + prior.durationMs, 0);
        const broadcastTime =
          entryStart + midroll.offsetMs + priorPodDuration;
        const voicedPod = selectVoicedMidrollFill(
          voicedCandidates,
          commercials,
          midroll.durationMs,
          seed,
          usedWithinEntry,
          broadcastTime,
          voicedPlacements,
        );
        if (voicedPod) {
          const breakClip = voicedCandidates.find(
            (candidate) => candidate.id === voicedPod[0]?.id,
          )!;
          const returnClip = voicedCandidates.find(
            (candidate) => candidate.id === voicedPod.at(-1)?.id,
          )!;
          const commercialDuration = voicedPod
            .slice(1, -1)
            .reduce((total, item) => total + item.duration, 0);
          for (const [candidate, placedAt] of [
            [breakClip, broadcastTime],
            [
              returnClip,
              broadcastTime + breakClip.duration + commercialDuration,
            ],
          ] as const) {
            const times = voicedPlacements.get(candidate.id) ?? [];
            times.push(placedAt);
            voicedPlacements.set(candidate.id, times);
          }
          for (const item of voicedPod)
            if (item.type === "content" && item.id)
              usedWithinEntry.add(item.id);
          return voicedPod;
        }
        const preferred = usedWithinEntry.size
          ? selectExactMidrollFill(candidates, midroll.durationMs, seed, usedWithinEntry)
          : selectExactMidrollFill(candidates, midroll.durationMs, seed);
        // Excluding can make the exact duration unreachable - the library may only
        // hold one spot of the right length. Falling back to the unused-inclusive
        // draw is the honest answer there: repeat a spot rather than leave a break
        // that Tunarr cannot fill.
        const pod = preferred ?? selectExactMidrollFill(candidates, midroll.durationMs, seed);
        for (const item of pod ?? [])
          if ("id" in item && typeof item.id === "string")
            usedWithinEntry.add(item.id);
        if (!pod && midrollCandidates.size) {
          blockingErrors.push({
            code: "MIDROLL_EXACT_FILL_UNAVAILABLE",
            message: `${entry.title} has a ${midroll.durationMs}ms break that cannot be filled with complete matched spots`,
          });
        }
        return pod;
      });
    }
    lineup.push(...splitContent(entry, match.id, midrollPods));
    const explicitVoice = voicedCandidates.find(
      (candidate) => candidate.id === match.id,
    );
    const explicitStart = Date.parse(entry.start);
    if (explicitVoice && Number.isFinite(explicitStart)) {
      const times = voicedPlacements.get(explicitVoice.id) ?? [];
      times.push(explicitStart);
      voicedPlacements.set(explicitVoice.id, times);
    }
  }
  const programs = [...matches.values()];
  if (knownFiller) {
    operations.push({
      type: "filler-update",
      fillerListId: knownFiller.id,
      payload: { name, programs },
    });
  } else {
    operations.push({ type: "filler-create", payload: { name, programs } });
  }
  if (hasMidroll && !programs.length) {
    blockingErrors.push({
      code: "MIDROLL_FILLER_UNAVAILABLE",
      message: "Mid-roll breaks require at least one matched filler program",
    });
  }
  const entryDurationMs = schedule.entries.reduce(
    (total, entry) => total + entry.durationMs,
    0,
  );
  if (entryDurationMs !== schedule.durationMs) {
    blockingErrors.push({
      code: "SCHEDULE_DURATION_MISMATCH",
      message:
        "Schedule entries do not add up to the declared schedule duration",
    });
  }
  const lineupDurationMs = lineup.reduce(
    (total, item) => total + item.duration,
    0,
  );
  if (lineupDurationMs !== schedule.durationMs) {
    blockingErrors.push({
      code: "LINEUP_DURATION_MISMATCH",
      message:
        "Tunarr lineup duration does not exactly match the MarkTV schedule",
    });
  }
  let publishedLineup = lineup;
  if (mapping.preserveExistingLineup) {
    try {
      const existing = snapshots.channels.find(channel => channel.id === mapping.channelId);
      if (mapping.createChannel || !existing || !snapshots.programming)
        throw new Error("Preserved lineup requires an existing channel and programming snapshot");
      const movieIds = new Set(Object.entries(snapshots.programming.programs)
        .filter(([, program]) => program.program.type === "movie").map(([id]) => id));
      for (const entry of schedule.entries) {
        if (entry.kind === "movie") {
          const match = entryMatches.get(entry.id);
          if (match) movieIds.add(match.id);
        }
      }
      assertPreservedMovies(snapshots.programming.lineup,
        Date.parse(schedule.entries[0]!.start) - existing.startTime, lineup, movieIds);
      publishedLineup = splicePreservedLineup(snapshots.programming.lineup,
        existing.startTime, Date.parse(schedule.entries[0]!.start), lineup);
      const operation = operations.find(operation => operation.type === "channel-update");
      if (operation?.type === "channel-update") {
        operation.payload.startTime = existing.startTime;
        operation.payload.duration = existing.duration;
      }
    } catch (error) {
      blockingErrors.push({ code: "PRESERVED_LINEUP_INVALID", message: error instanceof Error ? error.message : "Could not preserve existing lineup" });
    }
  }
  operations.push({
    type: "programming",
    channelId: resolvedChannelId,
    payload: publishedLineup,
  });

  const fingerprint = hash({
    url: capabilities.url,
    version: capabilities.version,
    capabilities,
    mapping,
    snapshots,
    inventory,
    schedule,
    catalog,
  });
  return {
    fingerprint,
    createdAt: new Date().toISOString(),
    url: capabilities.url,
    mapping,
    syncEligible: blockingErrors.length === 0,
    blockingErrors,
    warnings: [],
    matchCounts,
    operations,
    capabilities,
    snapshots,
    inventorySnapshot: inventory,
    scheduleSnapshot: schedule,
  };
}
