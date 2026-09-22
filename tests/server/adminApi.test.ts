import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { pinOwners } from "../../src/acquisition/paths.js";
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
  // The app also registers the owner-only managed acquisition library exactly
  // once, so an explicit read-only root is one entry among the registered roots.
  expect((await app.inject("/api/v1/media/roots")).json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: root.id, path: root.path }),
    ]),
  );
  const scanned = await app.inject({
    method: "POST",
    url: `/api/v1/media/roots/${root.id}/scan`,
  });
  expect(scanned.statusCode).toBe(200);
  expect(scanned.json()).toMatchObject({
    root: { id: root.id, lastScannedAt: expect.any(String) },
    result: { items: [expect.objectContaining({ title: "Pilot S01E01" })] },
  });

  // A manually registered voiced classification must survive a later library
  // scan of the same canonical path.
  const scannedMedia = (await app.inject("/api/v1/media")).json() as Array<{
    id: string;
    path?: string;
    kind: string;
    tags: string[];
  }>;
  const imported = scannedMedia.find((item) => item.path?.endsWith("Pilot_S01E01.mp4"));
  expect(imported).toBeDefined();
  const voicedTags = [...imported!.tags, "voiced-continuity", "continuity-channel=marktv-laughs"];
  expect((await app.inject({
    method: "PUT",
    url: `/api/v1/media/${imported!.id}`,
    payload: { ...imported, kind: "bumper", tags: voicedTags },
  })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/v1/media/roots/${root.id}/scan` })).statusCode).toBe(200);
  const rescanned = ((await app.inject("/api/v1/media")).json() as typeof scannedMedia)
    .find((item) => item.path?.endsWith("Pilot_S01E01.mp4"));
  expect(rescanned).toMatchObject({ kind: "bumper", tags: voicedTags });

  const unsafe = await app.inject({
    method: "POST",
    url: "/api/v1/media/roots",
    payload: { path: "relative/path" },
  });
  expect(unsafe.statusCode).toBe(422);
  expect(unsafe.json()).toMatchObject({ code: "INVALID_SCAN_ROOT" });

  // A generated continuity card lives inside the mapped root, so a later scan
  // rediscovers the file. It must not mint a second, untagged catalog entry that
  // would let the same file leak into another day's pools as ordinary filler.
  const cardDirectory = join(mediaRoot, "generated", "continuity");
  await mkdir(cardDirectory, { recursive: true });
  const cardPath = join(cardDirectory, "next-card.mp4");
  await writeFile(cardPath, "fixture");
  const card = {
    id: "continuity-test-card",
    source: "local-folder",
    path: cardPath,
    kind: "bumper",
    title: "marktv continuity next",
    durationMs: 5000,
    durationStatus: "ok",
    available: true,
    tags: ["continuity", "schedule-scoped-continuity", "continuity-hash=abc"],
  };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/media/${card.id}`,
        payload: card,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/media/roots/${root.id}/scan`,
      })
    ).statusCode,
  ).toBe(200);
  const catalog = (await app.inject("/api/v1/media")).json() as Array<{
    id: string;
    path?: string;
    tags: string[];
  }>;
  expect(catalog.filter((item) => item.path === cardPath)).toEqual([
    expect.objectContaining({
      id: "continuity-test-card",
      tags: expect.arrayContaining(["schedule-scoped-continuity"]),
    }),
  ]);
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

test("removing the root registered for the managed library leaves acquisition pinned", async () => {
  const dataDir = await temporaryDirectory("marktv-api-");
  const app = await buildApp({ dataDir });
  const roots = (await app.inject("/api/v1/media/roots")).json() as Array<{
    id: string;
    path: string;
  }>;
  // The app registers the managed acquisition library as a root at startup, and
  // startup pinning covers it under the root's own owner as well.
  const library = roots.find((root) => root.path.endsWith("library"));
  expect(library).toBeDefined();
  const libraryPath = library?.path ?? "";
  expect(pinOwners(libraryPath)).toContain("managed-paths");

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/v1/media/roots/${library?.id}`,
  });
  expect(removed.statusCode).toBe(204);

  // The root's pin is released, but the descriptor acquisition depends on must
  // survive: same directory, two independent owners.
  expect(pinOwners(libraryPath)).toEqual(["managed-paths"]);
  await app.close();
});

test("updates a local-folder media item whose base64url ID exceeds 100 characters", async () => {
  const app = await buildApp({
    dataDir: await temporaryDirectory("marktv-api-"),
  });
  const path = `/media/library/Example Show/Season 01/Example Show S01E01 ${"Long ".repeat(
    6,
  )}Title.mp4`;
  const id = `local-${Buffer.from(path).toString("base64url")}`;
  // Local IDs are absolute paths encoded with base64url, so they routinely
  // exceed find-my-way's default 100-character parameter limit.
  expect(id.length).toBeGreaterThan(100);
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/media/${id}`,
    payload: {
      id,
      source: "local-folder",
      path,
      kind: "episode",
      title: "Example Show S01E01",
      durationMs: 1_800_000,
      durationStatus: "ok",
      available: true,
      tags: [],
    },
  });
  expect(response.statusCode).toBe(200);
  expect(
    (await app.inject("/api/v1/media"))
      .json()
      .find((item: { id: string }) => item.id === id),
  ).toMatchObject({ id, title: "Example Show S01E01" });
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
  // Asked by the date this test generated: the endpoint answers for a
  // broadcast date, not for whatever row happens to be newest.
  expect(
    (
      await app.inject(
        `/api/v1/schedules/latest?channelId=${channel.id}&date=2026-09-13`,
      )
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
      await app.inject(
        "/api/v1/schedules/latest?channelId=marktv-laughs&date=2026-09-13",
      )
    ).json().id,
  ).toBe(first.json().schedule.id);
  await app.close();
});
