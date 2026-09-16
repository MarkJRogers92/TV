import { DateTime } from "luxon";
import {
  broadcastDateSchema,
  channelSchema,
  mediaSchema,
  poolSchema,
} from "../domain/models.js";
import type {
  Channel,
  MediaItem,
  Pool,
  Schedule,
  ScheduleDiagnostic,
  ScheduleEntry,
  SlotRule,
} from "../domain/models.js";
import {
  episodeBreakAnalysisKey,
  type EpisodeBreakAnalysis,
} from "../media/episodeBreaks.js";
import { validateChannelConfiguration } from "../domain/validation.js";
import { fillToBoundary } from "./fill.js";
import { createSeededRandom, fingerprint } from "./random.js";
import { selectCandidate, type Played } from "./select.js";

export type GenerateScheduleInput = {
  channel: Channel;
  pools: Pool[];
  items: MediaItem[];
  date: string;
  history?: Played[];
  now?: Date;
  episodeBreakAnalyses?: Record<string, EpisodeBreakAnalysis>;
};
export type ScheduleGenerationResult =
  | { ok: true; schedule: Schedule; diagnostics: ScheduleDiagnostic[] }
  | {
      ok: false;
      issues: Array<
        | ReturnType<typeof validateChannelConfiguration>[number]
        | {
            code: "INVALID_DATE" | "INVALID_CONFIGURATION";
            path: string;
            message: string;
          }
      >;
    };

const localTime = (date: DateTime) => date.toFormat("HH:mm");
const minutes = (value: string) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

function activeDaypart(channel: Channel, at: DateTime) {
  const current = at.hour * 60 + at.minute;
  const weekday = at.weekday % 7;
  return channel.dayparts
    .filter((daypart) => {
      const start = minutes(daypart.start);
      const end = minutes(daypart.end);
      if (start < end)
        return (
          daypart.days.includes(weekday) && current >= start && current < end
        );
      return (
        (daypart.days.includes(weekday) && current >= start) ||
        (daypart.days.includes((weekday + 6) % 7) && current < end)
      );
    })
    .sort((left, right) => right.priority - left.priority)[0];
}

function generationFingerprint(input: GenerateScheduleInput) {
  return fingerprint({
    channel: input.channel,
    configurationRevision: input.channel.revision,
    date: input.date,
    pools: [...input.pools].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    mediaSnapshot: [...input.items].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    historySnapshot: [...(input.history ?? [])].sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        left.mediaId.localeCompare(right.mediaId),
    ),
    episodeBreakAnalyses: Object.fromEntries(
      Object.entries(input.episodeBreakAnalyses ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

function resolveSlot(channel: Channel, at: DateTime): SlotRule | undefined {
  const fixed =
    at.second === 0 && at.millisecond === 0
      ? channel.slots.find(
          (slot) =>
            slot.time === localTime(at) && slot.days.includes(at.weekday % 7),
        )
      : undefined;
  if (fixed) return fixed;
  const daypart = activeDaypart(channel, at);
  return channel.slots.find(
    (slot) => !slot.time && slot.daypartId === daypart?.id,
  );
}

function buildMidrolls(
  slot: SlotRule,
  mediaId: string,
  durationMs: number,
  analyses: Record<string, EpisodeBreakAnalysis> | undefined,
): {
  midrolls: NonNullable<ScheduleEntry["midrolls"]>;
  fallbacks: number[];
  unsafe?: boolean;
} {
  if (slot.movieMidroll) {
    const policy = slot.movieMidroll;
    if (durationMs < policy.minimumMinutes * 60_000)
      return { midrolls: [], fallbacks: [] };
    const intervalMs = policy.intervalMinutes * 60_000;
    const breakMs = policy.breakMinutes * 60_000;
    const latestEnd = durationMs - policy.tailBufferMinutes * 60_000;
    const midrolls: NonNullable<ScheduleEntry["midrolls"]> = [];
    for (
      let offsetMs = intervalMs;
      midrolls.length < policy.maxBreaks && offsetMs + breakMs <= latestEnd;
      offsetMs += intervalMs
    ) {
      midrolls.push({ offsetMs, durationMs: breakMs });
    }
    return { midrolls, fallbacks: [] };
  }
  if (!slot.episodeMidroll) return { midrolls: [], fallbacks: [] };
  const policy = slot.episodeMidroll;
  const targetsMs = policy.targetMinutes.map((minutes) =>
    Math.round(Number(minutes) * 60_000),
  );
  const analysis = analyses?.[episodeBreakAnalysisKey(mediaId, policy)] ??
    analyses?.[mediaId] ?? {
      offsetsMs: targetsMs,
      fallbackTargetIndexes: targetsMs.map((_, index) => index),
    };
  const minimumSegmentMs = Math.round(policy.minimumSegmentMinutes * 60_000);
  const tailBufferMs = Math.round(policy.tailBufferMinutes * 60_000);
  const searchWindowMs = Math.round(policy.searchWindowMinutes * 60_000);
  const offsetsAreSafe =
    analysis.offsetsMs.length === targetsMs.length &&
    analysis.offsetsMs.every(
      (offset, index) =>
        Number.isInteger(offset) &&
        offset > 0 &&
        Math.abs(offset - targetsMs[index]) <= searchWindowMs &&
        offset - (analysis.offsetsMs[index - 1] ?? 0) >= minimumSegmentMs,
    ) &&
    durationMs - analysis.offsetsMs.at(-1)! >= tailBufferMs;
  if (!offsetsAreSafe) return { midrolls: [], fallbacks: [], unsafe: true };
  return {
    midrolls: analysis.offsetsMs.map((offsetMs) => ({
      offsetMs,
      durationMs: Math.round(policy.breakMinutes * 60_000),
    })),
    fallbacks: analysis.fallbackTargetIndexes,
  };
}

function strictNextBoundary(at: DateTime, boundaryMinutes: number) {
  const elapsedBoundaries = Math.floor(at.minute / boundaryMinutes) + 1;
  return at.startOf("hour").plus({
    minutes: elapsedBoundaries * boundaryMinutes,
  });
}

function nextBoundary(at: DateTime, boundaryMinutes: number) {
  return at.startOf("hour").plus({
    minutes: Math.ceil(at.minute / boundaryMinutes) * boundaryMinutes,
  });
}

function flexEntry(
  start: DateTime,
  end: DateTime,
  reason: string,
  source?: { daypartId?: string; slotId?: string },
): ScheduleEntry {
  return {
    id: `flex-${start.toMillis()}`,
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    localStart: localTime(start),
    localEnd: localTime(end),
    durationMs: end.toMillis() - start.toMillis(),
    kind: "flex",
    title: "Flexible programming",
    reason,
    sourceDaypartId: source?.daypartId,
    sourceSlotId: source?.slotId,
    selectionExplanation: reason,
  };
}

function selectionExplanation(slot: SlotRule, pool: Pool, weighted: boolean) {
  const prefix = slot.fallbackPoolIds.includes(pool.id)
    ? `Fallback pool ${pool.name}`
    : weighted
      ? `Weighted pool ${pool.name}`
      : `Pool ${pool.name}`;
  const decision =
    pool.mode === "chronological"
      ? `selected chronological next ${slot.kind}`
      : `selected deterministic shuffle ${slot.kind}`;
  return `${prefix}: ${decision}`;
}

export function generateSchedule(
  input: GenerateScheduleInput,
): ScheduleGenerationResult {
  if (!broadcastDateSchema.safeParse(input.date).success) {
    return {
      ok: false,
      issues: [
        {
          code: "INVALID_DATE",
          path: "date",
          message: "Date must be a real calendar date in YYYY-MM-DD form",
        },
      ],
    };
  }
  const structuralResults = [
    channelSchema.safeParse(input.channel),
    ...input.pools.map((pool) => poolSchema.safeParse(pool)),
    ...input.items.map((item) => mediaSchema.safeParse(item)),
  ];
  const structuralIssues = structuralResults.flatMap((result) =>
    result.success
      ? []
      : result.error.issues.map((issue) => {
          const path = issue.path.join(".");
          return {
            code: /(?:movie|episode)Midroll/.test(path)
              ? ("INVALID_BREAK_POLICY" as const)
              : ("INVALID_CONFIGURATION" as const),
            path,
            message: issue.message,
          };
        }),
  );
  if (structuralIssues.length) return { ok: false, issues: structuralIssues };
  const issues = validateChannelConfiguration(
    input.channel,
    input.pools,
    input.items,
  );
  if (issues.length) return { ok: false, issues };

  const dayStart = DateTime.fromISO(input.date, {
    zone: input.channel.timezone,
  }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  const generationId = generationFingerprint(input);
  const seed = `${input.channel.id}:${input.date}:${generationId}`;
  const entries: ScheduleEntry[] = [];
  const history = [...(input.history ?? [])];
  const diagnostics: ScheduleDiagnostic[] = [];
  let at: DateTime = dayStart;
  // The pool that filled the previous episode or movie slot, so the same series
  // is not scheduled twice running when something else could have taken it.
  let previousPoolId: string | undefined;

  while (at < dayEnd) {
    const daypart = activeDaypart(input.channel, at);
    const slot = resolveSlot(input.channel, at);
    if (!slot) {
      const boundary = DateTime.min(at.plus({ minutes: 30 }), dayEnd);
      entries.push(
        flexEntry(at, boundary, "No active programming slot", {
          daypartId: daypart?.id,
        }),
      );
      at = boundary;
      continue;
    }

    const primaryCandidates: Array<{
      pool: Pool;
      item: MediaItem;
      relaxed: boolean;
    }> = [];
    for (const poolId of slot.poolIds) {
      const pool = input.pools.find((candidate) => candidate.id === poolId);
      if (!pool) continue;
      const selected = selectCandidate({
        pool,
        items: input.items,
        kind: slot.kind,
        history,
        at: at.toUTC().toISO()!,
        seed: `${seed}:${at.toMillis()}:${poolId}`,
        allowCooldownRelaxation: slot.allowCooldownRelaxation,
      });
      if (selected.item) {
        primaryCandidates.push({
          pool,
          item: selected.item,
          relaxed: selected.relaxed,
        });
      }
    }
    // A pool that filled the previous slot is only reconsidered when it is the
    // sole option, so a series cannot run for hours merely because the seeded
    // choice kept landing on it. Weights decide among what remains.
    const contenders =
      new Set(primaryCandidates.map((candidate) => candidate.pool.id)).size > 1
        ? primaryCandidates.filter(
            (candidate) => candidate.pool.id !== previousPoolId,
          )
        : primaryCandidates;
    let selectedPool = contenders[0];
    if (contenders.length > 1) {
      const totalWeight = contenders.reduce(
        (total, candidate) => total + candidate.pool.weight,
        0,
      );
      let choice =
        createSeededRandom(`${seed}:${at.toMillis()}:pool-choice`)() *
        totalWeight;
      selectedPool = contenders.find((candidate) => {
        choice -= candidate.pool.weight;
        return choice < 0;
      })!;
    }
    if (!selectedPool) {
      for (const poolId of slot.fallbackPoolIds) {
        const pool = input.pools.find((candidate) => candidate.id === poolId);
        if (!pool) continue;
        const selected = selectCandidate({
          pool,
          items: input.items,
          kind: slot.kind,
          history,
          at: at.toUTC().toISO()!,
          seed: `${seed}:${at.toMillis()}:${poolId}`,
          allowCooldownRelaxation: slot.allowCooldownRelaxation,
        });
        if (selected.item) {
          selectedPool = {
            pool,
            item: selected.item,
            relaxed: selected.relaxed,
          };
          break;
        }
      }
    }
    const chosen = selectedPool?.item;
    const chosenPoolId = selectedPool?.pool.id;
    const cooldownRelaxed = selectedPool?.relaxed ?? false;
    if (chosenPoolId) previousPoolId = chosenPoolId;

    if (chosenPoolId && slot.fallbackPoolIds.includes(chosenPoolId)) {
      diagnostics.push({
        code: "FALLBACK_POOL",
        message: `Used fallback pool ${chosenPoolId} at ${localTime(at)}`,
      });
    }
    if (cooldownRelaxed && chosen) {
      diagnostics.push({
        code: "COOLDOWN_RELAXED",
        message: `Relaxed cooldown for ${chosen.title}`,
        mediaId: chosen.id,
      });
    }

    if (!chosen?.durationMs) {
      const boundary = DateTime.min(at.plus({ minutes: 30 }), dayEnd);
      entries.push(
        ...fillToBoundary({
          start: at.toJSDate(),
          boundary: boundary.toJSDate(),
          items: [],
        }).entries.map((entry) => ({
          ...entry,
          localStart: localTime(
            DateTime.fromISO(entry.start).setZone(input.channel.timezone),
          ),
          localEnd: localTime(
            DateTime.fromISO(entry.end).setZone(input.channel.timezone),
          ),
          sourceDaypartId: daypart?.id,
          sourceSlotId: slot.id,
          selectionExplanation:
            entry.reason ?? "No eligible program in configured pools",
        })),
      );
      diagnostics.push({
        code: "EXHAUSTED_POOL",
        message: `No eligible media at ${localTime(at)}`,
      });
      at = boundary;
      continue;
    }

    const attached = buildMidrolls(
      slot,
      chosen.id,
      chosen.durationMs,
      input.episodeBreakAnalyses,
    );
    let midrolls = attached.midrolls;
    let broadcastDurationMs =
      chosen.durationMs +
      midrolls.reduce((total, midroll) => total + midroll.durationMs, 0);
    if (
      slot.kind === "episode" &&
      midrolls.length &&
      at.plus({ milliseconds: broadcastDurationMs }) >
        strictNextBoundary(at, input.channel.breakPolicy.boundaryMinutes)
    ) {
      diagnostics.push({
        code: "EPISODE_BREAKS_SKIPPED_BLOCK_OVERFLOW",
        message: `${chosen.title} plus its mid-show breaks cannot fit before the next schedule boundary`,
        mediaId: chosen.id,
      });
      midrolls = [];
      broadcastDurationMs = chosen.durationMs;
    }
    if (attached.unsafe) {
      diagnostics.push({
        code: "EPISODE_BREAKS_SKIPPED_UNSAFE_OFFSETS",
        message: `${chosen.title} cannot satisfy the configured content and tail buffers`,
        mediaId: chosen.id,
      });
    }
    const finish = at.plus({ milliseconds: broadcastDurationMs });
    if (finish > dayEnd) {
      entries.push(
        flexEntry(at, dayEnd, "Selected program exceeds broadcast day", {
          daypartId: daypart?.id,
          slotId: slot.id,
        }),
      );
      diagnostics.push({
        code: "PROGRAM_OVERRUN",
        message: `${chosen.title} would exceed the broadcast day`,
        mediaId: chosen.id,
      });
      at = dayEnd;
      continue;
    }
    const entry: ScheduleEntry = {
      id: `${chosen.id}-${at.toMillis()}`,
      start: at.toUTC().toISO()!,
      end: finish.toUTC().toISO()!,
      localStart: localTime(at),
      localEnd: localTime(finish),
      durationMs: broadcastDurationMs,
      kind: chosen.kind,
      title: chosen.title,
      mediaId: chosen.id,
      path: chosen.path,
      source: slot.id,
      sourceDaypartId: daypart?.id,
      sourceSlotId: slot.id,
      selectionExplanation: selectionExplanation(
        slot,
        selectedPool.pool,
        primaryCandidates.length > 1,
      ),
    };
    if (midrolls.length) {
      entry.contentDurationMs = chosen.durationMs;
      entry.midrolls = midrolls;
      for (const targetIndex of attached.fallbacks) {
        diagnostics.push({
          code: "EPISODE_BREAK_FALLBACK",
          message: `${chosen.title} break ${targetIndex + 1} used the configured target because no safe black transition was detected`,
          mediaId: chosen.id,
        });
      }
    }
    entries.push(entry);
    history.push({ mediaId: chosen.id, at: entry.start });
    at = finish;

    const boundary = nextBoundary(
      at,
      input.channel.breakPolicy.boundaryMinutes,
    );
    if (boundary > at && boundary <= dayEnd) {
      const fillerPoolIds = [
        ...input.channel.breakPolicy.poolIds,
        ...(boundary.minute === 0
          ? input.channel.breakPolicy.stationIdPoolIds
          : []),
      ];
      const filler = fillerPoolIds.flatMap((poolId) => {
        const pool = input.pools.find((candidate) => candidate.id === poolId);
        return pool
          ? pool.mediaIds
              .map((id) => input.items.find((item) => item.id === id))
              .filter(
                (item): item is MediaItem =>
                  Boolean(item) && pool.kinds.includes(item!.kind),
              )
          : [];
      });
      const filled = fillToBoundary({
        start: at.toJSDate(),
        boundary: boundary.toJSDate(),
        items: filler,
        history,
        cooldownMinutes: input.channel.breakPolicy.cooldownMinutes,
        seed: `${seed}:filler:${at.toMillis()}`,
        source: "interstitial",
        stationIdsEligible: boundary.minute === 0,
      }).entries.map((fillerEntry) => ({
        ...fillerEntry,
        localStart: localTime(
          DateTime.fromISO(fillerEntry.start).setZone(input.channel.timezone),
        ),
        localEnd: localTime(
          DateTime.fromISO(fillerEntry.end).setZone(input.channel.timezone),
        ),
        sourceDaypartId: daypart?.id,
        sourceSlotId: slot.id,
        selectionExplanation:
          fillerEntry.reason ?? "Selected interstitial for schedule boundary",
      }));
      entries.push(...filled);
      for (const fillerEntry of filled) {
        if (fillerEntry.mediaId)
          history.push({ mediaId: fillerEntry.mediaId, at: fillerEntry.start });
      }
      at = boundary;
    }
  }

  const schedule: Schedule = {
    id: `${input.channel.id}-${input.date}-${generationId}`,
    channelId: input.channel.id,
    date: input.date,
    timezone: input.channel.timezone,
    seed,
    revision: input.channel.revision,
    generatedAt: (input.now ?? new Date()).toISOString(),
    durationMs: dayEnd.toMillis() - dayStart.toMillis(),
    entries,
    diagnostics,
    channelName: input.channel.name,
    channelNumber: input.channel.number,
    breakPolicy: input.channel.breakPolicy,
  };
  return { ok: true, schedule, diagnostics };
}
