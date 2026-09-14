import { expect, test } from "vitest";
import { DateTime } from "luxon";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

test.each([
  ["2026-03-08", 23],
  ["2026-09-13", 24],
  ["2026-11-01", 25],
])("uses the real Chicago broadcast-day length on %s", (date, hours) => {
  const { channel, pools, media } = demo("America/Chicago");
  const result = generateSchedule({ channel, pools, items: media, date });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.schedule.durationMs).toBe(hours * 3_600_000);
    const { entries } = result.schedule;
    const expectedStart = DateTime.fromISO(date, { zone: "America/Chicago" })
      .startOf("day")
      .toUTC()
      .toISO();
    const expectedEnd = DateTime.fromISO(date, { zone: "America/Chicago" })
      .plus({ days: 1 })
      .startOf("day")
      .toUTC()
      .toISO();
    expect(entries[0].start).toBe(expectedStart);
    expect(entries.at(-1)!.end).toBe(expectedEnd);
    expect(
      entries
        .slice(1)
        .every((entry, index) => entry.start === entries[index].end),
    ).toBe(true);
    expect(entries.reduce((total, entry) => total + entry.durationMs, 0)).toBe(
      result.schedule.durationMs,
    );
  }
});
