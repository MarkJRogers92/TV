import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Repositories } from "../db/repositories.js";
import { scheduleScopedContinuityTag, type MediaItem } from "../domain/models.js";

/**
 * Stable filesystem identity of a catalog entry, or `undefined` when it has none.
 *
 * A same-filesystem rename keeps device, inode, size and timestamps. Requiring
 * the whole tuple reduces the chance that a deleted file's reused inode can
 * inherit older playback history. Legacy rows without the tuple stay unlinked.
 */
export function fileIdentityKey(item: MediaItem): string | undefined {
  if (
    !item.deviceId || !item.inode || !item.fileSizeBytes ||
    !item.fileModifiedMs || !item.fileBirthMs
  ) return undefined;
  return [
    item.deviceId, item.inode, item.fileSizeBytes,
    item.fileModifiedMs, item.fileBirthMs,
  ].join(":");
}

function pathIsGone(path: string): boolean {
  try {
    // On case-insensitive filesystems lstat("Movie.mkv") can succeed after
    // the entry was renamed to "movie.mkv". Compare the directory's actual
    // names so that this spelling is treated as gone.
    return !readdirSync(dirname(path)).includes(basename(path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Join freshly scanned paths back to the catalog IDs they already own.
 *
 * The scanner mints IDs from the path (`local-<base64 path>`), so a rename
 * produces a new ID for the same file. That would fork the movie's exposure and
 * rotation history, which is keyed by ID, onto a second logical entry. This
 * function finds the one prior ID a scanned path may adopt:
 *
 * - the file identity tuple must match exactly, and
 * - the prior record's own path must actually be gone, so a partial scan of
 *   another media root cannot masquerade as a move, and
 * - the match must be unique on BOTH sides.
 *
 * Anything else fails closed: the scanned item keeps its path-derived ID and is
 * persisted as a NEW entry. Nothing here matches on title, bytes, size, or any
 * fuzzy key, an arrival whose path some record already owns is left to that
 * record, and a hardlink farm or a recycled inode (one identity, several
 * candidates) is deliberately left unmerged rather than guessed.
 *
 * A prepared/normalized rendition is a different file with its own inode. It
 * stays a separate catalog entry and is linked only when its registration
 * explicitly supplies `sourceMediaId`; rescans retain that catalog provenance.
 */
export function reconcileRenamedMediaIds(
  scanned: readonly MediaItem[],
  existing: readonly MediaItem[],
): Map<string, string> {
  const scannedPaths = new Set(
    scanned.flatMap((item) => (item.path ? [item.path] : [])),
  );
  const scannedIds = new Set(scanned.map((item) => item.id));
  const existingPaths = new Set(
    existing.flatMap((item) => (item.path ? [item.path] : [])),
  );

  const scannedByIdentity = new Map<string, MediaItem[]>();
  for (const item of scanned) {
    const key = fileIdentityKey(item);
    if (!key || !item.path) continue;
    scannedByIdentity.set(key, [...(scannedByIdentity.get(key) ?? []), item]);
  }

  const priorByIdentity = new Map<string, MediaItem[]>();
  for (const item of existing) {
    const key = fileIdentityKey(item);
    if (!key || !item.path) continue;
    // Avoid filesystem I/O for prior identities that cannot match this scan.
    if (!scannedByIdentity.has(key)) continue;
    // A partial scan of another root cannot prove a rename. The old path must
    // actually be gone; permission errors or an offline volume fail closed.
    if (scannedPaths.has(item.path) || !pathIsGone(item.path)) continue;
    // Guard against re-keying a record onto itself.
    if (scannedIds.has(item.id)) continue;
    priorByIdentity.set(key, [...(priorByIdentity.get(key) ?? []), item]);
  }

  const assignments = new Map<string, string>();
  for (const [key, priors] of priorByIdentity) {
    const arrivals = scannedByIdentity.get(key);
    // No arrival means the file simply went away; several on either side is an
    // ambiguous identity. Both keep the path-derived ID.
    if (!arrivals || arrivals.length !== 1 || priors.length !== 1) continue;
    const arrival = arrivals[0]!;
    // The arrival's path must be a genuinely new one. If a catalog record still
    // claims it, re-keying would leave two records pointing at one file.
    if (arrival.path && existingPaths.has(arrival.path)) continue;
    assignments.set(arrival.id, priors[0]!.id);
  }
  return assignments;
}

/**
 * Persist scanned items without discarding a manually-assigned `kind` and
 * without forking a renamed file's catalog identity.
 *
 * The scanner can only ever derive `episode` or `movie` from the path
 * (`src/media/localFolder.ts`), while `bumper`, `station-id` and `commercial`
 * are assigned through the API. Re-putting a scanned item verbatim therefore
 * resets those back to `episode`, which silently empties the pools that
 * reference them — and because `validatePoolRecords` is global, it also rejects
 * every subsequent pool write. A scan owns the path-derived fields; it does not
 * own `kind`, so an existing value wins.
 */
export function persistScannedMedia(
  repositories: Repositories,
  items: readonly MediaItem[],
): void {
  /**
   * Generated continuity cards are ordinary video files inside a mapped root,
   * so a library scan will rediscover them. They must not be re-registered: the
   * scanner can only derive `episode`/`movie` from a path and knows nothing
   * about the schedule binding, so a second, untagged catalog entry would strip
   * the generated marker and let the same file be drawn as ordinary filler (or
   * reclassified) on some other day. The registered card owns its path.
   */
  const existingItems = repositories.media.list();
  const generatedPaths = new Set(
    existingItems
      .filter((item) => item.tags.includes(scheduleScopedContinuityTag))
      .flatMap((item) => (item.path ? [item.path] : [])),
  );
  const pending = items.filter((item) => {
    // Also exclude an orphaned render whose registration failed or was removed.
    if (item.path?.replaceAll("\\", "/").includes("/generated/continuity/"))
      return false;
    if (item.path && generatedPaths.has(item.path)) return false;
    return true;
  });

  /**
   * The record that already owns a path, whatever its ID.
   *
   * A file that moved keeps its prior ID, so the next scan reports the new path
   * under a fresh path-derived ID that no record carries yet. Looking the path up
   * as well is what makes the reconciliation idempotent: without it, every scan
   * after the rename would add a second entry for the same file.
   */
  const ownerByPath = new Map<string, MediaItem>();
  for (const record of existingItems)
    if (record.path && !ownerByPath.has(record.path))
      ownerByPath.set(record.path, record);

  const reconciled = reconcileRenamedMediaIds(pending, existingItems);
  for (const item of pending) {
    const id =
      reconciled.get(item.id) ??
      (item.path ? ownerByPath.get(item.path)?.id : undefined) ??
      item.id;
    const incoming: MediaItem = id === item.id ? item : { ...item, id };
    const existing = repositories.media.get(id);
    repositories.media.put(
      existing
        ? {
            ...incoming,
            kind: existing.kind,
            // Explicit rendition provenance is catalog-owned metadata. A raw
            // rescan cannot infer it and must not erase it.
            sourceMediaId: existing.sourceMediaId ?? incoming.sourceMediaId,
            // Scans own path-derived metadata, not the imported voiced classification.
            tags: existing.tags.includes("voiced-continuity")
              ? existing.tags
              : incoming.tags,
          }
        : incoming,
    );
  }
}
