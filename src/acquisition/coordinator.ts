import { randomUUID } from "node:crypto";
import { stat, statfs } from "node:fs/promises";
import type { Repositories } from "../db/repositories.js";
import type { MediaItem } from "../domain/models.js";
import {
  ProviderError,
  type AcquisitionProvider,
  type ProviderErrorCode,
} from "../integrations/acquisition/provider.js";
import type { ProbeResult } from "../media/adapter.js";
import { LocalFolderAdapter } from "../media/localFolder.js";
import type { CredentialStore } from "../security/credentialStore.js";
import {
  downloadJob,
  DownloadError,
  type DownloadErrorCode,
  type DownloadHooks,
  type DownloadJobInput,
} from "./downloader.js";
import { parseVideoCandidate } from "./filename.js";
import {
  importVerifiedEpisode,
  ImportNeedsReviewError,
  ImportVerificationError,
  type VerifiedImportContext,
  type VerifiedImportResult,
} from "./importer.js";
import {
  matchCompletedFiles,
  minimumPlausibleBytes,
  type MatchPlan,
  type MatchSelection,
} from "./matcher.js";
import {
  episodeKey,
  normalizedSeriesTitle,
  seasonPackReviewId,
  type AcquisitionJob,
  type AcquisitionProviderId,
  type AcquisitionReview,
  type AcquisitionReviewCandidate,
  type CompletedImport,
  type WantedEpisode,
} from "./models.js";
import {
  containedPath,
  ManagedPathError,
  type ManagedPaths,
} from "./paths.js";
import type { ProviderName, RemoteItem, RemoteItemType } from "./providerTypes.js";
import { AcquisitionConflictError } from "./repository.js";

/**
 * The persisted job vocabulary is deliberately provider-neutral and admits
 * exactly one item type today; provider adapters are torrent-only until a
 * second `RemoteItemType` is added together with its adapter.
 */
const jobItemType: RemoteItemType = "torrent";

/** Total attempts (download or import cycles) one job may make by default. */
export const defaultMaxAttempts = 3;
/** Default provider poll interval. */
export const defaultPollIntervalMs = 60_000;
/** Ceiling for the bounded exponential backoff used when a failure has no typed retry hint. */
export const maximumBackoffMs = 30_000;

export type TransferReason = "user" | "shutdown" | null;

export interface CoordinatorTimer {
  unref?(): void;
}

/** Injected timer seam so lifecycle tests never wait on a real clock. */
export interface CoordinatorTimers {
  setInterval(callback: () => void, milliseconds: number): CoordinatorTimer;
  clearInterval(timer: CoordinatorTimer): void;
}

export type DownloadExecutor = (
  job: DownloadJobInput,
  provider: AcquisitionProvider,
  token: string,
  hooks: DownloadHooks,
  signal: AbortSignal,
) => Promise<string>;

export type ImportExecutor = (
  job: AcquisitionJob,
  wanted: WantedEpisode,
  partPath: string,
  context: VerifiedImportContext,
) => Promise<VerifiedImportResult>;

export interface AcquisitionCoordinatorDependencies {
  readonly repositories: Repositories;
  readonly credentials: CredentialStore;
  /** Complete, identity-validated provider map; keys must match implementations. */
  readonly providers: Record<ProviderName, AcquisitionProvider>;
  /** Managed paths captured at startup, including directory inode identities. */
  readonly paths: ManagedPaths;
  readonly download?: DownloadExecutor;
  readonly importEpisode?: ImportExecutor;
  readonly scanLibrary?: (root: string) => Promise<{ items: MediaItem[] }>;
  readonly probe?: (path: string) => Promise<ProbeResult>;
  readonly hasFreeBytes?: (neededBytes: number) => Promise<boolean>;
  readonly partialBytes?: (partPath: string) => Promise<number | null>;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly timers?: CoordinatorTimers;
  readonly intervalMs?: number;
}

export type ProviderPollState = {
  readonly provider: AcquisitionProviderId;
  readonly state: "ok" | "missing-credential" | "error";
  readonly itemCount: number;
  readonly errorCode: ProviderErrorCode | null;
};

export interface PollOutcome {
  readonly providers: readonly ProviderPollState[];
  /** Jobs reserved for still-Wanted selections during this poll, in reservation order. */
  readonly reservedJobIds: readonly string[];
  readonly matchedWantedIds: readonly string[];
  readonly reviewId: string | null;
  readonly seasonPackReviewId: string | null;
}

export type RetryOutcome =
  | { readonly kind: "queued"; readonly job: AcquisitionJob }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly reason: "missing-wanted"; readonly job: AcquisitionJob }
  | { readonly kind: "already-imported"; readonly job: AcquisitionJob }
  | { readonly kind: "active"; readonly job: AcquisitionJob };

export type CancelOutcome =
  | { readonly kind: "cancelled"; readonly job: AcquisitionJob }
  | { readonly kind: "not-found" }
  | { readonly kind: "already-cancelled"; readonly job: AcquisitionJob }
  | { readonly kind: "already-imported"; readonly job: AcquisitionJob };

export type StaleSeasonPackReason =
  | "missing-identity"
  | "empty-pack"
  | "mixed-locators"
  | "item-missing"
  | "not-completed"
  | "missing-file"
  | "changed-pack"
  | "unknown-pack-bytes";

export type SeasonImportOutcome =
  | {
      readonly kind: "scheduled";
      readonly wantedIds: readonly string[];
      readonly jobIds: readonly string[];
      readonly alreadyImported: number;
      readonly alreadyScheduled: number;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid-offer" }
  | { readonly kind: "no-credential"; readonly provider: AcquisitionProviderId }
  | {
      readonly kind: "provider-error";
      readonly provider: AcquisitionProviderId;
      readonly code: ProviderErrorCode;
      readonly retryable: boolean;
    }
  | {
      readonly kind: "stale";
      readonly provider: AcquisitionProviderId;
      readonly reason: StaleSeasonPackReason;
    }
  | {
      readonly kind: "insufficient-space";
      readonly provider: AcquisitionProviderId;
      readonly neededBytes: number;
    };

export type CandidateSelectionOutcome =
  | { readonly kind: "scheduled"; readonly job: AcquisitionJob }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid-review" }
  | { readonly kind: "stale-review" }
  | { readonly kind: "invalid-candidate" }
  | { readonly kind: "no-credential"; readonly provider: AcquisitionProviderId }
  | {
      readonly kind: "provider-error";
      readonly provider: AcquisitionProviderId;
      readonly code: ProviderErrorCode;
      readonly retryable: boolean;
    }
  | { readonly kind: "stale-candidate"; readonly provider: AcquisitionProviderId }
  | { readonly kind: "conflict" };

export class CoordinatorConfigurationError extends Error {
  readonly name = "CoordinatorConfigurationError";
}

type ProviderRead =
  | { readonly provider: ProviderName; readonly state: "ok"; readonly items: readonly RemoteItem[] }
  | { readonly provider: ProviderName; readonly state: "missing-credential"; readonly items: readonly RemoteItem[] }
  | { readonly provider: ProviderName; readonly state: "error"; readonly error: unknown; readonly items: readonly RemoteItem[] };

interface ActiveOperation {
  readonly controller: AbortController;
  reason: TransferReason;
  publicationCommitted: boolean;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  readonly partPath: string;
}

/** One recognized eligible episode inside a re-listed season pack. */
interface RecognizedPackFile {
  readonly remoteFileId: string;
  readonly originalFilename: string;
  readonly bytes: number | null;
  readonly resolution: string | null;
  readonly episode: number;
  readonly episodeTitle: string | null;
}

const providerNames = ["real-debrid", "torbox"] as const satisfies readonly ProviderName[];
const excludedWantedStatuses = new Set(["cancelled", "imported"]);
const terminalStates = new Set(["imported", "cancelled"]);

function isCompletedItem(item: RemoteItem): boolean {
  return typeof item.completedAt === "string" && item.completedAt.trim().length > 0 && Number.isFinite(Date.parse(item.completedAt));
}

const providerFailureDetails: Record<ProviderErrorCode, string> = {
  AUTHENTICATION: "Provider authentication failed",
  RATE_LIMITED: "Provider rate limit reached",
  UNAVAILABLE: "Provider is temporarily unavailable",
  UNSUPPORTED_SCHEMA: "Provider response is unsupported",
  PERMANENT: "Provider item is no longer available",
};

const downloadFailureDetails: Record<DownloadErrorCode, string> = {
  CANCELLED: "Download cancelled",
  INSUFFICIENT_SPACE: "Insufficient disk space",
  CAPABILITY_EXPIRED: "Provider download capability expired",
  TEMPORARY_SERVICE_FAILURE: "Download service is temporarily unavailable",
  UNSAFE_DOWNLOAD: "Download was refused for safety",
  PERMANENT_REJECTION: "Provider rejected the download",
};

const defaultTimers: CoordinatorTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

const defaultScanLibrary = async (root: string) => ({
  items: (await new LocalFolderAdapter().scan(root)).items,
});

const defaultPartialBytes = async (partPath: string): Promise<number | null> => {
  try {
    const info = await stat(partPath);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const defaultHasFreeBytes = async (path: string, neededBytes: number): Promise<boolean> => {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize) >= neededBytes;
};

function isTerminal(state: string): boolean {
  return terminalStates.has(state);
}

/**
 * Fails closed unless the injected provider map is complete and every key
 * points at an implementation that advertises the same provider name, so a
 * token or locator can never be handed to the wrong provider.
 */
function assertProviderMap(
  providers: Record<ProviderName, AcquisitionProvider>,
): void {
  if (!providers || typeof providers !== "object") {
    throw new CoordinatorConfigurationError("Invalid provider map: providers must be an object");
  }
  const keys = Object.keys(providers).sort();
  const expected = [...providerNames].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CoordinatorConfigurationError(
      "Invalid provider map: providers must contain exactly real-debrid and torbox",
    );
  }
  for (const name of providerNames) {
    const implementation = providers[name] as AcquisitionProvider | undefined;
    if (!implementation || typeof implementation !== "object") {
      throw new CoordinatorConfigurationError(`Invalid provider map: missing provider "${name}"`);
    }
    if (implementation.provider !== name) {
      throw new CoordinatorConfigurationError(`Invalid provider map: provider "${name}" is mismatched`);
    }
    for (const method of ["testAuthentication", "listCompletedItems", "requestDownloadUrl"] as const) {
      if (typeof implementation[method] !== "function") {
        throw new CoordinatorConfigurationError(`Invalid provider map: provider "${name}" is invalid`);
      }
    }
  }
}

/**
 * Single-flight acquisition coordinator. It owns every durable acquisition
 * mutation: polling, job reservation, download/import progress, retry, cancel,
 * and manual season import all pass through one serialized mutation queue, so
 * a timer tick can never overwrite a manual command.
 *
 * Only short, synchronous SQLite writes are queued. Keychain reads, provider
 * requests, transfers, probes, and filesystem scans happen outside the queue
 * and outside every database transaction.
 */
export class AcquisitionCoordinator {
  private readonly repositories: Repositories;
  private readonly credentials: CredentialStore;
  private readonly providers: Record<ProviderName, AcquisitionProvider>;
  private readonly paths: ManagedPaths;
  private readonly download: DownloadExecutor;
  private readonly importEpisode: ImportExecutor;
  private readonly scanLibrary: (root: string) => Promise<{ items: MediaItem[] }>;
  private readonly probe: ((path: string) => Promise<ProbeResult>) | undefined;
  private readonly hasFreeBytes: (neededBytes: number) => Promise<boolean>;
  private readonly partialBytes: (partPath: string) => Promise<number | null>;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly timers: CoordinatorTimers;
  private readonly intervalMs: number;

  private queue: Promise<void> = Promise.resolve();
  private timer: CoordinatorTimer | null = null;
  private pollInFlight: Promise<PollOutcome> | null = null;
  private pollController: AbortController | null = null;
  private jobLoop: Promise<void> | null = null;
  private readonly transfers = new Map<string, ActiveOperation>();
  private stopping = false;
  private lifecycleEpoch = 0;

  constructor(dependencies: AcquisitionCoordinatorDependencies) {
    assertProviderMap(dependencies.providers);
    if (!dependencies.repositories || !dependencies.credentials || !dependencies.paths) {
      throw new CoordinatorConfigurationError("Coordinator requires repositories, credentials, and managed paths");
    }
    const intervalMs = dependencies.intervalMs ?? defaultPollIntervalMs;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new CoordinatorConfigurationError("Poll interval must be a positive number of milliseconds");
    }
    this.repositories = dependencies.repositories;
    this.credentials = dependencies.credentials;
    this.providers = dependencies.providers;
    this.paths = dependencies.paths;
    this.download = dependencies.download ?? ((job, provider, token, hooks, signal) =>
      downloadJob(job, provider, token, hooks, signal));
    this.importEpisode = dependencies.importEpisode ?? importVerifiedEpisode;
    this.scanLibrary = dependencies.scanLibrary ?? defaultScanLibrary;
    this.probe = dependencies.probe;
    this.hasFreeBytes = dependencies.hasFreeBytes ?? ((neededBytes) => defaultHasFreeBytes(this.paths.inbox, neededBytes));
    this.partialBytes = dependencies.partialBytes ?? defaultPartialBytes;
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? (() => randomUUID());
    this.timers = dependencies.timers ?? defaultTimers;
    this.intervalMs = intervalMs;
  }

  /** Deterministic crash recovery, then exactly one unreferenced poll timer. */
  async start(): Promise<void> {
    this.stopping = false;
    const epoch = ++this.lifecycleEpoch;
    await this.processJobs(epoch);
    if (!this.isActive(epoch)) return;
    this.clearTimer();
    const timer = this.timers.setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  /** Clears the timer, aborts local transfers, and preserves durable state and parts. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.lifecycleEpoch += 1;
    this.clearTimer();
    this.pollController?.abort();
    const transfers = [...this.transfers.values()];
    for (const transfer of transfers) {
      if (transfer.reason === null) transfer.reason = "shutdown";
      transfer.controller.abort();
    }
    await Promise.all(transfers.map((transfer) => transfer.settled));
    const loop = this.jobLoop;
    if (loop) await loop.catch(() => undefined);
    const poll = this.pollInFlight;
    this.pollInFlight = null;
    if (poll) void poll.catch(() => undefined);
    await this.queue;
  }

  /**
   * One poll cycle. Concurrent callers coalesce onto the in-flight cycle, so a
   * timer tick and a manual poll can never duplicate provider work.
   */
  pollOnce(): Promise<PollOutcome> {
    if (this.pollInFlight) return this.pollInFlight;
    if (this.stopping) return Promise.resolve(this.stoppedPoll([]));
    const epoch = this.lifecycleEpoch;
    const controller = new AbortController();
    this.pollController = controller;
    const execution = (async () => {
      const reads = await this.readProviderListings(controller.signal);
      if (!this.isActive(epoch)) return this.stoppedPoll(reads);
      const outcome = await this.enqueue(() => this.isActive(epoch) ? this.applyPoll(reads) : this.stoppedPoll(reads));
      if (!this.isActive(epoch)) return outcome;
      await this.processJobs(epoch);
      return outcome;
    })();
    const run = execution.finally(() => {
      if (this.pollInFlight === run) this.pollInFlight = null;
      if (this.pollController === controller) this.pollController = null;
    });
    this.pollInFlight = run;
    return run;
  }

  /** Resets a resumable job to its selection state and runs it deterministically. */
  async retry(jobId: string): Promise<RetryOutcome> {
    const outcome = await this.enqueue(() => this.beginRetry(jobId));
    if (outcome.kind === "queued") await this.processJobs();
    return outcome;
  }

  /**
   * Durably records `cancelRequested` before aborting a pre-publication
   * operation. Once publication commits, waits for atomic finalization instead.
   */
  async cancel(jobId: string): Promise<CancelOutcome> {
    const started = await this.enqueue(() => this.beginCancel(jobId));
    if (started.outcome.kind !== "cancelled" || !started.transfer) return started.outcome;
    if (!started.transfer.publicationCommitted) {
      started.transfer.reason = "user";
      started.transfer.controller.abort();
    }
    await started.transfer.settled;
    const job = await this.enqueue(() => this.repositories.acquisitions.jobs.get(jobId));
    if (job?.state === "imported") return { kind: "already-imported", job };
    return { kind: "cancelled", job: job ?? started.outcome.job };
  }

  /**
   * Manual Import Season: re-list the exact provider item, verify the stored
   * identity against safe locators, recheck counts/bytes/duplicates/space, then
   * create only the remaining episodes and consume the durable offer.
   */
  async importSeason(reviewId: string): Promise<SeasonImportOutcome> {
    const offer = await this.enqueue(() => this.repositories.acquisitions.reviews.get(reviewId));
    if (!offer) return { kind: "not-found" };
    if (offer.kind !== "season-pack") return { kind: "invalid-offer" };
    const seriesTitle = offer.packSeriesTitle;
    const season = offer.packSeason;
    const locators = offer.candidates;
    const provider = locators[0]?.provider ?? null;
    if (!seriesTitle || season === null) return { kind: "stale", provider, reason: "missing-identity" };
    if (!locators.length || !provider) return { kind: "stale", provider, reason: "empty-pack" };
    const { itemType, remoteItemId } = locators[0];
    if (locators.some((locator) => locator.provider !== provider || locator.itemType !== itemType || locator.remoteItemId !== remoteItemId)) {
      return { kind: "stale", provider, reason: "mixed-locators" };
    }
    let token: string | null;
    try {
      token = await this.credentials.get(provider);
    } catch {
      return { kind: "provider-error", provider, code: "UNAVAILABLE", retryable: true };
    }
    if (!token) return { kind: "no-credential", provider };
    let items: readonly RemoteItem[];
    try {
      items = await this.providers[provider].listCompletedItems(token);
    } catch (error) {
      if (error instanceof ProviderError) {
        return { kind: "provider-error", provider, code: error.code, retryable: error.retryable };
      }
      return { kind: "provider-error", provider, code: "UNAVAILABLE", retryable: true };
    }
    const item = items.find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.itemType === itemType &&
        candidate.remoteItemId === remoteItemId,
    );
    if (!item) return { kind: "stale", provider, reason: "item-missing" };
    if (typeof item.completedAt !== "string" || item.completedAt.trim().length === 0 || !Number.isFinite(Date.parse(item.completedAt))) {
      return { kind: "stale", provider, reason: "not-completed" };
    }
    const revalidated = this.revalidatePack(item, offer);
    if (revalidated.ok === false) {
      return { kind: "stale", provider, reason: revalidated.reason };
    }
    const outcome = await this.enqueue(() =>
      this.scheduleSeasonImport(offer, provider, itemType, remoteItemId, revalidated.files),
    );
    if (outcome.kind === "scheduled") this.startOwnedJobLoop();
    return outcome;
  }

  /**
   * Revalidates and reserves one consciously selected, single-episode review
   * candidate. Provider I/O is outside the durable queue; the final mutation
   * rechecks the review version before it creates a job and consumes the row.
   */
  async selectCandidate(
    reviewId: string,
    candidateIndex: number,
    reviewUpdatedAt: string,
  ): Promise<CandidateSelectionOutcome> {
    const review = await this.enqueue(() => this.repositories.acquisitions.reviews.get(reviewId));
    if (!review) return { kind: "not-found" };
    if (review.kind === "season-pack" || review.kind === "multi-episode") return { kind: "invalid-review" };
    if (review.updatedAt !== reviewUpdatedAt) return { kind: "stale-review" };
    const locator = review.candidates[candidateIndex];
    if (!locator || locator.season === null || locator.episode === null) return { kind: "invalid-candidate" };
    const wanted = await this.enqueue(() => this.repositories.acquisitions.wanted.get(review.wantedId));
    if (!wanted || locator.season !== wanted.season || locator.episode !== wanted.episode) {
      return { kind: "stale-candidate", provider: locator.provider };
    }
    let token: string | null;
    try {
      token = await this.credentials.get(locator.provider);
    } catch {
      return { kind: "provider-error", provider: locator.provider, code: "UNAVAILABLE", retryable: true };
    }
    if (!token) return { kind: "no-credential", provider: locator.provider };
    let items: readonly RemoteItem[];
    try {
      items = await this.providers[locator.provider].listCompletedItems(token);
    } catch (error) {
      if (error instanceof ProviderError) return { kind: "provider-error", provider: locator.provider, code: error.code, retryable: error.retryable };
      return { kind: "provider-error", provider: locator.provider, code: "UNAVAILABLE", retryable: true };
    }
    const item = items.find((candidate) =>
      candidate.provider === locator.provider &&
      candidate.itemType === locator.itemType &&
      candidate.remoteItemId === locator.remoteItemId,
    );
    if (!item || !isCompletedItem(item)) return { kind: "stale-candidate", provider: locator.provider };
    const currentFile = item.files.find((file) =>
      file.provider === locator.provider && file.itemType === locator.itemType &&
      file.remoteItemId === locator.remoteItemId && file.remoteFileId === locator.remoteFileId,
    );
    const parsed = currentFile ? parseVideoCandidate(currentFile) : null;
    if (
      !parsed || parsed.multiEpisode || parsed.provider !== locator.provider ||
      parsed.itemType !== locator.itemType || parsed.remoteItemId !== locator.remoteItemId ||
      parsed.remoteFileId !== locator.remoteFileId || parsed.originalFilename !== locator.filename ||
      parsed.bytes !== locator.sizeBytes || parsed.resolution !== locator.resolution ||
      parsed.season !== wanted.season || parsed.episode !== wanted.episode || parsed.episodeEnd !== null
    ) return { kind: "stale-candidate", provider: locator.provider };
    const outcome = await this.enqueue(() =>
      this.reserveSelectedCandidate(review, candidateIndex, reviewUpdatedAt, wanted, locator),
    );
    if (outcome.kind === "scheduled") this.startOwnedJobLoop();
    return outcome;
  }

  /**
   * Starts the coordinator-owned job loop without awaiting blocked transfers,
   * so a command that only scheduled work can return its durable result while
   * the download continues in the background. The loop is still registered as
   * `jobLoop`, so `stop()` keeps ownership and waits for it, and the detached
   * rejection is contained here rather than becoming an unhandled rejection.
   */
  private startOwnedJobLoop(): void {
    void this.processJobs().catch(() => undefined);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  private isActive(epoch: number): boolean {
    return !this.stopping && this.lifecycleEpoch === epoch;
  }

  private stoppedPoll(reads: readonly ProviderRead[]): PollOutcome {
    return {
      providers: reads.map((read) => ({
        provider: read.provider,
        state: read.state,
        itemCount: read.items.length,
        errorCode: read.state === "error" && read.error instanceof ProviderError ? read.error.code : null,
      })),
      reservedJobIds: [],
      matchedWantedIds: [],
      reviewId: null,
      seasonPackReviewId: null,
    };
  }

  /**
   * Serializes every durable mutation behind one promise chain. The chained
   * value never rejects, so one failed command cannot poison the queue.
   */
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(() => operation());
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private async readProviderListings(signal?: AbortSignal): Promise<readonly ProviderRead[]> {
    return Promise.all(
      providerNames.map(async (provider): Promise<ProviderRead> => {
        try {
          const token = await this.credentials.get(provider);
          if (!token) return { provider, state: "missing-credential", items: [] };
          const items = await this.providers[provider].listCompletedItems(token, signal);
          return { provider, state: "ok", items };
        } catch (error) {
          return { provider, state: "error", error, items: [] };
        }
      }),
    );
  }

  /**
   * Applies one aggregated provider read inside a single queued mutation:
   * re-read durable Wanted/import/job state, match completed items, persist any
   * review, then reserve jobs for selections that are still Wanted.
   */
  private applyPoll(reads: readonly ProviderRead[]): PollOutcome {
    const repository = this.repositories.acquisitions;
    const ledger = repository.imports.list();
    const completedEpisodes = new Set(ledger.map((record) => record.episodeKey));
    const activeWanted = new Set(
      repository.jobs
        .list()
        .filter((job) => !isTerminal(job.state))
        .map((job) => job.wantedId),
    );
    const eligible = repository.wanted
      .list()
      .filter(
        (wanted) =>
          !excludedWantedStatuses.has(wanted.status) &&
          !activeWanted.has(wanted.id) &&
          !completedEpisodes.has(episodeKey(wanted.seriesTitle, wanted.season, wanted.episode)),
      );
    const plan = matchCompletedFiles(
      eligible,
      reads.flatMap((read) => read.items),
      ledger,
    );
    const reservedJobIds: string[] = [];
    const matchedWantedIds: string[] = [];
    let reviewId: string | null = null;
    let seasonPackReviewId: string | null = null;
    const handled = new Set<string>();
    let selections: readonly MatchSelection[] = [];
    if (plan.kind === "review") {
      const review = this.buildReview(plan);
      if (repository.wanted.get(plan.wantedId)) {
        repository.transaction(() => repository.reviews.save(review));
        repository.wanted.setStatus(plan.wantedId, "needs-review", {
          detail: review.message,
          now: this.isoNow(),
        });
        reviewId = review.id;
      }
      handled.add(plan.wantedId);
    } else if (plan.kind === "season-pack") {
      // The durable offer is written first: reservation of the currently
      // Wanted episodes can then fail or crash without losing the pack offer.
      const offer = this.buildSeasonPackOffer(plan);
      repository.transaction(() => repository.reviews.save(offer));
      seasonPackReviewId = offer.id;
      selections = plan.wantedSelections;
    } else if (plan.kind === "season-packs") {
      // A multi-season collection is deliberately never auto-selected. Each
      // durable offer retains only the requested season, allowing the UI to
      // present the competing collections and require an explicit Import
      // Season action for the chosen one.
      const offers = plan.offers.map((offer) =>
        this.buildSeasonPackOfferFromPreview(offer.wantedId, offer.packPreview),
      );
      repository.transaction(() => {
        for (const wantedId of plan.coveredWantedIds) {
          // Replace a prior single-episode ambiguity with the safer collection
          // choice. A completed multi-season collection is only actionable by
          // an explicit Import Season click, never an automatic reservation.
          for (const review of repository.reviews.listByWanted(wantedId)) {
            if (review.kind !== "season-pack") repository.reviews.remove(review.id);
          }
          repository.wanted.setStatus(wantedId, "waiting-provider", {
            detail: null,
            now: this.isoNow(),
          });
        }
        for (const offer of offers) repository.reviews.save(offer);
      });
      seasonPackReviewId = offers[0]?.id ?? null;
      if (plan.review) {
        const nextReview = this.buildReview(plan.review);
        if (repository.wanted.get(plan.review.wantedId)) {
          repository.transaction(() => repository.reviews.save(nextReview));
          repository.wanted.setStatus(plan.review.wantedId, "needs-review", {
            detail: nextReview.message,
            now: this.isoNow(),
          });
          reviewId = nextReview.id;
          handled.add(plan.review.wantedId);
        }
      } else {
        selections = plan.selections;
      }
    } else if (plan.kind === "automatic") {
      selections = plan.selections;
    }
    for (const reserved of this.reserveSelections(selections)) {
      handled.add(reserved.wantedId);
      matchedWantedIds.push(reserved.wantedId);
      reservedJobIds.push(reserved.jobId);
    }
    // Any eligible Wanted episode without a match waits for a provider match;
    // it is never silently dropped and never re-enters review.
    for (const wanted of eligible) {
      if (handled.has(wanted.id) || wanted.status !== "wanted") continue;
      repository.wanted.setStatus(wanted.id, "waiting-provider", { detail: null, now: this.isoNow() });
    }
    return {
      providers: reads.map((read) => ({
        provider: read.provider,
        state: read.state,
        itemCount: read.items.length,
        errorCode: read.state === "error" && read.error instanceof ProviderError ? read.error.code : null,
      })),
      reservedJobIds,
      matchedWantedIds,
      reviewId,
      seasonPackReviewId,
    };
  }

  private buildReview(plan: Extract<MatchPlan, { kind: "review" }>): AcquisitionReview {
    const id = `review:${plan.reason}:${plan.wantedId}`;
    const existing = this.repositories.acquisitions.reviews.get(id);
    const timestamp = this.isoNow();
    const next: AcquisitionReview = {
      id,
      wantedId: plan.wantedId,
      kind: plan.reason,
      message: reviewMessageFor(plan.reason),
      candidates: plan.candidates.map((candidate) => ({
        provider: candidate.provider,
        itemType: candidate.itemType,
        remoteItemId: candidate.remoteItemId,
        remoteFileId: candidate.remoteFileId,
        filename: candidate.filename,
        sizeBytes: candidate.sizeBytes,
        resolution: candidate.resolution,
        season: candidate.season,
        episode: candidate.episode,
      })),
      packEpisodeCount: null,
      packTotalBytes: null,
      packSeriesTitle: null,
      packSeason: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    // Re-polling an unchanged ambiguity must not invalidate a deliberate UI
    // selection. The review version advances only when a provider-visible,
    // selection-relevant fact actually changes.
    return existing && sameEpisodeReview(existing, next) ? existing : next;
  }

  private buildSeasonPackOffer(plan: Extract<MatchPlan, { kind: "season-pack" }>): AcquisitionReview {
    return this.buildSeasonPackOfferFromPreview(plan.wantedSelections[0]!.wantedId, plan.packPreview);
  }

  private buildSeasonPackOfferFromPreview(
    wantedId: string,
    preview: Extract<MatchPlan, { kind: "season-pack" }>['packPreview'],
  ): AcquisitionReview {
    const id = seasonPackReviewId(
      preview.provider,
      preview.itemType,
      preview.remoteItemId,
      preview.seriesTitle,
      preview.season,
    );
    const existing = this.repositories.acquisitions.reviews.get(id);
    const timestamp = this.isoNow();
    return {
      id,
      // The anchor is only the episode that surfaced the pack; the offer
      // survives that episode being imported or removed.
      wantedId,
      kind: "season-pack",
      message: `Season pack with ${preview.recognizedEpisodeCount} recognized episodes`,
      candidates: preview.fileLocators.map((locator) => ({
        provider: locator.provider,
        itemType: locator.itemType,
        remoteItemId: locator.remoteItemId,
        remoteFileId: locator.remoteFileId,
        filename: locator.filename,
        sizeBytes: locator.sizeBytes,
        resolution: locator.resolution,
        season: locator.season,
        episode: locator.episode,
      })),
      packEpisodeCount: preview.recognizedEpisodeCount,
      packTotalBytes: preview.totalBytes,
      packSeriesTitle: preview.seriesTitle,
      packSeason: preview.season,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Atomically reserves one `match-found` job per selection that is still a
   * Wanted episode with no nonterminal job, no remote-identity owner, and no
   * completion ledger entry. Ledger rows always win over new reservations.
   */
  private reserveSelections(
    selections: readonly MatchSelection[],
  ): readonly { readonly wantedId: string; readonly jobId: string }[] {
    const repository = this.repositories.acquisitions;
    const ordered = [...selections].sort(
      (left, right) =>
        left.episodeKey.localeCompare(right.episodeKey) ||
        left.provider.localeCompare(right.provider) ||
        left.remoteItemId.localeCompare(right.remoteItemId) ||
        left.remoteFileId.localeCompare(right.remoteFileId),
    );
    return this.repositories.transaction(() => {
      const reserved: Array<{ wantedId: string; jobId: string }> = [];
      for (const selection of ordered) {
        const wanted = repository.wanted.get(selection.wantedId);
        if (!wanted) continue;
        if (wanted.status !== "wanted" && wanted.status !== "waiting-provider") continue;
        if (repository.jobs.listByWanted(wanted.id).some((job) => !isTerminal(job.state))) continue;
        if (repository.imports.findByEpisode(wanted.seriesTitle, wanted.season, wanted.episode)) continue;
        if (repository.jobs.findRemote(selection.provider, selection.remoteItemId, selection.remoteFileId)) continue;
        if (repository.imports.findByRemote(selection.provider, selection.remoteItemId, selection.remoteFileId)) continue;
        const timestamp = this.isoNow();
        const job: AcquisitionJob = {
          id: this.randomId(),
          wantedId: wanted.id,
          episodeKey: episodeKey(wanted.seriesTitle, wanted.season, wanted.episode),
          provider: selection.provider,
          remoteItemId: selection.remoteItemId,
          remoteFileId: selection.remoteFileId,
          originalFilename: selection.originalFilename,
          expectedBytes: selection.bytes,
          receivedBytes: 0,
          state: "match-found",
          attempt: 0,
          maxAttempts: defaultMaxAttempts,
          retryAfterMs: null,
          cancelRequested: false,
          partPath: null,
          destinationPath: null,
          verifiedSha256: null,
          lastError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        repository.jobs.save(job);
        repository.wanted.setStatus(wanted.id, "match-found", { detail: null, now: timestamp });
        reserved.push({ wantedId: wanted.id, jobId: job.id });
      }
      return reserved;
    });
  }

  private reserveSelectedCandidate(
    expectedReview: AcquisitionReview,
    candidateIndex: number,
    reviewUpdatedAt: string,
    expectedWanted: WantedEpisode,
    locator: AcquisitionReviewCandidate,
  ): CandidateSelectionOutcome {
    const repository = this.repositories.acquisitions;
    return this.repositories.transaction(() => {
      const review = repository.reviews.get(expectedReview.id);
      if (!review) return { kind: "not-found" };
      if (review.kind === "season-pack" || review.kind === "multi-episode") return { kind: "invalid-review" };
      if (review.updatedAt !== reviewUpdatedAt) return { kind: "stale-review" };
      const currentLocator = review.candidates[candidateIndex];
      if (!currentLocator || !sameReviewCandidate(currentLocator, locator)) return { kind: "stale-review" };
      const wanted = repository.wanted.get(expectedWanted.id);
      if (
        !wanted || wanted.status !== "needs-review" ||
        wanted.seriesTitle !== expectedWanted.seriesTitle ||
        wanted.season !== locator.season || wanted.episode !== locator.episode
      ) return { kind: "conflict" };
      if (repository.jobs.listByWanted(wanted.id).some((job) => !isTerminal(job.state))) return { kind: "conflict" };
      if (repository.imports.findByEpisode(wanted.seriesTitle, wanted.season, wanted.episode)) return { kind: "conflict" };
      if (repository.jobs.findRemote(locator.provider, locator.remoteItemId, locator.remoteFileId)) return { kind: "conflict" };
      if (repository.imports.findByRemote(locator.provider, locator.remoteItemId, locator.remoteFileId)) return { kind: "conflict" };
      const timestamp = this.isoNow();
      const job: AcquisitionJob = {
        id: this.randomId(), wantedId: wanted.id,
        episodeKey: episodeKey(wanted.seriesTitle, wanted.season, wanted.episode),
        provider: locator.provider, remoteItemId: locator.remoteItemId, remoteFileId: locator.remoteFileId,
        originalFilename: locator.filename, expectedBytes: locator.sizeBytes, receivedBytes: 0,
        state: "match-found", attempt: 0, maxAttempts: defaultMaxAttempts, retryAfterMs: null,
        cancelRequested: false, partPath: null, destinationPath: null, verifiedSha256: null,
        lastError: null, createdAt: timestamp, updatedAt: timestamp,
      };
      repository.jobs.save(job);
      repository.wanted.setStatus(wanted.id, "match-found", { detail: null, now: timestamp });
      repository.reviews.remove(review.id);
      return { kind: "scheduled", job };
    });
  }

  /**
   * Deterministic sequential job execution. A loop already in flight is
   * awaited and then re-run so work scheduled by a concurrent command is never
   * dropped, while two job loops never run at once.
   */
  private async processJobs(epoch = this.lifecycleEpoch): Promise<void> {
    if (!this.isActive(epoch)) return;
    if (this.jobLoop) {
      await this.jobLoop;
      if (!this.isActive(epoch)) return;
      return this.processJobs(epoch);
    }
    const loop = this.runJobLoop(epoch);
    this.jobLoop = loop;
    try {
      await loop;
    } finally {
      if (this.jobLoop === loop) this.jobLoop = null;
    }
  }

  private async runJobLoop(epoch: number): Promise<void> {
    const visited = new Set<string>();
    for (;;) {
      if (!this.isActive(epoch)) return;
      const job = this.selectRunnableJob(visited);
      if (!job) return;
      visited.add(job.id);
      await this.processJob(job, epoch);
    }
  }

  private selectRunnableJob(visited: ReadonlySet<string>): AcquisitionJob | undefined {
    const nowMs = this.now().getTime();
    return this.repositories.acquisitions.jobs
      .list()
      .filter((job) => !visited.has(job.id) && isRunnable(job, nowMs))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )[0];
  }

  private async processJob(initial: AcquisitionJob, epoch: number): Promise<void> {
    if (!this.isActive(epoch)) return;
    const job = await this.enqueue(() => this.isActive(epoch) ? this.repositories.acquisitions.jobs.get(initial.id) : undefined);
    if (!job) return;
    switch (job.state) {
      case "match-found":
      case "waiting-provider":
      case "downloading":
      case "retry-wait":
        return this.attemptDownload(job, epoch);
      case "verifying":
      case "placing":
        return this.attemptImport(job, epoch);
      default:
        // cancelled / needs-review / imported never auto-resume.
        return;
    }
  }

  private exactPartPath(job: AcquisitionJob): string | null {
    try {
      return containedPath(this.paths.inbox, `${job.id}.part`);
    } catch {
      return null;
    }
  }

  private async attemptDownload(job: AcquisitionJob, epoch: number): Promise<void> {
    if (!this.isActive(epoch)) return;
    const partPath = this.managedPartPath(job);
    if (!partPath) {
      await this.enqueue(() => this.persistNeedsReview(job.id, "Managed partial path is not this job's part"));
      return;
    }
    if (job.partPath !== null && job.partPath !== partPath) {
      await this.enqueue(() => this.persistNeedsReview(job.id, "Managed partial path is not this job's part"));
      return;
    }
    // A partial that already holds every expected byte resumes at
    // verification instead of re-requesting a range the provider would reject.
    if (await this.isPartialComplete(job, partPath)) {
      if (!this.isActive(epoch)) return;
      await this.enqueue(() => { if (this.isActive(epoch)) this.markVerifying(job.id, partPath); });
      const verifying = await this.freshJob(job.id);
      if (verifying && this.isActive(epoch)) await this.attemptImport(verifying, epoch);
      return;
    }
    let token: string | null;
    try {
      token = await this.credentials.get(job.provider);
    } catch {
      if (!this.isActive(epoch)) return;
      await this.enqueue(() => this.persistRetryWait(job.id, backoffDelay(job.attempt)));
      return;
    }
    if (!token) {
      if (!this.isActive(epoch)) return;
      await this.enqueue(() => this.persistWaitingProvider(job.id));
      return;
    }
    if (!this.isActive(epoch)) return;
    const transfer = await this.enqueue(() => this.isActive(epoch) ? this.beginDownload(job.id, partPath) : null);
    if (!transfer) return;
    const controller = transfer.controller;
    const hooks: DownloadHooks = {
      inbox: this.paths.inbox,
      inboxIdentity: this.paths.inboxIdentity,
      hasFreeBytes: (neededBytes) => this.hasFreeBytes(neededBytes),
      onProgress: (receivedBytes, expectedBytes) =>
        this.enqueue(() => { if (this.isActive(epoch)) this.persistProgress(job.id, receivedBytes, expectedBytes); }),
    };
    try {
      const downloaded = await this.download(
        {
          id: job.id,
          provider: job.provider,
          itemType: jobItemType,
          remoteItemId: job.remoteItemId,
          remoteFileId: job.remoteFileId,
          receivedBytes: job.receivedBytes,
          expectedBytes: job.expectedBytes,
        },
        this.providers[job.provider],
        token,
        hooks,
        controller.signal,
      );
      await this.enqueue(() => { if (this.isActive(epoch)) this.markVerifying(job.id, downloaded); });
    } catch (error) {
      await this.enqueue(() =>
        this.handleDownloadFailure(job.id, error, transfer.reason, controller.signal.aborted),
      );
      return;
    } finally {
      const current = this.transfers.get(job.id);
      if (current && current.controller === controller) {
        this.transfers.delete(job.id);
        current.settle();
      }
    }
    const verifying = await this.freshJob(job.id);
    if (verifying && verifying.state === "verifying" && this.isActive(epoch)) await this.attemptImport(verifying, epoch);
  }

  private async freshJob(jobId: string): Promise<AcquisitionJob | undefined> {
    return this.enqueue(() => this.repositories.acquisitions.jobs.get(jobId));
  }

  private managedPartPath(job: AcquisitionJob): string | null {
    const expected = this.exactPartPath(job);
    if (!expected) return null;
    if (job.partPath !== null && job.partPath !== expected) return null;
    return expected;
  }

  private async isPartialComplete(job: AcquisitionJob, partPath: string): Promise<boolean> {
    if (job.expectedBytes === null || job.expectedBytes <= 0) return false;
    const bytes = await this.partialBytes(partPath);
    return bytes !== null && bytes > 0 && bytes >= job.expectedBytes;
  }

  /**
   * Queued mutation: re-reads the job and registers the abort handle before the
   * transfer starts, so a cancel that arrives later always finds it.
   */
  private beginDownload(jobId: string, partPath: string): ActiveOperation | null {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job) return null;
    if (job.cancelRequested || job.state === "cancelled" || job.state === "imported" || job.state === "needs-review") {
      return null;
    }
    if (job.attempt >= job.maxAttempts) {
      this.persistNeedsReview(jobId, "Retry limit reached");
      return null;
    }
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({
        ...job,
        state: "downloading",
        attempt: job.attempt + 1,
        partPath,
        retryAfterMs: null,
        lastError: null,
        updatedAt: timestamp,
      });
      if (repository.wanted.get(job.wantedId)) {
        repository.wanted.setStatus(job.wantedId, "downloading", { detail: null, now: timestamp });
      }
    });
    const transfer = this.createActiveOperation(partPath);
    this.transfers.set(jobId, transfer);
    return transfer;
  }

  private createActiveOperation(partPath: string): ActiveOperation {
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { controller, reason: null, publicationCommitted: false, settled, settle, partPath };
  }

  /** Queued mutation: persists received bytes without ever touching a terminal job. */
  private persistProgress(jobId: string, receivedBytes: number, expectedBytes: number | null): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || isTerminal(job.state) || job.cancelRequested) return;
    if (job.receivedBytes === receivedBytes && (expectedBytes === null || job.expectedBytes === expectedBytes)) return;
    repository.jobs.save({
      ...job,
      receivedBytes: Math.max(job.receivedBytes, receivedBytes),
      expectedBytes: expectedBytes ?? job.expectedBytes,
      updatedAt: this.isoNow(),
    });
  }

  private markVerifying(jobId: string, downloadedPath: string): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || isTerminal(job.state) || job.cancelRequested) return;
    const expected = this.exactPartPath(job);
    if (!expected || downloadedPath !== expected) {
      this.persistNeedsReview(jobId, "Downloaded partial path is not this job's part");
      return;
    }
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({ ...job, state: "verifying", partPath: expected, retryAfterMs: null, lastError: null, updatedAt: timestamp });
      if (repository.wanted.get(job.wantedId)) {
        repository.wanted.setStatus(job.wantedId, "verifying", { detail: null, now: timestamp });
      }
    });
  }

  private handleDownloadFailure(
    jobId: string,
    error: unknown,
    reason: TransferReason,
    aborted: boolean,
  ): void {
    const job = this.repositories.acquisitions.jobs.get(jobId);
    if (!job || isTerminal(job.state)) return;
    const userCancelled = reason === "user" || job.cancelRequested;
    if (userCancelled) {
      this.persistCancelled(jobId);
      return;
    }
    if (reason === "shutdown" || (aborted && this.stopping)) {
      // Shutdown preserves durable state and the partial so a restart resumes.
      this.persistInterrupted(jobId);
      return;
    }
    if (aborted && error instanceof DownloadError && error.code === "CANCELLED") {
      this.persistInterrupted(jobId);
      return;
    }
    if (error instanceof ProviderError) {
      if (!error.retryable) {
        this.persistNeedsReview(jobId, providerFailureDetails[error.code]);
        return;
      }
      this.retryOrFail(job, error.retryAfterMs ?? null);
      return;
    }
    if (error instanceof DownloadError) {
      if (error.code === "CANCELLED") {
        this.persistCancelled(jobId);
        return;
      }
      if (error.code === "INSUFFICIENT_SPACE" || error.code === "UNSAFE_DOWNLOAD" || error.code === "PERMANENT_REJECTION") {
        this.persistNeedsReview(jobId, downloadFailureDetails[error.code]);
        return;
      }
      if (error.code === "CAPABILITY_EXPIRED" || error.code === "TEMPORARY_SERVICE_FAILURE") {
        this.retryOrFail(job, error.retryAfterMs ?? null);
        return;
      }
      if (!error.retryable) {
        this.persistNeedsReview(jobId, downloadFailureDetails[error.code]);
        return;
      }
      this.retryOrFail(job, error.retryAfterMs ?? null);
      return;
    }
    if (error instanceof ManagedPathError || error instanceof AcquisitionConflictError) {
      this.persistNeedsReview(
        jobId,
        error instanceof AcquisitionConflictError
          ? "Episode or provider item is already imported"
          : "Managed library path is no longer safe",
      );
      return;
    }
    this.persistNeedsReview(jobId, "Download failed safely");
  }

  private retryOrFail(job: AcquisitionJob, retryAfterMs: number | null): void {
    if (job.attempt >= job.maxAttempts) {
      this.persistNeedsReview(job.id, "Retry limit reached");
      return;
    }
    this.persistRetryWait(job.id, retryAfterMs ?? backoffDelay(job.attempt));
  }

  private async attemptImport(job: AcquisitionJob, epoch: number): Promise<void> {
    if (!this.isActive(epoch)) return;
    const partPath = this.managedPartPath(job);
    if (!partPath) {
      await this.enqueue(() => this.persistNeedsReview(job.id, "Managed partial path is not this job's part"));
      return;
    }
    const ownership = await this.enqueue(() => {
      if (!this.isActive(epoch) || this.transfers.has(job.id)) return null;
      const current = this.repositories.acquisitions.jobs.get(job.id);
      if (!current || current.cancelRequested || current.state === "cancelled" || current.state === "imported") return null;
      const wanted = this.repositories.acquisitions.wanted.get(current.wantedId);
      if (!wanted) {
        this.persistNeedsReview(current.id, "Wanted episode is no longer available");
        return null;
      }
      // The completion ledger always wins before any filesystem work.
      if (this.ledgerFor(current)) {
        this.reconcileImportedJob(current.id);
        return null;
      }
      const operation = this.createActiveOperation(partPath);
      this.transfers.set(current.id, operation);
      return { job: current, wanted, operation };
    });
    if (!ownership) return;
    const activeJob = ownership.job;
    const wanted = ownership.wanted;
    const operation = ownership.operation;
    const controller = operation.controller;
    const context: VerifiedImportContext = {
      library: this.paths.library,
      inbox: this.paths.inbox,
      inboxIdentity: this.paths.inboxIdentity,
      libraryIdentity: this.paths.libraryIdentity,
      now: this.now,
      completedImportFor: (candidate) => this.ledgerFor(candidate),
      persistPlacing: (placing) => this.enqueue(() => {
        controller.signal.throwIfAborted();
        if (!this.isActive(epoch)) throw controller.signal.reason;
        this.persistPlacing(placing);
      }),
      needsReview: (candidate, message) => this.enqueue(() => {
        if (!operation.publicationCommitted) controller.signal.throwIfAborted();
        if (this.isActive(epoch)) this.persistNeedsReview(candidate.id, message);
      }),
      publicationCommitted: () => {
        operation.publicationCommitted = true;
        return this.enqueue(() => {
          const current = this.repositories.acquisitions.jobs.get(activeJob.id);
          if (current && current.state !== "imported" && current.cancelRequested) {
            this.repositories.acquisitions.jobs.save({ ...current, cancelRequested: false, updatedAt: this.isoNow() });
          }
        });
      },
      signal: controller.signal,
      ...(this.probe ? { probe: this.probe } : {}),
      scan: this.scanLibrary,
      finalize: (media, completedImport, importedJob) => this.enqueue(() => {
        const current = this.repositories.acquisitions.jobs.get(activeJob.id);
        if (!operation.publicationCommitted) controller.signal.throwIfAborted();
        if (!current || (!operation.publicationCommitted && (current.cancelRequested || current.state === "cancelled"))) {
          throw new ImportVerificationError("Acquisition was cancelled before finalization");
        }
        this.repositories.completeAcquisitionImport({ media, completedImport, importedJob });
      }),
    };
    try {
      await this.importEpisode(activeJob, wanted, partPath, context);
      const after = await this.freshJob(activeJob.id);
      if (after && after.state !== "imported" && this.ledgerFor(activeJob)) {
        await this.enqueue(() => this.reconcileImportedJob(activeJob.id));
      }
    } catch (error) {
      const current = await this.freshJob(activeJob.id);
      // A cancellation or a completed ledger can never be overwritten.
      if (!current || current.state === "imported") return;
      if (operation.publicationCommitted) {
        // Publication is the filesystem commit point. If a later scan or
        // finalization fails, preserve the durable placing record so startup
        // or retry can reconcile the already-published final without another
        // download. In particular, a racing cancel must not turn it cancelled.
        if (this.ledgerFor(activeJob)) {
          await this.enqueue(() => this.reconcileImportedJob(activeJob.id));
        }
        return;
      }
      if (operation.reason === "user" || current.cancelRequested) {
        await this.enqueue(() => this.persistCancelled(activeJob.id));
        return;
      }
      if (operation.reason === "shutdown" || (controller.signal.aborted && this.stopping)) return;
      if (current.state === "cancelled") return;
      if (error instanceof ImportNeedsReviewError) return;
      if (error instanceof AcquisitionConflictError) {
        await this.enqueue(() => this.persistNeedsReview(activeJob.id, "Episode or provider item is already imported"));
        return;
      }
      if (error instanceof ManagedPathError) {
        await this.enqueue(() => this.persistNeedsReview(activeJob.id, "Managed library path is no longer safe"));
        return;
      }
      if (error instanceof ImportVerificationError) {
        const partialBytes = await this.partialBytes(partPath);
        if (partialBytes === null && current.attempt < current.maxAttempts) {
          // A missing pre-publication partial is recoverable by re-downloading.
          await this.enqueue(() => this.persistRetryWait(activeJob.id, backoffDelay(current.attempt)));
          return;
        }
        await this.enqueue(() =>
          this.persistNeedsReview(activeJob.id, partialBytes === null && current.attempt >= current.maxAttempts
            ? "Retry limit reached"
            : "Media verification failed"),
        );
        return;
      }
      await this.enqueue(() => this.persistNeedsReview(activeJob.id, "Import failed safely"));
    } finally {
      const current = this.transfers.get(activeJob.id);
      if (current && current.controller === controller) {
        this.transfers.delete(activeJob.id);
        current.settle();
      }
    }
  }

  private ledgerFor(job: AcquisitionJob): CompletedImport | undefined {
    const repository = this.repositories.acquisitions;
    const wanted = repository.wanted.get(job.wantedId);
    const byEpisode =
      wanted === undefined
        ? repository.imports
            .list()
            .find((record) => record.episodeKey === job.episodeKey)
        : repository.imports.findByEpisode(wanted.seriesTitle, wanted.season, wanted.episode);
    const byRemote = repository.imports.findByRemote(job.provider, job.remoteItemId, job.remoteFileId);
    return [byEpisode, byRemote].find((record) =>
      record !== undefined &&
      record.wantedId === job.wantedId &&
      record.episodeKey === job.episodeKey &&
      record.provider === job.provider &&
      record.remoteItemId === job.remoteItemId &&
      record.remoteFileId === job.remoteFileId,
    );
  }

  private persistPlacing(placing: AcquisitionJob): void {
    const repository = this.repositories.acquisitions;
    const current = repository.jobs.get(placing.id);
    if (!current) throw new ImportVerificationError("Acquisition job no longer exists");
    if (current.cancelRequested || current.state === "cancelled" || current.state === "imported") {
      // Abort before publication: cancellation must win over placement.
      throw new ImportVerificationError("Acquisition was cancelled before publication");
    }
    this.repositories.transaction(() => {
      repository.jobs.save(placing);
      if (repository.wanted.get(placing.wantedId)) {
        repository.wanted.setStatus(placing.wantedId, "placing", { detail: null, now: placing.updatedAt });
      }
    });
  }

  private persistNeedsReview(jobId: string, message: string): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || job.cancelRequested || job.state === "cancelled" || job.state === "imported") return;
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({ ...job, state: "needs-review", lastError: message, retryAfterMs: null, updatedAt: timestamp });
      if (repository.wanted.get(job.wantedId)) {
        repository.wanted.setStatus(job.wantedId, "needs-review", { detail: message, now: timestamp });
      }
    });
  }

  private persistWaitingProvider(jobId: string): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || job.cancelRequested || isTerminal(job.state)) return;
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({ ...job, state: "waiting-provider", retryAfterMs: null, updatedAt: timestamp });
      if (repository.wanted.get(job.wantedId)) {
        repository.wanted.setStatus(job.wantedId, "waiting-provider", { detail: null, now: timestamp });
      }
    });
  }

  private persistRetryWait(jobId: string, delayMs: number): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || job.cancelRequested || isTerminal(job.state)) return;
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({ ...job, state: "retry-wait", retryAfterMs: delayMs, lastError: null, updatedAt: timestamp });
      if (repository.wanted.get(job.wantedId)) {
        repository.wanted.setStatus(job.wantedId, "retry-wait", { detail: null, now: timestamp });
      }
    });
  }

  /** Shutdown preserves the partial and the resumable downloading state. */
  private persistInterrupted(jobId: string): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || isTerminal(job.state)) return;
    repository.jobs.save({ ...job, state: "downloading", retryAfterMs: null, updatedAt: this.isoNow() });
  }

  private persistCancelled(jobId: string): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || job.state === "imported") return;
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({ ...job, state: "cancelled", cancelRequested: true, retryAfterMs: null, updatedAt: timestamp });
      if (repository.wanted.get(job.wantedId)) {
        repository.wanted.setStatus(job.wantedId, "cancelled", { detail: null, now: timestamp });
      }
    });
  }

  /**
   * Ledger-wins replay: the job ends `imported` and its Wanted episode is
   * marked imported without a second import. The row is kept (not deleted) so a
   * durable season-pack offer anchored to it is never consumed here.
   */
  private reconcileImportedJob(jobId: string): void {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job || job.state === "imported") return;
    const timestamp = this.isoNow();
    this.repositories.transaction(() => {
      repository.jobs.save({ ...job, state: "imported", cancelRequested: false, lastError: null, retryAfterMs: null, updatedAt: timestamp });
      const wanted = repository.wanted.get(job.wantedId);
      if (wanted && wanted.status !== "imported") {
        repository.wanted.setStatus(job.wantedId, "imported", { detail: null, now: timestamp });
      }
    });
  }

  private beginRetry(jobId: string): RetryOutcome {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job) return { kind: "not-found" };
    if (job.state === "imported") return { kind: "already-imported", job };
    if (this.transfers.has(jobId)) return { kind: "active", job };
    if (this.ledgerFor(job)) {
      this.reconcileImportedJob(job.id);
      return { kind: "already-imported", job: repository.jobs.get(job.id)! };
    }
    if (!repository.wanted.get(job.wantedId)) {
      return { kind: "unavailable", reason: "missing-wanted", job };
    }
    const timestamp = this.isoNow();
    const next = repository.jobs.save({
      ...job,
      state: "match-found",
      attempt: 0,
      cancelRequested: false,
      retryAfterMs: null,
      lastError: null,
      updatedAt: timestamp,
    });
    if (repository.wanted.get(job.wantedId)) {
      repository.wanted.setStatus(job.wantedId, "match-found", { detail: null, now: timestamp });
    }
    return { kind: "queued", job: next };
  }

  private beginCancel(jobId: string): { outcome: CancelOutcome; transfer: ActiveOperation | null } {
    const repository = this.repositories.acquisitions;
    const job = repository.jobs.get(jobId);
    if (!job) return { outcome: { kind: "not-found" }, transfer: null };
    if (job.state === "imported") return { outcome: { kind: "already-imported", job }, transfer: null };
    const transfer = this.transfers.get(jobId) ?? null;
    if (!transfer && job.state === "cancelled") {
      return { outcome: { kind: "already-cancelled", job }, transfer: null };
    }
    if (transfer) {
      // Publication is already durable and must finish finalization; before
      // publication the durable flag is written before the abort.
      if (transfer.publicationCommitted) {
        return { outcome: { kind: "cancelled", job }, transfer };
      }
      transfer.reason = "user";
      const flagged = repository.jobs.save({ ...job, cancelRequested: true, updatedAt: this.isoNow() });
      return { outcome: { kind: "cancelled", job: flagged }, transfer };
    }
    this.persistCancelled(jobId);
    const cancelled = repository.jobs.get(jobId) ?? job;
    return { outcome: { kind: "cancelled", job: cancelled }, transfer: null };
  }

  /**
   * Re-lists one provider item and verifies every stored locator against the
   * fresh listing, then recomputes recognized episodes and whole-pack bytes.
   */
  private revalidatePack(
    item: RemoteItem,
    offer: AcquisitionReview,
  ):
    | { readonly ok: true; readonly files: readonly RecognizedPackFile[] }
    | { readonly ok: false; readonly reason: StaleSeasonPackReason } {
    const seriesTitle = offer.packSeriesTitle;
    const season = offer.packSeason;
    if (!seriesTitle || season === null) return { ok: false, reason: "missing-identity" };
    const locators = offer.candidates;
    const target = normalizedSeriesTitle(seriesTitle);
    const recognized: RecognizedPackFile[] = [];
    for (const file of item.files) {
      const parsed = parseVideoCandidate(file);
      if (!parsed || parsed.multiEpisode || parsed.seriesTitle === null) continue;
      if (normalizedSeriesTitle(parsed.seriesTitle) !== target || parsed.season !== season) continue;
      if (parsed.bytes !== null && parsed.bytes < minimumPlausibleBytes) continue;
      recognized.push({
        remoteFileId: parsed.remoteFileId,
        originalFilename: parsed.originalFilename,
        bytes: parsed.bytes,
        resolution: parsed.resolution,
        episode: parsed.episode,
        episodeTitle: parsed.episodeTitle,
      });
    }
    const byEpisode = new Map<number, RecognizedPackFile>();
    for (const file of [...recognized].sort((left, right) => left.remoteFileId.localeCompare(right.remoteFileId))) {
      if (!byEpisode.has(file.episode)) byEpisode.set(file.episode, file);
    }
    const unique = [...byEpisode.values()].sort((left, right) => left.episode - right.episode);
    for (const locator of locators) {
      const file = item.files.find(
        (candidate) =>
          candidate.provider === locator.provider &&
          candidate.itemType === locator.itemType &&
          candidate.remoteItemId === locator.remoteItemId &&
          candidate.remoteFileId === locator.remoteFileId,
      );
      if (!file) return { ok: false, reason: "missing-file" };
      const parsed = parseVideoCandidate(file);
      if (
        !parsed ||
        parsed.multiEpisode ||
        parsed.seriesTitle === null ||
        normalizedSeriesTitle(parsed.seriesTitle) !== target ||
        parsed.season !== season ||
        parsed.provider !== locator.provider ||
        parsed.itemType !== locator.itemType ||
        parsed.remoteItemId !== locator.remoteItemId ||
        parsed.remoteFileId !== locator.remoteFileId ||
        parsed.originalFilename !== locator.filename ||
        parsed.bytes !== locator.sizeBytes ||
        parsed.resolution !== locator.resolution ||
        parsed.season !== locator.season ||
        parsed.episode !== locator.episode
      ) {
        return { ok: false, reason: "changed-pack" };
      }
    }
    if (unique.length !== locators.length) return { ok: false, reason: "changed-pack" };
    // It is not enough that every old locator is still present. The matcher
    // deterministically chooses the lexicographically first file per episode;
    // an inserted earlier id could otherwise make us download an unreviewed
    // replacement with the same byte count.
    if (
      unique.some((file) =>
        !locators.some(
          (locator) =>
            locator.provider === item.provider &&
            locator.itemType === item.itemType &&
            locator.remoteItemId === item.remoteItemId &&
            locator.remoteFileId === file.remoteFileId &&
            locator.filename === file.originalFilename &&
            locator.sizeBytes === file.bytes &&
            locator.resolution === file.resolution &&
            locator.season === season &&
            locator.episode === file.episode,
        ),
      )
    ) {
      return { ok: false, reason: "changed-pack" };
    }
    if (offer.packEpisodeCount === null || unique.length !== offer.packEpisodeCount) {
      return { ok: false, reason: "changed-pack" };
    }
    const totalBytes = unique.some((file) => file.bytes === null)
      ? null
      : unique.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    if (offer.packTotalBytes === null || totalBytes === null) {
      return { ok: false, reason: "unknown-pack-bytes" };
    }
    if (totalBytes !== offer.packTotalBytes) return { ok: false, reason: "changed-pack" };
    return { ok: true, files: unique };
  }

  /**
   * Queued mutation: rechecks duplicates/jobs and free space immediately before
   * creating only the remaining episodes, then consumes the offer.
   */
  private async scheduleSeasonImport(
    offer: AcquisitionReview,
    provider: AcquisitionProviderId,
    itemType: AcquisitionReviewCandidate["itemType"],
    remoteItemId: string,
    files: readonly RecognizedPackFile[],
  ): Promise<SeasonImportOutcome> {
    const repository = this.repositories.acquisitions;
    const currentOffer = repository.reviews.get(offer.id);
    if (!sameSeasonPackOffer(currentOffer, offer)) {
      return { kind: "stale", provider, reason: "changed-pack" };
    }
    const seriesTitle = offer.packSeriesTitle!;
    const season = offer.packSeason!;
    const remaining: RecognizedPackFile[] = [];
    let alreadyImported = 0;
    let alreadyScheduled = 0;
    for (const file of files) {
      if (repository.imports.findByEpisode(seriesTitle, season, file.episode)) {
        alreadyImported += 1;
        continue;
      }
      if (repository.imports.findByRemote(provider, remoteItemId, file.remoteFileId)) {
        alreadyImported += 1;
        continue;
      }
      const wanted = repository.wanted.findByIdentity(seriesTitle, season, file.episode);
      if (
        repository.jobs.findRemote(provider, remoteItemId, file.remoteFileId) ||
        (wanted !== undefined &&
          repository.jobs.listByWanted(wanted.id).some((job) => !isTerminal(job.state)))
      ) {
        alreadyScheduled += 1;
        continue;
      }
      remaining.push(file);
    }
    const neededBytes = remaining.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    if (!(await this.hasFreeBytes(neededBytes))) {
      return { kind: "insufficient-space", provider, neededBytes };
    }
    const wantedIds: string[] = [];
    const jobIds: string[] = [];
    let offerChanged = false;
    this.repositories.transaction(() => {
      // Provider I/O happens outside the SQLite queue. Re-read the durable
      // offer in the final serialized mutation so a delete or replacement
      // cannot schedule a stale selection or consume its successor.
      if (!sameSeasonPackOffer(repository.reviews.get(offer.id), offer)) {
        offerChanged = true;
        return;
      }
      for (const file of remaining) {
        const current = repository.wanted.findByIdentity(seriesTitle, season, file.episode);
        if (repository.imports.findByEpisode(seriesTitle, season, file.episode)) {
          alreadyImported += 1;
          continue;
        }
        if (repository.jobs.findRemote(provider, remoteItemId, file.remoteFileId)) {
          alreadyScheduled += 1;
          continue;
        }
        const timestamp = this.isoNow();
        const wanted =
          current ??
          repository.wanted.create({
            id: this.randomId(),
            seriesTitle,
            season,
            episode: file.episode,
            // Filename-derived title, with a stable server-owned fallback.
            episodeTitle: file.episodeTitle ?? `Episode ${file.episode}`,
            status: "wanted",
            statusDetail: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        if (
          current !== undefined &&
          repository.jobs.listByWanted(current.id).some((job) => !isTerminal(job.state))
        ) {
          alreadyScheduled += 1;
          continue;
        }
        const job: AcquisitionJob = {
          id: this.randomId(),
          wantedId: wanted.id,
          episodeKey: episodeKey(seriesTitle, season, file.episode),
          provider,
          remoteItemId,
          remoteFileId: file.remoteFileId,
          originalFilename: file.originalFilename,
          expectedBytes: file.bytes,
          receivedBytes: 0,
          state: "match-found",
          attempt: 0,
          maxAttempts: defaultMaxAttempts,
          retryAfterMs: null,
          cancelRequested: false,
          partPath: null,
          destinationPath: null,
          verifiedSha256: null,
          lastError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        repository.jobs.save(job);
        repository.wanted.setStatus(wanted.id, "match-found", { detail: null, now: timestamp });
        wantedIds.push(wanted.id);
        jobIds.push(job.id);
      }
      // Once this collection is committed for a season, the other displayed
      // collections are no longer actionable alternatives: their files would
      // collide with the just-reserved episode identities. Remove only the
      // same normalized series/season; a later failed import can be surfaced
      // again by the next provider poll.
      for (const review of repository.reviews.list()) {
        if (
          review.kind === "season-pack" &&
          review.packSeason === season &&
          review.packSeriesTitle !== null &&
          normalizedSeriesTitle(review.packSeriesTitle) === normalizedSeriesTitle(seriesTitle)
        ) {
          repository.reviews.remove(review.id);
        }
      }
    });
    if (offerChanged) return { kind: "stale", provider, reason: "changed-pack" };
    return { kind: "scheduled", wantedIds, jobIds, alreadyImported, alreadyScheduled };
  }
}

/** Compare the durable facts that make a season-pack offer safe to consume. */
function sameSeasonPackOffer(
  current: AcquisitionReview | undefined,
  expected: AcquisitionReview,
): boolean {
  if (!current || current.kind !== "season-pack" || expected.kind !== "season-pack") return false;
  if (
    current.id !== expected.id ||
    current.wantedId !== expected.wantedId ||
    current.packSeriesTitle !== expected.packSeriesTitle ||
    current.packSeason !== expected.packSeason ||
    current.packEpisodeCount !== expected.packEpisodeCount ||
    current.packTotalBytes !== expected.packTotalBytes
  ) return false;
  const key = (candidate: AcquisitionReviewCandidate): string =>
    [
      candidate.provider,
      candidate.itemType,
      candidate.remoteItemId,
      candidate.remoteFileId,
      candidate.filename,
      candidate.sizeBytes,
      candidate.resolution,
      candidate.season,
      candidate.episode,
    ].map((value) => String(value)).join("\u0000");
  return current.candidates.length === expected.candidates.length &&
    current.candidates.map(key).sort().every((value, index) => value === expected.candidates.map(key).sort()[index]);
}

function sameReviewCandidate(
  left: AcquisitionReviewCandidate,
  right: AcquisitionReviewCandidate,
): boolean {
  return left.provider === right.provider && left.itemType === right.itemType &&
    left.remoteItemId === right.remoteItemId && left.remoteFileId === right.remoteFileId &&
    left.filename === right.filename && left.sizeBytes === right.sizeBytes &&
    left.resolution === right.resolution && left.season === right.season && left.episode === right.episode;
}

/** Compares an episode review without its mutable timestamps. */
function sameEpisodeReview(
  current: AcquisitionReview,
  expected: AcquisitionReview,
): boolean {
  return current.kind !== "season-pack" && expected.kind !== "season-pack" &&
    current.id === expected.id &&
    current.wantedId === expected.wantedId &&
    current.kind === expected.kind &&
    current.message === expected.message &&
    current.packEpisodeCount === expected.packEpisodeCount &&
    current.packTotalBytes === expected.packTotalBytes &&
    current.packSeriesTitle === expected.packSeriesTitle &&
    current.packSeason === expected.packSeason &&
    current.candidates.length === expected.candidates.length &&
    current.candidates.every((candidate, index) =>
      sameReviewCandidate(candidate, expected.candidates[index]!),
    );
}

function isRunnable(job: AcquisitionJob, nowMs: number): boolean {
  switch (job.state) {
    case "match-found":
    case "waiting-provider":
    case "downloading":
    case "verifying":
    case "placing":
      return true;
    case "retry-wait":
      return job.retryAfterMs === null || Date.parse(job.updatedAt) + job.retryAfterMs <= nowMs;
    default:
      return false;
  }
}

function backoffDelay(attempt: number): number {
  return Math.min(maximumBackoffMs, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 5));
}

function reviewMessageFor(reason: "ambiguous" | "multi-episode" | "uncertain-title"): string {
  switch (reason) {
    case "ambiguous":
      return "More than one equally good file matches this episode";
    case "multi-episode":
      return "A file covers more than one episode";
    case "uncertain-title":
      return "A file's series title only partly matches this episode";
  }
}
