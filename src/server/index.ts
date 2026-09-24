import { createServer } from "node:net";
import { join } from "node:path";
import { assertLoopbackHost, buildApp } from "./app.js";
import { logError } from "./logging.js";
import { installProcessGuards } from "./processGuards.js";
import { registerStaticUi } from "./staticUi.js";

const host = process.env.MARKTV_HOST ?? "127.0.0.1";
assertLoopbackHost(host);
const port = Number(process.env.MARKTV_PORT ?? 4177);

// Refuse to start a second instance. This must run before buildApp(), which
// opens — and migrates — the database: migration takes a write lock, so a
// duplicate launched while the first is live waits out the SQLite busy timeout
// and then dies with "database is locked", which names the wrong cause. The port
// is what is actually taken. Probing first fails fast, with a message that says
// what to do, and keeps the duplicate away from the database entirely.
//
// A guard, not a lock: app.listen below still owns exclusivity, and the port
// could in principle be taken between the probe and that bind.
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", (error: NodeJS.ErrnoException) => {
    reject(
      error.code === "EADDRINUSE"
        ? new Error(
            `Another process is already listening on ${host}:${port}; refusing to start a second MarkTV instance`,
          )
        : error,
    );
  });
  probe.once("listening", () => probe.close(() => resolve()));
  probe.listen({ host, port });
});

const app = await buildApp({
  // On for the real service. The restart-verification script spawns this entry
  // point with MARKTV_SCHEDULE_REFRESH=0, because a background generation would
  // otherwise replace the very schedule that script is asserting survives.
  scheduleRefresh: process.env.MARKTV_SCHEDULE_REFRESH !== "0",
  // Stage 3 preparation, on for the real service like the schedule refresh. The
  // restart-verification and e2e scripts set these to "0" so a background
  // scan/probe cannot perturb what they assert.
  preparationIntake: process.env.MARKTV_PREPARATION_INTAKE !== "0",
  preparationExecutor: process.env.MARKTV_PREPARATION_EXECUTOR !== "0",
  // Stage 4 observe-only watchdog. Off unless a streams root is configured, so it
  // is a deliberate opt-in rather than a default background load.
  healthShadow: Boolean(process.env.MARKTV_HEALTH_SHADOW_ROOT),
  healthShadowRoot: process.env.MARKTV_HEALTH_SHADOW_ROOT,
  // Acting is a separate, deliberate opt-in from observing.
  healthRecovery:
    Boolean(process.env.MARKTV_HEALTH_SHADOW_ROOT) &&
    process.env.MARKTV_HEALTH_RECOVERY === "1",
  // R01 always-on: start each channel's producer so it runs with no viewers.
  alwaysOn: process.env.MARKTV_ALWAYS_ON === "1",
  // SC06: record each finished pod's per-creative exposure from the channel's own
  // advertised playlist. On by default whenever a streams root is configured,
  // because it only reads playlist files and writes ledger rows - it cannot
  // perturb serving. Set MARKTV_POD_EXPOSURE=0 to switch it off.
  podExposure:
    Boolean(process.env.MARKTV_HEALTH_SHADOW_ROOT) &&
    process.env.MARKTV_POD_EXPOSURE !== "0",
  podExposureStreamsRoot: process.env.MARKTV_HEALTH_SHADOW_ROOT,
});
if (process.env.MARKTV_DEV !== "1") {
  await registerStaticUi(app, join(process.cwd(), "dist"));
}

await app.listen({ host, port });

let closing = false;
const close = async (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    // A failed shutdown must not itself become an unhandled rejection: the process
    // is on its way out, and the only useful thing left is to record why.
    logError("shutdown", error, { signal });
    process.exitCode = 1;
  }
};
// Wrapped rather than registered directly: `once` ignores the listener's return
// value, so an async listener would reject into nothing.
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

installProcessGuards();
