/**
 * A read-only snapshot of the autopilot's actual state.
 *
 * Everything here is derived from what is already stored or on disk; nothing is
 * planned, written, or consumed. It exists so the dashboard (and a human
 * debugging a channel) can answer "what is the autopilot doing right now?"
 * without guessing from logs: preparation backlog and outcomes, which media
 * roots are actually mounted, and how far each channel's schedule reaches.
 */
import { statfs } from "node:fs/promises";
import { DateTime } from "luxon";
import type { Repositories } from "../db/repositories.js";
import type { Channel, ScheduleEntry } from "../domain/models.js";
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

export type MediaRootStatus = {
  path: string;
  present: boolean;
  /** Free bytes on the volume, when it is present. */
  freeBytes?: number;
};

export type AirEntry = {
  title: string;
  kind: string;
  mediaId?: string;
  movieRole?: string;
  start: string;
  end: string;
};

export type ChannelAirState = {
  /** The schedule entry actually airing right now, or null if none covers now. */
  onAir: (AirEntry & { elapsedMs: number; remainingMs: number }) | null;
  /** The next few committed entries, soonest first. */
  next: AirEntry[];
};

export type ChannelHorizonStatus = {
  id: string;
  name: string;
  hoursCovered: number;
  gaps: number;
  contiguous: boolean;
  air: ChannelAirState;
};

function airEntry(entry: ScheduleEntry): AirEntry {
  return {
    title: entry.title,
    kind: entry.kind,
    ...(entry.mediaId ? { mediaId: entry.mediaId } : {}),
    ...(entry.movieRole ? { movieRole: entry.movieRole } : {}),
    start: entry.start,
    end: entry.end,
  };
}

/**
 * What a channel is airing now and next, read from its committed schedule.
 *
 * Purely derived from the stored schedule for the channel's own broadcast date
 * (and the next day when an entry spans midnight); it never triggers generation.
 */
export function channelAirState(
  repositories: Repositories,
  channel: Channel,
  now: Date,
  nextCount = 3,
): ChannelAirState {
  const local = DateTime.fromJSDate(now, { zone: channel.timezone });
  const today = local.toISODate();
  if (!today) return { onAir: null, next: [] };
  const tomorrow = local.plus({ days: 1 }).toISODate();
  const entries = [
    ...(repositories.schedules.latestForDate(channel.id, today)?.entries ?? []),
    ...(tomorrow
      ? repositories.schedules.latestForDate(channel.id, tomorrow)?.entries ?? []
      : []),
  ];
  const nowMs = now.getTime();
  const onAir =
    entries.find(
      (entry) => Date.parse(entry.start) <= nowMs && nowMs < Date.parse(entry.end),
    ) ?? null;
  const next = entries
    .filter((entry) => Date.parse(entry.start) > nowMs)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
    .slice(0, nextCount)
    .map(airEntry);
  return {
    onAir: onAir
      ? {
          ...airEntry(onAir),
          elapsedMs: nowMs - Date.parse(onAir.start),
          remainingMs: Date.parse(onAir.end) - nowMs,
        }
      : null,
    next,
  };
}

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
      const stats = await statfs(identity.path).catch(() => undefined);
      statuses.push({
        path: root.path,
        present: true,
        ...(stats ? { freeBytes: Number(stats.bavail) * Number(stats.bsize) } : {}),
      });
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
      air: channelAirState(repositories, channel, now),
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
