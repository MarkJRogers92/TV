# Safe Tunarr integration

Tunarr remains the playback, tuner, and transcoding system. MarkTV prepares a channel, one deterministic filler list, and an ordered manual lineup through Tunarr's public HTTP API. MarkTV never writes Tunarr's database and does not provide FFmpeg pipelines, transcoding, HLS, tuner emulation, or playback clients.

## Prerequisites

1. Run a compatible Tunarr instance locally and add the same files to a Tunarr media library.
2. Confirm MarkTV and Tunarr see identical absolute paths. Relative paths are rejected; filename-only matching is never attempted.
3. Generate a MarkTV schedule with real media. Preview placeholders block synchronization.
4. To update an existing channel, copy its Tunarr channel ID. To create one, copy the ID of an existing Tunarr transcode configuration. MarkTV verifies that ID with `GET /api/transcode_configs` and never invents one.

## Test, dry run, sync

Enter the Tunarr URL and library ID. For an existing channel, enter its channel ID. To create a channel, select **Create a new Tunarr channel** and enter a verified transcode configuration ID.

**Test connection** separately reports health and channel, filler-list, transcode, inventory, and programming capabilities. **Dry run** fetches fresh channel, filler-list/program, transcode, inventory, and programming snapshots. It reports every blocker, exact-path match counts, and the ordered channel, filler, and programming operations.

Sync is enabled only for an eligible dry run. Any edited input invalidates it. Immediately before the first mutation, MarkTV fetches every snapshot again and compares a fingerprint containing the complete MarkTV schedule, mapping inputs, Tunarr version/capabilities, channel state, filler state, transcode configurations, and inventory. A stale or changed snapshot returns `STALE_DRY_RUN` before writing anything.

The mutation order is channel create/update, filler-list create/update, then manual programming. A new channel uses conservative required `SaveableChannel` values and the user-supplied transcode configuration. An existing channel keeps its required Tunarr fields while applying the MarkTV name, number, duration, and start time. The mid-roll filler list name is deterministic per MarkTV channel and contains matched official `ContentProgram` wrappers for commercials, general filler, and bumpers. Station IDs remain explicit scheduled content and are not eligible inside mid-show breaks. Returned channel and filler IDs are resolved before dependent operations. On the first HTTP failure, MarkTV stops and reports completed operations and the IDs already resolved.

## Episode and movie mid-rolls

For a scheduled episode or movie with mid-roll metadata, MarkTV splits the same matched Tunarr content ID into positive-duration content segments with exact `startOffsetMs` values. It inserts deterministic pods of complete matched commercials, filler, or bumpers between those segments. MarkTV materializes those pods as ordinary content entries because Tunarr 1.3.14 renders mid-roll flex entries as offline time even when they carry a filler-list configuration. The original files are never cut or re-encoded. The schedule entry records source-content duration separately from broadcast duration; content plus every inserted break must equal the wall-clock entry duration.

Duplicate, unordered, non-positive, out-of-range, or duration-inconsistent break layouts block the dry run. Mid-rolls also block when there is no matched positive-duration filler program, when complete spots cannot exactly fill a break, or when the complete Tunarr lineup duration differs from MarkTV's schedule. Ordinary unsplit programs and scheduled interstitial entries remain ordered content items. Existing flex entries remain flex items.

## Recovery and limitations

- `UNMATCHED_MEDIA_PATH`: Tunarr does not expose that exact absolute path.
- `AMBIGUOUS_MEDIA_PATH`: multiple Tunarr items expose the same path; MarkTV refuses to guess.
- `PLACEHOLDER_MEDIA`: replace preview media with a real scanned file and regenerate.
- `TRANSCODE_CONFIG_REQUIRED` or `TRANSCODE_CONFIG_NOT_FOUND`: choose an existing Tunarr configuration ID.
- `MIDROLL_FILLER_UNAVAILABLE`: add matching filler media to both applications and regenerate.
- `MIDROLL_EXACT_FILL_UNAVAILABLE`: add a combination of complete matched spots whose durations exactly fill the configured break, then regenerate.
- `INVALID_MIDROLL_LAYOUT`: regenerate; the stored break offsets or broadcast accounting are unsafe.
- `LINEUP_DURATION_MISMATCH` or `SCHEDULE_DURATION_MISMATCH`: do not sync; regenerate and review unmatched media or timing diagnostics.
- `UNSUPPORTED_SCHEMA` or a capability blocker: do not bypass the guard. Record the Tunarr version and review/update the adapter against Tunarr's current API before retrying.
- A partial failure may leave a channel or filler list created/updated. Review the returned completed operations and IDs, then run a new dry run; MarkTV never replays a stored operation blindly.

This adapter is based on the reviewed Tunarr source snapshot at commit `7063dc6fcb6b8e73f6b4b761294270fc0ed60add`, including `/api/channels`, `/api/filler-lists`, `/api/transcode_configs`, `/api/media-libraries/:libraryId/programs`, and `/api/channels/:id/programming`.
