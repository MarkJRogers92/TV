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
    state: { channelId: "7", fillerListId: undefined },
  });
});

test("resolves canonical library IDs for snapshot revalidation", async () => {
  const mod = (await import(
    "../../src/integrations/tunarr/types.js"
  )) as unknown as {
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
    { libraryId: canonical[0], libraryIds: canonical, channelId: "7", createChannel: false } as never,
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
