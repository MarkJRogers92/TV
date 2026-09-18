import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import {
  createRepositories,
  scheduleLimits,
} from "../../src/db/repositories.js";
import { demo } from "../../src/demo/marktvLaughs.js";
import type { Channel, Schedule } from "../../src/domain/models.js";
import { generateSchedule } from "../../src/scheduler/generate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const path = await mkdtemp(`${tmpdir()}/marktv-repository-`);
  temporaryDirectories.push(path);
  return path;
}

function schedule(
  id: string,
  generatedAt = "2026-09-13T12:00:00.000Z",
): Schedule {
  return {
    id,
    channelId: "marktv-laughs",
    date: "2026-09-13",
    timezone: "America/Chicago",
    seed: "seed",
    revision: "demo-1",
    generatedAt,
    durationMs: 86_400_000,
    entries: [
      {
        id: "entry-1",
        start: "2026-09-13T05:00:00.000Z",
        end: "2026-09-13T05:01:00.000Z",
        localStart: "00:00",
        localEnd: "00:01",
        durationMs: 60_000,
        kind: "episode",
        title: "Apartment 4B 1",
        mediaId: "apartment-4b-1",
      },
    ],
    diagnostics: [],
  };
}

test("persists documents and schedules after closing and reopening the database", async () => {
  const directory = await temporaryDirectory();
  let repositories = createRepositories(openDatabase(directory));
  const seeded = demo();
  repositories.channels.put(seeded.channel);
  repositories.settings.put("example", { enabled: true });
  repositories.schedules.replaceSuccessful(
    seeded.channel.id,
    schedule("persisted"),
  );
  repositories.close();

  repositories = createRepositories(openDatabase(directory));
  expect(repositories.channels.get(seeded.channel.id)).toEqual(seeded.channel);
  expect(repositories.settings.get("example")?.value).toEqual({
    enabled: true,
  });
  expect(repositories.schedules.latest(seeded.channel.id)?.id).toBe(
    "persisted",
  );
  repositories.close();
});

test("validates public document writes before touching SQL", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  const seeded = demo();
  const invalid = { ...seeded.channel, timezone: "not/a-zone" } as Channel;
  expect(() => repositories.channels.put(invalid)).toThrow();
  expect(repositories.channels.get(invalid.id)).toBeUndefined();
  expect(() =>
    repositories.pools.put({ ...seeded.pools[0], weight: 0 }),
  ).toThrow();
  expect(repositories.pools.get(seeded.pools[0].id)).toBeUndefined();
  repositories.close();
});

test("returns only non-flex play history from schedules before the requested date", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  const prior = schedule("prior");
  const sameDay = { ...schedule("same-day"), date: "2026-09-14" };
  const future = { ...schedule("future"), date: "2026-09-15" };
  prior.entries.push({
    id: "flex",
    start: "2026-09-13T05:01:00.000Z",
    end: "2026-09-13T05:02:00.000Z",
    localStart: "00:01",
    localEnd: "00:02",
    durationMs: 60_000,
    kind: "flex",
    title: "Flexible programming",
  });
  repositories.schedules.replaceSuccessful(prior.channelId, prior);
  repositories.schedules.replaceSuccessful(sameDay.channelId, sameDay);
  repositories.schedules.replaceSuccessful(future.channelId, future);

  expect(
    repositories.schedules.historyBefore("marktv-laughs", "2026-09-14"),
  ).toEqual([{ mediaId: "apartment-4b-1", at: "2026-09-13T05:00:00.000Z" }]);
  repositories.close();
});

test("keeps the last successful schedule when replacement validation fails", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  const valid = schedule("valid");
  repositories.schedules.replaceSuccessful(valid.channelId, valid);

  expect(() =>
    repositories.schedules.replaceSuccessful(valid.channelId, {
      ...schedule("invalid"),
      entries: [],
    }),
  ).toThrow();
  expect(repositories.schedules.latest(valid.channelId)?.id).toBe("valid");
  repositories.close();
});

test("validates entry timing before replacing a successful schedule", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  const valid = schedule("valid-timing");
  repositories.schedules.replaceSuccessful(valid.channelId, valid);
  const invalid = schedule("invalid-timing");
  invalid.entries[0].end = "2026-09-13T05:02:00.000Z";

  expect(() =>
    repositories.schedules.replaceSuccessful(invalid.channelId, invalid),
  ).toThrow();
  expect(repositories.schedules.latest(valid.channelId)?.id).toBe(
    "valid-timing",
  );
  repositories.close();
});

test("stores every successful generation and latest follows insertion order", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  repositories.schedules.replaceSuccessful(
    "marktv-laughs",
    schedule("z-first", "2026-09-13T14:00:00.000Z"),
  );
  repositories.schedules.replaceSuccessful(
    "marktv-laughs",
    schedule("a-second", "2026-09-13T13:00:00.000Z"),
  );
  repositories.schedules.replaceSuccessful(
    "marktv-laughs",
    schedule("a-second", "2026-09-13T15:00:00.000Z"),
  );

  expect(
    repositories.schedules.list("marktv-laughs").map((entry) => entry.id),
  ).toEqual(["z-first", "a-second", "a-second"]);
  expect(repositories.schedules.latest("marktv-laughs")?.generatedAt).toBe(
    "2026-09-13T15:00:00.000Z",
  );
  repositories.close();
});

test("rejects a schedule stored under a different channel without changing latest", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  repositories.schedules.replaceSuccessful("marktv-laughs", schedule("valid"));

  expect(() =>
    repositories.schedules.replaceSuccessful(
      "another-channel",
      schedule("wrong-channel"),
    ),
  ).toThrow();
  expect(repositories.schedules.latest("marktv-laughs")?.id).toBe("valid");
  repositories.close();
});

test("keeps latest when regeneration fails configuration validation", async () => {
  const repositories = createRepositories(
    openDatabase(await temporaryDirectory()),
  );
  const current = schedule("current");
  repositories.schedules.replaceSuccessful(current.channelId, current);
  const seeded = demo();
  seeded.channel.slots[0].poolIds = ["missing"];

  const failed = generateSchedule({
    channel: seeded.channel,
    pools: seeded.pools,
    items: seeded.media,
    date: "2026-09-13",
  });
  expect(failed.ok).toBe(false);
  expect(repositories.schedules.latest(current.channelId)?.id).toBe("current");
  repositories.close();
});

test("migrates legacy document schedules on reopen", async () => {
  const directory = await temporaryDirectory();
  const database = openDatabase(directory);
  const legacy = schedule("legacy");
  database
    .prepare("INSERT INTO documents(type, id, json) VALUES (?, ?, ?)")
    .run("schedule", `marktv-laughs:${legacy.id}`, JSON.stringify(legacy));
  database.close();

  const repositories = createRepositories(openDatabase(directory));
  expect(repositories.schedules.latest("marktv-laughs")?.id).toBe("legacy");
  expect(repositories.schedules.list("marktv-laughs")).toHaveLength(1);
  repositories.close();
});

test("keeps only the most recent generations, so the table cannot grow without limit", async () => {
  const previous = scheduleLimits.historyPerChannel;
  scheduleLimits.historyPerChannel = 2;
  try {
    const repositories = createRepositories(
      openDatabase(await temporaryDirectory()),
    );
    repositories.schedules.replaceSuccessful("marktv-laughs", schedule("a"));
    repositories.schedules.replaceSuccessful("marktv-laughs", schedule("b"));
    repositories.schedules.replaceSuccessful("marktv-laughs", schedule("c"));

    // `list` is ordered by generation_id, so the oldest is the one pruned and the
    // newest is still what `latest` returns.
    expect(
      repositories.schedules.list("marktv-laughs").map((entry) => entry.id),
    ).toEqual(["b", "c"]);
    expect(repositories.schedules.latest("marktv-laughs")?.id).toBe("c");
    repositories.close();
  } finally {
    scheduleLimits.historyPerChannel = previous;
  }
});
