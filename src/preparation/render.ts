import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { setPriority } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PreparationJob } from "./models.js";
import { collectPreflightEvidence, type PreflightEvidence, type PreflightMetadata } from "./preflight.js";
import { readSourceVersion, sourceVersionsEqual } from "./sourceVersion.js";

const run = promisify(execFile);
const PROFILE = "marktv-prepared-mp4-remux-v1";
const CACHE_CAP = 20 * 1024 ** 3;
const MIN_FREE = 15 * 1024 ** 3;

export type PreparedRendition = NonNullable<PreparationJob["rendition"]>;

/** Keep the existing explicit request available while automatic detection grows. */
export function requestedPreparation(tags: readonly string[]): "remux" | null {
  return tags.includes("preparation:needs-remux") ? "remux" : null;
}

/** Remux only a measured MP4 seek-index defect when stream-copy is lossless. */
export function remuxEligible(metadata: PreflightMetadata): boolean {
  if (metadata.status !== "passed" || metadata.mp4MoovBeforeMdat !== false) return false;
  if (!metadata.containerFormatNames.some((name) => name === "mov" || name === "mp4")) return false;
  if (metadata.unsupportedTrackCount !== 0) return false;
  if (metadata.tracks.filter((track) => track.type === "video").length !== 1) return false;
  const video = metadata.tracks.find((track) => track.type === "video" && track.selected);
  const audioTracks = metadata.tracks.filter((track) => track.type === "audio");
  const subtitles = metadata.tracks.filter((track) => track.type === "subtitle");
  // Keep this profile deliberately narrow: it preserves one H.264 video track
  // and at most one AAC audio track. Other layouts require a track-preserving
  // profile rather than silently dropping content.
  return video?.codec === "h264" && subtitles.length === 0 && audioTracks.length <= 1 &&
    (audioTracks.length === 0 || audioTracks[0]?.codec === "aac");
}

async function occupiedBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    total += (await stat(join(directory, entry.name))).size;
  }
  return total;
}

/** Never clean up pinned or unknown outputs automatically; defer when the cap/floor is tight. */
async function outputBudget(directory: string, sourceBytes: number): Promise<number> {
  const volume = await statfs(directory);
  const free = volume.bavail * volume.bsize;
  const floor = Math.max(MIN_FREE, volume.blocks * volume.bsize * 0.1);
  const headroom = Math.min(CACHE_CAP - await occupiedBytes(directory), free - floor);
  if (headroom < Math.max(64 * 1024 ** 2, sourceBytes * 1.1))
    throw new Error("preparation_storage_headroom");
  return Math.floor(headroom);
}

/**
 * Build one immutable cache file. The caller must hold the repository's sole
 * running-job lease and publish its catalog record only after this returns.
 */
export async function renderPreparedRendition(input: {
  job: PreparationJob;
  evidence: PreflightEvidence;
  mode: "remux";
  cacheDirectory: string;
  now?: () => Date;
}): Promise<{ rendition: PreparedRendition; validation: PreflightEvidence }> {
  const { job, evidence, mode, cacheDirectory } = input;
  if (evidence.result !== "sampled" && evidence.result !== "fully_decoded") throw new Error("source_not_decode_ready");
  const video = evidence.metadata.selectedVideoTrackIndex;
  const audio = evidence.metadata.selectedAudioTrackIndex;
  if (video === null) throw new Error("missing_selected_video");
  // This MP4 profile cannot promise preservation of PGS/forced subtitles or
  // alternate language tracks. Keep the original until that contract is solved.
  if (evidence.metadata.tracks.some((track) => track.type === "subtitle") ||
      evidence.metadata.tracks.filter((track) => track.type === "audio").length > 1 ||
      evidence.metadata.tracks.filter((track) => track.type === "video").length !== 1 ||
      evidence.metadata.unsupportedTrackCount !== 0)
    throw new Error("alternate_tracks_require_review");
  if (!sourceVersionsEqual(job.source, await readSourceVersion(job.source.path))) throw new Error("source_changed");
  await mkdir(cacheDirectory, { recursive: true });
  const { stdout } = await run("ffmpeg", ["-version"], { timeout: 10_000, maxBuffer: 8192 });
  const toolBuild = stdout.split("\n")[0] ?? "unknown";
  const id = createHash("sha256").update(JSON.stringify([
    job.sourceVersionKey, video, audio, mode, PROFILE, toolBuild,
  ])).digest("hex");
  const path = join(cacheDirectory, `${id}.mp4`);
  const validate = async (candidate: string) => {
    const file = await lstat(candidate);
    if (!file.isFile() || file.isSymbolicLink() || file.size === 0) throw new Error("rendition_not_regular_file");
    const validation = await collectPreflightEvidence(candidate, { level: "full", timeoutMs: 4 * 60 * 60 * 1000 });
    if (validation.result !== "fully_decoded") throw new Error(`rendition_${validation.result}`);
    if (validation.metadata.mp4MoovBeforeMdat !== true) throw new Error("rendition_faststart_unverified");
    const duration = evidence.metadata.durationSeconds;
    const actual = validation.metadata.durationSeconds;
    if (duration === null || actual === null || Math.abs(duration - actual) > 1) throw new Error("rendition_duration_mismatch");
    if (audio !== null && validation.metadata.selectedAudioTrackIndex === null) throw new Error("rendition_missing_audio");
    if (!sourceVersionsEqual(job.source, await readSourceVersion(job.source.path))) throw new Error("source_changed");
    return validation;
  };
  const finish = (validation: PreflightEvidence) => ({
    rendition: { id, path, profile: PROFILE, mode,
      validatedAt: (input.now ?? (() => new Date()))().toISOString(),
      validation: { metadata: validation.metadata, fullDecode: validation.fullDecode } },
    validation,
  });
  try {
    await lstat(path);
    return finish(await validate(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const maxBytes = await outputBudget(cacheDirectory, Number(job.source.sizeBytes));
  const temporary = join(cacheDirectory, `.${id}.${randomUUID()}.mp4`);
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-i", job.source.path,
    "-map", `0:${video}`, ...(audio === null ? [] : ["-map", `0:${audio}`]),
    "-map_metadata", "0", "-map_chapters", "0", "-fs", String(maxBytes)];
  args.push("-c", "copy");
  args.push("-movflags", "+faststart", "-y", temporary);
  try {
    // nice keeps serving processes ahead of this background work.
    const child = execFile("nice", ["-n", "10", "ffmpeg", ...args], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 256 * 1024 });
    if (child.pid) { try { setPriority(child.pid, 10); } catch { /* best effort */ } }
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg_exit_${code}`)));
    });
    if (!sourceVersionsEqual(job.source, await readSourceVersion(job.source.path))) throw new Error("source_changed");
    const validation = await validate(temporary);
    // A hard link publishes atomically without replacing a file pinned by an
    // existing schedule. A colliding existing key is left intact.
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return finish(await validate(path));
    }
    return finish(validation);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
