/**
 * Local diagnostic bundle (R17 / OP06).
 *
 * A single read-only snapshot a human can save when something looks wrong:
 * runtime facts, per-channel air state and incidents, preparation backlog, the
 * media roots and their free space, and scheduler coverage.
 *
 * R17/OP06 require the export to be LOCAL and redacted before any sharing. Two
 * things enforce that: nothing here uploads or contacts a network, and the whole
 * bundle is passed through `redactSensitive`, so any credential-shaped value
 * (a token in a URL, an API key) is redacted even if it reaches a field this
 * module does not know about.
 */
import type { Repositories } from "../db/repositories.js";
import { redactSensitive } from "../security/redaction.js";
import { autopilotStatus } from "./status.js";

export type DiagnosticBundle = {
  generatedAt: string;
  runtime: { platform: string; arch: string; node: string };
  status: Awaited<ReturnType<typeof autopilotStatus>>;
  /** Latest playout readings, when the observer is running. */
  playout?: unknown;
  /** The recent alert tail - what you were told, and when. */
  alerts?: unknown;
};

export async function diagnosticBundle(
  repositories: Repositories,
  now: Date,
  extras: { playout?: unknown; alerts?: unknown } = {},
): Promise<DiagnosticBundle> {
  const status = await autopilotStatus(repositories, now);
  const bundle: DiagnosticBundle = {
    generatedAt: now.toISOString(),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    status,
    // Added BEFORE redaction on purpose: these are assembled from observations
    // and alert text, and the bundle's one guarantee is that whatever it holds
    // has been through `redactSensitive`.
    ...extras,
  };
  // Defence in depth: redact anything credential-shaped before it leaves the host.
  return redactSensitive(bundle) as DiagnosticBundle;
}
