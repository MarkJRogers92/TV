import type { FastifyInstance } from "fastify";
import { continuityConfigUpdateSchema, continuityStatus, writeContinuityConfig } from "../../continuity/status.js";
import type { ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";

export async function registerContinuityRoutes(app: FastifyInstance, context: ServerContext) {
  const load = (channelId: string) =>
    continuityStatus({
      repositories: context.repositories,
      channelId,
      now: context.now(),
    });

  app.get("/api/v1/channels/:id/continuity", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const status = await load(id);
    return status ?? notFound(reply, "Channel");
  });

  app.put("/api/v1/channels/:id/continuity", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!context.repositories.channels.get(id)) return notFound(reply, "Channel");
    try {
      const patch = continuityConfigUpdateSchema.parse(request.body ?? {});
      // Staged interruptions stay behind their own playback-health gate; every
      // other control, including the director's on/off switch, is an ordinary
      // persisted setting.
      if (patch.stagedInterruptionsEnabled)
        return reply.code(409).send({
          code: "CONTINUITY_INTERRUPTION_NOT_READY",
          message: "Staged interruptions require a separate playback-health gate",
        });
      writeContinuityConfig(context.repositories, id, patch);
      return await load(id);
    } catch (error) {
      return validationError(reply, error);
    }
  });
}
