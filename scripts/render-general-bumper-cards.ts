#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

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
const inputPath = required("manifest");
const output = required("out");
const ffmpeg = values.get("ffmpeg") ?? "ffmpeg";
const ffprobe = values.get("ffprobe") ?? "ffprobe";
const hashFile = (path: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
const input = JSON.parse(await readFile(inputPath, "utf8")) as {
  cards: Array<{
    id: string;
    sourceName: string;
    path: string;
    sha256: string;
    role: string;
  }>;
};
await mkdir(output, { recursive: true });

const renders = [];
for (const card of input.cards) {
  const actualSourceHash = await hashFile(card.path);
  if (actualSourceHash !== card.sha256)
    throw new Error(`Prepared source hash mismatch: ${card.sourceName}`);
  const profile = {
    durationMs: 5_000,
    width: 1920,
    height: 1080,
    frameRate: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    sampleRate: 48_000,
    channels: 2,
  };
  const renderHash = createHash("sha256")
    .update(JSON.stringify({ source: card.sha256, profile, approval: "user-approved-legacy-card" }))
    .digest("hex");
  const filename = `${renderHash.slice(0, 20)}-${card.sourceName.replace(/\.png$/u, "")}.mp4`;
  const destination = join(output, filename);
  const temporary = `${destination}.${process.pid}.tmp.mp4`;
  try {
    await readFile(destination);
  } catch {
    await run("nice", [
      "-n", "10", ffmpeg, "-v", "error", "-loop", "1", "-i", card.path,
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "5",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p",
      "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", temporary,
    ], { maxBuffer: 1024 * 1024 });
    await rename(temporary, destination);
  }
  await run(ffmpeg, ["-v", "error", "-i", destination, "-f", "null", "-"], {
    maxBuffer: 1024 * 1024,
  });
  const { stdout } = await run(ffprobe, [
    "-v", "error", "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
    "-of", "json", destination,
  ], { maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout) as {
    streams?: Array<Record<string, string | number>>;
    format?: { duration?: string };
  };
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const durationMs = Math.round(Number(probe.format?.duration) * 1_000);
  const profileValid = Boolean(
    video?.codec_name === "h264" && video.width === 1920 && video.height === 1080 &&
      audio?.codec_name === "aac" && Number(audio.sample_rate) === 48_000 && audio.channels === 2 &&
      durationMs === profile.durationMs,
  );
  const staged = card.role === "interruption";
  const outputSha256 = await hashFile(destination);
  renders.push({
    ...card,
    outputPath: destination,
    renderHash,
    outputSha256,
    durationMs,
    profile,
    validation: { decoded: true, profileValid, video, audio },
    lifecycle: profileValid ? "validated" : "quarantined",
    airReady: profileValid && !staged,
    eligible: profileValid && !staged,
    rejectReason: staged ? "STAGED_INTERRUPTION_DISABLED" : profileValid ? null : "SOURCE_PROFILE_INVALID",
    reason: staged ? "STAGED_INTERRUPTION_DISABLED" : profileValid ? null : "SOURCE_PROFILE_INVALID",
    branding: "user-approved finished legacy card; not a canonical-logo substitute",
  });
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  approval: "user-approved-finished-legacy-card-artwork",
  audio: "continuous silent stereo AAC; no new voice generated",
  counts: {
    rendered: renders.length,
    validated: renders.filter((render) => render.validation.profileValid).length,
    eligible: renders.filter((render) => render.eligible).length,
    stagedQuarantined: renders.filter((render) => render.rejectReason === "STAGED_INTERRUPTION_DISABLED").length,
  },
  renders,
};
const manifestPath = join(output, "manifest.json");
const temporary = `${manifestPath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
await rename(temporary, manifestPath);
console.log(
  `Rendered ${manifest.counts.validated}/${manifest.counts.rendered} cards; ${manifest.counts.eligible} eligible and ${manifest.counts.stagedQuarantined} staged/quarantined.`,
);
