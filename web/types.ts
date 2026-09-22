import type {
  Channel,
  MediaItem,
  MovieRole,
  Pool,
  Schedule,
  ScheduleEntry,
} from "../src/domain/models";

export type { Channel, MediaItem, MovieRole, Pool, Schedule, ScheduleEntry };
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

export type ContinuityFrequency = "low" | "normal" | "high";
export type ContinuityWeirdness = "off" | "low" | "normal";

/** The card the director plans for one break, as the UI shows it. */
export type ContinuityPlannedCard = {
  cardType: "next" | "next-later" | "tonight" | "weekend" | "after-dark";
  family: "syndication" | "local-cable" | "prime-time" | "overnight";
  label: string;
  title: string;
  details: string[];
  durationMs: number;
  insertionInstant: string;
  targetTitles: string[];
  targetTimes: string[];
  /** True once the matching offline-rendered video is registered. */
  assetRegistered: boolean;
};

/** Read-only readiness information plus the continuity director controls. */
export type ContinuityStatus = {
  channelId: string;
  config: {
    enabled: boolean;
    nextCards: boolean;
    nextLaterFrequency: ContinuityFrequency;
    tonightFrequency: ContinuityFrequency;
    overnightWeirdness: ContinuityWeirdness;
    stagedInterruptionsEnabled: boolean;
    promoFrequency: number;
    clipCooldownMinutes: number;
    targetCooldownMinutes: number;
    oddPersonaCooldownHours: number;
    maximumSpokenElementsPerBreak: number;
    maximumContinuitySecondsPerBreak: number;
  };
  activation: {
    state: "enabled" | "disabled";
    reason: string | null;
    ready: boolean;
    canEnable: boolean;
  };
  branding: { state: "bound" | "missing" | "invalid"; expectedFile: string };
  assets: {
    discovered: number;
    airReady: number;
    generated: number;
    scriptOnly: number;
    quarantined: number;
  };
  voices: { network: number; local: number; overnight: number; odd: number; unclassified: number };
  director: {
    scheduleRevision: string;
    contentHash: string | null;
    label: string;
    current: string | null;
    next: string | null;
    later: string | null;
    cards: ContinuityPlannedCard[];
    skippedReason: string | null;
  };
  preview: {
    scheduleRevision: string;
    insertionInstant: string;
    label: string;
    current: string | null;
    next: string | null;
    later: string | null;
    selectedAsset: string | null;
    skippedReason: string | null;
  };
};

export type ContinuityUpdate = Partial<
  Pick<
    ContinuityStatus["config"],
    | "enabled"
    | "nextCards"
    | "nextLaterFrequency"
    | "tonightFrequency"
    | "overnightWeirdness"
    | "stagedInterruptionsEnabled"
    | "promoFrequency"
  >
>;

/** One movie airing the feature has assigned to a broadcast date. */
export type MovieProgrammingAiring = {
  date: string;
  position: "nightly" | "double-feature-1" | "double-feature-2";
  role: MovieRole;
  anchor: string;
  mediaId: string;
  title: string;
  /** An encore reuses an earlier opener and draws nothing new. */
  encore: boolean;
  available: boolean;
  consumes: boolean;
};

/**
 * What the movie-programming control reports.
 *
 * The optional half is present only while the feature is enabled, so a disabled
 * channel cannot look like it has a folder, a rotation, or a horizon.
 */
export type MovieProgrammingStatus = {
  channelId: string;
  enabled: boolean;
  upcoming: MovieProgrammingAiring[];
  degraded: string[];
  poolIds?: string[];
  rootPath?: string;
  rootAvailable?: boolean;
  movieCount?: number;
  rotationUpdatedAt?: string;
  lookaheadDays?: number;
};

export type MovieProgrammingControl = {
  enabled: boolean;
  poolIds?: string[];
  rootPath?: string;
};

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
export type WantedMovieView = {
  id: string;
  title: string;
  year: number | null;
  status: TechnicalState;
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
  stremioUrl: string;
};
export type NewWantedMovieInput = {
  title: string;
  year?: number | null;
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
