# HANDOFF — movie-day continuity: fix landed, one policy decision open

Written 2026-09-23 by the mixed-model session (DeepSeek root, with Muse review workers).
Reader: a GPT/Codex reviewer with this repository. Two parts: **§2 is done and deployed — review
it, do not redo it.** **§5 is an open decision — make it, implement it, and finalize.**

"Finalize" means: pick an option, implement it, run the verification in §8, deploy it if it
changes behaviour, and record the outcome in this file. You are authorised to edit, commit,
build and deploy for this work. Do not leave it as a recommendation.

---

## 1. System map (verified by direct inspection, 2026-09-23)

| Thing | Where |
|---|---|
| MarkTV app | `127.0.0.1:4177`, launchd `com.marktv.server`, cwd = this repo |
| App data | `data/marktv.sqlite` (channels, pools and settings are `documents` rows) |
| Tunarr (downstream) | `127.0.0.1:8000`, source `~/tunarr-fork`, lineups in `~/Library/Preferences/tunarr/channel-lineups/<uuid>.json` |
| Channels | 7 `marktv-laughs`, 8 `marktv-movies`, 9 `marktv-cult-movies` |
| Key source | `src/server/scheduleRefresh.ts`, `src/server/scheduleService.ts`, `src/scheduler/generate.ts`, `src/scheduler/preservedLineup.ts` |
| Relevant docs | `docs/PRESERVED-LINEUP.md`, `docs/MOVIE_PROGRAMMING.md`, `docs/CONTINUITY.md` |

How the three channels differ mechanically — this matters for everything below:

| | ch7 Laughs | ch8 Movies | ch9 Cult Movies |
|---|---|---|---|
| mechanism | `movieProgramming` **enabled** (nightly 02:00) + 10 episode pools | **preserved imported lineup** (`preservedLineup: {sourceId: marktv-movies-original-20260922, cycle: repeat}`) | **pool slot** `kind: movie`, `poolIds: ["cult-movies"]` |
| revision | `episode-midrolls-1` | `preserved-1` | `cult-movies-1` |
| selection stable per date? | **yes** — documented as a persisted rotation | n/a (sliced from an immutable archive) | **no** — see §4 |
| films | 10 sitcom pools | 29, `/MarkTV/Movies/*` | 19, `/MarkTV/Movies/Cult/*` |
| no-repeat | — | 10 080 min (7 d) | 1 440 min (24 h) |

Deploy: `npm run build && launchctl kickstart -k gui/$(id -u)/com.marktv.server`.

---

## 2. What was fixed — commit `8e64216` (DEPLOYED, VERIFIED)

**Symptom.** Channel 9 cut the last film of every day mid-scene and never aired the rest. On
2026-09-23, `Cemetery.Of.Terror` (91.5 min) started 23:20 and aired 40 min.

**Root cause — ordering, not missing code.** The carry feature already exists (commit `7d83479`,
already built and deployed): when a pool movie crosses midnight, `generate.ts` emits it and
records `movieCarry`, with the diagnostic `MOVIE_CONTINUES_NEXT_DAY`; `ScheduleService` reads
the previous date's carry via `slotMovieContinuation()` and passes it into generation. That all
worked. What did not: the quiet-hours pass builds **tomorrow** (03:00) *before* today's own
replacement runs (03:51 on this install), so tomorrow had already been built against a today
that had not yet crossed midnight — and tomorrow is only rebuilt if its *media* is stale. The
carry was written and never claimed.

**Change** (`src/server/scheduleRefresh.ts`): new exported `scheduleMissesPreviousCarry(previous,
next)`; the "build tomorrow" branch now also fires when tomorrow predates today's carry, and
**bypasses the quiet-hours gate** because the carry airs across midnight *tonight* — waiting for
the next quiet window is a day too late.

**Why it cannot become a regeneration loop** (this was the main design risk): the trigger is a
`generatedAt` comparison, not a flag. Once tomorrow is generated after today it is the newer of
the two and the predicate is false permanently — even if that generation decides *not* to carry
the film. A naive "does tomorrow contain the continuation?" test would have caused a rebuild every
ten minutes.

**Evidence.** Log line on the first pass after restart, `23:40:27Z`, and only for ch9:

```
warn schedule.refresh "Rebuilding a schedule that predates today's movie carry"
     channelId=marktv-cult-movies date=2026-09-24
```

Rebuilt `marktv-cult-movies-2026-09-24-a0a0be22` now opens `00:00–00:51` with
**Cemetery of Terror, `sourceOffsetMs` 2 400 000 (40.0 min in), airing its remaining 51 min**,
matching 09-23's own diagnostic exactly ("continues with 3089s left at source offset 2400000ms").
Day still totals exactly 86 400 000 ms.

**Verification run.** `npx vitest run tests/server/scheduleRefresh.test.ts` → 20/20 (3 new);
`npx vitest run` → **91 files, 1014 tests, all pass**; `npx tsc --noEmit` and eslint clean;
change confirmed present in `dist-server/` before restarting; service back on a new pid, API 200.

**Blast radius.** Only a channel that generates movie days from a pool is affected — ch9. ch8
slices an archive and ch7 uses `movieProgramming`; neither exercises this path. Tonight's stored
schedule was not modified; tomorrow is the first day that carries properly.

**Not changed, deliberately:** ch8's `preservedLineup` binding, any pool contents, the 365-day
Tunarr precalculation on ch8, and the continuity director.

---

## 3. Corrections to claims I made earlier — do not inherit these

1. **"The preserved archive is a one-shot migration crutch; its job is finished."** Wrong.
   `docs/PRESERVED-LINEUP.md` describes it as a designed feature: airing a lineup *somebody else
   already programmed*, "whose exact film order and start instants an operator approved". Its own
   example sourceId is `channel-8-movies`. Treat ch8 as deliberate until the owner says otherwise.
2. **"A new film can never enrol."** Overstated. `docs/MOVIE_PROGRAMMING.md:30` — enabling
   movie-programming **enrols the configured pool with every playable movie inside that folder**,
   and a rescan *extends* the rotation ("it never reshuffles what is still to come"). That is
   documented for `movieProgramming` channels (ch7). Whether ch9's **pool slot** refreshes the
   same way is **UNKNOWN** — ch9's `movieProgramming.enabled` is `false`. Confirm before asserting.
3. **The 365-day duration on ch8 is "purely cosmetic".** The value's origin is right (no
   server-side default; `maxDays: 365` comes from the web form constants). But ch8's Tunarr
   mapping is `preserveExistingLineup: true` (`docs/PRESERVED-LINEUP.md` §Setup step 4), so that
   large lineup may be the *imported* lineup the prepared days are spliced into. "Cosmetic" and
   "load-bearing imported artifact" are very different claims. Not verified — check.

---

## 4. Why ch8 and ch9 cannot be compared directly

Five independent differences (see §1 table): mechanism, folder, film count, no-repeat window, and
volume-versus-window (ch9's 19 films ≈ 28.5 h of runtime poured into a 24 h window with a 24 h
no-repeat rule, so a film *must* cross midnight nearly every day; ch8's archive cycles 124
airings with a 7-day rule). Any outcome difference would be unattributable.

**And the substantive finding — ch9's selection is not date-stable.** Six stored generations of
the *same* date (`schedule_generations`, `marktv-cult-movies`, `2026-09-23`):

| generation | generated (UTC) | entries | distinct films |
|---|---|---|---|
| 80 / 88 | 2026-09-22T08:00 | 174 / 184 | 14 |
| 89 | 2026-09-23T05:03 | 179 | 15 |
| 90 | 2026-09-23T05:40 | 376 | 15 |
| 94 | 2026-09-23T08:51 | 110 | 16 |
| 95 | 2026-09-23T08:59 | 91 | 17 |

The **film set itself differs** between generations (gen 89 differs from the final by 6 films),
not merely the interstitials — and entry counts span 91–376. Compare `docs/MOVIE_PROGRAMMING.md:15`,
where the *movieProgramming* rotation is **persisted and date-addressed**: "the movie for a date
and position is a pure function of the date and the stored order — so previews, rescans, restarts
and out-of-order generation reuse the same assignment". The pool-slot path has no such guarantee.
That asymmetry is the most likely root of the churn, and it is a stronger candidate for the *next*
fix than the mechanism comparison the owner asked about.

---

## 5. The decision (this is what you must finalize)

**Question put to me:** should channels 8 and 9 be left mechanically different, to observe which
approach works better?

**My recommendation (judgment, clearly labelled as such):**

- **Keep them different — yes, but not as an experiment.** Neither is currently a clean control,
  and "works better" has no measure. Leaving them different is fine *because it is the status quo
  and both are currently airing*, not because it will teach you anything.
- **Do NOT treat ch8 as a control to be preserved for science.** Per §3.1 it is a deliberate
  product choice; preserve or unfreeze it on that basis.
- **The next real work item is ch9's churn (§4), not the mechanism comparison.** A day whose film
  set changes four times before it airs makes the guide unreliable and interacts directly with the
  fix in §2 (see §6). Fix the churn by giving the pool-slot path the date-stable assignment the
  movieProgramming path already has.

**Options, each with acceptance criteria:**

- **A (recommended).** Leave the mechanisms as they are; fix churn — make pool-slot selection
  date-stable (persist a per-channel bag/assignment keyed by `(channel, date, position)`, as
  `MOVIE_PROGRAMMING.md` describes). *Accept when:* regenerating the same date twice yields an
  identical film set and identical start instants; 1 014 existing tests still pass.
- **B.** Decide ch8 explicitly: either unfreeze it (point it at generation over its pool) or keep
  it preserved. *Accept when:* the decision and its reason are written here, and if unfrozen,
  ch8's next day's film set tracks `/MarkTV/Movies/*` including a newly added file.
- **C.** Keep them different *as a measured comparison*. Only legitimate if, before starting, this
  file records: the metric, the observation window, and the pass/fail threshold. Suggested
  metrics: mid-film cuts per week, distinct films per rolling 7 days, flex/dead-air minutes,
  generations decided per date (§4), guide-versus-aired drift, latency from file-on-disk to first
  airing. *Accept when:* the pre-registered numbers are computed from stored schedules, not from
  impressions.

Whichever you choose: **do not run C and B1 at once** — unfreezing ch8 while measuring destroys
the comparison.

---

## 6. Known interaction between the §2 fix and the §4 churn

The fix rebuilds tomorrow once per *today-generation*. If today keeps being regenerated with a
different last film, tomorrow can be rebuilt each time. That is bounded (never a ten-minute loop),
but it amplifies churn: fewer generations of today ⇒ fewer rebuilds of tomorrow. This is another
reason option A is the right next step — it removes the amplification at the source.

---

## 7. Open questions only the owner/repo can answer

1. Why was ch8 bound to that archive — is the import it protected still the intent? (git history
   around `fix: preserve created Tunarr channel mappings`, `feat: isolate nested movie roots for
   channels`.)
2. Does anything re-capture `preserved-lineup:marktv-movies-original-20260922`? The archive is
   described as immutable; no re-import path was found.
3. Does ch9's pool slot refresh its membership from `/MarkTV/Movies/Cult`, or is the 19-entry
   `mediaIds` list static? (§3.2.)
4. What triggered the four regenerations of 2026-09-23, and the `breakPolicy.boundaryMinutes`
   change seen between 09-23 (5) and 09-24 (30)? Two config edits happened mid-day.

---

## 8. Verification recipes

```bash
# a specific date's schedule — ALWAYS check several dates; one day proves nothing
curl -s "http://127.0.0.1:4177/api/v1/schedules/latest?channelId=marktv-cult-movies&date=2026-09-24" | python3 -m json.tool | head -40

# carry + continuation + provenance for both movie channels
python3 - <<'PY'
import json, urllib.request
def get(u):
    return json.loads(urllib.request.urlopen(u, timeout=20).read())
for ch in ("marktv-movies", "marktv-cult-movies"):
    for d in ("2026-09-22","2026-09-23","2026-09-24"):
        s = get(f"http://127.0.0.1:4177/api/v1/schedules/latest?channelId={ch}&date={d}")
        if not isinstance(s, dict) or not s.get("id"): print(ch, d, "none"); continue
        cont = sum(1 for e in s.get("entries", []) if e.get("sourceOffsetMs"))
        print(ch, d, s.get("revision"), len(s.get("entries", [])), "cont:", cont,
              "carry:", bool(s.get("movieCarry")),
              [x.get("code") for x in (s.get("diagnostics") or [])])
PY

# anti-loop confirmation for the §2 fix: this must stay at 1 per rebuild event
grep -c "predates today's movie carry" ~/Library/Logs/marktv/server.error.log

# generation churn per date (§4)
sqlite3 "$HOME/.codex/.chatgpt-projects/g-p-6aa767e77a2481919883961c32ae600b/data/marktv.sqlite" \
  "select channel_id, schedule_id, generated_at from schedule_generations order by generation_id desc limit 20;"

# film-file health audit (48/48 clean as of 2026-09-23): /tmp/audit_movies.py
```

Pool membership decode (`documents.type='pool'`, `mediaIds` are `local-<base64 path>`):

```python
base64.b64decode(s + "=" * (-len(s) % 4)).decode()
```

---

## 9. Status of the last open verification — CONFIRMED (2026-09-23 18:52 local)

The §2 anti-loop check has now passed. After the single rebuild at `23:40:27Z`, a full refresh
pass ran at `18:50:27` local (`23:50:27Z`) and produced **no further trigger**:

- `grep -c "predates today's movie carry"` → **1**
- no `schedule.refresh` activity after the `23:40:27Z` pair
- `marktv-cult-movies-2026-09-24-a0a0be22` still `generatedAt 2026-09-23T23:40:27.650Z` — the
  rebuilt day was not touched again
- service still running

So the `generatedAt` guard behaves as designed: rebuild once, then stay quiet. Re-run the greps in
§8 if you change the trigger condition.

## 10. Standing lessons this session paid for

- **Never diagnose a channel from one day.** Channels here store one day at a time; I reported two
  films as "never airing" off a single snapshot and had to retract it. Both had aired the two
  preceding days.
- **Delegated workers cannot run `sqlite3`, `ffprobe`, `ffmpeg` or `curl`** — the allowlist is
  command-shaped (`ls`, `grep`, python3 file reads pass). Three Muse workers returned nothing on a
  media/DB audit for this reason. Keep that work in the parent session.
- **Tunarr's channel config is not the source of truth** for what airs; the app pushes lineups.

## 11. Decision and implementation (2026-09-23)

**Option A chosen.** Channel 8 remains bound to its approved preserved lineup. Channel 9
continues to use its movie pool. This is a product decision, not a controlled comparison.

The ordinary movie-slot generator now reuses film assignments already committed for the same
channel and date. The ordered assignments are stored under
`slot-movie-assignments:<channelId>:<date>` in the existing settings store. For days generated
before this change, the newest stored schedule supplies the initial assignments. If an assigned
film is no longer playable or no longer belongs to an eligible slot pool, normal selection
replaces it. A new film in the catalog does not reshuffle a date already committed. Future
unbuilt dates can select new films normally. The assignment write and schedule write share one
database transaction. This changes only ordinary movie slots, not channel 8's archive, channel
7's movie-programming rotation, Tunarr playback, or the continuity director.

Verification: a new regression test failed before the fix when one film was added, then passed
with identical film IDs and start instants after regeneration; it also checks replacement of an
unavailable assigned film. `npx vitest run` passed 91 files / 1,015 tests, `npm run typecheck`
passed, `npm run build` passed, and `git diff --check` passed. Full lint reported one unrelated
existing unused `basename` import in `scripts/prepare-shared-voiced-channels.ts`.

**Activated 2026-09-23 19:04 local, at the owner's request.** `launchctl kickstart -k
gui/501/com.marktv.server` restarted the built server; launchd reports it running as PID 92223,
and `GET /api/v1/channels` returned HTTP 200. The stored 2026-09-24 channel 9 schedule remains
`marktv-cult-movies-2026-09-24-a0a0be22`, with a 2,400,000 ms opening source offset and an exact
86,400,000 ms duration. The manual schedule-generation API also attempts a Tunarr sync, so no
live regeneration was requested merely to prove persistence. Assignment reuse in the running
process remains to be observed at a later legitimate rebuild; the automated regression test
covers it. TiviMate still appeared in Tunarr's session API immediately after the restart.

---

## 12. Independent review of §11 — two findings (2026-09-23, second vendor)

**Provenance, because it decides how much this is worth.** A separate model — Luna, i.e. GPT-6 on
the `codex-api` backend via this session's broker, not the reviewer that wrote §11 — reviewed
commit `afba720` as a **static, unanchored** review. The diff was stripped of *this document*
first (it sat in the same commit, 283 lines, and would have fed it §5 and §11 as premises), and
only the diff plus the three post-change files were supplied. My own findings were withheld, so
the finding below is independent detection rather than agreement with me. I then verified both
findings against the source myself; the calibration notes are mine, and they change the severity.

### Finding 1 — assignment indices can misalign (mechanism verified; LATENT — never yet fired)

Three facts, all read from the code:

- `src/scheduler/generate.ts` increments the counter **unconditionally** on every movie-slot visit:
  `if (slot.kind === "movie") { ... movieSlotPosition += 1; }`
- A visit that selects nothing takes a different branch — `if (!chosen?.durationMs)` — which emits
  only filler via `fillToBoundary`, logs `EXHAUSTED_POOL`, and `continue`s. **No movie entry is
  produced**, but the counter has already advanced.
- The write side persists only *emitted* movie entries, in order
  (`!entry.sourceOffsetMs && slotMovieIds.has(entry.sourceSlotId)`).

So one empty movie-slot visit shifts every later film's index down by one. On the next
regeneration the assignment for visit N is read as the assignment for visit N-1, and because the
assignment path assigns `relaxed: false` directly it also **bypasses the cooldown** that would
otherwise have applied. Net effect: a different start time for that film, and the later airing
possibly suppressed — which is exactly the guarantee §5 option A's acceptance criterion asserts.

**Calibration (mine, and it matters): across 91 stored generations there are zero `EXHAUSTED_POOL`
and zero `FALLBACK_POOL` diagnostics.** The precondition has never occurred on this install. This
is a latent defect, not an active one. The review described it as a live violation; that
overstates it. It becomes real the first time a movie slot starves its pool.

**Smallest fix.** Persist one entry per movie-slot **visit**, with an explicit placeholder for a
visit that produced nothing, so the stored list is indexed by visit rather than by emission — or
align the read on visit index. *Accept when:* a test forces an empty movie-slot visit, regenerates
the same channel+date, and asserts identical film IDs **and** identical start instants; plus a
round-trip on a day that never empties.

### Finding 2 — the media snapshot reseeds the day, so "identical start instants" is narrower than §5 claims

`generationFingerprint` hashes the channel, revision, date, **all pools, and the entire media
snapshot** (plus history, movie programming, continuation and break analyses); the seed is
`${channel.id}:${date}:${fingerprint}`. Adding any media to the library therefore reseeds that
date's generation, which can change earlier (non-movie) selections and move a *retained* film's
start instant. Verified by reading; **practical bite unmeasured** — channel 9's film starts look
30-minute boundary-aligned, which would blunt it. Note the fix is not simply "drop media from the
fingerprint": a media change *should* affect selection for days not yet committed. Either state the
guarantee precisely — film identity is stable per committed date; start instants are stable where
the surrounding layout does not depend on reseeded selections — or treat it as a larger design
change with its own handoff.

### Where the review corroborated §2/§11

Continuation entries do not consume an assignment position (matches my own line-trace, so that
uncertainty is now double-sourced); preserved-archive and movie-programming entries are correctly
excluded from this mechanism; and the transaction claim is true **at the call site**, with an
explicit and fair **UNKNOWN** from the review about whether `repositories.transaction` is truly
atomic (its implementation was out of scope — I verified only that both writes sit inside it).

### Independent verification of `afba720` (root session) — my own checks, so a regression cannot pass silently

Not a second opinion on the design — a check that the change does what §11 says and that its test
actually constrains the behaviour. Run by the session that wrote the §5 acceptance criterion, so
it is disinterested about the *method*, not about the *outcome*; the cross-vendor opinion is the
review above.

1. **The test pins the behaviour (the load-bearing one).** Reverted the two source files to the
   pre-fix version and ran the new test on its own:
   `git checkout 8e64216 -- src/scheduler/generate.ts src/server/scheduleService.ts`
   `npx vitest run tests/server/scheduleServiceMidroll.test.ts -t "keeps ordinary movie-slot picks"`
   → **1 failed**, at exactly `expect(filmEntries(rebuilt.schedule)).toEqual(expected)` — that is,
   without the fix, adding a film to the catalog reshuffles the day. With the fix it passes. Then
   `git checkout HEAD -- <those files>` restored a clean tree.
   A green test says the suite passes; this says the test *fails when the fix is absent*, which is
   the property that stops the bug returning unnoticed.
2. **Full suite:** `npx vitest run` → 91 files / **1,015 tests passed**, matching §11's claim.
3. **Transaction claim:** verified at the call site — `repositories.transaction(() => …)` opens at
   `scheduleService.ts:362` and wraps both `replaceSuccessful` (395) and `settings.put` (409).
   Whether that helper is genuinely atomic remains unverified, as the review also says.
4. **Deployed state:** `slotMovieAssignments` is present in the built bundle
   (`dist-server/.../scheduleService.js` ×2, `generate.js` ×1); the running process started
   19:04:37, after the 18:58 build, so the live process is running the new code. API 200, pid 92223.
5. **The §2 fix survived the change:** 09-24 channel 9 remains `a0a0be22`, 86,400,000 ms, with one
   continuation entry at `sourceOffsetMs` 2,400,000 airing 3,089,025 ms.

Reproduce 1 and 2 with the commands above; they are read-only apart from the temporary checkout,
which must be reverted.

### What to finalize

Finding 1 is a fix in the same two files and belongs to whoever owns `afba720`; it is small and the
acceptance test is specified above. Finding 2 is a documentation correction at minimum. Same
authority as §5: decide, implement, verify, deploy if it changes behaviour, and record the outcome
here.
