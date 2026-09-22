import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database.js";
import {
  createRepositories,
  type Repositories,
} from "../../src/db/repositories.js";
import { demo } from "../../src/demo/marktvLaughs.js";
import { generateSchedule } from "../../src/scheduler/generate.js";
import {
  autoSyncTunarr,
  readTunarrMapping,
  readTunarrMappingForChannel,
  readTunarrMappings,
  TUNARR_MAPPING_SETTING,
  type StoredTunarrMapping,
  upsertTunarrMapping,
} from "../../src/server/tunarrAutoSync.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function localProgram(id: string, path: string, durationMs: number) {
  return {
    type: "content",
    id,
    duration: durationMs,
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
    icon: { path: "", width: 0, duration: 0, position: "bottom-right" as const },
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
  } = {},
) {
  let rescanned = false;
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    options.record?.push(`${init?.method ?? "GET"} ${url}`);
    if (options.fail) throw new TypeError("fetch failed");
    const ok = (body: unknown = {}) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/api/media-sources"))
      return ok(
        options.offerScan === false
          ? []
          : [{ id: "source-a", libraries: [{ id: "lib-a" }] }],
      );
    if (/\/libraries\/[^/]+\/scan$/.test(url)) {
      rescanned = true;
      return new Response("", { status: 202 });
    }
    if (/\/api\/media-sources\/[^/]+\/[^/]+\/status$/.test(url))
      return ok({ state: "not_scanning" });
    if (url.endsWith("/api/system/health")) return ok({ database: { type: "healthy" } });
    if (url.endsWith("/api/version")) return ok({ tunarr: "1.3.14", ffmpeg: "7", nodejs: "22" });
    // Creates must answer with an id -- the sync reads created.id, and an array
    // response leaves it undefined and fails the operation.
    if (url.endsWith("/api/filler-lists"))
      return init?.method === "POST" ? ok({ id: "created-filler" }) : ok([]);
    if (url.endsWith("/api/transcode_configs")) return ok([]);
    // The client throws UNSUPPORTED_SCHEMA if this one does not parse, so an
    // empty programming document has to be spelled out rather than [].
    if (/\/api\/channels\/[^/]+\/programming$/.test(url))
      return ok({ totalPrograms: 0, programs: {}, lineup: [], startTimeOffsets: [] });
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
      const source =
        rescanned && options.rescanTo ? options.rescanTo : programsByLibrary;
      if (id in source) return ok(source[id]);
      return new Response(JSON.stringify({ error: "missing" }), { status: 404 });
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
      items.push({ ...base, id, title: `${base.title} copy ${copy}`, path: pathFor(id) });
      pools.find((pool) => pool.id === poolForKind[base.kind])?.mediaIds.push(id);
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
  if (!result.ok) throw new Error(`fixture schedule failed: ${JSON.stringify(result.issues)}`);
  return { channel, pools, items, schedule: result.schedule };
}

async function repositoriesWithSchedule(
  fixture: ReturnType<typeof setup>,
  // `null` means "Tunarr was never configured"; omitting it configures one.
  mapping: Partial<StoredTunarrMapping> | null = {},
): Promise<Repositories> {
  const dir = await mkdtemp(join(tmpdir(), "marktv-autosync-"));
  dirs.push(dir);
  const repositories = createRepositories(openDatabase(dir));
  repositories.channels.put(fixture.channel);
  fixture.pools.forEach((pool) => repositories.pools.put(pool));
  fixture.items.forEach((item) => repositories.media.put(item));
  repositories.schedules.replaceSuccessful(fixture.channel.id, fixture.schedule);
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
    { "lib-a": fixture.items.map((item) => localProgram(item.id, item.path!, item.durationMs ?? 60_000)) },
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
    { "lib-a": fixture.items.slice(1).map((item) => localProgram(item.id, item.path!, item.durationMs ?? 60_000)) },
    { record: calls, offerScan: false },
  );

  const outcome = await autoSyncTunarr(repositories, {
    channelId: fixture.channel.id,
    now,
  });

  expect({ status: outcome.status, message: outcome.message }).toMatchObject({ status: "blocked" });
  expect(outcome.blockingErrors).toBeGreaterThan(0);
  // The gate is the point: nothing was written to Tunarr.
  expect(calls.some((call) => call.startsWith("PUT") || call.startsWith("POST"))).toBe(false);
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

  expect({ status: outcome.status, message: outcome.message }).toMatchObject({ status: "failed" });
  expect(outcome.message).toBeTruthy();
  expect(readTunarrMapping(repositories)?.lastSync?.status).toBe("failed");
  repositories.close();
});

test("only the mapped channel is pushed", async () => {
  const fixture = setup();
  const repositories = await repositoriesWithSchedule(fixture);
  const calls: string[] = [];
  stubTunarr(
    { "lib-a": fixture.items.map((item) => localProgram(item.id, item.path!, item.durationMs ?? 60_000)) },
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
  const repositories = await repositoriesWithSchedule(fixture, { autoSync: false });
  const calls: string[] = [];
  stubTunarr(
    { "lib-a": fixture.items.map((item) => localProgram(item.id, item.path!, item.durationMs ?? 60_000)) },
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

