import { afterEach, expect, test } from "vitest";
import { DateTime } from "luxon";
import {
  cleanupRepositoryFixtures,
  makeScheduleService,
  openMovieRepositories,
} from "../support/repositoryFixture.js";
import { ensureMovieProgrammingPool } from "../../src/media/movieEnrollment.js";
import { movieOccurrenceKey } from "../../src/domain/movieProgramming.js";

afterEach(async () => {
  await cleanupRepositoryFixtures();
});

const now = () => new Date("2026-09-07T12:00:00.000Z");

test("a generated day stores its movie assignments and rotation", async () => {
  const fixture = await openMovieRepositories({ now });
  const result = await fixture.service.generate(fixture.fixture.channel, "2026-09-09");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const movie = result.schedule.entries.find(
    (entry) => entry.movieOccurrenceKey === "2026-09-09:nightly",
  );
  expect(movie).toBeTruthy();
  const stored = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-09",
    "nightly",
  );
  expect(stored?.mediaId).toBe(movie?.mediaId);
  expect(
    fixture.repositories.movieRotations.get("marktv-laughs")?.order,
  ).toHaveLength(30);
  fixture.close();
});

test("previewing, regenerating and restarting never consume the rotation", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  const first = await fixture.service.generate(channel, "2026-09-09");
  const rotation = fixture.repositories.movieRotations.get("marktv-laughs")!;
  const ledger = fixture.repositories.movieOccurrences.listForDate(
    "marktv-laughs",
    "2026-09-09",
  );
  expect(ledger.length).toBeGreaterThan(0);

  // A preview resolves the same dates again and must change nothing that was
  // already assigned. It MAY add the future assignments its horizon covers, which
  // is exactly the rolling preview the feature promises, and it must not touch the
  // rotation or the day that already aired.
  const preview = await fixture.service.movieProgrammingPreview(channel, now());
  expect(preview.enabled).toBe(true);
  expect(
    fixture.repositories.movieOccurrences.listForDate("marktv-laughs", "2026-09-09"),
  ).toEqual(ledger);
  expect(preview.upcoming.filter((airing) => airing.date === "2026-09-09")).toEqual(
    ledger.map((occurrence) => ({
      date: occurrence.date,
      position: occurrence.position,
      role: occurrence.role,
      anchor: occurrence.anchor,
      mediaId: occurrence.mediaId,
      title: expect.any(String),
      encore: !occurrence.consumes,
      available: true,
      consumes: occurrence.consumes,
    })),
  );

  const second = await fixture.service.generate(channel, "2026-09-09");
  expect(first.ok && second.ok && second.schedule.id).toBe(
    first.ok ? first.schedule.id : undefined,
  );
  expect(fixture.repositories.movieRotations.get("marktv-laughs")!.order).toEqual(
    rotation.order,
  );
  expect(
    fixture.repositories.movieOccurrences.listForDate("marktv-laughs", "2026-09-09"),
  ).toEqual(ledger);

  // A restart reads the same ledger back.
  const reopened = fixture.reopen();
  expect(reopened.movieRotations.get("marktv-laughs")!.order).toEqual(
    rotation.order,
  );
  expect(
    reopened.movieOccurrences
      .listForDate("marktv-laughs", "2026-09-09")
      .map((occurrence) => movieOccurrenceKey(occurrence.date, occurrence.position)),
  ).toEqual(
    ledger.map((occurrence) => movieOccurrenceKey(occurrence.date, occurrence.position)),
  );
  reopened.close();
});

test("a rescan extends the pool without reshuffling the existing rotation", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  await fixture.service.generate(channel, "2026-09-09");
  const rotation = fixture.repositories.movieRotations.get("marktv-laughs")!;
  const assignment = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-09",
    "nightly",
  )!;

  const added = {
    id: "movie-99",
    source: "local-folder" as const,
    path: "/Volumes/SSK Drive /MarkTV/Movies/New Arrival (2026).mkv",
    kind: "movie" as const,
    title: "New Arrival",
    durationMs: 100 * 60_000,
    durationStatus: "ok" as const,
    available: true,
    tags: [],
  };
  fixture.repositories.media.put(added);
  const outcomes = ensureMovieProgrammingPool(
    fixture.repositories,
    channel,
  );
  expect(outcomes[0]).toMatchObject({ added: 1, movieCount: 31 });

  const regenerated = await fixture.service.generate(channel, "2026-09-09");
  expect(regenerated.ok).toBe(true);
  // The already-assigned day keeps its movie; only the pool and the tail of the
  // bag grow.
  expect(
    fixture.repositories.movieOccurrences.get(
      "marktv-laughs",
      "2026-09-09",
      "nightly",
    ),
  ).toEqual(assignment);
  const extended = fixture.repositories.movieRotations.get("marktv-laughs")!;
  expect(extended.order.slice(0, rotation.order.length)).toEqual(rotation.order);
  expect(extended.order).toContain("movie-99");
  fixture.close();
});

test("an unmounted folder preserves the inventory, the rotation and reports degraded", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  await fixture.service.generate(channel, "2026-09-09");
  const rotation = fixture.repositories.movieRotations.get("marktv-laughs")!;

  // An unmount means the scan fails before it writes anything, so the media rows
  // are untouched. The next generation and preview must still work from what is
  // stored, and say plainly that the folder is unreachable.
  const preview = await fixture.service.movieProgrammingPreview(
    channel,
    now(),
    async () => false,
  );
  expect(preview.movieCount).toBe(rotation.order.length);
  const degraded = preview.enabled ? preview.degraded : [];
  expect(
    degraded.some((message) => message.includes("not reachable")),
  ).toBe(true);
  expect(
    fixture.repositories.movieRotations.get("marktv-laughs")!.order,
  ).toEqual(rotation.order);

  const generated = await fixture.service.generate(channel, "2026-09-10");
  expect(generated.ok).toBe(true);
  expect(
    fixture.repositories.movieRotations.get("marktv-laughs")!.order,
  ).toEqual(rotation.order);
  fixture.close();
});

test("a rotation survives an inventory that went entirely unavailable", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  await fixture.service.generate(channel, "2026-09-09");
  const rotation = fixture.repositories.movieRotations.get("marktv-laughs")!;
  for (const item of fixture.repositories.media.list()) {
    if (item.kind === "movie")
      fixture.repositories.media.put({ ...item, available: false });
  }
  // Nothing is eligible, so there is nothing to prune against: the saved order is
  // kept rather than emptied, and no new assignment is invented.
  const result = await fixture.service.generate(channel, "2026-09-17");
  expect(result.ok).toBe(true);
  expect(
    fixture.repositories.movieRotations.get("marktv-laughs")!.order,
  ).toEqual(rotation.order);
  fixture.close();
});

test("the weekend encore links travel through the service ledger", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  // Sunday first: its 02:00 encore has to reach back to Saturday's opener.
  await fixture.service.generate(channel, "2026-09-13");
  const saturday = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-12",
    "double-feature-1",
  );
  const sundayEncore = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-13",
    "nightly",
  );
  expect(saturday).toBeTruthy();
  expect(sundayEncore).toMatchObject({
    consumes: false,
    mediaId: saturday!.mediaId,
    encoreOf: movieOccurrenceKey("2026-09-12", "double-feature-1"),
  });
  fixture.close();
});

test("rolling coverage resolves a week or more of upcoming airings", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  const coverage = await fixture.service.ensureMovieCoverage(channel, now());
  expect(coverage.resolvedDates.length).toBeGreaterThanOrEqual(8);
  const preview = await fixture.service.movieProgrammingPreview(channel, now());
  const dates = new Set(
    "upcoming" in preview
      ? preview.upcoming.map((airing) => airing.date)
      : [],
  );
  expect(dates.size).toBeGreaterThanOrEqual(8);
  const horizon = DateTime.fromJSDate(now(), {
    zone: channel.timezone,
  })
    .startOf("day")
    .plus({ days: 7 })
    .toISODate()!;
  expect([...dates].some((date) => date >= horizon)).toBe(true);
  // Coverage also extends the stored schedules, one date per pass at most.
  expect(coverage.generatedDate).toBeDefined();
  expect(
    fixture.repositories.schedules.latestForDate(
      channel.id,
      coverage.generatedDate!,
    ),
  ).toBeTruthy();
  fixture.close();
});

test("a movie root that never mounted reports degraded without losing state", async () => {
  const fixture = await openMovieRepositories({ now });
  const service = makeScheduleService(
    fixture.repositories,
    fixture.dataDir,
    now,
  );
  const preview = await service.movieProgrammingPreview(
    fixture.fixture.channel,
    now(),
    async () => false,
  );
  expect(preview).toMatchObject({ enabled: true, rootAvailable: false });
  expect(preview.enabled ? preview.degraded.join("\n") : "").toContain(
    "not reachable",
  );
  fixture.close();
});

test("the status preview is non-mutating: no rotation, no occurrence, no schedule", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  // Nothing has been generated yet, so there is no rotation to read back: the
  // preview has to answer without creating one.
  const before = {
    rotation: fixture.repositories.movieRotations.get("marktv-laughs"),
    occurrences: fixture.repositories.movieOccurrences.listForChannel(
      "marktv-laughs",
    ),
    schedules: fixture.repositories.schedules.list("marktv-laughs"),
  };
  const preview = await fixture.service.movieProgrammingPreview(channel, now());
  expect(preview.enabled).toBe(true);
  expect(preview.enabled ? preview.upcoming.length : 0).toBeGreaterThan(0);

  expect(fixture.repositories.movieRotations.get("marktv-laughs")).toEqual(
    before.rotation,
  );
  expect(
    fixture.repositories.movieOccurrences.listForChannel("marktv-laughs"),
  ).toEqual(before.occurrences);
  expect(fixture.repositories.schedules.list("marktv-laughs")).toEqual(
    before.schedules,
  );

  // Asked a second time, it answers the same thing - a preview that reserved
  // anything would drift on every page load.
  expect(await fixture.service.movieProgrammingPreview(channel, now())).toEqual(
    preview,
  );
  fixture.close();
});

test("a future assignment whose movie vanished is repaired with its encore", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  await fixture.service.generate(channel, "2026-09-12");
  await fixture.service.generate(channel, "2026-09-13");
  const opener = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-12",
    "double-feature-1",
  )!;
  const encore = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-13",
    "nightly",
  )!;
  expect(encore.mediaId).toBe(opener.mediaId);

  // The film left the library: deleted, moved out of the configured root, or
  // reported missing by the last scan.
  fixture.repositories.media.put({
    ...fixture.repositories.media.get(opener.mediaId)!,
    available: false,
  });

  await fixture.service.generate(channel, "2026-09-12");
  const repaired = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-12",
    "double-feature-1",
  )!;
  // A bounded alternate from the rotation, not a blank or a repeat of the dead id.
  expect(repaired.mediaId).not.toBe(opener.mediaId);
  expect(
    fixture.repositories.movieRotations.get("marktv-laughs")!.order,
  ).toContain(repaired.mediaId);
  // The encore replays the opener, whichever film that now is.
  expect(
    fixture.repositories.movieOccurrences.get(
      "marktv-laughs",
      "2026-09-13",
      "nightly",
    )!.mediaId,
  ).toBe(repaired.mediaId);
  fixture.close();
});

test("an aired assignment is never rewritten when its movie vanished", async () => {
  const fixture = await openMovieRepositories({ now });
  const channel = fixture.fixture.channel;
  // 2026-09-05 is before the clock's 2026-09-07: it has already been broadcast.
  await fixture.service.generate(channel, "2026-09-05");
  const aired = fixture.repositories.movieOccurrences.get(
    "marktv-laughs",
    "2026-09-05",
    "nightly",
  )!;
  fixture.repositories.media.put({
    ...fixture.repositories.media.get(aired.mediaId)!,
    available: false,
  });
  await fixture.service.generate(channel, "2026-09-05");
  // History is history: the schedule for that day can no longer air the film, but
  // the record of what was assigned is not rewritten.
  expect(
    fixture.repositories.movieOccurrences.get(
      "marktv-laughs",
      "2026-09-05",
      "nightly",
    ),
  ).toEqual(aired);
  fixture.close();
});

test("movie programming disabled means the preview says so and schedules nothing", async () => {
  const fixture = await openMovieRepositories({
    now,
    programming: { enabled: false },
  });
  const preview = await fixture.service.movieProgrammingPreview(
    fixture.fixture.channel,
    now(),
  );
  expect(preview.enabled).toBe(false);
  const result = await fixture.service.generate(
    fixture.fixture.channel,
    "2026-09-09",
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.schedule.entries.some((entry) => entry.source === "movie-programming"),
  ).toBe(false);
  expect(fixture.repositories.movieRotations.get("marktv-laughs")).toBeUndefined();
  fixture.close();
});
