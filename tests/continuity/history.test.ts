import { afterEach, describe, expect, test } from "vitest";
import {
  appendContinuityDecision,
  invalidatePlannedContinuityDecisions,
  readContinuityHistory,
  readContinuityHistoryForPlanning,
} from "../../src/continuity/history.js";
import {
  cleanupRepositoryFixtures,
  openMovieRepositories,
} from "../support/repositoryFixture.js";

afterEach(cleanupRepositoryFixtures);

const planned = (overrides: Record<string, unknown> = {}) => ({
  id: "decision-1",
  state: "planned" as const,
  assetId: "station-id-1",
  personaId: "local" as const,
  targetAiringId: "airing-1",
  scheduleRevision: "revision-1",
  plannedAt: "2026-09-20T12:00:00.000Z",
  ...overrides,
});

const aired = (overrides: Record<string, unknown> = {}) => ({
  id: "decision-2",
  state: "aired" as const,
  assetId: "station-id-2",
  personaId: "odd" as const,
  targetAiringId: "airing-2",
  airedAt: "2026-09-20T12:01:00.000Z",
  ...overrides,
});

describe("continuity history", () => {
  test("persists channel-scoped planned and aired decisions idempotently", async () => {
    const fixture = await openMovieRepositories();
    const channelId = fixture.fixture.channel.id;

    appendContinuityDecision(fixture.repositories, channelId, planned());
    appendContinuityDecision(fixture.repositories, channelId, planned());
    appendContinuityDecision(fixture.repositories, channelId, aired());

    expect(readContinuityHistory(fixture.repositories, channelId)).toEqual([
      planned(),
      aired(),
    ]);
    expect(readContinuityHistory(fixture.repositories, "other-channel")).toEqual([]);
  });

  test("rejects malformed unknown stored data while retaining valid records", async () => {
    const fixture = await openMovieRepositories();
    const channelId = fixture.fixture.channel.id;
    fixture.repositories.settings.put(`continuity:${channelId}:history`, [
      planned(),
      { id: "not-a-real-decision", state: "aired", airedAt: "yesterday" },
      "unknown",
    ]);

    expect(readContinuityHistory(fixture.repositories, channelId)).toEqual([planned()]);
  });

  test("queries by age and bounds retained entries without dropping valid cooldown history", async () => {
    const fixture = await openMovieRepositories();
    const channelId = fixture.fixture.channel.id;
    appendContinuityDecision(fixture.repositories, channelId, aired({ id: "old", airedAt: "2026-09-20T10:00:00.000Z" }));
    appendContinuityDecision(fixture.repositories, channelId, planned({ id: "recent-plan", plannedAt: "2026-09-20T11:58:00.000Z" }));
    appendContinuityDecision(fixture.repositories, channelId, aired({ id: "recent-air", airedAt: "2026-09-20T11:59:00.000Z" }));

    expect(readContinuityHistory(fixture.repositories, channelId, {
      now: "2026-09-20T12:00:00.000Z",
      maxAgeMs: 5 * 60_000,
      maxEntries: 1,
    })).toEqual([aired({ id: "recent-air", airedAt: "2026-09-20T11:59:00.000Z" })]);
    expect(readContinuityHistory(fixture.repositories, channelId)).toHaveLength(3);
  });

  test("prunes only old decisions and entries beyond the cap", async () => {
    const fixture = await openMovieRepositories();
    const channelId = fixture.fixture.channel.id;
    appendContinuityDecision(fixture.repositories, channelId, aired({ id: "old", airedAt: "2026-09-20T10:00:00.000Z" }));
    appendContinuityDecision(fixture.repositories, channelId, planned({ id: "recent-plan", plannedAt: "2026-09-20T11:58:00.000Z" }));
    appendContinuityDecision(fixture.repositories, channelId, aired({ id: "recent-air", airedAt: "2026-09-20T11:59:00.000Z" }));

    expect(readContinuityHistory(fixture.repositories, channelId, {
      now: "2026-09-20T12:00:00.000Z",
      maxAgeMs: 5 * 60_000,
      maxEntries: 1,
      prune: true,
    })).toEqual([aired({ id: "recent-air", airedAt: "2026-09-20T11:59:00.000Z" })]);
    expect(readContinuityHistory(fixture.repositories, channelId)).toEqual([
      aired({ id: "recent-air", airedAt: "2026-09-20T11:59:00.000Z" }),
    ]);
  });

  test("invalidates stale planned records but preserves aired records for cooldowns", async () => {
    const fixture = await openMovieRepositories();
    const channelId = fixture.fixture.channel.id;
    appendContinuityDecision(fixture.repositories, channelId, planned());
    appendContinuityDecision(fixture.repositories, channelId, planned({ id: "current-plan", scheduleRevision: "revision-2" }));
    appendContinuityDecision(fixture.repositories, channelId, aired());

    expect(invalidatePlannedContinuityDecisions(
      fixture.repositories,
      channelId,
      "revision-2",
    )).toBe(1);
    expect(readContinuityHistory(fixture.repositories, channelId)).toEqual([
      planned({ id: "current-plan", scheduleRevision: "revision-2" }),
      aired(),
    ]);
  });

  test("planning history counts published insertions but never the schedule being built", async () => {
    const fixture = await openMovieRepositories();
    const channelId = fixture.fixture.channel.id;
    appendContinuityDecision(
      fixture.repositories,
      channelId,
      aired({ id: "actually-aired", airedAt: "2026-09-20T11:00:00.000Z" }),
    );
    appendContinuityDecision(
      fixture.repositories,
      channelId,
      planned({
        id: "self-generation",
        scheduleRevision: "revision-current",
        plannedAt: "2026-09-20T11:30:00.000Z",
        cardType: "next",
        targetKey: "airing-a",
      }),
    );
    appendContinuityDecision(
      fixture.repositories,
      channelId,
      planned({
        id: "other-generation",
        scheduleRevision: "revision-other",
        plannedAt: "2026-09-20T11:45:00.000Z",
        cardType: "next",
        targetKey: "airing-b",
      }),
    );
    appendContinuityDecision(
      fixture.repositories,
      channelId,
      planned({
        id: "future-record",
        scheduleRevision: "revision-other",
        plannedAt: "2026-09-20T13:00:00.000Z",
        cardType: "tonight",
        targetKey: "airing-c",
      }),
    );

    const history = readContinuityHistoryForPlanning(fixture.repositories, channelId, {
      before: "2026-09-20T12:00:00.000Z",
      excludeScheduleRevision: "revision-current",
    });
    // The current generation's own plans and anything after the planning instant
    // are excluded; a genuinely published insertion counts, and it is not
    // dressed up as an airing.
    expect(history.map((entry) => entry.assetId)).toEqual([
      "station-id-2",
      "station-id-1",
    ]);
    expect(history.map((entry) => entry.state)).toEqual(["aired", "planned"]);
    expect(history[1]).toMatchObject({
      cardType: "next",
      targetKey: "airing-b",
      airedAt: "2026-09-20T11:45:00.000Z",
    });
  });
});
