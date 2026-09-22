import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mediaSchema, scheduleScopedContinuityTag } from "../../domain/models.js";
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
  mediaRootOwner,
  putMediaRoot,
  removeMediaRoot,
} from "../../media/roots.js";
import {
  assertManagedDirectory,
  captureManagedDirectory,
  unpinManagedDirectory,
} from "../../acquisition/paths.js";
import type { MediaRootRecord, ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";
import { reconcileMovieProgramming } from "../../media/movieEnrollment.js";

const rootSchema = z.object({ path: z.string().min(1) });
function scanError(
  reply: Parameters<typeof validationError>[0],
  error: unknown,
) {
  if (error instanceof MediaScanError)
    return reply.code(422).send({ code: error.code, message: error.message });
  return validationError(reply, error);
}

/**
 * Persist scanned items without discarding a manually-assigned `kind`.
 *
 * The scanner can only ever derive `episode` or `movie` from the path
 * (`src/media/localFolder.ts`), while `bumper`, `station-id` and `commercial`
 * are assigned through the API. Re-putting a scanned item verbatim therefore
 * resets those back to `episode`, which silently empties the pools that
 * reference them — and because `validatePoolRecords` is global, it also rejects
 * every subsequent pool write. A scan owns the path-derived fields; it does not
 * own `kind`, so an existing value wins.
 */
function persistScanned(
  repositories: ServerContext["repositories"],
  items: Awaited<ReturnType<LocalFolderAdapter["scan"]>>["items"],
) {
  /**
   * Generated continuity cards are ordinary video files inside a mapped root,
   * so a library scan will rediscover them. They must not be re-registered: the
   * scanner can only derive `episode`/`movie` from a path and knows nothing
   * about the schedule binding, so a second, untagged catalog entry would strip
   * the generated marker and let the same file be drawn as ordinary filler (or
   * reclassified) on some other day. The registered card owns its path.
   */
  const generatedPaths = new Set(
    repositories.media
      .list()
      .filter((item) => item.tags.includes(scheduleScopedContinuityTag))
      .flatMap((item) => (item.path ? [item.path] : [])),
  );
  for (const item of items) {
    // Also exclude an orphaned render whose registration failed or was removed.
    if (item.path?.replaceAll("\\", "/").includes("/generated/continuity/")) continue;
    if (item.path && generatedPaths.has(item.path)) continue;
    const existing = repositories.media.get(item.id);
    repositories.media.put(existing ? { ...item, kind: existing.kind } : item);
  }
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
      const id = mediaRootId(resolved);
      const root: MediaRootRecord = {
        id,
        path: resolved,
        lastScannedAt: null,
        diagnostics: [],
        directoryIdentity: await captureManagedDirectory(resolved, { pin: mediaRootOwner(id) }),
      };
      putMediaRoot(repositories, root);
      return reply.code(201).send(root);
    } catch (error) {
      return scanError(reply, error);
    }
  });
  app.delete("/api/v1/media/roots/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const stored = getMediaRoot(repositories, id);
    if (!stored || !removeMediaRoot(repositories, id))
      return notFound(reply, "Media root");
    // Releases only this root's pin; the managed library holds its own, so
    // deleting the root registered for it cannot unpin acquisition.
    await unpinManagedDirectory(stored.directoryIdentity?.path ?? stored.path, mediaRootOwner(id));
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
        persistScanned(repositories, result.items);
        putMediaRoot(repositories, root);
        // A scan is one of the two moments the set of films can have changed, so
        // the movie pools are swept here; the write is a union and idempotent.
        reconcileMovieProgramming(repositories);
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
      persistScanned(repositories, result.items);
      reconcileMovieProgramming(repositories);
      return result;
    } catch (error) {
      return scanError(reply, error);
    }
  });
}
