import { expect, test, vi } from "vitest";
import type { Schedule } from "../../src/domain/models.js";
import { buildTunarrSyncPlan } from "../../src/integrations/tunarr/plan.js";
import { syncTunarrPlan } from "../../src/integrations/tunarr/sync.js";
import type {
  TunarrCapabilities,
  TunarrSnapshots,
} from "../../src/integrations/tunarr/types.js";

const schedule: Schedule = {
  id: "s",
  channelId: "marktv",
  channelName: "Laughs",
  channelNumber: 7,
  date: "2026-09-13",
  timezone: "UTC",
  seed: "x",
  revision: "r",
  generatedAt: "2026-09-13T00:00:00.000Z",
  durationMs: 1,
  diagnostics: [],
  entries: [
    {
      id: "flex",
      start: "",
      end: "",
      localStart: "",
      localEnd: "",
      durationMs: 1,
      kind: "flex",
      title: "Flex",
    },
  ],
};
const capabilities: TunarrCapabilities = {
  url: "http://fake",
  version: "1",
  healthy: true,
  supportsChannels: true,
  supportsFillerLists: true,
  supportsTranscodeConfigs: true,
  supportsInventory: true,
  supportsProgramming: true,
};
const channel = {
  id: "7",
  name: "Old",
  number: 1,
  duration: 1,
  groupTitle: "old",
  guideMinimumDuration: 1,
  icon: { path: "", width: 0, duration: 0, position: "bottom-right" as const },
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
const snapshots: TunarrSnapshots = {
  channels: [channel],
  fillerLists: [],
  fillerPrograms: {},
  transcodeConfigs: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  programming: {
    totalPrograms: 0,
    programs: {},
    lineup: [],
    startTimeOffsets: [],
  },
};
const mapping = { libraryId: "lib", channelId: "7", createChannel: false };
const plan = buildTunarrSyncPlan(
  schedule,
  [],
  capabilities,
  mapping,
  snapshots,
);

test("revalidates every snapshot before the first mutation", async () => {
  const mutate = vi.fn();
  const client = {
    snapshot: async () => ({
      capabilities,
      inventory: [],
      snapshots: {
        ...snapshots,
        channels: [{ ...channel, name: "Changed" }],
      },
    }),
    activeSessionCount: async () => 0,
    putChannel: mutate,
    createChannel: mutate,
    createFillerList: mutate,
    putFillerList: mutate,
    postProgramming: mutate,
  } as never;
  await expect(syncTunarrPlan(client, plan, schedule)).rejects.toMatchObject({
    code: "STALE_DRY_RUN",
  });
  expect(mutate).not.toHaveBeenCalled();
});

test("executes fresh operations in order and resolves returned IDs", async () => {
  const emptySnapshots = { ...snapshots, channels: [], programming: undefined };
  const creationMapping = {
    libraryId: "lib",
    createChannel: true,
    transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const creationPlan = buildTunarrSyncPlan(
    schedule,
    [],
    capabilities,
    creationMapping,
    emptySnapshots,
  );
  const order: string[] = [];
  const client = {
    snapshot: async () => ({
      capabilities,
      inventory: [],
      snapshots: emptySnapshots,
    }),
    activeSessionCount: async () => 0,
    createChannel: async () => {
      order.push("channel-create");
      return { id: "created-channel" };
    },
    putChannel: async () => {
      throw new Error("unused");
    },
    createFillerList: async () => {
      order.push("filler-create");
      return { id: "created-filler" };
    },
    putFillerList: async () => {
      throw new Error("unused");
    },
    postProgramming: async (channelId: string) => {
      order.push(`programming:${channelId}`);
      return { ok: true, status: 200 };
    },
  } as never;
  await expect(syncTunarrPlan(client, creationPlan, schedule)).resolves.toEqual(
    {
      completed: ["channel-create", "filler-create", "programming"],
      partialFailure: false,
      state: { channelId: "created-channel", fillerListId: "created-filler" },
    },
  );
  expect(order).toEqual([
    "channel-create",
    "filler-create",
    "programming:created-channel",
  ]);
});

test("stops first failure and reports completed operations and state", async () => {
  const fillerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fillerSnapshots = {
    ...snapshots,
    fillerLists: [
      { id: fillerId, name: "MarkTV - Laughs (marktv)", contentCount: 0 },
    ],
    fillerPrograms: { [fillerId]: [] },
  };
  const withFiller = buildTunarrSyncPlan(
    schedule,
    [],
    capabilities,
    mapping,
    fillerSnapshots,
  );
  const client = {
    snapshot: async () => ({
      capabilities,
      inventory: [],
      snapshots: fillerSnapshots,
    }),
    activeSessionCount: async () => 0,
    putChannel: async () => ({ ok: true, status: 200 }),
    createChannel: async () => {
      throw new Error("unused");
    },
    createFillerList: async () => ({ id: "unused" }),
    putFillerList: async () => ({ ok: false, status: 503 }),
    postProgramming: async () => {
      throw new Error("must stop");
    },
  } as never;
  await expect(syncTunarrPlan(client, withFiller, schedule)).resolves.toEqual({
    completed: ["channel-update"],
    partialFailure: true,
    error: "HTTP 503",
    state: { channelId: "7", fillerListId: fillerId },
  });
});

test("maps an unsupported successful mutation response to a safe partial failure", async () => {
  const client = {
    snapshot: async () => ({ capabilities, inventory: [], snapshots }),
    activeSessionCount: async () => 0,
    putChannel: async () => {
      throw Object.assign(
        new Error("Updated channel response is unsupported"),
        {
          code: "UNSUPPORTED_SCHEMA",
        },
      );
    },
    createChannel: async () => ({ id: "unused" }),
    createFillerList: async () => ({ id: "unused" }),
    putFillerList: async () => ({ ok: true, status: 200 }),
    postProgramming: async () => ({ ok: true, status: 200 }),
  } as never;
  await expect(syncTunarrPlan(client, plan, schedule)).resolves.toEqual({
    completed: [],
    partialFailure: true,
    error: "Updated channel response is unsupported",
    state: { channelId: "7" },
  });
});

test("resolves canonical library IDs for snapshot revalidation", async () => {
  const mod =
    (await import("../../src/integrations/tunarr/types.js")) as unknown as {
      resolveLibraryIds: (input: unknown) => string[];
    };
  expect(typeof mod.resolveLibraryIds).toBe("function");
  expect(mod.resolveLibraryIds({ libraryIds: [" x ", "x", "y"] })).toEqual([
    "x",
    "y",
  ]);
  const canonical = mod.resolveLibraryIds({ libraryIds: ["lib-a", "lib-b"] });
  const canonicalPlan = buildTunarrSyncPlan(
    schedule,
    [],
    capabilities,
    {
      libraryId: canonical[0],
      libraryIds: canonical,
      channelId: "7",
      createChannel: false,
    } as never,
    snapshots,
  );
  expect(canonicalPlan.mapping).toMatchObject({
    libraryId: "lib-a",
    libraryIds: ["lib-a", "lib-b"],
  });
  const seen: unknown[] = [];
  const client = {
    snapshot: async (mapping: unknown) => {
      seen.push(mapping);
      return { capabilities, inventory: [], snapshots };
    },
    activeSessionCount: async () => 0,
    putChannel: async () => ({ ok: true, status: 200 }),
    createChannel: async () => ({ id: "unused" }),
    createFillerList: async () => ({ id: "unused" }),
    putFillerList: async () => ({ ok: true, status: 200 }),
    postProgramming: async () => ({ ok: true, status: 200 }),
  } as never;
  await syncTunarrPlan(client, canonicalPlan, schedule);
  expect(seen[0]).toMatchObject({
    libraryIds: ["lib-a", "lib-b"],
  });
});

test("refuses to mutate while the mapped channel has active viewers", async () => {
  const mutate = vi.fn();
  const activeSessionCount = vi.fn(async (channelId: string) => {
    expect(channelId).toBe("7");
    return 2;
  });
  const client = {
    snapshot: async () => ({ capabilities, inventory: [], snapshots }),
    activeSessionCount,
    putChannel: mutate,
    createChannel: mutate,
    createFillerList: mutate,
    putFillerList: mutate,
    postProgramming: mutate,
  } as never;

  await expect(syncTunarrPlan(client, plan, schedule)).rejects.toMatchObject({
    code: "ACTIVE_VIEWERS",
  });
  expect(activeSessionCount).toHaveBeenCalledTimes(1);
  // Nothing disruptive reached Tunarr, so the viewer keeps watching.
  expect(mutate).not.toHaveBeenCalled();
});

test("applies the plan when the mapped channel has no active viewers", async () => {
  const client = {
    snapshot: async () => ({ capabilities, inventory: [], snapshots }),
    activeSessionCount: async (channelId: string) => {
      expect(channelId).toBe("7");
      return 0;
    },
    putChannel: async () => ({ ok: true, status: 200 }),
    createChannel: async () => ({ id: "unused" }),
    createFillerList: async () => ({ id: "unused" }),
    putFillerList: async () => ({ ok: true, status: 200 }),
    postProgramming: async () => ({ ok: true, status: 200 }),
  } as never;

  await expect(syncTunarrPlan(client, plan, schedule)).resolves.toMatchObject({
    completed: ["channel-update", "filler-create", "programming"],
    partialFailure: false,
  });
});

test("allows channel creation without an existing channel to check", async () => {
  const emptySnapshots = { ...snapshots, channels: [], programming: undefined };
  const creationPlan = buildTunarrSyncPlan(
    schedule,
    [],
    capabilities,
    {
      libraryId: "lib",
      createChannel: true,
      transcodeConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    emptySnapshots,
  );
  const activeSessionCount = vi.fn(async () => 4);
  const order: string[] = [];
  const client = {
    snapshot: async () => ({
      capabilities,
      inventory: [],
      snapshots: emptySnapshots,
    }),
    activeSessionCount,
    createChannel: async () => {
      order.push("channel-create");
      return { id: "created-channel" };
    },
    putChannel: async () => ({ ok: true, status: 200 }),
    createFillerList: async () => {
      order.push("filler-create");
      return { id: "created-filler" };
    },
    putFillerList: async () => ({ ok: true, status: 200 }),
    postProgramming: async () => {
      order.push("programming");
      return { ok: true, status: 200 };
    },
  } as never;

  await expect(
    syncTunarrPlan(client, creationPlan, schedule),
  ).resolves.toMatchObject({ partialFailure: false });
  expect(activeSessionCount).not.toHaveBeenCalled();
  expect(order).toEqual(["channel-create", "filler-create", "programming"]);
});

test("reads the channel-keyed session arrays current Tunarr builds serve", async () => {
  // Live shape: { "<channelId>": [{ type, state, numConnections, ... }] }.
  // Sessions carry no channel fields of their own; the map key attributes them.
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      "7": [
        {
          type: "hls",
          state: "started",
          numConnections: 2,
          connections: [],
        },
      ],
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const mutate = vi.fn();
    const client = {
      url: "http://fake",
      snapshot: async () => ({ capabilities, inventory: [], snapshots }),
      putChannel: mutate,
      createChannel: mutate,
      createFillerList: mutate,
      putFillerList: mutate,
      postProgramming: mutate,
    } as never;
    await expect(syncTunarrPlan(client, plan, schedule)).rejects.toMatchObject(
      {
        code: "ACTIVE_VIEWERS",
      },
    );
    expect(mutate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("ignores channel-keyed sessions for other channels", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      "some-other-channel": [
        {
          type: "hls",
          state: "started",
          numConnections: 3,
          connections: [],
        },
      ],
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const client = {
      url: "http://fake",
      snapshot: async () => ({ capabilities, inventory: [], snapshots }),
      putChannel: async () => ({ ok: true, status: 200 }),
      createChannel: async () => ({ id: "unused" }),
      createFillerList: async () => ({ id: "unused" }),
      putFillerList: async () => ({ ok: true, status: 200 }),
      postProgramming: async () => ({ ok: true, status: 200 }),
    } as never;
    await expect(syncTunarrPlan(client, plan, schedule)).resolves.toMatchObject(
      {
        partialFailure: false,
      },
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
