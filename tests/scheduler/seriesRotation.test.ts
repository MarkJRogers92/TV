import { expect, test } from "vitest";
import { generateSchedule } from "../../src/scheduler/generate.js";
import type { Channel, MediaItem, Pool, ScheduleEntry } from "../../src/domain/models.js";

/**
 * Three episode pools with no cooldown, so every pool always has a candidate.
 * That is the condition under which the seeded pool choice used to be free to
 * land on one series repeatedly -- a two-hour block of the same show, which no
 * amount of pool ordering could prevent because equal weights make order
 * meaningless.
 */
function fixture(poolIds: string[] = ["a", "b", "c"]) {
  const shows = { a: "Show A", b: "Show B", c: "Show C" } as Record<string, string>;
  const items: MediaItem[] = [];
  const pools: Pool[] = poolIds.map((id) => {
    const mediaIds = Array.from({ length: 20 }, (_, index) => `${id}-e${index + 1}`);
    mediaIds.forEach((mediaId, index) =>
      items.push({
        id: mediaId,
        source: "local-folder",
        path: `/media/${mediaId}.mkv`,
        kind: "episode",
        title: `Episode ${index + 1}`,
        showTitle: shows[id],
        season: 1,
        episode: index + 1,
        durationMs: 1_320_000,
        durationStatus: "ok",
        available: true,
        tags: [],
      }),
    );
    return {
      id,
      name: shows[id],
      kinds: ["episode" as const],
      mediaIds,
      mode: "chronological" as const,
      noRepeatMinutes: 0,
      weight: 1,
    };
  });
  const channel: Channel = {
    id: "channel",
    name: "Channel",
    number: 1,
    timezone: "UTC",
    enabled: true,
    revision: "1",
    dayparts: [
      { id: "daypart", name: "Daypart", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "06:00", priority: 1 },
    ],
    slots: [
      { id: "slot", daypartId: "daypart", days: [], poolIds, kind: "episode", fallbackPoolIds: [] },
    ],
    breakPolicy: { boundaryMinutes: 30, poolIds: [], stationIdPoolIds: [], cooldownMinutes: 120 },
  };
  return { channel, pools, items };
}

const showsOf = (entries: ScheduleEntry[], items: MediaItem[]) => {
  const byId = new Map(items.map((item) => [item.id, item]));
  return entries
    .filter((entry) => entry.kind === "episode" && entry.mediaId)
    .map((entry) => byId.get(entry.mediaId!)?.showTitle);
};

test("never schedules the same series twice in a row while another pool can fill the slot", () => {
  const { channel, pools, items } = fixture();
  const result = generateSchedule({
    channel,
    pools,
    items,
    date: "2026-09-15",
    now: new Date("2026-09-14T12:00:00.000Z"),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const shows = showsOf(result.schedule.entries, items);
  expect(shows.length).toBeGreaterThan(6);
  const repeats = shows.filter((show, index) => index > 0 && show === shows[index - 1]);
  expect(repeats).toEqual([]);
});

test("still repeats a series when it is the only pool that can fill the slot", () => {
  const { channel, pools, items } = fixture(["a"]);
  const result = generateSchedule({
    channel,
    pools,
    items,
    date: "2026-09-15",
    now: new Date("2026-09-14T12:00:00.000Z"),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const shows = showsOf(result.schedule.entries, items);
  // The rule must not starve a slot: with one pool there is nowhere else to go.
  expect(shows.length).toBeGreaterThan(6);
  expect(shows.every((show) => show === "Show A")).toBe(true);
});
