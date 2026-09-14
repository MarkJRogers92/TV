import type { FastifyReply } from "fastify";
import { z } from "zod";

export function validationError(reply: FastifyReply, error: unknown) {
  const issues =
    error instanceof z.ZodError
      ? error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }))
      : typeof error === "object" && error !== null && "issues" in error
        ? (error as { issues: unknown }).issues
        : [];
  return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
}

export function notFound(reply: FastifyReply, resource: string) {
  return reply
    .code(404)
    .send({ code: "NOT_FOUND", message: `${resource} was not found` });
}
