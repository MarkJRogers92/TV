# MarkTV MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable MarkTV admin application that creates a Laff-style daily schedule from local media metadata and safely previews or syncs that programming to Tunarr.

**Architecture:** A single TypeScript package runs a Fastify API and serves a React/Vite admin UI. Pure domain and scheduling modules sit behind SQLite repositories, while local-folder and Tunarr adapters remain replaceable boundaries; every schedule is also exportable as stable MarkTV JSON.

**Tech Stack:** Node.js 22+, TypeScript 5, Fastify 5, React 19, Vite 7, Zod 4, better-sqlite3 12, Luxon 3, Vitest 3, Testing Library, Playwright, ESLint, and Prettier.

**Spec:** `docs/superpowers/specs/2026-09-13-marktv-mvp-design.md`

## Global Constraints

- Bind to `127.0.0.1` by default and do not add authentication or remote hosting.
- Do not implement playback, transcoding, FFmpeg pipelines, HLS, tuner emulation, or client applications.
- Media scanning is read-only and may call `ffprobe` only to inspect duration.
- Treat channel scheduling as pure domain logic; no Fastify, SQLite, filesystem, or Tunarr calls inside the scheduler.
- Use deterministic generation keyed by channel ID, broadcast date, configuration revision, media revision, and history snapshot.
- Preserve the last successful schedule when validation or regeneration fails.
- Require a fresh Tunarr dry run before explicit synchronization; never write to Tunarr's database.
- Always write a versioned MarkTV JSON export independently of Tunarr availability.
- Keep source files under roughly 250 lines where practical and split by responsibility.
- Keep all work local. Do not create a GitHub remote, push, publish, or deploy.

## Planned File Structure

```text
package.json                    scripts and dependencies
tsconfig.json                   shared strict TypeScript settings
tsconfig.server.json            server build settings
vite.config.ts                  React build and development proxy
vitest.config.ts                unit/integration test settings
playwright.config.ts            local browser smoke settings
.gitignore                      generated data and build output
src/domain/models.ts            domain schemas and inferred types
src/domain/validation.ts        cross-record configuration validation
src/scheduler/generate.ts       pure day-generation loop
src/scheduler/select.ts         chronological/shuffle/cooldown selection
src/scheduler/fill.ts           boundary filler and flex placement
src/db/database.ts              SQLite connection and migrations
src/db/repositories.ts          transactional state repositories
src/demo/marktvLaughs.ts        fictional seeded channel and media
src/media/adapter.ts            media adapter contract
src/media/localFolder.ts        read-only discovery and ffprobe metadata
src/export/marktvJson.ts        versioned schedule writer
src/integrations/tunarr/types.ts Tunarr compatibility schemas
src/integrations/tunarr/client.ts version and HTTP transport
src/integrations/tunarr/plan.ts  path matching and dry-run plan
src/integrations/tunarr/sync.ts  explicit guarded mutation
src/server/app.ts               Fastify application composition
src/server/routes/*.ts          versioned resource endpoints
src/server/index.ts             local process entrypoint
web/main.tsx                    React entrypoint
web/App.tsx                     application shell and routing
web/api.ts                      typed API calls
web/styles.css                  MarkTV visual system
web/pages/Dashboard.tsx         Now Playing and Up Next
web/pages/ChannelEditor.tsx     channel/daypart/rule forms
web/pages/Library.tsx           roots, media, and pools
web/pages/Schedule.tsx          EPG preview and generation
web/pages/Tunarr.tsx            connection, dry run, and sync
tests/**/*.test.ts[x]           domain, API, adapter, and UI tests
tests/browser/smoke.spec.ts      production browser verification
config/marktv-laughs.sample.json readable sample configuration
README.md                       quick start and product boundary
docs/INSTALL.md                 installation and start guide
docs/CONFIGURATION.md           scheduling and media guide
docs/TUNARR.md                  safe integration guide
```

---

### Task 1: Runnable Application Foundation

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`
- Create: `src/server/app.ts`, `src/server/index.ts`, `web/index.html`, `web/main.tsx`, `web/App.tsx`, `web/styles.css`
- Test: `tests/server/health.test.ts`, `tests/web/app.test.tsx`

**Interfaces:**
- Produces: `buildApp(options?: { dataDir?: string; now?: () => Date }): Promise<FastifyInstance>`
- Produces: `GET /api/v1/health -> { status: "ok", version: string }`

- [ ] **Step 1: Add toolchain configuration and write failing health/UI tests**

```ts
// tests/server/health.test.ts
import { expect, test } from 'vitest';
import { buildApp } from '../../src/server/app.js';

test('reports a healthy local service', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'ok' });
  await app.close();
});
```

```tsx
// tests/web/app.test.tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from '../../web/App';

test('renders the MarkTV application shell', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'MarkTV' })).toBeVisible();
  expect(screen.getByRole('navigation')).toBeVisible();
});
```

- [ ] **Step 2: Install dependencies and verify both tests fail because application modules are absent**

Run: `npm install && npm test -- tests/server/health.test.ts tests/web/app.test.tsx`

Expected: FAIL with unresolved `src/server/app` and `web/App` imports.

- [ ] **Step 3: Implement the minimal Fastify app, React shell, build scripts, and local entrypoint**

```ts
// src/server/app.ts
import Fastify from 'fastify';
import pkg from '../../package.json' with { type: 'json' };

export async function buildApp(_options: { dataDir?: string; now?: () => Date } = {}) {
  const app = Fastify({ logger: false });
  app.get('/api/v1/health', async () => ({ status: 'ok' as const, version: pkg.version }));
  return app;
}
```

`src/server/index.ts` must listen on `MARKTV_HOST ?? '127.0.0.1'` and numeric `MARKTV_PORT ?? 4177`. `web/App.tsx` must render the product name and navigation labels Dashboard, Channel, Library, Schedule, and Tunarr. Configure `npm run dev`, `npm run build`, `npm start`, `npm test`, `npm run lint`, and `npm run test:browser`.

- [ ] **Step 4: Run focused tests and production build**

Run: `npm test -- tests/server/health.test.ts tests/web/app.test.tsx && npm run build`

Expected: two passing tests and successful Vite/server builds.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts playwright.config.ts .gitignore src/server web tests/server tests/web
git commit -m "feat: start local MarkTV application"
```

### Task 2: Validated Domain, SQLite State, and Demo Seed

**Files:**
- Create: `src/domain/models.ts`, `src/domain/validation.ts`
- Create: `src/db/database.ts`, `src/db/repositories.ts`
- Create: `src/demo/marktvLaughs.ts`, `config/marktv-laughs.sample.json`
- Modify: `src/server/app.ts`
- Test: `tests/domain/validation.test.ts`, `tests/db/repositories.test.ts`, `tests/demo/seed.test.ts`

**Interfaces:**
- Produces: Zod schemas and types `Channel`, `MediaItem`, `Pool`, `Daypart`, `SlotRule`, `BreakPolicy`, `Schedule`, `ScheduleEntry`
- Produces: `validateChannelConfiguration(channel, pools, items): ConfigurationIssue[]`
- Produces: `openDatabase(dataDir: string): MarkTvDatabase`
- Produces: `createRepositories(db): { channels, media, pools, schedules, settings }`
- Produces: `seedDemoIfEmpty(repositories, timezone): void`

- [ ] **Step 1: Write failing domain and persistence tests**

```ts
test('rejects equal-priority overlapping dayparts', () => {
  const issues = validateChannelConfiguration(channelWithOverlap, pools, items);
  expect(issues).toContainEqual(expect.objectContaining({ code: 'DAYPART_OVERLAP' }));
});
```

```ts
test('rolls back a failed schedule replacement', () => {
  const repos = createRepositories(openDatabase(tempDir));
  repos.schedules.replaceSuccessful('laughs', validSchedule);
  expect(() => repos.schedules.replaceSuccessful('laughs', invalidSchedule)).toThrow();
  expect(repos.schedules.latest('laughs')?.id).toBe(validSchedule.id);
});
```

```ts
test('seeds one fictional preview-only channel into an empty database', () => {
  seedDemoIfEmpty(repos, 'America/Chicago');
  expect(repos.channels.list()).toEqual([expect.objectContaining({ name: 'MarkTV Laughs', number: 7 })]);
  expect(repos.media.list().every(item => item.source === 'placeholder')).toBe(true);
});
```

- [ ] **Step 2: Run tests and confirm missing schemas/repositories cause failure**

Run: `npm test -- tests/domain/validation.test.ts tests/db/repositories.test.ts tests/demo/seed.test.ts`

Expected: FAIL because domain and database modules do not exist.

- [ ] **Step 3: Implement schemas, cross-record validation, migration, repositories, and seed**

Use integer milliseconds for all durations, ISO strings for instants, `HH:mm` strings for local schedule times, and IANA timezone names. SQLite tables must store JSON domain documents plus indexed IDs/revisions; `replaceSuccessful` validates before beginning a transaction and inserts the schedule atomically. Demo media must use fictional titles such as `Apartment 4B`, `Space Neighbors`, and `The Wacky Weekend Movie`, never copyrighted show or film metadata.

```ts
export type ConfigurationIssue = {
  code: 'DAYPART_OVERLAP' | 'MISSING_POOL' | 'MISSING_DURATION' | 'INVALID_BREAK_POLICY';
  path: string;
  message: string;
};
```

- [ ] **Step 4: Run focused tests and verify database reopen persistence**

Run: `npm test -- tests/domain/validation.test.ts tests/db/repositories.test.ts tests/demo/seed.test.ts`

Expected: all focused tests pass, including closing and reopening the temporary database.

- [ ] **Step 5: Commit the domain and persistence slice**

```bash
git add src/domain src/db src/demo src/server/app.ts config tests/domain tests/db tests/demo
git commit -m "feat: persist validated channel configuration"
```

### Task 3: Deterministic Program Selection

**Files:**
- Create: `src/scheduler/random.ts`, `src/scheduler/select.ts`, `src/scheduler/generate.ts`
- Test: `tests/scheduler/select.test.ts`, `tests/scheduler/generate.test.ts`, `tests/scheduler/timezone.test.ts`

**Interfaces:**
- Produces: `createSeededRandom(seed: string): () => number`
- Produces: `selectCandidate(input: SelectionInput): SelectionResult`
- Produces: `generateSchedule(input: GenerateScheduleInput): ScheduleGenerationResult`
- Consumes: validated domain types from Task 2

- [ ] **Step 1: Write failing tests for chronological order, shuffle stability, cooldowns, and DST**

```ts
test('advances episodes in season and episode order', () => {
  const first = selectCandidate(selection({ mode: 'chronological', history: [] }));
  const second = selectCandidate(selection({ mode: 'chronological', history: [played(first.item, noon)] }));
  expect([first.item.episode, second.item.episode]).toEqual([1, 2]);
});

test('produces identical schedules from identical inputs', () => {
  const first = generateSchedule(input);
  const second = generateSchedule(input);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (first.ok && second.ok) expect(first.schedule.entries).toEqual(second.schedule.entries);
});

test.each([['2026-03-08', 23], ['2026-11-01', 25]])('uses the real Chicago broadcast-day length', (date, hours) => {
  const result = generateSchedule(inputForDate(date));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.schedule.durationMs).toBe(hours * 3_600_000);
});
```

- [ ] **Step 2: Run tests and confirm selection/generation functions are missing**

Run: `npm test -- tests/scheduler/select.test.ts tests/scheduler/generate.test.ts tests/scheduler/timezone.test.ts`

Expected: FAIL with unresolved scheduler imports.

- [ ] **Step 3: Implement stable seeded selection and timezone-aware generation loop**

Hash the complete seed string with a stable 32-bit hash and use Mulberry32 for repeatable pseudo-random values. Resolve fixed slots before dayparts, reject equal-priority overlaps before generation, apply explicit fallback pools in listed order, and return flex plus a diagnostic when no candidate is eligible. Never use `Math.random()` or the server's local timezone inside scheduler modules.

```ts
export type ScheduleGenerationResult =
  | { ok: true; schedule: Schedule; diagnostics: ScheduleDiagnostic[] }
  | { ok: false; issues: ConfigurationIssue[] };
```

- [ ] **Step 4: Run scheduler tests**

Run: `npm test -- tests/scheduler/select.test.ts tests/scheduler/generate.test.ts tests/scheduler/timezone.test.ts`

Expected: all scheduler tests pass with 23-, 24-, and 25-hour days represented correctly.

- [ ] **Step 5: Commit deterministic scheduling**

```bash
git add src/scheduler tests/scheduler
git commit -m "feat: generate deterministic daily programming"
```

### Task 4: Filler, Station IDs, and Movie Policies

**Files:**
- Create: `src/scheduler/fill.ts`
- Modify: `src/scheduler/generate.ts`, `src/demo/marktvLaughs.ts`, `config/marktv-laughs.sample.json`
- Test: `tests/scheduler/fill.test.ts`, `tests/scheduler/movieSlots.test.ts`

**Interfaces:**
- Produces: `fillToBoundary(input: FillInput): FillResult`
- Consumes/extends: `generateSchedule` from Task 3

- [ ] **Step 1: Write failing tests for half-hour fill, hourly IDs, flex residuals, and movie slots**

```ts
test('fills a 480-second gap without exceeding the half-hour boundary', () => {
  const result = fillToBoundary(fillInput({ gapMs: 480_000, durations: [120_000, 60_000, 30_000] }));
  expect(result.entries.reduce((sum, entry) => sum + entry.durationMs, 0)).toBeLessThanOrEqual(480_000);
  expect(result.entries.at(-1)?.end).toBe(boundary);
});

test('places the Friday movie at 8 PM local time', () => {
  const result = generateSchedule(fridayDemoInput);
  expect(result.ok && result.schedule.entries).toContainEqual(expect.objectContaining({ kind: 'movie', localStart: '20:00' }));
});
```

- [ ] **Step 2: Run tests and confirm filler/movie behaviors fail**

Run: `npm test -- tests/scheduler/fill.test.ts tests/scheduler/movieSlots.test.ts`

Expected: FAIL because `fillToBoundary` and the demo movie policy are absent.

- [ ] **Step 3: Implement deterministic best-fit filler and preview mid-roll entries**

Use a bounded dynamic-programming fit over eligible interstitial durations, breaking equal fits with the seeded selection order. Allow a station ID at top-of-hour boundaries, apply independent filler cooldowns, and emit one flex entry for any positive residual. Preview movie mid-rolls as child annotations of the movie entry so MarkTV does not pretend the source file is split; store Tunarr's fixed-interval, 3-minute, minimum-60-minute, lazy strategy settings in the slot policy.

- [ ] **Step 4: Run filler, movie, and full scheduler tests**

Run: `npm test -- tests/scheduler`

Expected: all scheduler tests pass and no entry extends beyond its broadcast-day boundary.

- [ ] **Step 5: Commit broadcast formatting rules**

```bash
git add src/scheduler src/demo config tests/scheduler
git commit -m "feat: add broadcast filler and movie slots"
```

### Task 5: Read-Only Local Media Discovery and JSON Export

**Files:**
- Create: `src/media/adapter.ts`, `src/media/localFolder.ts`, `src/media/ffprobe.ts`
- Create: `src/export/marktvJson.ts`
- Test: `tests/media/localFolder.test.ts`, `tests/export/marktvJson.test.ts`
- Create fixtures: `tests/fixtures/media/Comedy_Show/Season_01/Comedy_Show_S01E01.mp4`, `tests/fixtures/media/Movies/Wacky_Weekend_2024.mkv`

**Interfaces:**
- Produces: `MediaAdapter.scan(root: string): Promise<MediaScanResult>`
- Produces: `LocalFolderAdapter` with injected `probe(path): Promise<ProbeResult>`
- Produces: `writeScheduleExport(schedule, destinationDir): Promise<string>`

- [ ] **Step 1: Write failing discovery and export tests**

```ts
test('discovers supported files without modifying the source tree', async () => {
  const before = await snapshotTree(fixtureRoot);
  const result = await adapter.scan(fixtureRoot);
  expect(result.items.map(item => item.kind)).toEqual(['episode', 'movie']);
  expect(await snapshotTree(fixtureRoot)).toEqual(before);
});

test('exports a versioned schedule with absolute paths', async () => {
  const path = await writeScheduleExport(realMediaSchedule, outputDir);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.entries[0].path).toMatch(/^\//);
});
```

- [ ] **Step 2: Run tests and confirm adapter/export modules are missing**

Run: `npm test -- tests/media/localFolder.test.ts tests/export/marktvJson.test.ts`

Expected: FAIL with unresolved media/export imports.

- [ ] **Step 3: Implement discovery, optional ffprobe inspection, and atomic JSON export**

Support `.mp4`, `.m4v`, `.mkv`, `.mov`, `.avi`, and `.webm`. Ignore hidden files and symlinks by default. Parse `SxxEyy` only as a metadata hint; retain editable titles. Call `ffprobe -v error -show_entries format=duration -of json -- <absolute-path>` through argument arrays, never a shell string. If unavailable or invalid, record `durationStatus: 'missing'`. Write exports to a temporary sibling file and rename atomically.

- [ ] **Step 4: Run adapter tests and inspect fixture hashes before/after**

Run: `npm test -- tests/media/localFolder.test.ts tests/export/marktvJson.test.ts`

Expected: all focused tests pass and fixture hashes remain identical.

- [ ] **Step 5: Commit local media and export adapters**

```bash
git add src/media src/export tests/media tests/export tests/fixtures
git commit -m "feat: scan local media and export schedules"
```

### Task 6: Admin API and Browser UI

**Files:**
- Create: `src/server/routes/channels.ts`, `src/server/routes/media.ts`, `src/server/routes/pools.ts`, `src/server/routes/schedules.ts`
- Modify: `src/server/app.ts`
- Create: `web/api.ts`, `web/types.ts`, `web/components/Nav.tsx`, `web/components/StatusCard.tsx`, `web/components/ScheduleTable.tsx`
- Create: `web/pages/Dashboard.tsx`, `web/pages/ChannelEditor.tsx`, `web/pages/Library.tsx`, `web/pages/Schedule.tsx`
- Modify: `web/App.tsx`, `web/styles.css`
- Test: `tests/server/adminApi.test.ts`, `tests/web/dashboard.test.tsx`, `tests/web/schedule.test.tsx`, `tests/web/channelEditor.test.tsx`

**Interfaces:**
- Produces: REST resources below `/api/v1/channels`, `/api/v1/media`, `/api/v1/pools`, and `/api/v1/schedules`
- Produces: `GET /api/v1/channels/:id/air -> { nowPlaying, upNext, scheduleStatus }`
- Produces: UI routes `/`, `/channel`, `/library`, `/schedule`, `/tunarr`

- [ ] **Step 1: Write failing API and UI behavior tests**

```ts
test('returns Now Playing and Up Next for an injected clock', async () => {
  const app = await buildApp({ dataDir, now: () => DateTime.fromISO('2026-09-13T18:12:00-05:00').toJSDate() });
  const response = await app.inject({ method: 'GET', url: '/api/v1/channels/marktv-laughs/air' });
  expect(response.json()).toMatchObject({ nowPlaying: { title: expect.any(String) }, upNext: { title: expect.any(String) } });
});
```

```tsx
test('shows preview-only status and current programming', async () => {
  render(<Dashboard api={fakeApi} />);
  expect(await screen.findByText('Preview only')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Now Playing' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Up Next' })).toBeVisible();
});
```

- [ ] **Step 2: Run focused tests and confirm routes/pages are missing**

Run: `npm test -- tests/server/adminApi.test.ts tests/web/dashboard.test.tsx tests/web/schedule.test.tsx tests/web/channelEditor.test.tsx`

Expected: FAIL with missing handlers and page modules.

- [ ] **Step 3: Implement validated CRUD, generation endpoints, and accessible responsive pages**

Use semantic forms, labeled inputs, visible focus, keyboard-operable navigation, inline field-path errors, and a single-column layout below 760px. The dashboard must lead with the channel name, current clock, Now Playing, Up Next, and schedule status. The schedule page must show local start/end, item type, title, source daypart/slot, and diagnostics. Use plain React state and `fetch`; do not add Redux or a component framework.

- [ ] **Step 4: Run API/UI tests, lint, and production build**

Run: `npm test -- tests/server/adminApi.test.ts tests/web && npm run lint && npm run build`

Expected: all focused tests pass, lint exits zero, and both UI/server build successfully.

- [ ] **Step 5: Commit the admin experience**

```bash
git add src/server web tests/server tests/web
git commit -m "feat: manage and preview MarkTV programming"
```

### Task 7: Tunarr Detection, Dry Run, and Guarded Sync

**Files:**
- Create: `src/integrations/tunarr/types.ts`, `src/integrations/tunarr/client.ts`, `src/integrations/tunarr/plan.ts`, `src/integrations/tunarr/sync.ts`
- Create: `src/server/routes/tunarr.ts`, `web/pages/Tunarr.tsx`
- Modify: `src/server/app.ts`, `web/App.tsx`, `web/api.ts`
- Test: `tests/integrations/tunarrClient.test.ts`, `tests/integrations/tunarrPlan.test.ts`, `tests/integrations/tunarrSync.test.ts`, `tests/web/tunarr.test.tsx`

**Interfaces:**
- Produces: `TunarrClient.detect(): Promise<TunarrCapabilities>`
- Produces: `buildTunarrSyncPlan(schedule, inventory, capabilities): TunarrSyncPlan`
- Produces: `syncTunarrPlan(client, freshPlan): Promise<TunarrSyncResult>`
- Produces: `POST /api/v1/tunarr/test`, `/dry-run`, and `/sync`

- [ ] **Step 1: Inspect the current official Tunarr OpenAPI document and save only hand-written compatibility schemas**

Use <https://tunarr.com/api-docs.html> and the current official repository to confirm version, channels, library-program search, channel programming, filler-list, and scheduling payloads. Do not vendor a generated client or copy Tunarr server code. Record the supported response fields as narrow Zod schemas in `types.ts`; tolerate unknown response fields.

- [ ] **Step 2: Write failing fake-server contract tests**

```ts
test('blocks mutation when duplicate normalized paths make a match ambiguous', () => {
  const plan = buildTunarrSyncPlan(schedule, inventoryWithDuplicatePath, capabilities);
  expect(plan.blockingErrors).toContainEqual(expect.objectContaining({ code: 'AMBIGUOUS_MEDIA_PATH' }));
  expect(plan.syncEligible).toBe(false);
});

test('requires a fresh dry-run fingerprint before sync', async () => {
  await expect(syncTunarrPlan(client, stalePlan)).rejects.toMatchObject({ code: 'STALE_DRY_RUN' });
  expect(fakeTunarr.mutations).toHaveLength(0);
});
```

Cover supported detection, unreachable service, unexpected schema, path normalization, unmatched placeholders, create/update distinction, partial HTTP failure, and exact ordered programming payload.

- [ ] **Step 3: Run contract tests and confirm integration modules are missing**

Run: `npm test -- tests/integrations`

Expected: FAIL with unresolved Tunarr modules.

- [ ] **Step 4: Implement the narrow version-aware adapter and explicit sync flow**

Normalize paths with `realpath` where possible and exact case-sensitive comparison; never basename-match. Dry-run fingerprint must hash Tunarr URL, detected version, channel snapshot, inventory snapshot, and MarkTV schedule revision. Sync must redetect/version-check, reject expired or changed plans, execute operations in declared order, stop after the first failure, and return completed operations without rolling back or hiding partial state. The UI must show connection state, version, matched/unmatched counts, warnings, blocking errors, and operation list; Sync remains disabled until the latest dry run is eligible.

- [ ] **Step 5: Run integration/UI tests and full build**

Run: `npm test -- tests/integrations tests/web/tunarr.test.tsx && npm run build`

Expected: all integration and Tunarr UI tests pass; no test contacts a real Tunarr instance.

- [ ] **Step 6: Commit the Tunarr boundary**

```bash
git add src/integrations src/server/routes/tunarr.ts src/server/app.ts web tests/integrations tests/web/tunarr.test.tsx
git commit -m "feat: preview and sync programming to Tunarr"
```

### Task 8: Documentation and Real Local Verification

**Files:**
- Create: `README.md`, `docs/INSTALL.md`, `docs/CONFIGURATION.md`, `docs/TUNARR.md`
- Create: `tests/browser/smoke.spec.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Produces: documented `npm install`, `npm run build`, `npm start`, and `npm run dev` workflows
- Produces: Playwright smoke covering production UI, seeded channel, Now Playing/Up Next, and schedule page

- [ ] **Step 1: Write the failing production browser smoke test**

```ts
test('loads the seeded MarkTV dashboard and schedule without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'MarkTV' })).toBeVisible();
  await expect(page.getByText('MarkTV Laughs')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Now Playing' })).toBeVisible();
  await page.getByRole('link', { name: 'Schedule' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run the smoke test against the current production command and confirm missing final wiring or documentation-related startup behavior**

Run: `npm run build && npm run test:browser`

Expected: FAIL until Playwright web-server configuration, production static serving, and automatic demo initialization are connected.

- [ ] **Step 3: Finish production static serving, temporary-data test configuration, and user documentation**

Document Node 22+, optional Homebrew FFmpeg for `ffprobe`, exact first-run commands, default URL `http://127.0.0.1:4177`, `MARKTV_DATA_DIR`, `MARKTV_HOST`, `MARKTV_PORT`, folder scanning, manual duration repair, pool/rule editing, deterministic generation, preview-only placeholders, dry run, explicit sync, API mismatch recovery, backup of the data directory, and the no-transcoding boundary. Configure Playwright to build, start MarkTV with a temporary data directory, and wait on `/api/v1/health`.

- [ ] **Step 4: Run the complete fresh verification gate**

Run: `npm test && npm run lint && npm run build && npm run test:browser`

Expected: all unit/integration/component tests pass, lint exits zero, build exits zero, and the browser smoke passes without console or page errors.

- [ ] **Step 5: Verify restart persistence with a temporary data directory**

Start MarkTV with `MARKTV_DATA_DIR` set to a newly created temporary directory, call the health endpoint, generate the demo schedule through `/api/v1/schedules/generate`, stop the process, restart with the same directory, and fetch the latest schedule. Confirm the schedule ID and entry count are identical after restart. Remove only that explicitly created temporary directory after the check.

- [ ] **Step 6: Review the final diff and requirement coverage**

Check every success criterion in the approved spec against a test, browser observation, documentation section, or explicit limitation. Inspect `git diff --check`, `git status --short`, generated-data exclusions, and ensure no remote exists with `git remote -v`.

- [ ] **Step 7: Commit the verified local MVP**

```bash
git add README.md docs package.json .gitignore playwright.config.ts tests/browser src/server
git commit -m "docs: complete local MarkTV MVP setup"
```

## Final Acceptance Evidence

The implementation handoff must report:

- The final local commit and clean/dirty status, including the intentionally untracked project `AGENTS.md` if it remains outside product history.
- Exact test, lint, build, and browser-smoke counts/results from the fresh final run.
- The local URL and commands used to start MarkTV.
- The temporary-data restart result.
- Whether a real Tunarr instance was available; fake-server contract tests are required regardless, and absence of a real instance must be stated rather than guessed around.
- Any installed-browser or optional-`ffprobe` limitation.
- Confirmation that no Git remote, push, publication, or deployment occurred.
