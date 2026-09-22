# MarkTV continuity

MarkTV continuity is an offline-first presentation layer. It derives truthful
promo context from a finalized, date-specific schedule, selects only local
validated media, and replaces complete break items only when the original
break duration is preserved exactly.

Continuity is on by default (a stored `enabled: false` is respected). Missing,
stale, unregistered, or incorrectly timed material falls back to the original
validated break. Playback never waits for rendering, speech generation, an
online service, or a missing external drive.

## Automatic preparation

Preparation is part of ordinary schedule generation. After the final normal
lineup is built - and before continuity is applied or exported -
`ScheduleService` runs a bounded, sequential offline pass that plans the day's
cards, renders only those whose break can actually be rebuilt exactly,
validates each file against the one approved profile, and registers the
survivors as ordinary local media. No per-day operator command is required.

The output root is chosen from the *existing* media-root and catalog state: the
mapped root that already holds the channel's commercials, falling back to any
root whose name marks it as commercial. Nothing is hardcoded to one machine's
volume and Tunarr's configuration is never edited. If no eligible writable root
can be determined, the channel has no canonical logo, no installed ffmpeg build
can render card text, or a render/validation/registration step fails, the
original breaks (and the ordinary schedule) are left exactly as they were, with
a diagnostic recorded.

Generated files are written as
`<root>/generated/continuity/<channel>/<date>/<content-hash>/`, published with a
temp-file-then-rename step, and re-validated by content hash before an existing
render is reused. Each card carries its full manifest metadata (content hash,
card class, family, wording, revision, target ids, duration) plus its file hash;
a missing, tampered or stale file never enters an applied schedule just because
the catalog lists it. Because the files live inside a mapped root, a later
library scan rediscovers them - the scan deliberately will not re-register a
path that already belongs to a schedule-scoped card.

## Asset groups

- Existing voiced bumpers and station IDs are reused from the normal media
  catalog. Title-specific clips remain title-scoped.
- The starter pack contributes 219 script-only jobs, four persona briefs, and
  eight SVG templates. Script-only entries are never reported as recorded.
- User-supplied general cards are finished legacy artwork. They may be rendered
  as visual-only five-second H.264/AAC bumpers, but their embedded wordmark is
  not treated as the canonical logo file.
- Dynamic schedule cards are bound to the user-approved canonical logo at
  `assets/branding/marktv-logo-canonical.png`. Production rendering verifies
  the actual PNG bytes against the recorded SHA-256; a missing, damaged, or
  different file blocks production eligibility without blocking playback.
  The canonical copy has a transparent exterior for compositing; the original
  white-background source is preserved as `marktv-logo-original-white.png`.
- Staged interruption cards are prepared separately and stay ineligible unless
  the explicit playback-health gate is implemented and enabled.

## Preparation commands

`npm run continuity:preview` creates schedule-bound SVG previews.

`npm run continuity:validate-assets` hashes and probes existing station media,
including real duration, video, and audio streams.

`npm run continuity:prepare-cards -- --db <sqlite snapshot> --out <directory>
[--date YYYY-MM-DD] [--channel <id>] [--limit N] [--ffmpeg <path>] [--font
<name|fontfile=path>]` is the manual equivalent of the automatic preparation
pass, for preparing a day outside a generation run. It reads the
snapshot read-only, plans the day's cards from the completed schedule, and
renders each to an approved-template SVG preview plus a PNG and a
profile-validated MP4 with continuous silent AAC. This command is preview-only;
manual catalog registration is disabled. Normal schedule generation prepares
cards inside an existing mapped library and confirms their playable inventory
before inserting them. Generated cards are never added to a pool.

Generated cards carry the `schedule-scoped-continuity` tag. They belong to one
completed schedule only: the scheduler never draws them as generic filler or
station IDs, a library scan cannot strip the marker, and a regenerated lineup
invalidates them by content hash. A card whose file is missing, unmeasured,
unregistered, or unrenderable is simply skipped and the original validated
break airs unchanged.

`npm run continuity:verify-day -- --db <copy of the live sqlite> --out
<directory> [--date YYYY-MM-DD] [--channel <id>] [--font <name|fontfile=path>]`
is the offline real-day verifier. It runs the **actual automatic pipeline** -
the same prepare-and-register step the schedule service calls, with its output
root overridden into the verifier's own directory - and then applies continuity
to the stored schedule in memory. It proves that every editorial entry is
byte-identical, that every break keeps its exact start, end and duration, that
no flexible (dead-air) time was added and that no break carries more than one
card, then writes a real frame extracted from each rendered MP4 plus the MP4s
and a JSON manifest. It makes no network call, opens the database read-only,
registers nothing, and never syncs Tunarr.

## The director

Continuity is planned from the *completed* schedule, never from a draft:

- **NEXT** names the immediate next episode by series (`showTitle`, falling back
  to the media title) or the next film by its own title. When that programme is
  the same series already on screen the copy reads `MORE {SHOW} NEXT` rather
  than implying the current episode is starting again.
- **NEXT/LATER** names the first useful distinct programme after NEXT, preferring
  something 30-120 minutes ahead. When there is no distinct target the break
  falls back to NEXT.
- **TONIGHT** prefers a weekend double feature that is actually tonight (both
  films of the configured opener/closer pair, with the real first start), then
  the evening film, then the near-2-AM film, then a distinct evening programme.
  A film that is *immediately* next is still a legitimate TONIGHT target - that
  is exactly what a configured double-feature opener is. Cards carry the actual
  schedule time in the channel's timezone, e.g. `STARTS 2:07 AM`. After
  midnight the same card is relabelled `THE 2 AM MOVIE` / `THE LATE MOVIE` so it
  never claims a programme is "tonight" when it is not, and it stays
  future-only. A film that already began (a carried-over tail) is never
  advertised as a new premiere, and a split feature counts once.

Every card is bound to the *content hash* of the whole completed schedule, its
broadcast date, channel, card class, target ids/titles/times, presentation
family, wording and duration. Regenerating the lineup mints a new hash, which
retires the earlier cards instead of reusing a card that no longer describes
what will air.

Wording rotates deterministically from the channel, date, schedule hash, card
class and target ids, so the same schedule always produces the same text. Four
presentation families - `syndication`, `local-cable`, `prime-time` and
`overnight` - share the same templates and canonical logo and differ only in
palette and accent; a family used recently is deprioritised, never banned.
Cadence is 90-120 minutes at `low`, 60-90 at `normal` and 30-60 at `high`.
**TONIGHT and the weekend pair share one daily promo bucket** (2, 5 or 8 a day
at low/normal/high). **NEXT/LATER is interval-limited only** and **NEXT has no
daily ceiling at all** - it is the fallback on any suitable transition. An
ordinary target is capped at two promotions a day, a film or event at three,
and the same target repeats no sooner than 60-90 minutes. Cooldowns, ceilings
and recent-family rotation advance only for a card that is actually inserted; a
candidate rejected at the fit or render stage spends nothing.

Cross-midnight promotion uses only the completed adjacent schedule: if
yesterday's stored lineup is available, its future 2 AM film may be promoted
with the time it actually aired; its content is part of the card's binding, and
if the adjacent schedule is absent the target is skipped rather than invented.
Cadence reads the successful insertions other generations published (temporal,
excluding the schedule being built) so a card that will air counts before it
airs without ever being presented as something that already played.
After midnight an optional secondary humour line may join a card (`off` never,
`low` about 10%, `normal` about 20%); it is appended to the information, never
substituted for it.

Exactly one informational card is ever placed in a break - a break that already
carries one, including a legacy information bumper, is left alone. Placement
has two whole-item paths, cheapest first: an exact swap of complete items whose
total is exactly the card's duration, and otherwise a bounded refill that
removes the smallest set of whole items covering the card and then fills the
released remainder from the channel's *own* eligible commercial pool (never
another channel's media) using the existing filler helper, cooldowns and
rotation bag. Either way nothing is trimmed or retimed, the break never gains
dead air, and commercials stay the majority. If no exact fit exists the original
validated break is returned byte-for-byte.

`npm run continuity:prepare-general-cards` validates and deduplicates supplied
PNG sources. `npm run continuity:render-general-cards` renders them one at a
time to immutable, profile-validated MP4 files. `npm run
continuity:register-general-cards -- --root <installed-card-directory>
--manifest <render-manifest>` verifies every installed file against the
approved render manifest, then uses MarkTV's existing media scanner and API
instead of editing the database directly.

## Activation boundary

Prepared and registered are not the same as scheduled or observed playing. The
status surface reports a channel ready only when a prepared asset is bound to
the *current* schedule's content hash - any other generated card in the catalog
says nothing about the lineup on screen. Ordinary continuity becomes part of a
lineup only while all of the following are true:

1. the exact schedule revision and future airing targets are still current;
2. every selected file is present, decoded, measured, and registered;
3. the complete break preserves its source and broadcast duration exactly;
4. no active viewer blocks the existing guarded Tunarr synchronization path;
5. a fresh dry run succeeds immediately before future-lineup publication.

Continuity must use the existing Tunarr adapter and active-viewer guard. It must
not write Tunarr's database, create a second scheduler, or restart playback.

The user-approved finished general cards can be added to future station-ID
selection with `npm run continuity:activate-general-cards -- --root
<installed-card-directory>`. This only updates the MarkTV pool; it does not
regenerate or sync a lineup. The matching `continuity:deactivate-general-cards
-- --root <installed-card-directory>` command removes those cards from future
selection without deleting their files or catalog records. Both commands fail
closed while Tunarr reports an active viewer and compare a fresh pool snapshot
immediately before writing.

## Rollback

Disable future continuity selection, restore the last compatible presentation
plan from the pre-change snapshot, and run the normal dry-run comparison before
syncing. Do not delete media referenced by the current, future, rollback, or
active playback manifests. Original shows, movies, commercials, station media,
movie-programming rules, and playback parameters remain unchanged.
