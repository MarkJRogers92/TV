import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { channelSchema } from "../../src/domain/models.js";
import { movieOccurrenceSchema } from "../../src/domain/movieProgramming.js";
import { movieFixture } from "../support/movieFixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function dataDir() {
  const path = await mkdtemp(join(tmpdir(), "marktv-movie-storage-"));
  directories.push(path);
  return path;
}

test("the movie rotation is stored once per channel and read back verbatim", async () => {
  const repositories = createRepositories(openDatabase(await dataDir()));
  const rotation = {
    channelId: "marktv-laughs",
    seed: "movie-rotation:marktv-laughs:seed",
    epochDate: "2026-09-06",
    order: ["movie-02", "movie-01"],
    fingerprint: "abc123",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  repositories.movieRotations.put(rotation);
  expect(repositories.movieRotations.get("marktv-laughs")).toEqual(rotation);
  expect(repositories.movieRotations.get("another-channel")).toBeUndefined();
  repositories.movieRotations.put({ ...rotation, fingerprint: "def456" });
  expect(repositories.movieRotations.get("marktv-laughs")).toEqual({
    ...rotation,
    fingerprint: "def456",
  });
  repositories.close();
});

test("occurrences are keyed by date and position and are stable when rewritten", async () => {
  const repositories = createRepositories(openDatabase(await dataDir()));
  const occurrence = {
    channelId: "marktv-laughs",
    date: "2026-09-12",
    position: "double-feature-1" as const,
    role: "weekend-opener" as const,
    anchor: "19:00",
    mediaId: "movie-01",
    consumes: true,
    resolvedAt: "2026-09-01T00:00:00.000Z",
  };
  repositories.movieOccurrences.put(occurrence);
  // Rewriting the same key replaces rather than duplicating, so a regeneration
  // cannot grow the ledger.
  repositories.movieOccurrences.put({ ...occurrence, resolvedAt: "2026-09-02T00:00:00.000Z" });
  expect(
    repositories.movieOccurrences.listForDate("marktv-laughs", "2026-09-12"),
  ).toEqual([{ ...occurrence, resolvedAt: "2026-09-02T00:00:00.000Z" }]);
  expect(repositories.movieOccurrences.listForChannel("marktv-laughs")).toHaveLength(1);
  expect(
    repositories.movieOccurrences.get("marktv-laughs", "2026-09-12", "nightly"),
  ).toBeUndefined();
  repositories.close();
});

test("movie records fail closed on malformed input", () => {
  expect(
    movieOccurrenceSchema.safeParse({
      channelId: "marktv-laughs",
      date: "2026-13-40",
      position: "nightly",
      role: "nightly",
      anchor: "02:00",
      mediaId: "movie-01",
      consumes: true,
      resolvedAt: "2026-09-01T00:00:00.000Z",
    }).success,
  ).toBe(false);
  expect(
    movieOccurrenceSchema.safeParse({
      channelId: "marktv-laughs",
      date: "2026-09-12",
      position: "third-feature",
      role: "nightly",
      anchor: "02:00",
      mediaId: "movie-01",
      consumes: true,
      resolvedAt: "2026-09-01T00:00:00.000Z",
    }).success,
  ).toBe(false);
});

test("the feature is off unless a channel turns it on, and defaults are filled in", () => {
  const { channel } = movieFixture();
  const withoutFeature = channelSchema.parse({
    ...channel,
    movieProgramming: undefined,
  });
  expect(withoutFeature.movieProgramming).toBeUndefined();

  const enabled = channelSchema.parse({
    ...channel,
    movieProgramming: { enabled: true },
  });
  expect(enabled.movieProgramming).toMatchObject({
    enabled: true,
    nightlyAnchor: "02:00",
    weekendAnchor: "19:00",
    bridgeMinSeconds: 60,
    bridgeMaxSeconds: 120,
    lookaheadDays: 8,
    breakPolicy: {
      targetMinutes: 2,
      maxMinutes: 2.5,
      protectionMinutes: 15,
      shortMaxMinutes: 110,
    },
  });
});

test("an existing database gains the movie tables without losing anything", async () => {
  const dir = await dataDir();
  const path = join(dir, "marktv.sqlite");
  // A database from before the feature: documents only, with a channel in it.
  const legacy = new Database(path);
  legacy.exec(
    "CREATE TABLE documents (type TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(type, id))",
  );
  legacy
    .prepare("INSERT INTO documents(type, id, json) VALUES (?, ?, ?)")
    .run("channel", "marktv-laughs", JSON.stringify(movieFixture().channel));
  legacy.close();

  const repositories = createRepositories(openDatabase(dir));
  expect(repositories.channels.get("marktv-laughs")).toBeTruthy();
  expect(repositories.movieRotations.get("marktv-laughs")).toBeUndefined();
  repositories.movieRotations.put({
    channelId: "marktv-laughs",
    seed: "seed",
    epochDate: "2026-09-06",
    order: ["movie-01"],
    fingerprint: "hash",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  expect(repositories.movieRotations.get("marktv-laughs")?.order).toEqual([
    "movie-01",
  ]);
  repositories.close();
});
