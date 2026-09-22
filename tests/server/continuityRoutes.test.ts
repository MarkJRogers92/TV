import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-continuity-api-"));
  directories.push(dataDir);
  return buildApp({
    dataDir,
    now: () => new Date("2026-09-20T23:05:00-05:00"),
  });
}

test("reports director readiness and never generates a schedule on read", async () => {
  const app = await fixture();
  const before = await app.inject(
    "/api/v1/schedules/latest?channelId=marktv-laughs&date=2026-09-20",
  );
  expect(before.json()).toBeNull();
  const response = await app.inject("/api/v1/channels/marktv-laughs/continuity");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    channelId: "marktv-laughs",
    config: {
      enabled: true,
      nextCards: true,
      nextLaterFrequency: "normal",
      tonightFrequency: "normal",
      overnightWeirdness: "low",
      stagedInterruptionsEnabled: false,
      clipCooldownMinutes: 60,
      targetCooldownMinutes: 30,
    },
    activation: { state: "enabled" },
    branding: { state: expect.stringMatching(/missing|invalid|bound/) },
    assets: {
      discovered: expect.any(Number),
      airReady: expect.any(Number),
      generated: expect.any(Number),
      scriptOnly: expect.any(Number),
    },
    voices: {
      network: expect.any(Number),
      local: expect.any(Number),
      overnight: expect.any(Number),
      odd: expect.any(Number),
    },
    director: {
      scheduleRevision: expect.any(String),
      label: expect.any(String),
      cards: expect.any(Array),
    },
    preview: {
      scheduleRevision: expect.any(String),
      insertionInstant: expect.any(String),
      label: expect.any(String),
    },
  });
  const after = await app.inject(
    "/api/v1/schedules/latest?channelId=marktv-laughs&date=2026-09-20",
  );
  expect(after.json()).toBeNull();
  await app.close();
});

test("persists director settings and keeps an explicit off choice off", async () => {
  const app = await fixture();
  const tuned = await app.inject({
    method: "PUT",
    url: "/api/v1/channels/marktv-laughs/continuity",
    payload: { nextCards: false, tonightFrequency: "high", overnightWeirdness: "off" },
  });
  expect(tuned.statusCode).toBe(200);
  expect(tuned.json().config).toMatchObject({
    enabled: true,
    nextCards: false,
    tonightFrequency: "high",
    overnightWeirdness: "off",
    nextLaterFrequency: "normal",
  });

  const off = await app.inject({
    method: "PUT",
    url: "/api/v1/channels/marktv-laughs/continuity",
    payload: { enabled: false },
  });
  expect(off.statusCode).toBe(200);
  expect(off.json()).toMatchObject({
    config: { enabled: false, nextCards: false, tonightFrequency: "high" },
    activation: { state: "disabled" },
  });

  const reread = await app.inject("/api/v1/channels/marktv-laughs/continuity");
  expect(reread.json().config).toMatchObject({ enabled: false, nextCards: false });

  const backOn = await app.inject({
    method: "PUT",
    url: "/api/v1/channels/marktv-laughs/continuity",
    payload: { enabled: true },
  });
  expect(backOn.statusCode).toBe(200);
  expect(backOn.json().config.enabled).toBe(true);
  await app.close();
});

test("refuses staged interruptions without a playback-health gate", async () => {
  const app = await fixture();
  const refused = await app.inject({
    method: "PUT",
    url: "/api/v1/channels/marktv-laughs/continuity",
    payload: { stagedInterruptionsEnabled: true },
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({ code: "CONTINUITY_INTERRUPTION_NOT_READY" });
  await app.close();
});

test("plans cards from a generated schedule without registering an asset", async () => {
  const app = await fixture();
  const mediaItem = {
    id: "continuity-next-generic",
    source: "local-folder",
    kind: "bumper",
    title: "marktv-up-next-generic",
    path: "/library/continuity-next-generic.mp4",
    durationMs: 15_000,
    durationStatus: "ok",
    available: true,
    tags: ["visual-only"],
  };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/media/${mediaItem.id}`,
        payload: mediaItem,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/schedules/generate",
        payload: { channelId: "marktv-laughs", date: "2026-09-20" },
      })
    ).statusCode,
  ).toBe(200);

  const ready = await app.inject("/api/v1/channels/marktv-laughs/continuity");
  const body = ready.json();
  // Readiness is bound to the *current schedule content hash*: a legacy bumper
  // that exists in the catalog says nothing about whether this lineup has a
  // prepared card, so the channel is not reported ready just because it is on.
  expect(body.activation.ready).toBe(false);
  expect(body.assets.boundToSchedule).toBe(0);
  expect(Array.isArray(body.director.cards)).toBe(true);
  for (const card of body.director.cards) {
    expect(["next", "next-later", "tonight", "weekend", "after-dark"]).toContain(card.cardType);
    expect(["syndication", "local-cable", "prime-time", "overnight"]).toContain(card.family);
    expect(card.assetRegistered).toBe(false);
  }
  await app.close();
});
