import { link, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Repositories } from "../../src/db/repositories.js";
import type { MediaItem } from "../../src/domain/models.js";
import { LocalFolderAdapter } from "../../src/media/localFolder.js";
import {
  persistScannedMedia,
  reconcileRenamedMediaIds,
} from "../../src/media/catalogReconcile.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

function media(overrides: Partial<MediaItem> & { id: string }): MediaItem {
  return {
    source: "local-folder",
    kind: "movie",
    title: overrides.id,
    durationMs: 60_000,
    durationStatus: "ok",
    available: true,
    tags: [],
    ...overrides,
  };
}

/** A catalog stub holding only the `media` collection the reconciler uses. */
function memoryCatalog(seed: MediaItem[] = []) {
  const rows = new Map(seed.map((item) => [item.id, item]));
  const repositories = {
    media: {
      list: () => [...rows.values()],
      get: (id: string) => rows.get(id),
      put: (item: MediaItem) => {
        rows.set(item.id, item);
      },
    },
  } as unknown as Repositories;
  return { repositories, rows };
}

async function libraryWith(names: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "marktv-reconcile-")));
  directories.push(root);
  const movies = join(root, "Movies");
  await mkdir(movies, { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(movies, name), "fixture")));
  return { root, movies, path: (name: string) => join(movies, name) };
}

const adapter = () => new LocalFolderAdapter(async () => 60_000);

test("reconciles one moved file to its unique prior id only when the old path is gone", () => {
  const prior = media({ id: "local-a", path: "/lib/Movies/A.mkv", deviceId: "1", inode: "7" });
  const arrival = media({ id: "local-b", path: "/lib/Movies/B.mkv", deviceId: "1", inode: "7" });
  const assignments = reconcileRenamedMediaIds([arrival], [prior]);
  expect(assignments.get("local-b")).toBe("local-a");

  // The original path is still present in the scan: a copy or a link, not a move.
  const stillPresent = media({ id: "local-a2", path: "/lib/Movies/A.mkv", deviceId: "1", inode: "7" });
  expect(reconcileRenamedMediaIds([arrival, stillPresent], [prior]).size).toBe(0);
});

test("fails closed on ambiguous identity and on records with no recorded dev+ino", () => {
  const first = media({ id: "local-a", path: "/lib/Movies/A.mkv", deviceId: "1", inode: "7" });
  const second = media({ id: "local-c", path: "/lib/Movies/C.mkv", deviceId: "1", inode: "7" });
  const arrival = media({ id: "local-b", path: "/lib/Movies/B.mkv", deviceId: "1", inode: "7" });
  // Two catalog records share one identity (a hardlink farm, a recycled inode).
  expect(reconcileRenamedMediaIds([arrival], [first, second]).size).toBe(0);
  // A pre-existing record with no identity can never be a rename source.
  const legacy = media({ id: "local-legacy", path: "/lib/Movies/Legacy.mkv" });
  expect(reconcileRenamedMediaIds([arrival], [legacy]).size).toBe(0);
});

test("persists a moved file under its prior id and still fails closed on a hardlink", async () => {
  const library = await libraryWith(["Movie A.mkv", "Other.mkv"]);
  const { repositories, rows } = memoryCatalog();
  persistScannedMedia(repositories, (await adapter().scan(library.root)).items);
  const original = [...rows.values()].find(
    (item) => item.path === library.path("Movie A.mkv"),
  )!;
  expect(original.deviceId).toBeTruthy();
  expect(original.inode).toBeTruthy();

  // Same filesystem: the rename keeps the inode, so the entry follows the file.
  const movedPath = library.path("Movie A Renamed.mkv");
  await rename(library.path("Movie A.mkv"), movedPath);
  persistScannedMedia(repositories, (await adapter().scan(library.root)).items);
  expect(rows.get(original.id)?.path).toBe(movedPath);
  expect([...rows.values()].filter((item) => item.path === movedPath)).toHaveLength(1);

  // A second link makes the identity ambiguous: nothing may be re-keyed.
  const linkedPath = library.path("Movie A Link.mkv");
  await link(movedPath, linkedPath);
  const before = [...rows.values()];
  persistScannedMedia(repositories, (await adapter().scan(library.root)).items);
  expect(rows.get(original.id)?.path).toBe(movedPath);
  expect([...rows.values()].filter((item) => item.path === linkedPath)).toHaveLength(1);
  expect(before.every((item) => rows.get(item.id)?.path === item.path)).toBe(true);
});
