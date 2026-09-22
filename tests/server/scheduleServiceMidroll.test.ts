import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { demo } from "../../src/demo/marktvLaughs.js";
import { ScheduleService } from "../../src/server/scheduleService.js";
import type { ContinuityPreparer } from "../../src/continuity/prepare.js";
import {
  appendContinuityDecision,
  readContinuityHistory,
} from "../../src/continuity/history.js";

test("runs the injected offline preparation before applying continuity, and survives its failure", async () => {
  const { dataDir, repositories, seeded } = await fixture();
  const calls: Array<{ scheduleId: string; poolCount: number }> = [];
  const preparer: ContinuityPreparer = async (input) => {
    calls.push({
      scheduleId: input.schedule.id,
      poolCount: (input.pools ?? []).length,
    });
    return {
      media: input.media,
      prepared: [],
      diagnostics: [{ code: "TEST_PREPARE", message: "offline preparation ran" }],
      rasterSupported: false,
    };
  };
  const service = new ScheduleService(
    repositories,
    dataDir,
    () => new Date("2026-09-16T12:00:00.000Z"),
    async () => "/tmp/schedule.json",
    undefined,
    preparer,
    "/tmp/repo-root",
  );
  const generated = await service.generate(seeded.channel, "2026-09-16");
  expect(generated.ok).toBe(true);
  if (!generated.ok) return;
  // Preparation sees the finished schedule and the channel's own pools, and its
  // diagnostics travel with the generated schedule.
  expect(calls).toEqual([
    { scheduleId: generated.schedule.id, poolCount: seeded.pools.length },
  ]);
  expect(generated.schedule.diagnostics).toContainEqual(
    expect.objectContaining({ code: "TEST_PREPARE" }),
  );

  // A preparation failure is a diagnostic, never a failed generation: the
  // ordinary schedule must still be produced.
  const failing = new ScheduleService(
    repositories,
    dataDir,
    () => new Date("2026-09-17T12:00:00.000Z"),
    async () => "/tmp/schedule.json",
    undefined,
    async () => {
      throw new Error("render exploded");
    },
    "/tmp/repo-root",
  );
  const stillGenerated = await failing.generate(seeded.channel, "2026-09-17");
  expect(stillGenerated.ok).toBe(true);
  if (!stillGenerated.ok) return;
  expect(stillGenerated.schedule.diagnostics).toContainEqual(
    expect.objectContaining({ code: "CONTINUITY_SKIPPED" }),
  );
});

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

test("analyzes selected local episodes but skips eligible episodes from inactive slots", async () => {
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
  const inactive = {
    ...local,
    id: "inactive-local-episode",
    title: "Inactive local episode",
    path: "/library/Inactive local episode.mp4",
  };
  repositories.media.put(inactive);
  for (const pool of repositories.pools.list()) {
    if (pool.kinds.includes("episode"))
      repositories.pools.put({ ...pool, mediaIds: [local.id] });
  }
  repositories.pools.put({
    id: "inactive-episodes",
    name: "Inactive episodes",
    kinds: ["episode"],
    mediaIds: [inactive.id],
    mode: "shuffle",
    noRepeatMinutes: 0,
    weight: 1,
  });
  const generated = await service.generate(
    {
      ...seeded.channel,
      slots: [
        ...seeded.channel.slots,
        {
          id: "inactive-slot",
          days: [0],
          time: "23:59",
          poolIds: ["inactive-episodes"],
          kind: "episode",
          fallbackPoolIds: [],
          episodeMidroll: {
            targetMinutes: [7.5, 15],
            searchWindowMinutes: 1.5,
            breakMinutes: 2.5,
            minimumSegmentMinutes: 2,
            tailBufferMinutes: 2,
          },
        },
      ],
    },
    "2026-09-15",
  );
  expect(analyzer.analyze).toHaveBeenCalledTimes(1);
  expect(analyzer.analyze).toHaveBeenCalledWith(
    expect.objectContaining({ id: local.id }),
    expect.anything(),
  );
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

test("analyzes eligible episodes one at a time", async () => {
  const { dataDir, repositories, seeded } = await fixture();
  const first = {
    ...seeded.media.find((item) => item.id === "apartment-4b-1")!,
    source: "local-folder" as const,
    path: "/library/Apartment 4B S01E01.mp4",
  };
  const second = {
    ...seeded.media.find((item) => item.id === "apartment-4b-2")!,
    source: "local-folder" as const,
    path: "/library/Apartment 4B S01E02.mp4",
  };
  repositories.media.put(first);
  repositories.media.put(second);
  for (const pool of repositories.pools.list()) {
    if (pool.kinds.includes("episode"))
      repositories.pools.put({ ...pool, mediaIds: [first.id, second.id] });
  }

  let inFlight = 0;
  let maxInFlight = 0;
  const analyzer = {
    analyze: vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return {
        offsetsMs: [448_500, 903_500],
        fallbackTargetIndexes: [],
      };
    }),
  };
  const service = new ScheduleService(
    repositories,
    dataDir,
    () => new Date("2026-09-16T12:00:00.000Z"),
    async () => "/tmp/schedule.json",
    analyzer,
  );

  const generated = await service.generate(seeded.channel, "2026-09-16");

  expect(generated.ok).toBe(true);
  expect(analyzer.analyze.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(maxInFlight).toBe(1);
  repositories.close();
});

test("applies enabled continuity only while generating a new schedule", async () => {
  const { dataDir, repositories, seeded } = await fixture();
  for (const item of repositories.media.list()) {
    if (item.kind !== "episode") continue;
    repositories.media.put({
      ...item,
      source: "local-folder",
      path: `/library/${item.id}.mp4`,
    });
  }
  repositories.settings.put(`continuity:${seeded.channel.id}:config`, {
    enabled: true,
    stagedInterruptionsEnabled: false,
    promoFrequency: 1,
    clipCooldownMinutes: 60,
    targetCooldownMinutes: 30,
    oddPersonaCooldownHours: 6,
    maximumSpokenElementsPerBreak: 2,
    maximumContinuitySecondsPerBreak: 20,
  });
  appendContinuityDecision(repositories, seeded.channel.id, {
    id: "obsolete-plan",
    state: "planned",
    assetId: "obsolete-bumper",
    personaId: "local",
    scheduleRevision: "obsolete-schedule",
    plannedAt: "2026-09-15T12:00:00.000Z",
  });
  repositories.media.put({
    id: "continuity-next-generic",
    source: "local-folder",
    kind: "bumper",
    title: "marktv-up-next-generic",
    path: "/library/continuity-next-generic.mp4",
    durationMs: 15_000,
    durationStatus: "ok",
    available: true,
    tags: ["visual-only"],
  });
  repositories.media.put({
    id: "exact-fit-commercial",
    source: "placeholder",
    kind: "commercial",
    title: "Exact fit commercial",
    durationMs: 15_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  });
  const adPool = repositories.pools.get("ads")!;
  repositories.pools.put({
    ...adPool,
    mediaIds: [...adPool.mediaIds, "exact-fit-commercial"],
  });
  const service = new ScheduleService(
    repositories,
    dataDir,
    () => new Date("2026-09-16T12:00:00.000Z"),
    async () => "/tmp/schedule.json",
  );

  const generated = await service.generate(seeded.channel, "2026-09-16");

  expect(generated.ok).toBe(true);
  if (!generated.ok) throw new Error("schedule generation failed");
  expect(generated.schedule.entries).toContainEqual(
    expect.objectContaining({
      mediaId: "continuity-next-generic",
      source: "continuity:next",
    }),
  );
  expect(generated.schedule.diagnostics).toContainEqual(
    expect.objectContaining({ code: "CONTINUITY_PLANNED" }),
  );
  const history = readContinuityHistory(repositories, seeded.channel.id);
  expect(history).not.toContainEqual(
    expect.objectContaining({ id: "obsolete-plan" }),
  );
  expect(history).toContainEqual(
    expect.objectContaining({
      state: "planned",
      assetId: expect.stringContaining("continuity-next-generic"),
      scheduleRevision: generated.schedule.id,
    }),
  );
  repositories.close();
});
