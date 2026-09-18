import { logError } from "./logging.js";

type GuardTarget = {
  on(event: string, listener: (payload: unknown) => void): unknown;
  exit(code?: number): void;
};

/**
 * Last-resort reporting for anything that escaped every other handler.
 *
 * The two events are treated differently on purpose:
 *
 * - `unhandledRejection` is logged and the process continues. Node would
 *   otherwise crash on it, and crashing an unattended service over one rejected
 *   promise is a worse outcome than staying up with the failure recorded. This
 *   matters because the rejection is usually a bug in one code path, not evidence
 *   that the process is unsound.
 * - `uncaughtException` is logged and the process EXITS. After one of these the
 *   runtime state is not trustworthy, so the honest options are a clean restart
 *   or running on with unknown state. Under launchd (`KeepAlive` with a
 *   `ThrottleInterval`) a restart costs about ten seconds, which is cheap next to
 *   serving from a corrupted process.
 *
 * Injectable so the behaviour is testable - `index.ts` has top-level side effects
 * and cannot be unit-tested, so guards living there would be unverified code.
 */
export function installProcessGuards(target: GuardTarget = process) {
  target.on("unhandledRejection", (reason: unknown) => {
    logError("process.unhandledRejection", reason);
  });

  target.on("uncaughtException", (error: unknown) => {
    logError("process.uncaughtException", error);
    target.exit(1);
  });
}
