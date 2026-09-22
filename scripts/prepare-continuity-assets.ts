#!/usr/bin/env -S npx tsx
import { basename, resolve } from "node:path";
import { DateTime } from "luxon";
import { inspectCanonicalLogo } from "../src/continuity/branding.js";
import { planContinuityCards } from "../src/continuity/director.js";
import { readAiredContinuityHistory } from "../src/continuity/history.js";
import { readContinuityConfig } from "../src/continuity/status.js";
import {
  DEFAULT_CARD_LIMIT,
  logoPathFor,
  parseArgs,
  renderPlans,
  writeManifest,
} from "./support/continuityOffline.js";
import { openReadOnlyRepositories } from "./support/continuityDatabase.js";

/**
 * Offline continuity asset preparation.
 *
 * Runs at schedule preparation time: it reads a snapshot of the database, plans
 * the day's cards from the completed schedule, and renders each to
 * SVG/PNG/MP4 in the output directory. Registration is reserved for the normal
 * schedule preparation pipeline with mapped-library verification. Nothing
 * here syncs Tunarr, edits a pool, or touches playback.
 */
const { values, required } = parseArgs(process.argv.slice(2));
const databasePath = resolve(required("db"));
const output = resolve(required("out"));
const repoRoot = resolve(values.get("repo-root") ?? ".");
const channelId = values.get("channel") ?? "marktv-laughs";
const ffmpeg = values.get("ffmpeg") ?? "ffmpeg";
const ffprobe = values.get("ffprobe") ?? "ffprobe";
const font = values.get("font") ?? "font=Arial";
const limit = Number(values.get("limit") ?? DEFAULT_CARD_LIMIT);
const register = values.get("register") === "true";
if (register) throw new Error("Manual catalog registration is disabled. Normal schedule generation prepares and verifies cards inside the mapped playback library.");

const { repositories, close } = openReadOnlyRepositories(databasePath);
try {
  const channel = repositories.channels.get(channelId);
  if (!channel) throw new Error(`Channel ${channelId} is not in ${basename(databasePath)}`);
  const now = values.get("now") ?? new Date().toISOString();
  const date =
    values.get("date") ??
    DateTime.fromISO(now, { setZone: true }).setZone(channel.timezone).toISODate();
  if (!date) throw new Error("Could not resolve a broadcast date");
  const schedule = repositories.schedules.latestForDate(channel.id, date);
  if (!schedule)
    throw new Error(`No completed schedule for ${channel.id} on ${date}; nothing to prepare`);
  const config = readContinuityConfig(repositories, channel.id);
  if (!config.enabled) {
    console.log("Continuity Director is switched off for this channel; preparing nothing.");
  }
  const plan = planContinuityCards({
    schedule,
    media: repositories.media.list(),
    config,
    history: readAiredContinuityHistory(repositories, channel.id),
  });
  const branding = await inspectCanonicalLogo(repoRoot);
  if (branding.state !== "bound")
    console.log(`Canonical logo is ${branding.state}; previews only, no production render.`);

  const { renders, rasterSupported } = await renderPlans({
    plans: plan.plans.slice(0, Number.isFinite(limit) ? limit : DEFAULT_CARD_LIMIT),
    outDir: output,
    repoRoot,
    logoPath: branding.state === "bound" ? logoPathFor(repoRoot, branding.expectedFile) : undefined,
    ffmpeg,
    ffprobe,
    font,
    production: branding.state === "bound",
    log: (message) => console.log(message),
  });

  const preparable = renders.filter((render) => render.files.mp4 && !render.error);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: "offline schedule-scoped continuity cards; generated media for one completed schedule",
    source: {
      database: basename(databasePath),
      channelId: channel.id,
      broadcastDate: date,
      scheduleId: schedule.id,
      contentHash: plan.contentHash,
      storedEnabled: config.enabled,
    },
    branding,
    rasterSupported,
    counts: {
      planned: plan.plans.length,
      rendered: preparable.length,
      skipped: renders.length - preparable.length,
      rejected: plan.rejections.length,
    },
    renders,
  };
  await writeManifest(output, manifest);
  console.log(
    `Prepared ${preparable.length}/${plan.plans.length} cards in ${output}. Manifest: ${resolve(output, "manifest.json")}`,
  );


} finally {
  close();
}
