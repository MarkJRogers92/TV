# TV Scheduler Design

Date: 2026-09-14
Status: Approved design awaiting implementation-plan review
Repository: `MarkJRogers92/TV`

## 1. Purpose

Build a configurable virtual television-network scheduler centered on 1990s and early-2000s sitcom syndication, with authentic commercial breaks, station promos, weekend marathons, and movie/special blocks.

The system should feel like a real cable network rather than a shuffled media playlist. It needs stable appointment-viewing anchors, rotating secondary programming, episode-state tracking, era-appropriate commercial selection, and deterministic daily playout schedules that can later feed a media server or playout engine.

This design intentionally separates programming policy from playout execution so the user can change the lineup, dayparts, anchors, rotations, and commercial rules without rewriting scheduler logic.

## 2. Canonical Launch Lineup

The initial sitcom library is:

1. Roseanne
2. Home Improvement
3. Married... with Children
4. Grace Under Fire
5. According to Jim
6. That '70s Show
7. Everybody Loves Raymond
8. The Nanny
9. Dinosaurs
10. The Drew Carey Show
11. Grounded for Life
12. 3rd Rock from the Sun
13. The King of Queens
14. NewsRadio
15. The Golden Girls
16. ALF
17. The Cosby Show
18. Night Court

The architecture must allow shows to be added, removed, disabled, or moved between programming pools through configuration only.

## 3. Design Principles

### 3.1 Stable anchors, flexible secondary slots

Major shows keep dependable weekday times so the channel develops an identity. Roughly 20-30% of non-anchor daytime slots are eligible to change on a periodic rotation cadence.

### 3.2 Syndication-style episode flow

Episodes should not be treated as a simple permanently linear DVD queue. The scheduler tracks episode state, recent plays, and air counts so it can avoid obvious repetition while retaining the familiar cadence of syndicated television.

### 3.3 Weekends should feel different

Saturday and Sunday use different rules from weekdays, including family-oriented mornings, rotating sitcom marathons, and evening movie/special windows.

### 3.4 Commercial repetition is intentional

The system should avoid duplicate commercials inside the same break and excessive near-term repetition, but should not maximize uniqueness. Campaign recurrence is part of the desired period-authentic television feel.

### 3.5 Configuration over code edits

Programming policy lives in human-readable configuration. Core scheduling code should operate on generic shows, blocks, slots, pools, weights, and rules rather than hard-coded titles.

## 4. Programming Blocks

The initial weekday dayparts are:

| Block | Time | Character |
| --- | --- | --- |
| Morning Comfort | 06:00-10:00 | Familiar, lighter comfort sitcoms |
| Retro Recess | 10:00-12:00 | ALF, Dinosaurs, and lighter/odder retro material |
| Afternoon Syndication | 12:00-17:00 | Broad rotating sitcom library |
| After Work | 17:00-19:00 | Family/working-class sitcom bridge into prime time |
| Prime Time | 19:00-22:00 | Major channel anchors |
| After Dark | 22:00-00:00 | Sharper, more adult sitcoms |
| Insomniac TV | 00:00-03:00 | NewsRadio, 3rd Rock, Night Court, Married, related late-night material |
| Graveyard Shift | 03:00-06:00 | Weighted reruns and deeper library rotation |

Programming-block names are first-class metadata. They may later be surfaced in bumpers, promos, EPG metadata, or UI branding.

## 5. Initial Weekday Anchors

The weekday backbone is:

- 18:00-19:00 — Home Improvement
- 19:00-20:00 — Roseanne
- 20:00-21:00 — Everybody Loves Raymond
- 21:00-22:00 — The Drew Carey Show
- 22:00-23:00 — Married... with Children

Each one-hour anchor is initially modeled as two half-hour episode slots unless source runtimes or special episodes require otherwise.

These anchor assignments should remain stable across normal rotation cycles unless explicitly changed in configuration.

## 6. Flexible Rotation

### 6.1 Eligible pool

The initial flexible rotation pool includes:

- The Golden Girls
- The Cosby Show
- The Nanny
- Grace Under Fire
- ALF
- Dinosaurs
- 3rd Rock from the Sun
- The King of Queens
- Grounded for Life
- According to Jim
- That '70s Show
- Night Court
- NewsRadio

Additional anchor shows may also appear in secondary slots where allowed, but their anchor positions remain protected.

### 6.2 Cadence

Default rotation cadence: 28 days.

Default percentage of eligible non-anchor daytime slots that may be reassigned at a rotation boundary: 25%.

Both values are configurable.

### 6.3 Rotation constraints

The scheduler should:

- preserve fixed anchors;
- honor block/show suitability rules;
- avoid assigning the same show to too many adjacent blocks;
- avoid making the same secondary show dominate the entire day;
- support optional per-show minimum and maximum weekly exposure;
- prefer continuity within a rotation period so the grid still feels intentional rather than random every morning.

Rotation should generate a stable grid for the configured period, not reshuffle every day.

## 7. Weekend Programming

### 7.1 Saturday

Default Saturday structure:

- Morning: ALF, Dinosaurs, and family-oriented retro programming.
- Late morning: Home Improvement, 3rd Rock from the Sun, and similar material.
- 13:00-16:00: rotating three-hour sitcom marathon.
- 16:00-20:00: normal weekend sitcom rotation.
- 20:00: Saturday Night Movie.
- Post-movie: Married... with Children, NewsRadio, Night Court, 3rd Rock, and similar late-night programming.

### 7.2 Sunday

Default Sunday structure:

- Morning: comfort-heavy programming such as The Golden Girls, The Nanny, and Grace Under Fire.
- Midday: Everybody Loves Raymond, The King of Queens, According to Jim, and related programming.
- 14:00-17:00: rotating three-hour sitcom marathon.
- 17:00-20:00: major sitcom rotation.
- 20:00: Sunday Night Movie or Special.
- Late night: lighter late-night rotation.

### 7.3 Marathon selection

Marathon selection must track recent marathon history and should not repeat the same show on consecutive eligible weekends unless explicitly forced.

Configuration may optionally define weighted marathon eligibility so certain shows appear more frequently than others.

## 8. Episode Rotation Model

Each show maintains persistent scheduling state.

Minimum state:

```text
show_id
last_episode_played
recent_episode_ids
season_progress
last_air_datetime
air_count
```

Per-episode state may include:

```text
episode_id
season_number
episode_number
runtime
last_air_datetime
air_count
special_flag
holiday_tags
```

### 8.1 Supported episode strategies

The scheduler should define a strategy interface supporting at least:

1. **Sequential syndication** — proceed in order, wrapping at the end of the eligible library.
2. **Shuffled syndication** — randomized order with a recent-play exclusion buffer.
3. **Season-weighted** — optional future mode giving configured seasons different weights.

Launch default: sequential syndication plus a recent-episode exclusion buffer.

Specials and holiday-tagged episodes may later be eligible for date-aware overrides.

## 9. Commercial Metadata and Selection

Each commercial clip should support metadata such as:

```text
commercial_id
title
year
duration_seconds
category
era_tags
daypart_tags
content_rating
weight
last_played_datetime
recent_play_count
source_file
```

Initial categories should include:

- food
- fast_food
- toys
- automotive
- household
- electronics
- movies
- video_games
- beer
- music_compilation
- 1_800_product
- infomercial
- network_promo

### 9.1 Daypart weighting

Commercial selection pools are configurable by programming block.

Examples:

- Morning/daytime may favor cereal, toys, household products, department-store advertising, and fast food.
- Prime time may favor cars, movies, electronics, fast food, and major-brand campaigns.
- Insomniac TV may favor 1-800 products, compilation CDs, psychic-line-style advertising, infomercial products, video games, and horror/movie trailers.

### 9.2 Repetition policy

Launch defaults:

- never repeat the exact same commercial within one break;
- prefer not to replay the exact same commercial within approximately 90 minutes;
- allow high-weight campaigns to recur multiple times per day;
- support frequency caps and weights by clip or campaign.

These should be preferences rather than impossible constraints when the available commercial pool is too small.

## 10. Break Construction

The system should generate breaks against a target slot duration rather than assume every sitcom file has an identical runtime.

A playout slot should know:

```text
slot_start
slot_end
program_runtime
break_target_seconds
```

Commercial selection fills available break time within a configurable tolerance.

The implementation should favor clean break-length fitting while avoiding pathological behavior such as endlessly searching for an exact duration match. A bounded fitting strategy is sufficient.

Future support may use detected act-break markers to place multiple commercial pods inside an episode rather than only padding the end of a slot.

## 11. Station Promos and IDs

The generated schedule should expose upcoming-program data so promos can be generated from schedule state.

Promo types should include:

- channel/station ID;
- "up next";
- "tonight";
- "more [show] after this";
- weekend marathon promo;
- Saturday Night Movie promo;
- Sunday Night Movie/Special promo.

Promos are treated as schedulable media items rather than hard-coded UI text so they can later have real audio/video assets.

## 12. Configuration Model

The implementation should use a human-readable configuration format such as YAML or JSON. YAML is preferred for hand-editing unless project implementation constraints later favor JSON.

Illustrative structure:

```yaml
channel:
  timezone: America/Chicago

rotation:
  cadence_days: 28
  flexible_slot_percentage: 0.25

blocks:
  prime_time:
    days: [mon, tue, wed, thu, fri]
    start: "19:00"
    end: "22:00"

anchors:
  - show: roseanne
    days: [mon, tue, wed, thu, fri]
    start: "19:00"
    episodes: 2

marathons:
  saturday:
    start: "13:00"
    duration_minutes: 180
    rotate_show: true
  sunday:
    start: "14:00"
    duration_minutes: 180
    rotate_show: true

movies:
  saturday: "20:00"
  sunday: "20:00"
```

Separate catalog files may hold show, episode, commercial, movie, and promo metadata if that keeps configuration easier to maintain.

## 13. Architecture

The scheduler should be split into focused components.

### 13.1 Catalog

Loads and validates media metadata for shows, episodes, commercials, promos, and movies/specials.

### 13.2 Programming Grid

Resolves configuration into a stable abstract weekly/rotation-period grid containing anchors, flexible slots, marathons, and movie windows.

### 13.3 Rotation Engine

Assigns eligible shows to flexible slots for a rotation period while enforcing suitability and exposure constraints.

### 13.4 Episode Selector

Chooses the next episode for an assigned show based on its configured syndication strategy and persistent history.

### 13.5 Break Filler

Builds commercial/promo pods that fit the available break duration and obey weighting/repetition rules.

### 13.6 Daily Schedule Generator

Combines the programming grid, episode selections, movie/special selections, commercials, and promos into the exact ordered playout schedule for a specific date.

### 13.7 State Store

Persists episode history, commercial history, marathon history, rotation assignments, and generation checkpoints.

The first implementation may use a local SQLite database because it is portable, transactional, inspectable, and adequate for a single-channel local system. The persistence interface should remain small enough to replace later if needed.

### 13.8 Playout Adapter

A separate boundary transforms the generated schedule into whatever a future playback system expects. The scheduler itself should not depend on a particular player, media server, or streaming protocol.

## 14. Data Flow

For a requested broadcast date:

1. Load validated channel configuration and catalogs.
2. Determine the active rotation period.
3. Reuse the stored rotation-period grid if one exists; otherwise generate and persist it.
4. Resolve the day's slots from weekday/weekend policy.
5. Select episodes for show slots using persistent episode state.
6. Resolve marathon and movie/special selections where applicable.
7. Calculate available commercial-break time from actual media runtimes.
8. Fill breaks from the relevant daypart commercial pool.
9. Insert station IDs/promos according to configurable rules.
10. Persist scheduling history atomically.
11. Emit the exact daily playout schedule in a machine-readable format.

Given identical configuration, catalog, state, date, and random seed, generation should be reproducible.

## 15. Error Handling

Configuration errors should fail clearly before schedule generation when possible.

Examples:

- anchor references an unknown show;
- slot overlaps another protected slot;
- invalid time range;
- empty required rotation pool;
- media item has missing or invalid runtime.

Runtime shortages should degrade gracefully where possible.

Examples:

- too few commercials to satisfy the 90-minute preference: allow a repeat and record the fallback;
- no eligible marathon show under normal cooldown rules: relax cooldown rather than fail the day;
- missing episode media: skip that episode and choose the next eligible one while emitting a warning.

A generated day should include diagnostics/warnings so scheduling compromises are visible.

## 16. Initial Schedule Output

The daily generator should produce a structured format that can later drive playout. Minimum event fields:

```text
event_id
event_type
start_datetime
end_datetime
duration_seconds
media_id
source_file
program_block
show_id
episode_id
commercial_id
promo_id
notes
```

Not every field applies to every event type.

A human-readable schedule view may be generated from the same data but should not be the primary persisted format.

## 17. Testing Requirements

Implementation should include automated tests for at least:

- fixed anchors remain fixed across rotation boundaries;
- only eligible flexible slots rotate;
- approximately the configured fraction of eligible slots changes at a rotation boundary;
- show suitability constraints are respected;
- sequential episode progression wraps correctly;
- recent-episode exclusions work;
- marathon shows do not repeat consecutively when alternatives exist;
- commercial clips never duplicate inside one break;
- recent-commercial preference is respected when the pool permits it;
- small commercial pools trigger graceful fallback instead of failure;
- weekend schedules differ from weekday schedules;
- movie/special windows remain protected;
- generated events do not overlap;
- a generated day covers the intended 24-hour broadcast window;
- deterministic generation reproduces the same schedule given the same seed and state snapshot;
- invalid configuration produces actionable validation errors.

A fixture catalog should provide small fake episode/commercial libraries so scheduler tests do not require copyrighted media files.

## 18. Launch Scope

The first implementation should focus on scheduling and metadata rather than live streaming.

In scope:

- channel configuration;
- sitcom catalog metadata;
- block definitions;
- weekday/weekend grids;
- fixed anchors;
- rotation-period assignment;
- episode selection/history;
- marathon selection/history;
- movie/special windows;
- commercial metadata and break fitting;
- station-promo hooks;
- SQLite state;
- machine-readable daily schedule output;
- tests and sample fixture data.

Out of scope for the first scheduler milestone:

- transcoding;
- HLS/DASH generation;
- live streaming server;
- automatic act-break detection;
- automatic commercial video splitting;
- EPG server integration;
- generated voiceover/video promos;
- multi-channel scheduling;
- rights management.

Those can be layered onto the playout-adapter boundary later without redesigning the scheduler core.

## 19. Acceptance Criteria

The scheduler milestone is complete when a user can:

1. define or edit the lineup and programming policy in configuration;
2. generate a stable weekday/weekend grid for the current rotation period;
3. generate an exact 24-hour schedule for a selected date;
4. see anchors remain fixed while configured secondary slots rotate periodically;
5. see sequential episode progression without immediate accidental repeats;
6. see Saturday and Sunday marathon/movie behavior;
7. see commercial pods selected by daypart with repetition controls;
8. rerun generation reproducibly from the same state/seed;
9. inspect persisted scheduler state and warnings;
10. add a new sitcom or commercial through metadata/configuration without changing core scheduling code.

## 20. Future Extensions

Likely later milestones include:

- act-break-aware commercial insertion using chapter markers, subtitles, or manual break metadata;
- automatic segmentation of commercial compilation videos into individual spots;
- period-specific schedule modes (for example, a 1994-heavy month versus a 1999-heavy month);
- holiday episode/event programming;
- themed nights;
- movie-library weighting and genre nights;
- dynamic promo rendering from upcoming schedule metadata;
- EPG/XMLTV output;
- integration with a local media server and continuous playout engine;
- multiple branded channels sharing the same catalog and scheduler infrastructure.
