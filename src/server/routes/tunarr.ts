import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { TunarrClient } from "../../integrations/tunarr/client.js";
import {
  buildTunarrSyncPlan,
} from "../../integrations/tunarr/plan.js";
import { syncTunarrPlan } from "../../integrations/tunarr/sync.js";
import {
  resolveLibraryIds,
  type TunarrMappingInput,
} from "../../integrations/tunarr/types.js";
import type { ServerContext } from "../context.js";
import {
  readTunarrMapping,
  TUNARR_MAPPING_SETTING,
  type StoredTunarrMapping,
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
type StoredMapping = StoredTunarrMapping;

function safeTunarrError(reply: FastifyReply, error: unknown, message: string) {
  const code =
    error instanceof z.ZodError
      ? "VALIDATION_ERROR"
      : ((error as { code?: string }).code ?? "TUNARR_ERROR");
  const status =
    code === "UNREACHABLE" ? 503 : code === "STALE_DRY_RUN" ? 409 : 422;
  return reply.code(status).send({ code, message });
}

export async function registerTunarrRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  app.get("/api/v1/tunarr/status", async () => {
    const stored = readTunarrMapping(context.repositories);
    if (!stored) return { configured: false };
    // Deliberately omits `plan`: it carries the whole 956-entry lineup.
    return {
      configured: true,
      url: stored.url,
      marktvChannelId: stored.marktvChannelId,
      channelId: stored.channelId ?? "",
      libraryIds: stored.libraryIds ?? (stored.libraryId ? [stored.libraryId] : []),
      autoSync: stored.autoSync !== false,
      hasPlan: Boolean(stored.plan),
      lastSync: stored.lastSync ?? null,
    };
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
      const schedule = context.repositories.schedules.latest(
        input.marktvChannelId,
      );
      if (!schedule)
        return reply.code(409).send({
          code: "NO_SCHEDULE",
          message: "Generate a MarkTV schedule before requesting a dry run",
        });
      const libraryIds = resolveLibraryIds(input);
      const mapping: TunarrMappingInput = {
        libraryId: libraryIds[0],
        libraryIds,
        channelId: input.channelId || undefined,
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
      );
      context.repositories.settings.put(TUNARR_MAPPING_SETTING, {
        ...mapping,
        url: input.url,
        marktvChannelId: input.marktvChannelId,
        plan,
      });
      return plan;
    } catch (error) {
      return safeTunarrError(
        reply,
        error,
        "Tunarr dry run could not be completed",
      );
    }
  });
  app.post("/api/v1/tunarr/sync", async (_request, reply) => {
    const stored = context.repositories.settings.get(TUNARR_MAPPING_SETTING)
      ?.value as StoredMapping | undefined;
    if (!stored?.plan || !stored.url)
      return reply.code(409).send({ code: "STALE_DRY_RUN" });
    try {
      const schedule = context.repositories.schedules.latest(
        stored.marktvChannelId,
      );
      if (!schedule)
        return reply.code(409).send({
          code: "STALE_DRY_RUN",
          message: "No current MarkTV schedule is available",
        });
      const result = await syncTunarrPlan(
        new TunarrClient(stored.url),
        stored.plan,
        schedule,
      );
      // Re-read rather than writing back the snapshot taken before the network
      // work. A dry run that completed while this was in flight may have stored a
      // newer plan, and spreading the stale copy would silently discard it. Only
      // the plan actually consumed here is cleared.
      const current = context.repositories.settings.get(TUNARR_MAPPING_SETTING)
        ?.value as StoredMapping | undefined;
      context.repositories.settings.put(TUNARR_MAPPING_SETTING, {
        ...(current ?? stored),
        ...result.state,
        plan: current?.plan === stored.plan ? undefined : current?.plan,
      });
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
