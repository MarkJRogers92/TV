# MarkTV Acquisition Workflow Design

**Status:** Approved by the user in the 2026-09-14 handoff.

## Goal

Add a local-only acquisition workflow that connects an exact episode on MarkTV's Wanted List to a user-selected Stremio source, then discovers the resulting completed Real-Debrid or TorBox file, downloads it safely, verifies it, imports it into MarkTV's managed library, registers it through the existing scanner/database, and removes the Wanted entry.

## Boundaries

- MarkTV opens only `stremio:///search?search={URI-encoded query}`. It does not scrape Stremio or read addon/profile credentials.
- The user selects the source in Stremio. MarkTV does not search torrents, choose sources, submit magnets, bypass DRM, or delete remote content.
- The first provider surface is completed torrents only. Real-Debrid uses `/user`, `/torrents`, `/torrents/info/{id}`, and `/unrestrict/link`. TorBox uses `/v1/api/user/me`, `/v1/api/torrents/mylist`, and `/v1/api/torrents/requestdl`.
- Provider types are explicit so TorBox Usenet and web downloads can later receive their own matching `mylist` and `requestdl` implementations without pretending their schemas are interchangeable.
- The server remains local-only. Once credentials and file controls exist, a non-loopback `MARKTV_HOST` is rejected.
- No commit, push, merge, publish, deployment, or remote deletion is part of this implementation.

## Architecture

The workflow is a new `src/acquisition/` subsystem with pure parsing/matching rules, durable SQLite-backed Wanted/job/review/import records, provider-neutral contracts, a resumable downloader, a safe importer, and a single-flight coordinator. Provider adapters live under `src/integrations/acquisition/`; macOS Keychain access lives under `src/security/`. Fastify routes expose commands and projections, while the React UI adds separate Wanted and Integrations pages.

The coordinator polls configured providers every 60 seconds by default, with an injected/manual `pollOnce()` for tests. It persists every meaningful state transition. It never stores tokens, bearer headers, unrestricted URLs, TorBox signed/request URLs, or remote deletion capabilities. Shutdown aborts current local transfers and preserves `.part` files and durable job state for restart recovery.

## Data model

Episode identity is `normalized series title + season + episode`. The database has additive tables for:

- `wanted_episodes`: user metadata and current non-technical status.
- `acquisition_jobs`: provider/item/file identity, original filename, sizes, retry/cancel/progress state, `.part` path, destination path, and timestamps.
- `acquisition_reviews`: ambiguity/season-pack records with safe candidate metadata only.
- `completed_imports`: unique episode identity and unique provider/item/file identity to prevent duplicates.

Tokens are never columns or JSON documents. SQLite stores no download URL.

Provider-neutral records are discriminated and safe to persist: `ProviderName` is `real-debrid | torbox`; `RemoteItemType` starts as `torrent`; `RemoteItem` contains provider, item type, stable item ID, original name, completion status/time, and `RemoteFile[]`; `RemoteFile` contains provider, item type, stable item/file IDs, original filename/path, and bytes. A persisted job stores this locator but no provider link. On restart or URL refresh, the adapter re-lists/reloads the locator and creates a fresh in-memory URL.

Wanted deletion is rejected with `409 ACTIVE_JOB` while a nonterminal job exists. The user cancels first; cancellation keeps the partial and durable job audit. Deleting a cancelled/unstarted Wanted entry removes its open reviews transactionally, but never removes completed-import records, imported media, local finished files, partial files, or anything remote.

## Matching

- Parse common `S01E02`, `S1E2`, `1x02`, and season-pack layouts.
- Normalize punctuation, whitespace, separators, Unicode, and release suffixes without discarding meaningful title words.
- Reject samples, trailers, featurettes, extras, non-video extensions, unsafe paths, and unreasonable tiny files.
- Automatically match only exact Wanted series/season/episode identities.
- Rank unambiguous candidates by resolution: highest at or below 720p; if none, lowest above 720p. Use size only as a plausibility/tie signal.
- Equal best candidates, uncertain title matches, multi-episode files, or conflicting episode identities go to Needs review.
- A season pack automatically schedules only exact Wanted episodes. Manual Import Season previews recognized unique episodes and total required bytes, rechecks disk space and duplicates, then imports the recognized files without changing the remote pack.

## Credentials and provider errors

The Keychain service uses `/usr/bin/security` through argument-array process execution. Token values are supplied on standard input, never command arguments. Tests use an injected in-memory credential store. Integration responses show only connected/not connected and a safe account label.

Provider errors are typed as retryable, rate-limited (with retry-after when available), authentication, unavailable, schema, or permanent. Logs and API errors pass through central redaction that removes bearer tokens, credential query parameters, and complete credential-bearing URLs. Temporary failures receive bounded backoff; authentication, ambiguity, unsafe paths, duplicates, and corrupt media stop cleanly.

## File lifecycle

- Inbox: `<MARKTV_DATA_DIR>/inbox`; managed library: `<MARKTV_DATA_DIR>/library`.
- A job downloads to a non-video `<job-id>.part` name.
- Resume only when the provider/HTTP server returns a valid `206` and matching `Content-Range`. A `200` response restarts the partial safely instead of appending.
- Regenerate provider URLs on expiry and retry temporary failures at most three times with bounded backoff.
- Check free bytes immediately before starting. Stream data while persisting progress; cancel aborts local work and preserves the partial.
- Accept only HTTPS provider download URLs without embedded username/password. Follow redirects manually (maximum five), validating every target. Resolve hostnames and reject loopback, private, link-local, multicast, unspecified, and cloud-metadata destinations before every request; never automatically follow an unvalidated redirect.
- Verify with the existing ffprobe mechanism before placement.
- Build the final name from sanitized Wanted metadata as `Series Name - S03E04 - Episode Title.ext`; assert containment and an allowlisted video extension.
- Never overwrite a final file. Publish with a destination-local atomic no-clobber operation, then register the managed library root and rescan using the existing adapter/repository transaction.
- Startup creates Inbox and managed-library directories with owner-only permissions when absent, then rejects symlink/non-directory replacements, resolves real paths, and registers the library root exactly once.
- Imported canonical names are authoritative. The shared filename parser recognizes `Series - S03E04 - Episode Title.ext`; the scanner maps the suffix to `MediaItem.title`, the prefix to `showTitle`, and the numbers to season/episode so later rescans preserve the same metadata.

Crash recovery is deterministic: before publication, a missing final plus a present partial resumes; a missing partial returns to waiting/retry. After `placing` is persisted, an absent final resumes publication, a present final with the expected path/size and successful probe proceeds to scanner registration, and any unrelated/conflicting final enters Needs review without overwrite. After scanning but before completion, recovery finds the path-derived media record, writes the completed-import ledger and removes the Wanted entry in one database transaction. A completed-import ledger entry always wins and prevents a second import.

## UI

Wanted provides add/remove actions, the official Stremio link, status/progress, retry/cancel, Needs review explanations, season-pack preview, and Import Season. Integrations provides masked token entry and Test connection for Real-Debrid and TorBox; it never returns or displays a saved token. Status labels are Wanted, Waiting for provider, Match found, Downloading, Verifying, Imported, and Needs review.

Durable technical states are `wanted`, `waiting-provider`, `match-found`, `retry-wait`, `downloading`, `verifying`, `placing`, `imported`, `needs-review`, and `cancelled`. The UI maps retry-wait to Waiting for provider and placing to Verifying; permanent failures map to Needs review with a safe explanation. Cancelled is displayed explicitly and offers Retry. There is no uncontrolled hidden failure state.

## Verification

Automated coverage includes provider adapters with mocked official responses, persistence/restart recovery, filename parsing and exact matching, quality choice, pack behavior, exclusions, sanitization/traversal, duplicates, partial/resume, URL refresh, disk failure, corrupt media, redaction, server routes, and UI behavior. Final local gates are tests, typecheck, lint, build, restart verification, and browser smoke.

Live provider authentication/listing and one controlled end-to-end authorized import remain user-gated until tokens are entered directly into MarkTV. Tokens must never be pasted into chat or terminal output.
