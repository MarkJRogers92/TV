import { seededIndex } from "./identity.js";
import type { ContinuityCardType, ContinuityFamily } from "./types.js";

/**
 * Which families make sense for a card class.
 *
 * Ordered by preference: the first entry is the natural home, the rest are
 * acceptable alternates. The selector uses this ordering but deprioritises a
 * family that has appeared recently rather than banning it outright - the
 * brief explicitly asks for no hard ban.
 */
export const familiesForCardType: Record<ContinuityCardType, ContinuityFamily[]> = {
  next: ["syndication", "local-cable"],
  "next-later": ["local-cable", "syndication"],
  tonight: ["prime-time", "local-cable"],
  weekend: ["prime-time"],
  "after-dark": ["overnight"],
};

/**
 * Families a card may use in the current daypart.
 *
 * After midnight the overnight presentation identity is added to every card so
 * the fourth family is reachable without a second card type or a second engine.
 */
export function candidateFamilies(
  cardType: ContinuityCardType,
  overnight: boolean,
): ContinuityFamily[] {
  const base = familiesForCardType[cardType];
  if (!overnight || base.includes("overnight")) return base;
  return [...base, "overnight"];
}

/** The approved SVG template each card class is built from. */
export const templateForCardType: Record<ContinuityCardType, string> = {
  next: "next",
  "next-later": "next-later",
  tonight: "tonight",
  weekend: "weekend",
  "after-dark": "after-dark",
};

type Palette = { accent: string; accentSoft: string; panel: string; bar: "top" | "bottom" | "left" };

const palettes: Record<ContinuityFamily, Palette> = {
  syndication: { accent: "#f3ce48", accentSoft: "#199b9a", panel: "#24164a", bar: "bottom" },
  "local-cable": { accent: "#5ae1d6", accentSoft: "#f3ce48", panel: "#163f4d", bar: "left" },
  "prime-time": { accent: "#e9c143", accentSoft: "#493286", panel: "#111a38", bar: "top" },
  overnight: { accent: "#cb986a", accentSoft: "#283d45", panel: "#10151e", bar: "bottom" },
};

/**
 * Pick the family for one card.
 *
 * `recentFamilies` is ordered newest-first. The first family of the card type
 * that has not been used recently wins; when every candidate has been used
 * recently, the least-recently-used one is chosen - a preference, never a ban.
 * Ties are broken by the caller's stable seed so the same schedule always
 * chooses the same family.
 */
export function selectFamily(
  cardType: ContinuityCardType,
  seed: string,
  recentFamilies: ContinuityFamily[] = [],
  candidatesOverride?: ContinuityFamily[],
): ContinuityFamily {
  const candidates = candidatesOverride?.length ? candidatesOverride : familiesForCardType[cardType];
  // Lower is better: -1 means "not used recently at all", otherwise the
  // family's distance from the newest entry in `recentFamilies`.
  const usage = (family: ContinuityFamily) => {
    const index = recentFamilies.indexOf(family);
    return index === -1 ? -1 : recentFamilies.length - index;
  };
  const ranked = [...candidates]
    .map((family, index) => ({ family, index, freshness: usage(family) }))
    .sort((left, right) => left.freshness - right.freshness || left.index - right.index);
  const freshest = ranked.filter((entry) => entry.freshness === ranked[0]!.freshness);
  if (freshest.length === 1) return freshest[0]!.family;
  // A single tie-breaker index keeps the choice deterministic without making a
  // family permanently win just because it is listed first.
  return freshest[seededIndex(`${seed}:family`, freshest.length)]!.family;
}

/**
 * Apply a family's palette and layout accent to a rendered template.
 *
 * This is intentionally additive: it never recolours the schedule text or a
 * logo image, so the approved copy stays legible and the canonical logo is
 * untouched. It only adds a bounded accent band in a family colour.
 */
export function applyFamilyStyle(svg: string, family: ContinuityFamily): string {
  const palette = palettes[family];
  const band =
    palette.bar === "top"
      ? `<rect x="0" y="0" width="960" height="10" fill="${palette.accent}"/>`
      : palette.bar === "bottom"
        ? `<rect x="0" y="708" width="960" height="12" fill="${palette.accent}"/>`
        : `<rect x="0" y="0" width="10" height="720" fill="${palette.accent}"/>`;
  const marker = `<g data-continuity-family="${family}">${band}<rect x="${
    palette.bar === "left" ? 10 : 0
  }" y="${palette.bar === "top" ? 10 : 0}" width="${
    palette.bar === "left" ? 4 : 960
  }" height="${palette.bar === "top" ? 4 : 720}" fill="${palette.accentSoft}" opacity="0.35"/></g>`;
  const close = svg.indexOf(">");
  if (close === -1) throw new Error("Continuity template is not an SVG document");
  return `${svg.slice(0, close + 1)}${marker}${svg.slice(close + 1)}`;
}
