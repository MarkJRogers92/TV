import Fastify from "fastify";
import { join } from "node:path";
import {
  AcquisitionCoordinator,
  type AcquisitionCoordinatorDependencies,
} from "../acquisition/coordinator.js";
import type { ProviderName } from "../acquisition/providerTypes.js";
import { openDatabase } from "../db/database.js";
import { createRepositories } from "../db/repositories.js";
import { logError, logInfo } from "./logging.js";
import {
  startScheduleRefresh,
  type ScheduleRefresh,
} from "./scheduleRefresh.js";
import {
  autoSyncTunarr,
  readTunarrMappingForChannel,
} from "./tunarrAutoSync.js";
import { seedDemoIfEmpty } from "../demo/marktvLaughs.js";
import { RealDebridProvider } from "../integrations/acquisition/realDebrid.js";
import { TorBoxProvider } from "../integrations/acquisition/torBox.js";
import type { AcquisitionProvider } from "../integrations/acquisition/provider.js";
import {
  pinRegisteredMediaRoots,
  registerManagedLibrary,
} from "../media/roots.js";
import { reconcileImportedSeries } from "../media/seriesEnrollment.js";
import { reconcileMovieProgramming } from "../media/movieEnrollment.js";
import {
  createPreparationIntakeRunner,
  type PreparationIntakeRunner,
} from "../preparation/intakeRunner.js";
import {
  createPreparationExecutor,
  type PreparationExecutor,
} from "../preparation/executor.js";
import { describePreparationEvent } from "../preparation/events.js";
import {
  createHealthShadow,
  type HealthShadow,
} from "../autopilot/healthShadow.js";
import { createChannelRecovery } from "../autopilot/recovery.js";
import {
  createAlwaysOnSupervisor,
  type AlwaysOnSupervisor,
} from "../autopilot/alwaysOn.js";
import {
  createPodExposureObserver,
  type PodExposureObserver,
} from "../autopilot/podExposureObserver.js";
import { createAiringLedger } from "../autopilot/airingLedger.js";
import { recordIncident } from "../autopilot/incidents.js";
import { DateTime } from "luxon";
import { KeychainCredentialStore } from "../security/keychain.js";
import type { CredentialStore } from "../security/credentialStore.js";
import type { ServerContext } from "./context.js";
import { registerAcquisitionRoutes } from "./routes/acquisitions.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerPoolRoutes } from "./routes/pools.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerTunarrRoutes } from "./routes/tunarr.js";
import { registerWatchRoutes } from "./routes/watch.js";
import { registerContinuityRoutes } from "./routes/continuity.js";
import { registerStatusRoutes } from "./routes/status.js";
import { ScheduleService, type ExportSchedule } from "./scheduleService.js";

/**
 * Injected coordinator seams for tests. Everything except the repositories,
 * credential store, provider map, and managed paths is replaceable, so tests
 * can drive downloads, verification, and the poll timer deterministically
 * without touching the network, Keychain, or the real clock.
 */
export type CoordinatorSeams = Omit<
  AcquisitionCoordinatorDependencies,
  "repositories" | "credentials" | "providers" | "paths"
>;

export type BuildAppOptions = {
  dataDir?: string;
  now?: () => Date;
  exportSchedule?: ExportSchedule;
  credentials?: CredentialStore;
  providers?: Record<ProviderName, AcquisitionProvider>;
  coordinator?: CoordinatorSeams;
  /**
   * Whether to run the background schedule refresh.
   *
   * Off by default, and deliberately so: it generates schedules and writes export
   * files on a timer, so anything that builds an app for a test, a verification
   * run, or a script must not inherit it. The real service opts in.
   */
  scheduleRefresh?: boolean;
  /**
   * Whether to run the background media-intake scanner.
   *
   * Off by default, for the same reason as `scheduleRefresh`: it walks registered
   * roots on a timer and writes catalog rows, so anything that builds an app for
   * a test, a verification run, or a script must not inherit it. The real service
   * opts in.
   */
  preparationIntake?: boolean;
  /** Test seam for the intake runner; defaults to the real implementation. */
  createIntakeRunner?: typeof createPreparationIntakeRunner;
  /**
   * Whether to run the background preparation executor.
   *
   * Off by default, for the same reason as the other background loops: it runs
   * bounded ffprobe/ffmpeg probes and writes preparation jobs. It records graded
   * evidence only — it does not convert or move originals.
   */
  preparationExecutor?: boolean;
  /** Test seam for the preparation executor; defaults to the real implementation. */
  createExecutor?: typeof createPreparationExecutor;
  /**
   * Observe-only continuity watchdog (Stage 4). Off by default; it samples each
   * channel's published playlist and LOGS the continuity classifier's verdict
   * without acting on it, so thresholds can be calibrated before any restart.
   */
  healthShadow?: boolean;
  /** Root of the per-channel HLS stream directories for the shadow watchdog. */
  healthShadowRoot?: string;
  /**
   * Whether the watchdog may ACT (bounded, channel-scoped) as well as observe.
   * Off by default: the transport repair is a deliberate opt-in once the shadow
   * verdicts are trusted. The circuit breaker and single-owner acknowledgment
   * apply regardless.
   */
  healthRecovery?: boolean;
  /**
   * Always-on supervisor (R01). Off by default. When on, it requests each
   * enabled channel's master playlist on a slow cadence so its producer starts
   * and keeps producing with no viewers; Tunarr's get-or-create makes the
   * repeat idempotent, so it can never create a second producer.
   */
  alwaysOn?: boolean;
  /**
   * Record per-creative pod exposure (SC06) from each channel's own advertised
   * playlist. Read-only with respect to serving: it reads playlist files and
   * writes ledger rows.
   */
  podExposure?: boolean;
  /** Root of the per-channel HLS stream directories, shared with the watchdog. */
  podExposureStreamsRoot?: string;
};

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;
const IPV6_LOOPBACK = new Set(["::1", "[::1]", "0:0:0:0:0:0:0:1"]);

const REQUIRED_PROVIDERS = [
  "real-debrid",
  "torbox",
] as const satisfies readonly ProviderName[];

/**
 * Fail closed when the injected provider map is incomplete or routes a key to
 * the wrong implementation. Every key must exist and its implementation must
 * advertise the same provider name, so a token can never be sent to the wrong
 * provider. Throws before any route, database, or provider can be used.
 */
export function assertValidProviderMap(
  providers: Record<ProviderName, AcquisitionProvider>,
): void {
  if (!providers || typeof providers !== "object") {
    throw new Error("Invalid provider map: providers must be an object");
  }
  const keys = Object.keys(providers).sort();
  const expected = [...REQUIRED_PROVIDERS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      "Invalid provider map: providers must contain exactly real-debrid and torbox",
    );
  }
  for (const name of REQUIRED_PROVIDERS) {
    const implementation = (providers as Record<string, unknown>)[name] as {
      provider?: unknown;
      testAuthentication?: unknown;
    };
    if (!implementation || typeof implementation !== "object") {
      throw new Error(`Invalid provider map: missing provider "${name}"`);
    }
    if (implementation.provider !== name) {
      throw new Error(`Invalid provider map: provider "${name}" is mismatched`);
    }
    if (typeof implementation.testAuthentication !== "function") {
      throw new Error(`Invalid provider map: provider "${name}" is invalid`);
    }
  }
}

/**
 * MarkTV keeps credential and file-control routes on the local machine, so the
 * listen address must be a loopback address. Anything else is rejected before
 * `app.listen` is called.
 */
export function assertLoopbackHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  const octetsValid =
    IPV4_LOOPBACK.test(normalized) &&
    normalized.split(".").every((octet) => Number(octet) <= 255);
  if (
    normalized !== "localhost" &&
    !IPV6_LOOPBACK.has(normalized) &&
    !octetsValid
  ) {
    throw new Error(
      `Refusing to bind MarkTV to non-loopback host "${host}"; use 127.0.0.1, ::1, or localhost`,
    );
  }
}

/** Exact Host-header authority check; names are never resolved. */
export function isLoopbackAuthority(value: string | undefined): boolean {
  if (!value || value !== value.trim()) return false;
  const normalized = value.toLowerCase();
  if (/^\[::1\](?::\d{1,5})?$/.test(normalized)) return true;
  const match = normalized.match(/^([^:]+)(?::\d{1,5})?$/);
  if (!match) return false;
  const hostname = match[1];
  if (hostname === "localhost") return true;
  return (
    IPV4_LOOPBACK.test(hostname) &&
    hostname.split(".").every((octet) => Number(octet) <= 255)
  );
}

/** Browser origins/referers must explicitly name a loopback authority. */
export function isLoopbackBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      return false;
    return isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}

function rejectNonLocalRequest(reply: {
  code: (status: number) => { send: (body: object) => unknown };
}) {
  return reply.code(403).send({
    code: "LOCAL_ONLY",
    message: "MarkTV accepts local browser requests only",
  });
}

export async function buildApp(options: BuildAppOptions = {}) {
  const providers =
    options.providers ??
    ({
      "real-debrid": new RealDebridProvider(),
      torbox: new TorBoxProvider(),
    } satisfies Record<ProviderName, AcquisitionProvider>);
  assertValidProviderMap(providers);
  // Local-folder media IDs are absolute paths encoded with base64url, so they
  // routinely exceed find-my-way's 100-character default and would be rejected
  // with a 414 before the media route runs. Allow generous headroom for real
  // paths while keeping the value bounded.
  const app = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 2048 },
  });
  // Fastify runs with `logger: false`, so an unexpected failure used to become a
  // bare 500 with nothing recorded anywhere - the same blind spot the background
  // loops had. Statuses below 500 keep Fastify's own handling, because its schema
  // validation and the routes' explicit replies already carry a meaningful status
  // and body; only genuinely unexpected failures are logged and normalised.
  app.setErrorHandler((error: unknown, request, reply) => {
    // Fastify types the handler's error as unknown, so the status has to be read
    // defensively rather than assumed.
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode) || 500
        : 500;
    if (status < 500) return reply.send(error);
    logError("request.unhandled", error, {
      method: request.method,
      url: request.url,
    });
    return reply
      .code(500)
      .send({ code: "INTERNAL_ERROR", message: "Unexpected server error" });
  });
  // This is registered before every route: binding to loopback is necessary,
  // but Host/Origin checks also prevent DNS rebinding and hostile browser tabs
  // from reaching local credential or acquisition controls.
  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackAuthority(request.headers.host))
      return rejectNonLocalRequest(reply);
    for (const value of [request.headers.origin, request.headers.referer]) {
      if (value !== undefined && !isLoopbackBrowserUrl(value))
        return rejectNonLocalRequest(reply);
    }
  });
  const dataDir =
    options.dataDir ??
    process.env.MARKTV_DATA_DIR ??
    join(process.cwd(), "data");
  const database = openDatabase(dataDir);
  const repositories = createRepositories(database);
  const now = options.now ?? (() => new Date());
  const credentials = options.credentials ?? new KeychainCredentialStore();
  // Create/verify the managed inbox and library, then register the resolved
  // library root exactly once so acquisition writes and the media scanner share
  // one root however often the app starts against the same data dir.
  const managedPaths = await registerManagedLibrary(repositories, dataDir, {
    inbox: process.env.MARKTV_INBOX_DIR,
    library: process.env.MARKTV_LIBRARY_DIR,
  });
  // Hold every registered root open so the inode comparisons the scanner relies
  // on cannot be defeated by a recycled inode, including roots from earlier runs.
  await pinRegisteredMediaRoots(repositories);
  // Enrol episodes that earlier runs imported. Enrolment is idempotent, so this
  // also re-attaches anything whose enrolment was skipped while the channel was
  // missing, and it closes the window after an import whose enrolment never ran.
  reconcileImportedSeries(repositories, { now: now() });
  // Movie pools are swept at startup too, so a library scanned before the feature
  // was switched on becomes schedulable without a second manual scan.
  reconcileMovieProgramming(repositories);
  // One coordinator for the whole process. It reuses the validated provider map
  // and credential store the integration routes use, so a token, locator, or
  // command can never be routed through a second, unvalidated stack.
  const coordinator = new AcquisitionCoordinator({
    repositories,
    credentials,
    providers,
    paths: managedPaths,
    ...options.coordinator,
    now: options.coordinator?.now ?? now,
  });
  const context: ServerContext = {
    dataDir,
    repositories,
    now,
    schedules: new ScheduleService(
      repositories,
      dataDir,
      now,
      options.exportSchedule,
    ),
    credentials,
    providers,
    integrationStatus: new Map(),
    coordinator,
  };
  seedDemoIfEmpty(
    context.repositories,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  // Held out here because the close hook is registered before startup runs, so it
  // needs something to stop by the time it fires.
  let scheduleRefresh: ScheduleRefresh | null = null;
  let preparationIntake: PreparationIntakeRunner | null = null;
  let preparationExecutor: PreparationExecutor | null = null;
  let healthShadow: HealthShadow | null = null;
  let alwaysOn: AlwaysOnSupervisor | null = null;
  let podExposureObserver: PodExposureObserver | null = null;
  app.addHook("onClose", async () => {
    scheduleRefresh?.stop();
    // Stop the intake scanner before the database handle closes: its poll timer
    // and file watchers must not outlive the repositories they write through.
    await preparationIntake?.stop();
    // Stop the preparation executor after the scanner, before the DB closes, so
    // a probe in flight cannot write a job record into a closed handle.
    await preparationExecutor?.stop();
    // Stop the observe-only watchdog; it only logs, but its timer must not
    // outlive the process either.
    await healthShadow?.stop();
    await alwaysOn?.stop();
    // Stop the pod-exposure observer before the repositories close: it writes
    // ledger rows through them.
    await podExposureObserver?.stop();
    // The coordinator owns every durable acquisition write, so stop it
    // (clearing its timer, aborting local transfers, and persisting resumable
    // state) before the database handle is closed.
    await context.coordinator.stop();
    context.repositories.close();
  });
  app.get("/api/v1/health", async () => ({
    status: "ok" as const,
    version: "0.1.0",
  }));
  await registerAcquisitionRoutes(app, context);
  await registerChannelRoutes(app, context);
  await registerContinuityRoutes(app, context);
  await registerStatusRoutes(app, context);
  await registerIntegrationRoutes(app, context);
  await registerMediaRoutes(app, context);
  await registerPoolRoutes(app, context);
  await registerScheduleRoutes(app, context);
  await registerTunarrRoutes(app, context);
  await registerWatchRoutes(app, context);
  // Deterministic startup: recover durable jobs and arm exactly one
  // unreferenced poll timer before the app begins serving.
  try {
    await coordinator.start();
    if (options.preparationIntake) {
      // One background intake worker for the process. Its first pass is bounded
      // (a fixed entry budget and at most one probe), and it never blocks
      // serving, so it is started but not awaited.
      const makeRunner =
        options.createIntakeRunner ?? createPreparationIntakeRunner;
      preparationIntake = makeRunner(repositories, {
        onError: (error, path) =>
          logError("preparation-intake", error, path ? { path } : {}),
        onEvent: (event) => {
          const { message, context } = describePreparationEvent(event);
          logInfo("preparation-intake", message, context);
        },
      });
      void preparationIntake
        .start()
        .catch((error) => logError("preparation-intake", error));
    }
    if (options.preparationExecutor) {
      // One background executor for the process; it claims at most one job per
      // pass and never blocks serving. Started but not awaited.
      const makeExecutor = options.createExecutor ?? createPreparationExecutor;
      preparationExecutor = makeExecutor(repositories, {
        onError: (error) => logError("preparation-executor", error),
        onEvent: (event) => {
          const { message, context } = describePreparationEvent(event);
          logInfo("preparation-executor", message, context);
        },
      });
      void preparationExecutor
        .start()
        .catch((error) => logError("preparation-executor", error));
    }
    if (options.healthShadow && options.healthShadowRoot) {
      // Bounded, channel-scoped recovery. Present only when acting is opted in;
      // otherwise the watchdog observes and logs only.
      const recovery = options.healthRecovery
        ? createChannelRecovery({
            recover: async (channelId) => {
              // Repair THAT channel only: re-push its current line-up to Tunarr.
              // Never touches another channel and never restarts the service.
              const channel = repositories.channels.get(channelId);
              if (!channel) return false;
              const today = DateTime.fromJSDate(context.now(), {
                zone: channel.timezone,
              }).toISODate();
              if (!today) return false;
              const schedule = repositories.schedules.latestForDate(
                channelId,
                today,
              );
              if (!schedule) return false;
              const outcome = await autoSyncTunarr(repositories, {
                channelId,
                scheduleId: schedule.id,
                now: context.now,
              });
              return outcome.status === "synced";
            },
            onDecision: (channelId, outcome, reason) => {
              logInfo("recovery", "Channel recovery decision", {
                channelId,
                outcome,
                reason,
              });
              // Record real decisions durably (not the routine no-action ones).
              if (outcome !== "no-action")
                recordIncident(repositories, {
                  at: context.now().toISOString(),
                  channelId,
                  kind: outcome,
                  reason,
                });
            },
          })
        : null;
      healthShadow = createHealthShadow(repositories, {
        streamsRoot: options.healthShadowRoot,
        // A MarkTV channel id is not its Tunarr UUID; resolve the real one.
        streamsDirectoryFor: (channel) => {
          const tunarrChannelId = readTunarrMappingForChannel(
            repositories,
            channel.id,
          )?.channelId;
          return tunarrChannelId
            ? join(options.healthShadowRoot!, `stream_${tunarrChannelId}`)
            : null;
        },
        ...(recovery
          ? {
              consume: async (result) => (await recovery.handle(result)).state,
            }
          : {}),
        onResult: (result) => {
          logInfo(
            "health-shadow",
            recovery
              ? "Continuity health (recovery armed)"
              : "Continuity health (observe-only)",
            {
              channelId: result.channelId,
              health: result.health,
              incident: result.incident,
              recommendation: result.recommendation,
            },
          );
          if (result.incident)
            recordIncident(repositories, {
              at: context.now().toISOString(),
              channelId: result.channelId,
              kind: "incident",
              reason: result.health,
            });
        },
        onError: (error, channelId) =>
          logError("health-shadow", error, channelId ? { channelId } : {}),
      });
      void healthShadow
        .start()
        .catch((error) => logError("health-shadow", error));
    }
    if (options.podExposure && options.podExposureStreamsRoot) {
      // Record what each finished pod actually advertised (SC06). Deliberately
      // NOT driven by the schedule: a plan recorded as exposure would log every
      // pod as three completed ads, which is the fault this case exists to
      // prevent. It reads the same stream directories the watchdog does.
      const ledger = createAiringLedger(database);
      podExposureObserver = createPodExposureObserver(repositories, ledger, {
        streamsRoot: options.podExposureStreamsRoot,
        // A MarkTV channel id is not its Tunarr UUID; resolve the real one, the
        // same way the watchdog does, or there is no playlist to read.
        streamsDirectoryFor: (channel) => {
          const tunarrChannelId = readTunarrMappingForChannel(
            repositories,
            channel.id,
          )?.channelId;
          return tunarrChannelId
            ? join(options.podExposureStreamsRoot!, `stream_${tunarrChannelId}`)
            : null;
        },
        onDecision: (decision) => {
          // Only the outcomes that carry a decision worth reading are logged at
          // info; a channel with no finished pods says nothing on purpose.
          if (
            decision.outcome === "recorded" ||
            decision.outcome === "refused"
          ) {
            logInfo("pod-exposure", decision.outcome, {
              channelId: decision.channelId,
              podId: decision.podId,
              airedSeconds: decision.record?.podAiredSeconds,
              completed: decision.record?.podCompleted,
              detail: decision.detail,
            });
          }
        },
        // Every pass reports what it looked at, including when it found nothing
        // observable - otherwise a silent observer cannot be told apart from one
        // that is not running.
        onPass: (summary) =>
          logInfo("pod-exposure", "pass", {
            channelId: summary.channelId,
            podsConsidered: summary.podsConsidered,
            recorded: summary.recorded,
            alreadyRecorded: summary.alreadyRecorded,
            notObserved: summary.notObserved,
            refused: summary.refused,
            noPlaylist: summary.noPlaylist,
          }),
        onError: (error, channelId) =>
          logError("pod-exposure", error, channelId ? { channelId } : {}),
      });
      void podExposureObserver
        .start()
        .catch((error) => logError("pod-exposure", error));
    }
    if (options.alwaysOn) {
      // Start each enabled channel's producer so it keeps running with no viewers.
      alwaysOn = createAlwaysOnSupervisor(repositories, {
        resolveStreamUrl: (channelId) => {
          const mapping = readTunarrMappingForChannel(repositories, channelId);
          if (!mapping?.url || !mapping.channelId) return null;
          return `${mapping.url.replace(/\/+$/, "")}/stream/channels/${mapping.channelId}.m3u8`;
        },
        onResult: (channelId, ok, status) =>
          logInfo("always-on", "Channel session ensured", {
            channelId,
            ok,
            status,
          }),
        onError: (error, channelId) =>
          logError("always-on", error, channelId ? { channelId } : {}),
      });
      void alwaysOn.start().catch((error) => logError("always-on", error));
    }
    if (options.scheduleRefresh) {
      // Not awaited: a refresh that has to generate takes minutes, and serving must
      // not wait on it.
      scheduleRefresh = startScheduleRefresh(context, {
        syncToTunarr: (channelId, scheduleId, at) =>
          autoSyncTunarr(repositories, { channelId, scheduleId, now: at }),
        lastSync: (channelId) =>
          readTunarrMappingForChannel(repositories, channelId)?.lastSync,
        movieProgramming: {
          ensureCoverage: (channel, at) =>
            context.schedules.ensureMovieCoverage(channel, at),
        },
      });
    }
  } catch (error) {
    // A failed start leaves no app handle to close, so release the intake
    // scanner, the executor, the coordinator, and the database here instead of
    // leaking them.
    await preparationIntake?.stop().catch(() => undefined);
    await preparationExecutor?.stop().catch(() => undefined);
    await healthShadow?.stop().catch(() => undefined);
    await alwaysOn?.stop().catch(() => undefined);
    await coordinator.stop().catch(() => undefined);
    repositories.close();
    throw error;
  }
  return app;
}
