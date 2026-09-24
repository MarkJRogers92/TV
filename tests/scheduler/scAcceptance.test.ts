/**
 * Acceptance cases SC01-SC12 (schedule, pods and continuity) from the
 * MarkTV_Autopilot_Handoff_2026-09-23 package. Case ids are named in the test
 * titles so the acceptance index can be matched to a result.
 */
import { describe, expect, test } from "vitest";
import { fillToBoundary } from "../../src/scheduler/fill.js";
import { movieFixture } from "../support/movieFixture.js";

describe("schedule acceptance (SC)", () => {
  test("SC04 a gap is filled now, contiguously, up to the boundary", () => {
    const { media } = movieFixture();
    const start = new Date("2026-09-24T10:00:00.000Z");
    const boundary = new Date("2026-09-24T10:05:00.000Z");
    const result = fillToBoundary({ start, boundary, items: media, seed: "sc04" });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]!.start).toBe(start.toISOString());
    // Contiguous: no silent hole between entries...
    for (let index = 1; index < result.entries.length; index += 1) {
      expect(result.entries[index]!.start).toBe(result.entries[index - 1]!.end);
    }
    // ...and the fill reaches the boundary rather than stopping short.
    expect(result.entries.at(-1)!.end).toBe(boundary.toISOString());
  });
});
