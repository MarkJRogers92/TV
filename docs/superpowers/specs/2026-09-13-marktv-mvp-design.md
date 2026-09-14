# MarkTV MVP Design

## Purpose

MarkTV is a private, local programming manager for a linear television channel. It chooses what airs and when, previews the resulting electronic program guide (EPG), and sends compatible programming to Tunarr. Tunarr remains responsible for media playback, FFmpeg, transcoding, HLS, HDHomeRun emulation, and client-facing guide delivery.

The MVP ships with one demo channel, **MarkTV Laughs**, modeled after a classic over-the-air sitcom network. The architecture treats a channel as data so additional channels can be added without duplicating scheduling code.

## Success Criteria

The MVP is complete when a user can:

1. Install dependencies and start MarkTV locally on a MacBook Air M2 with documented commands.
2. Open a browser-based admin interface and see Now Playing, Up Next, channel configuration, media pools, and a daily schedule.
3. Scan one or more local folders for common video files without playing or transcoding them.
4. Create and edit show, movie, commercial/filler, station-ID, and bumper pools.
5. Configure dayparts and scheduling rules for chronological or shuffled episodes, no-repeat windows, movie slots, interstitial breaks, and movie mid-roll policies.
6. Generate a deterministic daily schedule and regenerate the same result from the same configuration, date, and media state.
7. Export every generated schedule as a versioned MarkTV JSON artifact.
8. Test a Tunarr connection, preview a dry-run mapping, and sync compatible programming through Tunarr's current REST API when the installed Tunarr version supports it.
9. Run the included demo entirely from placeholder metadata before supplying real media.

## Scope

### Included

- One local web application with a React admin UI and Fastify API.
- SQLite persistence for application state.
- Multiple-channel data model, with one seeded demo channel.
- Local-folder media discovery.
- Optional `ffprobe` metadata inspection for duration; files lacking a usable duration are reported and excluded from generated schedules until corrected.
- Manual metadata editing for discovered and placeholder media.
- Daily schedule generation and EPG-style preview.
- Now Playing and Up Next calculated from the generated schedule and MarkTV's configured timezone.
- Versioned JSON schedule export.
- Tunarr health/version detection, library matching, dry-run reporting, channel creation/update, programming sync, filler-list configuration where supported, and clear unsupported-version errors.
- Sample configuration and local setup/configuration documentation.

### Excluded

- Video playback, transcoding, media segmentation, HLS, tuner emulation, and client apps.
- Authentication or internet exposure. MarkTV binds to `127.0.0.1` by default.
- Plex, Jellyfin, or Emby adapters.
- Multi-user editing, cloud synchronization, and remote deployment.
- Automatic destructive replacement of a Tunarr lineup without a visible dry run and explicit Sync action.
- GitHub repository creation, pushing, publishing, or deployment.

## Technical Architecture

MarkTV uses Node.js 22 or newer and TypeScript. Fastify hosts the JSON API and the built React/Vite application from one process. SQLite is accessed through a small repository layer. Runtime data lives under a configurable local data directory, defaulting to `./data`; generated files and the database are ignored by Git.

The application is divided into focused modules:

- **Domain model:** channel, media item, pool, daypart, slot rule, break rule, and schedule-entry types plus validation schemas.
- **Scheduler:** a pure deterministic function that consumes a channel definition, eligible media, prior play history, and a date, then returns schedule entries and diagnostics.
- **Media adapters:** an interface for discovering media. The MVP implements `LocalFolderAdapter`; later Plex and Jellyfin adapters can implement the same contract.
- **Persistence:** SQLite repositories and migrations. HTTP handlers never issue SQL directly.
- **Tunarr adapter:** version/feature detection, path-based media matching, payload construction, dry-run comparison, and sync. Tunarr-specific types stay out of the scheduler.
- **Export adapter:** writes a complete versioned MarkTV schedule artifact regardless of Tunarr availability.
- **Web application:** dashboard, channel editor, media/pool editor, schedule preview, and Tunarr connection/sync view.

The production start command builds the UI and launches one local server. Development mode may run Vite and Fastify together behind a single script.

## Data Model

### Channel

- Stable ID, name, channel number, timezone, enabled state, and optional logo path.
- Dayparts and recurring slot rules.
- Default no-repeat windows and break policy.
- Tunarr connection/channel mapping kept as integration configuration, not domain scheduling state.

### Media Item

- Stable MarkTV ID and adapter source (`placeholder` or `local-folder`).
- Absolute source path when backed by a local file.
- Kind: `episode`, `movie`, `commercial`, `filler`, `station-id`, or `bumper`.
- Title, duration, and optional show title, season, episode, year, description, and tags.
- Availability state and optional Tunarr program ID discovered during matching.

The path is the primary match key for real local media. Placeholder items cannot be synced to Tunarr and are called out in dry-run diagnostics.

### Pool

- Stable ID, name, allowed media kinds, and ordered media membership.
- Selection mode: `chronological` or `shuffle`.
- No-repeat window in minutes.
- Optional pool-level weight used when a slot references several pools.

Chronological state advances by the tuple `(show title, season, episode, media ID)`. Shuffle selection is deterministic for a given channel/date seed while respecting cooldowns.

### Daypart and Slot Rule

- Daypart: name, days of week, local start time, local end time, and priority.
- Slot: start cadence or fixed local time, allowed pool IDs, content kind, and selection overrides.
- Movie slots use a fixed day/time and movie pool.
- Higher-priority overlapping dayparts win. Equal-priority overlap is rejected during validation.

### Break Policy

- Between-program filler targets a wall-clock boundary, normally a 30-minute grid.
- Eligible pools are separated by role: commercials, general filler, station IDs, and bumpers.
- Cooldowns apply to interstitial items independently of show/movie cooldowns.
- The scheduler greedily selects items that fit the remaining gap without exceeding it. A residual gap is represented as `flex` for Tunarr rather than fabricating duration.
- Movie mid-roll settings include fixed interval, break duration, minimum program duration, maximum breaks, tail buffer, and eager/lazy selection. MarkTV stores and previews the policy; Tunarr performs the actual split and filler insertion.

### Generated Schedule

- Channel ID, local broadcast date, timezone, deterministic seed, generation timestamp, source configuration revision, and ordered entries.
- Each entry has start/end timestamps, duration, type, media reference or flex reason, source slot/daypart, and human-readable selection explanation.
- Diagnostics list missing durations, exhausted pools, cooldown relaxations, placeholder items, Tunarr match failures, and validation errors.

## Scheduling Behavior

The scheduler generates one local broadcast day at a time, from local midnight to the next local midnight. It uses timezone-aware instants so daylight-saving transitions produce a real 23- or 25-hour day when applicable.

For each position in the day:

1. Resolve the active fixed slot or highest-priority daypart rule.
2. Filter candidate media by pool, kind, availability, and duration.
3. Exclude candidates inside their configured no-repeat window.
4. Select the next chronological episode or a deterministic shuffled candidate.
5. Place the selected program.
6. Fill the remaining space to the configured boundary with eligible commercials, bumpers, and station IDs; represent any unfillable remainder as flex.
7. Record selection history and diagnostics, then continue until the end of the broadcast day.

If a pool has no eligible candidate, the scheduler first emits a diagnostic and uses configured fallback pools. It relaxes cooldowns only when a rule explicitly enables that behavior; otherwise it emits flex until the next resolvable boundary. Invalid configuration returns a validation response and does not replace the last successful schedule.

Generation is idempotent for the same date, configuration revision, media revision, and history snapshot. Regeneration is saved as a new generation while the last successful schedule remains available until replacement succeeds.

## Demo Channel

The seed data creates **MarkTV Laughs**, channel 7, in the machine's configured timezone with placeholder metadata:

- Morning comedy block from 6:00 AM to noon.
- Daytime sitcom block from noon to 5:00 PM.
- Evening favorites from 5:00 PM to 8:00 PM.
- Friday and Saturday movie slot at 8:00 PM.
- Late-night and overnight rerun blocks.
- Chronological episode pools for individual shows, shuffled selection between shows, a 12-hour episode no-repeat window, a 7-day movie no-repeat window, and a 2-hour commercial/bumper cooldown.
- Interstitials fill toward half-hour boundaries, with station IDs eligible at the top of the hour.
- Movies longer than 60 minutes preview 3-minute lazy mid-roll breaks every 30 minutes, performed by Tunarr after sync.

All demo titles are clearly fictional placeholders. The first generated preview works without real files but is marked **Preview only** and cannot be synced until items are matched to Tunarr media.

## HTTP API and UI Flow

The API is versioned under `/api/v1` and includes resources for health, channels, media roots/items, pools, schedules, and Tunarr integration. Request and response bodies share validation schemas with the domain layer.

The browser workflow is:

1. Dashboard shows MarkTV Laughs with current schedule status, Now Playing, and Up Next.
2. Channel editor changes identity, dayparts, slot rules, and break policies.
3. Library view adds a local root, scans it, reports metadata issues, and assigns items to pools.
4. Schedule view selects a date, generates or regenerates it, and displays a chronological EPG plus diagnostics.
5. Tunarr view saves a local URL, tests connectivity, requests a dry run, displays creates/updates/unmatched items, and enables Sync only when validation succeeds.

Mutating operations return validation errors with field paths. The UI preserves entered values and displays errors inline. Server errors use stable codes and safe messages; details remain in local logs.

## Tunarr Integration

Tunarr documents local-file sources, channel programming, filler lists, scheduling tools, and mid-roll breaks. It also exposes an OpenAPI-described REST API. Because API schemas can change between Tunarr releases, MarkTV does not couple scheduling to a single unverified payload shape.

The adapter follows this sequence:

1. Call Tunarr's version and health endpoints.
2. Detect supported endpoints and record the reported version.
3. Fetch Tunarr local-library programs and build a normalized absolute-path index.
4. Match every real MarkTV schedule entry to a Tunarr program; never guess among duplicate paths.
5. Build an in-memory sync plan containing channel changes, programming order, filler mappings, mid-roll settings, warnings, and blocking errors.
6. Return that plan for the UI dry run.
7. On explicit Sync, revalidate the Tunarr version and relevant channel state, then apply the same plan.
8. Return a result containing applied operations and any partial failure. Keep the JSON export as the recovery artifact.

If the current API differs from the supported contract, MarkTV stops before mutation, reports the version and failing capability, and leaves a schedule artifact that can be used to configure or extend the adapter. It does not write directly to Tunarr's database.

## Export Format

Each export is UTF-8 JSON named `<channel-slug>-YYYY-MM-DD.marktv.json`. It contains:

- `schemaVersion`
- MarkTV build version
- channel identity and timezone
- generation inputs and revision IDs
- ordered schedule entries with ISO timestamps and durations
- local paths for real media
- Tunarr IDs when matched
- break policy and filler roles
- diagnostics and sync eligibility

The export is MarkTV's stable interoperability and troubleshooting format, not a claim that Tunarr imports arbitrary JSON directly.

## Safety and Local Operation

- The server listens on `127.0.0.1` by default and has no authentication because remote access is outside the MVP.
- Local media is read-only. Scanning never renames, moves, edits, or deletes source files.
- Tunarr sync requires an explicit user action after a fresh dry run.
- SQLite writes use transactions. Failed generation or sync cannot erase the previous successful schedule.
- Paths and Tunarr URLs are validated. Logs never include credentials.
- No Git remote or deployment is created.

## Testing and Verification

### Automated tests

- Domain validation for overlapping dayparts, missing durations, invalid pools, and unsupported break settings.
- Scheduler tests for determinism, chronological episode order, shuffle stability, cooldown/no-repeat enforcement, fallback behavior, half-hour filler, station IDs, movie slots, midnight boundaries, and daylight-saving days.
- Local-folder adapter tests using temporary fixture trees; source files remain unchanged.
- Repository/API tests for create, edit, scan, generate, reload, and failed-generation preservation.
- Tunarr adapter contract tests using a local fake HTTP server for version detection, matching, dry run, supported sync, schema mismatch, duplicate paths, and partial failure reporting.
- Export schema tests.
- React component tests for Now Playing/Up Next, validation feedback, schedule rows, placeholder warnings, and disabled/enabled sync states.

### Final verification

- Install from a clean checkout with the documented supported Node version.
- Run the complete automated test suite and production build.
- Start the production server with a temporary data directory.
- Confirm the health endpoint and seeded demo schedule through HTTP.
- Open the UI in a real browser, confirm primary pages render, and check for console/page errors.
- Confirm stopping and restarting preserves configuration and the generated schedule.
- Confirm no process outside MarkTV is required for preview-only demo operation.

## Documentation Deliverables

- `README.md`: purpose, prerequisites, quick start, screenshots or UI description, and architectural boundary with Tunarr.
- `docs/INSTALL.md`: Node and optional `ffprobe` installation, dependency install, production build/start, data location, and troubleshooting.
- `docs/CONFIGURATION.md`: channel, folders, metadata, pools, dayparts, rules, breaks, generation, and timezone behavior.
- `docs/TUNARR.md`: supported connection flow, local-library path matching, dry run, sync, version/schema mismatch recovery, and clear separation from streaming.
- `config/marktv-laughs.sample.json`: readable sample equivalent of the seeded demo channel.

## Deferred Extensions

- Additional channels using the same channel model and scheduler.
- Plex, Jellyfin, and Emby media adapters.
- Authentication and LAN access.
- Schedule templates, seasonal programming, ratings constraints, and richer rotation strategies.
- Direct XMLTV generation only if a concrete client needs MarkTV—not Tunarr—to serve EPG data.

## Authoritative External References

- Tunarr channels: <https://tunarr.com/configure/channels/>
- Tunarr programming: <https://tunarr.com/configure/channels/programming/>
- Tunarr mid-roll breaks: <https://tunarr.com/configure/scheduling/mid-roll-breaks/>
- Tunarr API reference: <https://tunarr.com/api-docs.html>
