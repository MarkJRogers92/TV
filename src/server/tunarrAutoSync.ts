import type { Repositories } from "../db/repositories.js";
import { TunarrClient } from "../integrations/tunarr/client.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildTunarrSyncPlan,
  type TunarrSyncPlan,
} from "../integrations/tunarr/plan.js";
import { syncTunarrPlan } from "../integrations/tunarr/sync.js";
import { preparationEligibleMedia } from "../preparation/eligibleMedia.js";
import type { TunarrMediaSource } from "../integrations/tunarr/types.js";
import {
  normalizeLibraryIds,
  type TunarrMappingInput,
} from "../integrations/tunarr/types.js";

/**
 * Pushes a freshly generated schedule to Tunarr without a manual dry-run/sync.
 *
 * The dry-run the Tunarr page performs is not a human approval step -- it is how
 * the plan gets built and fingerprinted, and its `syncEligible` gate is what
 * refuses a lineup containing media Tunarr cannot resolve. Running the same
 * build-and-apply here keeps that gate while removing the click: if any
 * scheduled path is unmatched the sync is skipped and recorded, never forced.
 *
 * Nothing here may fail a schedule generation. Every outcome -- skipped,
 * blocked, failed, synced -- is written to the mapping as `lastSync` so a sync
 * that quietly did not happen is visible instead of looking like success.
 */

export const TUNARR_MAPPING_SETTING = "tunarr-mapping";
export const TUNARR_MAPPINGS_SETTING = "tunarr-mappings";
const PREPARED_SOURCE_NAME = "MarkTV Prepared Cache";
const preparedRegistration = new Map<string, Promise<string>>();

function isInside(path: string, directory: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(resolve(directory), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The local cache gets its own one-path source, so scanning it never walks original media roots. */
export async function ensurePreparedCacheLibrary(client: TunarrClient, cacheDirectory: string): Promise<string> {
  const key = `${client.url}\u001f${resolve(cacheDirectory)}`;
  const pending = preparedRegistration.get(key);
  if (pending) return pending;
  const work = (async () => {
    let sources = await client.mediaSources();
    const candidates = sources.filter((source) =>
      source.name === PREPARED_SOURCE_NAME || source.paths?.some((path) => resolve(path) === resolve(cacheDirectory)));
    if (candidates.length > 1) throw new Error("prepared_cache_source_ambiguous");
    let source: TunarrMediaSource | undefined = candidates[0];
    if (source && (source.type !== "local" || source.name !== PREPARED_SOURCE_NAME ||
      source.mediaType !== "other_videos" || source.paths?.length !== 1 ||
      resolve(source.paths[0]!) !== resolve(cacheDirectory)))
      throw new Error("prepared_cache_source_conflict");
    const sourceId = source?.id ?? await client.createLocalMediaSource(PREPARED_SOURCE_NAME, resolve(cacheDirectory));
    if (!source?.libraries?.some((library) => library.externalKey && resolve(library.externalKey) === resolve(cacheDirectory))) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        sources = await client.mediaSources();
        const same = sources.filter((candidate) => candidate.name === PREPARED_SOURCE_NAME ||
          candidate.paths?.some((path) => resolve(path) === resolve(cacheDirectory)));
        if (same.length > 1) throw new Error("prepared_cache_source_ambiguous");
        source = same.find((candidate) => candidate.id === sourceId);
        if (source && (source.type !== "local" || source.name !== PREPARED_SOURCE_NAME ||
          source.mediaType !== "other_videos" || source.paths?.length !== 1 ||
          resolve(source.paths[0]!) !== resolve(cacheDirectory)))
          throw new Error("prepared_cache_source_conflict");
        if (source?.libraries?.some((library) => library.externalKey && resolve(library.externalKey) === resolve(cacheDirectory))) break;
        if (attempt < 5) await new Promise((done) => setTimeout(done, 1_000));
      }
    }
    const matching = source?.libraries?.filter((library) =>
      library.externalKey && resolve(library.externalKey) === resolve(cacheDirectory)) ?? [];
    if (matching.length !== 1 || !matching[0]!.id) throw new Error("prepared_cache_library_unavailable");
    return matching[0]!.id;
  })();
  preparedRegistration.set(key, work);
  try { return await work; }
  finally { if (preparedRegistration.get(key) === work) preparedRegistration.delete(key); }
}

export type TunarrAutoSyncOutcome = {
  status: "synced" | "skipped" | "blocked" | "failed";
  at: string;
  marktvChannelId: string;
  scheduleId?: string;
  completed?: string[];
  programCount?: number;
  blockingErrors?: number;
  message?: string;
};

export type StoredTunarrMapping = TunarrMappingInput & {
  url: string;
  marktvChannelId: string;
  /** Automatic sync after a generation. Absent means enabled. */
  autoSync?: boolean;
  plan?: TunarrSyncPlan;
  lastSync?: TunarrAutoSyncOutcome;
};

type StoredTunarrMappingCollection = Record<string, StoredTunarrMapping>;

function isMappingCollection(
  value: unknown,
): value is StoredTunarrMappingCollection {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readLegacyTunarrMapping(
  repositories: Repositories,
): StoredTunarrMapping | undefined {
  return repositories.settings.get(TUNARR_MAPPING_SETTING)?.value as
    | StoredTunarrMapping
    | undefined;
}

export function readTunarrMappings(
  repositories: Repositories,
): StoredTunarrMapping[] {
  const value = repositories.settings.get(TUNARR_MAPPINGS_SETTING)?.value;
  const mappings = isMappingCollection(value) ? Object.values(value) : [];
  const legacy = readLegacyTunarrMapping(repositories);
  if (
    legacy?.marktvChannelId &&
    !mappings.some(
      (mapping) => mapping.marktvChannelId === legacy.marktvChannelId,
    )
  ) {
    mappings.push(legacy);
  }
  return mappings;
}

export function readTunarrMappingForChannel(
  repositories: Repositories,
  marktvChannelId: string,
): StoredTunarrMapping | undefined {
  return readTunarrMappings(repositories).find(
    (mapping) => mapping.marktvChannelId === marktvChannelId,
  );
}

export function readTunarrMapping(
  repositories: Repositories,
): StoredTunarrMapping | undefined {
  return readTunarrMappings(repositories)[0];
}

export function upsertTunarrMapping(
  repositories: Repositories,
  mapping: StoredTunarrMapping,
): void {
  const mappings = readTunarrMappings(repositories).filter(
    (candidate) => candidate.marktvChannelId !== mapping.marktvChannelId,
  );
  mappings.push(mapping);
  repositories.settings.put(
    TUNARR_MAPPINGS_SETTING,
    Object.fromEntries(
      mappings.map((candidate) => [candidate.marktvChannelId, candidate]),
    ),
  );
}

/** The subset of the stored mapping the plan builder consumes. */
function mappingInput(stored: StoredTunarrMapping): TunarrMappingInput {
  return {
    ...(stored.preserveExistingLineup ? { preserveExistingLineup: true } : {}),
    libraryId: stored.libraryId,
    libraryIds: stored.libraryIds,
    channelId: stored.channelId,
    fillerListId: stored.fillerListId,
    createChannel: stored.createChannel,
    transcodeConfigId: stored.transcodeConfigId,
  };
}

function persist(
  repositories: Repositories,
  mapping: StoredTunarrMapping,
  outcome: TunarrAutoSyncOutcome,
): TunarrAutoSyncOutcome {
  upsertTunarrMapping(repositories, {
    ...mapping,
    lastSync: outcome,
  });
  return outcome;
}

/**
 * Asks Tunarr to rescan the mapped libraries and waits for it to settle.
 *
 * A blocked plan almost always means Tunarr was scanned before the newest files
 * were added, which otherwise strands the sync until someone runs a scan by
 * hand. The status endpoint does not reliably report a scan that has only just
 * been accepted, so callers re-check the plan rather than trusting one poll.
 */
async function rescanTunarrLibraries(
  client: TunarrClient,
  mapping: TunarrMappingInput,
  onlyLibraryId?: string,
): Promise<boolean> {
  const libraryIds = onlyLibraryId ? [onlyLibraryId] : normalizeLibraryIds(mapping.libraryIds ?? mapping.libraryId);
  if (!libraryIds.length) return false;
  const sources = await client.mediaSources();
  let requested = false;
  for (const libraryId of libraryIds) {
    const source = sources.find((candidate) =>
      candidate.libraries?.some((library) => library.id === libraryId),
    );
    if (!source) continue;
    if (!(await client.scanLibrary(source.id, libraryId))) continue;
    requested = true;
  }
  if (requested) await new Promise((resolve) => setTimeout(resolve, 3_000));
  return requested;
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  const code = (error as { code?: string }).code;
  return code ? String(code) : "Unknown Tunarr error";
}

export async function autoSyncTunarr(
  repositories: Repositories,
  options: { channelId: string; now: () => Date; scheduleId?: string },
): Promise<TunarrAutoSyncOutcome> {
  const at = options.now().toISOString();
  const stored = readTunarrMappingForChannel(repositories, options.channelId);
  if (!stored?.url)
    return {
      status: "skipped",
      at,
      marktvChannelId: options.channelId,
      message: "Tunarr has not been configured",
    };

  const base = { at, marktvChannelId: options.channelId };
  if (stored.autoSync === false)
    return persist(repositories, stored, {
      ...base,
      status: "skipped",
      message: "Automatic sync is turned off",
    });
  // A caller that knows which day it means passes the id. The fallback to
  // `latest` is insertion order, and the quiet-hours pre-generation puts
  // TOMORROW's schedule newest - so resolving "the newest" here would push a
  // different day's lineup than the caller asked about, replacing what is on air.
  const schedule = options.scheduleId
    ? repositories.schedules.byId(stored.marktvChannelId, options.scheduleId)
    : repositories.schedules.latest(stored.marktvChannelId);
  if (!schedule)
    return persist(repositories, stored, {
      ...base,
      status: "skipped",
      message: options.scheduleId
        ? `No stored schedule with id ${options.scheduleId}`
        : "There is no schedule to sync",
    });

  // Generation may have selected a validated derived path under the original
  // logical media ID. Use the same version-checked catalog view at every plan
  // and apply step, including retries after a Tunarr rescan.
  const mediaCatalog = preparationEligibleMedia(repositories, repositories.media.list());
  const eligibleById = new Map(mediaCatalog.map((item) => [item.id, item.available]));
  const unavailable = schedule.entries.find((entry) =>
    entry.mediaId && eligibleById.get(entry.mediaId) === false);
  if (unavailable)
    return persist(repositories, stored, { ...base, status: "blocked", scheduleId: schedule.id,
      blockingErrors: 1, message: `Scheduled media ${unavailable.mediaId} is unavailable` });
  const eligibleCatalog = mediaCatalog.filter((item) => item.available);
  const catalogById = new Map(eligibleCatalog.map((item) => [item.id, item]));
  const cacheDirectory = repositories.preparation.cacheDirectory;
  const preparedPaths = new Set(schedule.entries.flatMap((entry) => {
    const path = entry.path;
    const catalog = entry.mediaId ? catalogById.get(entry.mediaId) : undefined;
    return path && catalog?.path === path && isInside(path, cacheDirectory) ? [resolve(path)] : [];
  }));
  let activeMapping = stored;
  try {
    const client = new TunarrClient(stored.url);
    let cacheLibraryId: string | undefined;
    if (preparedPaths.size) {
      cacheLibraryId = await ensurePreparedCacheLibrary(client, cacheDirectory);
      const originalIds = normalizeLibraryIds(activeMapping.libraryIds ?? activeMapping.libraryId);
      if (!originalIds.includes(cacheLibraryId)) {
        activeMapping = { ...activeMapping, libraryIds: [...originalIds, cacheLibraryId] };
        upsertTunarrMapping(repositories, activeMapping);
      }
    }
    const input = mappingInput(activeMapping);
    const snapshot = await client.snapshot(input);
    let plan = buildTunarrSyncPlan(
      schedule,
      snapshot.inventory,
      snapshot.capabilities,
      input,
      snapshot.snapshots,
      eligibleCatalog,
    );
    // A plan that cannot resolve its media usually means Tunarr has not scanned
    // since those files arrived. Rescanning turns a refusal the user would have
    // had to clear by hand into one automatic retry, and costs nothing on the
    // ordinary path where the inventory is already current.
    // A prepared day scans only its dedicated cache source. Tunarr's local scan
    // endpoint scans an entire source even when given one library ID; scanning
    // the original media source here would walk the full external library.
    if (!plan.syncEligible && (await rescanTunarrLibraries(client, input, cacheLibraryId))) {
      for (let attempt = 0; attempt < 6 && !plan.syncEligible; attempt += 1) {
        if (attempt > 0)
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        const refreshed = await client.snapshot(input);
        plan = buildTunarrSyncPlan(
          schedule,
          refreshed.inventory,
          refreshed.capabilities,
          input,
          refreshed.snapshots,
          eligibleCatalog,
        );
      }
    }
    if (!plan.syncEligible)
      return persist(
        repositories,
        { ...activeMapping, plan },
        {
          ...base,
          status: "blocked",
          scheduleId: schedule.id,
          blockingErrors: plan.blockingErrors.length,
          message: plan.blockingErrors[0]?.message,
        },
      );

    const result = await syncTunarrPlan(
      client,
      plan,
      schedule,
      eligibleCatalog,
    ).catch(
      (error: unknown) => {
        if ((error as { code?: string }).code === "ACTIVE_VIEWERS")
          return "blocked" as const;
        throw error;
      },
    );
    if (result === "blocked")
      return persist(
        repositories,
        { ...activeMapping, plan },
        {
          ...base,
          status: "blocked",
          scheduleId: schedule.id,
          message:
            "The Tunarr channel has active viewers; the sync will retry after playback stops",
        },
      );
    const state = { ...activeMapping, ...result.state, plan };
    if (result.state.channelId) state.createChannel = false;
    if (result.partialFailure)
      return persist(repositories, state, {
        ...base,
        status: "failed",
        scheduleId: schedule.id,
        completed: result.completed,
        message: result.error,
      });
    return persist(repositories, state, {
      ...base,
      status: "synced",
      scheduleId: schedule.id,
      completed: result.completed,
      programCount: plan.operations.find(
        (operation) => operation.type === "programming",
      )?.payload.length,
    });
  } catch (error) {
    return persist(repositories, activeMapping, {
      ...base,
      status: "failed",
      scheduleId: schedule.id,
      message: reason(error),
    });
  }
}
