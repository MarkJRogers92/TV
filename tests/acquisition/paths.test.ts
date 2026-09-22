import { lstat, mkdtemp, mkdir, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertManagedDirectory,
  canonicalVideoName,
  initializeManagedPaths,
  pinManagedDirectory,
  pinOwners,
  unpinManagedDirectory,
} from "../../src/acquisition/paths.js";

describe("canonicalVideoName", () => {
  test("creates a contained canonical episode filename", () => {
    expect(canonicalVideoName("A Show", 3, 4, "Title: Here", ".mkv")).toBe(
      "A Show - S03E04 - Title Here.mkv",
    );
  });

  test.each(["../escape.mkv", "/absolute.mkv", "CON.mkv", "bad\u0000.mkv"])(
    "rejects unsafe filename input %s",
    (value) => expect(() => canonicalVideoName("Show", 1, 2, value, ".mkv")).toThrow(),
  );

  test("rejects seasons and episodes beyond acquisition matching bounds", () => {
    expect(() => canonicalVideoName("Show", 100, 1, "Title", ".mkv")).toThrow();
    expect(() => canonicalVideoName("Show", 1, 1000, "Title", ".mkv")).toThrow();
  });
});

/**
 * Swaps a managed directory for a fresh one at the same path.
 *
 * The replacement is allocated *before* the original is removed, so its inode
 * cannot collide with the original's. Removing first and then calling mkdir at
 * the same path is not equivalent: ext4 recycles the freed inode number
 * immediately, which leaves dev+ino unchanged and makes the identity guard
 * silently pass. macOS allocates inodes monotonically and never hits this, so
 * only Linux exposes the difference.
 */
async function replaceManagedDirectory(path: string): Promise<void> {
  const replacement = `${path}-replacement`;
  await mkdir(replacement);
  await rm(path, { recursive: true });
  await rename(replacement, path);
}

describe("initializeManagedPaths", () => {
  test("creates owner-only inbox and library", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    expect(paths.inbox).toBe(await realpath(join(dataDir, "inbox")));
    expect(paths.library).toBe(await realpath(join(dataDir, "library")));
  });

  test("uses explicit absolute inbox and library directories outside the data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-data-"));
    const externalDir = await mkdtemp(join(tmpdir(), "marktv-external-"));
    const inbox = join(externalDir, "Inbox");
    const library = join(externalDir, "Shows");

    const paths = await initializeManagedPaths(dataDir, { inbox, library });

    expect(paths.inbox).toBe(await realpath(inbox));
    expect(paths.library).toBe(await realpath(library));
    await expect(lstat(join(dataDir, "inbox"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(dataDir, "library"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects relative managed path overrides", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-data-"));
    await expect(initializeManagedPaths(dataDir, { inbox: "relative-inbox" })).rejects.toThrow(/absolute/i);
    await expect(initializeManagedPaths(dataDir, { library: "relative-library" })).rejects.toThrow(/absolute/i);
  });

  test("rejects a symlinked inbox", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const target = join(dataDir, "target");
    await mkdir(target);
    await symlink(target, join(dataDir, "inbox"));
    await expect(initializeManagedPaths(dataDir)).rejects.toThrow(/symlink/i);
  });

  test("rejects an inbox replaced by a file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    await writeFile(join(dataDir, "inbox"), "not a directory");
    await expect(initializeManagedPaths(dataDir)).rejects.toThrow(/directory/i);
  });

  test("detects an inbox or library replacement after initialization", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    await replaceManagedDirectory(paths.inbox);
    await expect(assertManagedDirectory(paths.inboxIdentity)).rejects.toThrow(/replaced/i);
    await replaceManagedDirectory(paths.library);
    await expect(assertManagedDirectory(paths.libraryIdentity)).rejects.toThrow(/replaced/i);
  });
});

describe("managed identity token", () => {
  test("rejects a replacement even when dev and ino still match", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    // Models the ext4 case exactly: the replacement directory was handed the
    // freed inode number, so both inode checks pass and only the token can
    // catch it. Path, dev and ino are deliberately all genuine.
    await expect(assertManagedDirectory({ ...paths.inboxIdentity, token: "0".repeat(32) })).rejects.toThrow(/replaced/i);
  });

  test("accepts an unchanged inbox", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    await expect(assertManagedDirectory(paths.inboxIdentity)).resolves.toBeUndefined();
  });

  test.each(["", "0".repeat(32), "not-a-token", "f".repeat(31)])(
    "rejects an inbox whose identity token is %s",
    async (value) => {
      const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
      const paths = await initializeManagedPaths(dataDir);
      await writeFile(join(paths.inbox, ".marktv-identity"), value);
      await expect(assertManagedDirectory(paths.inboxIdentity)).rejects.toThrow(/replaced/i);
    },
  );

  test("reuses one token across initializations and keeps the library free of stray files", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const first = await initializeManagedPaths(dataDir);
    const second = await initializeManagedPaths(dataDir);
    expect(first.inboxIdentity.token).toMatch(/^[0-9a-f]{32}$/);
    expect(second.inboxIdentity.token).toBe(first.inboxIdentity.token);
    // The library is read by external media scanners, so it must gain no files.
    expect(first.libraryIdentity.token).toBeUndefined();
    expect(await readdir(first.library)).toEqual([]);
    expect(await readdir(first.inbox)).toEqual([".marktv-identity"]);
  });
});

describe("inode pinning", () => {
  test("a replacement cannot reuse a pinned managed directory's inode", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    for (const identity of [paths.inboxIdentity, paths.libraryIdentity]) {
      // Measured on ext4: without the held descriptor this rm+mkdir returns the
      // freed inode number 30/30 times, which is precisely the collision that
      // made the guard pass on CI while it passed locally on APFS. On macOS this
      // assertion holds with or without pinning, so it only has teeth on Linux.
      await rm(identity.path, { recursive: true });
      await mkdir(identity.path);
      expect((await lstat(identity.path)).ino).not.toBe(identity.ino);
      await expect(assertManagedDirectory(identity)).rejects.toThrow(/replaced/i);
    }
  });

  test("reinitializing does not accumulate pinned descriptors", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const first = await initializeManagedPaths(dataDir);
    const second = await initializeManagedPaths(dataDir);
    expect(second.inboxIdentity.ino).toBe(first.inboxIdentity.ino);
    expect(second.libraryIdentity.ino).toBe(first.libraryIdentity.ino);
    expect(pinOwners(first.libraryIdentity.path)).toEqual(["managed-paths"]);
  });
});

describe("pin ownership", () => {
  test("keeps a shared directory pinned until the last owner releases it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    const library = paths.libraryIdentity.path;
    expect(pinOwners(library)).toEqual(["managed-paths"]);

    await pinManagedDirectory(library, "media-root:abc");
    expect([...pinOwners(library)].sort()).toEqual(["managed-paths", "media-root:abc"]);

    // The managed library is itself registered as a media root, so deleting that
    // root must not release the pin acquisition depends on.
    await unpinManagedDirectory(library, "media-root:abc");
    expect(pinOwners(library)).toEqual(["managed-paths"]);
  });

  test("releases the last owner and allows the path to be pinned again", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    await unpinManagedDirectory(paths.inbox, "managed-paths");
    expect(pinOwners(paths.inbox)).toEqual([]);

    await pinManagedDirectory(paths.inbox, "managed-paths");
    expect(pinOwners(paths.inbox)).toEqual(["managed-paths"]);
  });

  test("ignores unknown owners and unknown paths instead of throwing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "marktv-paths-"));
    const paths = await initializeManagedPaths(dataDir);
    await unpinManagedDirectory(paths.inbox, "never-pinned");
    await unpinManagedDirectory(join(dataDir, "absent"), "managed-paths");
    expect(pinOwners(paths.inbox)).toEqual(["managed-paths"]);
    expect(pinOwners(join(dataDir, "absent"))).toEqual([]);
  });
});
