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
import {
  anchorInstant,
  continuationMidrolls,
  movieMidrollLayout,
  selectMovieBreak,
  selectMovieBridge,
  type MovieAiringPlan,
  type MovieContinuationPlan,
} from "./movieProgramming.js";
import type {
  MovieCarry,
  MovieProgramming,
  MovieRole,
} from "../domain/models.js";
import type { PreservedLineupIssue } from "./preservedLineup.js";

export type GenerateScheduleInput = {
  channel: Channel;
  pools: Pool[];
  items: MediaItem[];
  date: string;
  history?: Played[];
  now?: Date;
  episodeBreakAnalyses?: Record<string, EpisodeBreakAnalysis>;
  /**
   * The movie-programming feature's resolved plan for this date.
   *
   * Passed in rather than derived here because the assignments are persisted
   * state: the same plan is what a preview shows, what a regeneration reuses, and
   * what survives a restart.
   */
  movieProgramming?: MovieProgrammingRuntime;
};

export type MovieProgrammingRuntime = {
  programming: MovieProgramming;
  airings: MovieAiringPlan[];
  continuations: MovieContinuationPlan[];
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
        // A preserved-lineup channel refuses the day for reasons the ordinary
        // configuration validator never sees: a missing or unapproved archive,
        // coverage that does not reach this date, media the archive names that
        // the catalog cannot supply. They carry their own codes so the operator
        // can tell "this channel is not bound to what it was approved against"
        // from "this channel's slots are misconfigured".
        | PreservedLineupIssue
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
    // The movie assignments are part of the plan, not decoration: a different
    // assignment must produce a different generation fingerprint.
    movieProgramming: input.movieProgramming,
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
              || /breakPolicy/.test(path)
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
  // Interstitials already placed today. Held for the whole day rather than per
  // break, so the ad pool is consumed like a bag: an item used at 09:00 is not
  // offered again at 21:00 while unused items remain. The per-break cooldown
  // cannot reach that far back, which is why a day used to draw only ~214 of
  // 577 distinct ads. Scoped to one generation, so it never leaks across days -
  // each day is a fresh shuffle.
  const usedInterstitials = new Set<string>();
  const movieRuntime = input.movieProgramming;
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const poolItems = (poolIds: string[]) =>
    poolIds.flatMap((poolId) => {
      const pool = input.pools.find((candidate) => candidate.id === poolId);
      if (!pool) return [];
      return pool.mediaIds
        .map((id) => itemsById.get(id))
        .filter((item): item is MediaItem => Boolean(item));
    });
  // Breaks and bridges reuse the live interstitial pools and the same whole-spot
  // discipline the sitcom boundaries already use, so a movie break can never ask
  // Tunarr for a duration the library cannot actually fill.
  const movieBreakItems = movieRuntime
    ? poolItems(input.channel.breakPolicy.poolIds)
    : [];
  const bridgePoolIds = movieRuntime
    ? [
        ...(movieRuntime.programming.bridgePoolIds.length
          ? movieRuntime.programming.bridgePoolIds
          : input.channel.breakPolicy.poolIds),
      ]
    : [];
  const bridgeItems = poolItems(bridgePoolIds);
  const pendingAirings = (movieRuntime?.airings ?? []).map((airing) => ({
    ...airing,
    dueAt: anchorInstant(airing.date, airing.anchor, input.channel.timezone),
    placed: false,
    deferred: false,
  }));
  // What yesterday's schedule handed over: the tail of a feature that stopped at
  // midnight, the closer of a double feature whose opener did not finish in time,
  // or both. Held as one block so the pair can never be split by a sitcom.
  const pendingBlocks = (movieRuntime?.continuations ?? []).map(
    (continuation) => ({ ...continuation }),
  );
  let movieCarry: MovieCarry | undefined;
  const movieSeed = `${seed}:movie-programming`;

  /**
   * Interstitials that carry the schedule to the next boundary.
   *
   * Shared by ordinary programs and movies so both use one bag and one cooldown;
   * `source` names whatever produced the entry being padded.
   */
  const fillBoundary = (
    from: DateTime,
    source: { daypartId?: string; slotId?: string },
  ) => {
    const boundary = nextBoundary(
      from,
      input.channel.breakPolicy.boundaryMinutes,
    );
    if (!(boundary > from && boundary <= dayEnd)) return from;
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
      start: from.toJSDate(),
      boundary: boundary.toJSDate(),
      items: filler,
      history,
      cooldownMinutes: input.channel.breakPolicy.cooldownMinutes,
      seed: `${seed}:filler:${from.toMillis()}`,
      source: "interstitial",
      stationIdsEligible: boundary.minute === 0,
      exclude: usedInterstitials,
    }).entries.map((fillerEntry) => ({
      ...fillerEntry,
      localStart: localTime(
        DateTime.fromISO(fillerEntry.start).setZone(input.channel.timezone),
      ),
      localEnd: localTime(
        DateTime.fromISO(fillerEntry.end).setZone(input.channel.timezone),
      ),
      sourceDaypartId: source.daypartId,
      sourceSlotId: source.slotId,
      selectionExplanation:
        fillerEntry.reason ?? "Selected interstitial for schedule boundary",
    }));
    entries.push(...filled);
    for (const fillerEntry of filled) {
      if (fillerEntry.mediaId) {
        history.push({ mediaId: fillerEntry.mediaId, at: fillerEntry.start });
        usedInterstitials.add(fillerEntry.mediaId);
      }
    }
    return boundary;
  };

  /**
   * Emit one movie airing, truncating it at the day boundary if it does not fit.
   *
   * Truncation is a real split, not a drop: the tail keeps its source offset and
   * its remaining breaks and is continued by the next day's schedule.
   */
  const emitMovieAiring = (options: {
    item: MediaItem;
    start: DateTime;
    sourceOffsetMs: number;
    role: MovieRole;
    occurrenceKey: string;
    encore: boolean;
  }):
    | { entry: ScheduleEntry; end: DateTime; continues: boolean }
    | undefined => {
    const programming = movieRuntime!.programming;
    const breakSelection = selectMovieBreak(movieBreakItems, programming.breakPolicy, {
      seed: `${movieSeed}:${options.occurrenceKey}:break`,
    });
    // The film's own timeline is only ever known from the duration: no black,
    // fade, audio or chapter analysis of the movie file is performed here, so the
    // LOCATION of each break is an estimate from percentage targets and says so.
    // Whether the break's duration can be filled with whole spots is a separate,
    // genuinely determined fact, and is reported separately.
    const podFill =
      breakSelection.durationMs > 0
        ? breakSelection.source === "detected"
          ? {
              code: "MOVIE_BREAK_POD_FILL_DETECTED",
              message: `${options.item.title} break duration is an exact combination of ${breakSelection.items.length} whole spot(s) totalling ${Math.round(breakSelection.durationMs / 1000)}s`,
            }
          : {
              code: "MOVIE_BREAK_POD_FILL_ESTIMATED",
              message: `${options.item.title} has no local whole-spot combination; the configured ${Math.round(breakSelection.durationMs / 1000)}s target is used as the pod fill`,
            }
        : undefined;
    const fullLayout = movieMidrollLayout(
      options.item.durationMs!,
      breakSelection.durationMs,
      programming.breakPolicy,
    );
    const layout = continuationMidrolls(fullLayout, options.sourceOffsetMs);
    const availableMs = dayEnd.toMillis() - options.start.toMillis();
    const fullRemainingMs = options.item.durationMs! - options.sourceOffsetMs;
    if (availableMs <= 0 || fullRemainingMs <= 0) return undefined;
    let contentMs = Math.min(fullRemainingMs, availableMs);
    for (let guard = 0; guard < 64; guard += 1) {
      const inside = layout.filter((breakAt) => breakAt.offsetMs < contentMs);
      const total =
        contentMs +
        inside.reduce((sum, breakAt) => sum + breakAt.durationMs, 0);
      if (total <= availableMs) break;
      contentMs -= total - availableMs;
      if (contentMs <= 0) break;
    }
    if (contentMs <= 0) return undefined;
    // Offset zero is the break that sat exactly on the resume point: the previous
    // day could not air it, so it opens the continuation instead of vanishing.
    const inside = layout.filter(
      (breakAt) => breakAt.offsetMs >= 0 && breakAt.offsetMs < contentMs,
    );
    const broadcastMs =
      contentMs + inside.reduce((sum, breakAt) => sum + breakAt.durationMs, 0);
    const end = options.start.plus({ milliseconds: broadcastMs });
    const entry: ScheduleEntry = {
      id: `movie-${options.occurrenceKey}-${options.start.toMillis()}`,
      start: options.start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      localStart: localTime(options.start),
      localEnd: localTime(end),
      durationMs: broadcastMs,
      kind: "movie",
      title: options.item.title,
      mediaId: options.item.id,
      path: options.item.path,
      source: "movie-programming",
      sourceSlotId: "movie-programming",
      sourceDaypartId: activeDaypart(input.channel, options.start)?.id,
      movieRole: options.role,
      movieOccurrenceKey: options.occurrenceKey,
      selectionExplanation: options.encore
        ? `Movie programming: ${options.role} encore of ${options.occurrenceKey}`
        : `Movie programming: ${options.role} from the movie rotation`,
    };
    if (options.sourceOffsetMs > 0) entry.sourceOffsetMs = options.sourceOffsetMs;
    if (inside.length) {
      entry.contentDurationMs = contentMs;
      entry.midrolls = inside;
      diagnostics.push({
        code: "MOVIE_BREAK_ESTIMATED",
        message: `${options.item.title} break locations are estimated from percentage targets (first and last ${programming.breakPolicy.protectionMinutes} minutes protected); no black, fade, audio or chapter analysis was used and no credits metadata was available`,
        mediaId: options.item.id,
      });
      if (podFill)
        diagnostics.push({ ...podFill, mediaId: options.item.id });
    }
    const continues = fullRemainingMs - contentMs > 0;
    if (continues)
      diagnostics.push({
        code: "MOVIE_CONTINUES_NEXT_DAY",
        message: `${options.item.title} continues past ${input.date} with ${Math.round((fullRemainingMs - contentMs) / 1000)}s left at source offset ${options.sourceOffsetMs + contentMs}ms`,
        mediaId: options.item.id,
      });
    return { entry, end, continues };
  };

  /** Where the next day must resume a feature, as persisted carry state. */
  const continuationTail = (entry: ScheduleEntry) => ({
    mediaId: entry.mediaId!,
    // The SOURCE offset, not the entry's: a feature resumed at 40 minutes and
    // truncated again resumes at 40 minutes plus what it played today.
    sourceOffsetMs:
      (entry.sourceOffsetMs ?? 0) +
      (entry.contentDurationMs ?? entry.durationMs),
    occurrenceKey: entry.movieOccurrenceKey,
    role: entry.movieRole,
  });

  /**
   * The 60-120 second whole-spot bridge between the two halves of a pair.
   *
   * A bridge that does not fit before the day boundary is never clipped mid-spot:
   * half a commercial is worse than carrying the bridge to the next day, where
   * `bridgeOwed` guarantees it still airs exactly once.
   */
  const emitBridge = (
    pairKey: string,
  ): "emitted" | "unavailable" | "doesNotFit" => {
    const bridge = selectMovieBridge(bridgeItems, movieRuntime!.programming, {
      seed: `${movieSeed}:${pairKey}:bridge`,
      exclude: usedInterstitials,
    });
    if (!bridge) {
      diagnostics.push({
        code: "MOVIE_BRIDGE_UNAVAILABLE",
        message: `No ${movieRuntime!.programming.bridgeMinSeconds}-${movieRuntime!.programming.bridgeMaxSeconds}s whole-spot bridge is available between the two features`,
      });
      return "unavailable";
    }
    const totalMs = bridge.items.reduce(
      (sum, spot) => sum + spot.durationMs!,
      0,
    );
    if (at.plus({ milliseconds: totalMs }) > dayEnd) return "doesNotFit";
    for (const spot of bridge.items) {
      const spotEnd = at.plus({ milliseconds: spot.durationMs! });
      entries.push({
        id: `movie-bridge-${spot.id}-${at.toMillis()}`,
        start: at.toUTC().toISO()!,
        end: spotEnd.toUTC().toISO()!,
        localStart: localTime(at),
        localEnd: localTime(spotEnd),
        durationMs: spot.durationMs!,
        kind: spot.kind,
        title: spot.title,
        mediaId: spot.id,
        path: spot.path,
        source: "movie-bridge",
        sourceSlotId: "movie-programming",
        selectionExplanation:
          "Movie programming: whole-spot bridge between the two features",
      });
      history.push({ mediaId: spot.id, at: at.toUTC().toISO()! });
      usedInterstitials.add(spot.id);
      at = spotEnd;
    }
    return "emitted";
  };

  /**
   * Records what the next day owes.
   *
   * A closer that is already owed is never discarded by a later block on the same
   * day: losing a promised feature is the failure this whole mechanism exists to
   * prevent, and the alternative - one film airing in an unusual order - is only
   * reachable when a feature starts in the closing minutes of the day.
   */
  const recordCarry = (next: MovieCarry) => {
    movieCarry = {
      continuation: next.continuation,
      closer: next.closer ?? movieCarry?.closer,
    };
  };

  // A movie programme that began yesterday keeps the screen until it is really
  // finished. A weekend double feature is one block, so an opener that reached
  // midnight is resumed, bridged and closed before ordinary programming returns -
  // and if all of that cannot fit, the whole remaining block is carried again.
  while (pendingBlocks.length) {
    const block = pendingBlocks.shift()!;
    if (block.continuation) {
      const item = itemsById.get(block.continuation.mediaId);
      if (!item?.durationMs || item.kind !== "movie" || !item.available) {
        diagnostics.push({
          code: "MOVIE_CONTINUATION_UNAVAILABLE",
          message: `The movie that was to continue at ${localTime(at)} is no longer available`,
          mediaId: block.continuation.mediaId,
        });
      } else {
        const emitted = emitMovieAiring({
          item,
          start: at,
          sourceOffsetMs: block.continuation.sourceOffsetMs,
          role: block.continuation.role ?? "nightly",
          occurrenceKey:
            block.continuation.occurrenceKey ??
            `${input.date}:continuation:${block.continuation.mediaId}`,
          encore: false,
        });
        if (!emitted) {
          recordCarry({
            continuation: block.continuation,
            closer: block.pendingCloser,
          });
          break;
        }
        entries.push(emitted.entry);
        history.push({ mediaId: item.id, at: emitted.entry.start });
        at = emitted.end;
        if (emitted.continues) {
          recordCarry({
            continuation: continuationTail(emitted.entry),
            closer: block.pendingCloser,
          });
          break;
        }
      }
    }
    if (!block.pendingCloser) continue;
    let bridgeOwed = block.pendingCloser.bridgeOwed;
    if (bridgeOwed) {
      const bridge = emitBridge(block.pendingCloser.occurrenceKey);
      if (bridge === "emitted") bridgeOwed = false;
      else if (bridge === "doesNotFit") {
        recordCarry({
          closer: { ...block.pendingCloser, bridgeOwed: true },
        });
        break;
      } else
        // No bridge exists at all: skipping it beats carrying it forever, and the
        // diagnostic above already says the pair airs without one.
        bridgeOwed = false;
    }
    const closerItem = itemsById.get(block.pendingCloser.mediaId);
    if (!closerItem?.durationMs || closerItem.kind !== "movie" || !closerItem.available) {
      diagnostics.push({
        code: "MOVIE_MEDIA_UNAVAILABLE",
        message: `${block.pendingCloser.occurrenceKey} has no playable movie in the catalog`,
        mediaId: block.pendingCloser.mediaId,
      });
      continue;
    }
    const emitted = emitMovieAiring({
      item: closerItem,
      start: at,
      sourceOffsetMs: 0,
      role: block.pendingCloser.role,
      occurrenceKey: block.pendingCloser.occurrenceKey,
      encore: block.pendingCloser.encore,
    });
    if (!emitted) {
      recordCarry({ closer: { ...block.pendingCloser, bridgeOwed } });
      break;
    }
    entries.push(emitted.entry);
    history.push({ mediaId: closerItem.id, at: emitted.entry.start });
    at = emitted.end;
    if (emitted.continues) {
      recordCarry({ continuation: continuationTail(emitted.entry) });
      break;
    }
  }

  while (at < dayEnd) {
    const daypart = activeDaypart(input.channel, at);
    // A movie airing is due once the walk reaches a natural program boundary
    // within 15 minutes of its anchor. No exact-second match is required: the
    // anchor is soft, so a sitcom finishing at 02:03 or 19:04 starts the feature
    // there rather than dropping it.
    const dueAiring = pendingAirings.find(
      (airing) =>
        !airing.placed &&
        !airing.deferred &&
        at >= airing.dueAt.minus({ minutes: 15 }),
    );
    if (dueAiring) {
      const media = itemsById.get(dueAiring.mediaId);
      if (!media?.durationMs || media.kind !== "movie" || !media.available) {
        dueAiring.placed = true;
        diagnostics.push({
          code: "MOVIE_MEDIA_UNAVAILABLE",
          message: `${dueAiring.occurrenceKey} has no playable movie in the catalog`,
          mediaId: dueAiring.mediaId,
        });
        continue;
      }
      if (at > dueAiring.dueAt.plus({ minutes: 15 })) {
        diagnostics.push({
          code: "MOVIE_ANCHOR_LATE",
          message: `${media.title} started at ${localTime(at)} instead of its ${dueAiring.anchor} anchor`,
          mediaId: media.id,
        });
      }
      const emitted = emitMovieAiring({
        item: media,
        start: at,
        sourceOffsetMs: 0,
        role: dueAiring.role,
        occurrenceKey: dueAiring.occurrenceKey,
        encore: dueAiring.encore,
      });
      if (!emitted) {
        // There is genuinely no room left in the day. The airing stays unplaced
        // so the next generation can still honour it, but it is not re-found in
        // this walk, which would spin forever at the same instant.
        dueAiring.deferred = true;
        diagnostics.push({
          code: "MOVIE_AIRING_DROPPED",
          message: `${media.title} could not fit before the end of ${input.date}`,
          mediaId: media.id,
        });
        continue;
      }
      dueAiring.placed = true;
      entries.push(emitted.entry);
      history.push({ mediaId: media.id, at: emitted.entry.start });
      at = emitted.end;
      // A weekend double feature is one block: the opener, a 60-120 second
      // bridge of whole interstitials, then the closer. Never a third feature.
      const closer = dueAiring.pairId
        ? pendingAirings.find(
            (airing) =>
              !airing.placed &&
              !airing.deferred &&
              airing.pairId === dueAiring.pairId,
          )
        : undefined;
      if (closer) {
        // The opener ran to the day boundary: the pair is not finished, so the
        // closer is carried whole - with the bridge still owed - rather than
        // being dropped or left to a sitcom-filled gap.
        if (emitted.continues) {
          closer.placed = true;
          recordCarry({
            continuation: continuationTail(emitted.entry),
            closer: {
              occurrenceKey: closer.occurrenceKey,
              mediaId: closer.mediaId,
              role: closer.role,
              encore: closer.encore,
              bridgeOwed: true,
            },
          });
          at = fillBoundary(at, {
            daypartId: activeDaypart(input.channel, at)?.id,
            slotId: "movie-programming",
          });
          continue;
        }
        const bridgeOwed = false;
        const bridge = emitBridge(dueAiring.pairId!);
        if (bridge === "doesNotFit") {
          // The opener did finish today, but there is not enough broadcast day
          // left for even one intact bridge.  Keep the remaining pair atomic:
          // starting the closer in the final seconds would turn it into a
          // continuation and silently lose the bridge that belongs before it.
          // This is the same carry shape used when an opener itself crosses
          // midnight, so tomorrow emits bridge -> closer before any sitcom.
          recordCarry({
            closer: {
              occurrenceKey: closer.occurrenceKey,
              mediaId: closer.mediaId,
              role: closer.role,
              encore: closer.encore,
              bridgeOwed: true,
            },
          });
          closer.placed = true;
          at = fillBoundary(at, {
            daypartId: activeDaypart(input.channel, at)?.id,
            slotId: "movie-programming",
          });
          continue;
        }
        const closerMedia = itemsById.get(closer.mediaId);
        if (
          !closerMedia?.durationMs ||
          closerMedia.kind !== "movie" ||
          !closerMedia.available
        ) {
          closer.placed = true;
          diagnostics.push({
            code: "MOVIE_MEDIA_UNAVAILABLE",
            message: `${closer.occurrenceKey} has no playable movie in the catalog`,
            mediaId: closer.mediaId,
          });
        } else {
          const second = emitMovieAiring({
            item: closerMedia,
            start: at,
            sourceOffsetMs: 0,
            role: closer.role,
            occurrenceKey: closer.occurrenceKey,
            encore: closer.encore,
          });
          if (!second) {
            // Not placed here: the carry below is what schedules it, and only
            // after that has been decided is the closer accounted for.
            recordCarry({
              closer: {
                occurrenceKey: closer.occurrenceKey,
                mediaId: closer.mediaId,
                role: closer.role,
                encore: closer.encore,
                bridgeOwed,
              },
            });
            closer.placed = true;
          } else {
            closer.placed = true;
            entries.push(second.entry);
            history.push({ mediaId: closerMedia.id, at: second.entry.start });
            at = second.end;
            if (second.continues)
              recordCarry({ continuation: continuationTail(second.entry) });
          }
        }
      }
      at = fillBoundary(at, {
        daypartId: activeDaypart(input.channel, at)?.id,
        slotId: "movie-programming",
      });
      continue;
    }
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
    at = fillBoundary(at, { daypartId: daypart?.id, slotId: slot.id });
  }

  // Every branch above advances to a program boundary or clamps to the day end,
  // so this only fires if one of them ever forgets to. Filling it keeps the
  // promise the Tunarr plan checks: the entries add up to exactly one day.
  if (at < dayEnd) {
    entries.push(
      flexEntry(at, dayEnd, "Unfilled remainder of the broadcast day"),
    );
    at = dayEnd;
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
    movieCarry,
    channelName: input.channel.name,
    channelNumber: input.channel.number,
    breakPolicy: input.channel.breakPolicy,
  };
  return { ok: true, schedule, diagnostics };
}
