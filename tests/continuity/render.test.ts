import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  APPROVED_CANONICAL_LOGO_SHA256,
  inspectCanonicalLogo,
} from "../../src/continuity/branding.js";
import { renderCacheKey, renderContinuityCard } from "../../src/continuity/render.js";

const template = `<svg>{{LOGO}}<text>{{LABEL}}</text><text>{{TITLE_1}}</text><text>{{TITLE_2}}</text><text>{{DETAIL_1}}</text><text>{{DETAIL_2}}</text><text>{{DETAIL_3}}</text><text>{{DETAIL_4}}</text><text>{{FOOTER}}</text></svg>`;

test("escapes schedule text and never treats it as markup", () => {
  const svg = renderContinuityCard({
    template,
    production: false,
    label: "NEXT",
    title: `Roseanne & <b>Dan</b> $HOME "friends"`,
    details: ["Coming up"],
    footer: "MarkTV",
  });
  expect(svg).toContain("Roseanne &amp; &lt;b&gt;Dan&lt;/b&gt;");
  expect(svg).toContain("$HOME");
  expect(svg).toContain("&quot;friends&quot;");
  expect(svg).not.toContain("<b>");
  expect(svg).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
});

test("blocks production rendering without the approved logo binding", () => {
  expect(() =>
    renderContinuityCard({
      template,
      production: true,
      label: "NEXT",
      title: "Roseanne",
      details: [],
      footer: "MarkTV",
    }),
  ).toThrow(/canonical logo/i);
  expect(() =>
    renderContinuityCard({
      template,
      production: true,
      logoDataUri: "data:image/png;base64,not-the-approved-logo",
      label: "NEXT",
      title: "Roseanne",
      details: [],
      footer: "MarkTV",
    }),
  ).toThrow(/approved canonical logo/i);
});

test("binds the user-approved logo bytes for production rendering", async () => {
  const logo = await readFile(resolve("assets", "branding", "marktv-logo-canonical.png"));
  const branding = await inspectCanonicalLogo();
  expect(branding).toMatchObject({
    state: "bound",
    sha256: APPROVED_CANONICAL_LOGO_SHA256,
  });
  const svg = renderContinuityCard({
    template,
    production: true,
    logoDataUri: `data:image/png;base64,${logo.toString("base64")}`,
    label: "NEXT",
    title: "Roseanne",
    details: [],
    footer: "MarkTV",
  });
  expect(svg).toContain("data:image/png;base64,");
});

test("rejects titles that cannot fit instead of silently truncating", () => {
  expect(() =>
    renderContinuityCard({
      template,
      production: false,
      label: "NEXT",
      title: "A".repeat(40),
      details: [],
      footer: "MarkTV",
    }),
  ).toThrow(/does not fit/i);
});

test("cache identity changes with voice, logo, template, copy, or output profile", () => {
  const base = {
    text: "Next, Roseanne",
    personaId: "local",
    voiceBinding: "existing-local-1",
    voiceSettings: { rate: 1 },
    templateHash: "template-a",
    logoHash: "logo-a",
    outputProfile: { width: 720, height: 480, codec: "h264" },
  };
  const original = renderCacheKey(base);
  for (const changed of [
    { ...base, text: "Next, Night Court" },
    { ...base, personaId: "network" },
    { ...base, voiceBinding: "existing-local-2" },
    { ...base, templateHash: "template-b" },
    { ...base, logoHash: "logo-b" },
    { ...base, outputProfile: { ...base.outputProfile, height: 720 } },
  ]) expect(renderCacheKey(changed)).not.toBe(original);
});
