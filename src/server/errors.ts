import type { FastifyReply } from "fastify";
import { z } from "zod";
import { logError } from "./logging.js";

export function validationError(reply: FastifyReply, error: unknown) {
  const issues =
    error instanceof z.ZodError
      ? error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }))
      : typeof error === "object" && error !== null && "issues" in error
        ? (error as { issues: unknown }).issues
        : undefined;
  // Anything that is not a validation failure used to be reported as
  // `422 VALIDATION_ERROR` with an empty issue list, which asserted a validation
  // problem while hiding the real cause. A server fault is a 500.
  if (issues === undefined) {
    logError("request.validation", error);
    return reply
      .code(500)
      .send({ code: "INTERNAL_ERROR", message: "Unexpected server error" });
  }
  return reply.code(422).send({ code: "VALIDATION_ERROR", issues });
}

export function notFound(reply: FastifyReply, resource: string) {
  return reply
    .code(404)
    .send({ code: "NOT_FOUND", message: `${resource} was not found` });
}
