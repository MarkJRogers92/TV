import { createHash } from "node:crypto";
import { isApprovedCanonicalLogoBuffer } from "./branding.js";
import { applyFamilyStyle } from "./families.js";
import type { ContinuityFamily } from "./types.js";

export function escapeXml(value: string) {
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13;
    })
  )
    throw new Error("Invalid XML control character");
  return value.replace(/[<>&"']/gu, (character) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[
      character
    ]!,
  );
}

export function wrapCardText(text: string, maxCharacters: number, maxLines: number) {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ([...word].length > maxCharacters) throw new Error("Text does not fit: overlong word");
    const next = current ? `${current} ${word}` : word;
    if ([...next].length <= maxCharacters) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) throw new Error("Text does not fit: too many lines");
  return lines;
}

export function renderContinuityCard(input: {
  template: string;
  production: boolean;
  logoDataUri?: string;
  label: string;
  title: string;
  details: string[];
  footer: string;
}) {
  if (input.production) {
    const encoded = input.logoDataUri?.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u)?.[1];
    const logo = encoded ? Buffer.from(encoded, "base64") : undefined;
    if (!logo || !isApprovedCanonicalLogoBuffer(logo))
      throw new Error("Production continuity cards require the approved canonical logo");
  }
  const logo = input.logoDataUri
    ? `<image href="${escapeXml(input.logoDataUri)}" x="754" y="46" width="136" height="136" preserveAspectRatio="xMidYMid meet"/>`
    : '<rect x="754" y="46" width="136" height="136" fill="#151a24" stroke="#ffffff"/><text x="822" y="102" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="12">CANONICAL LOGO</text><text x="822" y="124" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="11">VALIDATION REQUIRED</text>';
  const title = wrapCardText(input.title, 27, 2);
  const details = input.details.flatMap((detail) => wrapCardText(detail, 40, 2));
  if (details.length > 4) throw new Error("Text does not fit: too many detail lines");
  const tokens: Record<string, string> = {
    LOGO: logo,
    LABEL: escapeXml(input.label),
    TITLE_1: escapeXml(title[0] ?? ""),
    TITLE_2: escapeXml(title[1] ?? ""),
    FOOTER: escapeXml(input.footer),
  };
  for (let index = 0; index < 4; index += 1)
    tokens[`DETAIL_${index + 1}`] = escapeXml(details[index] ?? "");
  const svg = input.template.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_, key: string) => {
    if (!Object.hasOwn(tokens, key)) throw new Error(`Unknown template token ${key}`);
    return tokens[key];
  });
  if (/\{\{/u.test(svg)) throw new Error("Unbound SVG template token");
  return svg;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

export const renderCacheKey = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");

/**
 * Render one planned card: the approved template, the plan's copy, the
 * canonical logo binding, and the family's palette accent.
 */
export function renderContinuityPlan(input: {
  template: string;
  plan: {
    label: string;
    title: string;
    details: string[];
    footer: string;
    family: ContinuityFamily;
  };
  production: boolean;
  logoDataUri?: string;
}) {
  const svg = renderContinuityCard({
    template: input.template,
    production: input.production,
    logoDataUri: input.logoDataUri,
    label: input.plan.label,
    title: input.plan.title,
    details: input.plan.details,
    footer: input.plan.footer,
  });
  return applyFamilyStyle(svg, input.plan.family);
}
