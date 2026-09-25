import { lstatSync } from "node:fs";
import type { Repositories } from "../db/repositories.js";
import type { MediaItem } from "../domain/models.js";
import type { PreparationJob } from "./models.js";
import { readSourceVersionSync, sourceVersionsEqual } from "./sourceVersion.js";

/** Apply only verdicts for the exact catalogued file version. Pool IDs remain logical IDs. */
export function preparationEligibleMedia(repositories: Repositories, items: readonly MediaItem[]): MediaItem[] {
  const jobs = new Map<string, PreparationJob>();
  for (const job of repositories.preparation.jobs.list()) {
    const prior = jobs.get(job.sourceMediaId);
    if (!prior || Date.parse(job.updatedAt) > Date.parse(prior.updatedAt)) jobs.set(job.sourceMediaId, job);
  }
  return items.map((item) => {
    if (item.source !== "local-folder" || !item.path || item.sourceMediaId) return item;
    const job = jobs.get(item.id);
    if (!job || (job.state !== "completed" && job.state !== "stale") || job.source.path !== item.path ||
      job.source.sizeBytes !== item.fileSizeBytes || job.source.modifiedMs !== item.fileModifiedMs ||
      job.source.deviceId !== item.deviceId || job.source.inode !== item.inode) return item;
    if (job.classification === "unavailable") {
      try { readSourceVersionSync(item.path); return item; }
      catch { return { ...item, available: false }; }
    }
    try {
      if (!sourceVersionsEqual(job.source, readSourceVersionSync(item.path))) return item;
      if (job.classification === "quarantined") return { ...item, available: false };
      if (job.state !== "completed" || !job.rendition) return item;
      const stat = lstatSync(job.rendition.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return item;
      return { ...item, path: job.rendition.path };
    } catch {
      // A missing proven-corrupt source cannot be treated as a fresh version.
      // For a missing cache file, the working original remains the fallback.
      return job.classification === "quarantined" ? { ...item, available: false } : item;
    }
  });
}
