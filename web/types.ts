import type {
  Channel,
  MediaItem,
  Pool,
  Schedule,
  ScheduleEntry,
} from "../src/domain/models";

export type { Channel, MediaItem, Pool, Schedule, ScheduleEntry };
export type ValidationIssue = { path: string; message: string };
export type ApiError = Error & { code?: string; issues?: ValidationIssue[] };
export type AirStatus = {
  channel: Pick<Channel, "id" | "name" | "number" | "timezone">;
  currentTime: string;
  scheduleStatus: string;
  nowPlaying: ScheduleEntry | null;
  upNext: ScheduleEntry | null;
};
export type MediaRoot = {
  id: string;
  path: string;
  lastScannedAt: string | null;
  diagnostics: Array<{ code: string; path: string; message: string }>;
};
export type ScanResult = {
  root: MediaRoot;
  result: { items: MediaItem[]; diagnostics: MediaRoot["diagnostics"] };
};
export type GeneratedSchedule = { schedule: Schedule; exportPath: string };
