# Configuring channels, media, and schedules

## Channels

Use the selected-channel control to switch among channel records. The Channel page edits identity, channel number, IANA timezone, dayparts, fixed/daypart slots, pool selection, chronological or deterministic shuffle mode, no-repeat windows, movie and episode break settings, and between-program break boundaries. Validation errors appear beside the saved form state; a failed save or generation does not replace the last successful schedule.

Day values use Sunday `0` through Saturday `6`. Dayparts use local `HH:mm` times. Higher-priority overlaps win; equal-priority overlaps are rejected. Overnight ranges are supported. Movie slots use local day/time rules. Tunarr performs actual splitting and filler insertion without changing the source file.

Episode slots can enable two mid-show breaks. The defaults target 7:30 and 15:00, search 1.5 minutes on either side for the nearest short black transition, and reserve 2.5 minutes per break. Minimum content-segment and episode-tail buffers prevent unsafe cuts. MarkTV caches successful analysis by media path, file identity, and policy; changed files or settings are analyzed again. If FFmpeg cannot find a safe transition, the configured target is used with an `EPISODE_BREAK_FALLBACK` diagnostic. If the episode and its breaks cannot safely fit the current 30-minute block, MarkTV omits the mid-show breaks and records a diagnostic rather than moving the next show off the half-hour.

## Local media and pools

Add only absolute folder paths on the Library page. Scans are read-only: MarkTV does not rename, move, edit, delete, play, or transcode source files, and it ignores hidden paths and symbolic links. Supported extensions are `.mp4`, `.m4v`, `.mkv`, `.mov`, `.avi`, and `.webm`. `SxxEyy` text is used only as an editable metadata hint.

When `ffprobe` is installed, MarkTV reads duration. Missing or invalid durations appear as diagnostics and keep an item unavailable. Repair one by entering a positive duration in milliseconds, correcting its editable title/kind as needed, and saving it. Assign media to a compatible pool after review. Pools define allowed kinds, ordered membership, selection mode, and no-repeat minutes.

## Deterministic scheduling

Select a broadcast date and generate. The EPG shows local start/end, kind, title, and source slot/daypart, followed by diagnostics and the JSON export path. Generation runs from local midnight to the next local midnight in the channel timezone, so daylight-saving dates can be 23 or 25 real hours.

Schedule identity and decisions are deterministic for the same channel configuration revision, pool configuration, media metadata snapshot, date, history snapshot, and cached break analysis. The audit timestamp may differ. Chronological pools advance in season/episode order; shuffle is seeded; cooldowns are enforced unless a slot explicitly allows relaxation; fallback pools are tried in listed order. Mid-show break time is part of an episode's broadcast runtime, so MarkTV reduces the between-show filler by the same amount. Residual interstitial gaps become flex rather than invented media.

The readable demo source is mirrored by `config/marktv-laughs.sample.json`; it contains no legacy fields. Placeholder items are preview-only and block Tunarr eligibility until replaced or matched with real absolute media paths.

## Movie programming

The optional movie-programming block adds nightly and weekend films around the sitcom schedule: 02:00 features, a 19:00 Saturday and Sunday double feature with a 60-120 second whole-spot bridge, and the two weekly encores, for eleven starts a week (nine new, two encores). It is disabled unless the channel sets `movieProgramming.enabled`, and enabling it requires both a movie pool (`movieProgramming.poolIds`) and the folder its films are scanned from (`movieProgramming.rootPath`); anything else is refused with a validation error rather than saved as a feature that can never schedule a film. Changing the block drops the schedules and assignments for days after today so a pre-generated tomorrow cannot air the configuration it replaced. The rotation, the dated assignments and the break policy are described in `docs/MOVIE_PROGRAMMING.md`.
