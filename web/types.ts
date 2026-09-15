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

export type TechnicalState =
  | "wanted"
  | "waiting-provider"
  | "match-found"
  | "retry-wait"
  | "downloading"
  | "verifying"
  | "placing"
  | "imported"
  | "needs-review"
  | "cancelled";
export type AcquisitionProviderId = "real-debrid" | "torbox";
export type WantedJobView = {
  id: string;
  state: TechnicalState;
  provider: AcquisitionProviderId;
  attempt: number;
  maxAttempts: number;
  expectedBytes: number | null;
  receivedBytes: number;
  retryAfterMs: number | null;
  cancelRequested: boolean;
  updatedAt: string;
};
export type WantedReviewView = {
  id: string;
  kind: string;
  message: string;
  candidateCount: number;
  candidates: Array<{
    candidateIndex: number;
    provider: AcquisitionProviderId;
    filename: string;
    sizeBytes: number | null;
    resolution: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
};
export type WantedView = {
  id: string;
  seriesTitle: string;
  season: number;
  episode: number;
  episodeTitle: string | null;
  status: TechnicalState;
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
  stremioUrl: string;
  job: WantedJobView | null;
  review: WantedReviewView | null;
};
export type NewWantedInput = {
  seriesTitle: string;
  season: number;
  episode: number;
  episodeTitle?: string | null;
};
export type SeasonPackEpisodeView = {
  episode: number | null;
  sizeBytes: number | null;
  resolution: string | null;
  status: TechnicalState | null;
};
export type SeasonPackView = {
  id: string;
  provider: AcquisitionProviderId | null;
  seriesTitle: string | null;
  season: number | null;
  episodeCount: number | null;
  totalBytes: number | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  episodes: SeasonPackEpisodeView[];
};
export type IntegrationProvider = "real-debrid" | "torbox";
export type IntegrationProjection = {
  provider: IntegrationProvider;
  connected: boolean;
  accountLabel: string | null;
  error: { code: string; message: string } | null;
};
export type JobActionResult = { status: string; job: WantedJobView };
export type ImportSeasonResult = {
  status: string;
  wantedIds: string[];
  jobIds: string[];
  alreadyImported: number;
  alreadyScheduled: number;
};
