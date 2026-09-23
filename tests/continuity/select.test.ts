import { expect, test } from "vitest";
import { selectContinuity } from "../../src/continuity/select.js";
import type { ContinuityAsset, ContinuityContext } from "../../src/continuity/types.js";

const context: ContinuityContext = {
  channelId: "marktv-laughs",
  scheduleId: "schedule-1",
  scheduleRevision: "revision-1",
  timezone: "America/Chicago",
  insertionInstant: "2026-09-20T23:00:00.000Z",
  current: null,
  returnTarget: null,
  next: {
    airingId: "roseanne-13",
    mediaId: "roseanne-media",
    title: "Roseanne",
    showTitle: "Roseanne",
    start: "2026-09-20T23:05:00.000Z",
    kind: "episode",
    sameSeriesAsCurrent: false,
  },
  later: null,
  tonight: [],
  weekendPair: null,
  presentationLabel: "COMING UP",
  allowTimeRelativePromos: true,
  managedLineup: true,
};

const asset = (overrides: Partial<ContinuityAsset> = {}): ContinuityAsset => ({
  id: "next-roseanne",
  mediaId: "bumper-roseanne",
  origin: "existing",
  contentHash: "hash",
  path: "/station/next-roseanne.mp4",
  durationMs: 6_000,
  role: "next",
  personaId: "local",
  lifecycle: "registered",
  scope: "title",
  targetSlug: "roseanne",
  airReady: true,
  ...overrides,
});

test("selects deterministically and enforces persisted cooldowns", () => {
  const available = [asset(), asset({ id: "next-roseanne-2", mediaId: "bumper-roseanne-2", contentHash: "hash-2" })];
  const first = selectContinuity(context, available, [], {
    now: "2026-09-20T23:00:00.000Z",
  });
  const rebuilt = selectContinuity(context, available, [], {
    now: "2026-09-20T23:00:00.000Z",
  });
  expect(rebuilt.selected?.id).toBe(first.selected?.id);

  const cooled = selectContinuity(
    context,
    available,
    [
      {
        assetId: first.selected!.id,
        targetAiringId: context.next!.airingId,
        personaId: first.selected!.personaId,
        airedAt: "2026-09-20T22:45:00.000Z",
      },
    ],
    { now: "2026-09-20T23:00:00.000Z" },
  );
  expect(cooled.selected).toBeNull();
  expect(cooled.rejections.some((item) => item.reason === "REPEAT_COOLDOWN")).toBe(true);
});

test("rejects stale and unavailable scoped assets, and keeps staged effects off", () => {
  const result = selectContinuity(
    context,
    [
      asset({ id: "stale", scheduleRevision: "revision-old" }),
      asset({ id: "missing", available: false }),
      asset({ id: "staged", role: "interruption", scope: "evergreen", targetSlug: undefined }),
    ],
    [],
    { now: "2026-09-20T23:00:00.000Z", stagedInterruptionsEnabled: false },
  );
  expect(result.selected).toBeNull();
  expect(result.rejections.map((item) => item.reason)).toEqual(
    expect.arrayContaining(["STALE_SCHEDULE", "MISSING_SOURCE", "UNHEALTHY_PLAYBACK"]),
  );
});

test("matches NEXT against the editorial next airing during a mid-roll", () => {
  const midrollContext: ContinuityContext = {
    ...context,
    returnTarget: {
      airingId: "current-night-court",
      mediaId: "night-court-media",
      title: "Night Court",
      showTitle: "Night Court",
      start: "2026-09-20T22:30:00.000Z",
      kind: "episode",
      sameSeriesAsCurrent: true,
    },
  };
  const result = selectContinuity(
    midrollContext,
    [
      asset(),
      asset({ id: "wrong-current", targetSlug: "night-court" }),
      asset({ id: "return", role: "return", scope: "title", targetSlug: "night-court" }),
    ],
    [],
    { now: context.insertionInstant },
  );
  expect(result.selected?.id).toBe("return");
  expect(result.rejections).toContainEqual({ assetId: "wrong-current", reason: "TARGET_MISMATCH" });
  expect(result.rejections).not.toContainEqual({ assetId: "next-roseanne", reason: "TARGET_MISMATCH" });
});

test("requires same-series evidence for a 'more Roseanne' voiced promo", () => {
  const roseanne = asset({ requiresSameSeriesAsCurrent: true });
  expect(selectContinuity(context, [roseanne], [], { now: context.insertionInstant }).selected).toBeNull();
  const sameSeries = { ...context, next: { ...context.next!, sameSeriesAsCurrent: true } };
  expect(selectContinuity(sameSeries, [roseanne], [], { now: context.insertionInstant }).selected?.id).toBe(roseanne.id);
});

test("permits only explicitly shared voiced assets on movie channel contexts", () => {
  const shared = asset({ channelId: "marktv-laughs", channelIds: ["marktv-movies", "marktv-cult-movies"] });
  const moviesContext = { ...context, channelId: "marktv-movies" };
  const cultContext = { ...context, channelId: "marktv-cult-movies" };
  const ownerContext = { ...context, channelId: "marktv-laughs" };
  const otherContext = { ...context, channelId: "marktv-sports" };
  expect(selectContinuity(moviesContext, [shared], [], { now: context.insertionInstant }).selected).toBe(shared);
  expect(selectContinuity(cultContext, [shared], [], { now: context.insertionInstant }).selected).toBe(shared);
  expect(selectContinuity(ownerContext, [shared], [], { now: context.insertionInstant }).selected).toBe(shared);
  expect(selectContinuity(otherContext, [shared], [], { now: context.insertionInstant }).selected).toBeNull();
});

test("applies the configured promo-frequency gate deterministically", () => {
  const result = selectContinuity(context, [asset()], [], {
    now: context.insertionInstant,
    promoFrequency: 0,
  });
  expect(result.selected).toBeNull();
  expect(result.rejections).toContainEqual({
    assetId: "next-roseanne",
    reason: "FREQUENCY_GATE",
  });
});
