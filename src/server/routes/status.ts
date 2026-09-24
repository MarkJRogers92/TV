import type { FastifyInstance } from "fastify";
import { autopilotStatus } from "../../autopilot/status.js";
import { diagnosticBundle } from "../../autopilot/diagnostics.js";
import type { ServerContext } from "../context.js";

/**
 * Read-only autopilot state. Deliberately a plain GET with no side effects: the
 * dashboard and a human debugging a channel must be able to look without
 * perturbing scheduling, preparation, or playback.
 */
export async function registerStatusRoutes(app: FastifyInstance, context: ServerContext) {
  app.get("/api/v1/autopilot/status", async () =>
    autopilotStatus(context.repositories, context.now()),
  );
  // Local, redacted diagnostic export (R17/OP06). Nothing is uploaded; the
  // bundle is returned to the caller only.
  app.get("/api/v1/diagnostics", async () =>
    diagnosticBundle(context.repositories, context.now()),
  );
}
