import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { channelSchema } from "../../domain/models.js";
import { validateChannelConfiguration } from "../../domain/validation.js";
import type { ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";
import { ScheduleExportError } from "../scheduleService.js";

export async function registerChannelRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  const { repositories } = context;
  const validate = (channel: ReturnType<typeof channelSchema.parse>) =>
    validateChannelConfiguration(
      channel,
      repositories.pools.list(),
      repositories.media.list(),
    );

  app.get("/api/v1/channels", async () => repositories.channels.list());
  app.get("/api/v1/channels/:id", async (request, reply) => {
    const channel = repositories.channels.get(
      (request.params as { id: string }).id,
    );
    return channel ?? notFound(reply, "Channel");
  });
  app.post("/api/v1/channels", async (request, reply) => {
    try {
      const channel = channelSchema.parse(request.body);
      if (repositories.channels.get(channel.id))
        return reply.code(409).send({ code: "ALREADY_EXISTS" });
      const issues = validate(channel);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      repositories.channels.put(channel);
      return reply.code(201).send(channel);
    } catch (error) {
      return validationError(reply, error);
    }
  });
  app.put("/api/v1/channels/:id", async (request, reply) => {
    try {
      const channel = channelSchema.parse(request.body);
      if (channel.id !== (request.params as { id: string }).id)
        return reply.code(400).send({ code: "ID_MISMATCH" });
      const issues = validate(channel);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      repositories.channels.put(channel);
      return channel;
    } catch (error) {
      return validationError(reply, error);
    }
  });
  app.delete("/api/v1/channels/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!repositories.channels.get(id)) return notFound(reply, "Channel");
    repositories.channels.remove(id);
    return reply.code(204).send();
  });
  app.get("/api/v1/channels/:id/air", async (request, reply) => {
    const channel = repositories.channels.get(
      (request.params as { id: string }).id,
    );
    if (!channel) return notFound(reply, "Channel");
    let schedule = repositories.schedules.latest(channel.id);
    if (!schedule) {
      try {
        const result = await context.schedules.ensure(
          channel,
          DateTime.fromJSDate(context.now(), {
            zone: channel.timezone,
          }).toISODate()!,
        );
        if (result.ok === false)
          return reply
            .code(422)
            .send({ code: "VALIDATION_ERROR", issues: result.issues });
        schedule = result.schedule;
      } catch (error) {
        if (error instanceof ScheduleExportError)
          return reply
            .code(500)
            .send({ code: error.code, message: error.message });
        return validationError(reply, error);
      }
    }
    const now = context.now();
    const instant = now.toISOString();
    const index =
      schedule?.entries.findIndex(
        (entry) => entry.start <= instant && entry.end > instant,
      ) ?? -1;
    return {
      channel: {
        id: channel.id,
        name: channel.name,
        number: channel.number,
        timezone: channel.timezone,
      },
      currentTime: DateTime.fromJSDate(now, { zone: channel.timezone }).toISO(),
      nowPlaying:
        index >= 0 ? schedule!.entries[index] : (schedule?.entries[0] ?? null),
      upNext:
        index >= 0
          ? (schedule!.entries[index + 1] ?? null)
          : (schedule?.entries[1] ?? null),
      scheduleStatus: "Preview only",
    };
  });
}
