import { join } from "node:path";
import type { Repositories } from "../db/repositories.js";
import type { Channel, MovieCarry, Schedule } from "../domain/models.js";
import type { EpisodeMidrollPolicy, MediaItem } from "../domain/models.js";
import { writeScheduleExport } from "../export/marktvJson.js";
import {
  generateSchedule,
  type ScheduleGenerationResult,
} from "../scheduler/generate.js";
import {
  EpisodeBreakAnalyzer,
  episodeBreakAnalysisKey,
  type EpisodeBreakAnalysis,
} from "../media/episodeBreaks.js";
import { DateTime } from "luxon";
import {
  ensureMovieOccurrencesForDate,
  movieProgrammingPlan,
  openMovieProjection,
  type MovieContinuationPlan,
} from "../scheduler/movieProgramming.js";
import type { MovieProgrammingRuntime } from "../scheduler/generate.js";
import type { MovieProgramming } from "../domain/models.js";
import { applyContinuityToSchedule } from "../continuity/publish.js";
import {
  appendContinuityDecision,
  invalidatePlannedContinuityDecisions,
  readContinuityHistoryForPlanning,
} from "../continuity/history.js";
import {
  prepareContinuityMedia,
  type ContinuityPreparer,
} from "../continuity/prepare.js";
import { readContinuityConfig } from "../continuity/status.js";
import {
  buildPreservedLineupSchedule,
  readPreservedLineup,
} from "../scheduler/preservedLineup.js";

export type ExportSchedule = (
  schedule: Schedule,
  destinationDir: string,
) => Promise<string>;
export type PersistedGeneration =
  | { ok: true; schedule: Schedule; exportPath: string }
  | Extract<ScheduleGenerationResult, { ok: false }>;

export class ScheduleExportError extends Error {
  readonly code = "EXPORT_FAILED";
}

/**
 * Cap on cached episode-break analyses.
 *
 * The cache key is content-derived - path, size, mtime, dev/ino and policy - so a
 * re-import or an edited file mints a NEW entry rather than refreshing an existing
 * one. Nothing ever removed them, so the documents table grew with every re-import
 * and `settings.list()` scanned more rows for every caller.
 */
const episodeBreakCacheLimit = 2_000;

/**
 * Drop every stored schedule for a channel that has not been broadcast yet.
 *
 * A movie-programming change rewrites what the future will air: enabling adds
 * nightly and weekend features to days that were planned as sitcoms, disabling
 * has to take them back out, and a changed anchor or pool changes the films. A
 * pre-generated tomorrow therefore cannot be left in place - it would air the
 * configuration the operator just replaced.
 *
 * Today is deliberately kept. Its schedule is already being broadcast, and
 * replacing it mid-airing would cut the channel over to a different lineup in
 * the middle of a programme. Past days are history and are never touched.
 *
 * The assignments for those future days go with them: each carries the anchor
 * and pool membership it was derived under, so keeping them would rebuild the
 * schedule from the very configuration that was just replaced. The rotation is
 * NOT touched - it is deliberately stable across rescans and edits.
 */
export function invalidateUnpublishedSchedules(
  repositories: Repositories,
  channel: Channel,
  now: Date,
): number {
  const today = DateTime.fromJSDate(now, { zone: channel.timezone }).toISODate();
  if (!today) return 0;
  repositories.movieOccurrences.removeAfterDate(channel.id, today);
  return repositories.schedules.removeAfterDate(channel.id, today);
}

export class ScheduleService {
  private readonly inFlight = new Map<string, Promise<PersistedGeneration>>();
  private readonly episodeBreakAnalyzer: {
    analyze(
      item: MediaItem,
      policy: EpisodeMidrollPolicy,
    ): Promise<EpisodeBreakAnalysis>;
  };

  constructor(
    private readonly repositories: Repositories,
    private readonly dataDir: string,
    private readonly now: () => Date,
    private readonly exportSchedule: ExportSchedule = writeScheduleExport,
    episodeBreakAnalyzer?: {
      analyze(
        item: MediaItem,
        policy: EpisodeMidrollPolicy,
      ): Promise<EpisodeBreakAnalysis>;
    },
    /**
     * Automatic offline continuity preparation.
     *
     * Injectable so the schedule tests exercise the wiring without spawning
     * real render jobs; production uses the offline renderer.
     */
    private readonly continuityPreparer: ContinuityPreparer = prepareContinuityMedia,
    private readonly continuityRepoRoot: string = process.cwd(),
  ) {
    this.episodeBreakAnalyzer =
      episodeBreakAnalyzer ??
      new EpisodeBreakAnalyzer({
        cache: {
          get: (key) =>
            this.repositories.settings.get(`episode-break-analysis:${key}`)
              ?.value,
          put: (key, value) =>
            this.repositories.settings.put(
              `episode-break-analysis:${key}`,
              value,
            ),
        },
      });
  }

  private async analyzeEpisodeBreaks(
    channel: Channel,
    selectedMediaIds: ReadonlySet<string>,
  ) {
    const pools = this.repositories.pools.list();
    const items = this.repositories.media.list();
    const poolsById = new Map(pools.map((pool) => [pool.id, pool]));
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const work = new Map<
      string,
      { item: MediaItem; policy: EpisodeMidrollPolicy }
    >();
    for (const slot of channel.slots) {
      if (slot.kind !== "episode" || !slot.episodeMidroll) continue;
      for (const poolId of [...slot.poolIds, ...slot.fallbackPoolIds]) {
        for (const mediaId of poolsById.get(poolId)?.mediaIds ?? []) {
          const item = itemsById.get(mediaId);
          if (
            !item ||
            !selectedMediaIds.has(item.id) ||
            item.kind !== "episode" ||
            item.source !== "local-folder" ||
            !item.path ||
            !item.available
          )
            continue;
          const key = episodeBreakAnalysisKey(item.id, slot.episodeMidroll);
          work.set(key, { item, policy: slot.episodeMidroll });
        }
      }
    }
    const analyses: Record<string, EpisodeBreakAnalysis> = {};
    const pending = [...work.entries()];
    const worker = async () => {
      for (;;) {
        const next = pending.shift();
        if (!next) return;
        analyses[next[0]] = await this.episodeBreakAnalyzer.analyze(
          next[1].item,
          next[1].policy,
        );
      }
    };
    // One analyzer at a time: each call spawns ffmpeg, and running two of them
    // at once doubles the peak load this already-slow generation step puts on
    // the machine.
    await worker();
    // Pruned here rather than inside the cache itself: this runs once per
    // generation, which is the natural low-frequency point, and the cache has just
    // been filled above.
    this.repositories.settings.pruneByPrefix(
      "episode-break-analysis:",
      episodeBreakCacheLimit,
    );
    return analyses;
  }

  async generate(channel: Channel, date: string): Promise<PersistedGeneration> {
    const input = {
      channel,
      pools: this.repositories.pools.list(),
      items: this.repositories.media.list(),
      date,
      history: this.repositories.schedules.historyBefore(channel.id, date),
      now: this.now(),
    };
    // A preserved-lineup channel is sliced, not scheduled. The archive decides the
    // day exactly, so ordinary selection is skipped entirely rather than being
    // consulted and overruled - and a missing, invalid or exhausted archive
    // refuses the day here, before anything is exported or stored.
    const preserved = this.preservedLineup(channel, date, input.items);
    let result: ScheduleGenerationResult;
    if (preserved) {
      if (preserved.ok === false) return preserved;
      result = preserved;
    } else {
      const movieProgramming = this.movieRuntime(channel, date);
      const slotMovieIds = new Set(
        channel.slots.filter((slot) => slot.kind === "movie").map((slot) => slot.id),
      );
      const assignmentKey = `slot-movie-assignments:${channel.id}:${date}`;
      const storedAssignments = this.repositories.settings.get(assignmentKey)?.value;
      const priorSchedule = this.repositories.schedules.latestForDate(channel.id, date);
      const priorAssignments = priorSchedule?.entries
        .filter((entry) =>
          entry.kind === "movie" &&
          entry.mediaId &&
          !entry.sourceOffsetMs &&
          entry.sourceSlotId &&
          slotMovieIds.has(entry.sourceSlotId),
        )
        .map((entry) => entry.mediaId!);
      const slotMovieAssignments = Array.isArray(storedAssignments) &&
        storedAssignments.every((id) => typeof id === "string")
        ? storedAssignments as string[]
        : priorAssignments;
      const ordinary = {
        ...input,
        movieProgramming: movieProgramming?.runtime,
        slotMovieContinuation: this.slotMovieContinuation(channel, date),
        slotMovieAssignments,
      };
      // The fallback layout has the same duration as a detected layout, so it is
      // a cheap, deterministic way to find the day's actual episode selections
      // before invoking ffmpeg. The persisted movie plan is resolved only once:
      // its occurrence ledger is idempotent, but doing so also keeps this pass a
      // pure draft rather than a second scheduling event.
      result = generateSchedule(ordinary);
      if (result.ok === false) return result;
      const episodeBreakAnalyses: Record<string, EpisodeBreakAnalysis> = {};
      const requestedEpisodeMediaIds = new Set<string>();
      // Analysis can change an episode's broadcast duration and therefore the
      // deterministic selections that follow it. Continue until every episode
      // selected by the latest pass has itself been considered for analysis.
      // Each media id is requested once, so this always terminates even when an
      // item is ineligible for analysis or the selection moves through a pool.
      for (;;) {
        const newlySelected = new Set(
          result.schedule.entries
            .filter(
              (entry) =>
                entry.kind === "episode" &&
                Boolean(entry.mediaId) &&
                !requestedEpisodeMediaIds.has(entry.mediaId!),
            )
            .map((entry) => entry.mediaId!),
        );
        if (!newlySelected.size) break;
        for (const mediaId of newlySelected)
          requestedEpisodeMediaIds.add(mediaId);
        Object.assign(
          episodeBreakAnalyses,
          await this.analyzeEpisodeBreaks(channel, newlySelected),
        );
        result = generateSchedule({ ...ordinary, episodeBreakAnalyses });
        if (result.ok === false) return result;
      }
      for (const diagnostic of movieProgramming?.diagnostics ?? [])
        result.schedule.diagnostics.push({
          code: diagnostic.code,
          message: diagnostic.message,
        });
    }
    // Both branches above returned on refusal, so there is a lineup to present.
    const lineup = result.schedule;
    // Continuity is an optional presentation pass over an already-final lineup.
    // Anything at all going wrong inside it - a corrupt setting, an unexpected
    // shape, a bug - must leave the ordinary schedule intact rather than fail
    // the generation the channel is waiting for.
    let continuity: ReturnType<typeof applyContinuityToSchedule> = {
      schedule: lineup,
      decisions: [],
      contentHash: "",
      planned: 0,
    };
    try {
      const continuityConfig = readContinuityConfig(this.repositories, channel.id);
      // Cadence reads the successful insertions other generations published, so
      // a card that will air counts before it airs - but the schedule being
      // built right now is excluded, and nothing later than the planning instant
      // can influence an earlier break.
      const history = readContinuityHistoryForPlanning(this.repositories, channel.id, {
        before: input.now.toISOString(),
        excludeScheduleRevision: lineup.id,
      });
      const adjacentSchedules = [-1, 1].flatMap((days) => {
        const adjacentDate = DateTime.fromISO(date, { zone: channel.timezone })
          .plus({ days }).toISODate();
        const adjacent = adjacentDate
          ? this.repositories.schedules.latestForDate(channel.id, adjacentDate)
          : undefined;
        return adjacent ? [adjacent] : [];
      });
      // Prepare (render + validate + register) before applying, so the pass sees
      // the cards it just produced. A failure here is just a diagnostic.
      const prepared = await this.continuityPreparer({
        repositories: this.repositories,
        channel,
        schedule: lineup,
        media: input.items,
        pools: input.pools,
        config: continuityConfig,
        history,
        adjacentSchedules,
        repoRoot: this.continuityRepoRoot,
        now: input.now,
      });
      for (const diagnostic of prepared.diagnostics)
        lineup.diagnostics.push({
          code: diagnostic.code,
          message: diagnostic.message,
        });
      continuity = applyContinuityToSchedule({
        schedule: lineup,
        media: prepared.media,
        config: continuityConfig,
        history,
        environment: {
          channel,
          pools: input.pools,
          fillerHistory: input.history,
          adjacentSchedules,
        },
      });
    } catch (error) {
      lineup.diagnostics.push({
        code: "CONTINUITY_SKIPPED",
        message: `Continuity was skipped: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
      continuity = { schedule: lineup, decisions: [], contentHash: "", planned: 0 };
    }
    const schedule = continuity.schedule;

    let exportPath: string;
    try {
      exportPath = await this.exportSchedule(
        schedule,
        join(this.dataDir, "exports"),
      );
    } catch (error) {
      throw new ScheduleExportError(
        `Could not export schedule: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    this.repositories.transaction(() => {
      // Continuity bookkeeping is optional: a corrupt or unwritable history
      // record must never roll back the ordinary schedule the channel needs.
      try {
        invalidatePlannedContinuityDecisions(
          this.repositories,
          channel.id,
          schedule.id,
        );
        for (const decision of continuity.decisions) {
          appendContinuityDecision(this.repositories, channel.id, {
            id: [schedule.id, decision.insertionInstant, decision.assetId].join(":"),
            state: "planned",
            assetId: decision.assetId,
            personaId: decision.personaId,
            ...(decision.targetAiringId
              ? { targetAiringId: decision.targetAiringId }
              : {}),
            scheduleRevision: schedule.id,
            plannedAt: input.now.toISOString(),
            cardType: decision.cardType,
            targetKey: decision.targetKey,
            family: decision.family,
          });
        }
      } catch (error) {
        schedule.diagnostics.push({
          code: "CONTINUITY_HISTORY_SKIPPED",
          message: `Continuity history was not persisted: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      }
      this.repositories.schedules.replaceSuccessful(channel.id, schedule);
      if (!preserved && channel.slots.some((slot) => slot.kind === "movie")) {
        const slotMovieIds = new Set(
          channel.slots.filter((slot) => slot.kind === "movie").map((slot) => slot.id),
        );
        const assignments = schedule.entries
          .filter((entry) =>
            entry.kind === "movie" &&
            entry.mediaId &&
            !entry.sourceOffsetMs &&
            entry.sourceSlotId &&
            slotMovieIds.has(entry.sourceSlotId),
          )
          .map((entry) => entry.mediaId!);
        this.repositories.settings.put(`slot-movie-assignments:${channel.id}:${date}`, assignments);
      }
    });
    return { ok: true, schedule, exportPath };
  }

  async ensure(channel: Channel, date: string): Promise<PersistedGeneration> {
    // Asked BY DATE. `latest` is insertion order, and the quiet-hours pass
    // stores TOMORROW's schedule, so it would answer a request for today with
    // tomorrow's lineup and never generate today's.
    const existing = this.repositories.schedules.latestForDate(
      channel.id,
      date,
    );
    if (existing) return { ok: true, schedule: existing, exportPath: "" };
    const key = `${channel.id}:${date}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const generation = this.generate(channel, date);
    this.inFlight.set(key, generation);
    try {
      return await generation;
    } finally {
      if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
    }
  }

  /**
   * The preserved-lineup day for a bound channel, or `undefined` for every other
   * channel.
   *
   * Read and built in one place so the failure modes stay distinct: a channel is
   * either bound (and then the archive is the only source of truth, present or
   * not) or it is not bound (and ordinary generation runs exactly as before).
   * There is no third path, which is what makes "fail closed" here mean refusing
   * the day rather than airing something else.
   */
  private preservedLineup(
    channel: Channel,
    date: string,
    media: readonly MediaItem[],
  ): ScheduleGenerationResult | undefined {
    const binding = channel.preservedLineup;
    if (!binding) return undefined;
    const archive = readPreservedLineup(this.repositories, binding);
    if (archive.ok === false) return { ok: false, issues: archive.issues };
    const result = buildPreservedLineupSchedule({
      channel,
      binding,
      archive: archive.archive,
      date,
      media,
      now: this.now(),
    });
    if (result.ok === false) return result;
    return { ...result, diagnostics: result.schedule.diagnostics };
  }

  /**
   * The movie plan for one date, derived from the persisted rotation and ledger.
   *
   * Everything here is idempotent by construction: occurrences already in the
   * ledger are read back, and anything newly derived is deterministic from the
   * date, the rotation order and the week's rules. Generating the same day twice,
   * previewing it, or rescanning the library therefore cannot consume or reseed
   * the rotation.
   */
  private movieRuntime(
    channel: Channel,
    date: string,
  ):
    | {
        runtime: MovieProgrammingRuntime;
        diagnostics: Array<{ code: string; message: string }>;
      }
    | undefined {
    const programming = channel.movieProgramming;
    if (!programming?.enabled) return undefined;
    const now = this.now();
    const assignment = ensureMovieOccurrencesForDate(
      this.repositories,
      channel,
      date,
      now,
    );
    if (!assignment) return undefined;
    const plan = movieProgrammingPlan({
      channel,
      date,
      occurrences: assignment.occurrences,
      continuations: this.movieContinuations(channel, date),
    });
    if (!plan) return undefined;
    return {
      runtime: {
        programming,
        airings: plan.airings,
        continuations: plan.continuations,
      },
      diagnostics: assignment.diagnostics,
    };
  }

  /**
   * The tail of a movie that crossed midnight.
   *
   * Read from yesterday's STORED schedule rather than re-derived, because the
   * only place the real start instant exists is the schedule that actually aired
   * it: soft anchors mean the feature did not necessarily begin on the minute its
   * anchor named. The carry the schedule recorded is preferred, because it also
   * remembers a double feature's unpaid closer and whether its bridge has aired -
   * neither of which the last entry would reveal.
   */
  private movieContinuations(
    channel: Channel,
    date: string,
  ): MovieContinuationPlan[] {
    const previousDate = DateTime.fromISO(date, { zone: channel.timezone })
      .minus({ days: 1 })
      .toISODate();
    if (!previousDate) return [];
    const previous = this.repositories.schedules.latestForDate(
      channel.id,
      previousDate,
    );
    if (!previous) return [];
    if (previous.movieCarry?.continuation?.slotId) return [];
    if (previous.movieCarry)
      return [
        {
          continuation: previous.movieCarry.continuation,
          pendingCloser: previous.movieCarry.closer,
        },
      ];
    const last = previous?.entries.at(-1);
    if (!last?.mediaId || last.kind !== "movie") return [];
    const item = this.repositories.media.get(last.mediaId);
    if (!item?.durationMs) return [];
    const consumedMs =
      (last.sourceOffsetMs ?? 0) + (last.contentDurationMs ?? last.durationMs);
    if (item.durationMs - consumedMs <= 0) return [];
    return [
      {
        continuation: {
          mediaId: last.mediaId,
          sourceOffsetMs: consumedMs,
          occurrenceKey: last.movieOccurrenceKey,
          role: last.movieRole,
        },
      },
    ];
  }

  /** Carry an unfinished ordinary movie-slot airing into the next date. */
  private slotMovieContinuation(
    channel: Channel,
    date: string,
  ): (NonNullable<MovieCarry["continuation"]> & { slotId: string }) | undefined {
    const previousDate = DateTime.fromISO(date, { zone: channel.timezone })
      .minus({ days: 1 })
      .toISODate();
    if (!previousDate) return undefined;
    const continuation = this.repositories.schedules.latestForDate(
      channel.id,
      previousDate,
    )?.movieCarry?.continuation;
    if (!continuation?.slotId) return undefined;
    return { ...continuation, slotId: continuation.slotId };
  }

  /**
   * Rolling movie coverage: resolve the next `lookaheadDays` of assignments and
   * extend the stored schedules one date per pass.
   *
   * Assignment is cheap and never consumes anything, so it is done for the whole
   * horizon every time. Building a full schedule is not cheap - it analyses every
   * episode - so at most one missing future day is built per pass, which fills a
   * week of coverage over the quiet hours without flooding the machine.
   */
  async ensureMovieCoverage(
    channel: Channel,
    today: Date,
  ): Promise<{ resolvedDates: string[]; generatedDate?: string }> {
    const programming = channel.movieProgramming;
    if (!programming?.enabled) return { resolvedDates: [] };
    const start = DateTime.fromJSDate(today, { zone: channel.timezone }).startOf(
      "day",
    );
    const horizon: string[] = [];
    for (let offset = 0; offset <= programming.lookaheadDays; offset += 1) {
      const date = start.plus({ days: offset }).toISODate();
      if (date) horizon.push(date);
    }
    const resolvedDates: string[] = [];
    for (const date of horizon) {
      const assignment = ensureMovieOccurrencesForDate(
        this.repositories,
        channel,
        date,
        this.now(),
      );
      if (assignment) resolvedDates.push(date);
    }
    for (const date of horizon.slice(1)) {
      if (this.repositories.schedules.latestForDate(channel.id, date)) continue;
      const generated = await this.ensure(channel, date);
      return generated.ok
        ? { resolvedDates, generatedDate: date }
        : { resolvedDates };
    }
    return { resolvedDates };
  }

  /**
   * The preview the status API and the UI read.
   *
   * Assignment only - it deliberately does not build schedules, so an operator
   * asking "what movies are coming up?" cannot make the server analyse a
   * library - and PURE: the assignments are resolved against an in-memory
   * overlay, so a preview never creates a rotation, never writes an occurrence,
   * and cannot change what generation will later air. Reading the status page
   * must not be a scheduling event.
   */
  async movieProgrammingPreview(
    channel: Channel,
    today: Date,
    isRootAvailable?: () => Promise<boolean>,
  ) {
    const programming: MovieProgramming | undefined =
      channel.movieProgramming;
    if (!programming?.enabled) return { enabled: false as const, upcoming: [] };
    const start = DateTime.fromJSDate(today, { zone: channel.timezone }).startOf(
      "day",
    );
    const startDate = start.toISODate();
    if (!startDate) return { enabled: false as const, upcoming: [] };
    const projection = openMovieProjection(this.repositories, channel, {
      date: startDate,
      now: this.now(),
    });
    const items = this.repositories.media.list();
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const degraded: string[] = [];
    const upcoming: Array<{
      date: string;
      position: string;
      role: string;
      anchor: string;
      mediaId: string;
      title: string;
      encore: boolean;
      available: boolean;
      consumes: boolean;
    }> = [];
    for (let offset = 0; offset <= programming.lookaheadDays; offset += 1) {
      const date = start.plus({ days: offset }).toISODate();
      if (!date || !projection) continue;
      const assignment = projection.resolve(date);
      if (!assignment) continue;
      for (const diagnostic of assignment.diagnostics)
        if (!degraded.includes(diagnostic.message))
          degraded.push(diagnostic.message);
      for (const occurrence of assignment.occurrences) {
        const item = itemsById.get(occurrence.mediaId);
        upcoming.push({
          date: occurrence.date,
          position: occurrence.position,
          role: occurrence.role,
          anchor: occurrence.anchor,
          mediaId: occurrence.mediaId,
          title: item?.title ?? occurrence.mediaId,
          encore: !occurrence.consumes,
          available: Boolean(item?.available && item.durationMs),
          consumes: occurrence.consumes,
        });
        if (!item)
          degraded.push(
            `Assigned movie ${occurrence.mediaId} is not in the catalog`,
          );
      }
    }
    const rotation = projection?.rotation ?? this.repositories.movieRotations.get(channel.id);
    const rootAvailable = isRootAvailable ? await isRootAvailable() : true;
    if (!rootAvailable)
      degraded.push(
        `The movie folder is not reachable; the saved inventory and rotation are preserved`,
      );
    return {
      enabled: true as const,
      poolIds: programming.poolIds,
      rootPath: programming.rootPath,
      rootAvailable,
      movieCount: rotation?.order.length ?? 0,
      rotationUpdatedAt: rotation?.updatedAt,
      lookaheadDays: programming.lookaheadDays,
      upcoming,
      degraded,
    };
  }
}
