import type { FastifyInstance } from "fastify";
import { autopilotStatus } from "../../autopilot/status.js";
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
}
