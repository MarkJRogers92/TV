import { DateTime } from "luxon";
import type { Channel, MediaItem, Schedule } from "../domain/models.js";
import { logError, logInfo, logWarn } from "./logging.js";
import type { PersistedGeneration } from "./scheduleService.js";

/**
 * Keeps today's schedule existent and current, without anyone asking.
 *
 * WHY THIS EXISTS
 * Nothing regenerated schedules. The only path was `POST /api/v1/schedules/generate`,
 * so a channel would replay the same stored lineup - the same commercials in the same
 * order - until a person pressed the button. On this install that had been running for
 * days, and bumpers added to the library in the meantime could never appear, because
 * the lineup they would have to appear in was generated before they existed.
 *
 * It also cannot be a request: generation analyses every episode with ffmpeg before it
 * can build a schedule, which takes minutes. A request that long times out, which is
 * exactly what happened when it was tried by hand - the client gave up and no schedule
 * was produced. Running on a timer makes being slow survivable.
 *
 * `ScheduleService.ensure()` looks like the right call and is not. It asks by date
 * now, but a schedule can exist for today and still be wrong: the files it refers to
 * may have been renamed since it was generated, and Tunarr refuses a lineup whose
 * programs it cannot play. Both comparisons are made here, explicitly, and a stored
 * schedule whose media no longer matches the catalog is replaced for the same date.
 *
 * Deliberately takes a narrow context rather than the whole `ServerContext`, and takes
 * the Tunarr sync as a dependency, so the whole thing is exercisable without a running
 * Tunarr or a real database.
 */

/** How often to look for a channel with no schedule for today. */
export const scheduleRefreshLimits = {
  intervalMs: 10 * 60_000,
  /**
   * Local hours during which TOMORROW's schedule is built ahead of time.
   *
   * Generation is the slow part - ffmpeg runs over every episode - and the sync is
   * the disruptive part, because replacing the lineup interrupts whoever is
   * watching. Building tomorrow in advance means the day boundary costs only the
   * sync, instead of a generation that can take minutes. Chosen to sit well inside
   * the quietest hours for a channel whose dayparts start in the morning.
   */
  quietStartHour: 3,
  quietEndHour: 5,
};

type RefreshTimer = { unref?: () => void };

export interface ScheduleRefreshTimers {
  setInterval: (callback: () => void, milliseconds: number) => RefreshTimer;
  clearInterval: (timer: RefreshTimer) => void;
}

const defaultTimers: ScheduleRefreshTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) =>
    clearInterval(timer as ReturnType<typeof setInterval>),
};

export interface ScheduleRefreshContext {
  readonly repositories: {
    readonly channels: { list: () => Channel[] };
    /**
     * The current media catalog, so a stored schedule can be checked against it.
     *
     * Taken as a narrow reader rather than the whole `Repositories`, like the
     * rest of this context: the refresh only ever asks what media exists now.
     */
    readonly media: { list: () => MediaItem[] };
    readonly schedules: {
      /**
       * Looked up BY DATE, deliberately not by `latest`.
       *
       * `latest` is insertion-ordered, and the quiet-hours pass at the bottom of
       * this file writes TOMORROW's schedule into the same table - which moves
       * `latest` off today. Asking "is today scheduled?" with `latest` therefore
       * answers about tomorrow, and the pass rebuilds today: the regeneration and
       * the pre-generation then flip `latest` back and forth forever, every tick.
       */
      latestForDate: (
        channelId: string,
        date: string,
      ) => Schedule | undefined;
    };
  };
  readonly schedules: {
    generate: (channel: Channel, date: string) => Promise<PersistedGeneration>;
  };
  readonly now: () => Date;
}

export interface ScheduleRefreshDependencies {
  readonly timers?: ScheduleRefreshTimers;
  readonly now?: () => Date;
  /**
   * Plan-and-apply one specific schedule to Tunarr. Injected rather than imported
   * so a test can observe the call without a Tunarr instance.
   *
   * The schedule's id is a required argument because the sync otherwise resolves
   * the newest stored schedule, and during the quiet hours that is tomorrow's -
   * pushing it would air the wrong day's programming today.
   */
  readonly syncToTunarr: (
    channelId: string,
    scheduleId: string,
    now: () => Date,
  ) => Promise<{ status: string }>;
  /**
   * The most recent recorded Tunarr sync. Reading it is what distinguishes
   * "generated" from "actually broadcast", so a failed sync gets retried.
   */
  readonly lastSync: (channelId: string) =>
    | { scheduleId?: string; status?: string }
    | undefined;
  /**
   * Rolls the movie-programming feature's coverage forward.
   *
   * Optional so a test that does not exercise movies needs no stub, and narrow so
   * the refresh keeps knowing nothing about rotation persistence.
   */
  readonly movieProgramming?: {
    ensureCoverage: (
      channel: Channel,
      now: Date,
    ) => Promise<{ resolvedDates: string[]; generatedDate?: string }>;
  };
}

export interface ScheduleRefresh {
  /** Exposed so a test, or an operator, can drive one cycle directly. */
  refreshOnce: () => Promise<void>;
  stop: () => void;
}

/**
 * Whether a stored schedule still refers to the media the catalog holds now.
 *
 * The quiet-hours pass builds TOMORROW's schedule hours before it airs, so
 * anything that moves a file in the meantime - a rename, a re-import, an edited
 * media record - leaves that stored schedule pointing at a path the catalog no
 * longer has. Tunarr refuses the resulting plan, and the channel keeps replaying
 * whatever it was already broadcasting, so the day never picks up its new
 * lineup. This is how the refresh notices.
 *
 * Compared against the catalog rather than the filesystem, deliberately. A
 * schedule that disagrees with the catalog can always be replaced by generating
 * from it again, so this check cannot call the same schedule stale forever;
 * asking the filesystem could, and this runs every ten minutes.
 */
export function scheduleHasStaleMedia(
  schedule: Schedule,
  media: MediaItem[],
): boolean {
  const byId = new Map(media.map((item) => [item.id, item]));
  return schedule.entries.some((entry) => {
    if (entry.kind === "flex") return false;
    const item = entry.mediaId ? byId.get(entry.mediaId) : undefined;
    return !item || item.path !== entry.path;
  });
}

/**
 * Whether a stored schedule for the NEXT date was built before the carry the
 * PREVIOUS date now records.
 *
 * A feature that runs past midnight is written down on the schedule that owned
 * the airing and resumed by the next day, but only the next day can start with
 * it. The quiet-hours pass builds tomorrow BEFORE today's own replacement runs,
 * so a today that was rebuilt afterwards - because its media changed, or because
 * it only just crossed midnight - leaves tomorrow opening on the wrong film and
 * the tail of today's last feature is never aired at all.
 *
 * The `generatedAt` comparison is what stops this rebuilding tomorrow forever:
 * once tomorrow has been generated against today's carry, tomorrow is the newer
 * of the two and this is false again, whatever the generation happened to
 * decide. A carry with no `slotId` belongs to the movie-programming path, which
 * resumes its own features through `movieContinuations` instead.
 */
export function scheduleMissesPreviousCarry(
  previous: Schedule,
  next: Schedule,
): boolean {
  const continuation = previous.movieCarry?.continuation;
  if (!continuation?.slotId) return false;
  if (Date.parse(previous.generatedAt) <= Date.parse(next.generatedAt))
    return false;
  return !next.entries.some(
    (entry) =>
      entry.mediaId === continuation.mediaId &&
      (entry.sourceOffsetMs ?? 0) > 0,
  );
}

export function startScheduleRefresh(
  context: ScheduleRefreshContext,
  dependencies: ScheduleRefreshDependencies,
): ScheduleRefresh {
  const timers = dependencies.timers ?? defaultTimers;
  const now = dependencies.now ?? context.now;
  // Single-flight. A generation takes minutes and the interval keeps ticking, so
  // without this guard every tick would start another one behind the first.
  let refreshing = false;
  let timer: RefreshTimer | null = null;

  async function refreshOnce(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      // Read once per pass: every channel is checked against the same catalog.
      const media = context.repositories.media.list();
      for (const channel of context.repositories.channels.list()) {
        if (!channel.enabled) continue;
        try {
          const local = DateTime.fromJSDate(now(), { zone: channel.timezone });
          const today = local.toISODate();
          if (!today) continue;
          const tomorrow = local.plus({ days: 1 }).toISODate();

          // Both questions are asked by date. Asking them of the newest row instead
          // is what made this loop regenerate work it already had: the pre-generation
          // below inserts a row dated tomorrow, which is then the newest row, so a
          // "newest row is not today" test is true on every subsequent pass.
          let schedule = context.repositories.schedules.latestForDate(
            channel.id,
            today,
          );
          const storedTomorrow = tomorrow
            ? context.repositories.schedules.latestForDate(channel.id, tomorrow)
            : undefined;

          // A schedule for today that no longer matches the catalog is not a
          // schedule for today. Regenerating for the SAME date is what replaces
          // it; the stored one is dropped here so the generation below runs and
          // the sync is aimed at the replacement rather than the stale row.
          if (schedule && scheduleHasStaleMedia(schedule, media)) {
            logWarn("schedule.refresh", "Replacing a stale schedule", {
              channelId: channel.id,
              date: today,
              scheduleId: schedule.id,
            });
            schedule = undefined;
          }

          if (!schedule) {
            logInfo("schedule.refresh", "Generating a schedule for today", {
              channelId: channel.id,
              date: today,
            });
            const generated = await context.schedules.generate(channel, today);
            if (generated.ok === false) {
              logWarn("schedule.refresh", "Schedule generation was refused", {
                channelId: channel.id,
                date: today,
                issues: generated.issues.map((issue) =>
                  "code" in issue ? issue.code : "unknown",
                ),
              });
              continue;
            }
            schedule = generated.schedule;
          }

          // Having a schedule for today does NOT mean Tunarr has it. The sync is a
          // separate step, and its plan-then-apply guard refuses when the channel's
          // state moved between its two snapshots - which is exactly what an active
          // viewer causes. So this keeps retrying until the sync for THIS schedule
          // is recorded as synced, instead of assuming that generating was enough.
          // Without that, one failed sync would strand the lineup until the next day.
          const synced = dependencies.lastSync(channel.id);
          if (synced?.scheduleId !== schedule.id || synced.status !== "synced") {
            // The id is passed rather than letting the sync resolve "the newest
            // schedule" for itself: in the quiet hours the newest is tomorrow's, and
            // pushing that would air the wrong day.
            const tunarr = await dependencies.syncToTunarr(
              channel.id,
              schedule.id,
              now,
            );
            logInfo("schedule.refresh", "Tunarr sync attempted", {
              channelId: channel.id,
              date: today,
              scheduleId: schedule.id,
              tunarr: tunarr.status,
            });
          }

          // Tomorrow, built in the quiet hours but deliberately NOT broadcast. A
          // schedule covers one specific day, so pushing tomorrow's early would air
          // the wrong day's programming. Paying the generation cost now is what keeps
          // the midnight swap down to the sync alone.
          //
          // A pre-generated tomorrow that no longer matches the catalog is rebuilt
          // for the same reason today's is: it is cheaper now than at midnight,
          // and it is still not broadcast.
          //
          // A tomorrow that predates today's movie carry is the same kind of wrong,
          // and is rebuilt even outside the quiet hours. Unlike staleness it cannot
          // wait for the next quiet window: the carry is a film that airs across
          // midnight TONIGHT, so by then tomorrow is already on air. One generation
          // is the cost, and the alternative is that the rest of today's last
          // feature is never aired.
          const carryGap =
            tomorrow && storedTomorrow
              ? scheduleMissesPreviousCarry(schedule, storedTomorrow)
              : false;
          if (
            tomorrow &&
            (!storedTomorrow ||
              scheduleHasStaleMedia(storedTomorrow, media) ||
              carryGap) &&
            (carryGap ||
              (local.hour >= scheduleRefreshLimits.quietStartHour &&
                local.hour < scheduleRefreshLimits.quietEndHour))
          ) {
            if (storedTomorrow)
              logWarn(
                "schedule.refresh",
                carryGap
                  ? "Rebuilding a schedule that predates today's movie carry"
                  : "Replacing a stale pre-generated schedule",
                {
                  channelId: channel.id,
                  date: tomorrow,
                  scheduleId: storedTomorrow.id,
                },
              );
            logInfo("schedule.refresh", "Pre-generating tomorrow's schedule", {
              channelId: channel.id,
              date: tomorrow,
            });
            const ahead = await context.schedules.generate(channel, tomorrow);
            if (ahead.ok === false) {
              logWarn("schedule.refresh", "Pre-generation was refused", {
                channelId: channel.id,
                date: tomorrow,
                issues: ahead.issues.map((issue) =>
                  "code" in issue ? issue.code : "unknown",
                ),
              });
            }
          }

          // Movie coverage rolls forward in the quiet hours too, and only here: it
          // resolves a week or more of assignments (cheap and idempotent) and builds
          // at most one missing future schedule per pass. Nothing about it touches
          // the live date, and the sync above still aims at today's id alone.
          if (
            channel.movieProgramming?.enabled &&
            dependencies.movieProgramming &&
            local.hour >= scheduleRefreshLimits.quietStartHour &&
            local.hour < scheduleRefreshLimits.quietEndHour
          ) {
            try {
              const coverage = await dependencies.movieProgramming.ensureCoverage(
                channel,
                now(),
              );
              logInfo("schedule.refresh", "Movie coverage rolled forward", {
                channelId: channel.id,
                resolved: coverage.resolvedDates.length,
                generated: coverage.generatedDate,
              });
            } catch (error) {
              // Contained here rather than left to the pass-level catch: one
              // channel's movie inventory must not stop every other channel's
              // refresh.
              logError("schedule.refresh.movies", error, {
                channelId: channel.id,
              });
            }
          }
        } catch (error) {
          // A bad catalog entry, failed generation, or Tunarr error on one
          // channel must not keep the other channels from refreshing.
          logError("schedule.refresh.channel", error, { channelId: channel.id });
        }
      }
    } catch (error) {
      // Never rethrow: this runs on a timer, where a throw has nowhere to go and
      // would silently stop every future refresh.
      logError("schedule.refresh", error);
    } finally {
      refreshing = false;
    }
  }

  // Immediately, because a stale schedule is audible right now. When today's
  // schedule already exists this first pass costs a single indexed read.
  void refreshOnce();
  timer = timers.setInterval(
    () => void refreshOnce(),
    scheduleRefreshLimits.intervalMs,
  );
  timer.unref?.();

  return {
    refreshOnce,
    stop() {
      if (!timer) return;
      timers.clearInterval(timer);
      timer = null;
    },
  };
}
