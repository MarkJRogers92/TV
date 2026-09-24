/**
 * A read-only snapshot of the autopilot's actual state.
 *
 * Everything here is derived from what is already stored or on disk; nothing is
 * planned, written, or consumed. It exists so the dashboard (and a human
 * debugging a channel) can answer "what is the autopilot doing right now?"
 * without guessing from logs: preparation backlog and outcomes, which media
 * roots are actually mounted, and how far each channel's schedule reaches.
 */
import type { Repositories } from "../db/repositories.js";
import { assertManagedDirectory, captureManagedDirectory } from "../acquisition/paths.js";
import { listMediaRoots } from "../media/roots.js";
import { assessCoverage } from "../scheduler/coverage.js";
import type { PreparationClassification, PreparationJobState } from "../preparation/models.js";

export type PreparationStatus = {
  intakes: number;
  jobs: Record<PreparationJobState, number>;
  classifications: Record<PreparationClassification, number>;
  /** Newest jobs first, for a quick "what just happened" view. */
  recent: Array<{ path: string; state: PreparationJobState; classification: PreparationClassification | null }>;
};

export type MediaRootStatus = { path: string; present: boolean };

export type ChannelHorizonStatus = {
  id: string;
  name: string;
  hoursCovered: number;
  gaps: number;
  contiguous: boolean;
};

export type AutopilotStatus = {
  at: string;
  preparation: PreparationStatus;
  mediaRoots: MediaRootStatus[];
  channels: ChannelHorizonStatus[];
};

const JOB_STATES: PreparationJobState[] = ["queued", "running", "completed", "failed", "stale"];
const CLASSIFICATIONS: PreparationClassification[] = ["ready_original", "needs_remux", "needs_normalize", "quarantined", "unavailable"];

export function preparationStatus(repositories: Repositories, limit = 10): PreparationStatus {
  const jobs = repositories.preparation.jobs.list();
  const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<PreparationJobState, number>;
  const classifications = Object.fromEntries(CLASSIFICATIONS.map((value) => [value, 0])) as Record<PreparationClassification, number>;
  for (const job of jobs) {
    counts[job.state] += 1;
    if (job.classification) classifications[job.classification] += 1;
  }
  return {
    intakes: repositories.preparation.intakes.list().length,
    jobs: counts,
    classifications,
    recent: jobs.slice(-limit).reverse().map((job) => ({
      path: job.source.path,
      state: job.state,
      classification: job.classification,
    })),
  };
}

/** Whether each registered root is currently reachable. A missing drive is reported, never treated as empty. */
export async function mediaRootStatus(repositories: Repositories): Promise<MediaRootStatus[]> {
  const roots = listMediaRoots(repositories);
  const statuses: MediaRootStatus[] = [];
  for (const root of roots) {
    try {
      const identity = root.directoryIdentity ?? await captureManagedDirectory(root.path);
      await assertManagedDirectory(identity);
      statuses.push({ path: root.path, present: true });
    } catch {
      statuses.push({ path: root.path, present: false });
    }
  }
  return statuses;
}

/** How far each enabled channel's stored metadata reaches over the R09 horizon. */
export function channelHorizonStatus(
  repositories: Repositories,
  now: Date,
  horizonHours = 72,
): ChannelHorizonStatus[] {
  const startMs = now.getTime();
  const endMs = startMs + horizonHours * 3_600_000;
  return repositories.channels.list().map((channel) => {
    const coverage = assessCoverage(repositories.schedules.list(channel.id), { startMs, endMs });
    return {
      id: channel.id,
      name: channel.name,
      hoursCovered: Math.round(coverage.coveredMs / 3_600_000),
      gaps: coverage.gaps.length,
      contiguous: coverage.contiguous,
    };
  });
}

export async function autopilotStatus(repositories: Repositories, now: Date): Promise<AutopilotStatus> {
  return {
    at: now.toISOString(),
    preparation: preparationStatus(repositories),
    mediaRoots: await mediaRootStatus(repositories),
    channels: channelHorizonStatus(repositories, now),
  };
}
