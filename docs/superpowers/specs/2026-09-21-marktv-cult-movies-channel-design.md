# MarkTV Cult Movies channel design

## Outcome

Add a third MarkTV channel, `MarkTV Cult Movies`, on channel 9. It will run a
continuous daily stream of shuffled movies drawn only from
`/Volumes/SSK Drive /MarkTV/Movies/Cult`, with the existing `ads` commercial
pool used for interstitial breaks. The existing MarkTV channels and their
current lineups remain unchanged.

The channel must be a live daily channel, not a one-time Tunarr lineup. MarkTV
will therefore retain independent Tunarr sync state for each MarkTV channel.

## Current constraints

- MarkTV currently has one application channel, `MarkTV Laughs` (7).
- Tunarr currently has MarkTV channels 7 and 8; channel 9 will be created with
  the existing `Default` transcode configuration.
- The MarkTV application currently stores one global Tunarr mapping. A second
  channel would overwrite that mapping and would not receive automatic daily
  syncs.
- The existing `movies` pool contains 29 top-level Movies files. The Cult
  folder contains 20 playable movie files, but they are not yet in MarkTV's
  catalog or any pool.
- The existing MarkTV movie root is the broader `/Movies` folder. A normal
  recursive scan would otherwise make its movie enrollment claim the nested
  Cult files as well.

## Design

### Cult media isolation

Create a dedicated `cult-movies` pool with `kind: movie`, `mode: shuffle`, and
`noRepeatMinutes: 1440`. Its membership will be populated from the scanned
Cult folder only.

Extend movie-root enrollment so a narrower configured root takes precedence
over a broader configured root. When one configured movie root is a strict child
of another configured movie root, the broader channel excludes files claimed by
the narrower channel. This keeps the existing `movies` pool at its current 29
members while allowing the Cult pool to claim the 20 nested files. The rule is
path-based and applies to configured roots even when the narrower channel's
movie-programming feature is disabled; it does not change ordinary pool editing
or delete media records.

The channel's ordinary all-day movie slot references only `cult-movies`. Its
break policy references only the shared `ads` pool, so no show, general movie,
bumper, or station-ID pool can enter its scheduled content accidentally.

### Scheduling

Add a channel document with:

- id `marktv-cult-movies`;
- name `MarkTV Cult Movies`;
- number `9`;
- timezone `America/Chicago`;
- one all-day daypart and one movie slot;
- `cult-movies` as the only primary pool;
- the shared `ads` pool as the only break pool;
- no fallback pool; and
- a disabled movie-programming scope block carrying `poolIds: ["cult-movies"]`
  and the Cult `rootPath`. This block reserves the root for enrollment
  isolation but does not invoke the separate nightly/weekend movie-programming
  scheduler.

The existing deterministic scheduler will generate a full broadcast date. The
shuffled pool and 24-hour no-repeat window provide daily variety without
repeating a title during the same rolling day when enough films are available.
The schedule is validated against the catalog and Tunarr inventory before it is
applied.

### Per-channel Tunarr mappings

Replace the single operational mapping path with a backwards-compatible
per-channel mapping store. Existing legacy mapping data remains readable and is
migrated into the new collection on first access; channel 7's mapping and
last-sync state are preserved exactly.

The Tunarr status, dry-run, sync, and automatic refresh paths will resolve a
mapping by `marktvChannelId`. Automatic refresh will check and sync each
channel's own current-date schedule against its own mapping. A failed or
viewer-blocked sync for one channel will be recorded for that channel and will
not suppress or rewrite another channel's mapping.

The existing manual API shape remains usable for channel 7, with an optional
channel selector/status projection for multiple channels. Each dry run stores
its plan under the selected MarkTV channel, so channel 9 cannot consume channel
7's pending plan.

### Tunarr activation

After the MarkTV catalog contains the Cult files, scan the existing Tunarr
Movies library so Tunarr can resolve those exact paths. Use the current Default
transcode configuration to create channel 9. Run a fresh dry run and sync for
channel 9 only. Do not restart Tunarr; the current service has no active viewer
session and channel creation/programming uses its live API.

## Failure handling and rollback

- If any Cult file has no usable duration or Tunarr cannot resolve its exact
  path, the sync remains blocked and no partial Cult lineup is presented as
  active.
- If the channel creation succeeds but programming fails, retain the returned
  Tunarr channel ID and report the partial operation; do not blindly replay a
  stale plan.
- If a sync is blocked by active viewers, preserve the existing live lineup and
  retry after the viewer session ends.
- Before activation, capture the current MarkTV channel/pool documents and
  Tunarr channel list. The new channel can be disabled or its programming
  replaced without touching channels 7 or 8.
- No media files are moved, renamed, deleted, or copied.

## Verification

Implementation verification will include:

1. Focused tests for per-channel mapping compatibility, automatic sync routing,
   nested-root movie isolation, and the Cult channel configuration.
2. Typecheck and lint for the changed application code.
3. A live catalog scan proving 20 Cult-root movie records and unchanged
   membership of the existing `movies` pool.
4. A generated current-date Cult schedule proving every movie entry resolves to
   a path under `/Movies/Cult` and every interstitial entry comes from `ads`.
5. Tunarr inventory and dry-run evidence proving the new channel's scheduled
   paths resolve, followed by a successful channel-9 programming sync.
6. Post-activation checks of channels 7, 8, and 9, including Tunarr channel
   identity, MarkTV mapping state, current schedule IDs, and active viewer
   status. No long-duration client playback claim will be made from an HTTP
   response alone.

## Out of scope

- Reorganizing the external Movies folder or copying any media.
- Adding metadata artwork, ratings, EPG enrichment, or a separate commercial
  library.
- Changing the current channel-7 or channel-8 programming policy.
- Rebuilding or restarting Tunarr.
