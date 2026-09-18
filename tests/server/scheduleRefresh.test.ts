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
  } = {},
) {
  const channel = demo().channel;
  const generate = vi.fn<
    (channel: Channel, date: string) => Promise<PersistedGeneration>
  >(
    options.generate ??
      (async () => ({
        ok: true,
        schedule: scheduleStub(TODAY),
        exportPath: "/tmp/export.json",
      })),
  );
  const syncToTunarr = vi.fn(async () => ({ status: "synced" }));
  const timers = {
    setInterval: vi.fn(() => ({ unref: vi.fn() })),
    clearInterval: vi.fn(),
  };
  const context: ScheduleRefreshContext = {
    repositories: {
      channels: { list: () => [channel] },
      schedules: {
        latest: () =>
          options.storedDate ? { date: options.storedDate } : undefined,
      },
    },
    schedules: { generate },
    now,
  };
  const refresh = startScheduleRefresh(context, { timers, syncToTunarr, now });
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

test("does nothing when today's schedule already exists", async () => {
  const { refresh, generate, syncToTunarr } = setup({ storedDate: TODAY });

  await settle();

  // The whole point of the date comparison: a refresh must not regenerate a
  // schedule that is already correct for today.
  expect(generate).not.toHaveBeenCalled();
  expect(syncToTunarr).not.toHaveBeenCalled();
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
