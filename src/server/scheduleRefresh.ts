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
        const date = DateTime.fromJSDate(now(), {
          zone: channel.timezone,
        }).toISODate();
        if (!date) continue;

        let schedule = context.repositories.schedules.latest(channel.id);
        if (schedule?.date !== date) {
          logInfo("schedule.refresh", "Generating a schedule for today", {
            channelId: channel.id,
            date,
            previousDate: schedule?.date ?? null,
          });
          const generated = await context.schedules.generate(channel, date);
          if (generated.ok === false) {
            logWarn("schedule.refresh", "Schedule generation was refused", {
              channelId: channel.id,
              date,
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
        // Without that, a single failed sync would strand the lineup until someone
        // generated the next day's schedule.
        const synced = dependencies.lastSync();
        if (synced?.scheduleId === schedule?.id && synced.status === "synced") {
          continue;
        }

        const tunarr = await dependencies.syncToTunarr(channel.id, now);
        logInfo("schedule.refresh", "Tunarr sync attempted", {
          channelId: channel.id,
          date,
          scheduleId: schedule?.id,
          tunarr: tunarr.status,
        });
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
