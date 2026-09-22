import { expect, test } from "vitest";
import { composeContinuityBreak } from "../../src/continuity/compose.js";

const spot = (id: string, durationMs: number) => ({
  id,
  durationMs,
  kind: "commercial" as const,
  spoken: false,
  informational: false,
});
const continuity = (
  id: string,
  durationMs: number,
  role: "next" | "return" | "station-id",
) => ({
  id,
  durationMs,
  kind: "continuity" as const,
  role,
  spoken: true,
  informational: role === "next",
});

test("replaces whole spots only, preserves exact budget, and places return last", () => {
  const original = [spot("a", 20_000), spot("b", 30_000), spot("c", 30_000), spot("d", 70_000)];
  const result = composeContinuityBreak({
    original,
    promo: continuity("next", 10_000, "next"),
    returnClip: continuity("return", 10_000, "return"),
  });
  expect(result.usedContinuity).toBe(true);
  expect(result.entries.reduce((sum, item) => sum + item.durationMs, 0)).toBe(150_000);
  expect(result.entries.at(-1)?.id).toBe("return");
  expect(result.entries.filter((item) => item.informational)).toHaveLength(1);
  expect(result.entries.filter((item) => item.spoken)).toHaveLength(2);
});

test("retains the original validated break when no exact whole-spot fit exists", () => {
  const original = [spot("a", 30_000), spot("b", 30_000), spot("c", 30_000)];
  const result = composeContinuityBreak({
    original,
    promo: continuity("next", 8_000, "next"),
    returnClip: continuity("return", 3_200, "return"),
  });
  expect(result).toEqual({ entries: original, usedContinuity: false, reason: "BREAK_BUDGET" });
});

test("drops the optional promo before a correct return when caps are exceeded", () => {
  const original = [spot("a", 10_000), spot("b", 10_000), spot("c", 30_000)];
  const result = composeContinuityBreak({
    original,
    promo: continuity("next", 15_000, "next"),
    returnClip: continuity("return", 10_000, "return"),
    existingSpokenCount: 1,
  });
  expect(result.usedContinuity).toBe(true);
  expect(result.entries.some((item) => item.id === "next")).toBe(false);
  expect(result.entries.at(-1)?.id).toBe("return");
  expect(result.entries.reduce((sum, item) => sum + item.durationMs, 0)).toBe(50_000);
});

test("counts retained continuity already present in the break caps", () => {
  const existing = continuity("existing-promo", 8_000, "next");
  const original = [existing, spot("a", 10_000), spot("b", 10_000)];
  const result = composeContinuityBreak({
    original,
    promo: continuity("new-promo", 10_000, "next"),
    returnClip: continuity("return", 10_000, "return"),
  });
  expect(result.usedContinuity).toBe(true);
  expect(result.entries.filter((item) => item.informational)).toHaveLength(1);
  expect(result.entries.filter((item) => item.kind === "continuity")).toHaveLength(2);
  expect(result.entries.at(-1)?.id).toBe("return");
});

test("replaces existing continuity before an equal-duration commercial", () => {
  const original = [
    spot("commercial", 15_000),
    continuity("old-promo", 15_000, "next"),
  ];
  const result = composeContinuityBreak({
    original,
    promo: continuity("new-promo", 15_000, "next"),
  });

  expect(result.usedContinuity).toBe(true);
  expect(result.entries.map((entry) => entry.id)).toEqual([
    "commercial",
    "new-promo",
  ]);
  expect(result.entries.reduce((sum, item) => sum + item.durationMs, 0)).toBe(
    30_000,
  );
});

test("keeps commercials in the majority when several whole-item swaps fit", () => {
  const original = [
    { id: "old-promo", durationMs: 30_000, kind: "continuity" as const, role: "next" as const, spoken: true, informational: true },
    spot("ad-1", 20_000),
    spot("ad-2", 10_000),
  ];
  // Both an existing 30s promo and a pair of commercials can be given up for the
  // exact same duration; the pair has to survive so commercials stay the bulk of
  // the break.
  const result = composeContinuityBreak({
    original,
    promo: continuity("new-promo", 30_000, "next"),
    maximumContinuityMs: 40_000,
  });
  expect(result.usedContinuity).toBe(true);
  expect(result.entries.map((entry) => entry.id)).toEqual(["ad-1", "ad-2", "new-promo"]);
  expect(result.entries.reduce((sum, item) => sum + item.durationMs, 0)).toBe(60_000);
});
