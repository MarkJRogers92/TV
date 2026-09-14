import { join } from "node:path";
import type { Repositories } from "../db/repositories.js";
import type { Channel, Schedule } from "../domain/models.js";
import { writeScheduleExport } from "../export/marktvJson.js";
import {
  generateSchedule,
  type ScheduleGenerationResult,
} from "../scheduler/generate.js";

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

  constructor(
    private readonly repositories: Repositories,
    private readonly dataDir: string,
    private readonly now: () => Date,
    private readonly exportSchedule: ExportSchedule = writeScheduleExport,
  ) {}

  async generate(channel: Channel, date: string): Promise<PersistedGeneration> {
    const result = generateSchedule({
      channel,
      pools: this.repositories.pools.list(),
      items: this.repositories.media.list(),
      date,
      history: this.repositories.schedules.historyBefore(channel.id, date),
      now: this.now(),
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
