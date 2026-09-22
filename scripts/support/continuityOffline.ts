import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Schedule, ScheduleEntry } from "../../src/domain/models.js";
import { generatedContinuityTags, generatedFileName, generatedMediaId } from "../../src/continuity/assets.js";
import type { ContinuityCardPlan, PlanResult } from "../../src/continuity/director.js";
import { isApprovedCanonicalLogoBuffer } from "../../src/continuity/branding.js";
import {
  cardFileName,
  cardSvg,
  decodeRendered,
  ffmpegHasDrawtext,
  probeRendered,
  rasterArgs,
  readTemplate,
  runFfmpeg,
  writeTextFiles,
} from "../../src/continuity/offline.js";
import { templateForCardType } from "../../src/continuity/families.js";

export const DEFAULT_CARD_LIMIT = 8;

export function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error(`Invalid argument near ${name ?? "end"}`);
    values.set(name.slice(2), value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  return { values, required };
}

const hashFile = (path: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

const atomicWrite = async (path: string, content: string) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { flag: "w" });
  await rename(temporary, path);
};

const editorial = (entry: ScheduleEntry) =>
  entry.kind === "episode" || entry.kind === "movie";

export type TimingIssue = { breakEntryId: string; message: string };

/**
 * Compare a continuity-applied schedule with the schedule it came from.
 *
 * This is the acceptance check the verifier reports on: the editorial lineup
 * and every program start must be untouched, each break must keep its exact
 * total duration, and nothing may be added but whole, already-validated items.
 */
export function verifyExactTiming(
  original: Schedule,
  applied: Schedule,
): { ok: boolean; issues: TimingIssue[]; breaks: Array<{ id: string; durationMs: number; entries: number }> } {
  const issues: TimingIssue[] = [];
  const originalEditorial = original.entries.filter(editorial);
  const appliedEditorial = applied.entries.filter(editorial);
  if (originalEditorial.length !== appliedEditorial.length)
    issues.push({
      breakEntryId: "-",
      message: `Editorial entry count changed: ${originalEditorial.length} -> ${appliedEditorial.length}`,
    });
  for (const [index, entry] of originalEditorial.entries()) {
    const after = appliedEditorial[index];
    if (!after) continue;
    // Every field of the editorial airing, not just its timing: a replacement
    // that quietly swapped the media behind an unchanged window would pass a
    // timing-only check.
    if (JSON.stringify(after) !== JSON.stringify(entry))
      issues.push({
        breakEntryId: entry.id,
        message: `Editorial airing ${entry.id} changed (${entry.start} -> ${after.start})`,
      });
  }
  const originalBreaks = breaksOf(original.entries);
  const appliedBreaks = breaksOf(applied.entries);
  if (originalBreaks.length !== appliedBreaks.length)
    issues.push({
      breakEntryId: "-",
      message: `Break count changed: ${originalBreaks.length} -> ${appliedBreaks.length}`,
    });
  const breaks = appliedBreaks.map((items, index) => {
    const durationMs = items.reduce((sum, item) => sum + item.durationMs, 0);
    const before = originalBreaks[index];
    const expected = before?.reduce((sum, item) => sum + item.durationMs, 0);
    if (expected !== undefined && expected !== durationMs)
      issues.push({
        breakEntryId: items[0]?.id ?? `break-${index}`,
        message: `Break duration changed: ${expected} -> ${durationMs}`,
      });
    // Breaks start and end on the same instants as before.
    if (before?.length && items.length) {
      if (before[0]!.start !== items[0]!.start)
        issues.push({
          breakEntryId: items[0]!.id,
          message: `Break start moved: ${before[0]!.start} -> ${items[0]!.start}`,
        });
      if (before.at(-1)!.end !== items.at(-1)!.end)
        issues.push({
          breakEntryId: items[0]!.id,
          message: `Break end moved: ${before.at(-1)!.end} -> ${items.at(-1)!.end}`,
        });
    }
    // The scheduler itself leaves `flex` filler when a break cannot be filled
    // exactly, so only an *increase in dead-air duration* is continuity's fault.
    const flexBefore =
      before?.filter((item) => item.kind === "flex").reduce((sum, item) => sum + item.durationMs, 0) ?? 0;
    const flexAfter = items
      .filter((item) => item.kind === "flex")
      .reduce((sum, item) => sum + item.durationMs, 0);
    if (flexAfter > flexBefore)
      issues.push({
        breakEntryId: items[0]?.id ?? `break-${index}`,
        message: `Break gained ${flexAfter - flexBefore}ms of flexible (dead-air) time`,
      });
    const informational = items.filter((item) => item.source?.startsWith("continuity:"));
    if (informational.length > 1)
      issues.push({
        breakEntryId: items[0]?.id ?? `break-${index}`,
        message: `Break carries ${informational.length} continuity cards`,
      });
    return { id: items[0]?.id ?? `break-${index}`, durationMs, entries: items.length };
  });
  return { ok: issues.length === 0, issues, breaks };
}

const breaksOf = (entries: ScheduleEntry[]) => {
  const breaks: ScheduleEntry[][] = [];
  let current: ScheduleEntry[] | undefined;
  for (const entry of entries) {
    if (editorial(entry)) {
      if (current?.length) breaks.push(current);
      current = undefined;
      continue;
    }
    current = current ?? [];
    current.push(entry);
  }
  if (current?.length) breaks.push(current);
  return breaks;
};

export type RenderRecord = {
  id: string;
  cardType: ContinuityCardPlan["cardType"];
  family: ContinuityCardPlan["family"];
  label: string;
  title: string;
  details: string[];
  durationMs: number;
  insertionInstant: string;
  breakEntryId: string;
  scheduleRevision: string;
  contentHash: string;
  wordingKey: string;
  target: ContinuityCardPlan["target"];
  mediaId: string;
  fileName: string;
  files: { svg: string; png?: string; mp4?: string };
  hashes: { svg: string; png?: string; mp4?: string };
  probe?: { durationMs: number; profileValid: boolean };
  tags: string[];
  error?: string;
};

/** The representative cards the parent reviews, one per available class. */
export function representativePlans(plans: ContinuityCardPlan[], limit = DEFAULT_CARD_LIMIT) {
  const wanted: ContinuityCardPlan["cardType"][] = [
    "next",
    "next-later",
    "tonight",
    "weekend",
    "after-dark",
  ];
  const chosen: ContinuityCardPlan[] = [];
  for (const cardType of wanted) {
    const match = plans.find((plan) => plan.cardType === cardType);
    if (match) chosen.push(match);
  }
  for (const plan of plans) if (!chosen.includes(plan) && chosen.length < limit) chosen.push(plan);
  return chosen.slice(0, limit);
}

export async function renderPlans(input: {
  plans: ContinuityCardPlan[];
  outDir: string;
  repoRoot: string;
  logoPath?: string;
  ffmpeg: string;
  ffprobe: string;
  font: string;
  production: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
}): Promise<{ renders: RenderRecord[]; rasterSupported: boolean }> {
  const log = input.log ?? (() => {});
  // Production rendering is only entered with the exact approved logo bytes;
  // anything else silently degrades to a preview rather than shipping a card
  // with an unapproved mark.
  const logoDataUri = await (async () => {
    if (!input.production || !input.logoPath) return undefined;
    try {
      const buffer = await readFile(input.logoPath);
      return isApprovedCanonicalLogoBuffer(buffer)
        ? `data:image/png;base64,${buffer.toString("base64")}`
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const production = Boolean(logoDataUri);
  const rasterSupported = Boolean(
    production && input.logoPath && (await ffmpegHasDrawtext(input.ffmpeg)),
  );
  if (!rasterSupported)
    log(
      production
        ? "Raster rendering unavailable (ffmpeg build lacks drawtext or the canonical logo is missing); SVG previews only."
        : input.production
          ? "Canonical logo is not the approved binding; SVG previews only."
          : "Preview-only run: raster rendering is skipped.",
    );
  await mkdir(input.outDir, { recursive: true });
  const renders: RenderRecord[] = [];
  for (const plan of input.plans) {
    const name = cardFileName(plan);
    const record: RenderRecord = {
      id: plan.id,
      cardType: plan.cardType,
      family: plan.family,
      label: plan.label,
      title: plan.title,
      details: plan.details,
      durationMs: plan.durationMs,
      insertionInstant: plan.insertionInstant,
      breakEntryId: plan.breakEntryId,
      scheduleRevision: plan.scheduleRevision,
      contentHash: plan.contentHash,
      wordingKey: plan.wordingKey,
      target: plan.target,
      mediaId: generatedMediaId(plan),
      fileName: generatedFileName(plan),
      files: { svg: `${name}.svg` },
      hashes: { svg: "" },
      tags: generatedContinuityTags(plan),
    };
    try {
      const template = templateForCardType[plan.cardType];
      const svg = cardSvg({
        plan,
        template: await readTemplate(input.repoRoot, template),
        production,
        logoDataUri,
      });
      const svgPath = join(input.outDir, record.files.svg);
      await atomicWrite(svgPath, svg);
      record.hashes.svg = await hashFile(svgPath);
      if (rasterSupported && input.logoPath) {
        const textDir = join(input.outDir, `${name}-text`);
        await mkdir(textDir, { recursive: true });
        const textFiles = await writeTextFiles(textDir, plan);
        const pngPath = join(input.outDir, `${name}.png`);
        const mp4Path = join(input.outDir, `${name}.mp4`);
        try {
          const args = (outputPath: string, still: boolean) =>
            rasterArgs({
              plan,
              logoPath: input.logoPath!,
              outputPath,
              textFiles,
              font: input.font,
              still,
            });
          await runFfmpeg(input.ffmpeg, args(pngPath, true), input.timeoutMs);
          await runFfmpeg(input.ffmpeg, args(mp4Path, false), input.timeoutMs);
          await decodeRendered(input.ffmpeg, mp4Path);
          const probe = await probeRendered(input.ffprobe, mp4Path);
          if (!probe.profileValid)
            throw new Error("Rendered profile does not match the approved card profile");
          if (Math.abs(probe.durationMs - plan.durationMs) > 120)
            throw new Error(
              `Rendered duration ${probe.durationMs}ms differs from planned ${plan.durationMs}ms`,
            );
          record.files.png = basename(pngPath);
          record.files.mp4 = basename(mp4Path);
          record.hashes.png = await hashFile(pngPath);
          record.hashes.mp4 = await hashFile(mp4Path);
          record.probe = { durationMs: probe.durationMs, profileValid: probe.profileValid };
        } finally {
          await rm(textDir, { recursive: true, force: true });
        }
      }
      log(`Rendered ${plan.cardType} (${plan.family}) -> ${record.files.mp4 ?? record.files.svg}`);
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      log(`Skipped ${plan.cardType}: ${record.error}`);
    }
    renders.push(record);
  }
  return { renders, rasterSupported };
}

export async function writeManifest(outDir: string, manifest: unknown) {
  await atomicWrite(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export const resolveMaybe = (value: string | undefined, fallback: string) =>
  value ? resolve(value) : fallback;

/** Where the canonical logo lives, derived from the loaded branding report. */
export function logoPathFor(repoRoot: string, expectedFile: string) {
  return join(repoRoot, "assets", "branding", expectedFile);
}

export type OfflineRun = {
  channelId: string;
  date: string;
  plan: PlanResult;
  representative: ContinuityCardPlan[];
};
