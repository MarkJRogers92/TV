import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { channelSchema } from "../../domain/models.js";
import { validateChannelConfiguration } from "../../domain/validation.js";
import type { ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";
import {
  invalidateUnpublishedSchedules,
  ScheduleExportError,
} from "../scheduleService.js";
import { z } from "zod";
import { validateMediaRoot, MediaScanError } from "../../media/localFolder.js";
import { ensureMovieProgrammingPool } from "../../media/movieEnrollment.js";

const movieProgrammingControlSchema = z.object({
  enabled: z.boolean().optional(),
  poolIds: z.array(z.string().min(1)).optional(),
  rootPath: z.string().min(1).optional(),
  nightlyAnchor: z.string().optional(),
  weekendAnchor: z.string().optional(),
  bridgePoolIds: z.array(z.string().min(1)).optional(),
  lookaheadDays: z.number().int().optional(),
  weekendOpenerEncoreEnabled: z.boolean().optional(),
  breakPolicy: z
    .object({
      targetMinutes: z.number().positive().optional(),
      maxMinutes: z.number().positive().optional(),
      protectionMinutes: z.number().nonnegative().optional(),
      shortMaxMinutes: z.number().positive().optional(),
    })
    .optional(),
});

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
      const previous = repositories.channels.get(channel.id);
      const issues = validate(channel);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      repositories.transaction(() => {
        repositories.channels.put(channel);
        // A channel document carries the movie configuration too, so an edit that
        // reaches it here invalidates the same unpublished future days the
        // dedicated control does. Today's schedule is left alone.
        if (
          JSON.stringify(previous?.movieProgramming ?? null) !==
          JSON.stringify(channel.movieProgramming ?? null)
        )
          invalidateUnpublishedSchedules(repositories, channel, context.now());
      });
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
  /**
   * The movie-programming control and its status.
   *
   * The feature is off unless a channel says otherwise, so this route is the only
   * thing an operator needs to touch to turn it on, and the GET half reports what
   * it would do - the configured folder, how many films the rotation holds, what
   * is coming up, and anything degraded - without generating a schedule.
   */
  app.get("/api/v1/channels/:id/movie-programming", async (request, reply) => {
    const channel = repositories.channels.get(
      (request.params as { id: string }).id,
    );
    if (!channel) return notFound(reply, "Channel");
    const rootPath = channel.movieProgramming?.rootPath;
    let rootAvailable = true;
    const degraded: string[] = [];
    if (rootPath) {
      try {
        await validateMediaRoot(rootPath);
      } catch (error) {
        rootAvailable = false;
        degraded.push(
          error instanceof MediaScanError
            ? `${error.code}: ${error.message}`
            : `The movie folder ${rootPath} could not be checked`,
        );
      }
    }
    const preview = await context.schedules.movieProgrammingPreview(
      channel,
      context.now(),
      async () => rootAvailable,
    );
    return {
      channelId: channel.id,
      ...preview,
      degraded: [
        ...(("degraded" in preview ? preview.degraded : []) ?? []),
        ...degraded,
      ],
    };
  });
  app.put("/api/v1/channels/:id/movie-programming", async (request, reply) => {
    const channel = repositories.channels.get(
      (request.params as { id: string }).id,
    );
    if (!channel) return notFound(reply, "Channel");
    try {
      const control = movieProgrammingControlSchema.parse(request.body ?? {});
      const enabled =
        control.enabled ?? channel.movieProgramming?.enabled ?? false;
      const merged = channelSchema.parse({
        ...channel,
        movieProgramming: {
          ...(channel.movieProgramming ?? {}),
          ...control,
          // Stamp the instant the feature is switched on. A first run that starts
          // on a Sunday or Monday has no earlier weekend opener of its own, and
          // this is what tells the scheduler not to invent one.
          ...(enabled && channel.movieProgramming?.enabled !== true
            ? { activatedAt: context.now().toISOString() }
            : {}),
          breakPolicy: {
            ...(channel.movieProgramming?.breakPolicy ?? {}),
            ...(control.breakPolicy ?? {}),
          },
        },
      });
      // Anything already broadcast is history. Anything planned for a later day
      // was planned from the configuration being replaced, so it is dropped and
      // rebuilt instead of airing the old lineup.
      const changed =
        JSON.stringify(channel.movieProgramming ?? null) !==
        JSON.stringify(merged.movieProgramming ?? null);
      if (merged.movieProgramming?.enabled !== true) {
        // Turning the feature off is a plain configuration write: it must not
        // depend on the movie pools or the folder still being reachable.
        repositories.transaction(() => {
          repositories.channels.put(merged);
          if (changed)
            invalidateUnpublishedSchedules(repositories, merged, context.now());
        });
        return merged;
      }
      // Enabling asks the configured pools to exist, so the operator does not have
      // to hand-build a pool from the library first. The write is a union and
      // idempotent; if the rest of the configuration is refused below, the pool
      // remains a harmless empty container.
      ensureMovieProgrammingPool(repositories, merged);
      const issues = validate(merged);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      repositories.transaction(() => {
        repositories.channels.put(merged);
        if (changed)
          invalidateUnpublishedSchedules(repositories, merged, context.now());
      });
      return merged;
    } catch (error) {
      return validationError(reply, error);
    }
  });
  app.get("/api/v1/channels/:id/air", async (request, reply) => {
    const channel = repositories.channels.get(
      (request.params as { id: string }).id,
    );
    if (!channel) return notFound(reply, "Channel");
    // Read BY DATE. `latest` is insertion order, and the quiet-hours pass stores
    // TOMORROW's schedule, so asking it what is on the air reports the wrong
    // day's lineup - and would not generate today's at all, because a schedule
    // for some other date looks like one already exists.
    const today = DateTime.fromJSDate(context.now(), {
      zone: channel.timezone,
    }).toISODate()!;
    let schedule = repositories.schedules.latestForDate(channel.id, today);
    if (!schedule) {
      try {
        const result = await context.schedules.ensure(channel, today);
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
