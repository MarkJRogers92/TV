# Movie programming

The movie-programming feature films the channel's late night and weekends without turning the sitcom schedule into a second scheduler: it is one configuration block on the channel, one persisted rotation, and one dated assignment ledger, all consumed by the existing generator and pushed by the existing guarded Tunarr sync.

## What it schedules

- **Nightly feature, 02:00 local.** Every night, soft-anchored: the film starts at the first natural program boundary within fifteen minutes either side of the anchor, so a sitcom finishing at 02:03 starts it at 02:03 and nothing depends on an exact second.
- **Weekend double feature, 19:00 local Saturday and Sunday.** Opener, a 60-120 second bridge of whole interstitials, closer. Never a third film.
- **Encores.** Sunday 02:00 replays Saturday's opener; Monday 02:00 replays Sunday's opener. Saturday 02:00 is an ordinary nightly feature.

A normal week therefore has eleven starts: nine new selections and two encores. A first run that begins on a Sunday or Monday has no earlier opener of its own to replay, so those slots take one ordinary selection from the rotation and say so with `MOVIE_ENCORE_FALLBACK` - a past airing is never invented. Weekends the feature already covers still link out of order: generating Monday before Sunday derives the same Sunday opener.

## Rotation

The rotation is a persisted bag per channel. Every cycle plays all eligible movies once before any repeat, and because the order is a permutation no film can follow itself, including across a cycle boundary. Assignments are dated rows keyed by `(channel, date, position)`, and the movie for a date and position is a pure function of the date and the stored order - so previews, rescans, restarts and out-of-order generation reuse the same assignment instead of consuming the rotation again. An encore link is resolved from its source day, generating that day's assignment first if it has not been built yet.

A rescan only extends the order with newly eligible movies; it never reshuffles what is still to come. An inventory that became entirely unavailable keeps the stored rotation rather than pruning it to nothing. Eligibility is scoped to the configured root: films on another volume, or left behind at a folder the channel no longer points at, are not drawn even when the catalogue still lists them. A future assignment whose film disappeared is re-derived from the rotation - and any encore that replays it follows, in one write - but an assignment for a day that has already aired is never rewritten.

## Breaks

Movie breaks are separate from the sitcom policy: a film up to 110 minutes gets three breaks at roughly 25/50/75 per cent, a longer one gets four at roughly 20/40/60/80 per cent, the first and last fifteen minutes are never interrupted, and a break targets two minutes built from complete spots - never longer than the live 2.5-minute sitcom policy. A break Tunarr cannot fill exactly blocks the sync instead of airing as dead time.

Two different facts are reported separately, because they used to be conflated: `MOVIE_BREAK_ESTIMATED` says the break's **location** is a percentage of the running time and that no black, fade, audio or chapter analysis was performed; `MOVIE_BREAK_POD_FILL_DETECTED` or `MOVIE_BREAK_POD_FILL_ESTIMATED` says whether the break's **duration** is an exact combination of whole local spots. Nothing is called detected unless something measured it. A break that lands exactly on a resume point is kept and opens the continuation rather than disappearing, and the breaks within one film draw from a bag so the same spot is not repeated while alternatives fit.

A movie that would cross midnight is not dropped: the tail continues in the next broadcast day carrying its source offset and remaining breaks, and Tunarr is told where in the file to resume. The state is written onto the schedule itself (`movieCarry`), so a restart or a regenerated day resumes exactly where the film stopped. A weekend double feature is one block: if the opener reaches midnight, the closer and the not-yet-played bridge are carried with it, the closer airs in full across as many midnights as it needs, and no sitcom or third film can appear inside the block.

## Endpoints and activation

- `GET /api/v1/channels/:id/movie-programming` - enabled state, movie folder and whether it is reachable, rotation size, the upcoming airings for the lookahead horizon, and anything degraded.
- `PUT /api/v1/channels/:id/movie-programming` - `{ "enabled": true, "poolIds": ["movies"], "rootPath": "/Volumes/SSK Drive /MarkTV/Movies" }`. Enabling enrols the configured pool with every playable movie inside that folder, so the root only has to be scanned once. Enabling with no pool or no folder is refused: a channel that says it has movie programming and can never schedule a film is not a valid configuration. The instant of enabling is recorded, which is what tells a first run apart from a weekend the feature already covered.

The feature is **off by default**. To activate it on the production channel:

1. Confirm the movie root is registered under Library and scanned, so the movie media exist with playable durations.
2. `PUT` the control above with the pool id and the absolute root path.
3. Generate the current date and check the diagnostics, then let the quiet-hours pass roll the lookahead forward.

### Reserving a nested movie root

A channel may carry a disabled movie-programming block with `enabled: false`, its
`poolIds`, and a `rootPath` solely to reserve that folder for a dedicated movie
pool. The enrollment sweep treats configured child roots as excluded from a
broader enabled root, so a general Movies pool cannot absorb those files. The
nightly and weekend movie scheduler remains off until that block is explicitly
enabled.

The rolling coverage pass is idempotent: it resolves at least seven days of assignments every quiet-hours pass and builds at most one missing future schedule per pass. Only the current broadcast date is ever synced to Tunarr, through the existing plan-then-apply guard, so a future day can be prepared without being aired.

The status preview is genuinely non-mutating: it resolves the horizon against an in-memory overlay, so reading the page never creates a rotation, writes an assignment, or builds a schedule. Generation and coverage are the only paths that reserve anything.

Changing the control - enabling, disabling, or editing the anchors, pools or break policy - drops the stored schedules and assignments for days **after** today, so a pre-generated tomorrow cannot air the configuration that was just replaced. Today's schedule is left alone because it is already on air, and past days are history. The rotation is deliberately not touched.

## Recovery

- `MOVIE_ROTATION_EMPTY` - no eligible movies; scan the root or check the pool.
- `MOVIE_ROTATION_SHORT` - only one eligible movie, so consecutive airings must repeat it.
- `MOVIE_MEDIA_UNAVAILABLE`, `MOVIE_CONTINUATION_UNAVAILABLE` - an assigned movie is missing or unplayable; rescan and regenerate.
- `MOVIE_ANCHOR_LATE` - a long preceding program pushed the feature off its anchor; the film still airs.
- `MOVIE_BRIDGE_UNAVAILABLE` - no whole-spot combination fits the bridge window; add interstitials to the bridge pools.
- `MOVIE_ENCORE_FALLBACK` - the encore's opener was never scheduled (the feature started that day), so an ordinary rotation selection was used instead.
- `MOVIE_ASSIGNMENT_REPAIRED` - a future assignment's film left the catalogue; it was re-derived, and any linked encore followed.
- `MOVIE_BREAK_ESTIMATED` - the break locations are percentage estimates; no analysis of the film was performed.
- `MOVIE_BREAK_POD_FILL_ESTIMATED` - no local whole-spot combination reaches the target; the configured two minutes is used, and the Tunarr dry run decides whether it can be filled exactly.
