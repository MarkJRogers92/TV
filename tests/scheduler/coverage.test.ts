import { describe, expect, test } from "vitest";
import type { Schedule } from "../../src/domain/models.js";
import { assessCoverage, newestByDate } from "../../src/scheduler/coverage.js";

function schedule(
  date: string,
  generatedAt: string,
  entries: Array<[string, string]>,
): Schedule {
  return {
    date,
    generatedAt,
    entries: entries.map(([start, end]) => ({
      start,
      end,
      durationMs: Date.parse(end) - Date.parse(start),
    })),
  } as unknown as Schedule;
}

const DAY = 24 * 60 * 60 * 1000;

describe("schedule coverage", () => {
  test("two contiguous broadcast days cover the window exactly", () => {
    const schedules = [
      schedule("2026-09-24", "2026-09-24T00:00:00.000Z", [
        ["2026-09-24T00:00:00.000Z", "2026-09-24T12:00:00.000Z"],
        ["2026-09-24T12:00:00.000Z", "2026-09-25T00:00:00.000Z"],
      ]),
      schedule("2026-09-25", "2026-09-25T00:00:00.000Z", [
        ["2026-09-25T00:00:00.000Z", "2026-09-26T00:00:00.000Z"],
      ]),
    ];
    const coverage = assessCoverage(schedules, {
      startMs: Date.parse("2026-09-24T00:00:00.000Z"),
      endMs: Date.parse("2026-09-26T00:00:00.000Z"),
    });
    expect(coverage.contiguous).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.coveredMs).toBe(2 * DAY);
    expect(coverage.coverageStartMs).toBe(Date.parse("2026-09-24T00:00:00.000Z"));
    expect(coverage.coverageEndMs).toBe(Date.parse("2026-09-26T00:00:00.000Z"));
  });

  test("a missing broadcast day is reported as a gap", () => {
    const schedules = [
      schedule("2026-09-24", "2026-09-24T00:00:00.000Z", [
        ["2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z"],
      ]),
    ];
    const coverage = assessCoverage(schedules, {
      startMs: Date.parse("2026-09-24T00:00:00.000Z"),
      endMs: Date.parse("2026-09-26T00:00:00.000Z"),
    });
    expect(coverage.contiguous).toBe(false);
    expect(coverage.gaps).toEqual([
      { fromMs: Date.parse("2026-09-25T00:00:00.000Z"), toMs: Date.parse("2026-09-26T00:00:00.000Z") },
    ]);
  });

  test("a window wider than coverage reports leading and trailing gaps", () => {
    const schedules = [
      schedule("2026-09-24", "2026-09-24T00:00:00.000Z", [
        ["2026-09-24T06:00:00.000Z", "2026-09-24T18:00:00.000Z"],
      ]),
    ];
    const coverage = assessCoverage(schedules, {
      startMs: Date.parse("2026-09-24T00:00:00.000Z"),
      endMs: Date.parse("2026-09-25T00:00:00.000Z"),
    });
    expect(coverage.gaps).toEqual([
      { fromMs: Date.parse("2026-09-24T00:00:00.000Z"), toMs: Date.parse("2026-09-24T06:00:00.000Z") },
      { fromMs: Date.parse("2026-09-24T18:00:00.000Z"), toMs: Date.parse("2026-09-25T00:00:00.000Z") },
    ]);
    expect(coverage.coveredMs).toBe(12 * 60 * 60 * 1000);
  });

  test("overlapping entries are counted and defeat contiguity", () => {
    const schedules = [
      schedule("2026-09-24", "2026-09-24T00:00:00.000Z", [
        ["2026-09-24T00:00:00.000Z", "2026-09-24T14:00:00.000Z"],
        ["2026-09-24T12:00:00.000Z", "2026-09-25T00:00:00.000Z"],
      ]),
    ];
    const coverage = assessCoverage(schedules, {
      startMs: Date.parse("2026-09-24T00:00:00.000Z"),
      endMs: Date.parse("2026-09-25T00:00:00.000Z"),
    });
    expect(coverage.overlaps).toBe(1);
    expect(coverage.contiguous).toBe(false);
  });

  test("only the newest generation per date is measured", () => {
    const older = schedule("2026-09-24", "2026-09-24T00:00:00.000Z", [
      ["2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z"],
    ]);
    // A rebuild that lost the morning: the newest generation must win.
    const newer = schedule("2026-09-24", "2026-09-24T10:00:00.000Z", [
      ["2026-09-24T06:00:00.000Z", "2026-09-25T00:00:00.000Z"],
    ]);
    expect(newestByDate([older, newer])).toEqual([newer]);
    const coverage = assessCoverage([older, newer], {
      startMs: Date.parse("2026-09-24T00:00:00.000Z"),
      endMs: Date.parse("2026-09-25T00:00:00.000Z"),
    });
    expect(coverage.gaps).toEqual([
      { fromMs: Date.parse("2026-09-24T00:00:00.000Z"), toMs: Date.parse("2026-09-24T06:00:00.000Z") },
    ]);
  });

  test("[SC01] a 72-hour horizon covers with no gaps, overlaps or zero-length entries", () => {
    const schedules = [
      schedule("2026-09-24", "2026-09-24T00:00:00.000Z", [
        ["2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z"],
      ]),
      schedule("2026-09-25", "2026-09-25T00:00:00.000Z", [
        ["2026-09-25T00:00:00.000Z", "2026-09-26T00:00:00.000Z"],
      ]),
      schedule("2026-09-26", "2026-09-26T00:00:00.000Z", [
        ["2026-09-26T00:00:00.000Z", "2026-09-27T00:00:00.000Z"],
      ]),
    ];
    const coverage = assessCoverage(schedules, {
      startMs: Date.parse("2026-09-24T00:00:00.000Z"),
      endMs: Date.parse("2026-09-27T00:00:00.000Z"),
    });
    expect(coverage.contiguous).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.overlaps).toBe(0);
    expect(coverage.coveredMs).toBe(3 * DAY);
  });
});
