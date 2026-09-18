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
 * dependency, and no logging framework. It exists to make background conditions
 * observable, not to become a general-purpose logger.
 */

export const logSink = {
  /**
   * Mutable so tests can capture output rather than write to stderr, matching the
   * `watchProxyLimits` / `tunarrClientLimits` convention used elsewhere.
   */
  sink: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

function writeRecord(
  level: "error" | "warn" | "info",
  scope: string,
  message: string,
  context: Record<string, unknown>,
) {
  const record = {
    at: new Date().toISOString(),
    level,
    scope,
    message,
    ...context,
  };
  try {
    logSink.sink(JSON.stringify(record));
  } catch {
    // Swallowed on purpose. This runs inside catch blocks that are reporting an
    // error, so throwing here would replace the real failure with a logging
    // failure - in the one place where that is least recoverable.
  }
}

export function logError(
  scope: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  writeRecord(
    "error",
    scope,
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    context,
  );
}

/**
 * For conditions that are not failures yet but become them if ignored - low disk
 * space being the motivating case. Separate from `logError` so a reader can tell
 * "this is broken" apart from "this is heading somewhere bad".
 */
export function logWarn(
  scope: string,
  message: string,
  context: Record<string, unknown> = {},
) {
  writeRecord("warn", scope, message, context);
}

/**
 * For things that worked and are worth being able to reconstruct later - a
 * schedule generating itself being the motivating case, since the whole point is
 * that nobody triggered it and so nobody would otherwise know when it happened.
 */
export function logInfo(
  scope: string,
  message: string,
  context: Record<string, unknown> = {},
) {
  writeRecord("info", scope, message, context);
}
