import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  INCIDENT_RING,
  incidentCounts,
  listIncidents,
  recordIncident,
} from "../../src/autopilot/incidents.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repositories() {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-incidents-"));
  dirs.push(dataDir);
  return createRepositories(openDatabase(dataDir));
}

test("[R17] incidents are durable, per channel, and bounded", async () => {
  const repos = await repositories();
  const at = "2026-09-24T12:00:00.000Z";
  recordIncident(repos, { at, channelId: "a", kind: "incident", reason: "stalled" });
  recordIncident(repos, { at, channelId: "a", kind: "dispatched", reason: "wake" });
  recordIncident(repos, { at, channelId: "b", kind: "incident", reason: "stalled" });

  expect(listIncidents(repos, "a")).toHaveLength(2);
  expect(listIncidents(repos, "b")).toHaveLength(1);
  expect(incidentCounts(repos, "a", 24 * 60 * 60 * 1000, new Date(at))).toEqual({
    incidents: 1,
    dispatched: 1,
    suppressed: 0,
    recovered: 0,
  });

  // The ring is bounded: flooding one channel does not grow without limit.
  for (let index = 0; index < INCIDENT_RING + 10; index += 1)
    recordIncident(repos, { at, channelId: "a", kind: "suppressed", reason: "circuit-open" });
  expect(listIncidents(repos, "a")).toHaveLength(INCIDENT_RING);

  // Events outside the window are not counted.
  expect(
    incidentCounts(repos, "a", 24 * 60 * 60 * 1000, new Date("2026-09-27T12:00:00.000Z")),
  ).toMatchObject({ incidents: 0, dispatched: 0 });
});
