import { expect, test } from "vitest";
import {
  splicePreservedLineup,
  assertPreservedMovies,
} from "../../src/integrations/tunarr/preserveLineup.js";
const content = (id: string, duration: number, startOffsetMs = 0) => ({
  type: "content" as const,
  id,
  duration,
  startOffsetMs,
});

test("replaces only one window, retaining the full future lineup and clipped movie offsets", () => {
  const original = [
    content("a", 100),
    content("ad", 20),
    content("b", 100),
    content("future", 500),
  ];
  const replacement = [
    content("a", 50, 50),
    content("card", 5),
    content("ad", 15),
    content("b", 30),
  ];
  const result = splicePreservedLineup(original, 1000, 1050, replacement);
  expect(result).toEqual([
    content("a", 50),
    ...replacement,
    content("b", 70, 30),
    content("future", 500),
  ]);
  expect(result.reduce((sum, item) => sum + item.duration, 0)).toBe(720);
});

test("does not accumulate fractional rounding into future movie starts", () => {
  const original = [
    content("ad", 30.267),
    content("movie", 100),
    content("ad", 20.543),
    content("future", 100),
  ];
  const result = splicePreservedLineup(original, 0, 31, [
    content("movie", 99, 0.733),
  ]);
  expect(result.at(-1)).toEqual(original.at(-1));
  expect(
    result.slice(0, -1).reduce((s, item) => s + item.duration, 0),
  ).toBeCloseTo(150.81, 8);
  expect(result.reduce((s, item) => s + item.duration, 0)).toBeCloseTo(
    250.81,
    8,
  );
});

test("rejects missing coverage and invalid durations without changing original", () => {
  const original = [content("movie", 100)];
  expect(() =>
    splicePreservedLineup(original, 0, 90, [content("next", 20)]),
  ).toThrow();
  expect(() =>
    splicePreservedLineup(original, 0, -1, [content("next", 20)]),
  ).toThrow();
  expect(() =>
    splicePreservedLineup(original, 0, 0, [content("next", NaN)]),
  ).toThrow();
  expect(original).toEqual([content("movie", 100)]);
});

test("refuses a changed movie order, time, or source offset", () => {
  const original = [content("a", 100), content("ad", 20), content("b", 100)];
  const ids = new Set(["a", "b"]);
  const replacement = [
    content("a", 50, 50),
    content("card", 20),
    content("b", 30),
  ];
  expect(() =>
    assertPreservedMovies(original, 50, replacement, ids),
  ).not.toThrow();
  expect(() =>
    assertPreservedMovies(original, 50, [content("b", 100)], ids),
  ).toThrow();
  expect(() =>
    assertPreservedMovies(
      original,
      50,
      [content("a", 50, 40), content("card", 20), content("b", 30)],
      ids,
    ),
  ).toThrow();
});
