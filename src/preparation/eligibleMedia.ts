import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Repositories } from "../db/repositories.js";
import type { MediaItem } from "../domain/models.js";
import type { PreparationJob } from "./models.js";
import { readSourceVersionSync, sourceVersionsEqual } from "./sourceVersion.js";

const verifiedFiles = new Set<string>();

function symlinkFree(path: string): boolean {
  let current = resolve(path);
  while (current !== dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) return false;
    current = dirname(current);
  }
  return true;
}

/** A stored path is only a hint. Reconfirm its location and bounded decode before it can be scheduled. */
function verifiedRenditionPath(job: PreparationJob, cacheDirectory: string): string | null {
  const rendition = job.rendition;
  if (!rendition || !isAbsolute(rendition.path) || !/^[a-f0-9]{64}$/.test(rendition.id) ||
      basename(rendition.path) !== `${rendition.id}.mp4`) return null;
  const root = realpathSync.native(cacheDirectory);
  const path = realpathSync.native(rendition.path);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ||
      !symlinkFree(cacheDirectory) || !symlinkFree(rendition.path)) return null;
  const file = lstatSync(path);
  if (!file.isFile() || file.size <= 0) return null;
  const expected = rendition.validation.metadata as { status?: unknown; durationSeconds?: unknown; selectedAudioTrackIndex?: unknown };
  const decoded = rendition.validation.fullDecode as { status?: unknown };
  if (expected.status !== "passed" || decoded.status !== "passed" ||
      typeof expected.durationSeconds !== "number" || expected.durationSeconds <= 0 ||
      (expected.selectedAudioTrackIndex !== null &&
       (typeof expected.selectedAudioTrackIndex !== "number" || !Number.isInteger(expected.selectedAudioTrackIndex)))) return null;
  const key = [path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs,
    rendition.id, expected.durationSeconds].join(":");
  if (!verifiedFiles.has(key)) {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
      "format=duration:stream=codec_type", "-of", "json", "--", path],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"] })) as {
      format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || Math.abs(duration - expected.durationSeconds) > 1 ||
        !probe.streams?.some((track) => track.codec_type === "video") ||
        (expected.selectedAudioTrackIndex !== null && !probe.streams.some((track) => track.codec_type === "audio")))
      return null;
    const starts = [...new Set([0, Math.max(0, duration / 2 - 0.5), Math.max(0, duration - 1)]
      .map((value) => value.toFixed(3)))];
    for (const start of starts) {
      execFileSync("ffmpeg", ["-v", "error", "-xerror", "-ss", start, "-i", path,
        "-t", "1", "-map", "0:v:0", ...(expected.selectedAudioTrackIndex === null ? [] : ["-map", "0:a:0"]),
        "-f", "null", "-"], { timeout: 5_000, maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"] });
    }
    // If the file changed while decoding, this verdict does not apply.
    const after = lstatSync(path);
    if (after.size !== file.size || after.mtimeMs !== file.mtimeMs || after.ctimeMs !== file.ctimeMs ||
        after.dev !== file.dev || after.ino !== file.ino) return null;
    if (verifiedFiles.size >= 2_000) verifiedFiles.clear();
    verifiedFiles.add(key);
  }
  return path;
}

/** Apply only verdicts for the exact catalogued file version. Pool IDs remain logical IDs. */
export function preparationEligibleMedia(repositories: Repositories, items: readonly MediaItem[]): MediaItem[] {
  const jobs = new Map<string, PreparationJob>();
  for (const job of repositories.preparation.jobs.list()) {
    const prior = jobs.get(job.sourceMediaId);
    if (!prior || Date.parse(job.updatedAt) > Date.parse(prior.updatedAt)) jobs.set(job.sourceMediaId, job);
  }
  return items.map((item) => {
    if (item.source !== "local-folder" || !item.path || item.sourceMediaId) return item;
    const job = jobs.get(item.id);
    if (!job || (job.state !== "completed" && job.state !== "stale") || job.source.path !== item.path ||
      job.source.sizeBytes !== item.fileSizeBytes || job.source.modifiedMs !== item.fileModifiedMs ||
      job.source.deviceId !== item.deviceId || job.source.inode !== item.inode) return item;
    if (job.classification === "unavailable") {
      try { readSourceVersionSync(item.path); return item; }
      catch { return { ...item, available: false }; }
    }
    try {
      if (!sourceVersionsEqual(job.source, readSourceVersionSync(item.path))) return item;
      if (job.classification === "quarantined") return { ...item, available: false };
      if (job.state !== "completed" || !job.rendition) return item;
      const path = verifiedRenditionPath(job, repositories.preparation.cacheDirectory);
      return path ? { ...item, path } : item;
    } catch {
      // A missing proven-corrupt source cannot be treated as a fresh version.
      // For a missing cache file, the working original remains the fallback.
      return job.classification === "quarantined" ? { ...item, available: false } : item;
    }
  });
}
