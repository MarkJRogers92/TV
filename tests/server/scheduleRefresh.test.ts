import { afterEach, expect, test, vi } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import type { Channel, MediaItem, Schedule } from "../../src/domain/models.js";
import { logSink } from "../../src/server/logging.js";
import type { PersistedGeneration } from "../../src/server/scheduleService.js";
import {
  scheduleRefreshLimits,
  scheduleHasStaleMedia,
  scheduleMissesPreviousCarry,
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

function scheduleStub(
  date: string,
  entries: Schedule["entries"] = [],
): Schedule {
  return {
    id: `marktv-laughs-${date}`,
    channelId: "marktv-laughs",
    date,
    timezone: "America/Chicago",
    seed: `marktv-laughs:${date}`,
    revision: "episode-midrolls-1",
    generatedAt: "2026-09-17T05:00:00.000Z",
    durationMs: 86_400_000,
    entries,
    diagnostics: [],
  };
}

const catalogItem = (id: string, path: string): MediaItem => ({
  id,
  source: "local-folder",
  path,
  kind: "episode",
  title: id,
  durationMs: 1_380_000,
  durationStatus: "ok",
  available: true,
  tags: [],
});

/** One scheduled program referencing a media path the catalog may have moved. */
function scheduledMedia(id: string, mediaId: string, path: string) {
  return {
    id,
    start: "2026-09-17T10:00:00.000Z",
    end: "2026-09-17T10:30:00.000Z",
    localStart: "05:00",
    localEnd: "05:30",
    durationMs: 1_800_000,
    kind: "episode" as const,
    title: mediaId,
    mediaId,
    path,
  };
}

/**
 * A stored schedule whose media has since been renamed: the id is stable so a
 * test can tell the replacement apart from what it replaced.
 */
function staleSchedule(
  date: string,
  path = "/media/old/renamed.mkv",
): Schedule {
  return {
    ...scheduleStub(date, [scheduledMedia("stale-entry", "episode-1", path)]),
    id: `stale-${date}`,
  };
}

function setup(
  options: {
    storedDate?: string;
    /** Whole schedules, so a test can hold several dates and exact entries. */
    stored?: Schedule[];
    media?: MediaItem[];
    generate?: (channel: Channel, date: string) => Promise<PersistedGeneration>;
    lastSync?: () => { scheduleId?: string; status?: string } | undefined;
    now?: () => Date;
    channels?: Channel[];
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
  for (const schedule of options.stored ?? [])
    stored.set(schedule.date, schedule);
  const media = options.media ?? [];
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
      channels: { list: () => options.channels ?? [channel] },
      media: { list: () => media },
      schedules: {
        // Asked by date: the pass needs "is TODAY scheduled?", and the newest row
        // is not always today's.
        latestForDate: (_channelId: string, date: string) => stored.get(date),
        list: () => [...stored.values()],
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

test("a failed channel does not prevent the next channel from refreshing", async () => {
  const first = demo().channel;
  const second = { ...demo().channel, id: "second-channel" };
  const { refresh, generate, syncToTunarr } = setup({
    channels: [first, second],
    generate: async (channel, date) => {
      if (channel.id === first.id) throw new Error("first channel failed");
      return { ok: true, schedule: scheduleStub(date), exportPath: "/tmp/export.json" };
    },
  });

  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));
  expect(syncToTunarr.mock.calls[0]?.[0]).toBe(second.id);
  refresh.stop();
});

test("disabled channels are excluded from the automatic refresh", async () => {
  const { refresh, generate, syncToTunarr } = setup({
    channels: [{ ...demo().channel, enabled: false }],
  });
  await settle();
  expect(generate).not.toHaveBeenCalled();
  expect(syncToTunarr).not.toHaveBeenCalled();
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

test("checks and syncs each channel using its own last-sync state", async () => {
  const channel7 = demo().channel;
  const channel9 = {
    ...channel7,
    id: "marktv-cult-movies",
    name: "MarkTV Cult Movies",
    number: 9,
  };
  const schedule7 = scheduleStub(TODAY);
  const schedule9 = {
    ...scheduleStub(TODAY),
    id: "marktv-cult-movies-2026-09-17",
    channelId: channel9.id,
    channelName: channel9.name,
    channelNumber: channel9.number,
    seed: `${channel9.id}:${TODAY}`,
  };
  const schedules = new Map([
    [`${channel7.id}:${TODAY}`, schedule7],
    [`${channel9.id}:${TODAY}`, schedule9],
  ]);
  const lastSync = vi.fn((channelId: string) =>
    channelId === channel7.id
      ? { scheduleId: schedule7.id, status: "synced" }
      : undefined,
  );
  const syncToTunarr = vi.fn<
    (
      channelId: string,
      scheduleId: string,
      at: () => Date,
    ) => Promise<{ status: string }>
  >(async () => ({ status: "synced" }));
  const refresh = startScheduleRefresh(
    {
      repositories: {
        channels: { list: () => [channel7, channel9] },
        media: { list: () => [] },
        schedules: {
          latestForDate: (channelId, date) =>
            schedules.get(`${channelId}:${date}`),
          list: () => [...schedules.values()],
        },
      },
      schedules: {
        generate: async (_channel, date) => ({
          ok: true as const,
          schedule: scheduleStub(date),
          exportPath: "/tmp/export.json",
        }),
      },
      now,
    },
    {
      lastSync,
      syncToTunarr,
      now,
      timers: {
        setInterval: vi.fn(() => ({ unref: vi.fn() })),
        clearInterval: vi.fn(),
      },
    },
  );

  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));

  expect(lastSync).toHaveBeenCalledWith(channel7.id);
  expect(lastSync).toHaveBeenCalledWith(channel9.id);
  expect(syncToTunarr).toHaveBeenCalledWith(
    channel9.id,
    schedule9.id,
    expect.any(Function),
  );
  refresh.stop();
});

test("reads a stored schedule's media references against the catalog", () => {
  const catalog = [catalogItem("episode-1", "/media/new/renamed.mkv")];

  // Still current: the entry names a catalog item whose path is where it says.
  expect(
    scheduleHasStaleMedia(
      scheduleStub(TODAY, [
        scheduledMedia("entry", "episode-1", "/media/new/renamed.mkv"),
      ]),
      catalog,
    ),
  ).toBe(false);
  // Renamed: the catalog moved that media somewhere else.
  expect(
    scheduleHasStaleMedia(
      scheduleStub(TODAY, [
        scheduledMedia("entry", "episode-1", "/media/old/renamed.mkv"),
      ]),
      catalog,
    ),
  ).toBe(true);
  // Removed: the catalog no longer holds the media the entry references.
  expect(
    scheduleHasStaleMedia(
      scheduleStub(TODAY, [
        scheduledMedia("entry", "episode-2", "/media/new/renamed.mkv"),
      ]),
      catalog,
    ),
  ).toBe(true);
  // Flex holds no media at all, so it can never be stale.
  expect(
    scheduleHasStaleMedia(
      scheduleStub(TODAY, [
        {
          id: "flex-entry",
          start: "2026-09-17T10:00:00.000Z",
          end: "2026-09-17T10:30:00.000Z",
          localStart: "05:00",
          localEnd: "05:30",
          durationMs: 1_800_000,
          kind: "flex",
          title: "Flexible programming",
        },
      ]),
      catalog,
    ),
  ).toBe(false);
});

test("replaces today's stored schedule when its media no longer matches the catalog", async () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  const { refresh, generate, syncToTunarr } = setup({
    stored: [staleSchedule(TODAY)],
    media: [catalogItem("episode-1", "/media/new/renamed.mkv")],
    // The stale schedule itself was already broadcast, so a pass that failed to
    // notice the rename would find nothing to sync and leave the lineup on the
    // old path.
    lastSync: () => ({
      scheduleId: staleSchedule(TODAY).id,
      status: "synced",
    }),
  });

  await vi.waitFor(() => expect(syncToTunarr).toHaveBeenCalledTimes(1));

  expect(generate.mock.calls.map((call) => call[1])).toEqual([TODAY]);
  // The replacement, named explicitly: Tunarr still holds the old path.
  expect(syncToTunarr.mock.calls[0]?.[1]).toBe(scheduleStub(TODAY).id);
  expect(lines.join("\n")).toContain("stale");
  refresh.stop();
});

test("leaves today's stored schedule alone while its media still matches the catalog", async () => {
  const current = scheduleStub(TODAY, [
    scheduledMedia("entry", "episode-1", "/media/new/renamed.mkv"),
  ]);
  const { refresh, generate, syncToTunarr } = setup({
    stored: [current],
    media: [catalogItem("episode-1", "/media/new/renamed.mkv")],
    lastSync: () => ({ scheduleId: current.id, status: "synced" }),
  });

  await settle();

  // Regenerating an already-correct-and-synced schedule every ten minutes is the
  // loop this check must not reintroduce.
  expect(generate).not.toHaveBeenCalled();
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

test("pre-generates a replacement for a stale tomorrow in the quiet hours", async () => {
  const today = scheduleStub(TODAY, [
    scheduledMedia("entry", "episode-1", "/media/new/renamed.mkv"),
  ]);
  const { refresh, generate, syncToTunarr } = setup({
    stored: [today, staleSchedule("2026-09-18")],
    media: [catalogItem("episode-1", "/media/new/renamed.mkv")],
    lastSync: () => ({ scheduleId: today.id, status: "synced" }),
    now: () => new Date("2026-09-17T09:00:00Z"), // 04:00 local
  });

  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

  // Tomorrow is rebuilt because its media moved, and still not broadcast.
  expect(generate.mock.calls[0]?.[1]).toBe("2026-09-18");
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

/** Today, having just recorded that a feature runs past the day boundary. */
function carryingSchedule(
  generatedAt = "2026-09-17T09:00:00.000Z",
): Schedule {
  return {
    ...scheduleStub(TODAY),
    generatedAt,
    movieCarry: {
      continuation: {
        mediaId: "cult-movie-1",
        sourceOffsetMs: 2_400_000,
        slotId: "cult-movies",
      },
    },
  };
}

/** Tomorrow, opening on the carried film from the offset today recorded. */
function continuingSchedule(generatedAt = "2026-09-17T09:30:00.000Z"): Schedule {
  return {
    ...scheduleStub("2026-09-18", [
      {
        id: "continuation-entry",
        start: "2026-09-18T05:00:00.000Z",
        end: "2026-09-18T05:40:00.000Z",
        localStart: "00:00",
        localEnd: "00:40",
        durationMs: 2_400_000,
        kind: "movie" as const,
        title: "cult-movie-1",
        mediaId: "cult-movie-1",
        path: "/media/movies/Cult/cult-movie-1.mp4",
        sourceOffsetMs: 2_400_000,
      },
    ]),
    generatedAt,
  };
}

test("recognises a next day built before the carry that today now records", () => {
  // Yesterday's carry belongs to the movie-programming path and is resumed by
  // movieContinuations, so the slot path must not claim it.
  expect(
    scheduleMissesPreviousCarry(
      {
        ...carryingSchedule(),
        movieCarry: {
          continuation: { mediaId: "cult-movie-1", sourceOffsetMs: 2_400_000 },
        },
      },
      scheduleStub("2026-09-18"),
    ),
  ).toBe(false);
  // Built before today was replaced, and still opening on the wrong film.
  expect(
    scheduleMissesPreviousCarry(carryingSchedule(), scheduleStub("2026-09-18")),
  ).toBe(true);
  // Already continuing the film: nothing left to rebuild.
  expect(
    scheduleMissesPreviousCarry(carryingSchedule(), continuingSchedule()),
  ).toBe(false);
  // Built AFTER today's carry and still not opening on the film. Tomorrow is the
  // newer of the two, so there is nothing left to add - this is what stops
  // tomorrow being rebuilt every ten minutes even if a generation decides not to
  // carry the film after all.
  expect(
    scheduleMissesPreviousCarry(carryingSchedule("2026-09-17T09:00:00.000Z"), {
      ...scheduleStub("2026-09-18"),
      generatedAt: "2026-09-17T09:30:00.000Z",
    }),
  ).toBe(false);
});

test("a film that crosses midnight: tomorrow is rebuilt at midday, not left on the wrong film", async () => {
  // Midday is well outside the quiet hours. The carry airs across midnight
  // TONIGHT, so waiting for the next quiet window would be a day too late - the
  // rest of today's last feature would simply never air.
  const today = carryingSchedule();
  const { refresh, generate, syncToTunarr } = setup({
    stored: [today, scheduleStub("2026-09-18")],
    lastSync: () => ({ scheduleId: today.id, status: "synced" }),
  });

  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

  expect(generate.mock.calls[0]?.[1]).toBe("2026-09-18");
  // Rebuilt, and still not broadcast: tomorrow is not pushed early.
  expect(syncToTunarr).not.toHaveBeenCalled();
  refresh.stop();
});

test("leaves a tomorrow that already carries the film alone", async () => {
  const today = carryingSchedule();
  const tomorrow = continuingSchedule();
  const { refresh, generate, syncToTunarr } = setup({
    stored: [today, tomorrow],
    lastSync: () => ({ scheduleId: today.id, status: "synced" }),
  });

  await settle();

  expect(generate).not.toHaveBeenCalled();
  expect(syncToTunarr).not.toHaveBeenCalled();
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
