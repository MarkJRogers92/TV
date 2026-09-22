import type { FastifyInstance, FastifyReply } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { TunarrClient } from "../../integrations/tunarr/client.js";
import { buildTunarrSyncPlan } from "../../integrations/tunarr/plan.js";
import { syncTunarrPlan } from "../../integrations/tunarr/sync.js";
import {
  resolveLibraryIds,
  type TunarrMappingInput,
} from "../../integrations/tunarr/types.js";
import type { ServerContext } from "../context.js";
import {
  readTunarrMapping,
  readTunarrMappingForChannel,
  readTunarrMappings,
  type StoredTunarrMapping,
  upsertTunarrMapping,
} from "../tunarrAutoSync.js";

const testSchema = z.object({
  url: z.string().url(),
  channelId: z.string().default(""),
  libraryId: z.string().default(""),
  libraryIds: z.array(z.string()).optional(),
});
const dryRunSchema = z
  .object({
    url: z.string().url(),
    channelId: z.string().default(""),
    libraryId: z.string().optional(),
    libraryIds: z.array(z.string()).optional(),
    marktvChannelId: z.string().min(1).default("marktv-laughs"),
    createChannel: z.boolean().default(false),
    transcodeConfigId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!resolveLibraryIds(value).length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one library ID is required",
        path: ["libraryIds"],
      });
    }
  });
const statusQuerySchema = z.object({
  marktvChannelId: z.string().min(1).optional(),
});
const syncSchema = z.object({
  marktvChannelId: z.string().min(1).optional(),
});
type StoredMapping = StoredTunarrMapping;

function safeTunarrError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string,
) {
  const code =
    error instanceof z.ZodError
      ? "VALIDATION_ERROR"
      : ((error as { code?: string }).code ?? "TUNARR_ERROR");
  const status =
    code === "UNREACHABLE"
      ? 503
      : code === "STALE_DRY_RUN" || code === "ACTIVE_VIEWERS"
        ? 409
        : 422;
  return reply.code(status).send({
    code,
    message:
      code === "ACTIVE_VIEWERS"
        ? "The Tunarr channel has active viewers; try again after playback stops"
        : fallbackMessage,
  });
}

export async function registerTunarrRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  app.get("/api/v1/tunarr/status", async (request) => {
    const query = statusQuerySchema.parse(request.query);
    const mappings = readTunarrMappings(context.repositories);
    const stored = query.marktvChannelId
      ? readTunarrMappingForChannel(
          context.repositories,
          query.marktvChannelId,
        )
      : readTunarrMapping(context.repositories);
    if (!stored)
      return query.marktvChannelId
        ? { configured: false }
        : { configured: false, mappings: [] };
    // Deliberately omits `plan`: it carries the whole 956-entry lineup.
    const projection = {
      configured: true,
      url: stored.url,
      marktvChannelId: stored.marktvChannelId,
      channelId: stored.channelId ?? "",
      libraryIds:
        stored.libraryIds ?? (stored.libraryId ? [stored.libraryId] : []),
      autoSync: stored.autoSync !== false,
      hasPlan: Boolean(stored.plan),
      lastSync: stored.lastSync ?? null,
    };
    return query.marktvChannelId
      ? projection
      : { ...projection, mappings: mappings.map((mapping) => ({
          configured: true,
          url: mapping.url,
          marktvChannelId: mapping.marktvChannelId,
          channelId: mapping.channelId ?? "",
          libraryIds:
            mapping.libraryIds ??
            (mapping.libraryId ? [mapping.libraryId] : []),
          autoSync: mapping.autoSync !== false,
          hasPlan: Boolean(mapping.plan),
          lastSync: mapping.lastSync ?? null,
        })) };
  });
  app.post("/api/v1/tunarr/test", async (request, reply) => {
    try {
      const input = testSchema.parse(request.body);
      return await new TunarrClient(input.url).detect(
        input.channelId,
        resolveLibraryIds(input),
      );
    } catch (error) {
      return safeTunarrError(
        reply,
        error,
        "Tunarr connection could not be validated",
      );
    }
  });
  app.post("/api/v1/tunarr/dry-run", async (request, reply) => {
    try {
      const input = dryRunSchema.parse(request.body);
      const existing = readTunarrMappingForChannel(
        context.repositories,
        input.marktvChannelId,
      );
      // Resolve the channel, then ask for the schedule dated TODAY in that
      // channel's timezone. `latest` is insertion order, and the quiet-hours
      // pass writes tomorrow's schedule, so it would answer about the wrong day.
      const channel = context.repositories.channels.get(input.marktvChannelId);
      const today = channel
        ? DateTime.fromJSDate(context.now(), {
            zone: channel.timezone,
          }).toISODate()
        : null;
      const schedule = today
        ? context.repositories.schedules.latestForDate(channel!.id, today)
        : undefined;
      if (!schedule)
        return reply.code(409).send({
          code: "NO_SCHEDULE",
          message:
            "Generate a MarkTV schedule for today before requesting a dry run",
        });
      const libraryIds = resolveLibraryIds(input);
      const mapping: TunarrMappingInput = {
        ...(existing?.preserveExistingLineup ? { preserveExistingLineup: true } : {}),
        libraryId: libraryIds[0],
        libraryIds,
        channelId: input.channelId || undefined,
        // Reuse the filler list this channel already owns instead of dropping
        // the id and creating a duplicate on the next sync.
        fillerListId: existing?.fillerListId,
        createChannel: input.createChannel,
        transcodeConfigId: input.transcodeConfigId || undefined,
      };
      const client = new TunarrClient(input.url);
      const remote = await client.snapshot(mapping);
      const plan = buildTunarrSyncPlan(
        schedule,
        remote.inventory,
        remote.capabilities,
        mapping,
        remote.snapshots,
        context.repositories.media.list(),
      );
      // Preserve stored state this dry run is not replacing (lastSync,
      // autoSync, fillerListId). Spread the mapping first, then remove the
      // optional keys the user actually cleared, so a preserved value is never
      // overwritten by `undefined`.
      const stored: StoredMapping = {
        ...(existing ?? {}),
        ...mapping,
        url: input.url,
        marktvChannelId: input.marktvChannelId,
        plan,
      };
      if (!mapping.channelId) delete stored.channelId;
      if (!mapping.fillerListId) delete stored.fillerListId;
      if (!mapping.transcodeConfigId) delete stored.transcodeConfigId;
      upsertTunarrMapping(context.repositories, stored);
      return plan;
    } catch (error) {
      return safeTunarrError(
        reply,
        error,
        "Tunarr dry run could not be completed",
      );
    }
  });
  app.post("/api/v1/tunarr/sync", async (request, reply) => {
    try {
      const input = syncSchema.parse(request.body ?? {});
      const stored = readTunarrMappingForChannel(
        context.repositories,
        input.marktvChannelId ?? "marktv-laughs",
      );
      if (!stored?.plan || !stored.url)
        return reply.code(409).send({ code: "STALE_DRY_RUN" });
      // Apply exactly the schedule the dry run validated, even if tomorrow's
      // schedule was inserted afterwards and is now the newest row.
      const schedule = context.repositories.schedules.byId(
        stored.marktvChannelId,
        stored.plan.scheduleSnapshot.id,
      );
      if (!schedule)
        return reply.code(409).send({
          code: "STALE_DRY_RUN",
          message:
            "The schedule this dry run captured is no longer available; run a new dry run",
        });
      const result = await syncTunarrPlan(
        new TunarrClient(stored.url),
        stored.plan,
        schedule,
        context.repositories.media.list(),
      );
      // Re-read rather than writing back the snapshot taken before the network
      // work. A dry run that completed while this was in flight may have stored a
      // newer plan, and spreading the stale copy would silently discard it. Only
      // the plan actually consumed here is cleared.
      const current = readTunarrMappingForChannel(
        context.repositories,
        stored.marktvChannelId,
      );
      const next: StoredMapping = {
        ...(current ?? stored),
        ...result.state,
      };
      if (result.state.channelId) next.createChannel = false;
      if (current?.plan?.fingerprint === stored.plan.fingerprint)
        delete next.plan;
      else if (current?.plan) next.plan = current.plan;
      else delete next.plan;
      upsertTunarrMapping(context.repositories, next);
      if (result.partialFailure) return reply.code(502).send(result);
      return result;
    } catch (error) {
      return safeTunarrError(
        reply,
        error,
        "Tunarr sync could not be completed",
      );
    }
  });
}
