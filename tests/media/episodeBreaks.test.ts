import { expect, test, vi } from "vitest";

test("chooses the nearest conservative black transition for each target", async () => {
  const module = await import("../../src/media/episodeBreaks.js").catch(
    () => ({}) as Record<string, unknown>,
  );
  expect(module.selectEpisodeBreakOffsets).toBeTypeOf("function");
  const select = module.selectEpisodeBreakOffsets as unknown as (
    input: unknown,
  ) => unknown;
  expect(
    select({
      durationMs: 1_380_000,
      targetsMs: [450_000, 900_000],
      searchWindowMs: 90_000,
      minimumSegmentMs: 120_000,
      tailBufferMs: 120_000,
      candidates: [
        { startMs: 420_000, endMs: 420_500 },
        { startMs: 448_000, endMs: 449_000 },
        { startMs: 903_000, endMs: 904_000 },
        { startMs: 960_000, endMs: 960_400 },
      ],
    }),
  ).toEqual({
    offsetsMs: [448_500, 903_500],
    fallbackTargetIndexes: [],
  });
});

test("falls back deterministically when no safe black transition is available", async () => {
  const module = await import("../../src/media/episodeBreaks.js").catch(
    () => ({}) as Record<string, unknown>,
  );
  expect(module.selectEpisodeBreakOffsets).toBeTypeOf("function");
  const select = module.selectEpisodeBreakOffsets as unknown as (
    input: unknown,
  ) => unknown;
  expect(
    select({
      durationMs: 1_380_000,
      targetsMs: [450_000, 900_000],
      searchWindowMs: 90_000,
      minimumSegmentMs: 120_000,
      tailBufferMs: 120_000,
      candidates: [{ startMs: 1_100_000, endMs: 1_100_500 }],
    }),
  ).toEqual({
    offsetsMs: [450_000, 900_000],
    fallbackTargetIndexes: [0, 1],
  });
});

test("caches ffmpeg black detection by stable file identity and policy", async () => {
  const module = await import("../../src/media/episodeBreaks.js").catch(
    () => ({}) as Record<string, unknown>,
  );
  expect(module.EpisodeBreakAnalyzer).toBeTypeOf("function");
  const cache = new Map<string, unknown>();
  const runner = vi.fn(async (_file: string, args: readonly string[]) => {
    const startSeconds = Number(args[args.indexOf("-ss") + 1]);
    return {
      stdout: "",
      stderr:
        startSeconds < 400
          ? "[blackdetect] black_start:88 black_end:90 black_duration:2"
          : "[blackdetect] black_start:87 black_end:89 black_duration:2",
    };
  });
  const stat = vi.fn(async () => ({ size: 123_456, mtimeMs: 789_000 }));
  const Analyzer = module.EpisodeBreakAnalyzer as unknown as new (
    input: unknown,
  ) => { analyze: (item: unknown, policy: unknown) => Promise<unknown> };
  const analyzer = new Analyzer({
    runner,
    stat,
    cache: {
      get: (key: string) => cache.get(key),
      put: (key: string, value: unknown) => cache.set(key, value),
    },
  });
  const item = {
    id: "roseanne-s01e01",
    source: "local-folder",
    path: "/library/Roseanne S01E01.mp4",
    kind: "episode",
    title: "Life and Stuff",
    durationMs: 1_380_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  };
  const policy = {
    targetMinutes: [7.5, 15],
    searchWindowMinutes: 1.5,
    breakMinutes: 2.5,
    minimumSegmentMinutes: 2,
    tailBufferMinutes: 2,
  };

  const first = await analyzer.analyze(item, policy);
  const second = await analyzer.analyze(item, policy);

  expect(first).toEqual({
    offsetsMs: [449_000, 898_000],
    fallbackTargetIndexes: [],
  });
  expect(second).toEqual(first);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls[0][1]).toContain(
    "setpts=PTS-STARTPTS,blackdetect=d=0.05:pic_th=0.90:pix_th=0.10",
  );
  expect(runner.mock.calls[0][1]).toContain("-nostdin");
  expect(stat).toHaveBeenCalledTimes(2);
  expect(cache.size).toBe(1);
});

test("keeps a successful break candidate when another analysis window fails without caching the failure", async () => {
  const { EpisodeBreakAnalyzer } =
    await import("../../src/media/episodeBreaks.js");
  const cache = new Map<string, unknown>();
  let calls = 0;
  const analyzer = new EpisodeBreakAnalyzer({
    stat: async () => ({ size: 1, mtimeMs: 2 }),
    runner: async () => {
      calls += 1;
      if (calls === 2) throw new Error("ffmpeg failed");
      return {
        stdout: "",
        stderr: "[blackdetect] black_start:88 black_end:90 black_duration:2",
      };
    },
    cache: {
      get: (key) => cache.get(key),
      put: (key, value) => cache.set(key, value),
    },
  });
  const result = await analyzer.analyze(
    {
      id: "episode",
      source: "local-folder",
      path: "/library/episode.mp4",
      kind: "episode",
      title: "Episode",
      durationMs: 1_380_000,
      durationStatus: "ok",
      available: true,
      tags: [],
    },
    {
      targetMinutes: [7.5, 15],
      searchWindowMinutes: 1.5,
      breakMinutes: 2.5,
      minimumSegmentMinutes: 2,
      tailBufferMinutes: 2,
    },
  );
  expect(result).toEqual({
    offsetsMs: [449_000, 900_000],
    fallbackTargetIndexes: [1],
  });
  expect(cache.size).toBe(0);
});
