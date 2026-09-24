import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAiringLedger, type AiringWriteResult } from "../../src/autopilot/airingLedger.js";
import {
  createSourceContinuation,
  durablePublishedContiguousEnd,
} from "../../src/autopilot/sourceContinuation.js";
import { openDatabase } from "../../src/db/database.js";

/*
 * PL03 — "Continue same occurrence from next source interval; no full-film
 * completion or rewind."
 *
 * Producer-side continuation for one occurrence. A continuation offset is the
 * end of the greatest source range DURABLY PUBLISHED contiguously; a gap stops
 * it. Two failure directions are the point of these tests:
 *   - rewinding: resuming at source zero, or moving a durable boundary
 *     backwards, would replay content;
 *   - completing: skipping a gap, or treating the end of source as reached,
 *     would claim a film finished when it did not.
 * Neither is reachable: with no published coverage the planner refuses, and
 * `restartAtSourceZero` is fixed false by the plan type.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function dataDir() {
  const path = await mkdtemp(join(tmpdir(), "marktv-source-continuation-"));
  directories.push(path);
  return path;
}

function ok<T>(result: AiringWriteResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  }
  return result.value;
}

const AT = "2026-09-23T05:00:00.000Z";
const SOURCE_START = 0;
const SOURCE_END = 1_440_000;

/** A track with one reserved occurrence covering the whole source. */
function reservedOccurrence(database: ReturnType<typeof openDatabase>) {
  const ledger = createAiringLedger(database);
  const track = ok(
    ledger.ensureSeriesTrack({ channelId: "marktv-laughs", seriesTitle: "Night Court", at: AT }),
  );
  ok(
    ledger.ensureEpisodeIdentity({
      episodeKey: "S01E04",
      trackKey: track.trackKey,
      title: "Night Court S01E04",
      season: 1,
      episode: 4,
      at: AT,
    }),
  );
  const reservation = ok(
    ledger.reserveOccurrence({
      occurrenceKey: "occ-pl03",
      trackKey: track.trackKey,
      episodeKey: "S01E04",
      channelId: "marktv-laughs",
      broadcastDate: "2026-09-23",
      plannedStart: AT,
      plannedEnd: "2026-09-23T05:24:00.000Z",
      sourceMediaId: "S01E04-file",
      sourceStartMs: SOURCE_START,
      sourceEndMs: SOURCE_END,
    }),
  );
  return { ledger, reservation };
}

function publish(
  ledger: ReturnType<typeof createAiringLedger>,
  occurrenceKey: string,
  intervals: Array<[number, number]>,
) {
  intervals.forEach(([sourceStartMs, sourceEndMs], index) => {
    ok(
      ledger.recordPublishedInterval({
        intervalId: `${occurrenceKey}-pub-${index}`,
        occurrenceKey,
        sourceStartMs,
        sourceEndMs,
        publishedAt: AT,
        evidence: "hls-publisher-ack",
      }),
    );
  });
}

test("[PL03] resumes from the durable contiguous published end, never from source zero", async () => {
  const database = openDatabase(await dataDir());
  try {
    const { ledger } = reservedOccurrence(database);
    publish(ledger, "occ-pl03", [[0, 120_000]]);

    const plan = createSourceContinuation(database).planContinuation({
      occurrenceKey: "occ-pl03",
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The next source request begins where publication actually stopped.
    expect(plan.value.requestedSourceOffsetMs).toBe(120_000);
    expect(plan.value.sourceMediaId).toBe("S01E04-file");
    // Rewinding is not representable on a plan.
    expect(plan.value.restartAtSourceZero).toBe(false);
  } finally {
    database.close();
  }
});

test("[PL03] a gap in published coverage stops the boundary instead of skipping it", async () => {
  const database = openDatabase(await dataDir());
  try {
    const { ledger } = reservedOccurrence(database);
    // Reachable coverage ends at 120s; the second range is far ahead and does
    // not touch it. Advancing to 420s would claim unwatched source as published
    // and would replay nothing for the viewer but silently drop 3 minutes.
    publish(ledger, "occ-pl03", [
      [0, 120_000],
      [300_000, 420_000],
    ]);

    const plan = createSourceContinuation(database).planContinuation({
      occurrenceKey: "occ-pl03",
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.requestedSourceOffsetMs).toBe(120_000);
    // And it has not jumped to the end of the film either.
    expect(plan.value.requestedSourceOffsetMs).toBeLessThan(plan.value.sourceEndMs);
  } finally {
    database.close();
  }
});

test("[PL03] with no published coverage it refuses rather than resuming at source zero", async () => {
  const database = openDatabase(await dataDir());
  try {
    reservedOccurrence(database);

    const plan = createSourceContinuation(database).planContinuation({
      occurrenceKey: "occ-pl03",
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    // Refusing is the only outcome that cannot replay the opening.
    expect(plan.reason).toBe("insufficient-evidence");
  } finally {
    database.close();
  }
});

test("[PL03] touching intervals are joined and a detached interval never rewinds the boundary", () => {
  // Touching endpoints count as joined, so the boundary advances across them.
  expect(
    durablePublishedContiguousEnd(
      [
        { sourceStartMs: 0, sourceEndMs: 100_000 },
        { sourceStartMs: 100_000, sourceEndMs: 200_000 },
      ],
      0,
      1_440_000,
    ),
  ).toBe(200_000);

  // An interval that starts below the anchor is ignored rather than rewinding
  // the cursor, and one that does not touch the cursor cannot advance it.
  expect(
    durablePublishedContiguousEnd(
      [
        { sourceStartMs: 50_000, sourceEndMs: 60_000 },
        { sourceStartMs: 500_000, sourceEndMs: 600_000 },
      ],
      0,
      1_440_000,
    ),
  ).toBe(0);

  // Coverage is anchored at the start: the first gap is the end of the run.
  expect(
    durablePublishedContiguousEnd(
      [
        { sourceStartMs: 0, sourceEndMs: 90_000 },
        { sourceStartMs: 95_000, sourceEndMs: 200_000 },
      ],
      0,
      1_440_000,
    ),
  ).toBe(90_000);
});
