import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ContinuityCardPlan } from "./director.js";
import { applyFamilyStyle } from "./families.js";
import { renderContinuityCard, wrapCardText } from "./render.js";

const run = promisify(execFile);

/**
 * The one output profile offline continuity cards are rendered to.
 *
 * It matches the already-validated station card profile so the files are
 * ordinary catalog media and need no adapter or playback change.
 */
export const CONTINUITY_RENDER_PROFILE = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  sampleRate: 48_000,
  channels: 2,
} as const;

export const DEFAULT_RENDER_TIMEOUT_MS = 120_000;

/** Families tint the raster the same way they tint the template preview. */
const familyColors: Record<
  ContinuityCardPlan["family"],
  { background: string; accent: string; detail: string; bar: "top" | "bottom" | "left" }
> = {
  syndication: { background: "0x392567", accent: "0xf3ce48", detail: "0xe1dfdb", bar: "bottom" },
  "local-cable": { background: "0x112d38", accent: "0x5ae1d6", detail: "0xe1dfdb", bar: "left" },
  "prime-time": { background: "0x1b2349", accent: "0xe9c143", detail: "0xe1dfdb", bar: "top" },
  overnight: { background: "0x10151e", accent: "0xcb986a", detail: "0xe1dfdb", bar: "bottom" },
};

/** The approved-template SVG preview for one plan (vector, no rasteriser needed). */
export function cardSvg(input: {
  plan: ContinuityCardPlan;
  template: string;
  logoDataUri?: string;
  production: boolean;
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

export function cardFileName(plan: ContinuityCardPlan) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        plan.contentHash,
        plan.cardType,
        plan.family,
        plan.label,
        plan.title,
        plan.details,
        plan.wordingKey,
        plan.durationMs,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return `${plan.broadcastDate}-${plan.cardType}-${plan.family}-${hash}`;
}

const drawtext = (
  textFile: string,
  font: string,
  size: number,
  color: string,
  x: number,
  y: number,
) =>
  [
    // `expansion=none` disables drawtext's `%{...}` expansion, so an arbitrary
    // title that happens to contain a percent sign is drawn literally instead
    // of being interpreted (or failing) as a filter expression.
    "drawtext=expansion=none",
    `textfile=${escapeFilterValue(textFile)}`,
    escapeFilterValue(font),
    `fontcolor=${escapeFilterValue(color)}`,
    `fontsize=${size}`,
    `x=${x}`,
    `y=${y}`,
  ].join(":");

/** Escape a path/value for use inside an ffmpeg filter argument. */
export function escapeFilterValue(value: string) {
  return value
    .replace(/\\/gu, "\\\\\\\\")
    .replace(/:/gu, "\\:")
    .replace(/'/gu, "\\'")
    .replace(/,/gu, "\\,");
}

/**
 * ffmpeg arguments that compose one card.
 *
 * Text is supplied through `textfile=` entries rather than inline, so a title
 * containing a colon, comma, percent sign or apostrophe cannot be interpreted
 * as filter syntax. The raster deliberately reuses the plan's copy, palette and
 * canonical logo; the SVG preview keeps the approved template artwork.
 */
export function rasterArgs(input: {
  plan: ContinuityCardPlan;
  logoPath: string;
  outputPath: string;
  textFiles: { label: string; title: string[]; details: string[] };
  /** Either `fontfile=/path/to.ttf` or `font=Family Name`. */
  font: string;
  still: boolean;
}) {
  const colors = familyColors[input.plan.family];
  const titleLines = input.textFiles.title;
  const detailLines = input.textFiles.details.slice(0, 4);
  const filters: string[] = [
    drawtext(input.textFiles.label, input.font, 52, colors.accent, 120, 170),
    ...titleLines.map((file, index) =>
      drawtext(file, input.font, index === 0 ? 96 : 88, "white", 120, 300 + index * 120),
    ),
    ...detailLines.map((file, index) =>
      drawtext(file, input.font, 44, colors.detail, 120, 620 + index * 66),
    ),
  ];
  const bar =
    colors.bar === "top"
      ? `drawbox=x=0:y=0:w=1920:h=12:color=${colors.accent}:t=fill`
      : colors.bar === "bottom"
        ? `drawbox=x=0:y=1068:w=1920:h=12:color=${colors.accent}:t=fill`
        : `drawbox=x=0:y=0:w=12:h=1080:color=${colors.accent}:t=fill`;
  const filterGraph =
    `[0:v]${[...filters, bar].join(",")}[card];` +
    `[1:v]scale=300:-1[logo];[card][logo]overlay=1540:60[v]`;
  const durationSeconds = (input.plan.durationMs / 1_000).toFixed(3);
  const args = [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${colors.background}:s=1920x1080:r=${CONTINUITY_RENDER_PROFILE.frameRate}`,
    "-loop",
    "1",
    "-i",
    input.logoPath,
    ...(input.still
      ? []
      : [
          "-f",
          "lavfi",
          "-i",
          `anullsrc=r=${CONTINUITY_RENDER_PROFILE.sampleRate}:cl=stereo`,
        ]),
    "-filter_complex",
    filterGraph,
    "-map",
    "[v]",
  ];
  if (input.still) {
    args.push("-frames:v", "1", "-update", "1");
  } else {
    args.push(
      "-map",
      "2:a",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
    );
  }
  args.push(
    "-t",
    durationSeconds,
    "-r",
    String(CONTINUITY_RENDER_PROFILE.frameRate),
    // The still is written by the image encoder inferred from its extension;
    // only the MP4 carries the H.264/AAC delivery profile.
    ...(input.still
      ? []
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]),
    input.outputPath,
  );
  return args;
}

/** Writes the wrapped copy lines to per-line files drawtext can read safely. */
export async function writeTextFiles(directory: string, plan: ContinuityCardPlan) {
  // Every text boundary is validated before anything is written: a label that
  // cannot be laid out, or copy that needs more lines than the card has room
  // for, fails the render instead of being silently clipped.
  const label = wrapCardText(plan.label, 32, 1)[0] ?? "";
  const titleLines = wrapCardText(plan.title, 27, 2);
  const detailLines = plan.details.flatMap((detail) => wrapCardText(detail, 40, 2));
  if (detailLines.length > 4) throw new Error("Text does not fit: too many detail lines");
  const write = async (name: string, value: string) => {
    const file = join(directory, `${name}.txt`);
    await writeFile(file, value.replace(/\r?\n/gu, " "), "utf8");
    return file;
  };
  const labelFile = await write("label", label);
  const title: string[] = [];
  for (const [index, line] of titleLines.entries())
    title.push(await write(`title-${index}`, line));
  const details: string[] = [];
  for (const [index, line] of detailLines.entries())
    details.push(await write(`detail-${index}`, line));
  return {
    label: labelFile,
    title,
    details,
    cleanup: async () => void (await rm(directory, { recursive: true, force: true })),
  };
}

/**
 * Capability cache keyed by executable.
 *
 * Two builds can be installed side by side - the distribution `ffmpeg` without
 * libfreetype and a Homebrew build with drawtext - so a single global boolean
 * would have let one build's limitation disable the other.
 */
const drawtextSupport = new Map<string, Promise<boolean>>();

/** Whether the chosen ffmpeg can render text (libfreetype build). */
export async function ffmpegHasDrawtext(ffmpeg: string) {
  const cached = drawtextSupport.get(ffmpeg);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const { stdout } = await run(ffmpeg, ["-hide_banner", "-filters"], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: DEFAULT_RENDER_TIMEOUT_MS,
      });
      // Both filters are needed: drawtext rasterises the card copy and drawbox
      // paints the family accent bar.
      return /\bdrawtext\b/u.test(stdout) && /\bdrawbox\b/u.test(stdout);
    } catch {
      return false;
    }
  })();
  drawtextSupport.set(ffmpeg, probe);
  return probe;
}

/**
 * The installed ffmpeg builds worth trying, most specific first.
 *
 * Playback keeps whatever FFmpeg configuration it already has; this only picks
 * a binary for the *offline* card render, and only one whose build actually
 * carries the filters the card needs.
 */
export function ffmpegCandidates(options: { preferred?: string; path?: string } = {}) {
  const candidates: string[] = [];
  if (options.preferred) candidates.push(options.preferred);
  if (process.env.CONTINUITY_FFMPEG) candidates.push(process.env.CONTINUITY_FFMPEG);
  candidates.push(
    "/opt/homebrew/opt/ffmpeg@7/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  );
  const onPath = (options.path ?? process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((entry) => join(entry, "ffmpeg"));
  candidates.push(...onPath);
  return [...new Set(candidates)];
}

/** First installed render binary that can actually draw the card copy. */
export async function selectFfmpegBinary(options: {
  preferred?: string;
  path?: string;
} = {}): Promise<string | undefined> {
  for (const candidate of ffmpegCandidates(options)) {
    if (await ffmpegHasDrawtext(candidate)) return candidate;
  }
  return undefined;
}

export type ProbeResult = {
  durationMs: number;
  profileValid: boolean;
  video: Record<string, unknown> | null;
  audio: Record<string, unknown> | null;
};

/** Measure a rendered file and check it against the one approved profile. */
export async function probeRendered(ffprobe: string, path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
      "-of",
      "json",
      path,
    ],
    { maxBuffer: 1024 * 1024, timeout: DEFAULT_RENDER_TIMEOUT_MS },
  );
  const probe = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string };
  };
  const video = probe.streams?.find((stream) => stream.codec_type === "video") ?? null;
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio") ?? null;
  const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1_000);
  const profileValid = Boolean(
    video &&
      video.codec_name === CONTINUITY_RENDER_PROFILE.videoCodec &&
      video.width === CONTINUITY_RENDER_PROFILE.width &&
      video.height === CONTINUITY_RENDER_PROFILE.height &&
      audio &&
      audio.codec_name === CONTINUITY_RENDER_PROFILE.audioCodec &&
      Number(audio.sample_rate) === CONTINUITY_RENDER_PROFILE.sampleRate &&
      audio.channels === CONTINUITY_RENDER_PROFILE.channels,
  );
  return { durationMs, profileValid, video, audio };
}

/** Decode the whole file so a truncated or unreadable render is caught. */
export async function decodeRendered(ffmpeg: string, path: string) {
  await run(ffmpeg, ["-v", "error", "-i", path, "-f", "null", "-"], {
    maxBuffer: 1024 * 1024,
    timeout: DEFAULT_RENDER_TIMEOUT_MS,
  });
}

export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  timeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
) {
  const options = { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs };
  // `nice` keeps a long render from monopolising the machine, but it is not
  // universally spawnable (some sandboxes forbid it); fall back to a direct
  // invocation rather than failing the render.
  try {
    await run("nice", ["-n", "10", ffmpeg, ...args], options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOENT") throw error;
    await run(ffmpeg, args, options);
  }
}

export const readTemplate = async (repoRoot: string, template: string) =>
  readFile(join(repoRoot, "assets", "continuity", "templates", `${template}.svg`), "utf8");
