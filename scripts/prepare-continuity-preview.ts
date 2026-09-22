#!/usr/bin/env -S npx tsx
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { MediaItem, Schedule } from "../src/domain/models.js";
import { inspectCanonicalLogo } from "../src/continuity/branding.js";
import { deriveContinuityContext } from "../src/continuity/context.js";
import { renderCacheKey, renderContinuityCard } from "../src/continuity/render.js";

const argumentsByName = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument near ${name ?? "end"}`);
  argumentsByName.set(name.slice(2), value);
}
const required = (name: string) => {
  const value = argumentsByName.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const schedulePath = required("schedule");
const mediaPath = required("media");
const output = required("out");
const at = argumentsByName.get("at") ?? new Date().toISOString();
const managedLineup = argumentsByName.get("managed-lineup") !== "false";
if (!Number.isFinite(Date.parse(at))) throw new Error("--at must be an ISO instant");

const schedule = JSON.parse(await readFile(schedulePath, "utf8")) as Schedule;
const media = JSON.parse(await readFile(mediaPath, "utf8")) as MediaItem[];
const context = deriveContinuityContext({
  schedules: [schedule],
  media,
  insertionInstant: new Date(at).toISOString(),
  managedLineup,
});
const branding = await inspectCanonicalLogo();
const logoDataUri =
  branding.state === "bound"
    ? `data:image/png;base64,${(await readFile(resolve("assets", "branding", branding.expectedFile))).toString("base64")}`
    : undefined;
const current = context.current?.showTitle ?? context.current?.title ?? "MarkTV";
const next = context.next?.showTitle ?? context.next?.title ?? "No confirmed next program";
const later = context.later?.showTitle ?? context.later?.title ?? "No confirmed later program";
const tonight = context.tonight.slice(0, 3).map((item) => item.showTitle ?? item.title);
const weekend = context.weekendPair?.map((item) => item.title) ?? [];
const definitions = [
  { template: "next", label: "NEXT", title: next, details: ["Coming up on MarkTV"], eligible: Boolean(context.next) },
  { template: "next-later", label: "COMING UP", title: next, details: [`LATER · ${later}`], eligible: Boolean(context.next && context.later) },
  { template: "tonight", label: context.presentationLabel, title: tonight[0] ?? next, details: tonight.slice(1), eligible: context.allowTimeRelativePromos && tonight.length > 0 },
  { template: "weekend", label: "WEEKEND DOUBLE FEATURE", title: weekend[0] ?? "No confirmed upcoming pair", details: weekend[1] ? [`FOLLOWED BY · ${weekend[1]}`] : [], eligible: Boolean(context.weekendPair) },
  { template: "after-dark", label: "AFTER DARK", title: next, details: ["Late television on MarkTV"], eligible: Boolean(context.next) },
  { template: "break", label: "MORE AFTER THIS", title: current, details: ["You’re watching MarkTV"], eligible: Boolean(context.current) },
  { template: "return", label: "BACK TO", title: current, details: ["Right here on MarkTV"], eligible: Boolean(context.returnTarget) },
  { template: "interruption", label: "PLEASE STAND BY", title: "STAGED INTERRUPTION", details: ["Disabled pending playback health gate"], eligible: false },
];

await mkdir(output, { recursive: true });
const atomic = async (path: string, content: string) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { flag: "wx" });
  await rename(temporary, path);
};
const cards: Array<{ file: string; template: string; eligible: boolean; cacheKey: string }> = [];
for (const definition of definitions) {
  const templatePath = resolve("assets", "continuity", "templates", `${definition.template}.svg`);
  const template = await readFile(templatePath, "utf8");
  const svg = renderContinuityCard({
    template,
    production: branding.state === "bound",
    logoDataUri,
    label: definition.label,
    title: definition.title,
    details: definition.details,
    footer:
      branding.state === "bound"
        ? "PREVIEW ONLY · AUDIO AND PUBLICATION NOT ENABLED"
        : "PREVIEW ONLY · CANONICAL LOGO VALIDATION REQUIRED",
  });
  const file = `${definition.template}.svg`;
  await atomic(join(output, file), svg);
  cards.push({
    file,
    template: definition.template,
    eligible: definition.eligible,
    cacheKey: renderCacheKey({
      scheduleRevision: context.scheduleRevision,
      insertionInstant: context.insertionInstant,
      definition,
      template,
      logo: "unbound",
      output: "svg-preview",
    }),
  });
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceSchedule: basename(schedulePath),
  scheduleId: schedule.id,
  scheduleRevision: context.scheduleRevision,
  insertionInstant: context.insertionInstant,
  production: false,
  airReady: false,
  branding: branding.state,
  canonicalLogoSha256: branding.state === "bound" ? branding.sha256 : null,
  audioGenerated: false,
  cards,
};
await atomic(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const figures = cards
  .map(
    (card) =>
      `<figure><img src="${card.file}" alt="${card.template} preview"><figcaption>${card.template} · ${
        card.eligible ? "context eligible" : "suppressed"
      }</figcaption></figure>`,
  )
  .join("\n");
await atomic(
  join(output, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>MarkTV continuity preview</title><style>body{font:16px system-ui;background:#111821;color:#eee;margin:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}figure{margin:0}img{width:100%;border:1px solid #566}figcaption{padding:8px}</style><h1>MarkTV continuity · schedule-bound preview</h1><p>Schedule ${schedule.id}; generated for ${context.insertionInstant}. Canonical logo: ${branding.state}. Preview only: audio, publication, and live activation remain disabled.</p><div class="grid">${figures}</div>`,
);
console.log(`Prepared ${cards.length} schedule-bound SVG previews in ${output}. Air ready: false.`);
