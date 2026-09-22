import { createHash } from "node:crypto";
import type { Repositories } from "../db/repositories.js";
import { initializeManagedPaths, pinManagedDirectory, type ManagedDirectoryIdentity, type ManagedPathOverrides, type ManagedPaths } from "../acquisition/paths.js";

export type MediaRootRecord = {
  id: string;
  path: string;
  lastScannedAt: string | null;
  diagnostics: Array<{ code: string; path: string; message: string }>;
  /** Optional for roots registered before inode identity tracking. */
  directoryIdentity?: ManagedDirectoryIdentity;
};

const settingPrefix = "media-root:";

/** A stable ID means the same resolved directory is only registered once. */
export function mediaRootId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** Pin ownership key for a registered root, shared by the route handlers. */
export function mediaRootOwner(id: string): string {
  return `media-root:${id}`;
}

/**
 * Pins every registered root for the lifetime of the process.
 *
 * Roots persisted by an earlier run carry an identity but no descriptor, so
 * without this they stay vulnerable to inode recycling until the first scan --
 * and an attacker who swaps the directory before that scan is never detected.
 */
export async function pinRegisteredMediaRoots(repositories: Repositories): Promise<void> {
  for (const root of listMediaRoots(repositories)) {
    if (!root.directoryIdentity) continue;
    try {
      await pinManagedDirectory(root.directoryIdentity.path, mediaRootOwner(root.id));
    } catch {
      // A root can be temporarily absent, e.g. an unmounted volume. Scanning
      // reports that through assertManagedDirectory, so this is not fatal.
    }
  }
}

export function listMediaRoots(repositories: Repositories): MediaRootRecord[] {
  return repositories.settings
    .list()
    .filter((setting) => setting.id.startsWith(settingPrefix))
    .map((setting) => setting.value as MediaRootRecord)
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Writes a root by its path-derived ID, so repeated managed-root setup is idempotent. */
export function putMediaRoot(
  repositories: Repositories,
  root: Omit<MediaRootRecord, "id"> & { id?: string },
): MediaRootRecord {
  const record: MediaRootRecord = { ...root, id: root.id ?? mediaRootId(root.path) };
  repositories.settings.put(`${settingPrefix}${record.id}`, record);
  return record;
}

export function getMediaRoot(
  repositories: Repositories,
  id: string,
): MediaRootRecord | undefined {
  const value = repositories.settings.get(`${settingPrefix}${id}`)?.value;
  return value as MediaRootRecord | undefined;
}

export function removeMediaRoot(repositories: Repositories, id: string): boolean {
  const key = `${settingPrefix}${id}`;
  if (!repositories.settings.get(key)) return false;
  repositories.settings.remove(key);
  return true;
}

/**
 * Acquisition is the only writer to this root. Create/validate the managed
 * paths first, then register the resolved library path once without altering
 * an existing root's scan history.
 */
export async function registerManagedLibrary(
  repositories: Repositories,
  dataDir: string,
  overrides: ManagedPathOverrides = {},
): Promise<ManagedPaths & { root: MediaRootRecord }> {
  const paths = await initializeManagedPaths(dataDir, overrides);
  const id = mediaRootId(paths.library);
  const existing = getMediaRoot(repositories, id);
  const root = existing ?? putMediaRoot(repositories, {
    id,
    path: paths.library,
    lastScannedAt: null,
    diagnostics: [],
    directoryIdentity: paths.libraryIdentity,
  });
  return { ...paths, root };
}
