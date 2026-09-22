# MarkTV Cult Movies Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real daily MarkTV Cult Movies channel 9 whose shuffled movie lineup is sourced only from the external Cult folder, uses the existing commercial pool, and syncs independently from the existing channels.

**Architecture:** Keep the current deterministic scheduler and Tunarr plan/apply guard. Add a backwards-compatible per-MarkTV-channel mapping store so automatic refresh can sync each channel independently. Reserve the Cult root through a disabled movie-programming scope block, make nested-root enrollment prefer the narrower root, then activate channel 9 through the existing APIs without restarting Tunarr.

**Tech Stack:** TypeScript, Fastify, Zod, SQLite JSON documents, Luxon, Vitest, Tunarr 1.3.15, Node 22, local HTTP APIs.

**Spec:** `docs/superpowers/specs/2026-09-21-marktv-cult-movies-channel-design.md`

## Global Constraints

- Cult media source is exactly `/Volumes/SSK Drive /MarkTV/Movies/Cult`, including the volume's trailing space.
- The new `cult-movies` pool contains only playable media whose paths are inside the Cult root.
- The existing `movies` pool remains at its current 29 top-level movie members.
- Channel 9 uses only `cult-movies` for movie content and only the shared `ads` pool for interstitial breaks.
- Existing MarkTV channels 7 and 8 must not be rewritten by channel-9 activation.
- Legacy singleton Tunarr mapping data must remain readable, and channel 7's mapping must remain intact.
- Schedule reads and syncs target the channel-local current date and the captured schedule ID, never insertion-order newest.
- Tunarr restart or bundle rebuild is out of scope; an active viewer blocks an existing-channel lineup mutation.
- No media files are moved, renamed, copied, deleted, or re-encoded.

## Review Focus

- Legacy `tunarr-mapping` data with no new mapping document must still sync channel 7; test migration and read compatibility in Task 1.
- Two stored mappings must retain separate plans, channel IDs, and `lastSync` values; test channel-specific persistence and routing in Tasks 1-3.
- A nested Cult root must win over the broad Movies root even when the Cult channel's special movie-programming scheduler is disabled; test strict path containment and broad-pool exclusion in Task 4.
- A missing, unavailable, or unresolved Cult file must block activation before Tunarr mutation; test the generated schedule/catalog/Tunarr gate in Task 5.
- An active Tunarr viewer must prevent replacement of the mapped lineup without changing either channel's stored state; test the existing guard for a channel-9 mapping in Task 3 and live-check sessions in Task 5.

## File Map

- Modify `src/server/tunarrAutoSync.ts`: per-channel mapping read, migration, upsert, and automatic sync persistence.
- Modify `src/server/routes/tunarr.ts`: channel-specific status, dry-run storage, and sync selection while preserving the current channel-7 API behavior.
- Modify `src/server/scheduleRefresh.ts` and `src/server/app.ts`: pass the channel ID when reading sync state.
- Modify `src/media/movieEnrollment.ts`: compute configured nested roots and exclude narrower-root media from broader movie enrollment.
- Modify `docs/MOVIE_PROGRAMMING.md`: document the disabled scope block used to reserve a nested movie root without enabling the special scheduler.
- Modify `tests/server/tunarrAutoSync.test.ts`, `tests/server/tunarrRoutes.test.ts`, and `tests/server/scheduleRefresh.test.ts`: pin mapping compatibility, route isolation, and multi-channel refresh behavior.
- Modify `tests/media/movieEnrollment.test.ts`: pin nested-root ownership and preserve existing-pool behavior.
- Create `tests/server/cultMoviesChannel.test.ts`: validate the production-shaped channel document and generated all-day schedule against Cult-only media and `ads` breaks.
- Live state, not repository source: register `/Movies/Cult`, scan it, populate `cult-movies`, create MarkTV channel 9, scan Tunarr's Movies library, dry-run, sync, and verify.

### Task 1: Add backwards-compatible per-channel Tunarr mapping storage

**Files:**
- Modify: `src/server/tunarrAutoSync.ts`
- Test: `tests/server/tunarrAutoSync.test.ts`

**Interfaces:**
- Consume the existing `StoredTunarrMapping` shape and legacy setting key `tunarr-mapping`.
- Produce `TUNARR_MAPPINGS_SETTING = "tunarr-mappings"`, `readTunarrMappings(repositories): StoredTunarrMapping[]`, `readTunarrMappingForChannel(repositories, marktvChannelId): StoredTunarrMapping | undefined`, and `upsertTunarrMapping(repositories, mapping): void`.
- Keep `readTunarrMapping(repositories): StoredTunarrMapping | undefined` as a compatibility helper for existing single-mapping callers and tests; new channel-aware callers use `readTunarrMappingForChannel`.

- [ ] **Step 1: Write failing mapping-store tests**

Add tests that store one legacy value under `TUNARR_MAPPING_SETTING`, assert `readTunarrMappings` returns it, then upsert a second channel and assert both mappings are available independently. Add a test that upserting channel 9 does not change channel 7's `channelId`, `plan`, or `lastSync`.

```ts
const laughMapping = { ...baseMapping, marktvChannelId: "marktv-laughs", channelId: "tunarr-7" };
const cultMapping = { ...baseMapping, marktvChannelId: "marktv-cult-movies", channelId: "tunarr-9" };
repositories.settings.put(TUNARR_MAPPING_SETTING, laughMapping);

expect(readTunarrMappingForChannel(repositories, "marktv-laughs")).toMatchObject({
  channelId: "tunarr-7",
});
upsertTunarrMapping(repositories, cultMapping);
expect(readTunarrMappings(repositories)).toEqual(
  expect.arrayContaining([laughMapping, cultMapping]),
);
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run: `npx vitest run tests/server/tunarrAutoSync.test.ts`

Expected: FAIL because the channel-aware reader, mapping collection, and upsert helper do not exist yet.

- [ ] **Step 3: Implement the mapping collection and legacy migration**

Store the new value as a JSON object keyed by `marktvChannelId` under `TUNARR_MAPPINGS_SETTING`. `readTunarrMappings` must first parse the new collection when present; otherwise it must read the legacy singleton and return a one-element list. `upsertTunarrMapping` must merge the selected channel into the collection, preserving every other mapping and leaving the legacy document readable. Update `autoSyncTunarr` in the same file to read and persist the mapping for `options.channelId`, rather than treating the one legacy mapping as the only possible target.

```ts
export const TUNARR_MAPPINGS_SETTING = "tunarr-mappings";

export function readTunarrMappingForChannel(
  repositories: Repositories,
  marktvChannelId: string,
): StoredTunarrMapping | undefined {
  return readTunarrMappings(repositories).find(
    (mapping) => mapping.marktvChannelId === marktvChannelId,
  );
}

export function upsertTunarrMapping(
  repositories: Repositories,
  mapping: StoredTunarrMapping,
): void {
  const mappings = readTunarrMappings(repositories).filter(
    (candidate) => candidate.marktvChannelId !== mapping.marktvChannelId,
  );
  repositories.settings.put({
    id: TUNARR_MAPPINGS_SETTING,
    value: Object.fromEntries(
      [...mappings, mapping].map((candidate) => [candidate.marktvChannelId, candidate]),
    ),
  });
}
```

The production implementation must preserve any fields not replaced by a dry run, including `autoSync`, `fillerListId`, `transcodeConfigId`, `lastSync`, and an existing pending `plan` when another channel is updated.

- [ ] **Step 4: Run the focused mapping tests**

Run: `npx vitest run tests/server/tunarrAutoSync.test.ts`

Expected: PASS, including the existing blocked, failed, active-viewer, rescan, and legacy tests.

- [ ] **Step 5: Commit the storage boundary**

```bash
git add src/server/tunarrAutoSync.ts tests/server/tunarrAutoSync.test.ts
git commit -m "fix: store Tunarr mappings per channel"
```

### Task 2: Route dry runs and manual syncs to the selected channel

**Files:**
- Modify: `src/server/routes/tunarr.ts`
- Test: `tests/server/tunarrRoutes.test.ts`

**Interfaces:**
- Consume `readTunarrMappingForChannel`, `readTunarrMappings`, and `upsertTunarrMapping` from Task 1.
- Produce a status response that can project one mapping by `marktvChannelId` while keeping the current channel-7 top-level fields; dry-run and sync must never write or consume another channel's plan.

- [ ] **Step 1: Add failing route tests for independent plans**

Create two MarkTV channels and dated schedules in the route fixture. Run a dry run for `marktv-cult-movies` with `createChannel: true`, then assert the stored channel-7 mapping remains unchanged. Add a sync request with `{ "marktvChannelId": "marktv-cult-movies" }` and assert the programming call targets the Cult mapping's resolved Tunarr channel, not channel 7. Add a status assertion for `GET /api/v1/tunarr/status?marktvChannelId=marktv-cult-movies`.

```ts
const dryRun = await app.inject({
  method: "POST",
  url: "/api/v1/tunarr/dry-run",
  payload: {
    url: "http://fake",
    marktvChannelId: "marktv-cult-movies",
    libraryIds: ["lib-movies"],
    createChannel: true,
    transcodeConfigId: TRANSCODE_CONFIG_ID,
  },
});
expect(dryRun.statusCode).toBe(200);

const sync = await app.inject({
  method: "POST",
  url: "/api/v1/tunarr/sync",
  payload: { marktvChannelId: "marktv-cult-movies" },
});
expect(sync.statusCode).toBe(200);
expect(postedChannelIds).toContain("created-channel");
```

- [ ] **Step 2: Run the route tests and confirm the new assertions fail**

Run: `npx vitest run tests/server/tunarrRoutes.test.ts`

Expected: FAIL because the sync route still reads the singleton setting and the status route cannot select channel 9.

- [ ] **Step 3: Implement channel-aware route selection**

Keep the current dry-run payload, including its existing default of `marktv-laughs`, but store the completed mapping through `upsertTunarrMapping`. Add an optional `marktvChannelId` to the sync body. When omitted, select the legacy/default channel-7 mapping to preserve the existing UI workflow; when supplied, select that mapping only. Return `STALE_DRY_RUN` when the selected mapping has no plan. Make status return the selected mapping projection and include a `mappings` array when no selector is supplied, without removing the current top-level fields used by the existing page.

Before applying a sync, resolve the schedule by `stored.marktvChannelId` and the captured `stored.plan.scheduleSnapshot.id`, exactly as the existing route does. After the sync, upsert only the selected mapping so a channel-9 sync cannot erase channel 7's pending plan or last-sync state.

- [ ] **Step 4: Run the route tests and the existing Tunarr integration tests**

Run: `npx vitest run tests/server/tunarrRoutes.test.ts tests/integrations/tunarrPlan.test.ts tests/integrations/tunarrSync.test.ts`

Expected: PASS with the new channel-selection tests and all existing stale-dry-run, current-date, active-viewer, and partial-failure tests.

- [ ] **Step 5: Commit the route boundary**

```bash
git add src/server/routes/tunarr.ts tests/server/tunarrRoutes.test.ts
git commit -m "fix: route Tunarr plans by MarkTV channel"
```

### Task 3: Make automatic refresh multi-channel aware

**Files:**
- Modify: `src/server/scheduleRefresh.ts`
- Modify: `src/server/app.ts`
- Test: `tests/server/scheduleRefresh.test.ts`
- Test: `tests/server/tunarrAutoSync.test.ts`

**Interfaces:**
- Consume `readTunarrMappingForChannel` and the channel-aware `autoSyncTunarr` from Task 1.
- Produce `ScheduleRefreshDependencies.lastSync(channelId: string)` and ensure every refresh iteration compares and records sync state for the channel currently being processed.

- [ ] **Step 1: Add failing refresh tests for two channels**

Extend the refresh fixture to return two channels with separate current schedules and make `lastSync` return a synced result only for channel 7. Assert the refresh does not sync channel 7 and does sync channel 9 with channel 9's schedule ID. Add an assertion that the `lastSync` mock receives each channel ID.

```ts
expect(lastSync).toHaveBeenCalledWith("marktv-laughs");
expect(lastSync).toHaveBeenCalledWith("marktv-cult-movies");
expect(syncToTunarr).toHaveBeenCalledWith(
  "marktv-cult-movies",
  "marktv-cult-movies-2026-09-21",
  expect.any(Function),
);
```

- [ ] **Step 2: Run the refresh tests and confirm the new assertions fail**

Run: `npx vitest run tests/server/scheduleRefresh.test.ts`

Expected: FAIL because `lastSync` currently has no channel argument and the app-level dependency reads one global mapping.

- [ ] **Step 3: Implement channel-specific refresh state**

Change the dependency type and call site from `lastSync()` to `lastSync(channel.id)`. In `buildApp`, pass a reader that returns `readTunarrMappingForChannel(repositories, channelId)?.lastSync`. Keep the single-flight guard, date-aware schedule lookup, quiet-hours generation, and active-viewer handling unchanged. Do not let a failed channel-9 refresh change the stored result for channel 7.

- [ ] **Step 4: Run the refresh and auto-sync tests**

Run: `npx vitest run tests/server/scheduleRefresh.test.ts tests/server/tunarrAutoSync.test.ts`

Expected: PASS, including current-date generation, tomorrow pre-generation, failed-sync retry, overlapping-pass protection, legacy mapping behavior, and independent channel outcomes.

- [ ] **Step 5: Commit the automatic-refresh change**

```bash
git add src/server/scheduleRefresh.ts src/server/app.ts tests/server/scheduleRefresh.test.ts tests/server/tunarrAutoSync.test.ts
git commit -m "fix: refresh Tunarr channels independently"
```

### Task 4: Enforce Cult-root ownership and validate the channel shape

**Files:**
- Modify: `src/media/movieEnrollment.ts`
- Modify: `docs/MOVIE_PROGRAMMING.md`
- Test: `tests/media/movieEnrollment.test.ts`
- Create: `tests/server/cultMoviesChannel.test.ts`

**Interfaces:**
- Consume the existing `withinMovieRoot`, `eligibleMovieMediaIds`, `ensureMovieProgrammingPool`, and repository channel list.
- Produce path filtering in which a configured strict child root is excluded from a broader root's enrollment, even when the child channel has `movieProgramming.enabled === false`.

- [ ] **Step 1: Add failing nested-root and channel-shape tests**

Add a broad channel rooted at `/Volumes/SSK Drive /MarkTV/Movies` and a disabled scope channel rooted at `/Volumes/SSK Drive /MarkTV/Movies/Cult`. Put one top-level movie and two Cult movies in the catalog. Assert the broad pool receives only the top-level movie and that the Cult IDs remain available for the dedicated pool. Add a production-shaped channel fixture with an all-day daypart, the sole `cult-movies` movie slot, `ads` as its only break pool, and the disabled scope block.

```ts
expect(eligibleMovieMediaIds(items, ROOT, [`${ROOT}/Cult`])).toEqual([
  "top-level-movie",
]);
expect(cultChannel.movieProgramming).toMatchObject({
  enabled: false,
  poolIds: ["cult-movies"],
  rootPath: `${ROOT}/Cult`,
});
```

- [ ] **Step 2: Run the enrollment and channel tests and confirm the new assertions fail**

Run: `npx vitest run tests/media/movieEnrollment.test.ts tests/server/cultMoviesChannel.test.ts`

Expected: FAIL because the eligibility helper has no exclusion-root argument and no test fixture yet covers the channel-9 shape.

- [ ] **Step 3: Implement strict nested-root exclusion**

Add an optional `excludedRootPaths` argument to `eligibleMovieMediaIds`. In `reconcileMovieProgramming`, collect every channel's configured `movieProgramming.rootPath`, including disabled scope blocks, and for each enabled channel pass the strict child roots below its own root as exclusions. Keep the existing union/no-prune behavior: an unavailable or unmounted root must not remove stored pool members. Do not change media records or ordinary pool routes.

```ts
const configuredRoots = repositories.channels
  .list()
  .map((channel) => channel.movieProgramming?.rootPath)
  .filter((root): root is string => Boolean(root));

const exclusions = configuredRoots.filter(
  (candidate) =>
    candidate !== channel.movieProgramming?.rootPath &&
    withinMovieRoot(channel.movieProgramming?.rootPath, candidate),
);
```

Use normalized path-boundary checks rather than raw string prefixes, so `Movies 2` cannot be mistaken for a child of `Movies`.

- [ ] **Step 4: Document the disabled scope block**

Add a short section to `docs/MOVIE_PROGRAMMING.md` explaining that a channel may carry `enabled: false`, `poolIds`, and `rootPath` solely to reserve a nested movie root for pool isolation; the special nightly/weekend scheduler remains off until `enabled` is true.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/media/movieEnrollment.test.ts tests/server/cultMoviesChannel.test.ts tests/scheduler/generate.test.ts`

Expected: PASS, with the existing root-membership, no-prune, and movie scheduling tests unchanged.

- [ ] **Step 6: Commit root isolation and channel validation**

```bash
git add src/media/movieEnrollment.ts docs/MOVIE_PROGRAMMING.md tests/media/movieEnrollment.test.ts tests/server/cultMoviesChannel.test.ts
git commit -m "feat: isolate nested movie roots for channels"
```

### Task 5: Run application verification and activate channel 9 safely

**Files:**
- No additional repository files; this task changes live MarkTV/Tunarr state through the existing APIs.
- Verification evidence: live API responses, generated schedule, Tunarr inventory, and post-sync channel/mapping checks.

**Interfaces:**
- Consume the production build from Tasks 1-4, MarkTV at `http://127.0.0.1:4177`, Tunarr at `http://127.0.0.1:8000`, and the external volume path from the spec.
- Produce an active MarkTV channel 9, a Tunarr channel 9 mapping, a current-date schedule, and independent daily refresh state.

- [ ] **Step 1: Run repository-level validation before touching live configuration**

Run:

```bash
npm run typecheck
npm run lint
npx vitest run tests/server/tunarrAutoSync.test.ts tests/server/tunarrRoutes.test.ts tests/server/scheduleRefresh.test.ts tests/media/movieEnrollment.test.ts tests/server/cultMoviesChannel.test.ts
npm test
git diff --check
```

Expected: typecheck, lint, and the focused tests exit successfully; `npm test` is run once to detect regressions and its complete exit status is recorded, including any known unrelated failure. `git diff --check` emits no whitespace errors. Record pre-existing lint warnings or unrelated full-suite failures separately from changed-line failures.

- [ ] **Step 2: Build and restart only MarkTV's application service**

Run `npm run build`, then restart the existing `com.marktv.server` service using its current launchd mechanism. Do not restart `com.marktv.tunarr-patched`. Verify:

```bash
curl -fsS http://127.0.0.1:4177/api/v1/health
curl -fsS http://127.0.0.1:8000/api/sessions
curl -fsS http://127.0.0.1:8000/api/version
```

Expected: MarkTV health is `ok`, Tunarr reports no active sessions before any existing-channel mutation, and Tunarr remains on 1.3.15.

- [ ] **Step 3: Register the Cult root and create the empty dedicated pool/channel**

Before activation, read and record the current MarkTV channel list, `movies` pool member count, Tunarr channel list, and channel-7 mapping. Then call the existing APIs in this order:

```http
POST /api/v1/pools
{
  "id": "cult-movies",
  "name": "Cult Movies",
  "kinds": ["movie"],
  "mediaIds": [],
  "mode": "shuffle",
  "noRepeatMinutes": 1440,
  "weight": 1
}
```

If `cult-movies` already exists from a partial attempt, do not create a second pool: read it, verify its kind/settings, and update it in place only after confirming its current members are not used by an existing channel.

Create MarkTV channel `marktv-cult-movies` with number 9, the all-day `00:00` to `00:00` daypart, the sole `cult-movies` movie slot, `breakPolicy.poolIds: ["ads"]`, and the disabled Cult scope block described in the spec. Then register `/Volumes/SSK Drive /MarkTV/Movies/Cult` as a media root and scan that root.

Expected: the scan discovers 20 playable Cult movie records; the existing `movies` pool remains at 29 members because its broader root excludes the configured Cult child root.

- [ ] **Step 4: Populate and validate `cult-movies` without admitting other files**

Read `/api/v1/media`, select only records whose paths satisfy the exact Cult root boundary, and PUT `/api/v1/pools/cult-movies` with those IDs and the existing shuffle/no-repeat settings. Verify:

```text
count(cult-movies.mediaIds) == 20
every cult-movies media path starts with "/Volumes/SSK Drive /MarkTV/Movies/Cult/"
count(movies.mediaIds) == 29
intersection(cult-movies.mediaIds, movies.mediaIds) == empty
```

If any Cult item has a missing duration or unavailable state, stop before generating or syncing and report the exact item(s).

- [ ] **Step 5: Scan Tunarr's existing Movies library and verify exact inventory**

Request a scan for media source `aa6f06cf-e150-4bf9-b91a-e247385453b0` and library `a971f806-81fb-4756-bfa6-e5a55bb89388`. Wait for the scan status to settle, then query the library programs. Verify that all 20 Cult paths resolve with a playable `state` and that the existing 29 movie paths remain present.

- [ ] **Step 6: Generate channel 9's current schedule and dry-run the new Tunarr mapping**

Generate the channel-local current date:

```http
POST /api/v1/schedules/generate
{
  "channelId": "marktv-cult-movies"
}
```

The first response may report Tunarr as skipped because the new mapping is not configured yet; retain the generated schedule. Then dry-run with the existing three library IDs and the verified Default transcode configuration `3725b1ad-99bb-4072-ae37-58f02a8b26ac`:

```http
POST /api/v1/tunarr/dry-run
{
  "url": "http://127.0.0.1:8000",
  "marktvChannelId": "marktv-cult-movies",
  "libraryIds": [
    "b6be27ac-7c23-40f4-9839-c368879b8d23",
    "103d1831-b9cf-4fea-b83a-87cfdcbefd34",
    "a971f806-81fb-4756-bfa6-e5a55bb89388"
  ],
  "createChannel": true,
  "transcodeConfigId": "3725b1ad-99bb-4072-ae37-58f02a8b26ac"
}
```

Expected: the plan is eligible, all scheduled Cult movie paths and `ads` entries match Tunarr inventory, and no `UNUSABLE_MEDIA_STATE`, unmatched-path, or duration mismatch blocker is present.

- [ ] **Step 7: Sync only channel 9 and verify independent daily state**

Before sync, check `/api/sessions` again. If any session is present for the new or existing mapped channel, stop and preserve the current lineups. Otherwise call:

```http
POST /api/v1/tunarr/sync
{"marktvChannelId":"marktv-cult-movies"}
```

Verify the result completes channel creation, filler-list update/create, and programming. Then check MarkTV channel 7's mapping and last-sync state, the new channel-9 mapping, Tunarr's channel list, the current-date schedule, and the exact scheduled-path partition. Confirm no Tunarr restart occurred.

- [ ] **Step 8: Run the post-activation checks**

Run:

```bash
curl -fsS http://127.0.0.1:4177/api/v1/channels
curl -fsS 'http://127.0.0.1:4177/api/v1/schedules/latest?channelId=marktv-cult-movies'
curl -fsS 'http://127.0.0.1:4177/api/v1/tunarr/status?marktvChannelId=marktv-laughs'
curl -fsS 'http://127.0.0.1:4177/api/v1/tunarr/status?marktvChannelId=marktv-cult-movies'
curl -fsS http://127.0.0.1:8000/api/channels
curl -fsS http://127.0.0.1:8000/api/sessions
```

Expected: MarkTV lists channels 7 and 9, Tunarr lists the original channels plus channel 9, channel 7's mapping and schedule are unchanged, channel 9 has a synced current-date schedule, and no active viewer was interrupted. Report real-client playback separately if a client is available; do not call a short API/playlist check sustained playback proof.

- [ ] **Step 9: Commit the final source changes and record the live handoff**

After inspecting the complete diff and verification output:

```bash
git status --short
git diff --check
git add src/server/tunarrAutoSync.ts src/server/routes/tunarr.ts src/server/scheduleRefresh.ts src/server/app.ts src/media/movieEnrollment.ts docs/MOVIE_PROGRAMMING.md tests/server/tunarrAutoSync.test.ts tests/server/tunarrRoutes.test.ts tests/server/scheduleRefresh.test.ts tests/media/movieEnrollment.test.ts tests/server/cultMoviesChannel.test.ts
git commit -m "feat: add daily MarkTV cult movies channel"
```

Report the final local commit, live MarkTV/Tunarr channel IDs, Cult count, existing-pool count, schedule ID, sync result, and any real-client playback evidence separately.

## Verification Matrix

| Requirement | Evidence |
|---|---|
| Cult-only source | 20 scanned media records and every channel-9 movie path under `/Movies/Cult` |
| Existing pool isolation | `movies` remains 29 and has no Cult IDs |
| Shuffled daily stream | Channel-9 pool is `shuffle`, `noRepeatMinutes: 1440`, all-day movie slot |
| Shared commercials | Channel-9 break policy is exactly `ads` |
| Daily automation | Channel-9 mapping has its own `lastSync`, and refresh tests cover independent routing |
| Safe Tunarr mutation | `/api/sessions` checked before sync; dry-run eligible; no Tunarr restart |
| Existing-channel safety | Channel 7 mapping, channel list, and current-date schedule rechecked after activation |
