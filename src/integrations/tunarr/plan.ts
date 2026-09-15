import { createHash } from "node:crypto";
import type { Schedule, ScheduleEntry } from "../../domain/models.js";
import { normalizeLocalPath } from "./client.js";
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
  const matches = inventory.filter((item) => item.path === path);
  if (matches.length !== 1) {
    if (matches.length) counts.ambiguous += 1;
    else counts.unmatched += 1;
    blockingErrors.push({
      code: matches.length ? "AMBIGUOUS_MEDIA_PATH" : "UNMATCHED_MEDIA_PATH",
      message: path,
    });
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
  let previousOffset = 0;
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
  if (!breaks.length)
    return [{ type: "content", id: contentId, duration: entry.durationMs }];
  const contentDurationMs = entry.contentDurationMs!;
  const lineup: TunarrLineup = [];
  let offset = 0;
  for (const [index, midroll] of breaks.entries()) {
    if (midroll.offsetMs <= offset) continue;
    lineup.push({
      type: "content",
      id: contentId,
      duration: midroll.offsetMs - offset,
      startOffsetMs: offset,
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
      startOffsetMs: offset,
    });
  }
  return lineup;
}

function selectExactMidrollFill(
  candidates: MidrollCandidate[],
  targetDuration: number,
  seed: string,
): TunarrLineup | undefined {
  const ordered = [...candidates].sort((left, right) =>
    hash(`${seed}:${left.id}`).localeCompare(hash(`${seed}:${right.id}`)),
  );

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
  for (const entry of schedule.entries) {
    if (entry.kind === "flex") continue;
    const match = matchEntry(entry, inventory, blockingErrors, matchCounts);
    if (!match) continue;
    entryMatches.set(entry.id, match);
    if (fillerKinds.has(entry.kind) && match.program.duration > 0) {
      matches.set(match.id, match.program);
      midrollCandidates.set(match.id, {
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
      midrollPods = entry.midrolls.map((midroll, index) => {
        const pod = selectExactMidrollFill(
          [...midrollCandidates.values()],
          midroll.durationMs,
          `${schedule.seed}:${entry.id}:${index}`,
        );
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
  operations.push({
    type: "programming",
    channelId: resolvedChannelId,
    payload: lineup,
  });

  const fingerprint = hash({
    url: capabilities.url,
    version: capabilities.version,
    capabilities,
    mapping,
    snapshots,
    inventory,
    schedule,
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
