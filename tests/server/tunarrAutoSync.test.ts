import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDatabase } from "../../src/db/database.js";
import {
  createRepositories,
  type Repositories,
} from "../../src/db/repositories.js";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";
import { TunarrClient } from "../../src/integrations/tunarr/client.js";
import { readSourceVersionSync } from "../../src/preparation/sourceVersion.js";
import {
  autoSyncTunarr,
  ensurePreparedCacheLibrary,
  readTunarrMapping,
  readTunarrMappingForChannel,
  readTunarrMappings,
  TUNARR_MAPPING_SETTING,
  type StoredTunarrMapping,
  upsertTunarrMapping,
} from "../../src/server/tunarrAutoSync.js";

const dirs: string[] = [];
const runFfmpeg = promisify(execFile);
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function localProgram(
  id: string,
  path: string,
  durationMs: number,
  /** Tunarr's own verdict, when it declares one for this program. */
  state?: string,
) {
  return {
    type: "content",
    id,
    duration: durationMs,
    ...(state ? { state } : {}),
    program: {
      uuid: "11111111-1111-4111-8111-111111111111",
      mediaItem: { locations: [{ type: "local", path }] },
    },
  };
}

/** A Tunarr channel valid against channelSchema, so the plan can find the mapped one. */
function tunarrChannel(id: string) {
  return {
    id,
    name: "MarkTV Laughs",
    number: 7,
    duration: 86_400_000,
    groupTitle: "MarkTV",
    guideMinimumDuration: 0,
    icon: {
      path: "",
      width: 0,
      duration: 0,
      position: "bottom-right" as const,
    },
    startTime: 0,
    stealth: false,
    offline: { mode: "pic" as const },
    onDemand: { enabled: false },
    streamMode: "hls" as const,
    transcodeConfigId: "11111111-1111-4111-8111-111111111111",
    disableFillerOverlay: false,
    subtitlesEnabled: false,
    programCount: 0,
  };
}

/** Stubs Tunarr: an inventory per library, and 200s for everything a sync touches. */
function stubTunarr(
  programsByLibrary: Record<string, unknown>,
  options: {
    fail?: boolean;
    record?: string[];
    /** Inventory served once a scan has been requested, modelling a stale scan. */
    rescanTo?: Record<string, unknown>;
    /** Set false to model a Tunarr that exposes no scannable source. */
    offerScan?: boolean;
    /** Active Tunarr sessions, so a sync can be blocked by a live viewer. */
    sessions?: unknown[];
    preparedCache?: { path: string; programs: unknown[] };
    sourceWrites?: unknown[];
  } = {},
) {
  let rescanned = false;
  let cacheCreated = false;
  let cacheScanned = false;
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    options.record?.push(`${init?.method ?? "GET"} ${url}`);
    if (options.fail) throw new TypeError("fetch failed");
    const ok = (body: unknown = {}) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/api/media-sources") && init?.method === "POST") {
      options.sourceWrites?.push(JSON.parse(String(init.body)));
      cacheCreated = true;
      return new Response(JSON.stringify({ id: "source-cache" }), { status: 201 });
    }
    if (url.endsWith("/api/media-sources"))
      return ok(
        options.offerScan === false
          ? []
          : [{ id: "source-a", libraries: [{ id: "lib-a" }] },
            ...(cacheCreated && options.preparedCache ? [{ id: "source-cache", type: "local",
              name: "MarkTV Prepared Cache", mediaType: "other_videos",
              paths: [options.preparedCache.path],
              libraries: [{ id: "lib-cache", externalKey: options.preparedCache.path }] }] : [])],
      );
    if (/\/libraries\/[^/]+\/scan$/.test(url)) {
      rescanned = true;
      if (url.includes("/lib-cache/")) cacheScanned = true;
      return new Response("", { status: 202 });
    }
    if (/\/api\/media-sources\/[^/]+\/[^/]+\/status$/.test(url))
      return ok({ state: "not_scanning" });
    if (url.endsWith("/api/system/health"))
      return ok({ database: { type: "healthy" } });
    if (url.endsWith("/api/version"))
      return ok({ tunarr: "1.3.14", ffmpeg: "7", nodejs: "22" });
    if (url.endsWith("/api/sessions")) return ok(options.sessions ?? []);
    // Creates must answer with an id -- the sync reads created.id, and an array
    // response leaves it undefined and fails the operation.
    if (url.endsWith("/api/filler-lists"))
      return init?.method === "POST" ? ok({ id: "created-filler" }) : ok([]);
    if (url.endsWith("/api/transcode_configs")) return ok([]);
    // The client throws UNSUPPORTED_SCHEMA if this one does not parse, so an
    // empty programming document has to be spelled out rather than [].
    if (/\/api\/channels\/[^/]+\/programming$/.test(url))
      return ok({
        totalPrograms: 0,
        programs: {},
        lineup: [],
        startTimeOffsets: [],
      });
    if (url.endsWith("/api/channels"))
      return init?.method === "POST"
        ? ok({ id: "created-channel" })
        : ok([tunarrChannel("tunarr-channel")]);
    // putChannel parses the response as a channel, so an empty object fails it.
    const channelPut = url.match(/\/api\/channels\/([^/]+)$/);
    if (channelPut && init?.method === "PUT")
      return ok(tunarrChannel(decodeURIComponent(channelPut[1])));
    const match = url.match(/\/api\/media-libraries\/([^/]+)\/programs$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (id === "lib-cache" && options.preparedCache)
        return ok(cacheScanned ? options.preparedCache.programs : []);
      const source =
        rescanned && options.rescanTo ? options.rescanTo : programsByLibrary;
      if (id in source) return ok(source[id]);
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }
    return ok();
  }) as typeof fetch;
  vi.stubGlobal("fetch", stub);
}

/**
 * A repository holding the demo channel plus a stored schedule whose every entry
 * has a real-looking media path, so the plan can match all of them.
 */
function setup(options: { pathFor?: (id: string) => string } = {}) {
  const pathFor = options.pathFor ?? ((id: string) => `/media/${id}.mkv`);
  const { channel, pools, media } = demo();
  const items = media.map((item) => ({ ...item, path: pathFor(item.id) }));
  // Mid-rolls are filled from distinct spots, so the demo's single filler of each
  // kind cannot satisfy a 150s break. Duplicate them into the pools that fill it.
  const poolForKind: Record<string, string> = {
    commercial: "ads",
    bumper: "bumpers",
    filler: "filler",
    "station-id": "ids",
  };
  for (const base of items.filter((item) => item.kind in poolForKind)) {
    for (let copy = 1; copy <= 8; copy += 1) {
      const id = `${base.id}-copy-${copy}`;
      items.push({
        ...base,
        id,
        title: `${base.title} copy ${copy}`,
        path: pathFor(id),
      });
      pools
        .find((pool) => pool.id === poolForKind[base.kind])
        ?.mediaIds.push(id);
    }
  }
  // No mid-roll policy: an exact-fill pod needs matched spots whose durations
  // sum precisely to each break, which is plan.ts's own concern and is covered
  // by its tests. What is under test here is the sync orchestration around it.
  const rollFree = {
    ...channel,
    slots: channel.slots.map((slot) => ({
      ...slot,
      episodeMidroll: undefined,
      movieMidroll: undefined,
    })),
  };
  const result = generateSchedule({
    channel: rollFree,
    pools,
    items,
    date: "2026-09-15",
    now: new Date("2026-09-14T13:00:00.000Z"),
  });
  if (!result.ok)
    throw new Error(
      `fixture schedule failed: ${JSON.stringify(result.issues)}`,
    );
  return { channel, pools, items, schedule: result.schedule };
}

async function repositoriesWithSchedule(
  fixture: ReturnType<typeof setup>,
  // `null` means "Tunarr was never configured"; omitting it configures one.
  mapping: Partial<StoredTunarrMapping> | null = {},
): Promise<Repositories> {
  const dir = await mkdtemp(join(realpathSync.native(tmpdir()), "marktv-autosync-"));
  dirs.push(dir);
  const repositories = createRepositories(openDatabase(dir));
  repositories.channels.put(fixture.channel);
  fixture.pools.forEach((pool) => repositories.pools.put(pool));
  fixture.items.forEach((item) => repositories.media.put(item));
  repositories.schedules.replaceSuccessful(
    fixture.channel.id,
    fixture.schedule,
  );
  if (mapping !== null)
    repositories.settings.put(TUNARR_MAPPING_SETTING, {
      libraryId: "lib-a",
      libraryIds: ["lib-a"],
      channelId: "tunarr-channel",
      createChannel: false,
      url: "http://tunarr.test",
      marktvChannelId: fixture.channel.id,
      ...mapping,
    });
  return repositories;
}

test("stores independent Tunarr mappings for each MarkTV channel", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const channel7: StoredTunarrMapping = {
    libraryId: "lib-a",
    libraryIds: ["lib-a"],
    channelId: "tunarr-channel-7",
    createChannel: false,
    url: "http://tunarr.test",
    marktvChannelId: "marktv-laughs",
    lastSync: {
      status: "synced",
      at: "2026-09-14T18:00:00.000Z",
      marktvChannelId: "marktv-laughs",
      scheduleId: "schedule-7",
    },
  };
  const channel9: StoredTunarrMapping = {
    ...channel7,
    channelId: "tunarr-channel-9",
    marktvChannelId: "marktv-cult-movies",
    lastSync: {
      status: "blocked",
      at: "2026-09-14T19:00:00.000Z",
      marktvChannelId: "marktv-cult-movies",
      scheduleId: "schedule-9",
    },
  };

  repositories.settings.put(TUNARR_MAPPING_SETTING, channel7);
  expect(readTunarrMappingForChannel(repositories, "marktv-laughs")).toEqual(
    channel7,
  );

  upsertTunarrMapping(repositories, channel9);

  expect(readTunarrMappings(repositories)).toEqual(
    expect.arrayContaining([channel7, channel9]),
  );
  expect(
    readTunarrMappingForChannel(repositories, "marktv-laughs")?.lastSync,
  ).toEqual(channel7.lastSync);
  expect(
    readTunarrMappingForChannel(repositories, "marktv-cult-movies"),
  ).toEqual(channel9);
  repositories.close();
});

const now = () => new Date("2026-09-14T18:00:00.000Z");

test("syncs the generated schedule and records the outcome", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  stubTunarr(
    {
      "lib-a": fixture.items.map((item) =>
        localProgram(item.id, item.path!, item.durationMs ?? 60_000),
      ),
    },
    { record: calls },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect(outcome.status).toBe("synced");
  expect(outcome.scheduleId).toBe(fixture.schedule.id);
  expect(outcome.programCount).toBeGreaterThan(0);
  expect(calls.some((call) => call.includes("/programming"))).toBe(true);
  // Recorded, so the page can show it without re-deriving anything.
  expect(readTunarrMapping(repositories)?.lastSync).toMatchObject({
    status: "synced",
    scheduleId: fixture.schedule.id,
  });
  repositories.close();
});

test("registers a dedicated bounded cache source once and syncs its prepared path", async () => {
  const fixture = setup();
  const entry = fixture.schedule.entries.find((candidate) => candidate.mediaId)!;
  const item = fixture.items.find((candidate) => candidate.id === entry.mediaId)!;
  const directory = await mkdtemp(join(tmpdir(), "marktv-sync-prepared-"));
  dirs.push(directory);
  const originalPath = join(directory, "original.mkv");
  await writeFile(originalPath, "source");
  const source = readSourceVersionSync(originalPath);
  Object.assign(item, { source: "local-folder", path: originalPath,
    fileSizeBytes: source.sizeBytes, fileModifiedMs: source.modifiedMs,
    deviceId: source.deviceId, inode: source.inode });
  const repositories = await repositoriesWithSchedule(fixture);
  await mkdir(repositories.preparation.cacheDirectory, { recursive: true });
  const renditionId = "a".repeat(64);
  const preparedPath = join(repositories.preparation.cacheDirectory, `${renditionId}.mp4`);
  await runFfmpeg("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", preparedPath]);
  fixture.schedule.entries = fixture.schedule.entries.map((candidate) =>
    candidate.mediaId === item.id ? { ...candidate, path: preparedPath } : candidate);
  repositories.schedules.replaceSuccessful(fixture.channel.id, fixture.schedule);
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-14T12:00:00Z" });
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-14T12:01:00Z" });
  const claimed = repositories.preparation.claimNext(() => source)!;
  repositories.preparation.complete({ id: claimed.id, attempt: claimed.attempt }, {
    classification: "needs_remux",
    rendition: { id: renditionId, path: preparedPath, profile: "fixture", mode: "remux",
      validatedAt: "2026-09-14T12:02:00Z", validation: { metadata: {
        status: "passed", durationSeconds: 1, selectedAudioTrackIndex: null }, fullDecode: { status: "passed" } } },
  }, source);
  const calls: string[] = [];
  const sourceWrites: unknown[] = [];
  const cacheProgram = localProgram(`prepared-${item.id}`, preparedPath, item.durationMs ?? 60_000);
  stubTunarr({ "lib-a": fixture.items.map((candidate) =>
    localProgram(candidate.id, candidate.path!, candidate.durationMs ?? 60_000)) },
    { record: calls, sourceWrites, preparedCache: { path: repositories.preparation.cacheDirectory,
      programs: [{ ...cacheProgram, program: { ...cacheProgram.program, type: "other_video" } }] } });

  const outcome = await autoSyncTunarr(repositories, { channelId: fixture.channel.id, now });
  expect(outcome.status).toBe("synced");
  expect(readTunarrMapping(repositories)?.plan?.matchCounts.unmatched).toBe(0);
  expect(readTunarrMapping(repositories)?.libraryIds).toEqual(["lib-a", "lib-cache"]);
  expect(calls.filter((call) => call === "POST http://tunarr.test/api/media-sources")).toHaveLength(1);
  expect(sourceWrites).toEqual([{ type: "local", name: "MarkTV Prepared Cache", mediaType: "other_videos",
    paths: [repositories.preparation.cacheDirectory], pathReplacements: [] }]);
  expect(calls.filter((call) => call.endsWith("/libraries/lib-a/scan"))).toHaveLength(0);
  const repeated = await autoSyncTunarr(repositories, { channelId: fixture.channel.id, now });
  expect(repeated.status).toBe("synced");
  expect(calls.filter((call) => call === "POST http://tunarr.test/api/media-sources")).toHaveLength(1);
  repositories.close();
}, 15_000);

test("refuses a conflicting cache source without creating or rewriting Tunarr sources", async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify([{ id: "other", type: "local", name: "MarkTV Prepared Cache",
      mediaType: "other_videos", paths: ["/different/cache"], libraries: [] }]));
  }) as typeof fetch;
  const client = new TunarrClient("http://tunarr.test", fetcher);
  await expect(ensurePreparedCacheLibrary(client, "/expected/cache")).rejects.toThrow("prepared_cache_source_conflict");
  expect(calls).toEqual(["GET http://tunarr.test/api/media-sources"]);
});

test("refuses a stored schedule containing a version-matched quarantine before contacting Tunarr", async () => {
  const fixture = setup();
  const entry = fixture.schedule.entries.find((candidate) => candidate.mediaId)!;
  const item = fixture.items.find((candidate) => candidate.id === entry.mediaId)!;
  const directory = await mkdtemp(join(tmpdir(), "marktv-sync-quarantine-"));
  dirs.push(directory);
  const path = join(directory, "bad.mkv");
  await writeFile(path, "corrupt fixture");
  const source = readSourceVersionSync(path);
  Object.assign(item, { source: "local-folder", path,
    fileSizeBytes: source.sizeBytes, fileModifiedMs: source.modifiedMs,
    deviceId: source.deviceId, inode: source.inode });
  fixture.schedule.entries = fixture.schedule.entries.map((candidate) =>
    candidate.mediaId === item.id ? { ...candidate, path } : candidate);
  const repositories = await repositoriesWithSchedule(fixture);
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-14T12:00:00Z" });
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-14T12:01:00Z" });
  const claimed = repositories.preparation.claimNext(() => source)!;
  repositories.preparation.complete({ id: claimed.id, attempt: claimed.attempt },
    { classification: "quarantined", failureKind: "decode_corruption" }, source);
  const fetchStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);

  const outcome = await autoSyncTunarr(repositories, { channelId: fixture.channel.id, now });
  expect(outcome).toMatchObject({ status: "blocked", blockingErrors: 1 });
  expect(fetchStub).not.toHaveBeenCalled();
  repositories.close();
});

test("refuses an unresolved scheduled media ID before contacting Tunarr", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const missingId = fixture.schedule.entries.find((entry) => entry.kind !== "flex")!.mediaId!;
  repositories.media.remove(missingId);
  const fetchStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
  const outcome = await autoSyncTunarr(repositories, { channelId: fixture.channel.id, now });
  expect(outcome).toMatchObject({ status: "blocked", blockingErrors: 1 });
  expect(outcome.message).toContain(missingId);
  expect(fetchStub).not.toHaveBeenCalled();
  repositories.close();
});

test("does nothing when Tunarr has never been configured", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture, null);
  const calls: string[] = [];
  stubTunarr({}, { record: calls });

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect(outcome).toMatchObject({ status: "skipped" });
  expect(outcome.message).toMatch(/configured/i);
  expect(calls).toEqual([]);
  expect(readTunarrMapping(repositories)).toBeUndefined();
  repositories.close();
});

test("refuses a lineup with media Tunarr cannot resolve, and applies nothing", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  // Inventory deliberately missing one scheduled item, and no scannable source,
  // so the rescan cannot rescue it and the refusal has to stand.
  stubTunarr(
    {
      "lib-a": fixture.items
        .slice(1)
        .map((item) =>
          localProgram(item.id, item.path!, item.durationMs ?? 60_000),
        ),
    },
    { record: calls, offerScan: false },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect({ status: outcome.status, message: outcome.message }).toMatchObject({
    status: "blocked",
  });
  expect(outcome.blockingErrors).toBeGreaterThan(0);
  // The gate is the point: nothing was written to Tunarr.
  expect(
    calls.some((call) => call.startsWith("PUT") || call.startsWith("POST")),
  ).toBe(false);
  expect(readTunarrMapping(repositories)?.lastSync?.status).toBe("blocked");
  repositories.close();
});

test("blocks when the only Tunarr match is a program Tunarr cannot play", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  // Every absolute path still matches, so a path-only plan would be eligible -
  // and would push a lineup whose programs Tunarr has marked missing.
  stubTunarr(
    {
      "lib-a": fixture.items.map((item) =>
        localProgram(item.id, item.path!, item.durationMs ?? 60_000, "missing"),
      ),
    },
    { record: calls, offerScan: false },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect(outcome.status).toBe("blocked");
  expect(outcome.message).toMatch(/cannot be played/);
  expect(outcome.blockingErrors).toBeGreaterThan(0);
  expect(
    calls.some((call) => call.startsWith("PUT") || call.startsWith("POST")),
  ).toBe(false);
  expect(readTunarrMapping(repositories)?.lastSync?.status).toBe("blocked");
  repositories.close();
});

test("an unreachable Tunarr records a failure instead of throwing", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  stubTunarr({}, { fail: true });

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect({ status: outcome.status, message: outcome.message }).toMatchObject({
    status: "failed",
  });
  expect(outcome.message).toBeTruthy();
  expect(readTunarrMapping(repositories)?.lastSync?.status).toBe("failed");
  repositories.close();
});

test("only the mapped channel is pushed", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  stubTunarr(
    {
      "lib-a": fixture.items.map((item) =>
        localProgram(item.id, item.path!, item.durationMs ?? 60_000),
      ),
    },
    { record: calls },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: "some-other-channel",
    now,
  });

  expect(outcome).toMatchObject({ status: "skipped" });
  expect(calls).toEqual([]);
  repositories.close();
});

test("automatic sync can be turned off without losing the mapping", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture, {
    autoSync: false,
  });
  const calls: string[] = [];
  stubTunarr(
    {
      "lib-a": fixture.items.map((item) =>
        localProgram(item.id, item.path!, item.durationMs ?? 60_000),
      ),
    },
    { record: calls },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect(outcome).toMatchObject({ status: "skipped" });
  expect(calls).toEqual([]);
  const stored = readTunarrMapping(repositories);
  expect(stored?.url).toBe("http://tunarr.test");
  expect(stored?.autoSync).toBe(false);
  repositories.close();
});

test("rescans Tunarr and retries once when a stale inventory blocks the plan", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  const complete = fixture.items.map((item) =>
    localProgram(item.id, item.path!, item.durationMs ?? 60_000),
  );
  stubTunarr(
    // Stale, exactly as a library scanned before the newest files were added.
    { "lib-a": complete.slice(1) },
    { record: calls, rescanTo: { "lib-a": complete } },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect(outcome.status).toBe("synced");
  expect(
    calls.some((call) => call.startsWith("POST") && call.endsWith("/scan")),
  ).toBe(true);
  repositories.close();
}, 30_000);

test("blocks without mutating while the mapped channel has active viewers", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  stubTunarr(
    {
      "lib-a": fixture.items.map((item) =>
        localProgram(item.id, item.path!, item.durationMs ?? 60_000),
      ),
    },
    {
      record: calls,
      sessions: [{ channelId: "tunarr-channel", numConnections: 1 }],
    },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect(outcome.status).toBe("blocked");
  expect(outcome.message).toMatch(/viewer/i);
  // The guard runs before the first mutation, so a live viewer keeps watching.
  expect(
    calls.some((call) => call.startsWith("PUT") || call.startsWith("POST")),
  ).toBe(false);
  const stored = readTunarrMapping(repositories);
  expect(stored?.lastSync?.status).toBe("blocked");
  // The plan is kept so a retry can apply it once the viewer leaves.
  expect(stored?.plan).toBeTruthy();
  repositories.close();
});
