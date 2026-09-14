import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { demo, seedDemoIfEmpty } from "../../src/demo/marktvLaughs.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

async function repositories() {
  const directory = await mkdtemp(`${tmpdir()}/marktv-demo-`);
  directories.push(directory);
  return createRepositories(openDatabase(directory));
}

test("seeds one fictional preview-only channel into an empty database", async () => {
  const repos = await repositories();
  seedDemoIfEmpty(repos, "America/Chicago");

  expect(repos.channels.list()).toEqual([
    expect.objectContaining({
      id: "marktv-laughs",
      name: "MarkTV Laughs",
      number: 7,
    }),
  ]);
  expect(
    repos.media.list().every((item) => item.source === "placeholder"),
  ).toBe(true);
  const channel = repos.channels.get("marktv-laughs")!;
  expect(
    channel.dayparts.map(({ id, name, start, end }) => ({
      id,
      name,
      start,
      end,
    })),
  ).toEqual([
    { id: "morning", name: "Morning", start: "06:00", end: "12:00" },
    { id: "daytime", name: "Daytime", start: "12:00", end: "17:00" },
    { id: "evening", name: "Evening", start: "17:00", end: "20:00" },
    { id: "late-night", name: "Late Night", start: "20:00", end: "00:00" },
    { id: "overnight", name: "Overnight", start: "00:00", end: "06:00" },
  ]);
  expect(channel.slots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "friday-movie",
        days: [5, 6],
        time: "20:00",
        poolIds: ["movies"],
      }),
    ]),
  );
  expect(repos.pools.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "apartment-4b",
        mode: "chronological",
        noRepeatMinutes: 720,
      }),
      expect.objectContaining({
        id: "space-neighbors",
        mode: "chronological",
        noRepeatMinutes: 720,
      }),
      expect.objectContaining({ id: "movies", noRepeatMinutes: 10_080 }),
      expect.objectContaining({ id: "ads", noRepeatMinutes: 120 }),
    ]),
  );
  repos.close();
});

test("is idempotent and does not seed over existing user state", async () => {
  const repos = await repositories();
  seedDemoIfEmpty(repos, "America/Chicago");
  const originalCounts = [
    repos.channels.list().length,
    repos.pools.list().length,
    repos.media.list().length,
  ];
  seedDemoIfEmpty(repos, "Europe/London");
  expect([
    repos.channels.list().length,
    repos.pools.list().length,
    repos.media.list().length,
  ]).toEqual(originalCounts);
  expect(repos.channels.get("marktv-laughs")?.timezone).toBe("America/Chicago");
  repos.close();
});

test("sample configuration is structurally identical to the seeded demo and contains no legacy fields", async () => {
  const sample = JSON.parse(
    await readFile(
      join(process.cwd(), "config/marktv-laughs.sample.json"),
      "utf8",
    ),
  );
  expect(sample).toEqual(demo("America/Chicago"));
  expect(sample).not.toHaveProperty("previewOnly");
  expect(sample).not.toHaveProperty("description");
  expect(sample.channel.breakPolicy).not.toHaveProperty("roles");
  expect(sample.channel.breakPolicy).not.toHaveProperty(
    "stationIdsAtTopOfHour",
  );
});
