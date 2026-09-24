import { afterEach, expect, test, vi } from "vitest";
import type { Channel, Schedule } from "../../src/domain/models.js";
import { logSink } from "../../src/server/logging.js";
import type { PersistedGeneration } from "../../src/server/scheduleService.js";
import {
  startScheduleRefresh,
  type ScheduleRefreshContext,
} from "../../src/server/scheduleRefresh.js";
import { movieFixture } from "../support/movieFixture.js";

const previousSink = logSink.sink;
afterEach(() => {
  logSink.sink = previousSink;
});

function scheduleStub(channel: Channel, date: string): Schedule {
  return {
    id: `${channel.id}-${date}`,
    channelId: channel.id,
    date,
    timezone: channel.timezone,
    seed: `${channel.id}:${date}`,
    revision: channel.revision,
    generatedAt: "2026-09-08T08:00:00.000Z",
    durationMs: 86_400_000,
    entries: [
      {
        id: `entry-${date}`,
        start: `${date}T05:00:00.000Z`,
        end: `${date}T05:30:00.000Z`,
        localStart: "00:00",
        localEnd: "00:30",
        durationMs: 1_800_000,
        kind: "episode",
        title: "Apartment 4B 1",
        mediaId: "apartment-4b-1",
      },
    ],
    diagnostics: [],
  };
}

function setup(options: {
  now: Date;
  enabled?: boolean;
  coverage?: () => Promise<{ resolvedDates: string[]; generatedDate?: string }>;
}) {
  const channel: Channel = movieFixture().channel;
  if (options.enabled === false) channel.movieProgramming!.enabled = false;
  const clock = () => options.now;
  const today = "2026-09-08";
  const stored = new Map<string, Schedule>([[today, scheduleStub(channel, today)]]);
  const generate = vi.fn<
    (channel: Channel, date: string) => Promise<PersistedGeneration>
  >(async (channel, date) => {
    const schedule = scheduleStub(channel, date);
    // Persist like the real service: the pass reads latestForDate between
    // generations, so a stub that forgets would regenerate the same date.
    stored.set(date, schedule);
    return { ok: true, schedule, exportPath: "" };
  });
  const syncToTunarr = vi.fn(async () => ({ status: "synced" }));
  const ensureCoverage = vi.fn<
    (
      channel: Channel,
      now: Date,
    ) => Promise<{ resolvedDates: string[]; generatedDate?: string }>
  >(
    options.coverage ??
      (async () => ({
        resolvedDates: ["2026-09-09", "2026-09-10"],
        generatedDate: "2026-09-09",
      })),
  );
  const context: ScheduleRefreshContext = {
    repositories: {
      channels: { list: () => [channel] },
      // A catalog that still agrees with the stored schedule, so the pass has no
      // stale-schedule work to do and the movie coverage is the only thing left.
      media: {
        list: () => [
          {
            id: "apartment-4b-1",
            source: "placeholder" as const,
            kind: "episode" as const,
            title: "Apartment 4B 1",
            durationMs: 1_380_000,
            durationStatus: "ok" as const,
            available: true,
            tags: [],
          },
        ],
      },
      schedules: {
        latestForDate: (_channelId: string, date: string) => stored.get(date),
        list: () => [...stored.values()],
      },
    },
    schedules: { generate },
    now: clock,
  };
  const timers = {
    setInterval: vi.fn(() => ({ unref: vi.fn() })),
    clearInterval: vi.fn(),
  };
  const refresh = startScheduleRefresh(context, {
    timers,
    now: clock,
    syncToTunarr,
    lastSync: () => ({ scheduleId: scheduleStub(channel, today).id, status: "synced" }),
    movieProgramming: { ensureCoverage },
  });
  return { refresh, generate, syncToTunarr, ensureCoverage };
}

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("movie coverage rolls forward in the quiet hours without touching the live sync", async () => {
  // 08:30Z is 03:30 in America/Chicago, inside the quiet window.
  const { refresh, ensureCoverage, syncToTunarr, generate } = setup({
    now: new Date("2026-09-08T08:30:00Z"),
  });
  await settle();
  expect(ensureCoverage).toHaveBeenCalledTimes(1);
  expect(ensureCoverage.mock.calls[0][0]).toMatchObject({ id: "marktv-laughs" });
  // Today's schedule already exists and is synced, so nothing is regenerated for
  // today and nothing is pushed again. The quiet-hours pass still builds tomorrow
  // (a generation, not a broadcast) and then the first missing horizon day.
  const generated = generate.mock.calls.map((call) => call[1]);
  expect(generated[0]).toBe("2026-09-09");
  expect(generated).not.toContain("2026-09-08");
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

test("coverage waits for the quiet hours", async () => {
  const { refresh, ensureCoverage } = setup({
    now: new Date("2026-09-08T17:00:00Z"),
  });
  await settle();
  expect(ensureCoverage).not.toHaveBeenCalled();
  refresh.stop();
});

test("a channel without movie programming never rolls coverage", async () => {
  const { refresh, ensureCoverage } = setup({
    now: new Date("2026-09-08T08:30:00Z"),
    enabled: false,
  });
  await settle();
  expect(ensureCoverage).not.toHaveBeenCalled();
  refresh.stop();
});

test("a coverage failure does not stop the pass", async () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  const { refresh } = setup({
    now: new Date("2026-09-08T08:30:00Z"),
    coverage: async () => {
      throw new Error("movie root exploded");
    },
  });
  await settle();
  expect(lines.join("\n")).toContain("movie root exploded");
  refresh.stop();
});
