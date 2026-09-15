import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { demo } from "../../src/demo/marktvLaughs.js";
import { ScheduleService } from "../../src/server/scheduleService.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-midroll-service-"));
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  const seeded = demo("UTC");
  repositories.channels.put(seeded.channel);
  seeded.pools.forEach((pool) => repositories.pools.put(pool));
  seeded.media.forEach((item) => repositories.media.put(item));
  return { dataDir, repositories, seeded };
}

test("precomputes detected offsets for eligible local episodes but never probes placeholders", async () => {
  const { dataDir, repositories, seeded } = await fixture();
  const analyzer = {
    analyze: vi.fn(async () => ({
      offsetsMs: [448_500, 903_500],
      fallbackTargetIndexes: [],
    })),
  };
  const service = new ScheduleService(
    repositories,
    dataDir,
    () => new Date("2026-09-14T12:00:00.000Z"),
    async () => "/tmp/schedule.json",
    analyzer,
  );

  await service.generate(seeded.channel, "2026-09-14");
  expect(analyzer.analyze).not.toHaveBeenCalled();

  const local = {
    ...seeded.media.find((item) => item.id === "apartment-4b-1")!,
    source: "local-folder" as const,
    path: "/library/Apartment 4B S01E01.mp4",
  };
  repositories.media.put(local);
  for (const pool of repositories.pools.list()) {
    if (pool.kinds.includes("episode"))
      repositories.pools.put({ ...pool, mediaIds: [local.id] });
  }
  const generated = await service.generate(seeded.channel, "2026-09-15");
  expect(analyzer.analyze).toHaveBeenCalledTimes(1);
  expect(
    generated.ok &&
      generated.schedule.entries.find((entry) => entry.kind === "episode"),
  ).toMatchObject({
    contentDurationMs: 1_380_000,
    durationMs: 1_680_000,
    midrolls: [
      { offsetMs: 448_500, durationMs: 150_000 },
      { offsetMs: 903_500, durationMs: 150_000 },
    ],
  });
  repositories.close();
});
