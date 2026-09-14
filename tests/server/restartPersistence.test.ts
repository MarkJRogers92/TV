import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("reopens the same data directory with the generated schedule intact", async () => {
  directory = await mkdtemp(`${tmpdir()}/marktv-restart-`);
  let app = await buildApp({
    dataDir: directory,
    now: () => new Date("2026-09-13T18:12:00-05:00"),
  });
  const generated = (
    await app.inject({
      method: "POST",
      url: "/api/v1/schedules/generate",
      payload: { channelId: "marktv-laughs", date: "2026-09-13" },
    })
  ).json().schedule;
  await app.close();

  app = await buildApp({ dataDir: directory });
  const reopened = (
    await app.inject("/api/v1/schedules/latest?channelId=marktv-laughs")
  ).json();
  expect({ id: reopened.id, entries: reopened.entries.length }).toEqual({
    id: generated.id,
    entries: generated.entries.length,
  });
  await app.close();
});
