import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureManagedDirectory } from "../../src/acquisition/paths.js";
import { channelAirState, mediaRootStatus, preparationStatus } from "../../src/autopilot/status.js";
import type { Channel } from "../../src/domain/models.js";
import type { Repositories } from "../../src/db/repositories.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { putMediaRoot } from "../../src/media/roots.js";
import { buildApp } from "../../src/server/app.js";

const cleanups: Array<() => void | Promise<void>> = [];
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repositories() {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-status-"));
  temporary.push(dataDir);
  const repos = createRepositories(openDatabase(dataDir));
  cleanups.push(() => { repos.close(); });
  return repos;
}

test("preparationStatus counts intakes and jobs by state", async () => {
  const repos = await repositories();
  const source = { path: "/approved/media/x.mp4", sizeBytes: "1", modifiedMs: "1", deviceId: "1", inode: "1" };
  repos.preparation.observe({ sourceMediaId: "m1", source, observedAt: "2026-09-24T12:00:00.000Z" });
  repos.preparation.observe({ sourceMediaId: "m1", source, observedAt: "2026-09-24T12:01:00.000Z" });

  const status = preparationStatus(repos);
  expect(status.intakes).toBe(1);
  expect(status.jobs.queued).toBe(1);
  expect(status.recent[0]).toMatchObject({ path: source.path, state: "queued" });
});

test("[OP12] mediaRootStatus reports a missing root as absent, not empty", async () => {
  const repos = await repositories();
  const rootPath = await mkdtemp(join(tmpdir(), "marktv-status-root-"));
  temporary.push(rootPath);
  putMediaRoot(repos, {
    path: rootPath,
    lastScannedAt: null,
    diagnostics: [],
    directoryIdentity: await captureManagedDirectory(rootPath),
  });
  const gone = join(rootPath, "gone");
  putMediaRoot(repos, { path: gone, lastScannedAt: null, diagnostics: [] });

  const present = new Map((await mediaRootStatus(repos)).map((root) => [root.path, root.present]));
  expect(present.get(rootPath)).toBe(true);
  expect(present.get(gone)).toBe(false);
});

test("[R17] channelAirState reports what is on air now and what is next", () => {
  const entry = (id: string, start: string, end: string, title: string) => ({
    id,
    start,
    end,
    localStart: "00:00",
    localEnd: "00:30",
    durationMs: Date.parse(end) - Date.parse(start),
    kind: "episode",
    title,
  });
  const schedule = {
    channelId: "c1",
    date: "2026-09-24",
    entries: [
      entry("e1", "2026-09-24T05:00:00.000Z", "2026-09-24T05:30:00.000Z", "A"),
      entry("e2", "2026-09-24T05:30:00.000Z", "2026-09-24T06:00:00.000Z", "B"),
    ],
  };
  const repositories = {
    schedules: {
      latestForDate: (_id: string, date: string) =>
        date === "2026-09-24" ? schedule : undefined,
    },
  } as unknown as Repositories;
  const channel = { id: "c1", name: "C", timezone: "America/Chicago" } as unknown as Channel;

  const air = channelAirState(repositories, channel, new Date("2026-09-24T05:10:00.000Z"));
  expect(air.onAir).toMatchObject({
    title: "A",
    elapsedMs: 10 * 60 * 1000,
    remainingMs: 20 * 60 * 1000,
  });
  expect(air.next.map((item) => item.title)).toEqual(["B"]);
});

test("the status route returns a read-only snapshot", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-status-app-"));
  temporary.push(dataDir);
  const app = await buildApp({ dataDir });
  const response = await app.inject({ method: "GET", url: "/api/v1/autopilot/status" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    preparation: expect.objectContaining({ intakes: expect.any(Number) }),
    mediaRoots: expect.any(Array),
    channels: expect.any(Array),
  });
  await app.close();
});

test("[OP06] the diagnostic bundle is local, redacted and carries the status", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-diag-"));
  temporary.push(dataDir);
  const app = await buildApp({ dataDir });
  const response = await app.inject({ method: "GET", url: "/api/v1/diagnostics" });
  expect(response.statusCode).toBe(200);
  const bundle = response.json();
  expect(bundle).toMatchObject({
    generatedAt: expect.any(String),
    runtime: expect.objectContaining({ platform: expect.any(String), node: expect.any(String) }),
    status: expect.objectContaining({ mediaRoots: expect.any(Array), channels: expect.any(Array) }),
  });
  // Redacted: no bearer/token-shaped value survives.
  expect(response.body).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
  await app.close();
});
