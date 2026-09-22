#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { MediaItem } from "../src/domain/models.js";
import { classifyExistingContinuityAssets } from "../src/continuity/catalog.js";

const run = promisify(execFile);
const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument near ${name ?? "end"}`);
  values.set(name.slice(2), value);
}
const required = (name: string) => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const mediaPath = required("media");
const outputPath = required("out");
const ffprobe = values.get("ffprobe") ?? "ffprobe";

const hashFile = (path: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

const source = JSON.parse(await readFile(mediaPath, "utf8")) as MediaItem[];
const mediaById = new Map(source.map((item) => [item.id, item]));
const assets = classifyExistingContinuityAssets(source);
const validated = [];
for (const asset of assets) {
  const media = asset.mediaId ? mediaById.get(asset.mediaId) : undefined;
  try {
    if (!asset.path) throw new Error("Missing source path");
    const info = await stat(asset.path);
    const [{ stdout }, sha256] = await Promise.all([
      run(ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of", "json",
        asset.path,
      ], { maxBuffer: 1024 * 1024 }),
      hashFile(asset.path),
    ]);
    const probe = JSON.parse(stdout) as {
      streams?: Array<Record<string, string | number>>;
      format?: { duration?: string };
    };
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const measuredDurationMs = Math.round(Number(probe.format?.duration) * 1_000);
    const durationMatches = Boolean(
      media?.durationMs && Number.isFinite(measuredDurationMs) && Math.abs(media.durationMs - measuredDurationMs) <= 500,
    );
    const sourceValid = info.isFile() && info.size > 0 && Boolean(video && audio && durationMatches);
    const airReady = asset.airReady && sourceValid;
    validated.push({
      ...asset,
      contentHash: sha256,
      durationMs: measuredDurationMs,
      lifecycle: airReady ? "validated" : "quarantined",
      airReady,
      validation: {
        checkedAt: new Date().toISOString(),
        bytes: info.size,
        durationMatchesCatalog: durationMatches,
        video: video ?? null,
        audio: audio ?? null,
        error: sourceValid ? null : "SOURCE_PROFILE_INVALID",
      },
    });
  } catch (error) {
    validated.push({
      ...asset,
      lifecycle: "quarantined",
      airReady: false,
      validation: {
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCatalog: mediaPath,
  counts: {
    discovered: validated.length,
    validated: validated.filter((asset) => asset.airReady).length,
    quarantined: validated.filter((asset) => !asset.airReady).length,
  },
  assets: validated,
};
await mkdir(dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
await rename(temporary, outputPath);
console.log(
  `Validated ${report.counts.validated}/${report.counts.discovered} continuity assets; ${report.counts.quarantined} quarantined.`,
);
