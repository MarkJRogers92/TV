import type { RemoteFile } from "./providerTypes.js";

export const videoExtensions = ["mkv", "mp4", "avi", "m4v", "mov", "webm"] as const;
const videoExtensionSet = new Set<string>(videoExtensions);
export const maximumSeasonNumber = 99;
export const maximumEpisodeNumber = 999;

export function isVideoExtension(extension: string): boolean {
  const normalized = extension.toLowerCase();
  return videoExtensionSet.has(normalized.startsWith(".") ? normalized.slice(1) : normalized);
}

export type VideoResolution = "480p" | "720p" | "1080p" | "1440p" | "2160p";

/**
 * Trust controls for {@link parseVideoCandidate}. Provider filenames are
 * untrusted input, so every flag defaults to the untrusted behavior.
 */
export interface ParseVideoCandidateOptions {
  /**
   * Treat a canonical `Series - SxxEyy - Title` name as authoritative managed
   * metadata, so an episode title that reads like an extra ("Sample",
   * "Trailer", "Featurette", "Extras") is preserved. Only managed library
   * scans may enable this: a remote provider can imitate the canonical shape.
   */
  readonly trustedManagedCanonical?: boolean;
}

export interface ParsedVideoCandidate extends RemoteFile {
  readonly bytes: number | null;
  readonly seriesTitle: string | null;
  readonly episodeTitle: string | null;
  readonly season: number;
  readonly episode: number;
  readonly episodeEnd: number | null;
  readonly multiEpisode: boolean;
  readonly resolution: VideoResolution | null;
  readonly resolutionHeight: number | null;
}

const forbiddenExtraWords = new Set(["sample", "samples", "trailer", "featurette", "featurettes", "extra", "extras"]);
const releaseSuffixWords = new Set([
  "web", "webdl", "webrip", "bluray", "bdrip", "hdtv", "dvdrip", "x264", "x265", "h264", "h265", "hevc", "avc", "aac", "ddp", "dts", "truehd", "remux", "proper", "repack", "group",
]);

function safeRemotePath(value: string): boolean {
  if (value.includes("\0") || value.startsWith("/") || /^[a-z]:[\\/]/i.test(value)) return false;
  return value.split(/[\\/]/).every((part) => part !== "..");
}

function displayWords(value: string): string[] {
  return value
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function cleanTitle(value: string): string | null {
  const words = displayWords(value);
  const releaseStart = words.findIndex((word) => {
    const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    return releaseSuffixWords.has(normalized) || /^(480|720|1080|1440|2160)p$/i.test(normalized) || /^(4k|2k|uhd|fhd)$/i.test(normalized);
  });
  if (releaseStart >= 0) words.splice(releaseStart);
  while (words.length > 0) {
    const last = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (releaseSuffixWords.has(last) || /^(480|720|1080|1440|2160)p$/i.test(last) || /^(4k|2k|uhd|fhd)$/i.test(last)) words.pop();
    else break;
  }
  const result = words.join(" ").trim().replace(/\s+-\s*$/, "").trim();
  return result || null;
}

function resolutionFrom(value: string): VideoResolution | null {
  const normalized = value.toLowerCase();
  if (/(?:^|[^a-z0-9])(2160p|4k|uhd)(?:$|[^a-z0-9])/.test(normalized)) return "2160p";
  if (/(?:^|[^a-z0-9])(1440p|2k)(?:$|[^a-z0-9])/.test(normalized)) return "1440p";
  if (/(?:^|[^a-z0-9])(1080p|fhd)(?:$|[^a-z0-9])/.test(normalized)) return "1080p";
  if (/(?:^|[^a-z0-9])720p(?:$|[^a-z0-9])/.test(normalized)) return "720p";
  if (/(?:^|[^a-z0-9])480p(?:$|[^a-z0-9])/.test(normalized)) return "480p";
  return null;
}

function invalidEpisode(season: number, episode: number, end: number | null): boolean {
  return season < 0 || season > maximumSeasonNumber || episode < 0 || episode > maximumEpisodeNumber || (end !== null && (end < episode || end > maximumEpisodeNumber));
}

/**
 * Parse a safe video filename without interpreting a provider URL or token.
 * The second argument is the trust switch from
 * {@link ParseVideoCandidateOptions}; a bare boolean is accepted as shorthand
 * for `trustedManagedCanonical`. It defaults to untrusted provider parsing.
 */
export function parseVideoCandidate(
  file: RemoteFile,
  options: ParseVideoCandidateOptions | boolean = {},
): ParsedVideoCandidate | null {
  if (!file.originalFilename || file.originalFilename.includes("\0") || /[\\/]/.test(file.originalFilename) || !safeRemotePath(file.remotePath)) return null;
  const extensionMatch = /\.([a-z0-9]+)$/i.exec(file.originalFilename);
  if (!extensionMatch || !isVideoExtension(extensionMatch[1])) return null;

  const trustedManagedCanonical =
    typeof options === "boolean" ? options : options.trustedManagedCanonical === true;
  const stem = file.originalFilename.slice(0, -extensionMatch[0].length);

  // Canonical names deliberately keep their episode title, including release-like words.
  const canonical = /^(.*?)\s+-\s+[sS](\d{1,3})[eE](\d{1,4})(?:\s*(?:-|\s)[eE](\d{1,4}))?\s+-\s+(.*?)\s*$/.exec(stem);
  let seriesTitle: string | null;
  let episodeTitle: string | null;
  let season: number;
  let episode: number;
  let episodeEnd: number | null = null;
  if (canonical) {
    seriesTitle = canonical[1].trim() || null;
    season = Number(canonical[2]);
    episode = Number(canonical[3]);
    episodeEnd = canonical[4] === undefined ? null : Number(canonical[4]);
    episodeTitle = canonical[5].trim() || null;
  } else {
    const match = /(?:^|[ ._-])(?:s(\d{1,3})e(\d{1,4})(?:(?:[ ._-]*e?)(\d{1,4}))?|(\d{1,3})x(\d{1,4})(?:[ ._-]*(\d{1,4}))?)(?=$|[ ._-])/i.exec(stem);
    if (!match) return null;
    season = Number(match[1] ?? match[4]);
    episode = Number(match[2] ?? match[5]);
    episodeEnd = match[3] !== undefined ? Number(match[3]) : match[6] !== undefined ? Number(match[6]) : null;
    const markerStart = match.index + (match[0].length - match[0].trimStart().length);
    const before = stem.slice(0, markerStart).replace(/[ ._-]+$/, "");
    const after = stem.slice(match.index + match[0].length).replace(/^[ ._-]+/, "");
    seriesTitle = cleanTitle(before);
    episodeTitle = cleanTitle(after);
  }
  // Extras-style words in the episode title mark an unsafe extra. Managed
  // canonical names are trusted metadata and may keep those words verbatim,
  // but a remote provider filename can imitate the canonical shape, so every
  // other parse rejects them.
  const trustedCanonicalTitle = canonical !== null && trustedManagedCanonical;
  if (!trustedCanonicalTitle && displayWords(episodeTitle ?? "").some((word) => forbiddenExtraWords.has(word.toLowerCase()))) return null;
  if (invalidEpisode(season, episode, episodeEnd)) return null;
  const resolution = resolutionFrom(stem);
  return {
    ...file,
    bytes: typeof file.bytes === "number" && Number.isFinite(file.bytes) && file.bytes >= 0 ? Math.floor(file.bytes) : null,
    seriesTitle,
    episodeTitle,
    season,
    episode,
    episodeEnd,
    multiEpisode: episodeEnd !== null,
    resolution,
    resolutionHeight: resolution === null ? null : Number.parseInt(resolution, 10),
  };
}
