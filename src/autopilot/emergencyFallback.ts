import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const approvedManifestVersion = "v1-20260923";
const approvedManifestSha256 = "2e4eeadeadecc72e8057c16e4363da39eeeb2f58a64a30b8bd6dd9d06a29322a";
const verifiedPoolBrand: unique symbol = Symbol("verified emergency pool");

interface VerifiedEmergencyAsset {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly fullDecodeVerified: boolean;
  readonly loopEligible: boolean;
}

/**
 * Constructed only by the on-disk verifier below. This is a point-in-time
 * inventory, not a playback handle: future activation must rehash immediately
 * before opening, or use an immutable descriptor bound to the verified bytes.
 */
export interface VerifiedEmergencyFallbackPool {
  readonly root: string;
  readonly assets: readonly VerifiedEmergencyAsset[];
  readonly [verifiedPoolBrand]: true;
}

export type EmergencyPoolLoadResult =
  | { readonly ok: true; readonly pool: VerifiedEmergencyFallbackPool }
  | {
      readonly ok: false;
      readonly reason: "root-not-internal" | "manifest-unavailable" | "manifest-invalid";
    };

export interface EmergencyFallbackInput {
  readonly externalVolumePresent: boolean;
  readonly enabledChannels: readonly { readonly id: string }[];
  readonly pool: EmergencyPoolLoadResult;
}

export interface EmergencyManifestPolicy {
  readonly expectedManifestSha256: string;
}

export interface EmergencyFallbackDecision {
  /** This module describes a possible plan only; no caller or service is activated. */
  readonly activation: "not-activated";
  readonly status: "no-fallback-needed" | "fallback-plan-ready" | "blocked";
  readonly channels: readonly {
    readonly channelId: string;
    readonly action: "normal-programming" | "internal-emergency-loop" | "unavailable";
  }[];
  readonly assetIds: readonly string[];
  readonly blockedReason?: "internal-pool-not-verified";
  readonly preservation: {
    readonly settingsChanged: false;
    readonly catalogChanged: false;
    readonly historyReset: false;
    readonly externalMountPathCreated: false;
  };
}

const preservedState = {
  settingsChanged: false,
  catalogChanged: false,
  historyReset: false,
  externalMountPathCreated: false,
} as const;

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function isExternalVolumePath(path: string): boolean {
  const volumesRoot = resolve("/Volumes");
  const resolvedPath = resolve(path);
  return resolvedPath === volumesRoot || isWithin(volumesRoot, resolvedPath);
}

async function hasSymlinkComponent(path: string): Promise<boolean> {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function readRegularFileWithoutFollowingSymlinks(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function recordOf(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads the approved manifest and verifies the current internal files against it.
 *
 * The returned pool is branded so the planner cannot be given caller-authored
 * hash strings or "verified" booleans. Full-decode evidence is copied from the
 * manifest only after the current file size and SHA-256 both match.
 */
export async function loadVerifiedEmergencyFallbackPool(
  internalRoot: string,
): Promise<EmergencyPoolLoadResult> {
  return loadVerifiedEmergencyFallbackPoolWithManifestPolicy(internalRoot, {
    expectedManifestSha256: approvedManifestSha256,
  });
}

/**
 * @internal Explicit digest-policy seam for isolated fixture tests. Do not use
 * this entry point from runtime or application code; production callers must use
 * the pinned-default `loadVerifiedEmergencyFallbackPool` entry point.
 */
export async function loadVerifiedEmergencyFallbackPoolWithManifestPolicy(
  internalRoot: string,
  policy: EmergencyManifestPolicy,
): Promise<EmergencyPoolLoadResult> {
  if (!/^[a-f0-9]{64}$/.test(policy.expectedManifestSha256)) {
    return { ok: false, reason: "manifest-invalid" };
  }
  if (!isAbsolute(internalRoot) || isExternalVolumePath(internalRoot)) {
    return { ok: false, reason: "root-not-internal" };
  }

  let root: string;
  try {
    if (await hasSymlinkComponent(internalRoot)) {
      return { ok: false, reason: "root-not-internal" };
    }
    root = await realpath(internalRoot);
    // The user's home directory is the trusted internal-storage anchor for this host.
    const [rootMetadata, trustedHomeMetadata] = await Promise.all([
      stat(root),
      stat(homedir()),
    ]);
    if (
      root !== resolve(internalRoot) ||
      isExternalVolumePath(root) ||
      !rootMetadata.isDirectory() ||
      rootMetadata.dev !== trustedHomeMetadata.dev
    ) {
      return { ok: false, reason: "root-not-internal" };
    }
  } catch {
    return { ok: false, reason: "root-not-internal" };
  }

  const manifestPath = resolve(root, "manifest.json");
  if (!isWithin(root, manifestPath) || isExternalVolumePath(manifestPath)) {
    return { ok: false, reason: "manifest-invalid" };
  }

  let manifest: unknown;
  try {
    if (await hasSymlinkComponent(manifestPath)) {
      return { ok: false, reason: "manifest-invalid" };
    }
    const resolvedManifest = await realpath(manifestPath);
    if (resolvedManifest !== manifestPath || !isWithin(root, resolvedManifest)) {
      return { ok: false, reason: "manifest-invalid" };
    }
    const manifestContents = await readRegularFileWithoutFollowingSymlinks(resolvedManifest);
    const manifestSha256 = createHash("sha256").update(manifestContents).digest("hex");
    if (manifestSha256 !== policy.expectedManifestSha256) {
      return { ok: false, reason: "manifest-invalid" };
    }
    manifest = JSON.parse(manifestContents.toString("utf8"));
  } catch {
    return { ok: false, reason: "manifest-unavailable" };
  }

  if (
    !recordOf(manifest) ||
    manifest.version !== approvedManifestVersion ||
    !Array.isArray(manifest.assets)
  ) {
    return { ok: false, reason: "manifest-invalid" };
  }

  const assets: VerifiedEmergencyAsset[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const entry of manifest.assets) {
    if (
      !recordOf(entry) ||
      typeof entry.filename !== "string" ||
      !entry.filename.trim() ||
      typeof entry.source !== "string" ||
      !entry.source.trim() ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) <= 0
    ) continue;

    // Manifest entries name one file below the approved root, never a subpath.
    if (entry.filename !== entry.filename.split(/[\\/]/).at(-1) || entry.filename === "." || entry.filename === "..") {
      continue;
    }
    const assetPath = resolve(root, entry.filename);
    if (!isWithin(root, assetPath) || isExternalVolumePath(assetPath)) continue;

    try {
      if (await hasSymlinkComponent(assetPath)) continue;
      const resolvedAsset = await realpath(assetPath);
      if (resolvedAsset !== assetPath || !isWithin(root, resolvedAsset) || isExternalVolumePath(resolvedAsset)) continue;
      const metadata = await stat(resolvedAsset);
      if (!metadata.isFile() || metadata.size !== entry.bytes) continue;
      const content = await readRegularFileWithoutFollowingSymlinks(resolvedAsset);
      if (content.byteLength !== entry.bytes) continue;
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== entry.sha256) continue;

      const id = entry.filename.replace(/\.[^.]+$/, "");
      const source = entry.source.replaceAll("\\", "/");
      if (seenIds.has(id) || seenPaths.has(resolvedAsset)) continue;
      seenIds.add(id);
      seenPaths.add(resolvedAsset);
      assets.push({
        id,
        path: resolvedAsset,
        sha256: actualSha256,
        bytes: content.byteLength,
        fullDecodeVerified:
          typeof entry.validation === "string" && /full video\/audio decode passed\b/i.test(entry.validation),
        // A station ID may be used once by a separate transition gate, never in a recurring loop.
        loopEligible: !source.split("/").includes("station-ids"),
      });
    } catch {
      // A missing, unreadable, replaced, or symlinked member is simply excluded.
    }
  }

  return {
    ok: true,
    pool: {
      root,
      assets,
      [verifiedPoolBrand]: true,
    },
  };
}

/**
 * Returns a source-only decision; it cannot mutate settings, catalog, or history.
 * The manifest check is a point-in-time disk verification, not a playback lease.
 * Any future runtime activation must revalidate the asset hash immediately before
 * opening it or bind playout to an immutable descriptor of the verified bytes.
 */
export function decideEmergencyFallback(
  input: EmergencyFallbackInput,
): EmergencyFallbackDecision {
  const channels = input.enabledChannels.map(({ id }) => ({ channelId: id }));
  if (input.externalVolumePresent) {
    return {
      activation: "not-activated",
      status: "no-fallback-needed",
      channels: channels.map(({ channelId }) => ({ channelId, action: "normal-programming" })),
      assetIds: [],
      preservation: preservedState,
    };
  }

  if (!channels.length) {
    return {
      activation: "not-activated",
      status: "no-fallback-needed",
      channels: [],
      assetIds: [],
      preservation: preservedState,
    };
  }

  const assets = input.pool.ok
    ? input.pool.pool.assets.filter(({ fullDecodeVerified, loopEligible }) => fullDecodeVerified && loopEligible)
    : [];
  if (assets.length < 2) {
    return {
      activation: "not-activated",
      status: "blocked",
      channels: channels.map(({ channelId }) => ({ channelId, action: "unavailable" })),
      assetIds: [],
      blockedReason: "internal-pool-not-verified",
      preservation: preservedState,
    };
  }

  return {
    activation: "not-activated",
    status: "fallback-plan-ready",
    channels: channels.map(({ channelId }) => ({ channelId, action: "internal-emergency-loop" })),
    assetIds: assets.map(({ id }) => id),
    preservation: preservedState,
  };
}
