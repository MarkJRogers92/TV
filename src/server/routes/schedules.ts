import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { broadcastDateSchema } from "../../domain/models.js";
import type { ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";
import { ScheduleExportError } from "../scheduleService.js";
import { autoSyncTunarr } from "../tunarrAutoSync.js";

const generateSchema = z.object({
  channelId: z.string().min(1).default("marktv-laughs"),
  date: broadcastDateSchema.optional(),
});

export async function registerScheduleRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  const { repositories } = context;
  app.get("/api/v1/schedules/latest", async (request, reply) => {
    const query = request.query as { channelId?: string };
    const channelId = query.channelId ?? "marktv-laughs";
    if (!repositories.channels.get(channelId))
      return notFound(reply, "Channel");
    return repositories.schedules.latest(channelId) ?? null;
  });
  app.post("/api/v1/schedules/generate", async (request, reply) => {
    try {
      const input = generateSchema.parse(request.body ?? {});
      const channel = repositories.channels.get(input.channelId);
      if (!channel) return notFound(reply, "Channel");
      const date =
        input.date ??
        DateTime.fromJSDate(context.now(), {
          zone: channel.timezone,
        }).toISODate()!;
      const result = await context.schedules.generate(channel, date);
      if (result.ok === false) return reply.code(422).send(result);
      // A generated schedule is only audible once Tunarr has it. This runs the
      // same plan-and-apply path the Tunarr page uses, so an unmatched path
      // still refuses; it can never fail the generation itself.
      const tunarr = await autoSyncTunarr(repositories, {
        channelId: channel.id,
        // The schedule just generated, named explicitly: resolving "the newest"
        // would race the quiet-hours pre-generation, which can put tomorrow's
        // schedule in the table while this request is in flight.
        scheduleId: result.schedule.id,
        now: context.now,
      });
      return { schedule: result.schedule, exportPath: result.exportPath, tunarr };
    } catch (error) {
      if (error instanceof ScheduleExportError)
        return reply
          .code(500)
          .send({ code: error.code, message: error.message });
      return validationError(reply, error);
    }
  });
}
