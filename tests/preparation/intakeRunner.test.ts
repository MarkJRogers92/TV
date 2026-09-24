import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { LocalFolderAdapter } from "../../src/media/localFolder.js";
import { captureManagedDirectory } from "../../src/acquisition/paths.js";
import { mediaRootId, putMediaRoot } from "../../src/media/roots.js";
import { createPreparationIntakeRunner } from "../../src/preparation/intakeRunner.js";
import type { PreparationEvent } from "../../src/preparation/events.js";

const temporary: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: { probe?: (path: string) => Promise<{ durationMs: number | null }>; entryBudget?: number; onEvent?: (event: PreparationEvent) => void } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-intake-data-"));
  // Registered roots are stored canonically (realpath), so a temp dir under
  // macOS /var (a symlink to /private/var) must be resolved to match.
  const rootRaw = await mkdtemp(join(tmpdir(), "marktv-intake-root-"));
  const rootPath = await realpath(rootRaw);
  temporary.push(dataDir, rootRaw);
  const repositories = createRepositories(openDatabase(dataDir));
  cleanups.push(() => { repositories.close(); });
  const identity = await captureManagedDirectory(rootPath);
  putMediaRoot(repositories, { path: rootPath, lastScannedAt: null, diagnostics: [], directoryIdentity: identity });
  let nowMs = Date.parse("2026-09-24T12:00:00.000Z");
  const probe = vi.fn(options.probe ?? (async () => ({ durationMs: 60_000 })));
  const runner = createPreparationIntakeRunner(repositories, {
    now: () => new Date(nowMs),
    intervalMs: 60_000,
    entryBudget: options.entryBudget,
    adapter: new LocalFolderAdapter(probe),
    watch: false,
    onEvent: options.onEvent,
  });
  return {
    dataDir, rootPath, repositories, runner, probe,
    advance: (ms: number) => { nowMs += ms; },
  };
}

test("PR01 is probed and cataloged only after two matching observations at least 60 seconds apart", async () => {
  const { rootPath, repositories, runner, probe, advance } = await fixture();
  const path = join(rootPath, "PR01.mkv");
  await writeFile(path, "stable video bytes");

  await runner.runOnce();
  expect(probe).not.toHaveBeenCalled();
  expect(repositories.media.list()).toEqual([]);
  expect(repositories.preparation.jobs.list()).toEqual([]);

  advance(59_999);
  await runner.runOnce();
  expect(probe).not.toHaveBeenCalled();

  advance(1);
  await runner.runOnce();
  expect(probe).toHaveBeenCalledTimes(1);
  expect(repositories.media.list()).toEqual([expect.objectContaining({ path, durationStatus: "ok", durationMs: 60_000 })]);
  expect(repositories.preparation.jobs.list()).toHaveLength(1);
  expect(repositories.preparation.jobs.list()[0]).toMatchObject({ state: "queued", source: { path } });
});

test("an absent registered root is skipped and the runner remains usable", async () => {
  const { rootPath, repositories, runner, probe } = await fixture();
  await rm(rootPath, { recursive: true, force: true });
  await expect(runner.runOnce()).resolves.toBeUndefined();
  expect(probe).not.toHaveBeenCalled();
  expect(repositories.media.list()).toEqual([]);
});

test("source mutation during probe discards the result and does not queue work", async () => {
  let changed = false;
  let target = "";
  const probe = vi.fn(async () => {
    if (!changed) {
      changed = true;
      await writeFile(target, "different bytes with a different size");
    }
    return { durationMs: 60_000 };
  });
  const { rootPath, repositories, runner, advance } = await fixture({ probe });
  target = join(rootPath, "Changed.mkv");
  await writeFile(target, "initial bytes");
  await runner.runOnce();
  advance(60_000);
  await runner.runOnce();

  expect(probe).toHaveBeenCalledTimes(1);
  expect(repositories.media.list()).toEqual([]);
  expect(repositories.preparation.jobs.list()).toEqual([]);
});

test("a second runner resumes the durable settle window and repeated passes stay idempotent", async () => {
  const { rootPath, repositories, runner, probe, advance } = await fixture();
  const path = join(rootPath, "Restart.mkv");
  await writeFile(path, "stable video bytes");
  await runner.runOnce();
  advance(60_000);
  await runner.stop();

  const resumed = createPreparationIntakeRunner(repositories, {
    now: () => new Date(Date.parse("2026-09-24T12:01:00.000Z")),
    intervalMs: 60_000,
    adapter: new LocalFolderAdapter(async () => ({ durationMs: 60_000 })),
    watch: false,
  });
  await resumed.runOnce();
  await resumed.runOnce();
  expect(repositories.media.list()).toHaveLength(1);
  expect(repositories.preparation.jobs.list()).toHaveLength(1);
  expect(probe).not.toHaveBeenCalled();
});

test("app lifecycle starts and stops the intake runner", async () => {
  const { rootPath, runner } = await fixture();
  await mkdir(join(rootPath, "Subfolder"));
  const stop = vi.spyOn(runner, "stop");
  const start = vi.spyOn(runner, "start");
  await runner.start();
  expect(start).toHaveBeenCalledTimes(1);
  await runner.stop();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mediaRootId(rootPath)).toBeDefined();
});

test("a catalog entry appearing mid-window does not prevent settlement", async () => {
  const { rootPath, repositories, runner, advance } = await fixture();
  const path = join(rootPath, "PR02.mkv");
  await writeFile(path, "stable video bytes");
  await runner.runOnce();
  expect(repositories.media.list()).toEqual([]);

  // Another component catalogs the same bytes under a different id before the
  // settle window elapses. The pending intake must still settle and queue work.
  const stats = await lstat(path);
  repositories.media.put({
    id: "media-reconciled", source: "local-folder", path, kind: "episode", title: "PR02",
    durationMs: 60_000, durationStatus: "ok", available: true, tags: [],
    deviceId: String(stats.dev), inode: String(stats.ino),
    fileSizeBytes: String(stats.size), fileModifiedMs: String(stats.mtimeMs),
  });

  advance(60_000);
  await runner.runOnce();
  expect(repositories.preparation.jobs.list()).toHaveLength(1);
  expect(repositories.preparation.intakes.list()).toHaveLength(1);
});

test("non-video sidecars do not consume the per-pass candidate budget", async () => {
  const { rootPath, repositories, runner, probe, advance } = await fixture({ entryBudget: 2 });
  for (let index = 0; index < 10; index += 1)
    await writeFile(join(rootPath, `A${index}.nfo`), "sidecar");
  await writeFile(join(rootPath, "ZZ.mkv"), "stable video bytes");

  await runner.runOnce();
  advance(60_000);
  await runner.runOnce();

  expect(probe).toHaveBeenCalledTimes(1);
  expect(repositories.media.list()).toHaveLength(1);
});

test("emits observed then settled events for a new candidate", async () => {
  const events: PreparationEvent[] = [];
  const { rootPath, runner, advance } = await fixture({ onEvent: (event) => events.push(event) });
  const path = join(rootPath, "Ev.mkv");
  await writeFile(path, "stable bytes");

  await runner.runOnce();
  advance(60_000);
  await runner.runOnce();

  expect(events.map((event) => event.event)).toEqual(["intake.observed", "intake.settled"]);
  expect(events[0]).toMatchObject({ path });
  expect(events[1]).toMatchObject({ path });
});

test("the walk advances past already-settled files to reach a new candidate beyond the budget", async () => {
  const { rootPath, repositories, runner } = await fixture({ entryBudget: 1 });
  for (const name of ["A01.mkv", "A02.mkv", "A03.mkv", "A04.mkv", "A05.mkv"]) {
    const path = join(rootPath, name);
    await writeFile(path, "already catalogued bytes");
    const stats = await lstat(path);
    repositories.media.put({
      id: `media-${name}`, source: "local-folder", path, kind: "episode", title: name,
      durationMs: 60_000, durationStatus: "ok", available: true, tags: [],
      deviceId: String(stats.dev), inode: String(stats.ino),
      fileSizeBytes: String(stats.size), fileModifiedMs: String(stats.mtimeMs),
    });
  }
  const fresh = join(rootPath, "Z-fresh.mkv");
  await writeFile(fresh, "genuinely new bytes");

  // Budget is 1 and the settled files sort first; a walk that stalls on them
  // would never observe Z-fresh.
  await runner.runOnce();

  const intakes = repositories.preparation.intakes.list();
  expect(intakes).toHaveLength(1);
  expect(intakes[0].source.path).toBe(fresh);
});

test("an already-settled intake does not stall the walk", async () => {
  const { rootPath, repositories, runner } = await fixture({ entryBudget: 1 });
  const settled = join(rootPath, "A-settled.mkv");
  await writeFile(settled, "settled bytes");
  const stats = await lstat(settled);
  const source = {
    path: settled, sizeBytes: String(stats.size), modifiedMs: String(stats.mtimeMs),
    deviceId: String(stats.dev), inode: String(stats.ino),
  };
  // Already settled, and observed long enough ago that a stale walk would pick
  // it up as "due to probe" and break the pass on it every time.
  repositories.preparation.observe({ sourceMediaId: "media-a", source, observedAt: "2026-09-24T11:00:00.000Z" });
  repositories.preparation.observe({ sourceMediaId: "media-a", source, observedAt: "2026-09-24T11:01:00.000Z" });

  const fresh = join(rootPath, "Z-fresh.mkv");
  await writeFile(fresh, "new bytes");

  await runner.runOnce();

  const paths = repositories.preparation.intakes.list().map((item) => item.source.path);
  expect(paths).toContain(fresh);
});

test("a probe does not stop the walk before later new candidates are observed", async () => {
  const { rootPath, repositories, runner } = await fixture();
  const due = join(rootPath, "A-due.mkv");
  await writeFile(due, "old bytes");
  const stats = await lstat(due);
  const source = {
    path: due, sizeBytes: String(stats.size), modifiedMs: String(stats.mtimeMs),
    deviceId: String(stats.dev), inode: String(stats.ino),
  };
  // Pending and long overdue: the walk reaches it first and probes it. A walk
  // that stopped on the probe would never observe the new file behind it.
  repositories.preparation.observe({ sourceMediaId: "media-due", source, observedAt: "2026-09-24T11:00:00.000Z" });
  const fresh = join(rootPath, "Z-fresh.mkv");
  await writeFile(fresh, "new bytes");

  await runner.runOnce();

  const paths = repositories.preparation.intakes.list().map((item) => item.source.path);
  expect(paths).toContain(fresh);
});
