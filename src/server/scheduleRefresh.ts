import { DateTime } from "luxon";
import type { Channel } from "../domain/models.js";
import { logError, logInfo, logWarn } from "./logging.js";
import type { PersistedGeneration } from "./scheduleService.js";

/**
 * Keeps today's schedule existent, without anyone asking.
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
 * `ScheduleService.ensure()` looks like the right call and is not: it returns ANY
 * existing schedule for the channel without comparing the date, so against a stale
 * schedule it short-circuits and never regenerates. The date comparison is made here,
 * explicitly.
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
    readonly schedules: {
      latest: (channelId: string) => { id: string; date: string } | undefined;
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
   * Plan-and-apply the generated schedule to Tunarr. Injected rather than imported
   * so a test can observe the call without a Tunarr instance.
   */
  readonly syncToTunarr: (
    channelId: string,
    now: () => Date,
  ) => Promise<{ status: string }>;
  /**
   * The most recent recorded Tunarr sync. Reading it is what distinguishes
   * "generated" from "actually broadcast", so a failed sync gets retried.
   */
  readonly lastSync: () =>
    | { scheduleId?: string; status?: string }
    | undefined;
}

export interface ScheduleRefresh {
  /** Exposed so a test, or an operator, can drive one cycle directly. */
  refreshOnce: () => Promise<void>;
  stop: () => void;
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
      for (const channel of context.repositories.channels.list()) {
        const local = DateTime.fromJSDate(now(), { zone: channel.timezone });
        const today = local.toISODate();
        if (!today) continue;
        const tomorrow = local.plus({ days: 1 }).toISODate();

        const priorLatest = context.repositories.schedules.latest(channel.id);
        const alreadyHaveTomorrow = priorLatest?.date === tomorrow;
        let schedule = priorLatest;

        if (schedule?.date !== today) {
          logInfo("schedule.refresh", "Generating a schedule for today", {
            channelId: channel.id,
            date: today,
            previousDate: schedule?.date ?? null,
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
        const synced = dependencies.lastSync();
        if (synced?.scheduleId !== schedule?.id || synced.status !== "synced") {
          const tunarr = await dependencies.syncToTunarr(channel.id, now);
          logInfo("schedule.refresh", "Tunarr sync attempted", {
            channelId: channel.id,
            date: today,
            scheduleId: schedule?.id,
            tunarr: tunarr.status,
          });
        }

        // Tomorrow, built in the quiet hours but deliberately NOT broadcast. A
        // schedule covers one specific day, so pushing tomorrow's early would air
        // the wrong day's programming. Paying the generation cost now is what keeps
        // the midnight swap down to the sync alone.
        if (
          tomorrow &&
          !alreadyHaveTomorrow &&
          local.hour >= scheduleRefreshLimits.quietStartHour &&
          local.hour < scheduleRefreshLimits.quietEndHour
        ) {
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
