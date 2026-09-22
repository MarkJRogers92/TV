import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { demo } from "../../src/demo/marktvLaughs.js";
import type { Schedule } from "../../src/domain/models.js";
import {
  readTunarrMapping,
  readTunarrMappingForChannel,
  readTunarrMappings,
  TUNARR_MAPPING_SETTING,
  type StoredTunarrMapping,
} from "../../src/server/tunarrAutoSync.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "marktv-tunarr-routes-"));
  directories.push(dir);
  return dir;
}

test("returns stable 4xx/503 responses instead of exposing Tunarr failures", async () => {
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  const missingPlan = await app.inject({
    method: "POST",
    url: "/api/v1/tunarr/sync",
  });
  expect(missingPlan.statusCode).toBe(409);
  expect(missingPlan.json()).toEqual({ code: "STALE_DRY_RUN" });
  const unavailable = await app.inject({
    method: "POST",
    url: "/api/v1/tunarr/test",
    payload: { url: "http://127.0.0.1:1", channelId: "7" },
  });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json()).toMatchObject({ code: "UNREACHABLE" });
  await app.close();
});

function stubTunarr(programsByLibrary: Record<string, unknown>) {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/system/health"))
      return new Response(JSON.stringify({ database: { type: "healthy" } }), {
        status: 200,
      });
    if (url.endsWith("/api/version"))
      return new Response(
        JSON.stringify({ tunarr: "1.3.14", ffmpeg: "7", nodejs: "22" }),
        { status: 200 },
      );
    if (url.endsWith("/api/channels"))
      return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/filler-lists"))
      return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/transcode_configs"))
      return new Response(JSON.stringify([]), { status: 200 });
    const match = url.match(/\/api\/media-libraries\/([^/]+)\/programs$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (id in programsByLibrary)
        return new Response(JSON.stringify(programsByLibrary[id]), {
          status: 200,
        });
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify({ error: "missing" }), {
      status: 404,
    });
  }) as typeof fetch;
  vi.stubGlobal("fetch", stub);
}

function localProgram(id: string, path: string) {
  return {
    type: "content",
    id,
    duration: 60_000,
    program: {
      uuid: "11111111-1111-4111-8111-111111111111",
      mediaItem: { locations: [{ type: "local", path }] },
    },
  };
}

const TRANSCODE_CONFIG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    transcodeConfigId: TRANSCODE_CONFIG_ID,
    disableFillerOverlay: false,
    subtitlesEnabled: false,
    programCount: 0,
  };
}

function programEntry(id: string, path: string, start: string) {
  return {
    id,
    start,
    end: new Date(Date.parse(start) + 60_000).toISOString(),
    localStart: "00:00",
    localEnd: "00:01",
    durationMs: 60_000,
    kind: "episode" as const,
    title: id,
    mediaId: `media-${id}`,
    path,
    source: "local-folder" as const,
  };
}

function scheduleFor(
  id: string,
  date: string,
  entries: Schedule["entries"],
): Schedule {
  return {
    id,
    channelId: "marktv-laughs",
    channelName: "MarkTV Laughs",
    channelNumber: 7,
    date,
    timezone: "America/Chicago",
    seed: `marktv-laughs:${date}`,
    revision: "test",
    generatedAt: `${date}T00:00:00.000Z`,
    durationMs: entries.reduce((total, entry) => total + entry.durationMs, 0),
    entries,
    diagnostics: [],
  };
}

async function readStoredMapping(dir: string) {
  const repositories = createRepositories(openDatabase(dir));
  try {
    return readTunarrMapping(repositories) as
      | Record<string, unknown>
      | undefined;
  } finally {
    repositories.close();
  }
}

/**
 * A Tunarr that supports the whole existing-channel sync path. The plan fixture
 * has one episode pointing at `/media/A.mkv`, so the applied lineup's first
 * content id identifies which schedule reached Tunarr.
 */
function stubSyncTunarr(
  options: {
    sessions?: unknown[];
    record?: string[];
    onProgramming?: (body: { lineup?: Array<{ id?: string }> }) => void;
  } = {},
) {
  const programmingDoc = {
    totalPrograms: 0,
    programs: {},
    lineup: [],
    startTimeOffsets: [],
  };
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    options.record?.push(`${init?.method ?? "GET"} ${url}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/api/sessions")) return json(options.sessions ?? []);
    if (url.endsWith("/api/system/health"))
      return json({ database: { type: "healthy" } });
    if (url.endsWith("/api/version"))
      return json({ tunarr: "1.3.14", ffmpeg: "7", nodejs: "22" });
    if (/\/api\/channels\/[^/]+\/programming$/.test(url)) {
      if (init?.method === "POST")
        options.onProgramming?.(JSON.parse(String(init.body)));
      return json(programmingDoc);
    }
    if (url.endsWith("/api/channels")) {
      return init?.method === "POST"
        ? json(tunarrChannel("created-channel"))
        : json([tunarrChannel("tunarr-channel")]);
    }
    if (url.endsWith("/api/filler-lists")) {
      return init?.method === "POST"
        ? json({ id: "created-filler" })
        : json([]);
    }
    if (url.endsWith("/api/transcode_configs"))
      return json([{ id: TRANSCODE_CONFIG_ID }]);
    const put = url.match(/\/api\/channels\/([^/]+)$/);
    if (put && init?.method === "PUT")
      return json(tunarrChannel(decodeURIComponent(put[1])));
    const library = url.match(/\/api\/media-libraries\/([^/]+)\/programs$/);
    if (library)
      return json([
        localProgram("a1", "/media/A.mkv"),
        localProgram("b1", "/media/B.mkv"),
      ]);
    return json({});
  }) as typeof fetch;
  vi.stubGlobal("fetch", stub);
}

test("accepts multiple libraryIds and aggregates inventory for connection test", async () => {
  stubTunarr({
    "lib-a": [localProgram("a1", "/media/A.mkv")],
    "lib-b": [localProgram("b1", "/media/B.mkv")],
  });
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/test",
      payload: { url: "http://fake", libraryIds: ["lib-a", "lib-b"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supportsInventory: true });
  } finally {
    await app.close();
  }
});

test("trims and deduplicates library IDs into canonical form", async () => {
  stubTunarr({
    "lib-a": [localProgram("a1", "/media/A.mkv")],
    "lib-b": [localProgram("b1", "/media/B.mkv")],
  });
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/test",
      payload: {
        url: "http://fake",
        libraryIds: [" lib-a ", "lib-a", "lib-b "],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supportsInventory: true });
  } finally {
    await app.close();
  }
});

test("keeps legacy singular libraryId backward compatible for dry-run validation", async () => {
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const legacy = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: { url: "http://127.0.0.1:1", libraryId: "lib" },
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({ code: "NO_SCHEDULE" });
    const canonical = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: { url: "http://127.0.0.1:1", libraryIds: ["lib"] },
    });
    expect(canonical.statusCode).toBe(409);
    expect(canonical.json()).toMatchObject({ code: "NO_SCHEDULE" });
  } finally {
    await app.close();
  }
});

test("fails closed when any library endpoint is invalid", async () => {
  stubTunarr({
    good: [localProgram("good1", "/media/Good.mkv")],
  });
  const app = await buildApp({ dataDir: await mkdtemp(`${tmpdir()}/marktv-`) });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/test",
      payload: { url: "http://fake", libraryIds: ["good", "missing"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supportsInventory: false });
  } finally {
    await app.close();
  }
});

test("dry-runs the channel's local today instead of the newest inserted schedule", async () => {
  const dir = await makeDataDir();
  const repositories = createRepositories(openDatabase(dir));
  const channel = demo().channel;
  repositories.channels.put(channel);
  const today = scheduleFor(`${channel.id}-today`, "2026-09-16", [
    programEntry("today-entry", "/media/Today.mkv", "2026-09-16T05:00:00.000Z"),
  ]);
  const tomorrow = scheduleFor(`${channel.id}-tomorrow`, "2026-09-17", [
    programEntry(
      "tomorrow-entry",
      "/media/Tomorrow.mkv",
      "2026-09-17T05:00:00.000Z",
    ),
  ]);
  repositories.schedules.replaceSuccessful(channel.id, today);
  // Inserted last, so `latest` resolves to tomorrow even though the route runs
  // during today in the channel's timezone.
  repositories.schedules.replaceSuccessful(channel.id, tomorrow);
  repositories.close();

  stubTunarr({ "lib-a": [localProgram("today", "/media/Today.mkv")] });
  const app = await buildApp({
    dataDir: dir,
    // 21:00 on September 16 in America/Chicago, already September 17 in UTC.
    now: () => new Date("2026-09-17T02:00:00.000Z"),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: {
        url: "http://fake",
        libraryIds: ["lib-a"],
        createChannel: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scheduleSnapshot).toMatchObject({
      id: today.id,
      date: "2026-09-16",
    });
  } finally {
    await app.close();
  }
});

test("sync applies the schedule captured by the stored dry-run plan", async () => {
  const dir = await makeDataDir();
  const repositories = createRepositories(openDatabase(dir));
  const channel = demo().channel;
  repositories.channels.put(channel);
  const today = scheduleFor(`${channel.id}-today`, "2026-09-16", [
    programEntry("today-entry", "/media/A.mkv", "2026-09-16T05:00:00.000Z"),
  ]);
  repositories.schedules.replaceSuccessful(channel.id, today);
  repositories.close();

  let posted: { lineup?: Array<{ id?: string }> } | undefined;
  stubSyncTunarr({
    onProgramming: (body) => {
      posted = body;
    },
  });

  const app = await buildApp({
    dataDir: dir,
    now: () => new Date("2026-09-16T18:00:00.000Z"),
  });
  try {
    const dryRun = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: {
        url: "http://fake",
        libraryIds: ["lib-a"],
        channelId: "tunarr-channel",
      },
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().scheduleSnapshot.id).toBe(today.id);

    // Tomorrow becomes the newest row after the dry run captured today's plan.
    const later = createRepositories(openDatabase(dir));
    later.schedules.replaceSuccessful(
      channel.id,
      scheduleFor(`${channel.id}-tomorrow`, "2026-09-17", [
        programEntry(
          "tomorrow-entry",
          "/media/B.mkv",
          "2026-09-17T05:00:00.000Z",
        ),
      ]),
    );
    later.close();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/sync",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ partialFailure: false });
    expect(posted?.lineup?.[0]).toMatchObject({ type: "content", id: "a1" });
  } finally {
    await app.close();
  }
});

test("routes Cult dry-runs and syncs without changing channel 7", async () => {
  const dir = await makeDataDir();
  const repositories = createRepositories(openDatabase(dir));
  const channel7 = demo().channel;
  const channel9 = {
    ...channel7,
    id: "marktv-cult-movies",
    name: "MarkTV Cult Movies",
    number: 9,
  };
  const channel7Mapping: StoredTunarrMapping = {
    url: "http://old",
    marktvChannelId: channel7.id,
    libraryId: "lib-shows",
    libraryIds: ["lib-shows"],
    channelId: "tunarr-channel",
    createChannel: false,
    lastSync: {
      status: "synced",
      at: "2026-09-16T00:00:00.000Z",
      marktvChannelId: channel7.id,
      scheduleId: "channel-7-schedule",
    },
  };
  repositories.channels.put(channel7);
  repositories.channels.put(channel9);
  repositories.schedules.replaceSuccessful(
    channel7.id,
    scheduleFor("channel-7-schedule", "2026-09-16", [
      programEntry("laughs-entry", "/media/A.mkv", "2026-09-16T05:00:00.000Z"),
    ]),
  );
  const cultSchedule = {
    ...scheduleFor("channel-9-schedule", "2026-09-16", [
      programEntry("cult-entry", "/media/A.mkv", "2026-09-16T05:00:00.000Z"),
    ]),
    channelId: channel9.id,
    channelName: channel9.name,
    channelNumber: channel9.number,
  };
  repositories.schedules.replaceSuccessful(channel9.id, cultSchedule);
  repositories.settings.put(TUNARR_MAPPING_SETTING, channel7Mapping);
  repositories.close();

  const postedChannelIds: string[] = [];
  const calls: string[] = [];
  stubSyncTunarr({
    record: calls,
    onProgramming: (body) => {
      postedChannelIds.push(JSON.stringify(body));
    },
  });
  const app = await buildApp({
    dataDir: dir,
    now: () => new Date("2026-09-16T18:00:00.000Z"),
  });
  try {
    const dryRun = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: {
        url: "http://fake",
        marktvChannelId: channel9.id,
        libraryIds: ["lib-movies"],
        createChannel: true,
        transcodeConfigId: TRANSCODE_CONFIG_ID,
      },
    });
    expect(dryRun.statusCode).toBe(200);

    const afterDryRun = createRepositories(openDatabase(dir));
    expect(
      readTunarrMappingForChannel(afterDryRun, channel7.id),
    ).toEqual(channel7Mapping);
    expect(
      readTunarrMappingForChannel(afterDryRun, channel9.id)?.plan,
    ).toBeTruthy();
    afterDryRun.close();

    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/sync",
      payload: { marktvChannelId: channel9.id },
    });
    expect(sync.statusCode).toBe(200);
    expect(postedChannelIds).toHaveLength(1);
    expect(postedChannelIds[0]).toContain('"id":"a1"');
    expect(calls).toContain(
      "POST http://fake/api/channels/created-channel/programming",
    );

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/tunarr/status?marktvChannelId=${channel9.id}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      configured: true,
      marktvChannelId: channel9.id,
      channelId: "created-channel",
      hasPlan: false,
    });

    const finalRepositories = createRepositories(openDatabase(dir));
    expect(readTunarrMappings(finalRepositories)).toHaveLength(2);
    expect(
      readTunarrMappingForChannel(finalRepositories, channel7.id),
    ).toEqual(channel7Mapping);
    finalRepositories.close();
  } finally {
    await app.close();
  }
});

test("a dry run preserves stored sync state it does not replace", async () => {
  const dir = await makeDataDir();
  const repositories = createRepositories(openDatabase(dir));
  const channel = demo().channel;
  const fillerListId = "11111111-1111-4111-8111-111111111111";
  repositories.channels.put(channel);
  repositories.schedules.replaceSuccessful(
    channel.id,
    scheduleFor(`${channel.id}-today`, "2026-09-16", [
      programEntry(
        "today-entry",
        "/media/Today.mkv",
        "2026-09-16T05:00:00.000Z",
      ),
    ]),
  );
  repositories.settings.put(TUNARR_MAPPING_SETTING, {
    url: "http://old",
    marktvChannelId: channel.id,
    libraryId: "lib-a",
    libraryIds: ["lib-a"],
    channelId: "tunarr-channel",
    fillerListId,
    createChannel: false,
    autoSync: false,
    lastSync: {
      status: "synced",
      at: "2026-09-16T00:00:00.000Z",
      marktvChannelId: channel.id,
    },
  });
  repositories.close();

  stubTunarr({ "lib-a": [localProgram("today", "/media/Today.mkv")] });
  const app = await buildApp({
    dataDir: dir,
    now: () => new Date("2026-09-16T18:00:00.000Z"),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: {
        url: "http://fake",
        libraryIds: ["lib-a"],
        channelId: "tunarr-channel",
      },
    });
    expect(response.statusCode).toBe(200);

    const stored = await readStoredMapping(dir);
    expect(stored).toMatchObject({
      url: "http://fake",
      channelId: "tunarr-channel",
      fillerListId,
      autoSync: false,
    });
    expect((stored?.lastSync as { status?: string } | undefined)?.status).toBe(
      "synced",
    );
    expect(
      (stored?.plan as { mapping?: { fillerListId?: string } } | undefined)
        ?.mapping?.fillerListId,
    ).toBe(fillerListId);
  } finally {
    await app.close();
  }
});

test("manual sync answers ACTIVE_VIEWERS with 409 and mutates nothing", async () => {
  const dir = await makeDataDir();
  const repositories = createRepositories(openDatabase(dir));
  const channel = demo().channel;
  repositories.channels.put(channel);
  repositories.schedules.replaceSuccessful(
    channel.id,
    scheduleFor(`${channel.id}-today`, "2026-09-16", [
      programEntry("today-entry", "/media/A.mkv", "2026-09-16T05:00:00.000Z"),
    ]),
  );
  repositories.close();

  const record: string[] = [];
  stubSyncTunarr({
    record,
    sessions: [{ channelId: "tunarr-channel", numConnections: 1 }],
  });
  const app = await buildApp({
    dataDir: dir,
    now: () => new Date("2026-09-16T18:00:00.000Z"),
  });
  try {
    const dryRun = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/dry-run",
      payload: {
        url: "http://fake",
        libraryIds: ["lib-a"],
        channelId: "tunarr-channel",
      },
    });
    expect(dryRun.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tunarr/sync",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ACTIVE_VIEWERS" });
    expect(response.json().message).toMatch(/viewer/i);
    expect(
      record.some((call) => call.startsWith("PUT") || call.startsWith("POST")),
    ).toBe(false);
    // The plan survives, so the user can retry once playback stops.
    expect((await readStoredMapping(dir))?.plan).toBeTruthy();
  } finally {
    await app.close();
  }
});
