import Fastify from "fastify";
import { join } from "node:path";
import {
  AcquisitionCoordinator,
  type AcquisitionCoordinatorDependencies,
} from "../acquisition/coordinator.js";
import type { ProviderName } from "../acquisition/providerTypes.js";
import { openDatabase } from "../db/database.js";
import { createRepositories } from "../db/repositories.js";
import { seedDemoIfEmpty } from "../demo/marktvLaughs.js";
import { RealDebridProvider } from "../integrations/acquisition/realDebrid.js";
import { TorBoxProvider } from "../integrations/acquisition/torBox.js";
import type { AcquisitionProvider } from "../integrations/acquisition/provider.js";
import { registerManagedLibrary } from "../media/roots.js";
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
};

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;
const IPV6_LOOPBACK = new Set(["::1", "[::1]", "0:0:0:0:0:0:0:1"]);

const REQUIRED_PROVIDERS = ["real-debrid", "torbox"] as const satisfies readonly ProviderName[];

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
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid provider map: providers must contain exactly real-debrid and torbox");
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
    normalized
      .split(".")
      .every((octet) => Number(octet) <= 255);
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
  return IPV4_LOOPBACK.test(hostname) && hostname.split(".").every((octet) => Number(octet) <= 255);
}

/** Browser origins/referers must explicitly name a loopback authority. */
export function isLoopbackBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
    return isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}

function rejectNonLocalRequest(reply: { code: (status: number) => { send: (body: object) => unknown } }) {
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
  // This is registered before every route: binding to loopback is necessary,
  // but Host/Origin checks also prevent DNS rebinding and hostile browser tabs
  // from reaching local credential or acquisition controls.
  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackAuthority(request.headers.host)) return rejectNonLocalRequest(reply);
    for (const value of [request.headers.origin, request.headers.referer]) {
      if (value !== undefined && !isLoopbackBrowserUrl(value)) return rejectNonLocalRequest(reply);
    }
  });
  const dataDir =
    options.dataDir ??
    process.env.MARKTV_DATA_DIR ??
    join(process.cwd(), "data");
  const repositories = createRepositories(openDatabase(dataDir));
  const now = options.now ?? (() => new Date());
  const credentials = options.credentials ?? new KeychainCredentialStore();
  // Create/verify the managed inbox and library, then register the resolved
  // library root exactly once so acquisition writes and the media scanner share
  // one root however often the app starts against the same data dir.
  const managedPaths = await registerManagedLibrary(repositories, dataDir);
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

  app.addHook("onClose", async () => {
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
  await registerIntegrationRoutes(app, context);
  await registerMediaRoutes(app, context);
  await registerPoolRoutes(app, context);
  await registerScheduleRoutes(app, context);
  await registerTunarrRoutes(app, context);
  // Deterministic startup: recover durable jobs and arm exactly one
  // unreferenced poll timer before the app begins serving.
  try {
    await coordinator.start();
  } catch (error) {
    // A failed start leaves no app handle to close, so release the coordinator
    // and database here instead of leaking both.
    await coordinator.stop().catch(() => undefined);
    repositories.close();
    throw error;
  }
  return app;
}
