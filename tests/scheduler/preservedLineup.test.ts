import { expect, test } from "vitest";
import { DateTime } from "luxon";
import {
  normalizePreservedLineup,
  preservedLineupStartTimes,
  slicePreservedLineupDay,
  type PreservedLineupClip,
  type PreservedLineupIssueCode,
  type PreservedLineupSlice,
} from "../../src/scheduler/preservedLineup.js";
import {
  archiveOf,
  coveringSpecs,
  dayEnd,
  dayStart,
  moviePattern,
  preservedZone,
  repeatSpecs,
  type PreservedEntrySpec,
} from "../support/preservedLineupFixture.js";

const slices = (
  archive: Parameters<typeof slicePreservedLineupDay>[0]["archive"],
  dates: string[],
  cycle: "once" | "repeat" = "once",
) =>
  dates.map((date) => {
    const result = slicePreservedLineupDay({
      archive,
      date,
      timezone: preservedZone,
      cycle,
    });
    expect(result.ok ? "" : JSON.stringify(result.issues)).toBe("");
    if (!result.ok) throw new Error("expected a slice");
    return result.clips;
  });

const issueCodes = (result: PreservedLineupSlice): PreservedLineupIssueCode[] =>
  result.ok ? [] : result.issues.map((entry) => entry.code);

const bySourceIndex = (clips: PreservedLineupClip[]) =>
  [...clips].sort(
    (left, right) =>
      left.sourceIndex - right.sourceIndex || left.start - right.start,
  );

test("slices whole days in archive order without reselecting a movie", () => {
  const base = dayStart("2026-09-15");
  const archive = archiveOf(
    base,
    coveringSpecs(moviePattern, 3 * 86_400_000),
  );
  const starts = preservedLineupStartTimes(
    base,
    archive.entries.map((entry) => ({ durationMs: entry.durationMs })),
  );
  const dates = ["2026-09-15", "2026-09-16", "2026-09-17"];
  const dayClips = slices(archive, dates);

  for (const [index, clips] of dayClips.entries()) {
    const date = dates[index];
    // Each day is covered exactly, from local midnight to local midnight.
    expect(clips[0].start).toBe(dayStart(date));
    expect(clips.at(-1)!.end).toBe(dayEnd(date));
    expect(
      clips.reduce((total, clip) => total + clip.durationMs, 0),
    ).toBe(dayEnd(date) - dayStart(date));
    for (let position = 1; position < clips.length; position += 1)
      expect(clips[position].start).toBe(clips[position - 1].end);
  }

  // The whole archive is replayed in order: a clip always continues the entry
  // its predecessor was in, which is what "no reselection" has to mean.
  const everyClip = bySourceIndex(dayClips.flat());
  for (const clip of everyClip) {
    const entry = archive.entries[clip.sourceIndex];
    expect(clip.mediaId).toBe(entry.mediaId);
    expect(clip.kind).toBe(entry.kind);
    expect(clip.sourceOffsetMs).toBe(
      Math.round((entry.sourceOffsetMs ?? 0) + (clip.start - starts[clip.sourceIndex])),
    );
  }
  for (let position = 1; position < everyClip.length; position += 1) {
    const previous = everyClip[position - 1];
    const current = everyClip[position];
    expect(current.sourceIndex).toBeLessThanOrEqual(previous.sourceIndex + 1);
    expect(current.sourceIndex).toBeGreaterThanOrEqual(previous.sourceIndex);
  }

  // A film that airs whole starts at exactly its imported instant, with no
  // offset - the archive's start times survive the slice untouched.
  const wholeFilms = archive.entries
    .map((entry, index) => ({ entry, start: starts[index], end: starts[index + 1] }))
    .filter(({ entry }) => entry.kind === "movie");
  const dayWindows = dates.map((date) => [dayStart(date), dayEnd(date)]);
  for (const film of wholeFilms) {
    if (
      !dayWindows.some(
        ([start, end]) => film.start >= start && film.end <= end,
      )
    )
      continue;
    const clip = everyClip.find(
      (candidate) => candidate.sourceIndex === archive.entries.indexOf(film.entry),
    );
    expect(clip).toBeTruthy();
    expect(clip!.start).toBe(film.start);
    expect(clip!.sourceOffsetMs).toBe(0);
  }
});

test("clips a film at midnight and continues it at the advanced source offset", () => {
  const base = dayStart("2026-09-15");
  const archive = archiveOf(base, [
    // Opens one minute before midnight, so the film crosses the boundary and the
    // converter has already marked the entry as starting 5s into its file.
    { mediaId: "lead-in", kind: "commercial", durationMs: 30_000 },
    {
      mediaId: "movie-x",
      kind: "movie",
      durationMs: 7_200_000,
      sourceOffsetMs: 5_000,
    },
    {
      mediaId: "rest-of-day",
      kind: "commercial",
      durationMs: 86_400_000 - 7_170_000,
    },
  ]);
  // Shift the whole archive so the film straddles this channel's midnight.
  const earlier = archiveOf(
    base - 60_000,
    archive.entries.map((entry) => ({
      mediaId: entry.mediaId,
      kind: entry.kind,
      durationMs: entry.durationMs,
      ...(entry.sourceOffsetMs ? { sourceOffsetMs: entry.sourceOffsetMs } : {}),
    })),
  );
  const clips = slices(earlier, ["2026-09-15"])[0];
  const film = clips.find((clip) => clip.mediaId === "movie-x");
  expect(film).toBeTruthy();
  // The half of the film that airs today starts at local midnight, is 30s short
  // of the source, and points 35s into the file: 30s of elapsed wall time on top
  // of the 5s the import already recorded.
  expect(film!.start).toBe(dayStart("2026-09-15"));
  expect(film!.durationMs).toBe(7_200_000 - 30_000);
  expect(film!.sourceOffsetMs).toBe(35_000);

  const before = slicePreservedLineupDay({
    archive: earlier,
    date: "2026-09-14",
    timezone: preservedZone,
    cycle: "once",
  });
  expect(issueCodes(before)).toEqual(["PRESERVED_LINEUP_OUT_OF_RANGE"]);
});

test("absorbs fractional commercial lengths by rounding cumulative boundaries", () => {
  const base = dayStart("2026-09-15");
  const spots: PreservedEntrySpec[] = Array.from({ length: 400 }, (_, index) => ({
    mediaId: `spot-${index + 1}`,
    kind: "commercial" as const,
    durationMs: 30_000.4,
  }));
  const archive = archiveOf(base, [
    ...spots,
    { mediaId: "movie-after-ads", kind: "movie", durationMs: 90 * 60_000 },
    { mediaId: "tail", kind: "commercial", durationMs: 86_400_000 },
  ]);
  const starts = preservedLineupStartTimes(
    base,
    archive.entries.map((entry) => ({ durationMs: entry.durationMs })),
  );
  // 400 breaks of 30.0004s are 160ms longer than 400 whole breaks. Cumulative
  // rounding keeps that 160ms; rounding each break first would have thrown it
  // away and started the film 160ms early.
  const perEntryRounded = base + spots.length * 30_000;
  expect(starts[spots.length]).toBe(base + 12_000_160);
  expect(starts[spots.length]).not.toBe(perEntryRounded);
  expect(
    Math.abs(starts[spots.length] - (base + spots.length * 30_000.4)),
  ).toBeLessThanOrEqual(0.5);

  const clips = slices(archive, ["2026-09-15"])[0];
  const film = clips.find((clip) => clip.mediaId === "movie-after-ads")!;
  expect(film.start).toBe(base + 12_000_160);
  expect(film.sourceOffsetMs).toBe(0);
});

test("slices DST days at their real length", () => {
  const spring = archiveOf(
    dayStart("2026-03-08"),
    coveringSpecs(moviePattern, 2 * 86_400_000),
  );
  const springClips = slices(spring, ["2026-03-08"])[0];
  expect(dayEnd("2026-03-08") - dayStart("2026-03-08")).toBe(23 * 3_600_000);
  expect(springClips[0].start).toBe(
    DateTime.fromISO("2026-03-08T00:00", { zone: preservedZone }).toMillis(),
  );
  expect(springClips.at(-1)!.end).toBe(
    DateTime.fromISO("2026-03-09T00:00", { zone: preservedZone }).toMillis(),
  );
  expect(
    springClips.reduce((total, clip) => total + clip.durationMs, 0),
  ).toBe(23 * 3_600_000);

  const fall = archiveOf(
    dayStart("2026-11-01"),
    coveringSpecs(moviePattern, 2 * 86_400_000),
  );
  const fallClips = slices(fall, ["2026-11-01"])[0];
  expect(dayEnd("2026-11-01") - dayStart("2026-11-01")).toBe(25 * 3_600_000);
  expect(
    fallClips.reduce((total, clip) => total + clip.durationMs, 0),
  ).toBe(25 * 3_600_000);
  // The reel is continuous across the repeated hour: nothing restarts, and no
  // film is skipped because the wall clock went backwards.
  for (let position = 1; position < fallClips.length; position += 1)
    expect(fallClips[position].start).toBe(fallClips[position - 1].end);
});

test("fails closed on a missing, malformed, unapproved or out-of-coverage archive", () => {
  const base = dayStart("2026-09-15");
  const twoDays = archiveOf(base, coveringSpecs(moviePattern, 2 * 86_400_000));

  expect(
    issueCodes(
      slicePreservedLineupDay({
        archive: twoDays,
        date: "2026-09-14",
        timezone: preservedZone,
        cycle: "once",
      }),
    ),
  ).toEqual(["PRESERVED_LINEUP_OUT_OF_RANGE"]);
  expect(
    issueCodes(
      slicePreservedLineupDay({
        archive: twoDays,
        date: "2026-09-20",
        timezone: preservedZone,
        cycle: "once",
      }),
    ),
  ).toEqual(["PRESERVED_LINEUP_EXHAUSTED"]);

  expect(normalizePreservedLineup({ schemaVersion: 1 }).ok).toBe(false);
  const inconsistent = normalizePreservedLineup({
    schemaVersion: 1,
    sourceId: "channel-8-movies",
    entries: [
      {
        startTime: base,
        mediaId: "movie-a",
        kind: "movie",
        durationMs: 60_000,
      },
      {
        startTime: base + 60_001,
        mediaId: "movie-b",
        kind: "movie",
        durationMs: 60_000,
      },
    ],
  });
  expect(inconsistent.ok).toBe(false);
  expect(
    inconsistent.ok ? [] : inconsistent.issues.map((entry) => entry.code),
  ).toEqual(["PRESERVED_LINEUP_INVALID"]);

  const tampered = normalizePreservedLineup({
    schemaVersion: 1,
    sourceId: "channel-8-movies",
    digest: "0".repeat(64),
    entries: [
      {
        startTime: base,
        mediaId: "movie-a",
        kind: "movie",
        durationMs: 86_400_000,
      },
    ],
  });
  expect(tampered.ok ? [] : tampered.issues.map((entry) => entry.code)).toEqual([
    "PRESERVED_LINEUP_DIGEST_MISMATCH",
  ]);

  // An archive shorter than the broadcast day cannot be tiled, so it is refused
  // rather than padded with anything at all.
  const short = archiveOf(base, [
    { mediaId: "movie-a", kind: "movie", durationMs: 3_600_000 },
  ]);
  expect(
    issueCodes(
      slicePreservedLineupDay({
        archive: short,
        date: "2026-09-15",
        timezone: preservedZone,
        cycle: "repeat",
      }),
    ),
  ).toEqual(["PRESERVED_LINEUP_OUT_OF_RANGE"]);
});

test("repeats the archive by its exact span when the binding asks for it", () => {
  const base = dayStart("2026-09-15");
  // Twelve 119.5-minute features plus a 30s break make exactly three hours, so
  // 24 cycles are exactly two broadcast days and the span is unambiguous.
  const twoDays = archiveOf(
    base,
    repeatSpecs(
      [
        { mediaId: "movie", kind: "movie", durationMs: 7_170_000 },
        { mediaId: "ad", kind: "commercial", durationMs: 30_000 },
      ],
      24,
    ),
  );
  const span = 2 * 86_400_000;
  const inRange = slices(twoDays, ["2026-09-15"])[0];
  const wrapped = slices(twoDays, ["2026-09-17"], "repeat")[0];
  expect(wrapped.map((clip) => clip.mediaId)).toEqual(
    inRange.map((clip) => clip.mediaId),
  );
  for (const [index, clip] of wrapped.entries())
    expect(clip.start).toBe(inRange[index].start + span);
  // A day before the archive lands on the same reel, shifted backwards.
  const earlier = slices(twoDays, ["2026-09-13"], "repeat")[0];
  expect(earlier.map((clip) => clip.mediaId)).toEqual(
    inRange.map((clip) => clip.mediaId),
  );
  expect(earlier[0].start).toBe(dayStart("2026-09-13"));

  // A loop whose span is not a whole number of days runs off the end mid-day and
  // continues from the top of the archive, still inside this broadcast day.
  const oneAndAHalfDays = archiveOf(
    base,
    repeatSpecs(
      [
        { mediaId: "movie", kind: "movie", durationMs: 7_170_000 },
        { mediaId: "ad", kind: "commercial", durationMs: 30_000 },
      ],
      18,
    ),
  );
  const wrappedDay = slices(oneAndAHalfDays, ["2026-09-16"], "repeat")[0];
  expect(
    wrappedDay.reduce((total, clip) => total + clip.durationMs, 0),
  ).toBe(86_400_000);
  expect(wrappedDay[0].start).toBe(dayStart("2026-09-16"));
  expect(wrappedDay.at(-1)!.end).toBe(dayStart("2026-09-17"));
  for (let position = 1; position < wrappedDay.length; position += 1)
    expect(wrappedDay[position].start).toBe(wrappedDay[position - 1].end);
  const wrapIndex = wrappedDay.findIndex(
    (clip) => clip.start === dayStart("2026-09-16") + 12 * 3_600_000,
  );
  expect(wrapIndex).toBeGreaterThan(0);
  expect(wrappedDay[wrapIndex].mediaId).toBe("movie-1");
  expect(wrappedDay[wrapIndex].sourceOffsetMs).toBe(0);
});

test("a full-year archive of 42k entries slices a middle day exactly", () => {
  // Same shape as the imported archive this feature exists for: a feature plus a
  // handful of fractional breaks, repeated for a year, 42 490 entries and a total
  // that is not a whole millisecond.
  const base = dayStart("2026-09-15");
  const cycles = 4_249;
  const pattern: PreservedEntrySpec[] = [
    { mediaId: "feature", kind: "movie", durationMs: 7_170_000 },
    ...Array.from({ length: 9 }, (_, index) => ({
      mediaId: `break-${index + 1}`,
      kind: "commercial" as const,
      durationMs: 30_000.05,
    })),
  ];
  const specs = repeatSpecs(pattern, cycles);
  expect(specs.length).toBe(42_490);
  const archive = archiveOf(base, specs);
  const starts = preservedLineupStartTimes(
    base,
    archive.entries.map((entry) => ({ durationMs: entry.durationMs })),
  );
  const exactTotal = specs.reduce((total, spec) => total + spec.durationMs, 0);
  expect(starts.at(-1)! - base).toBe(Math.round(exactTotal));
  // A year of programming, still within a millisecond of the imported total.
  expect(Math.abs(exactTotal - 31_612_561_911)).toBeLessThan(50_000_000);

  const date = DateTime.fromMillis(base, { zone: preservedZone })
    .plus({ days: 200 })
    .toISODate()!;
  const clips = slices(archive, [date])[0];
  expect(clips[0].start).toBe(dayStart(date));
  expect(clips.at(-1)!.end).toBe(dayEnd(date));
  for (const clip of clips) {
    const entry = archive.entries[clip.sourceIndex];
    expect(clip.sourceOffsetMs).toBe(
      Math.round((entry.sourceOffsetMs ?? 0) + (clip.start - starts[clip.sourceIndex])),
    );
    if (clip.start === starts[clip.sourceIndex]) {
      // A film that starts inside the day starts at exactly its imported
      // instant, 42 490 entries into the archive.
      expect(clip.start).toBe(starts[clip.sourceIndex]);
      expect(clip.sourceOffsetMs).toBe(0);
    } else {
      // Only the day boundary may move a start, and only to midnight, with the
      // elapsed wall time carried as a source offset.
      expect(clip.start).toBe(dayStart(date));
      expect(clip.sourceOffsetMs).toBeGreaterThan(0);
    }
  }
  // The day still holds a normal feature rotation, not a fraction of one.
  const features = clips.filter((clip) => clip.kind === "movie");
  expect(features.length).toBeGreaterThanOrEqual(10);
  expect(features.length).toBeLessThanOrEqual(13);
});

test("normalizing is deterministic and content-addressed", () => {
  const base = dayStart("2026-09-15");
  const archive = archiveOf(base, repeatSpecs(moviePattern, 2));
  const again = normalizePreservedLineup(archive);
  expect(again.ok && again.archive.digest).toBe(archive.digest);

  const changed = normalizePreservedLineup({
    ...archive,
    entries: archive.entries.map((entry, index) =>
      index === 0 ? { ...entry, durationMs: entry.durationMs + 1_000 } : entry,
    ),
  });
  expect(changed.ok && changed.archive.digest).not.toBe(archive.digest);
});
