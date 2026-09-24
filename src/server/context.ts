import type { ProviderName } from "../acquisition/providerTypes.js";
import type { AcquisitionCoordinator } from "../acquisition/coordinator.js";
import type { Repositories } from "../db/repositories.js";
import type { AcquisitionProvider } from "../integrations/acquisition/provider.js";
import type { CredentialStore } from "../security/credentialStore.js";
import type { ScheduleService } from "./scheduleService.js";
export type { MediaRootRecord } from "../media/roots.js";

export type IntegrationErrorState = {
  code: string;
  message: string;
};

export type IntegrationStatus = {
  connected: boolean;
  accountLabel: string | null;
  error: IntegrationErrorState | null;
};

export type IntegrationProjection = {
  provider: ProviderName;
  connected: boolean;
  accountLabel: string | null;
  error: IntegrationErrorState | null;
};

import type { AlertSink } from "../autopilot/alerts.js";
import type { PlayoutSample } from "../autopilot/playoutWatch.js";

export type ServerContext = {
  repositories: Repositories;
  dataDir: string;
  /** The human channel: alerts a person can be told to go and read. */
  alertSink?: AlertSink;
  /** The latest playout readings, for the status and diagnostic views. */
  playoutSnapshot?: () => PlayoutSample[];
  now: () => Date;
  schedules: ScheduleService;
  credentials: CredentialStore;
  providers: Record<ProviderName, AcquisitionProvider>;
  integrationStatus: Map<ProviderName, IntegrationStatus>;
  /**
   * The single shared acquisition coordinator. Routes command the durable
   * workflow only through this instance; no route writes acquisition state
   * directly.
   */
  coordinator: AcquisitionCoordinator;
};
