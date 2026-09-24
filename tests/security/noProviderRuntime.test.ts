import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

/*
 * OP10 — "No LLM/provider call or new cloud runtime dependency."
 *
 * The operand here is the runtime dependency SURFACE, pinned as an exact set
 * rather than filtered against a list of provider names. A deny-list only
 * catches providers somebody thought of; pinning the set means ANY new runtime
 * dependency fails this test and has to be justified against OP10, whether it
 * is a model SDK, a cloud client, or a telemetry agent.
 *
 * MarkTV is a local application: it schedules, prepares and serves its own media
 * from local storage. The absence of a provider or cloud runtime is therefore a
 * design property worth defending, not an accident - OP06 (local, redacted
 * export) and the single-loopback-listener guard in tests/server/localOnly cover
 * the other two edges of the same claim.
 */

/** The complete runtime dependency surface. Adding one is a review decision. */
const RUNTIME_DEPENDENCIES = [
  "@fastify/static",
  "better-sqlite3",
  "fastify",
  "hls.js",
  "luxon",
  "react",
  "react-dom",
  "zod",
];

test("[OP10] the runtime dependency surface is pinned, so no provider or cloud SDK can be added silently", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
    RUNTIME_DEPENDENCIES,
  );
});

test("[OP10] no dependency comes from a model provider or a cloud runtime vendor", async () => {
  // The set above is the full runtime surface, so this cannot catch an addition -
  // the pinned-set test does that. What this adds is an explicit rejection of the
  // two families OP10 names, across devDependencies too: a provider SDK or a cloud
  // runtime client must not appear anywhere in the manifest, not even as tooling.
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const providerOrCloud = /^(openai|@?anthropic|@google-cloud\/|@google\/generative|aws-sdk|@aws-sdk\/|@azure\/|@mistralai\/|cohere-ai|langchain|@langchain\/|ollama)/i;
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ].filter((name) => providerOrCloud.test(name));

  expect(names).toEqual([]);
});
