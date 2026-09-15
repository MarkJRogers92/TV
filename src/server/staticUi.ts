import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serves the built UI from `root`, falling back to index.html for client-side
 * routes so a deep link survives a reload.
 *
 * Extracted from the server entrypoint so the security-relevant behaviour of
 * this configuration -- path containment, and which requests reach the SPA
 * fallback instead of a JSON 404 -- can be asserted directly. The entrypoint
 * cannot be imported from a test because it listens on a real port at module
 * scope, so keeping the registration here is what makes it testable at all.
 *
 * `@fastify/static` is registered only when the app is not running in dev mode,
 * which means the whole plugin sits outside the unit-test boundary otherwise.
 */
export async function registerStaticUi(
  app: FastifyInstance,
  root: string,
): Promise<void> {
  await app.register(fastifyStatic, { root, prefix: "/" });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ code: "NOT_FOUND" })
      : reply.sendFile("index.html"),
  );
}
