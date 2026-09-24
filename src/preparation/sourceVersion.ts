import { lstat } from "node:fs/promises";
import type { PreparationSourceVersion } from "./models.js";

/**
 * The single canonical reader for a preparation source version.
 *
 * The representation is not free to choose: the media catalog stores
 * `String(stats.mtimeMs)`, `String(stats.size)`, `String(stats.dev)` and
 * `String(stats.ino)` from a **non-bigint `lstat`** (`LocalFolderAdapter`), and
 * the preparation repository compares those strings for exact equality and
 * hashes them into the job's version key. Every caller therefore has to agree:
 *
 *  - A bigint `stat` truncates the fractional millisecond
 *    (`"1720000000000"` vs `"1720000000000.17"`), so a job recorded by the
 *    intake runner would look changed to any other reader and be invalidated.
 *  - `stat` follows symlinks while `lstat` does not, so a symlinked source would
 *    also compare unequal; the media scanner already rejects symlinks outright.
 *
 * Keep this in lock-step with `LocalFolderAdapter.scan`/`scanFile`.
 */
export function sourceVersionFromStats(
  path: string,
  stats: { size: number | bigint; mtimeMs: number | bigint; dev: number | bigint; ino: number | bigint },
): PreparationSourceVersion {
  return {
    path,
    sizeBytes: String(stats.size),
    modifiedMs: String(stats.mtimeMs),
    deviceId: String(stats.dev),
    inode: String(stats.ino),
  };
}

/** Stats one path with `lstat` and returns the canonical version. */
export async function readSourceVersion(path: string): Promise<PreparationSourceVersion> {
  return sourceVersionFromStats(path, await lstat(path));
}

/** Exact-equality comparison over the canonical string fields. */
export function sourceVersionsEqual(left: PreparationSourceVersion, right: PreparationSourceVersion): boolean {
  return left.path === right.path && left.sizeBytes === right.sizeBytes && left.modifiedMs === right.modifiedMs &&
    left.deviceId === right.deviceId && left.inode === right.inode;
}
