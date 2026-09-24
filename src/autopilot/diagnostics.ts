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
};

export async function diagnosticBundle(
  repositories: Repositories,
  now: Date,
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
  };
  // Defence in depth: redact anything credential-shaped before it leaves the host.
  return redactSensitive(bundle) as DiagnosticBundle;
}
