import { expect, test } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

test("does not apply a Monday-only rule on Sunday", () => {
  const { channel, pools, media } = demo("America/Chicago");
  channel.slots = [
    {
      id: "monday",
      days: [1],
      time: "09:00",
      poolIds: ["apartment-4b"],
      kind: "episode",
      fallbackPoolIds: [],
    },
  ];
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-13",
  });
  expect(
    result.ok &&
      result.schedule.entries.some((entry) => entry.source === "monday"),
  ).toBe(false);
});

test("uses higher priority daypart and supports overnight ranges", () => {
  const { channel, pools, media } = demo("America/Chicago");
  channel.dayparts = [
    {
      id: "overnight",
      name: "overnight",
      days: [1],
      start: "22:00",
      end: "06:00",
      priority: 3,
    },
    {
      id: "low",
      name: "low",
      days: [1],
      start: "00:00",
      end: "23:59",
      priority: 1,
    },
  ];
  channel.slots = [
    {
      id: "overnight-rule",
      daypartId: "overnight",
      days: [],
      poolIds: ["apartment-4b"],
      kind: "episode",
      fallbackPoolIds: [],
    },
    {
      id: "low-rule",
      daypartId: "low",
      days: [],
      poolIds: ["apartment-4b"],
      kind: "episode",
      fallbackPoolIds: [],
    },
  ];
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-15",
  });
  expect(
    result.ok &&
      result.schedule.entries.find((entry) => entry.localStart === "00:00")
        ?.source,
  ).toBe("overnight-rule");
});

test("does not use a commercial from a filler pool whose declared kind is movie", () => {
  const { channel, pools, media } = demo("America/Chicago");
  pools.push({
    id: "bad-filler",
    name: "Misconfigured filler",
    kinds: ["movie"],
    mediaIds: ["ad-1"],
    mode: "shuffle",
    noRepeatMinutes: 0,
    weight: 1,
  });
  channel.breakPolicy.poolIds = ["bad-filler"];
  const result = generateSchedule({
    channel,
    pools,
    items: media,
    date: "2026-09-18",
  });
  expect(
    result.ok &&
      result.schedule.entries.some((entry) => entry.mediaId === "ad-1"),
  ).toBe(false);
});
