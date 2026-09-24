import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Schedule } from "../../src/domain/models.js";
import { writeScheduleExport } from "../../src/export/marktvJson.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

async function outputDirectory() {
  const path = await mkdtemp(`${tmpdir()}/marktv-export-`);
  directories.push(path);
  return path;
}

function schedule(
  id: string,
  path = "/media/Comedy Show/episode.mp4",
  generatedAt = "2026-09-13T12:00:00.000Z",
): Schedule {
  return {
    id,
    channelId: "MarkTV Laughs",
    date: "2026-09-13",
    timezone: "America/Chicago",
    seed: "deterministic-seed",
    revision: "demo-1",
    generatedAt,
    durationMs: 86_400_000,
    entries: [
      {
        id: "one",
        start: "2026-09-13T05:00:00.000Z",
        end: "2026-09-13T05:23:00.000Z",
        localStart: "00:00",
        localEnd: "00:23",
        durationMs: 1_380_000,
        kind: "episode",
        title: "Episode",
        mediaId: "one",
        path,
        sourceDaypartId: "late-night",
        sourceSlotId: "late-shows",
        selectionExplanation:
          "Weighted pool Comedy Show: selected chronological next episode",
      },
    ],
    diagnostics: [{ code: "NOTICE", message: "Generated locally" }],
  };
}

test("exports a versioned self-describing schedule with absolute paths and diagnostics", async () => {
  const result = await writeScheduleExport(
    schedule("generation-one"),
    await outputDirectory(),
  );
  expect(basename(result)).toBe("marktv-laughs-2026-09-13.marktv.json");
  const parsed = JSON.parse(await readFile(result, "utf8"));
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    marktvVersion: "0.1.0",
    channel: { id: "MarkTV Laughs", timezone: "America/Chicago" },
    generation: {
      id: "generation-one",
      seed: "deterministic-seed",
      configurationRevision: "demo-1",
    },
    diagnostics: [{ code: "NOTICE", message: "Generated locally" }],
    sync: { eligible: true, blockingReasons: [] },
  });
  expect(parsed.entries[0].path).toMatch(/^\//);
  expect(parsed.entries[0]).toMatchObject({
    sourceDaypartId: "late-night",
    sourceSlotId: "late-shows",
    selectionExplanation:
      "Weighted pool Comedy Show: selected chronological next episode",
  });
});

test("marks entries without absolute media paths as ineligible for sync", async () => {
  const result = await writeScheduleExport(
    schedule("preview", ""),
    await outputDirectory(),
  );
  const parsed = JSON.parse(await readFile(result, "utf8"));
  expect(parsed.sync).toEqual({
    eligible: false,
    blockingReasons: ["MEDIA_PATH_MISSING_OR_RELATIVE"],
  });
});

test("atomically reuses the same generation export and preserves its original artifact", async () => {
  const directory = await outputDirectory();
  const first = await writeScheduleExport(
    schedule("same-generation"),
    directory,
  );
  const before = await readFile(first, "utf8");
  const second = await writeScheduleExport(
    schedule(
      "same-generation",
      "/media/changed.mp4",
      "2026-09-13T13:00:00.000Z",
    ),
    directory,
  );
  expect(second).toBe(first);
  expect(await readFile(second, "utf8")).toBe(before);
  expect((await readdir(directory)).some((name) => name.includes(".tmp"))).toBe(
    false,
  );
});

test("[OP04] does not overwrite a distinct generation for the same channel and date", async () => {
  const directory = await outputDirectory();
  const [first, second] = await Promise.all([
    writeScheduleExport(schedule("generation-one"), directory),
    writeScheduleExport(schedule("generation-two"), directory),
  ]);
  expect(second).not.toBe(first);
  expect([basename(first), basename(second)]).toContain(
    "marktv-laughs-2026-09-13.marktv.json",
  );
  expect([basename(first), basename(second)]).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^marktv-laughs-2026-09-13-[a-f0-9]{16}\.marktv\.json$/,
      ),
    ]),
  );
  expect(await readdir(directory)).toHaveLength(2);
  expect(JSON.parse(await readFile(first, "utf8")).generation.id).toBe(
    "generation-one",
  );
  expect(JSON.parse(await readFile(second, "utf8")).generation.id).toBe(
    "generation-two",
  );
});

test("publishes concurrent same-generation exports as one complete idempotent artifact", async () => {
  const directory = await outputDirectory();
  const firstSchedule = schedule("concurrent-generation", "/media/first.mp4");
  const secondSchedule = schedule(
    "concurrent-generation",
    "/media/second.mp4",
    "2026-09-13T13:00:00.000Z",
  );
  const [first, second] = await Promise.all([
    writeScheduleExport(firstSchedule, directory),
    writeScheduleExport(secondSchedule, directory),
  ]);
  expect(second).toBe(first);
  expect(["/media/first.mp4", "/media/second.mp4"]).toContain(
    JSON.parse(await readFile(first, "utf8")).entries[0].path,
  );
  expect(
    (await readdir(directory)).filter((name) => name.includes(".tmp")),
  ).toEqual([]);
});
