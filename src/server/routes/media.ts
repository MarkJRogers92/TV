import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mediaSchema } from "../../domain/models.js";
import { validatePoolRecords } from "../../domain/validation.js";
import {
  LocalFolderAdapter,
  MediaScanError,
  validateMediaRoot,
} from "../../media/localFolder.js";
import {
  getMediaRoot,
  listMediaRoots,
  mediaRootId,
  putMediaRoot,
  removeMediaRoot,
} from "../../media/roots.js";
import { assertManagedDirectory, captureManagedDirectory } from "../../acquisition/paths.js";
import type { MediaRootRecord, ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";

const rootSchema = z.object({ path: z.string().min(1) });
function scanError(
  reply: Parameters<typeof validationError>[0],
  error: unknown,
) {
  if (error instanceof MediaScanError)
    return reply.code(422).send({ code: error.code, message: error.message });
  return validationError(reply, error);
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  const { repositories } = context;
  app.get("/api/v1/media", async () => repositories.media.list());
  app.put("/api/v1/media/:id", async (request, reply) => {
    try {
      const item = mediaSchema.parse(request.body);
      if (item.id !== (request.params as { id: string }).id)
        return reply.code(400).send({ code: "ID_MISMATCH" });
      const issues = validatePoolRecords(repositories.pools.list(), [
        ...repositories.media
          .list()
          .filter((existing) => existing.id !== item.id),
        item,
      ]);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      repositories.media.put(item);
      return item;
    } catch (error) {
      return validationError(reply, error);
    }
  });
  app.delete("/api/v1/media/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!repositories.media.get(id)) return notFound(reply, "Media item");
    if (repositories.pools.list().some((pool) => pool.mediaIds.includes(id)))
      return reply.code(409).send({ code: "MEDIA_IN_USE" });
    repositories.media.remove(id);
    return reply.code(204).send();
  });

  app.get("/api/v1/media/roots", async () => listMediaRoots(repositories));
  app.post("/api/v1/media/roots", async (request, reply) => {
    try {
      const { path } = rootSchema.parse(request.body);
      const resolved = await validateMediaRoot(path);
      const root: MediaRootRecord = {
        id: mediaRootId(resolved),
        path: resolved,
        lastScannedAt: null,
        diagnostics: [],
        directoryIdentity: await captureManagedDirectory(resolved),
      };
      putMediaRoot(repositories, root);
      return reply.code(201).send(root);
    } catch (error) {
      return scanError(reply, error);
    }
  });
  app.delete("/api/v1/media/roots/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!removeMediaRoot(repositories, id))
      return notFound(reply, "Media root");
    return reply.code(204).send();
  });
  app.post("/api/v1/media/roots/:id/scan", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const stored = getMediaRoot(repositories, id);
    if (!stored) return notFound(reply, "Media root");
    try {
      const identity = stored.directoryIdentity ?? await captureManagedDirectory(stored.path);
      await assertManagedDirectory(identity);
      const result = await new LocalFolderAdapter(undefined, identity).scan(stored.path);
      await assertManagedDirectory(identity);
      const root = {
        ...stored,
        directoryIdentity: identity,
        lastScannedAt: context.now().toISOString(),
        diagnostics: result.diagnostics,
      };
      repositories.transaction(() => {
        result.items.forEach((item) => repositories.media.put(item));
        putMediaRoot(repositories, root);
      });
      return { root, result };
    } catch (error) {
      return scanError(reply, error);
    }
  });
  app.post("/api/v1/media/scan", async (request, reply) => {
    try {
      const { path } = rootSchema.parse({
        path: (request.body as { root?: unknown } | undefined)?.root,
      });
      const result = await new LocalFolderAdapter().scan(path);
      result.items.forEach((item) => repositories.media.put(item));
      return result;
    } catch (error) {
      return scanError(reply, error);
    }
  });
}
