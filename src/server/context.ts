import type { Repositories } from "../db/repositories.js";
import type { ScheduleService } from "./scheduleService.js";

export type ServerContext = {
  repositories: Repositories;
  dataDir: string;
  now: () => Date;
  schedules: ScheduleService;
};

export type MediaRootRecord = {
  id: string;
  path: string;
  lastScannedAt: string | null;
  diagnostics: Array<{ code: string; path: string; message: string }>;
};
