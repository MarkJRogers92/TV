# Preserved imported lineups

A **preserved lineup channel** airs a lineup somebody else already programmed -
an imported movie channel whose exact film order and start instants an operator
approved - instead of a lineup MarkTV selected. Generation for such a channel is
a *slice*, not a selection: the requested broadcast day is cut out of an
immutable, normalized archive that maps the import onto MarkTV media ids.

Nothing about ordinary channels changes. A channel with no `preservedLineup`
binding is generated exactly as before, and the two kinds of channel can coexist.

## Plan (what this change does)

1. **Archive in, day out.** `src/scheduler/preservedLineup.ts` validates a
   normalized archive, computes a content digest, and slices exactly one
   broadcast day from it. It never consults a pool, never applies a cooldown and
   never swaps a program.
2. **Channel binding.** `channel.preservedLineup` (`src/domain/models.ts`) names
   the archive (`settings` row `preserved-lineup:<sourceId>`), optionally pins
   the digest the channel was approved against, and declares what a day outside
   the archive's coverage means (`cycle: "once" | "repeat"`, default `"once"`).
3. **Service integration.** `ScheduleService.generate()` checks the binding
   before it does any ordinary work. A bound channel is sliced; every other
   channel runs the unchanged generation path. Either way the existing continuity
   pass then runs over the finished lineup, and the existing export/persist/sync
   path stores it.
4. **Fail closed.** A missing, malformed, tampered, out-of-coverage or unmappable
   archive refuses the day (HTTP 422 with `ok: false` from the generation API, a
   "generation was refused" warning from the refresh loop). Ordinary selection is
   never a fallback, because a scheduled-from-scratch day is a different product,
   not a degraded one.
5. **Only the requested day is materialized.** A year-long archive never becomes
   a year of stored schedules; retention stays at its existing 90 generations
   per channel, and the quiet-hours refresh still pre-builds at most tomorrow.

## Normalized archive format (schema version 1)

Stored as one `settings` row whose key is `preserved-lineup:<sourceId>`:

```jsonc
{
  "schemaVersion": 1,
  "sourceId": "channel-8-movies",
  "generatedAt": "2026-09-22T18:00:00.000Z", // optional provenance, not identity
  "entries": [
    {
      "startTime": 1789794000000,   // epoch ms, exact broadcast start in the channel tz
      "mediaId": "movie-042",       // MarkTV catalog id
      "kind": "movie",              // episode|movie|commercial|filler|station-id|bumper
      "durationMs": 7020000,        // exact source length; may be fractional
      "sourceOffsetMs": 0,          // optional: where playback begins inside the file
      "title": "The Long Goodbye"   // optional; the catalog title wins
    },
    // …
  ],
  "digest": "…"                     // optional on import; recomputed and verified on read
}
```

Invariants the converter must satisfy (they are validated, not assumed):

| Invariant | Why |
| --- | --- |
| Entries are chronological and tile the archive with no gap and no overlap | a hole is a hole; it cannot be filled from anything else |
| `entries[i].startTime === Math.round(anchor + Σ durationMs(0…i-1))` | movies keep their exact imported start even after thousands of fractional commercial breaks |
| Durations are *source* lengths: programs whole milliseconds, imported breaks may be fractional | fractions are absorbed by boundary rounding, never by stretching a program |
| `sourceOffsetMs` marks an entry that was already mid-file when the snapshot was taken | the day slicer adds elapsed wall time on top of it |
| The archive is expressed in the channel's timezone | days are cut at local midnight, so DST days come out 23 or 25 hours long |

`preservedLineupStartTimes(anchorMs, entries)` computes the canonical `startTime`
array, and is the intended way for the converter to fill the field in.
`preservedLineupDigest(archive)` is a sha256 over `{schemaVersion, sourceId,
entries}` in canonical JSON - provenance timestamps and a previously stored
digest are not part of identity.

Storage helpers: `writePreservedLineup(repositories, raw)` normalizes, digests and
stores an archive; `readPreservedLineup(repositories, binding)` reads it back and
verifies both its own digest and the digest the channel is pinned to.

## Slicing rules

- **Boundaries round cumulatively**, with compensated (Kahan) summation, so the
  same archive slices to the same integer instants on any machine and fractional
  commercial lengths cannot accumulate into drift. A 30.0004 s break that is
  rounded to 30 000 ms individually would start a later film 160 ms early; the
  cumulative boundary keeps it.
- **Day boundaries come from the channel timezone.** 2026-03-08 in
  `America/Chicago` is 23 h and 2026-11-01 is 25 h; both are sliced at their real
  length, and the reel is continuous across a repeated hour.
- **A program straddling either boundary is clipped at it.** The half that airs
  today ends at midnight; the continuation starts at the next local midnight with
  `sourceOffsetMs` advanced by the elapsed wall time (plus any offset the archive
  already recorded). The film resumes; it is never restarted and never reselected.
- **`cycle: "once"`** refuses a day that is not fully covered. **`cycle:
  "repeat"`** tiles the archive by its exact total span, so a repeated archive
  still airs at *this* day's instants rather than last period's; a span that is
  not a whole number of days therefore wraps mid-day, continuing from the top of
  the archive inside the same broadcast day.
- **Media resolution** only supplies the local path and title. An archive entry
  whose media id is absent from the catalog, or has no local path, refuses the day
  rather than dropping the airing.

## Failure codes (all fail closed)

| Code | Meaning |
| --- | --- |
| `PRESERVED_LINEUP_MISSING` | no archive stored under the bound key |
| `PRESERVED_LINEUP_INVALID` | wrong shape, inconsistent boundaries, unusable date |
| `PRESERVED_LINEUP_DIGEST_MISMATCH` | stored content, or the channel's pin, does not match |
| `PRESERVED_LINEUP_OUT_OF_RANGE` | the day starts before coverage (or the archive is shorter than a day) |
| `PRESERVED_LINEUP_EXHAUSTED` | coverage does not reach the end of the requested day |
| `PRESERVED_LINEUP_COVERAGE_GAP` | the archive does not tile the day |
| `PRESERVED_LINEUP_MEDIA_MISSING` | an airing's media id is not in the catalog |
| `PRESERVED_LINEUP_MEDIA_UNAVAILABLE` | the catalog item has no local path |

## Setup

1. Convert the live Tunarr snapshot into a v1 archive: map every lineup item to a
   MarkTV `mediaId` (`kind`, `durationMs`, and `sourceOffsetMs` from the snapshot
   item's own `startOffsetMs`), lay the entries out from the first item's start
   instant, and fill each `startTime` from `preservedLineupStartTimes`.
2. `writePreservedLineup(repositories, archiveJson)` (or write the same JSON to
   the `preserved-lineup:<sourceId>` setting directly).
3. Bind the channel: `preservedLineup: { sourceId, digest?, cycle? }`. Pinning the
   digest is the approval record - re-importing a different archive then mints a
   new schedule revision instead of silently reinterpreting the old one.
4. On the Tunarr mapping for that channel, set `preserveExistingLineup: true` so
   the sync publishes the prepared day *spliced into* the live imported lineup
   rather than replacing the whole lineup. The day window is
   `schedule.entries[0].start` and its length is the schedule's exact duration.
5. Nothing else: the refresh loop, the schedule API, the continuity pass and the
   sync all treat the preserved day like any other stored schedule.

## Sync and playback

Offsets need no new plumbing. A clipped airing is stored with
`sourceOffsetMs` (`ScheduleEntry`), which the existing Tunarr plan already turns
into a content item's `startOffsetMs`; the same mechanism movie programming uses
for a film that crosses midnight. The sync-side splice then clips the *original*
lineup at the same boundaries the same way, so the hour before and after the
prepared day keep their imported programming and their own offsets. If the sync
cannot satisfy the splice (`preserveExistingLineup` without an existing channel
and programming snapshot, or a window outside that lineup), it blocks the sync
with `PRESERVED_LINEUP_INVALID` and leaves the channel alone.

## Verification

```bash
npx vitest run tests/scheduler/preservedLineup.test.ts \
  tests/server/preservedLineupService.test.ts
npm run typecheck
npm test
```
