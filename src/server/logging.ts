/**
 * The app's only logging seam.
 *
 * MarkTV runs Fastify with `logger: false` and had no logging of its own at all.
 * Combined with background loops that discard their errors, that made every
 * unattended failure invisible: the acquisition poll timer and the job loop both
 * ran `void work().catch(() => undefined)`, so a persistent fault - an unreadable
 * database, a provider that keeps failing - left the service answering requests
 * normally while it had silently stopped polling and downloading. There was
 * nothing to notice it by.
 *
 * This is deliberately minimal: one structured line per event on stderr, no new
 * dependency, and no logging framework. It exists to make background failures
 * observable, not to become a general-purpose logger.
 */

export const errorLog = {
  /**
   * Mutable so tests can capture output rather than write to stderr, matching the
   * `watchProxyLimits` / `tunarrClientLimits` convention used elsewhere.
   */
  sink: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

export function logError(
  scope: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const record = {
    at: new Date().toISOString(),
    level: "error" as const,
    scope,
    message,
    ...context,
  };
  try {
    errorLog.sink(JSON.stringify(record));
  } catch {
    // Swallowed on purpose. This runs inside catch blocks that are reporting an
    // error, so throwing here would replace the real failure with a logging
    // failure - in the one place where that is least recoverable.
  }
}
