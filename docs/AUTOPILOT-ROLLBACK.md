# Autopilot rollback and state preservation

Baseline captured September 23, 2026 at `/Users/markrogers/marktv-ops/backups/autopilot-20260923-2225`. The folder contains consistent MarkTV and Tunarr SQLite backups, the previous server entry and Tunarr bundle, launch configurations, settings, dirty patches, and checksums. Both backup databases passed `PRAGMA integrity_check` when captured. This is a recovery snapshot, not a database image to overwrite after newer viewing has happened.

## Before any activation

Record the deployed Git commits, complete built artifact hashes, active channel IDs, current Tunarr sessions, current progress and movie exposure high-water marks, and a new consistent database backup. Keep the previous build beside the new one. Check that the new build includes all preserved Tunarr producer/buffer fixes and the uncommitted build environment values, or stop the deployment. Do not replace the live database during a binary rollback.

## If an activated stage regresses playback

1. Stop only the affected new background job or feature flag first. Leave healthy channel producers and the original media alone.
2. Capture current MarkTV/Tunarr database backups and the incident logs before changing binaries. Verify the copies with `PRAGMA integrity_check`; record SHA-256 hashes and current state high-water marks.
3. Restore the previous application/Tunarr build and prior launch configuration for the affected service only. Restart that service only after recording which clients will be interrupted. Leave both **current** live databases in place if their schema remains backward compatible.
4. If an older binary cannot read the additive schema, use a tested compatibility adapter or perform a transactionally reviewed, forward-state-preserving migration on copied databases. Do not copy the September 23 database backup over newer progress or movie history. The new high-water marks, active occurrence/source offset, completed exposure intervals and approved encore links must survive any data conversion.
5. Verify channel IDs and URLs, stream mode, output/buffer/pacing settings, current programming position, upcoming episode floor and nightly movie history. Then observe a real client transition and record the result.

## What is proven now

The baseline backup is readable and internally consistent. No binary rollback or post-activation history reconciliation has yet been exercised; the steps above remain an operational procedure until an isolated restore rehearsal passes.
