import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { MediaAdapter, MediaScanResult, ProbeResult } from "./adapter.js";
import type { MediaItem } from "../domain/models.js";
import { probeDuration } from "./ffprobe.js";
import {
  isVideoExtension,
  parseVideoCandidate,
} from "../acquisition/filename.js";
import { assertManagedDirectory, type ManagedDirectoryIdentity } from "../acquisition/paths.js";

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
  // Managed library names are produced by canonicalVideoName, so their
  // canonical episode titles are trusted metadata and keep words such as
  // "Trailer", "Extras", or "Featurette" verbatim.
  const parsed = parseVideoCandidate(
    {
      provider: "real-debrid",
      itemType: "torrent",
      remoteItemId: "local-scan",
      remoteFileId: path,
      originalFilename: basename(path),
      remotePath: basename(path),
      bytes: null,
    },
    { trustedManagedCanonical: true },
  );
  if (parsed) {
    return {
      extension,
      title: parsed.episodeTitle ?? rawTitle.replaceAll("_", " "),
      kind: "episode" as const,
      showTitle: parsed.seriesTitle ?? rawTitle.replaceAll("_", " "),
      season: parsed.season,
      episode: parsed.episode,
    };
  }
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
  if (result.hasVideoStream === false)
    return { durationMs: null, hasVideoStream: false, reason: result.reason ?? "Missing readable video stream" };
  return result;
}

export class LocalFolderAdapter implements MediaAdapter {
  constructor(
    private readonly probe: Probe = probeDuration,
    private readonly expectedRoot?: ManagedDirectoryIdentity,
  ) {}

  async scan(root: string): Promise<MediaScanResult> {
    const scanRoot = await validateMediaRoot(root);
    if (this.expectedRoot) await assertManagedDirectory(this.expectedRoot);
    const items: MediaItem[] = [];
    const diagnostics: MediaScanResult["diagnostics"] = [];

    const walk = async (directory: string): Promise<void> => {
      if (this.expectedRoot) await assertManagedDirectory(this.expectedRoot);
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
          !isVideoExtension(extname(discoveredPath))
        )
          continue;

        const path = await realpath(discoveredPath);
        // dev+ino is the file's identity across a same-filesystem rename: it
        // does not change when the path does, which is what lets the catalog
        // join a moved file back to the ID it already had. `realpath` may have
        // resolved a link, so stat the resolved path; a race that removes the
        // file between the listing and here just leaves the item unidentified.
        let identity: {
          deviceId: string;
          inode: string;
          fileSizeBytes: string;
          fileModifiedMs: string;
          fileBirthMs: string;
        } | undefined;
        try {
          const stats = await stat(path);
          identity = {
            deviceId: String(stats.dev),
            inode: String(stats.ino),
            fileSizeBytes: String(stats.size),
            fileModifiedMs: String(stats.mtimeMs),
            fileBirthMs: String(stats.birthtimeMs),
          };
        } catch {
          identity = undefined;
        }
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
          deviceId: identity?.deviceId,
          inode: identity?.inode,
          fileSizeBytes: identity?.fileSizeBytes,
          fileModifiedMs: identity?.fileModifiedMs,
          fileBirthMs: identity?.fileBirthMs,
          kind: metadata.kind,
          title: metadata.title,
          durationMs: probed.durationMs,
          durationStatus: probed.durationMs ? "ok" : "missing",
          showTitle: metadata.showTitle,
          season: metadata.season,
          episode: metadata.episode,
          available: Boolean(probed.durationMs) && probed.hasVideoStream !== false,
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
    if (this.expectedRoot) await assertManagedDirectory(this.expectedRoot);
    return { items, diagnostics };
  }

  /** Inspects one settled candidate without probing every other file in its root. */
  async scanFile(root: string, candidatePath: string): Promise<MediaItem> {
    const scanRoot = await validateMediaRoot(root);
    if (this.expectedRoot) await assertManagedDirectory(this.expectedRoot);
    const rel = relative(scanRoot, candidatePath);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new MediaScanError("INVALID_SCAN_ROOT", "Media candidate must be inside its registered root");

    const before = await lstat(candidatePath);
    if (!before.isFile() || before.isSymbolicLink() || !(await realpath(candidatePath)).startsWith(`${scanRoot}${sep}`))
      throw new MediaScanError("INVALID_SCAN_ROOT", "Media candidate is not a regular file inside its registered root");
    if (!isVideoExtension(extname(candidatePath)))
      throw new MediaScanError("INVALID_SCAN_ROOT", "Media candidate has an unsupported video extension");
    const beforeHash = await hashFile(candidatePath);
    let probed: ProbeResult;
    try {
      probed = normalizeProbe(await this.probe(candidatePath));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Media probe failed");
    }
    const after = await lstat(candidatePath);
    if (!after.isFile() || after.isSymbolicLink() ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        beforeHash !== await hashFile(candidatePath))
      throw new Error("Media source changed while it was being probed");
    if (this.expectedRoot) await assertManagedDirectory(this.expectedRoot);

    const metadata = metadataFromPath(candidatePath);
    return {
      id: `local-${Buffer.from(candidatePath).toString("base64url")}`,
      source: "local-folder",
      path: candidatePath,
      deviceId: String(after.dev),
      inode: String(after.ino),
      fileSizeBytes: String(after.size),
      fileModifiedMs: String(after.mtimeMs),
      fileBirthMs: String(after.birthtimeMs),
      kind: metadata.kind,
      title: metadata.title,
      durationMs: probed.durationMs,
      durationStatus: probed.durationMs ? "ok" : "missing",
      showTitle: metadata.showTitle,
      season: metadata.season,
      episode: metadata.episode,
      available: Boolean(probed.durationMs) && probed.hasVideoStream !== false,
      tags: [],
    };
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
