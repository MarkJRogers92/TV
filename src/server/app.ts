import Fastify from "fastify";
import { join } from "node:path";
import { openDatabase } from "../db/database.js";
import { createRepositories } from "../db/repositories.js";
import { seedDemoIfEmpty } from "../demo/marktvLaughs.js";
import type { ServerContext } from "./context.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerPoolRoutes } from "./routes/pools.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerTunarrRoutes } from "./routes/tunarr.js";
import { ScheduleService, type ExportSchedule } from "./scheduleService.js";

export type BuildAppOptions = {
  dataDir?: string;
  now?: () => Date;
  exportSchedule?: ExportSchedule;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  const dataDir =
    options.dataDir ??
    process.env.MARKTV_DATA_DIR ??
    join(process.cwd(), "data");
  const repositories = createRepositories(openDatabase(dataDir));
  const now = options.now ?? (() => new Date());
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
  };
  seedDemoIfEmpty(
    context.repositories,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  app.addHook("onClose", async () => context.repositories.close());
  app.get("/api/v1/health", async () => ({
    status: "ok" as const,
    version: "0.1.0",
  }));
  await registerChannelRoutes(app, context);
  await registerMediaRoutes(app, context);
  await registerPoolRoutes(app, context);
  await registerScheduleRoutes(app, context);
  await registerTunarrRoutes(app, context);
  return app;
}
