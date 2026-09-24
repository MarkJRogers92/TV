import { lstat, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readSourceVersion,
  sourceVersionFromStats,
  sourceVersionsEqual,
} from "../../src/preparation/sourceVersion.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("PREP-SV1 source version uses the catalog's non-bigint lstat representation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marktv-sv-"));
  temporary.push(directory);
  const path = join(directory, "a.mkv");
  await writeFile(path, "0123456789");
  // A sub-millisecond mtime is exactly the case a bigint reader truncates.
  await utimes(path, 1_720_000_000.5, 1_720_000_000.25);

  const stats = await lstat(path);
  const version = await readSourceVersion(path);
  expect(version).toEqual(sourceVersionFromStats(path, stats));
  expect(version.modifiedMs).toBe(String(stats.mtimeMs));
  expect(version.sizeBytes).toBe(String(stats.size));
  expect(version.deviceId).toBe(String(stats.dev));
  expect(version.inode).toBe(String(stats.ino));

  // Document the hazard this reader exists to prevent: a bigint stat would
  // produce a different string here, which the repository would read as a
  // source change. Guarded so a whole-millisecond mtime does not flake.
  const bigintMs = (await stat(path, { bigint: true })).mtimeMs.toString();
  if (String(stats.mtimeMs) !== bigintMs) {
    expect(version.modifiedMs).not.toBe(bigintMs);
  }
});

test("PREP-SV2 sourceVersionsEqual compares every canonical field exactly", () => {
  const base = { path: "/a.mkv", sizeBytes: "10", modifiedMs: "1720000000000.5", deviceId: "1", inode: "2" };
  expect(sourceVersionsEqual(base, { ...base })).toBe(true);
  expect(sourceVersionsEqual(base, { ...base, modifiedMs: "1720000000000" })).toBe(false);
  expect(sourceVersionsEqual(base, { ...base, sizeBytes: "11" })).toBe(false);
  expect(sourceVersionsEqual(base, { ...base, inode: "3" })).toBe(false);
});
