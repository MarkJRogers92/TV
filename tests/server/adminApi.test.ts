import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { writeScheduleExport } from "../../src/export/marktvJson.js";
import type { ExportSchedule } from "../../src/server/scheduleService.js";

const temporaryDirectories: string[] = [];
afterEach(async () =>
  Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

async function temporaryDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

test("provides validated channel, pool, media, and schedule administration", async () => {
  const app = await buildApp({
    dataDir: await temporaryDirectory("marktv-api-"),
    now: () => new Date("2026-09-13T18:12:00-05:00"),
  });
  const demo = (await app.inject("/api/v1/channels")).json()[0];
  const second = {
    ...demo,
    id: "second-channel",
    name: "Second Channel",
    number: 8,
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/channels",
        payload: second,
      })
    ).statusCode,
  ).toBe(201);
  expect((await app.inject("/api/v1/channels")).json()).toHaveLength(2);

  const pool = {
    id: "new-pool",
    name: "New Pool",
    kinds: ["episode"],
    mediaIds: [],
    mode: "chronological",
    noRepeatMinutes: 60,
    weight: 1,
  };
  expect(
    (await app.inject({ method: "POST", url: "/api/v1/pools", payload: pool }))
      .statusCode,
  ).toBe(201);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/pools/new-pool",
        payload: { ...pool, name: "Edited Pool" },
      })
    ).json().name,
  ).toBe("Edited Pool");
  expect(
    (await app.inject({ method: "DELETE", url: "/api/v1/pools/new-pool" }))
      .statusCode,
  ).toBe(204);

  const generated = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: demo.id, date: "2026-09-13" },
  });
  expect(generated.statusCode).toBe(200);
  expect(generated.json()).toMatchObject({
    schedule: { channelId: demo.id, entries: expect.any(Array) },
    exportPath: expect.stringMatching(/\.marktv\.json$/),
  });
  expect(
    (await app.inject(`/api/v1/schedules/latest?channelId=${demo.id}`)).json()
      .id,
  ).toBe(generated.json().schedule.id);

  const air = await app.inject(`/api/v1/channels/${demo.id}/air`);
  expect(air.json()).toMatchObject({
    channel: { id: demo.id },
    currentTime: expect.any(String),
    scheduleStatus: "Preview only",
    nowPlaying: { title: expect.any(String) },
    upNext: { title: expect.any(String) },
  });
  await app.close();
});

test("persists, scans, and removes explicit read-only media roots with safe errors", async () => {
  const dataDir = await temporaryDirectory("marktv-api-");
  const mediaRoot = await temporaryDirectory("marktv-media-");
  await mkdir(join(mediaRoot, "Show"), { recursive: true });
  await writeFile(join(mediaRoot, "Show", "Pilot_S01E01.mp4"), "fixture");
  const app = await buildApp({ dataDir });

  const added = await app.inject({
    method: "POST",
    url: "/api/v1/media/roots",
    payload: { path: mediaRoot },
  });
  expect(added.statusCode).toBe(201);
  const root = added.json();
  expect((await app.inject("/api/v1/media/roots")).json()).toEqual([
    expect.objectContaining({ id: root.id, path: root.path }),
  ]);
  const scanned = await app.inject({
    method: "POST",
    url: `/api/v1/media/roots/${root.id}/scan`,
  });
  expect(scanned.statusCode).toBe(200);
  expect(scanned.json()).toMatchObject({
    root: { id: root.id, lastScannedAt: expect.any(String) },
    result: { items: [expect.objectContaining({ title: "Pilot S01E01" })] },
  });

  const unsafe = await app.inject({
    method: "POST",
    url: "/api/v1/media/roots",
    payload: { path: "relative/path" },
  });
  expect(unsafe.statusCode).toBe(422);
  expect(unsafe.json()).toMatchObject({ code: "INVALID_SCAN_ROOT" });
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/media/roots/${root.id}`,
      })
    ).statusCode,
  ).toBe(204);
  await app.close();
});

test("returns stable not-found, ID mismatch, and validation errors", async () => {
  const app = await buildApp({
    dataDir: await temporaryDirectory("marktv-api-"),
  });
  expect((await app.inject("/api/v1/channels/missing")).statusCode).toBe(404);
  const channel = (await app.inject("/api/v1/channels/marktv-laughs")).json();
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/channels/wrong",
        payload: channel,
      })
    ).json(),
  ).toEqual({ code: "ID_MISMATCH" });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/media/roots",
        payload: {},
      })
    ).json(),
  ).toMatchObject({ code: "VALIDATION_ERROR" });
  const referencedPool = await app.inject({
    method: "DELETE",
    url: "/api/v1/pools/apartment-4b",
  });
  expect(referencedPool.statusCode).toBe(409);
  expect(referencedPool.json()).toMatchObject({
    code: "POOL_IN_USE",
    issues: [expect.objectContaining({ path: "poolId" })],
  });
  await app.close();
});

test("rejects malformed channel and generation dates without replacing persisted state", async () => {
  const app = await buildApp({
    dataDir: await temporaryDirectory("marktv-api-"),
  });
  const channel = (await app.inject("/api/v1/channels/marktv-laughs")).json();
  const original = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: channel.id, date: "2026-09-13" },
  });
  expect(original.statusCode).toBe(200);

  const invalidChannel = await app.inject({
    method: "PUT",
    url: `/api/v1/channels/${channel.id}`,
    payload: { ...channel, timezone: "America/Definitely_Not_Real" },
  });
  expect(invalidChannel.statusCode).toBe(422);
  expect(invalidChannel.json()).toMatchObject({
    code: "VALIDATION_ERROR",
    issues: expect.any(Array),
  });
  expect(
    (await app.inject(`/api/v1/channels/${channel.id}`)).json().timezone,
  ).toBe(channel.timezone);

  const pools = (await app.inject("/api/v1/pools")).json();
  const moviePool = pools.find((pool: { id: string }) => pool.id === "movies");
  const episode = (await app.inject("/api/v1/media"))
    .json()
    .find((item: { kind: string }) => item.kind === "episode");
  const episodeId = episode.id;
  const invalidPool = await app.inject({
    method: "PUT",
    url: `/api/v1/pools/${moviePool.id}`,
    payload: { ...moviePool, mediaIds: [...moviePool.mediaIds, episodeId] },
  });
  expect(invalidPool.statusCode).toBe(422);
  expect(
    (await app.inject("/api/v1/pools"))
      .json()
      .find((pool: { id: string }) => pool.id === "movies").mediaIds,
  ).toEqual(moviePool.mediaIds);

  const invalidMedia = await app.inject({
    method: "PUT",
    url: `/api/v1/media/${episodeId}`,
    payload: { ...episode, kind: "movie" },
  });
  expect(invalidMedia.statusCode).toBe(422);
  expect(
    (await app.inject("/api/v1/media"))
      .json()
      .find((item: { id: string }) => item.id === episodeId).kind,
  ).toBe("episode");
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/media/${episodeId}`,
      })
    ).statusCode,
  ).toBe(409);

  const invalidDate = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: channel.id, date: "2026-02-31" },
  });
  expect(invalidDate.statusCode).toBe(422);
  expect(invalidDate.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(
    (
      await app.inject(`/api/v1/schedules/latest?channelId=${channel.id}`)
    ).json().id,
  ).toBe(original.json().schedule.id);
  await app.close();
});

test("uses persisted earlier schedules as no-repeat history after restart", async () => {
  const dataDir = await temporaryDirectory("marktv-history-");
  let app = await buildApp({ dataDir });
  const channel = (await app.inject("/api/v1/channels/marktv-laughs")).json();
  const pool = (await app.inject("/api/v1/pools"))
    .json()
    .find((entry: { id: string }) => entry.id === "apartment-4b");
  const onlyEpisode = pool.mediaIds[0];
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/pools/${pool.id}`,
        payload: { ...pool, mediaIds: [onlyEpisode], noRepeatMinutes: 10_080 },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/channels/${channel.id}`,
        payload: {
          ...channel,
          dayparts: [
            {
              id: "all-day",
              name: "All day",
              days: [0, 1, 2, 3, 4, 5, 6],
              start: "00:00",
              end: "00:00",
              priority: 1,
            },
          ],
          slots: [
            {
              id: "episodes",
              daypartId: "all-day",
              days: [],
              poolIds: [pool.id],
              kind: "episode",
              fallbackPoolIds: [],
            },
          ],
        },
      })
    ).statusCode,
  ).toBe(200);
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: channel.id, date: "2026-09-13" },
  });
  expect(first.statusCode).toBe(200);
  expect(
    first
      .json()
      .schedule.entries.some(
        (entry: { mediaId?: string }) => entry.mediaId === onlyEpisode,
      ),
  ).toBe(true);
  await app.close();

  app = await buildApp({ dataDir });
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: channel.id, date: "2026-09-14" },
  });
  expect(second.statusCode).toBe(200);
  expect(
    second
      .json()
      .schedule.entries.some(
        (entry: { kind: string }) => entry.kind === "episode",
      ),
  ).toBe(false);
  expect(
    second
      .json()
      .schedule.entries.every(
        (entry: { kind: string }) => entry.kind === "flex",
      ),
  ).toBe(true);
  await app.close();
});

test("auto-generation exports once before persisting across concurrent air requests", async () => {
  const dataDir = await temporaryDirectory("marktv-air-export-");
  let exportCalls = 0;
  const app = await buildApp({
    dataDir,
    now: () => new Date("2026-09-13T18:12:00-05:00"),
    exportSchedule: (async (schedule, destination) => {
      exportCalls += 1;
      return writeScheduleExport(schedule, destination);
    }) satisfies ExportSchedule,
  });

  const responses = await Promise.all([
    app.inject("/api/v1/channels/marktv-laughs/air"),
    app.inject("/api/v1/channels/marktv-laughs/air"),
  ]);
  expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(exportCalls).toBe(1);
  expect(await readdir(join(dataDir, "exports"))).toEqual([
    "marktv-laughs-2026-09-13.marktv.json",
  ]);
  expect(
    (
      await app.inject("/api/v1/schedules/latest?channelId=marktv-laughs")
    ).json().id,
  ).toBeTruthy();
  await app.close();
});

test("an export failure does not replace the prior successful schedule", async () => {
  const dataDir = await temporaryDirectory("marktv-export-failure-");
  let exportCalls = 0;
  const app = await buildApp({
    dataDir,
    exportSchedule: (async (schedule, destination) => {
      exportCalls += 1;
      if (exportCalls === 2) throw new Error("disk unavailable");
      return writeScheduleExport(schedule, destination);
    }) satisfies ExportSchedule,
  });
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: "marktv-laughs", date: "2026-09-13" },
  });
  expect(first.statusCode).toBe(200);
  const failed = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: "marktv-laughs", date: "2026-09-14" },
  });
  expect(failed.statusCode).toBe(500);
  expect(failed.json()).toMatchObject({ code: "EXPORT_FAILED" });
  expect(
    (
      await app.inject("/api/v1/schedules/latest?channelId=marktv-laughs")
    ).json().id,
  ).toBe(first.json().schedule.id);
  await app.close();
});
