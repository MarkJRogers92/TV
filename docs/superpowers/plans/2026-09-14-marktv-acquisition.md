# MarkTV Acquisition Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, local-only Wanted List to verified-library acquisition workflow using user-selected Stremio sources and completed Real-Debrid or TorBox torrents.

**Architecture:** A provider-neutral acquisition subsystem owns pure matching, durable state, resumable downloads, safe import, and coordination. Separate Real-Debrid/TorBox adapters and a Keychain credential store are injected into Fastify; thin routes and two React pages expose commands and status.

**Tech Stack:** Node.js 22, TypeScript, Fastify, React 19, SQLite/better-sqlite3, Zod, Vitest/Testing Library, macOS `/usr/bin/security`, ffprobe.

**Spec:** `docs/superpowers/specs/2026-09-14-marktv-acquisition-design.md`

## Global Constraints

- No automated torrent searching, source selection, magnet submission, Stremio scraping, DRM bypass, remote deletion, commit, push, merge, publish, or deploy.
- Use only `stremio:///search?search={URI-encoded query}` for Stremio.
- First provider scope is completed torrents: Real-Debrid `/user`, `/torrents`, `/torrents/info/{id}`, `/unrestrict/link`; TorBox `/v1/api/user/me`, `/v1/api/torrents/mylist`, `/v1/api/torrents/requestdl`.
- Never store or log tokens, bearer headers, provider download URLs, or credential-bearing URLs.
- Server credential/file-control routes require a loopback bind.
- Production changes follow red-green-refactor; workers use `working-tree` mode and create no commits.
- Preserve all untracked files in the main checkout and edit only the isolated worktree.

---

### Task 1: Durable acquisition records and loopback boundary

**Files:**
- Create: `src/acquisition/models.ts`
- Create: `src/acquisition/repository.ts`
- Modify: `src/db/database.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Test: `tests/acquisition/repository.test.ts`
- Test: `tests/server/localOnly.test.ts`

**Interfaces:**
- Produces `WantedEpisode`, `AcquisitionJob`, `AcquisitionReview`, `CompletedImport`, their Zod schemas, and `createAcquisitionRepository(database)`.
- Defines technical state union `wanted | waiting-provider | match-found | retry-wait | downloading | verifying | placing | imported | needs-review | cancelled` and enforces valid persisted values.
- Produces `assertLoopbackHost(host: string): void` used before `app.listen`.

- [ ] Write repository tests that prove Wanted records survive database reopen, status/job/review records round-trip, deleting an unstarted/cancelled Wanted record also removes open reviews, deleting with a nonterminal job returns an active-job result, completed imports are never cascaded, episode identity is unique, and provider/item/file identity cannot be imported twice.
- [ ] Run `npm test -- --configLoader runner tests/acquisition/repository.test.ts` and confirm failures are missing schema/repository behavior.
- [ ] Add additive `CREATE TABLE IF NOT EXISTS` migrations with explicit columns and unique indexes; implement typed repository methods without putting network/file work inside transactions.
- [ ] Write server tests proving `127.0.0.1`, `::1`, and `localhost` are accepted while `0.0.0.0`, `::`, and LAN/public hosts are rejected before listen.
- [ ] Run both focused files and `npm run typecheck`; keep all state schemas strict and timestamps ISO strings.

### Task 2: Wanted API and Stremio workflow

**Files:**
- Create: `src/acquisition/identity.ts`
- Create: `src/server/routes/acquisitions.ts`
- Modify: `src/server/app.ts`
- Test: `tests/acquisition/identity.test.ts`
- Test: `tests/server/acquisitionRoutes.test.ts`

**Interfaces:**
- Produces `episodeKey(seriesTitle, season, episode): string` and `stremioSearchUrl(wanted): string`.
- Produces routes `GET/POST /api/v1/acquisitions/wanted`, `DELETE /wanted/:id`, `GET /status`, `POST /poll`, `POST /jobs/:id/retry`, `POST /jobs/:id/cancel`, and `POST /reviews/:id/import-season` with unimplemented commands returning safe `409 NOT_READY` until their services land.

- [ ] Write failing identity tests with literal URLs and normalization cases, including Unicode and the exact `stremio:///search?search=` prefix.
- [ ] Write failing route tests for validation, create/list/delete persistence, duplicate episode conflict, no token fields in JSON, and restart persistence using the same data directory.
- [ ] Implement identity helpers and thin repository-backed Wanted routes with server-generated UUIDs and initial `wanted` status.
- [ ] Register routes in `buildApp` and inject the acquisition repository through `ServerContext`.
- [ ] Run the two focused files and typecheck.

### Task 3: Filename parser, matcher, quality rules, and season packs

**Files:**
- Create: `src/acquisition/providerTypes.ts`
- Create: `src/acquisition/filename.ts`
- Create: `src/acquisition/matcher.ts`
- Test: `tests/acquisition/filename.test.ts`
- Test: `tests/acquisition/matcher.test.ts`

**Interfaces:**
- Produces provider-safe discriminated records in `providerTypes.ts`, `parseVideoCandidate(file: RemoteFile): ParsedVideoCandidate | null`, and `matchCompletedFiles(wanted: WantedEpisode[], remoteItems: RemoteItem[], completed: CompletedImport[]): MatchPlan`.
- `ProviderName = 'real-debrid' | 'torbox'`, `RemoteItemType = 'torrent'`, `RemoteItem = {provider,itemType,remoteItemId,originalName,completedAt,files}`, and `RemoteFile = {provider,itemType,remoteItemId,remoteFileId,originalFilename,remotePath,bytes}`. These contain no URL or token.
- `MatchPlan` is exactly one of `{kind:'none'}`, `{kind:'automatic', selections}`, `{kind:'review', reason, candidates}`, or `{kind:'season-pack', wantedSelections, packPreview}`.

- [ ] Write table-driven failing parser tests for `S01E02`, `S1E2`, `1x02`, common dots/spaces, canonical MarkTV names, resolution tags, multi-episode ambiguity, video extension allowlist, sample/trailer/featurette/extra rejection, and unsafe paths.
- [ ] Write failing matcher tests for exact normalized series/season/episode, no cross-season match, duplicate candidate ambiguity, best <=720p, lowest >720p fallback, unreasonable size rejection, and duplicate completed-import exclusion.
- [ ] Write failing season-pack tests proving automatic selection includes only Wanted episodes and preview reports recognized unique count plus required bytes.
- [ ] Implement pure parsing/ranking/matching with no provider-specific fields and deterministic tie handling.
- [ ] Run both focused files, typecheck, and mutation-check the wrong-season, wrong-resolution, and sample branches.

### Task 4: Keychain and provider adapters

**Files:**
- Create: `src/security/credentialStore.ts`
- Create: `src/security/keychain.ts`
- Create: `src/security/redaction.ts`
- Create: `src/integrations/acquisition/provider.ts`
- Create: `src/integrations/acquisition/realDebrid.ts`
- Create: `src/integrations/acquisition/torBox.ts`
- Test: `tests/security/keychain.test.ts`
- Test: `tests/security/redaction.test.ts`
- Test: `tests/integrations/realDebrid.test.ts`
- Test: `tests/integrations/torBox.test.ts`

**Interfaces:**
- `CredentialStore` exposes `get(provider)`, `set(provider, token)`, and `remove(provider)`.
- Consumes `RemoteItem` and `RemoteFile` from `src/acquisition/providerTypes.ts`; do not redefine them in an integration module.
- `AcquisitionProvider` exposes `testAuthentication(token)`, `listCompletedItems(token): Promise<RemoteItem[]>`, and `requestDownloadUrl(token, locator: Pick<RemoteFile,'provider'|'itemType'|'remoteItemId'|'remoteFileId'>): Promise<string>`. The adapter reloads provider state as needed; URLs remain memory-only.
- `ProviderError` carries `code`, `retryable`, and optional `retryAfterMs`, never a credential-bearing URL.

- [ ] Write failing Keychain tests using an injected process runner; assert token input is sent through stdin and never occurs in executable arguments, output, or errors.
- [ ] Write failing redaction tests for Bearer headers, `token`, `auth_token`, API-key query parameters, signed URLs, nested error causes, and ordinary safe text preservation.
- [ ] Write failing Real-Debrid adapter tests from complete official-shaped fixtures for auth, downloaded torrents, torrent info file/link alignment, unrestrict, 401, 429/Retry-After, 5xx, schema drift, and pagination.
- [ ] Write failing TorBox adapter tests from complete official-shaped envelopes for `/user/me`, `mylist`, `download_finished`, `requestdl`, token query redaction, 401, 429, 5xx, and schema drift.
- [ ] Implement the injected Keychain runner, central redaction, provider contract, and adapters with injected fetch and Zod boundary parsing. Do not implement create/delete/control endpoints.
- [ ] Run the four focused files and typecheck.

### Task 5: Resumable downloader and verified safe importer

**Files:**
- Create: `src/acquisition/paths.ts`
- Create: `src/acquisition/downloader.ts`
- Create: `src/acquisition/importer.ts`
- Create: `src/acquisition/remoteUrl.ts`
- Create: `src/media/roots.ts`
- Modify: `src/media/ffprobe.ts`
- Modify: `src/media/localFolder.ts`
- Modify: `src/server/routes/media.ts`
- Test: `tests/acquisition/paths.test.ts`
- Test: `tests/acquisition/downloader.test.ts`
- Test: `tests/acquisition/importer.test.ts`
- Test: `tests/media/localFolder.test.ts`

**Interfaces:**
- `downloadJob(job, provider, token, hooks, signal)` streams to `<inbox>/<job-id>.part`, persists progress, and returns the completed part path.
- `importVerifiedEpisode(job, wanted, partPath, context)` returns the registered `MediaItem` and `CompletedImport`.
- Shared media-root helpers expose `mediaRootId`, `listMediaRoots`, and `putMediaRoot`.

- [ ] Write failing path tests for canonical naming, invalid characters, reserved names, `..`, absolute-path inputs, extension allowlist, containment, and non-symlink parents.
- [ ] Write failing remote-URL/downloader tests for HTTPS-only URLs, no URL credentials, public DNS addresses only, IPv4/IPv6 loopback/private/link-local/unspecified/multicast/cloud-metadata rejection, manually validated redirects with a five-hop cap, new `200` transfer, valid `206` resume, `200` restart after Range, invalid Content-Range, interrupted preservation, cancellation preservation, progress, expired-link regeneration, three-attempt backoff, and disk-space rejection.
- [ ] Write failing importer tests for corrupt probe rejection, no-clobber duplicate detection, atomic publication, original remote identity preservation, scanner registration, canonical rescans preserving metadata, and database/filesystem recovery states.
- [ ] Extract media-root helpers without behavior changes. Create `<dataDir>/inbox` and `<dataDir>/library` with owner-only permissions, reject symlink/non-directory replacements, resolve them, and idempotently register the managed root. Extend probing only as needed to verify a readable video stream/duration while retaining injection.
- [ ] Make the shared parser recognize canonical `Series - S03E04 - Episode Title.ext` and update the scanner mapping so `title` is the episode title and `showTitle` is the series.
- [ ] Implement safe paths, validated manual-redirect streaming download, and importer. Persist `placing` before publication and cover the crash matrix: pre-publish missing/present partial; placing with absent final; expected verified final; conflicting final; scanned media without completion ledger; completion ledger preventing all repeats.
- [ ] Run all four focused files and typecheck.

### Task 6: Single-flight coordinator, recovery, and provider/integration routes

**Files:**
- Create: `src/acquisition/coordinator.ts`
- Create: `src/server/routes/integrations.ts`
- Modify: `src/server/routes/acquisitions.ts`
- Modify: `src/server/context.ts`
- Modify: `src/server/app.ts`
- Test: `tests/acquisition/coordinator.test.ts`
- Test: `tests/server/integrationRoutes.test.ts`
- Test: `tests/server/acquisitionRoutes.test.ts`
- Test: `tests/server/acquisitionRestart.test.ts`

**Interfaces:**
- `AcquisitionCoordinator` exposes `start()`, `stop()`, `pollOnce()`, `retry(jobId)`, `cancel(jobId)`, and `importSeason(reviewId)`.
- Integration routes expose `GET /api/v1/integrations`, `PUT /:provider/token`, and `POST /:provider/test`; responses contain only provider, connected, accountLabel, and safe error state.

- [ ] Write failing coordinator tests for single-flight polling, exact automatic match, ambiguity review, pack Wanted-only scheduling, bounded/retry-after handling, permanent auth stop, duplicate prevention, every technical-state transition and its seven-label/Cancelled projection, retry, cancel, active-job Wanted deletion conflict, and shutdown.
- [ ] Write failing restart tests for waiting/matched/downloading/verifying/placing states and `.part` recovery without duplicate imports.
- [ ] Write failing integration route tests with an in-memory credential store; assert a saved token is never returned, SQLite remains token-free, test-auth works, and provider errors are redacted.
- [ ] Implement coordinator state transitions and wire injected/default providers, Keychain, importer, and timer lifecycle through `buildApp`; use a 60-second default and `unref()` the timer.
- [ ] Replace Task 2 `NOT_READY` commands with coordinator calls and implement season-pack preflight/recheck.
- [ ] Run all four focused files and typecheck.

### Task 7: Wanted and Integrations UI

**Files:**
- Create: `web/pages/Wanted.tsx`
- Create: `web/pages/Integrations.tsx`
- Create: `web/components/AcquisitionStatus.tsx`
- Modify: `web/types.ts`
- Modify: `web/api.ts`
- Modify: `web/components/Nav.tsx`
- Modify: `web/App.tsx`
- Modify: `web/styles.css`
- Test: `tests/web/wanted.test.tsx`
- Test: `tests/web/integrations.test.tsx`
- Modify: `tests/web/app.test.tsx`

**Interfaces:**
- Extends `MarkTvApi` with the routes from Tasks 2 and 6.
- `Wanted` and `Integrations` accept an optional injected `client` like existing pages.

- [ ] Write failing Wanted UI tests for add/delete, encoded Stremio anchor, all seven non-technical labels, progress, safe retry/cancel, Needs review explanation, pack count/bytes, and Import Season confirmation.
- [ ] Write failing Integrations UI tests for masked password inputs, connect/test flows, never rendering returned/saved tokens, and friendly invalid/rate-limit/outage errors.
- [ ] Write failing App navigation/hash-route tests for Wanted and Integrations.
- [ ] Implement API/type additions, focused pages/components, navigation, and existing-style responsive CSS; use lightweight polling only while active jobs exist.
- [ ] Run the three focused web files and typecheck.

### Task 8: Documentation and full local acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/INSTALL.md`
- Modify: `docs/CONFIGURATION.md`
- Test: `tests/browser/smoke.spec.ts`

**Interfaces:**
- Documents Keychain-only token entry, local-only host enforcement, Inbox/library paths, Stremio manual step, retry/cancel semantics, and the live-verification gate.

- [ ] Extend the browser smoke to navigate Wanted and Integrations without entering any token or contacting providers.
- [ ] Document setup and operational boundaries without example secrets or credential-bearing URLs.
- [ ] Run `npm test -- --configLoader runner`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run verify:restart`, and `npm run test:browser`.
- [ ] Inspect `git status --short`, `git diff --check`, and the complete diff; confirm only feature-worktree files changed and no credential or remote URL was persisted.
- [ ] Stop before live auth/listing or controlled import if tokens have not been entered directly into MarkTV. Report the exact manual actions needed; never request tokens in chat.
