import { seededIndex } from "./identity.js";
import type { ContinuityCardType } from "./types.js";

export type ContinuityWording = {
  label: string;
  title: string;
  details: string[];
};

export type WordingInput = {
  cardType: ContinuityCardType;
  /** The program the card names: the show for NEXT/NEXT-LATER, the film or program for TONIGHT. */
  title: string;
  /** True when the NEXT target is the same series that is currently airing. */
  sameSeries: boolean;
  /** Secondary target for the two-item shapes (NEXT-LATER's later program, a weekend pair's second film). */
  second?: string;
  /** Local channel time the named program starts, e.g. "2:07 AM". */
  startTime?: string;
  /** Stable seed parts: channel, broadcast date, schedule hash, card class, target ids. */
  seed: string;
  /** True for an after-midnight insertion, where time-relative copy changes. */
  overnight?: boolean;
  /** True when the promoted target is a film rather than an episode. */
  movie?: boolean;
};

const pick = <T,>(variants: T[], seed: string): T =>
  variants[seededIndex(seed, variants.length)]!;

/**
 * Present a series name the way a card should read it.
 *
 * Catalogs are frequently scanned from file names, so a series can arrive
 * entirely lower-case ("roseanne", "that 70s show"). Only an all-lower-case
 * name is touched - anything already carrying its own capitalisation, acronyms
 * or punctuation is left exactly as the operator catalogued it.
 */
export function normalizeSeriesTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (!trimmed) return undefined;
  if (/[A-Z]/u.test(trimmed)) return trimmed;
  return trimmed.replace(/(^|[\s\-/])(\p{L})/gu, (_, prefix: string, letter: string) =>
    `${prefix}${letter.toUpperCase()}`,
  );
}

const releaseMarkers =
  /\b(?:2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|ac3|dts|remastered|proper|repack)\b/iu;

/**
 * Present a film title.
 *
 * Many film catalogs are named straight from the release file
 * (`Popcorn.1991.1080p.BluRay.x264-[YTS.LT]`). When - and only when - a title
 * carries a year followed by recognisable release markers, the card shows the
 * name and year instead. A title the operator already catalogued cleanly, or one
 * with no release markers, is never rewritten.
 */
export function normalizeMovieTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(?<name>.*?)[\s._-]+(?<year>(?:19|20)\d{2})[\s._-]+(?<rest>.+)$/u);
  if (!match?.groups) return trimmed;
  const { name, year, rest } = match.groups as { name: string; year: string; rest: string };
  if (!releaseMarkers.test(rest)) return trimmed;
  const cleaned = name.replace(/[._]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!cleaned) return trimmed;
  return `${cleaned} (${year})`;
}

type Variant = { label: string; details: string[] };

const laterDetail = (second: string) => `LATER · ${second}`;

const nextVariants = (sameSeries: boolean, seed: string): Variant => {
  const different: Variant[] = [
    { label: "NEXT", details: ["COMING UP ON MARKTV"] },
    { label: "UP NEXT", details: ["ON MARKTV"] },
    { label: "COMING UP NEXT", details: ["ON MARKTV"] },
    { label: "NEXT ON MARKTV", details: ["COMING UP"] },
  ];
  // "MORE {SHOW} NEXT" rather than a NEXT card naming the show already on
  // screen, which reads as if the current episode were starting again.
  const same: Variant[] = [
    { label: "MORE", details: ["NEXT ON MARKTV"] },
    { label: "STILL MORE", details: ["NEXT ON MARKTV"] },
    { label: "MORE FROM", details: ["UP NEXT"] },
    { label: "STILL AHEAD", details: ["MORE ON MARKTV"] },
    { label: "CONTINUES", details: ["MORE NEXT ON MARKTV"] },
    { label: "MORE AHEAD", details: ["CONTINUES NEXT"] },
  ];
  return pick(sameSeries ? same : different, seed);
};

const nextLaterVariants = (sameSeries: boolean, second: string, seed: string): Variant => {
  const different: Variant[] = [
    { label: "NEXT", details: [laterDetail(second)] },
    { label: "COMING UP", details: [`THEN · ${second}`] },
    { label: "UP NEXT", details: [laterDetail(second)] },
    { label: "NEXT ON MARKTV", details: [laterDetail(second)] },
  ];
  const same: Variant[] = [
    { label: "MORE", details: [laterDetail(second)] },
    { label: "STILL MORE", details: [`THEN · ${second}`] },
  ];
  return pick(sameSeries ? same : different, seed);
};

const tonightVariants = (startTime: string | undefined, seed: string): Variant => {
  const starts = startTime ? [`STARTS ${startTime}`] : ["TONIGHT"];
  const variants: Variant[] = [
    { label: "TONIGHT", details: starts },
    { label: "TONIGHT ON MARKTV", details: starts },
    { label: "COMING UP TONIGHT", details: starts },
  ];
  return pick(variants, seed);
};

/**
 * After midnight "TONIGHT" would name the wrong day. A film that is genuinely
 * still ahead keeps a truthful time-relative label and its exact start time.
 */
const overnightMovieVariants = (startTime: string | undefined, seed: string): Variant => {
  const details = startTime ? [`STARTS ${startTime}`] : ["LATE TONIGHT ON MARKTV"];
  return pick(
    [
      { label: "THE 2 AM MOVIE", details },
      { label: "THE LATE MOVIE", details },
      { label: "LATE NIGHT MOVIE", details },
    ],
    seed,
  );
};

/**
 * Deterministic wording for one planned card.
 *
 * Every part of the card that carries information - the program name, the
 * later program, the actual start time - is set from the schedule rather than
 * from the rotation; only the connective copy varies. Two runs over the same
 * completed schedule therefore produce identical text, and a rotation cannot
 * silently drop the time a film starts.
 */
export function wordContinuityCard(input: WordingInput): ContinuityWording {
  const seed = `${input.seed}:${input.cardType}`;
  const base = (() => {
    switch (input.cardType) {
      case "next":
        return nextVariants(input.sameSeries, seed);
      case "next-later":
        return nextLaterVariants(input.sameSeries, input.second ?? "MORE", seed);
      case "tonight":
        return input.overnight && input.movie
          ? overnightMovieVariants(input.startTime, seed)
          : tonightVariants(input.startTime, seed);
      case "weekend":
        return {
          label: pick(["WEEKEND DOUBLE FEATURE", "TONIGHT'S DOUBLE FEATURE"], seed),
          details: [
            ...(input.startTime ? [`STARTS ${input.startTime}`] : []),
            ...(input.second ? [`FOLLOWED BY · ${input.second}`] : []),
          ],
        } satisfies Variant;
      case "after-dark":
        return {
          label: pick(["AFTER DARK", "LATE NIGHT ON MARKTV"], seed),
          details: ["LATE NIGHT ON MARKTV"],
        } satisfies Variant;
    }
  })();
  return { label: base.label, title: input.title, details: [...base.details] };
}

/**
 * A secondary, dry line that may join an after-midnight card.
 *
 * It is appended to the informational details, never substituted for them, so
 * the program and its time always stay legible. `off` removes it entirely.
 */
export function overnightSecondaryLine(
  weirdness: "off" | "low" | "normal",
  seed: string,
): string | undefined {
  if (weirdness === "off") return undefined;
  const threshold = weirdness === "low" ? 10 : 20;
  if (seededIndex(`${seed}:overnight`, 100) >= threshold) return undefined;
  return pick(
    [
      "NIGHT SHIFT ON MARKTV",
      "THE LATE SHIFT CONTINUES",
      "STILL ON THE AIR",
      "NOBODY ELSE IS AWAKE",
    ],
    `${seed}:overnight-line`,
  );
}
