import { expect, test } from "vitest";
import { createAlwaysOnSupervisor } from "../../src/autopilot/alwaysOn.js";
import type { Repositories } from "../../src/db/repositories.js";

const repositories = {
  channels: {
    list: () => [
      { id: "a", enabled: true },
      { id: "b", enabled: false },
      { id: "c", enabled: true },
    ],
  },
} as unknown as Repositories;

const okFetch = (calls: string[]) =>
  (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  }) as unknown as typeof fetch;

test("[R01] starts only enabled channels that have a stream URL", async () => {
  const calls: string[] = [];
  const supervisor = createAlwaysOnSupervisor(repositories, {
    // 'b' is disabled, 'c' has no mapping — only 'a' should be requested.
    resolveStreamUrl: (channelId) =>
      channelId === "a" ? "http://t/a.m3u8" : channelId === "b" ? "http://t/b.m3u8" : null,
    fetchImpl: okFetch(calls),
  });

  await supervisor.runOnce();
  expect(calls).toEqual(["http://t/a.m3u8"]);
});

test("[R01] a failing request is reported and never thrown", async () => {
  const failed: string[] = [];
  const supervisor = createAlwaysOnSupervisor(repositories, {
    resolveStreamUrl: (channelId) => (channelId === "a" ? "http://t/a.m3u8" : null),
    fetchImpl: (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch,
    onError: (_error, channelId) => failed.push(channelId ?? ""),
  });

  await expect(supervisor.runOnce()).resolves.toBeUndefined();
  expect(failed).toContain("a");
});
