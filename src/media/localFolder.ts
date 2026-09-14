import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { MediaAdapter, MediaScanResult, ProbeResult } from "./adapter.js";
import type { MediaItem } from "../domain/models.js";
import { probeDuration } from "./ffprobe.js";

const supportedExtensions = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".mov",
  ".avi",
  ".webm",
]);

export type MediaScanErrorCode =
  | "INVALID_SCAN_ROOT"
  | "SCAN_ROOT_NOT_FOUND"
  | "SCAN_ROOT_NOT_DIRECTORY"
  | "SCAN_ROOT_SYMLINK";

export class MediaScanError extends Error {
  constructor(
    public readonly code: MediaScanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MediaScanError";
  }
}

type Probe = (path: string) => Promise<ProbeResult | number | undefined>;

function metadataFromPath(path: string) {
  const extension = extname(path);
  const rawTitle = basename(path, extension);
  const episodeHint = rawTitle.match(/S(\d+)E(\d+)/i);
  const title = rawTitle.replaceAll("_", " ");
  const kind = /(?:^|[/\\])movies?(?:[/\\]|$)/i.test(path)
    ? "movie"
    : "episode";
  const hintedShow = episodeHint
    ? rawTitle
        .slice(0, episodeHint.index)
        .replace(/[_ .-]+$/, "")
        .replaceAll("_", " ")
    : undefined;
  return {
    extension,
    title,
    kind: kind as "episode" | "movie",
    showTitle: kind === "episode" ? hintedShow || title : undefined,
    season: episodeHint ? Number(episodeHint[1]) : undefined,
    episode: episodeHint ? Number(episodeHint[2]) : undefined,
  };
}

export async function validateMediaRoot(root: string) {
  if (!isAbsolute(root))
    throw new MediaScanError(
      "INVALID_SCAN_ROOT",
      "Media scan root must be an absolute path",
    );
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new MediaScanError(
        "SCAN_ROOT_NOT_FOUND",
        "Media scan root does not exist",
      );
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new MediaScanError(
      "SCAN_ROOT_SYMLINK",
      "Media scan root cannot be a symbolic link",
    );
  if (!stats.isDirectory())
    throw new MediaScanError(
      "SCAN_ROOT_NOT_DIRECTORY",
      "Media scan root must be a directory",
    );
  return realpath(root);
}

function normalizeProbe(result: ProbeResult | number | undefined): ProbeResult {
  if (typeof result === "number")
    return {
      durationMs: Number.isFinite(result) && result > 0 ? result : null,
    };
  if (!result) return { durationMs: null, reason: "Missing usable duration" };
  return result;
}

export class LocalFolderAdapter implements MediaAdapter {
  constructor(private readonly probe: Probe = probeDuration) {}

  async scan(root: string): Promise<MediaScanResult> {
    const scanRoot = await validateMediaRoot(root);
    const items: MediaItem[] = [];
    const diagnostics: MediaScanResult["diagnostics"] = [];

    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        diagnostics.push({
          code: "DIRECTORY_UNREADABLE",
          path: directory,
          message:
            error instanceof Error
              ? error.message
              : "Directory could not be read",
        });
        return;
      }
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const discoveredPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(discoveredPath);
          continue;
        }
        if (
          !entry.isFile() ||
          !supportedExtensions.has(extname(discoveredPath).toLowerCase())
        )
          continue;

        const path = await realpath(discoveredPath);
        let probed: ProbeResult;
        try {
          probed = normalizeProbe(await this.probe(path));
        } catch (error) {
          probed = {
            durationMs: null,
            reason:
              error instanceof Error ? error.message : "Duration probe failed",
          };
        }
        const metadata = metadataFromPath(path);
        items.push({
          id: `local-${Buffer.from(path).toString("base64url")}`,
          source: "local-folder",
          path,
          kind: metadata.kind,
          title: metadata.title,
          durationMs: probed.durationMs,
          durationStatus: probed.durationMs ? "ok" : "missing",
          showTitle: metadata.showTitle,
          season: metadata.season,
          episode: metadata.episode,
          available: Boolean(probed.durationMs),
          tags: [],
        });
        if (!probed.durationMs) {
          diagnostics.push({
            code: "MISSING_DURATION",
            path,
            message: probed.reason ?? "Missing usable duration",
          });
        }
      }
    };

    await walk(scanRoot);
    return { items, diagnostics };
  }
}
