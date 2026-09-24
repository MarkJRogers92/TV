import { watch as watchDirectory, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { Repositories } from "../db/repositories.js";
import { assertManagedDirectory, captureManagedDirectory, type ManagedDirectoryIdentity } from "../acquisition/paths.js";
import { isVideoExtension } from "../acquisition/filename.js";
import { LocalFolderAdapter } from "../media/localFolder.js";
import { persistScannedMedia } from "../media/catalogReconcile.js";
import { listMediaRoots } from "../media/roots.js";
import { isPreparationCandidate } from "./repository.js";
import type { PreparationObserver } from "./events.js";
import { sourceVersionFromStats, sourceVersionsEqual } from "./sourceVersion.js";

const DERIVED_DIRECTORY_NAMES = ["generated", "derived", "prepared", "transcoded", "transcodes", "renditions"] as const;
const DERIVED_DIRECTORY_SET = new Set<string>(DERIVED_DIRECTORY_NAMES);

export type PreparationIntakeRunnerOptions = {
  intervalMs?: number;
  /**
   * Bounds how many NEW candidates are observed per pass. Already-settled and
   * already-tracked files do not consume it, and the walk visits every directory
   * even after a probe, so one root's backlog cannot starve the others.
   */
  entryBudget?: number;
  now?: () => Date;
  adapter?: LocalFolderAdapter;
  watch?: boolean;
  onError?: (error: unknown, path?: string) => void;
  onEvent?: PreparationObserver;
};

export type PreparationIntakeRunner = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for deterministic tests and controlled maintenance runs. */
  runOnce(): Promise<void>;
};

function isDerivedDirectory(name: string): boolean {
  return DERIVED_DIRECTORY_SET.has(name.toLowerCase());
}

function mediaVersionMatches(item: { path?: string; fileSizeBytes?: string; fileModifiedMs?: string; deviceId?: string; inode?: string }, source: ReturnType<typeof sourceVersionFromStats>): boolean {
  return item.path === source.path && item.fileSizeBytes === source.sizeBytes &&
    item.fileModifiedMs === source.modifiedMs && item.deviceId === source.deviceId && item.inode === source.inode;
}

function idempotencyKey(path: string): string {
  return `local-${Buffer.from(path).toString("base64url")}`;
}

export function createPreparationIntakeRunner(
  repositories: Repositories,
  options: PreparationIntakeRunnerOptions = {},
): PreparationIntakeRunner {
  const intervalMs = options.intervalMs ?? 15_000;
  const entryBudget = options.entryBudget ?? 96;
  const now = options.now ?? (() => new Date());
  const adapter = options.adapter ?? new LocalFolderAdapter();
  const shouldWatch = options.watch ?? true;
  const onError = options.onError ?? (() => undefined);
  const onEvent = options.onEvent ?? (() => undefined);
  const watchers = new Map<string, FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping = false;
  let started = false;
  let rerunRequested = false;

  const closeWatchers = () => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };

  const schedule = (delay = intervalMs) => {
    if (stopping || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, delay);
    timer.unref();
  };

  const ensureWatch = (directory: string) => {
    if (!shouldWatch || watchers.has(directory)) return;
    try {
      const watcher = watchDirectory(directory, () => {
        if (inFlight) { rerunRequested = true; return; }
        schedule(0);
      });
      watcher.on("error", (error) => onError(error, directory));
      watchers.set(directory, watcher);
    } catch (error) {
      // fs.watch can be unavailable on removable/network volumes. Polling remains
      // the source of truth, so an unsupported watcher is only a diagnostic.
      onError(error, directory);
    }
  };

  const runPass = async () => {
    const roots = listMediaRoots(repositories);
    const existingByPath = new Map(repositories.media.list().flatMap((item) => item.path ? [[item.path, item] as const] : []));

    // Resolve every registered root up front (few roots), so unreachable roots
    // are recognised even when the scan budget stops the walk early, and so the
    // watcher prune compares like-for-like real paths.
    const reachable: ManagedDirectoryIdentity[] = [];
    for (const root of roots) {
      try {
        const identity = root.directoryIdentity ?? await captureManagedDirectory(root.path);
        await assertManagedDirectory(identity);
        reachable.push(identity);
      } catch {
        // A missing drive, replaced root, or permission failure is not an empty
        // catalog. Leave durable observations untouched until it returns.
      }
    }
    const reachablePaths = reachable.map((identity) => identity.path);
    for (const [directory, watcher] of watchers) {
      if (!reachablePaths.some((root) => directory === root || directory.startsWith(`${root}${sep}`))) {
        watcher.close();
        watchers.delete(directory);
      }
    }

    // Bounds how many NEW candidates are observed per pass. The walk itself is
    // not capped: every directory is still visited so a file that is ready to
    // probe is never starved behind a long prefix of already-seen files, and so
    // successive passes reach the whole tree instead of re-reading its head.
    let observationsThisPass = 0;
    let probedOne = false;
    const intakes = repositories.preparation.intakes.list();

    for (const identity of reachable) {
      // One directory watcher per root. Deep-tree changes are caught by the poll;
      // a watcher per subdirectory would grow without bound on a large library.
      ensureWatch(identity.path);
      const outputDirectories = DERIVED_DIRECTORY_NAMES.map((name) => join(identity.path, name));
      const directories = [identity.path];
      while (directories.length) {
        const directory = directories.shift()!;
        let entries;
        try {
          await assertManagedDirectory(identity);
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (!isDerivedDirectory(entry.name)) directories.push(join(directory, entry.name));
            continue;
          }
          if (!entry.isFile() || !isVideoExtension(extname(entry.name))) continue;
          const path = join(directory, entry.name);
          const rel = relative(identity.path, path);
          if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
          if (!isPreparationCandidate(path, outputDirectories)) continue;

          try {
            await assertManagedDirectory(identity);
            const stats = await lstat(path);
            if (!stats.isFile() || stats.isSymbolicLink()) continue;
            const source = sourceVersionFromStats(path, stats);
            const existing = existingByPath.get(path);

            // Key observations by the source version, not the catalog id. The
            // catalog can gain (or re-key) an entry for this path mid-window, and
            // resolving the id from `existing` each pass would then orphan the
            // pending intake, start a duplicate one for the same bytes, or (with
            // a plain catalog check first) never settle at all.
            const prior = intakes.find((item) => sourceVersionsEqual(item.source, source));
            const pending = prior !== undefined && prior.settledAt === null;
            const catalogued = existing !== undefined && mediaVersionMatches(existing, source);

            // A settled intake or an exact catalog match is DONE. Skipping it here,
            // before the probe branch, is what lets the walk advance: otherwise a
            // single settled-but-uncatalogued file is re-probed and breaks the pass
            // every time, and the runner never reaches the rest of the tree. Neither
            // case consumes the new-observation budget.
            if (!pending && (prior !== undefined || catalogued)) continue;

            if (pending && prior) {
              // Observed before, not yet settled. Not due -> skip cheaply; due ->
              // probe it to settle. This runs even when the file was catalogued
              // mid-window, so a pending intake still completes.
              // At most one probe per pass, but the walk does NOT stop here: a
              // root whose backlog is always due first would otherwise starve
              // every later root, so probes are capped, not the walk.
              if (probedOne) continue;
              if (Date.parse(now().toISOString()) - Date.parse(prior.firstObservedAt) < 60_000) continue;

              // At most one ffprobe operation per pass and one across this driver.
              // Hashing around the probe plus a fresh stat catches same-path edits
              // that happened while ffprobe was reading the source.
              const item = await adapter.scanFile(identity.path, path);
              await assertManagedDirectory(identity);
              const after = await lstat(path);
              const current = after.isFile() && !after.isSymbolicLink() ? sourceVersionFromStats(path, after) : null;
              if (!current || !sourceVersionsEqual(source, current)) continue;
              const observedAt = now().toISOString();
              const settled = repositories.preparation.observe({ sourceMediaId: prior.sourceMediaId, source: current, observedAt }, { outputDirectories });
              if (settled.kind !== "settled") continue;
              persistScannedMedia(repositories, [item]);
              existingByPath.set(path, item);
              onEvent({ event: "intake.settled", path, sourceMediaId: prior.sourceMediaId });
              probedOne = true;
              continue;
            }

            // A genuinely new candidate: the only thing the per-pass budget caps.
            if (observationsThisPass >= entryBudget) continue;
            observationsThisPass += 1;
            const sourceMediaId = existing?.id ?? idempotencyKey(path);
            const observed = repositories.preparation.observe({ sourceMediaId, source, observedAt: now().toISOString() }, { outputDirectories });
            if (observed.kind === "observed") onEvent({ event: "intake.observed", path, sourceMediaId });
          } catch (error) {
            onError(error, path);
          }
        }
      }
    }
  };

  const runOnce = async () => {
    if (stopping) return;
    if (inFlight) { rerunRequested = true; return inFlight; }
    inFlight = runPass().catch((error) => onError(error)).finally(() => {
      inFlight = undefined;
      if (rerunRequested && !stopping) {
        rerunRequested = false;
        schedule(0);
      } else if (started && !stopping) schedule();
    });
    return inFlight;
  };

  return {
    async start() {
      if (started || stopping) return;
      started = true;
      await runOnce();
    },
    async stop() {
      stopping = true;
      started = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      closeWatchers();
      await inFlight;
    },
    runOnce,
  };
}
