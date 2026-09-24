# Autopilot implementation checkpoint — September 23, 2026

**Scope:** Work started from the September 23 handoff in `/Users/markrogers/Downloads`. This is an implementation checkpoint, not a claim that the full package is live.

## Implemented in source

- Stage 0 discovery and consistent live database/bundle backups: `MARKTV_DISCOVERY.md` and `/Users/markrogers/marktv-ops/backups/autopilot-20260923-2225`.
- Stage 1 partial: chronological episode selection no longer cycles back to the first episode or skips a missing ordered successor based on the supplied history. A second encode with the same season/episode position cannot be selected as the next episode. Cooldown relaxation does not bypass the no-replay rule for episodes. This is a selector correction only; a durable actual-airing ledger, identity migration, active occurrence and source-position recovery are not implemented.
- Continuity guard: background refresh isolates one channel's generation/sync failure and skips disabled channels. This does not yet supply a 72-hour committed horizon or emergency media.
- State-safe rollback procedure recorded in `AUTOPILOT-ROLLBACK.md`; an isolated restore rehearsal remains pending.

## Verification completed

- `./node_modules/.bin/vitest run tests/scheduler/select.test.ts tests/scheduler/seriesRotation.test.ts tests/scheduler/generate.test.ts tests/server/scheduleRefresh.test.ts`: 47 tests passed in four files. After independent review exposed an unknown-metadata gap, the selector was corrected and `./node_modules/.bin/vitest run tests/scheduler/select.test.ts tests/server/scheduleRefresh.test.ts` passed 37 tests in two files.
- `./node_modules/.bin/tsc --noEmit`: passed.
- `git diff --check`: passed.
- `./node_modules/.bin/vitest run tests/scheduler tests/server/scheduleRefresh.test.ts tests/db/repositories.test.ts`: 140 tests passed in 13 files after updating the episode midroll fixture to use a distinct second episode. The old one-episode fixture expected an automatic replay at 00:30, which conflicts with the new no-replay rule; the updated test still checks alignment and now checks that the next episode is actually different.
- Both Stage 0 SQLite backup copies returned `ok` from `PRAGMA integrity_check`.

## Gates and runtime status

- Stage 0 is **partial**: a clean rebuild of MarkTV commit `3efd39f` matched the complete running `dist-server` tree. Tunarr running-bundle/source equivalence and an actual client transition on each channel are not proven. A channel 7 TiviMate session and active HLS producer were observed via Tunarr API/process/filesystem, but no client picture/audio result was obtained.
- Stage 1 is **not passed**: the existing `historyBefore` repository reads generated schedules as history, and Tunarr's `program_play_history` records lineup calculation. Neither proves completed airing. Activating the selector alone could omit episodes that were planned but never aired. No database migration or live schedule replacement has been performed.
- Stages 2–6 are **not passed**. Existing movie reservations, weekend encore and Tunarr pacing/buffer changes remain the live baseline. No background preparation queue, internal emergency pool, channel-scoped recovery activation, all-channel canary, real-client acceptance, or 24–48 hour soak is claimed.
- The new source changes have **not** been built into or deployed over the running MarkTV/Tunarr services. No live service restart or stream interruption has occurred during this checkpoint. User authorization to interrupt streams for a gated deployment is recorded, but it is not a substitute for the Stage 0/1 evidence.

## Next critical work

Create an authoritative airing/exposure ledger and migrate a monotonic per-series floor using evidence stronger than scheduled rows; preserve the active source offset and reserve future episodes separately. Then test duplicate callbacks, restart/rename, missing successor, and failure recovery on copied state before any live selector activation. Integrate the 72-hour future plan and stronger movie exposure policy after that gate. The complete background automation suite and actual client/soak checks remain in scope.
