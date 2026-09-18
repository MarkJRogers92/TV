import { afterEach, expect, test, vi } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import type { Channel, Schedule } from "../../src/domain/models.js";
import { logSink } from "../../src/server/logging.js";
import type { PersistedGeneration } from "../../src/server/scheduleService.js";
import {
  scheduleRefreshLimits,
  startScheduleRefresh,
  type ScheduleRefreshContext,
} from "../../src/server/scheduleRefresh.js";

const previousSink = logSink.sink;
afterEach(() => {
  logSink.sink = previousSink;
});

/** Midday in America/Chicago, so "today" is unambiguous. */
const now = () => new Date("2026-09-17T17:00:00Z");
const TODAY = "2026-09-17";

function scheduleStub(date: string): Schedule {
  return {
    id: `marktv-laughs-${date}`,
    channelId: "marktv-laughs",
    date,
    timezone: "America/Chicago",
    seed: `marktv-laughs:${date}`,
    revision: "episode-midrolls-1",
    generatedAt: "2026-09-17T05:00:00.000Z",
    durationMs: 86_400_000,
    entries: [],
    diagnostics: [],
  };
}

function setup(
  options: {
    storedDate?: string;
    generate?: (channel: Channel, date: string) => Promise<PersistedGeneration>;
    lastSync?: () => { scheduleId?: string; status?: string } | undefined;
    now?: () => Date;
  } = {},
) {
  const clock = options.now ?? now;
  const channel = demo().channel;
  // A store that can hold SEVERAL days at once, like the real table, rather than a
  // single "latest" value. The redundant-regeneration bug was invisible to a
  // one-date stub: reproducing it needs tomorrow's schedule to be able to become
  // the newest row, which is exactly what the following pass then misread.
  const stored = new Map<string, Schedule>();
  if (options.storedDate)
    stored.set(options.storedDate, scheduleStub(options.storedDate));
  const generate = vi.fn<
    (channel: Channel, date: string) => Promise<PersistedGeneration>
  >(
    options.generate ??
      (async (_channel: Channel, date: string) => {
        const schedule = scheduleStub(date);
        stored.set(date, schedule);
        return { ok: true, schedule, exportPath: "/tmp/export.json" };
      }),
  );
  const syncToTunarr = vi.fn<
    (
      channelId: string,
      scheduleId: string,
      at: () => Date,
    ) => Promise<{ status: string }>
  >(async () => ({ status: "synced" }));
  const timers = {
    setInterval: vi.fn(() => ({ unref: vi.fn() })),
    clearInterval: vi.fn(),
  };
  const context: ScheduleRefreshContext = {
    repositories: {
      channels: { list: () => [channel] },
      schedules: {
        // Asked by date: the pass needs "is TODAY scheduled?", and the newest row
        // is not always today's.
        latestForDate: (_channelId: string, date: string) => stored.get(date),
      },
    },
    schedules: { generate },
    now: clock,
  };
  const refresh = startScheduleRefresh(context, {
    timers,
    syncToTunarr,
    // Default: nothing has ever been synced, so a sync is always due.
    lastSync: options.lastSync ?? (() => undefined),
    now: clock,
  });
  return { channel, generate, syncToTunarr, timers, refresh };
}

/** Drains the fire-and-forget pass that `start` kicks off. */
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("generates today's schedule and pushes it to Tunarr when the stored one is older", async () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  const { refresh, generate, syncToTunarr } = setup({ storedDate: "2026-09-15" });

  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));

  // The date is derived in the channel's timezone, not the process's.
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({ id: "marktv-laughs" }),
    TODAY,
  );
  expect(lines.join("\n")).toContain("schedule.refresh");
  refresh.stop();
});

test("does nothing when today's schedule already exists and is live", async () => {
  const { refresh, generate, syncToTunarr } = setup({
    storedDate: TODAY,
    lastSync: () => ({ scheduleId: scheduleStub(TODAY).id, status: "synced" }),
  });

  await settle();

  // The whole point of the date comparison: a refresh must not regenerate a
  // schedule that is already correct for today and already broadcast.
  expect(generate).not.toHaveBeenCalled();
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

test("retries the sync when the previous attempt did not succeed", async () => {
  // Generating is not broadcasting. The sync's plan-then-apply guard refuses when
  // the channel state moves between its snapshots, which an active viewer causes,
  // so a failed sync must be retried rather than assumed done because a schedule
  // for today exists.
  const { refresh, generate, syncToTunarr } = setup({
    storedDate: TODAY,
    lastSync: () => ({ scheduleId: scheduleStub(TODAY).id, status: "failed" }),
  });

  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));

  expect(generate).not.toHaveBeenCalled();
  refresh.stop();
});

test("generates when no schedule has ever been stored", async () => {
  const { refresh, syncToTunarr } = setup();

  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));

  refresh.stop();
});

test("reports a refused generation as a warning and does not sync it", async () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  // Passed as the implementation rather than set afterwards: the service runs its
  // first pass during `start`, so a mock arranged later would arrive too late.
  const { refresh, syncToTunarr } = setup({
    storedDate: "2026-09-15",
    generate: async () => ({
      ok: false,
      issues: [
        { code: "INVALID_CONFIGURATION", path: "slots", message: "no slots" },
      ],
    }),
  });

  await settle();

  expect(syncToTunarr).not.toHaveBeenCalled();
  expect(lines.join("\n")).toContain("INVALID_CONFIGURATION");
  refresh.stop();
});

test("contains a generation failure instead of throwing on the timer", async () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  const { refresh, syncToTunarr } = setup({
    storedDate: "2026-09-15",
    generate: async () => {
      throw new Error("ffmpeg exploded");
    },
  });

  await settle();

  expect(lines.join("\n")).toContain("ffmpeg exploded");
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

test("overlapping passes generate only once", async () => {
  // The generation never resolves, so the first pass is still in flight when the
  // next two arrive. They must not start a second one - a generation takes minutes
  // and the interval would otherwise stack them up behind each other.
  const { refresh, generate } = setup({
    storedDate: "2026-09-15",
    generate: () => new Promise<PersistedGeneration>(() => {}),
  });

  await settle();
  await refresh.refreshOnce();
  await refresh.refreshOnce();

  expect(generate).toHaveBeenCalledTimes(1);
  refresh.stop();
});

test("pre-generates tomorrow's schedule in the quiet hours without broadcasting it", async () => {
  // 09:00Z is 04:00 in America/Chicago, inside the quiet window.
  const { refresh, generate, syncToTunarr } = setup({
    storedDate: TODAY,
    lastSync: () => ({ scheduleId: scheduleStub(TODAY).id, status: "synced" }),
    now: () => new Date("2026-09-17T09:00:00Z"),
  });

  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

  expect(generate.mock.calls[0]?.[1]).toBe("2026-09-18");
  // Not synced: a schedule covers one specific day, so pushing tomorrow's early
  // would have the channel air the wrong day's programming.
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

test("does not pre-generate outside the quiet hours", async () => {
  // 17:00Z is 12:00 in America/Chicago - the default clock in these tests.
  const { refresh, generate } = setup({
    storedDate: TODAY,
    lastSync: () => ({ scheduleId: scheduleStub(TODAY).id, status: "synced" }),
  });

  await settle();

  expect(generate).not.toHaveBeenCalled();
  refresh.stop();
});

test("does not rebuild today after pre-generating tomorrow", async () => {
  // The regression this guards is a loop, not a single bad call.
  //
  // The pre-generation below writes tomorrow's schedule, and the schedule store is
  // read by insertion order. A pass that asks "is today scheduled?" of the NEWEST
  // row therefore gets tomorrow's date back, concludes today is missing and rebuilds
  // it - which makes today newest again, so the pass after that rebuilds tomorrow.
  // On a real install that ran every ten minutes indefinitely and produced ~12
  // generations in 93 minutes, alternating between two dates.
  const { refresh, generate } = setup({
    storedDate: TODAY,
    lastSync: () => ({ scheduleId: scheduleStub(TODAY).id, status: "synced" }),
    now: () => new Date("2026-09-17T09:00:00Z"), // 04:00 local, inside the quiet window
  });

  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  await refresh.refreshOnce();
  await refresh.refreshOnce();

  // Once, for tomorrow. Any entry for today means the loop is back.
  expect(generate.mock.calls.map((call) => call[1])).toEqual(["2026-09-18"]);
  refresh.stop();
});

test("aims the sync at the day it decided about, not the newest schedule", async () => {
  // The sync resolves its target itself, so the refresh must name the schedule it
  // means. Left to the newest row, the quiet hours would have it push TOMORROW's
  // lineup over today's - the exact mistake the pre-generation comment forbids.
  const { refresh, syncToTunarr } = setup({ storedDate: "2026-09-15" });

  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));

  expect(syncToTunarr.mock.calls[0]?.[0]).toBe("marktv-laughs");
  expect(syncToTunarr.mock.calls[0]?.[1]).toBe(scheduleStub(TODAY).id);
  refresh.stop();
});

test("arms one unreferenced timer at the configured interval, and clears it on stop", () => {
  const { refresh, timers } = setup({ storedDate: TODAY });

  expect(timers.setInterval).toHaveBeenCalledTimes(1);
  expect(timers.setInterval).toHaveBeenCalledWith(
    expect.any(Function),
    scheduleRefreshLimits.intervalMs,
  );

  refresh.stop();
  expect(timers.clearInterval).toHaveBeenCalledTimes(1);
});
