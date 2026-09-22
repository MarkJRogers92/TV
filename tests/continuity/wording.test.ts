import { expect, test } from "vitest";
import {
  normalizeMovieTitle,
  normalizeSeriesTitle,
  overnightSecondaryLine,
  wordContinuityCard,
} from "../../src/continuity/wording.js";

test("normalizes a scanned all-lower-case series name and leaves catalogued casing alone", () => {
  expect(normalizeSeriesTitle("roseanne")).toBe("Roseanne");
  expect(normalizeSeriesTitle("that 70s show")).toBe("That 70s Show");
  expect(normalizeSeriesTitle("  married   with children ")).toBe("Married With Children");
  expect(normalizeSeriesTitle("Night Court")).toBe("Night Court");
  expect(normalizeSeriesTitle("CSI")).toBe("CSI");
  expect(normalizeSeriesTitle(undefined)).toBeUndefined();
  expect(normalizeSeriesTitle("   ")).toBeUndefined();
});

test("presents release-file film names without rewriting clean catalog titles", () => {
  expect(normalizeMovieTitle("Popcorn.1991.1080p.BluRay.x264-[YTS.LT]")).toBe("Popcorn (1991)");
  expect(normalizeMovieTitle("Brain.Damage.1988.1080p.BluRay.x264.AAC5.1-[YTS.MX]")).toBe(
    "Brain Damage (1988)",
  );
  expect(normalizeMovieTitle("Street Trash 1987 REMASTERED 1080p BluRay HEVC x265 5.1 BONE")).toBe(
    "Street Trash (1987)",
  );
  expect(normalizeMovieTitle("Tremors (1990)")).toBe("Tremors (1990)");
  expect(normalizeMovieTitle("Major Payne (1995)")).toBe("Major Payne (1995)");
  expect(normalizeMovieTitle("1984")).toBe("1984");
  expect(normalizeMovieTitle(undefined)).toBeUndefined();
});

test("same-series NEXT never reads as NEXT {show already on screen}", () => {
  for (let index = 0; index < 12; index += 1) {
    const card = wordContinuityCard({
      cardType: "next",
      title: "Roseanne",
      sameSeries: true,
      seed: `seed-${index}`,
    });
    expect([
      "MORE",
      "STILL MORE",
      "MORE FROM",
      "STILL AHEAD",
      "CONTINUES",
      "MORE AHEAD",
    ]).toContain(card.label);
    // The same series still reads as more/continues, never as a fresh NEXT of
    // the show already on screen.
    expect(card.details.join(" ")).toMatch(/MORE|NEXT|CONTINUES/);
    expect(card.title).toBe("Roseanne");
  }
});

test("different-series NEXT rotates only connective copy", () => {
  const labels = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const card = wordContinuityCard({
      cardType: "next",
      title: "Night Court",
      sameSeries: false,
      seed: `seed-${index}`,
    });
    labels.add(card.label);
    expect(card.title).toBe("Night Court");
    expect(card.details.length).toBeGreaterThan(0);
  }
  expect(labels.size).toBeGreaterThan(1);
  expect(["NEXT", "UP NEXT", "COMING UP NEXT", "NEXT ON MARKTV"]).toEqual(
    expect.arrayContaining([...labels]),
  );
});

test("NEXT/LATER and TONIGHT always carry their schedule facts", () => {
  const later = wordContinuityCard({
    cardType: "next-later",
    title: "Night Court",
    sameSeries: false,
    second: "Cheers",
    seed: "seed",
  });
  expect(later.details.join(" ")).toContain("Cheers");

  const tonight = wordContinuityCard({
    cardType: "tonight",
    title: "Tremors",
    sameSeries: false,
    startTime: "2:07 AM",
    seed: "seed",
  });
  expect(tonight.title).toBe("Tremors");
  expect(tonight.details).toContain("STARTS 2:07 AM");

  const weekend = wordContinuityCard({
    cardType: "weekend",
    title: "Tremors",
    sameSeries: false,
    second: "The Blob",
    startTime: "7:00 PM",
    seed: "seed",
  });
  expect(weekend.title).toBe("Tremors");
  expect(weekend.details.join(" ")).toContain("STARTS 7:00 PM");
  expect(weekend.details.join(" ")).toContain("The Blob");
});

test("overnight humour is off at zero, rare when low, and never informational", () => {
  let offCount = 0;
  let lowCount = 0;
  let normalCount = 0;
  for (let index = 0; index < 200; index += 1) {
    if (overnightSecondaryLine("off", `seed-${index}`)) offCount += 1;
    if (overnightSecondaryLine("low", `seed-${index}`)) lowCount += 1;
    if (overnightSecondaryLine("normal", `seed-${index}`)) normalCount += 1;
  }
  expect(offCount).toBe(0);
  expect(lowCount).toBeGreaterThan(0);
  expect(lowCount).toBeLessThan(60);
  expect(normalCount).toBeGreaterThan(lowCount);
  expect(overnightSecondaryLine("low", "stable-seed")).toBe(
    overnightSecondaryLine("low", "stable-seed"),
  );
});
