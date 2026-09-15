// @vitest-environment node

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { registerStaticUi } from "../../src/server/staticUi.js";

/**
 * `@fastify/static` is registered by the server entrypoint only when
 * `MARKTV_DEV !== "1"`, so none of this behaviour is reachable from the
 * ordinary unit tests. The package was upgraded specifically to pick up four
 * path-traversal and route-guard-bypass advisories, and nothing asserted the
 * result: a drift back to an unsafe configuration would have been silent.
 *
 * These tests drive the real application with the real registration, pointed at
 * a throwaway root so the served content is controlled here.
 *
 * Two delivery mechanisms are needed, and the split is deliberate.
 * `app.inject()` parses its `url` as a URL, so it removes literal dot segments
 * before the request exists -- `/../x` arrives as `/x`, which is a plain
 * request that cannot fail. Percent-encoded separators are not dot segments and
 * survive intact. The literal form is therefore sent over a raw socket, where
 * it arrives verbatim.
 */

const SENTINEL = "TOP-SECRET-SENTINEL";

const temporaryDirectories: string[] = [];
const startedApps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(startedApps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function servedApp({ listen = false, serveParent = false } = {}) {
  const parent = await temporaryDirectory("marktv-static-");
  const root = join(parent, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), '<!doctype html><div id="root"></div>');
  await writeFile(join(root, "assets", "app.js"), "console.log('served');");
  // Deliberately a sibling of the served root: reaching it requires escaping.
  await writeFile(join(parent, "outside-secret.txt"), SENTINEL);

  const app = await buildApp({
    dataDir: await temporaryDirectory("marktv-static-data-"),
  });
  await registerStaticUi(app, serveParent ? parent : root);
  startedApps.push(app);
  if (listen) {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) throw new Error("Could not determine the listening port.");
    return { app, root, parent, port };
  }
  return { app, root, parent, port: 0 };
}

/** Sends `path` verbatim, bypassing URL dot-segment removal. */
function rawGet(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("serves the built UI and its assets from the static root", async () => {
  const { app } = await servedApp();

  const home = await app.inject({ method: "GET", url: "/" });
  expect(home.statusCode).toBe(200);
  expect(home.body).toContain('<div id="root"></div>');

  // Positive control: the handler does serve real files from disk, so a
  // traversal succeeding below would genuinely have exposed the sentinel.
  const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
  expect(asset.statusCode).toBe(200);
  expect(asset.body).toContain("console.log('served')");
});

test("falls back to index.html for client routes but never for API paths", async () => {
  const { app } = await servedApp();

  const deepLink = await app.inject({ method: "GET", url: "/deep/client/route" });
  expect(deepLink.statusCode).toBe(200);
  expect(deepLink.body).toContain('<div id="root"></div>');

  const missingApi = await app.inject({
    method: "GET",
    url: "/api/v1/does-not-exist",
  });
  expect(missingApi.statusCode).toBe(404);
  expect(missingApi.json()).toEqual({ code: "NOT_FOUND" });
  expect(missingApi.body).not.toContain('<div id="root">');
});

test.each([
  "/%2e%2e%2foutside-secret.txt",
  "/..%2foutside-secret.txt",
  "/....//outside-secret.txt",
  "/%252e%252e%252foutside-secret.txt",
  "/%2e%2e%2f%2e%2e%2foutside-secret.txt",
])("never serves a file outside the static root via %s", async (url) => {
  const { app } = await servedApp();

  const response = await app.inject({ method: "GET", url });
  // Asserted on the body rather than the status: a blocked traversal and the
  // benign SPA fallback can both answer 200, so only the content distinguishes
  // "refused" from "served something it should not have".
  expect(response.body).not.toContain(SENTINEL);
});

test.each(["/../outside-secret.txt", "/assets/../../outside-secret.txt"])(
  "refuses the literal dot-segment traversal %s on a raw socket",
  async (path) => {
    const { port, app } = await servedApp({ listen: true });
    expect(port).toBeGreaterThan(0);

    const response = await rawGet(port, path);
    expect(response.body).not.toContain(SENTINEL);
    // Unlike the encoded forms, this arrives as a real traversal and is refused
    // outright rather than falling through to the SPA handler.
    expect(response.status).toBe(403);

    await app.close();
  },
);

test("the sentinel used by the traversal probes is genuinely reachable by path", async () => {
  const { parent } = await servedApp();
  // Guards against every probe passing vacuously because the file is absent.
  const info = await stat(join(parent, "outside-secret.txt"));
  expect(info.isFile()).toBe(true);
  expect(info.size).toBeGreaterThan(0);
});

test("control: the sentinel does appear when it sits inside the served root", async () => {
  // Serves the parent directory, placing the sentinel inside the root. This
  // proves the `not.toContain` assertions above are capable of failing -- that
  // they do not pass merely because the sentinel can never reach a response
  // body. Without it, every traversal probe would be unfalsifiable.
  const { app } = await servedApp({ serveParent: true });

  const response = await app.inject({ method: "GET", url: "/outside-secret.txt" });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain(SENTINEL);
});
