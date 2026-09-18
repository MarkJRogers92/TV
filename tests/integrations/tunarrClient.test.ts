import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import {
  TunarrClient,
  tunarrClientLimits,
} from "../../src/integrations/tunarr/client.js";
import { buildTunarrSyncPlan } from "../../src/integrations/tunarr/plan.js";
import type { TunarrLineup } from "../../src/integrations/tunarr/types.js";

type FakeState = {
  health?: unknown;
  version?: unknown;
  inventory?: unknown;
  channels?: unknown[];
  fillers?: unknown;
  fillerPrograms?: unknown;
  transcodes?: unknown;
  programming?: unknown;
  postStatus?: number;
  channelMutation?: unknown;
  fillerMutation?: unknown;
  programmingMutation?: unknown;
  requests: { method: string; path: string; body?: unknown }[];
};
async function fakeTunarr(
  state: FakeState,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    state.requests.push({
      method: request.method!,
      path: request.url!,
      body: body ? JSON.parse(body) : undefined,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/system/health")
      return send(200, state.health ?? { database: { type: "healthy" } });
    if (request.url === "/api/version")
      return send(
        200,
        state.version ?? { tunarr: "1.0.0", ffmpeg: "7", nodejs: "22" },
      );
    if (request.url === "/api/channels" && request.method === "GET")
      return send(200, state.channels ?? []);
    if (request.url === "/api/channels" && request.method === "POST")
      return send(201, state.channelMutation ?? officialChannel());
    if (request.url === "/api/channels/7" && request.method === "PUT")
      return send(200, state.channelMutation ?? officialChannel());
    if (request.url === "/api/filler-lists" && request.method === "GET")
      return send(200, state.fillers ?? []);
    if (request.url === "/api/filler-lists" && request.method === "POST")
      return send(201, state.fillerMutation ?? { id: "created-filler" });
    if (request.url === "/api/filler-lists/filler/programs")
      return send(200, state.fillerPrograms ?? []);
    if (request.url === "/api/filler-lists/filler" && request.method === "PUT")
      return send(
        200,
        state.fillerMutation ?? {
          id: "filler",
          name: "MarkTV",
          contentCount: 0,
        },
      );
    if (request.url === "/api/transcode_configs")
      return send(200, state.transcodes ?? []);
    if (request.url === "/api/media-libraries/lib/programs")
      return send(200, state.inventory ?? []);
    if (
      request.url === "/api/channels/7/programming" &&
      request.method === "GET"
    )
      return send(
        200,
        state.programming ?? {
          totalPrograms: 0,
          programs: {},
          lineup: [],
          startTimeOffsets: [],
        },
      );
    if (
      request.url === "/api/channels/7/programming" &&
      request.method === "POST"
    )
      return send(
        state.postStatus ?? 200,
        state.programmingMutation ?? {
          totalPrograms: 0,
          programs: {},
          lineup: [],
          startTimeOffsets: [],
        },
      );
    return send(404, { error: "missing" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function officialChannel() {
  return {
    id: "created-channel",
    name: "MarkTV",
    number: 7,
    duration: 60_000,
    groupTitle: "MarkTV",
    guideMinimumDuration: 30_000,
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
    transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    disableFillerOverlay: false,
    subtitlesEnabled: false,
    programCount: 0,
  };
}

describe("TunarrClient local contract", () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  test("detects reachable version and programming capability from current endpoints", async () => {
    const state: FakeState = {
      requests: [],
      version: { tunarr: "0.20.1", ffmpeg: "7", nodejs: "22" },
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    const client = new TunarrClient(server.url);
    await expect(client.detect("7")).resolves.toMatchObject({
      url: server.url,
      version: "0.20.1",
      supportsProgramming: true,
      healthy: true,
      supportsChannels: true,
      supportsFillerLists: true,
      supportsTranscodeConfigs: true,
    });
    expect(state.requests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/api/system/health",
        "/api/channels",
        "/api/filler-lists",
        "/api/transcode_configs",
      ]),
    );
  });
  test("returns stable unreachable and schema mismatch errors", async () => {
    await expect(
      new TunarrClient("http://127.0.0.1:1").detect("7"),
    ).rejects.toMatchObject({ code: "UNREACHABLE" });
    const state: FakeState = { requests: [], version: { nope: true } };
    const server = await fakeTunarr(state);
    servers.push(server);
    await expect(
      new TunarrClient(server.url).detect("7"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });
  test("gives up on a Tunarr that accepts the connection and then never answers", async () => {
    const previous = tunarrClientLimits.requestTimeoutMs;
    tunarrClientLimits.requestTimeoutMs = 200;
    // Opens the socket and never writes a response. Without a deadline this
    // awaits forever, which is the shape of a wedged Tunarr - distinct from an
    // unreachable one, where the connection is refused immediately.
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) =>
      hanging.listen(0, "127.0.0.1", resolve),
    );
    servers.push({
      close: () =>
        new Promise((resolve, reject) => {
          hanging.closeAllConnections();
          hanging.close((error) => (error ? reject(error) : resolve()));
        }),
    });
    const address = hanging.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(
        new TunarrClient(`http://127.0.0.1:${port}`).detect("7"),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      tunarrClientLimits.requestTimeoutMs = previous;
    }
  });
  test("rejects an HTTP-200 health report containing an official error result", async () => {
    const state: FakeState = {
      requests: [],
      health: { database: { type: "error", context: "database unavailable" } },
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    await expect(
      new TunarrClient(server.url).detect("7"),
    ).resolves.toMatchObject({
      healthy: false,
    });
  });
  test("rejects a malformed condensed programming lineup during capability detection", async () => {
    const state: FakeState = {
      requests: [],
      programming: {
        totalPrograms: 1,
        programs: {},
        lineup: [{ type: "content", duration: 60000 }],
        startTimeOffsets: [],
      },
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    await expect(
      new TunarrClient(server.url).detect("7"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });
  test("rejects an official flex lineup item with zero duration during capability detection", async () => {
    const state: FakeState = {
      requests: [],
      programming: {
        totalPrograms: 1,
        programs: {},
        lineup: [{ type: "flex", duration: 0 }],
        startTimeOffsets: [],
      },
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    await expect(
      new TunarrClient(server.url).detect("7"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });
  test("validates programming records and official filler configuration UUIDs", async () => {
    const invalidRecord = await fakeTunarr({
      requests: [],
      programming: {
        totalPrograms: 1,
        programs: { bad: { type: "content", id: "bad", duration: 1 } },
        lineup: [],
        startTimeOffsets: [],
      },
    });
    servers.push(invalidRecord);
    await expect(
      new TunarrClient(invalidRecord.url).detect("7"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });

    const invalidFiller = await fakeTunarr({
      requests: [],
      programming: {
        totalPrograms: 0,
        programs: {},
        lineup: [
          {
            type: "flex",
            duration: 1,
            fillerConfig: {
              fillerListIds: ["not-a-uuid"],
              fillerListCooldownOverrides: { list: -1 },
              origin: "midroll",
            },
          },
        ],
        startTimeOffsets: [],
      },
    });
    servers.push(invalidFiller);
    await expect(
      new TunarrClient(invalidFiller.url).detect("7"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });
  test("extracts only normalized absolute local paths from the documented inventory endpoint", async () => {
    const state: FakeState = {
      requests: [],
      inventory: [
        {
          type: "content",
          id: "lineup-content-id",
          duration: 60000,
          program: {
            uuid: "11111111-1111-4111-8111-111111111111",
            mediaItem: {
              locations: [
                { type: "local", path: "/media/shows/../shows/A.mkv" },
              ],
            },
          },
        },
        {
          type: "content",
          id: "remote-content-id",
          duration: 60000,
          program: {
            uuid: "22222222-2222-4222-8222-222222222222",
            mediaItem: {
              locations: [{ type: "remote", path: "/remote/A.mkv" }],
            },
          },
        },
      ],
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    await expect(
      new TunarrClient(server.url).inventory("lib"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "lineup-content-id",
        path: "/media/shows/A.mkv",
        program: expect.objectContaining({ id: "lineup-content-id" }),
      }),
    ]);
  });
  test("sends the exact manual programming payload", async () => {
    const state: FakeState = { requests: [] };
    const server = await fakeTunarr(state);
    servers.push(server);
    const lineup: TunarrLineup = [
      { type: "content", id: "p1", duration: 60000, startOffsetMs: 500 },
      { type: "flex", duration: 1000 },
    ];
    await new TunarrClient(server.url).postProgramming("7", lineup);
    expect(state.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/channels/7/programming",
      body: { type: "manual", lineup, append: false },
    });
  });
  test("uses the official content wrapper id to produce an eligible manual dry-run payload", async () => {
    const state: FakeState = {
      requests: [],
      inventory: [
        {
          type: "content",
          id: "lineup-content-id",
          duration: 60000,
          program: {
            uuid: "11111111-1111-4111-8111-111111111111",
            mediaItem: { locations: [{ type: "local", path: "/media/A.mkv" }] },
          },
        },
      ],
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    const schedule = {
      id: "s",
      channelId: "c",
      date: "2026-09-13",
      timezone: "UTC",
      seed: "s",
      revision: "r",
      generatedAt: "",
      durationMs: 60000,
      diagnostics: [],
      entries: [
        {
          id: "e",
          start: "",
          end: "",
          localStart: "",
          localEnd: "",
          durationMs: 60000,
          kind: "episode" as const,
          title: "A",
          path: "/media/A.mkv",
        },
      ],
    };
    const plan = buildTunarrSyncPlan(
      schedule,
      await new TunarrClient(server.url).inventory("lib"),
      {
        url: server.url,
        version: "1",
        healthy: true,
        supportsChannels: true,
        supportsFillerLists: true,
        supportsTranscodeConfigs: true,
        supportsInventory: true,
        supportsProgramming: true,
      },
      { libraryId: "lib", channelId: "7", createChannel: false },
      {
        channels: [{ ...officialChannel(), id: "7", name: "Old" }],
        fillerLists: [],
        fillerPrograms: {},
        transcodeConfigs: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        programming: {
          totalPrograms: 0,
          programs: {},
          lineup: [],
          startTimeOffsets: [],
        },
      },
    );
    expect(plan.syncEligible).toBe(true);
    expect(
      plan.operations.find((operation) => operation.type === "programming"),
    ).toMatchObject({
      type: "programming",
      payload: [{ type: "content", id: "lineup-content-id", duration: 60000 }],
    });
  });

  test("uses official channel and filler lifecycle shapes", async () => {
    const state: FakeState = {
      requests: [],
      channels: [{ id: "7", name: "Existing" }],
      fillers: [{ id: "filler", name: "MarkTV", contentCount: 0 }],
      fillerPrograms: [],
      transcodes: [{ id: "transcode", name: "Default" }],
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    const client = new TunarrClient(server.url);
    await expect(
      client.createChannel({ type: "new", channel: { name: "MarkTV" } }),
    ).resolves.toEqual({ id: "created-channel" });
    await client.putChannel("7", { name: "MarkTV" });
    await expect(
      client.createFillerList({ name: "MarkTV", programs: [] }),
    ).resolves.toEqual({ id: "created-filler" });
    await client.putFillerList("filler", { name: "MarkTV", programs: [] });
    expect(state.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/channels",
          body: { type: "new", channel: { name: "MarkTV" } },
        }),
        expect.objectContaining({
          method: "PUT",
          path: "/api/channels/7",
          body: { name: "MarkTV" },
        }),
        expect.objectContaining({
          method: "POST",
          path: "/api/filler-lists",
          body: { name: "MarkTV", programs: [] },
        }),
        expect.objectContaining({
          method: "PUT",
          path: "/api/filler-lists/filler",
          body: { name: "MarkTV", programs: [] },
        }),
      ]),
    );
  });

  test("rejects arbitrary filler values and malformed successful mutation responses", async () => {
    const state: FakeState = {
      requests: [],
      fillerPrograms: [{ type: "mystery", id: "bad", duration: 1 }],
      channelMutation: { id: "missing-required-fields" },
      fillerMutation: { nope: true },
      programmingMutation: { ok: true },
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    const client = new TunarrClient(server.url);
    await expect(client.getFillerPrograms("filler")).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
    await expect(client.createChannel({})).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
    await expect(client.putChannel("7", {})).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
    await expect(client.createFillerList({})).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
    await expect(client.putFillerList("filler", {})).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
    await expect(client.postProgramming("7", [])).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
  });

  test("rejects relative local inventory paths instead of resolving against cwd", async () => {
    const state: FakeState = {
      requests: [],
      inventory: [
        {
          type: "content",
          id: "relative",
          duration: 60_000,
          program: {
            uuid: "11111111-1111-4111-8111-111111111111",
            mediaItem: { locations: [{ type: "local", path: "media/A.mkv" }] },
          },
        },
      ],
    };
    const server = await fakeTunarr(state);
    servers.push(server);
    await expect(
      new TunarrClient(server.url).inventory("lib"),
    ).rejects.toMatchObject({ code: "RELATIVE_MEDIA_PATH" });
  });

  test("recognizes absolute externalId for local sourceType when locations are absent", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/media-libraries/lib/programs"))
        return new Response(
          JSON.stringify([
            {
              type: "content",
              id: "local-external",
              duration: 60_000,
              program: {
                uuid: "11111111-1111-4111-8111-111111111111",
                sourceType: "local",
                externalId: "/media/B.mkv",
              },
            },
          ]),
          { status: 200 },
        );
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }) as typeof fetch;
    await expect(
      new TunarrClient("http://fake", fetcher).inventory("lib"),
    ).resolves.toEqual([
      expect.objectContaining({ id: "local-external", path: "/media/B.mkv" }),
    ]);
  });

  test("ignores remote externalId and preserves locations precedence", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/media-libraries/lib/programs"))
        return new Response(
          JSON.stringify([
            {
              type: "content",
              id: "remote-external",
              duration: 60_000,
              program: {
                uuid: "22222222-2222-4222-8222-222222222222",
                sourceType: "remote",
                externalId: "/media/C.mkv",
              },
            },
            {
              type: "content",
              id: "locations-win",
              duration: 60_000,
              program: {
                uuid: "33333333-3333-4333-8333-333333333333",
                sourceType: "local",
                externalId: "/media/ignored.mkv",
                mediaItem: {
                  locations: [{ type: "local", path: "/media/D.mkv" }],
                },
              },
            },
            {
              type: "content",
              id: "empty-locations",
              duration: 60_000,
              program: {
                uuid: "44444444-4444-4444-8444-444444444444",
                sourceType: "local",
                externalId: "/media/E.mkv",
                mediaItem: { locations: [] },
              },
            },
          ]),
          { status: 200 },
        );
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }) as typeof fetch;
    await expect(
      new TunarrClient("http://fake", fetcher).inventory("lib"),
    ).resolves.toEqual([
      expect.objectContaining({ id: "locations-win", path: "/media/D.mkv" }),
    ]);
  });

  test("rejects relative externalId paths instead of resolving against cwd", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/media-libraries/lib/programs"))
        return new Response(
          JSON.stringify([
            {
              type: "content",
              id: "relative-external",
              duration: 60_000,
              program: {
                uuid: "55555555-5555-4555-8555-555555555555",
                sourceType: "local",
                externalId: "media/rel.mkv",
              },
            },
          ]),
          { status: 200 },
        );
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }) as typeof fetch;
    await expect(
      new TunarrClient("http://fake", fetcher).inventory("lib"),
    ).rejects.toMatchObject({ code: "RELATIVE_MEDIA_PATH" });
  });

  test("aggregates inventory across multiple library IDs", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/media-libraries/lib-a/programs"))
        return new Response(
          JSON.stringify([
            {
              type: "content",
              id: "a1",
              duration: 60_000,
              program: {
                uuid: "11111111-1111-4111-8111-111111111111",
                mediaItem: {
                  locations: [{ type: "local", path: "/media/A.mkv" }],
                },
              },
            },
          ]),
          { status: 200 },
        );
      if (target.endsWith("/api/media-libraries/lib-b/programs"))
        return new Response(
          JSON.stringify([
            {
              type: "content",
              id: "b1",
              duration: 60_000,
              program: {
                uuid: "22222222-2222-4222-8222-222222222222",
                sourceType: "local",
                externalId: "/media/B.mkv",
              },
            },
          ]),
          { status: 200 },
        );
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }) as typeof fetch;
    const client = new TunarrClient("http://fake", fetcher);
    const inventory = await (client as unknown as {
      inventory: (ids: string[]) => Promise<Array<{ id: string; path: string }>>;
    }).inventory(["lib-a", "lib-b"]);
    expect(inventory.map((item) => item.id).sort()).toEqual(["a1", "b1"]);
    expect(inventory.map((item) => item.path).sort()).toEqual([
      "/media/A.mkv",
      "/media/B.mkv",
    ]);
  });

  test("fails closed without partial inventory when any library is invalid", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/media-libraries/good/programs"))
        return new Response(
          JSON.stringify([
            {
              type: "content",
              id: "good1",
              duration: 60_000,
              program: {
                uuid: "11111111-1111-4111-8111-111111111111",
                mediaItem: {
                  locations: [{ type: "local", path: "/media/Good.mkv" }],
                },
              },
            },
          ]),
          { status: 200 },
        );
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }) as typeof fetch;
    const client = new TunarrClient("http://fake", fetcher);
    await expect(
      (client as unknown as {
        inventory: (ids: string[]) => Promise<unknown>;
      }).inventory(["good", "missing"]),
    ).rejects.toMatchObject({ code: "INVENTORY_UNAVAILABLE" });
  });

  test("requires every library endpoint for inventory capability", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/system/health"))
        return new Response(JSON.stringify({ database: { type: "healthy" } }), {
          status: 200,
        });
      if (target.endsWith("/api/version"))
        return new Response(
          JSON.stringify({ tunarr: "1.3.14", ffmpeg: "7", nodejs: "22" }),
          { status: 200 },
        );
      if (target.endsWith("/api/channels"))
        return new Response(JSON.stringify([]), { status: 200 });
      if (target.endsWith("/api/filler-lists"))
        return new Response(JSON.stringify([]), { status: 200 });
      if (target.endsWith("/api/transcode_configs"))
        return new Response(JSON.stringify([]), { status: 200 });
      if (target.endsWith("/api/media-libraries/good/programs"))
        return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
      });
    }) as typeof fetch;
    const client = new TunarrClient("http://fake", fetcher);
    const both = await (client as unknown as {
      detect: (channel: string, libs: string[]) => Promise<{ supportsInventory: boolean }>;
    }).detect("", ["good", "missing"]);
    expect(both.supportsInventory).toBe(false);
    const single = await (client as unknown as {
      detect: (channel: string, libs: string[]) => Promise<{ supportsInventory: boolean }>;
    }).detect("", ["good"]);
    expect(single.supportsInventory).toBe(true);
  });
});
