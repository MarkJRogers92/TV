# Configuring channels, media, and schedules

## Channels

Use the selected-channel control to switch among channel records. The Channel page edits identity, channel number, IANA timezone, dayparts, fixed/daypart slots, pool selection, chronological or deterministic shuffle mode, no-repeat windows, movie break settings, and between-program break boundaries. Validation errors appear beside the saved form state; a failed save or generation does not replace the last successful schedule.

Day values use Sunday `0` through Saturday `6`. Dayparts use local `HH:mm` times. Higher-priority overlaps win; equal-priority overlaps are rejected. Overnight ranges are supported. Movie slots use local day/time rules. The demo's mid-roll entries are a policy preview—Tunarr performs any actual splitting and filler insertion.

## Local media and pools

Add only absolute folder paths on the Library page. Scans are read-only: MarkTV does not rename, move, edit, delete, play, or transcode source files, and it ignores hidden paths and symbolic links. Supported extensions are `.mp4`, `.m4v`, `.mkv`, `.mov`, `.avi`, and `.webm`. `SxxEyy` text is used only as an editable metadata hint.

When `ffprobe` is installed, MarkTV reads duration. Missing or invalid durations appear as diagnostics and keep an item unavailable. Repair one by entering a positive duration in milliseconds, correcting its editable title/kind as needed, and saving it. Assign media to a compatible pool after review. Pools define allowed kinds, ordered membership, selection mode, and no-repeat minutes.

## Deterministic scheduling

Select a broadcast date and generate. The EPG shows local start/end, kind, title, and source slot/daypart, followed by diagnostics and the JSON export path. Generation runs from local midnight to the next local midnight in the channel timezone, so daylight-saving dates can be 23 or 25 real hours.

Schedule identity and decisions are deterministic for the same channel configuration revision, pool configuration, media metadata snapshot, date, and history snapshot. The audit timestamp may differ. Chronological pools advance in season/episode order; shuffle is seeded; cooldowns are enforced unless a slot explicitly allows relaxation; fallback pools are tried in listed order. Residual interstitial gaps become flex rather than invented media.

The readable demo source is mirrored by `config/marktv-laughs.sample.json`; it contains no legacy fields. Placeholder items are preview-only and block Tunarr eligibility until replaced or matched with real absolute media paths.
