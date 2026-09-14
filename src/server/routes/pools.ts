import type { FastifyInstance } from "fastify";
import { poolSchema } from "../../domain/models.js";
import { validatePoolRecords } from "../../domain/validation.js";
import type { ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";

export async function registerPoolRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  const { pools } = context.repositories;
  const validate = (candidate: ReturnType<typeof poolSchema.parse>) =>
    validatePoolRecords(
      [...pools.list().filter((pool) => pool.id !== candidate.id), candidate],
      context.repositories.media.list(),
    );
  app.get("/api/v1/pools", async () => pools.list());
  app.post("/api/v1/pools", async (request, reply) => {
    try {
      const pool = poolSchema.parse(request.body);
      if (pools.get(pool.id))
        return reply.code(409).send({ code: "ALREADY_EXISTS" });
      const issues = validate(pool);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      pools.put(pool);
      return reply.code(201).send(pool);
    } catch (error) {
      return validationError(reply, error);
    }
  });
  app.put("/api/v1/pools/:id", async (request, reply) => {
    try {
      const pool = poolSchema.parse(request.body);
      if (pool.id !== (request.params as { id: string }).id)
        return reply.code(400).send({ code: "ID_MISMATCH" });
      const issues = validate(pool);
      if (issues.length)
        return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
      pools.put(pool);
      return pool;
    } catch (error) {
      return validationError(reply, error);
    }
  });
  app.delete("/api/v1/pools/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!pools.get(id)) return notFound(reply, "Pool");
    const referenced = context.repositories.channels
      .list()
      .some(
        (channel) =>
          channel.slots.some((slot) =>
            [...slot.poolIds, ...slot.fallbackPoolIds].includes(id),
          ) ||
          [
            ...channel.breakPolicy.poolIds,
            ...channel.breakPolicy.stationIdPoolIds,
          ].includes(id),
      );
    if (referenced)
      return reply.code(409).send({
        code: "POOL_IN_USE",
        issues: [
          {
            path: "poolId",
            message: `Pool ${id} is referenced by a channel`,
          },
        ],
      });
    pools.remove(id);
    return reply.code(204).send();
  });
}
