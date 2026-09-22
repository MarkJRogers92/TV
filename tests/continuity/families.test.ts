import { expect, test } from "vitest";
import {
  applyFamilyStyle,
  candidateFamilies,
  familiesForCardType,
  selectFamily,
  templateForCardType,
} from "../../src/continuity/families.js";
import { continuityFamilies } from "../../src/continuity/types.js";

test("each card class maps to an approved template and a known family set", () => {
  expect(templateForCardType).toEqual({
    next: "next",
    "next-later": "next-later",
    tonight: "tonight",
    weekend: "weekend",
    "after-dark": "after-dark",
  });
  for (const families of Object.values(familiesForCardType))
    for (const family of families) expect(continuityFamilies).toContain(family);
});

test("adds the overnight family after midnight without replacing the daypart family", () => {
  expect(candidateFamilies("next", false)).toEqual(["syndication", "local-cable"]);
  expect(candidateFamilies("next", true)).toEqual([
    "syndication",
    "local-cable",
    "overnight",
  ]);
  expect(candidateFamilies("after-dark", true)).toEqual(["overnight"]);
});

test("deprioritises a recently used family but never bans it", () => {
  expect(selectFamily("next", "seed", ["syndication"])).toBe("local-cable");
  expect(selectFamily("next", "seed", ["local-cable"])).toBe("syndication");
  // Both alternates recently used: the least-recent one still comes back.
  expect(selectFamily("next", "seed", ["local-cable", "syndication"])).toBe("syndication");
  for (let index = 0; index < 8; index += 1)
    expect(selectFamily("next", `seed-${index}`, ["syndication"])).toBe("local-cable");
});

test("family styling only adds an accent band and keeps the rendered copy", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>NEXT Night Court</text></svg>';
  const styled = applyFamilyStyle(svg, "prime-time");
  expect(styled).toContain('data-continuity-family="prime-time"');
  expect(styled).toContain("<text>NEXT Night Court</text>");
  expect(styled.startsWith("<svg")).toBe(true);
});
