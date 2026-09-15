import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { videoExtensions } from "./filename.js";

export const managedVideoExtensions: ReadonlySet<string> = new Set(
  videoExtensions.map((extension) => `.${extension}`),
);
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class ManagedPathError extends Error {
  readonly name = "ManagedPathError";
}

export interface ManagedPaths {
  readonly inbox: string;
  readonly library: string;
  readonly inboxIdentity: ManagedDirectoryIdentity;
  readonly libraryIdentity: ManagedDirectoryIdentity;
}

/** A resolved directory identity detects replacement after startup. */
export interface ManagedDirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  /**
   * Random token stored inside the directory itself. Inode numbers are freed
   * the moment an entry is unlinked and ext4 hands the recycled number straight
   * back to the next mkdir, so dev+ino alone cannot detect a same-path
   * replacement. Set only for the staging inbox; the library keeps dev+ino
   * because external media scanners read it and must not meet stray files.
   */
  readonly token?: string;
}

const sentinelName = ".marktv-identity";
const sentinelPattern = /^[0-9a-f]{32}$/;

/**
 * Directories held open for the lifetime of the process.
 *
 * An open descriptor keeps the inode allocated, so the kernel cannot hand the
 * freed number to a directory that replaces this one at the same path -- which
 * makes the dev+ino comparison in `assertManagedDirectory` sound rather than
 * merely likely. Measured on the CI filesystem (ext4, ubuntu-24.04): rm+mkdir
 * at the same path reuses the inode 30/30 times unpinned and 0/30 times while a
 * descriptor is held.
 *
 * This is what remains of fd pinning now that `openat` is unavailable: Node
 * exposes no fd-relative open, so writes cannot be made relative to the
 * directory, but the inode can still be kept from being recycled.
 *
 * Pins are counted per owner rather than per path because the managed library is
 * itself registered as a media root: without ownership, deleting that root would
 * close the descriptor acquisition depends on.
 */
const pinnedDirectories = new Map<string, { handle: FileHandle; owners: Set<string> }>();

/** Holds a directory open on behalf of `owner`. `resolvedPath` must already be resolved. */
export async function pinManagedDirectory(resolvedPath: string, owner: string): Promise<void> {
  const pin = pinnedDirectories.get(resolvedPath);
  if (pin) {
    pin.owners.add(owner);
    return;
  }
  pinnedDirectories.set(resolvedPath, {
    handle: await open(resolvedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    owners: new Set([owner]),
  });
}

/** Releases one owner's pin; the descriptor closes only when the last owner leaves. */
export async function unpinManagedDirectory(resolvedPath: string, owner: string): Promise<void> {
  const pin = pinnedDirectories.get(resolvedPath);
  if (!pin || !pin.owners.delete(owner)) return;
  if (pin.owners.size > 0) return;
  pinnedDirectories.delete(resolvedPath);
  await pin.handle.close();
}

/** Exposed so tests can assert pin lifetimes without reaching into module state. */
export function pinOwners(resolvedPath: string): readonly string[] {
  return [...(pinnedDirectories.get(resolvedPath)?.owners ?? [])];
}

/** Reads a directory's identity token, minting one the first time it is needed. */
async function ensureSentinel(directory: string): Promise<string> {
  const file = join(directory, sentinelName);
  let existing: string | undefined;
  try {
    existing = (await readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ManagedPathError("Unable to read managed identity");
  }
  if (existing !== undefined) {
    if (!sentinelPattern.test(existing)) throw new ManagedPathError("Managed identity is malformed");
    return existing;
  }
  const token = randomBytes(16).toString("hex");
  try {
    // `wx` never truncates an existing token, so a second process cannot rotate it.
    await writeFile(file, token, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ManagedPathError("Unable to create managed identity");
    const raced = (await readFile(file, "utf8")).trim();
    if (!sentinelPattern.test(raced)) throw new ManagedPathError("Managed identity is malformed");
    return raced;
  }
}

function assertSafeComponent(value: string, field: string): string {
  if (!value || value !== value.trim() || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new ManagedPathError(`${field} contains unsafe characters`);
  if (value === "." || value === ".." || value.includes("..") || /[\\/]/.test(value) || isAbsolute(value))
    throw new ManagedPathError(`${field} must not contain a path`);
  if (reserved.test(value)) throw new ManagedPathError(`${field} is a reserved name`);
  return value;
}

function cleanLabel(value: string, field: string): string {
  assertSafeComponent(value, field);
  const clean = value.replace(/[<>:"|?*]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean === "." || clean === ".." || reserved.test(clean))
    throw new ManagedPathError(`${field} is unsafe`);
  return clean;
}

/** Builds a single safe basename; callers still assert root containment when joining it. */
export function canonicalVideoName(
  seriesTitle: string,
  season: number,
  episode: number,
  episodeTitle: string,
  extension: string,
): string {
  if (!Number.isInteger(season) || season < 0 || season > 99 || !Number.isInteger(episode) || episode < 0 || episode > 999)
    throw new ManagedPathError("Season must be 0-99 and episode must be 0-999");
  const lowerExtension = extension.toLowerCase();
  if (!managedVideoExtensions.has(lowerExtension)) throw new ManagedPathError("Unsupported video extension");
  const series = cleanLabel(seriesTitle, "Series title");
  const title = cleanLabel(episodeTitle, "Episode title");
  const result = `${series} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} - ${title}${lowerExtension}`;
  if (Buffer.byteLength(result) > 255) throw new ManagedPathError("Canonical filename exceeds 255 bytes");
  return result;
}

export function containedPath(root: string, childName: string): string {
  assertSafeComponent(childName, "Child name");
  const destination = join(root, childName);
  const rel = relative(root, destination);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new ManagedPathError("Destination escapes managed root");
  return destination;
}

async function ensureDirectory(path: string): Promise<string> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ManagedPathError(`Unable to create managed directory: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new ManagedPathError(`Managed path is a symlink: ${basename(path)}`);
  if (!stats.isDirectory()) throw new ManagedPathError(`Managed path is not a directory: ${basename(path)}`);
  await chmod(path, 0o700);
  return realpath(path);
}

export async function captureManagedDirectory(
  path: string,
  options: { sentinel?: boolean; pin?: string } = {},
): Promise<ManagedDirectoryIdentity> {
  const resolved = await realpath(path);
  const entry = await lstat(path);
  const target = await lstat(resolved);
  if (entry.isSymbolicLink() || !target.isDirectory())
    throw new ManagedPathError("Managed directory is not a real directory");
  if (options.pin !== undefined) await pinManagedDirectory(resolved, options.pin);
  const identity = { path: resolved, dev: target.dev, ino: target.ino };
  return options.sentinel ? { ...identity, token: await ensureSentinel(resolved) } : identity;
}

/** Constant-time token compare; a length mismatch is simply a mismatch. */
async function sentinelMatches(directory: string, expected: string): Promise<boolean> {
  try {
    const left = Buffer.from((await readFile(join(directory, sentinelName), "utf8")).trim());
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** Revalidate path, realpath, inode, and identity token immediately before sensitive work. */
export async function assertManagedDirectory(
  identity: ManagedDirectoryIdentity,
): Promise<void> {
  const resolved = await realpath(identity.path);
  const entry = await lstat(identity.path);
  if (entry.isSymbolicLink() || resolved !== identity.path || !entry.isDirectory() || entry.dev !== identity.dev || entry.ino !== identity.ino)
    throw new ManagedPathError("Managed directory was replaced");
  if (identity.token !== undefined && !(await sentinelMatches(identity.path, identity.token)))
    throw new ManagedPathError("Managed directory was replaced");
}

/** Creates and then verifies the only directories used by acquisition writes. */
export async function initializeManagedPaths(dataDir: string): Promise<ManagedPaths> {
  const root = await ensureDirectory(dataDir);
  const inbox = await ensureDirectory(join(root, "inbox"));
  const library = await ensureDirectory(join(root, "library"));
  return {
    inbox,
    library,
    inboxIdentity: await captureManagedDirectory(inbox, { sentinel: true, pin: "managed-paths" }),
    libraryIdentity: await captureManagedDirectory(library, { pin: "managed-paths" }),
  };
}
