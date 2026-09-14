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
const fillerKinds = new Set(["commercial", "filler", "bumper", "station-id"]);
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

function splitMovie(
  entry: ScheduleEntry,
  contentId: string,
  fillerListId: string,
  cooldownMs: number,
): TunarrLineup {
  const breaks = [...(entry.midrolls ?? [])]
    .filter(
      (midroll) =>
        midroll.offsetMs > 0 &&
        midroll.offsetMs < entry.durationMs &&
        midroll.durationMs > 0,
    )
    .sort((left, right) => left.offsetMs - right.offsetMs);
  if (!breaks.length)
    return [{ type: "content", id: contentId, duration: entry.durationMs }];
  const lineup: TunarrLineup = [];
  let offset = 0;
  for (const midroll of breaks) {
    if (midroll.offsetMs <= offset) continue;
    lineup.push({
      type: "content",
      id: contentId,
      duration: midroll.offsetMs - offset,
      startOffsetMs: offset,
    });
    lineup.push({
      type: "flex",
      duration: midroll.durationMs,
      fillerConfig: {
        fillerListIds: [fillerListId],
        fillerRepeatCooldownMs: cooldownMs,
        origin: "midroll",
      },
    });
    offset = midroll.offsetMs;
  }
  if (offset < entry.durationMs) {
    lineup.push({
      type: "content",
      id: contentId,
      duration: entry.durationMs - offset,
      startOffsetMs: offset,
    });
  }
  return lineup;
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
  const lineup: TunarrLineup = [];
  let hasMidroll = false;
  for (const entry of schedule.entries) {
    if (entry.kind === "flex") {
      lineup.push({ type: "flex", duration: entry.durationMs });
      continue;
    }
    const match = matchEntry(entry, inventory, blockingErrors, matchCounts);
    if (!match) continue;
    if (fillerKinds.has(entry.kind)) matches.set(match.id, match.program);
    if (entry.kind === "movie" && entry.midrolls?.length) hasMidroll = true;
    lineup.push(
      ...splitMovie(
        entry,
        match.id,
        knownFiller?.id ?? PENDING_FILLER_ID,
        (schedule.breakPolicy?.cooldownMinutes ?? 0) * 60_000,
      ),
    );
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
