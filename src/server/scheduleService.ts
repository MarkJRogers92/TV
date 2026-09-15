import { join } from "node:path";
import type { Repositories } from "../db/repositories.js";
import type { Channel, Schedule } from "../domain/models.js";
import type { EpisodeMidrollPolicy, MediaItem } from "../domain/models.js";
import { writeScheduleExport } from "../export/marktvJson.js";
import {
  generateSchedule,
  type ScheduleGenerationResult,
} from "../scheduler/generate.js";
import {
  EpisodeBreakAnalyzer,
  episodeBreakAnalysisKey,
  type EpisodeBreakAnalysis,
} from "../media/episodeBreaks.js";

export type ExportSchedule = (
  schedule: Schedule,
  destinationDir: string,
) => Promise<string>;
export type PersistedGeneration =
  | { ok: true; schedule: Schedule; exportPath: string }
  | Extract<ScheduleGenerationResult, { ok: false }>;

export class ScheduleExportError extends Error {
  readonly code = "EXPORT_FAILED";
}

export class ScheduleService {
  private readonly inFlight = new Map<string, Promise<PersistedGeneration>>();
  private readonly episodeBreakAnalyzer: {
    analyze(
      item: MediaItem,
      policy: EpisodeMidrollPolicy,
    ): Promise<EpisodeBreakAnalysis>;
  };

  constructor(
    private readonly repositories: Repositories,
    private readonly dataDir: string,
    private readonly now: () => Date,
    private readonly exportSchedule: ExportSchedule = writeScheduleExport,
    episodeBreakAnalyzer?: {
      analyze(
        item: MediaItem,
        policy: EpisodeMidrollPolicy,
      ): Promise<EpisodeBreakAnalysis>;
    },
  ) {
    this.episodeBreakAnalyzer =
      episodeBreakAnalyzer ??
      new EpisodeBreakAnalyzer({
        cache: {
          get: (key) =>
            this.repositories.settings.get(`episode-break-analysis:${key}`)
              ?.value,
          put: (key, value) =>
            this.repositories.settings.put(
              `episode-break-analysis:${key}`,
              value,
            ),
        },
      });
  }

  private async analyzeEpisodeBreaks(channel: Channel) {
    const pools = this.repositories.pools.list();
    const items = this.repositories.media.list();
    const poolsById = new Map(pools.map((pool) => [pool.id, pool]));
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const work = new Map<
      string,
      { item: MediaItem; policy: EpisodeMidrollPolicy }
    >();
    for (const slot of channel.slots) {
      if (slot.kind !== "episode" || !slot.episodeMidroll) continue;
      for (const poolId of [...slot.poolIds, ...slot.fallbackPoolIds]) {
        for (const mediaId of poolsById.get(poolId)?.mediaIds ?? []) {
          const item = itemsById.get(mediaId);
          if (
            !item ||
            item.kind !== "episode" ||
            item.source !== "local-folder" ||
            !item.path ||
            !item.available
          )
            continue;
          const key = episodeBreakAnalysisKey(item.id, slot.episodeMidroll);
          work.set(key, { item, policy: slot.episodeMidroll });
        }
      }
    }
    const analyses: Record<string, EpisodeBreakAnalysis> = {};
    const pending = [...work.entries()];
    const worker = async () => {
      for (;;) {
        const next = pending.shift();
        if (!next) return;
        analyses[next[0]] = await this.episodeBreakAnalyzer.analyze(
          next[1].item,
          next[1].policy,
        );
      }
    };
    await Promise.all([worker(), worker()]);
    return analyses;
  }

  async generate(channel: Channel, date: string): Promise<PersistedGeneration> {
    const episodeBreakAnalyses = await this.analyzeEpisodeBreaks(channel);
    const result = generateSchedule({
      channel,
      pools: this.repositories.pools.list(),
      items: this.repositories.media.list(),
      date,
      history: this.repositories.schedules.historyBefore(channel.id, date),
      now: this.now(),
      episodeBreakAnalyses,
    });
    if (result.ok === false) return result;

    let exportPath: string;
    try {
      exportPath = await this.exportSchedule(
        result.schedule,
        join(this.dataDir, "exports"),
      );
    } catch (error) {
      throw new ScheduleExportError(
        `Could not export schedule: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    this.repositories.schedules.replaceSuccessful(channel.id, result.schedule);
    return { ok: true, schedule: result.schedule, exportPath };
  }

  async ensure(channel: Channel, date: string): Promise<PersistedGeneration> {
    const existing = this.repositories.schedules.latest(channel.id);
    if (existing) return { ok: true, schedule: existing, exportPath: "" };
    const key = `${channel.id}:${date}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const generation = this.generate(channel, date);
    this.inFlight.set(key, generation);
    try {
      return await generation;
    } finally {
      if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
    }
  }
}
