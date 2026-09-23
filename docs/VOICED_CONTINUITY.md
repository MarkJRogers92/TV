# Voiced continuity imports

The voiced bumper package is imported as ordinary MarkTV media with an explicit
continuity role. Its tags restrict it to channel `marktv-laughs` (channel 7),
and its claims are checked against the actual next airing and local broadcast
clock. Unknown or unsupported claims stay registered but staged.

Run the importer without `--apply` first; this verifies package manifests,
source hashes, the registered media root, catalog conflicts, and station-ID
eligibility without writing to MarkTV:

```sh
npm run continuity:import-voiced -- --source /path/to/MarkTV_Bumpers_Prepared --destination "/Volumes/SSK Drive /MarkTV/Commercials/generated/voiced-canon-20260922"
```

`--apply` copies verified videos without overwriting files and registers their
catalog records through the MarkTV media API. The separate
`--activate-hourly-ids` option adds only channel-7-eligible station IDs to the
existing `ids` pool after rechecking that the pool has not changed. Importing
does not publish or sync a schedule. A later media-root scan preserves voiced
classification tags for already registered paths.

Apply requires a successful Tunarr session check. It writes a recovery snapshot
(`--backup <path>`), skips identical records, and rejects changed metadata.
Failures restore catalog/pool changes while retaining verified copied files.
Catalog durations come from the rendered MP4, rounded to integer milliseconds.

The importer excludes the byte-identical duplicate apology row. The Roseanne
promo requires the next airing to be another Roseanne episode; clock claims
require the stated local time; the feature-start promo must sit immediately
before a movie that has not started. Daypart station IDs require an explicit
channel and timezone at the fill site and must fit wholly inside their local
daypart. Horror and generic-comedy claims remain staged until catalog metadata
can verify the genre. Break-out and return clips carry explicit roles for the
mid-roll adapter and cannot enter generic filler selection.

The adapter matches these clips to healthy Tunarr inventory and puts break-out
first and return last only when full commercials fill the remainder exactly.
It limits voice to two clips and twenty seconds per pod, retains a commercial
majority, and applies a sixty-minute clip cooldown. A failed fit keeps the
original commercial selection. Daypart windows are morning 06:00–12:00,
primetime 19:00–23:00, and overnight/after-hours 23:00–06:00, in channel time.

## Shared general clips (channels 8 and 9)

Seven approved clips can additionally carry
`continuity-shared-channels=marktv-movies,marktv-cult-movies`: MAIN, NOSTALGIA,
STAY_MARKED and SLOGAN_NATURE station IDs, plus BREAK_OUT and the two RETURN
clips. Their primary channel remains `marktv-laughs`. The shared-channel parser
rejects duplicate or malformed scope tags, other assets, and timing/title claims.

`scripts/prepare-shared-voiced-channels.ts` previews the existing today/tomorrow
schedules. `--apply` backs up and freshness-checks affected records, adds separate
station ID pools to channels 8/9, and inserts full IDs into future breaks using
exact refills or reduced existing flex. It preserves editorial entries and break
windows, and refuses a metadata-only activation. It does not sync Tunarr; each
channel must subsequently use the normal guarded sync. The break/return clips
remain eligible only for actual nested midrolls, which the activation schedules
currently do not contain.

Activation evidence and rollback data are in
`~/Downloads/MarkTV_Shared_Voiced_Backup_2026-09-22`. Original media is reused;
channel 7's lineup and pools are untouched.
