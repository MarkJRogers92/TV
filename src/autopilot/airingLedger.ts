import type { MarkTvDatabase } from "../db/database.js";
import {
  recordPartialExposure,
  type AiredInterval,
  type MemberExposure,
  type PodMember,
} from "../continuity/podExposure.js";

/*
 * Durable airing ledger (Stage 1, additive).
 *
 * The ledger is the only place that may credit an episode as *aired*. It does
 * not read `schedule_generations`, `documents`, or Tunarr's play history: those
 * record what was planned or calculated, not what was published and played out.
 * An occurrence is credited only from two independently recorded evidence
 * streams that both cover the whole source contiguously - published source
 * intervals (the publisher demonstrably emitted the source) and actual aired
 * source intervals (an explicit aired observation exists). A gap in either
 * stream holds the occurrence; it never advances the track's completion floor.
 *
 * The floor is monotonic per series track: a later episode cannot be credited
 * before its immediate predecessor is credited. Ordering is *gap-aware* rather
 * than adjacency-in-the-registry: for ordinary ordered tracks the successor of
 * (season, episode) is the numerically next episode, so a missing E11 does not
 * let E12 jump the floor. Tracks whose position is only an ordinal advance by
 * ordinal. A missing or ambiguous episode position holds the track and leaves
 * the floor exactly where it was. The active occurrence and its source offset
 * are persisted so a restart reopens the same occurrence at the same offset
 * instead of restarting or skipping it.
 *
 * One series is one logical track shared by every channel that airs it, so two
 * channels drawing from the same library contend for one floor. A caller that
 * genuinely needs an independent floor passes an explicit `separateTrack`
 * discriminator. Identity is never derived from a filename: it comes from the
 * normalized series title plus, for episodes, the season/episode pair or an
 * explicit ordinal.
 */

/**
 * The additive tables this module owns. Exported so callers and tests can
 * assert the schema without guessing at index names.
 */
export const airingLedgerTables = [
  "airing_series_tracks",
  "airing_episode_identities",
  "airing_track_holds",
  "airing_occurrence_reservations",
  "airing_occurrence_attempts",
  "airing_published_source_intervals",
  "airing_aired_source_intervals",
  "airing_active_occurrences",
  "airing_completion_floors",
  "airing_pod_member_exposure",
] as const;

export type TrackHoldReason = "missing-position" | "ambiguous-position";
export type OccurrenceState =
  "reserved" | "active" | "interrupted" | "completed" | "abandoned";
export type AttemptOutcome =
  "started" | "superseded" | "cancelled" | "failed" | "completed";
export type ActiveOccurrenceState = "active" | "interrupted";

/**
 * Why a write was refused. Every refusal leaves the database unchanged; none of
 * them throw, so callers can hold a track and retry without unwinding a
 * transaction.
 */
export type AiringRefusalReason =
  | "track-held"
  | "unknown-track"
  | "unknown-episode"
  | "unknown-occurrence"
  | "no-active-occurrence"
  | "occurrence-in-progress"
  | "active-occurrence-mismatch"
  | "missing-position"
  | "ambiguous-position"
  | "id-conflict"
  | "invalid-interval"
  | "offset-regression"
  | "insufficient-evidence"
  | "predecessor-incomplete"
  | "already-credited";

/**
 * A comparable position inside one track. Ordered tracks carry a numeric
 * season/episode pair; every other track falls back to a monotonic ordinal.
 * The two are deliberately not comparable with each other.
 */
export type TrackPosition = {
  positionKey: string;
  season: number | null;
  episode: number | null;
  ordinal: number | null;
};

export type AiringWriteResult<T> =
  | { ok: true; created: boolean; value: T }
  | { ok: false; reason: AiringRefusalReason; detail: string };

/** One recorded exposure write. `at` defaults to now. */
export type PodExposureInput = {
  /** Unique per pod airing; a replay carries the same id. */
  exposureId: string;
  podId: string;
  channelId: string;
  /** The pod's members in playback order - the layout that aired. */
  members: readonly PodMember[];
  /** The part of the pod that actually aired. */
  aired: AiredInterval;
  /**
   * Where the pod begins, when `aired` is expressed in absolute time. Without it
   * the members are laid out from zero and an absolute interval overlaps none of
   * them, so every member would be recorded at zero seconds.
   */
  podStartMs?: number;
  at?: string;
};

/**
 * What was recorded for one pod airing: the per-member seconds and completion
 * flags, plus the pod-level totals. `members` is exactly the shape
 * `recordPartialExposure` returns, so a stored record reads back as the
 * computation's output.
 */
export type PodExposureRecord = {
  exposureId: string;
  podId: string;
  channelId: string;
  airedStartMs: number;
  airedEndMs: number;
  members: MemberExposure[];
  podAiredMs: number;
  podAiredSeconds: number;
  podCompleted: boolean;
  recordedAt: string;
};

export type SeriesTrackRecord = {
  trackKey: string;
  /** Informational only: the channel that first registered the shared track. */
  channelId: string;
  /** Logical (channel-independent) series key; equal to `trackKey` by default. */
  seriesKey: string;
  /** Explicit discriminator for an intentionally separate track, else null. */
  trackScope: string | null;
  /**
   * Explicit, trustworthy start position for a track the ledger did not
   * observe from its first episode (for example a migrated floor). When null,
   * the first credit must be an unambiguous opener.
   */
  initialPosition: TrackPosition | null;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type EpisodeIdentityRecord = {
  episodeKey: string;
  trackKey: string;
  title: string;
  season: number | null;
  episode: number | null;
  ordinal: number | null;
  positionKey: string;
  createdAt: string;
  updatedAt: string;
};

export type TrackHold = {
  trackKey: string;
  reason: TrackHoldReason;
  detail: string | null;
  occurrenceKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OccurrenceReservation = {
  occurrenceKey: string;
  trackKey: string;
  episodeKey: string;
  channelId: string;
  broadcastDate: string | null;
  plannedStart: string;
  plannedEnd: string;
  sourceMediaId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  state: OccurrenceState;
  createdAt: string;
  updatedAt: string;
};

export type OccurrenceAttempt = {
  attemptId: string;
  occurrenceKey: string;
  attemptIndex: number;
  startedAt: string;
  endedAt: string | null;
  outcome: AttemptOutcome;
  sourceOffsetMs: number;
  createdAt: string;
  updatedAt: string;
};

export type SourceInterval = {
  intervalId: string;
  occurrenceKey: string;
  attemptId: string | null;
  sourceMediaId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  /** When the evidence was observed - publication or airing time. */
  observedAt: string;
  evidence: string;
  createdAt: string;
};

export type ActiveOccurrence = {
  trackKey: string;
  occurrenceKey: string;
  attemptId: string | null;
  sourceMediaId: string;
  sourceOffsetMs: number;
  state: ActiveOccurrenceState;
  interruptedAt: string | null;
  resumedAt: string | null;
  updatedAt: string;
};

export type CompletionFloor = {
  trackKey: string;
  season: number | null;
  episode: number | null;
  ordinal: number | null;
  positionKey: string;
  completedEpisodeKey: string;
  completedOccurrenceKey: string;
  completedAt: string;
  updatedAt: string;
};

export type OccurrenceEvaluation = {
  occurrenceKey: string;
  sourceStartMs: number;
  sourceEndMs: number;
  publishedCoverageMs: number;
  airedCoverageMs: number;
  /** Published source intervals cover the whole source with no gap. */
  contiguousPublished: boolean;
  /** At least one explicit aired source interval was recorded. */
  explicitAiredInterval: boolean;
  /** Aired source intervals cover the whole source with no gap. */
  contiguousAired: boolean;
  /** Completion: contiguous published coverage and an explicit aired interval. */
  complete: boolean;
};

export type CompletionCredit = {
  credited: boolean;
  floor: CompletionFloor;
  evaluation: OccurrenceEvaluation;
};

export type SeriesTrackInput = {
  channelId: string;
  seriesTitle: string;
  /**
   * Explicit override that gives this caller an independent floor for the same
   * series. Omit it to share one logical track (and one floor) across channels.
   */
  separateTrack?: string | null;
  /** Seed the track's explicit start position (defaults to none). */
  initialPosition?: {
    season?: number | null;
    episode?: number | null;
    ordinal?: number | null;
  } | null;
  at?: string;
};

export type InitialPositionInput = {
  trackKey: string;
  season?: number | null;
  episode?: number | null;
  ordinal?: number | null;
  at?: string;
};

export type EpisodeIdentityInput = {
  episodeKey: string;
  trackKey: string;
  title: string;
  season?: number | null;
  episode?: number | null;
  ordinal?: number | null;
  at?: string;
};

export type OccurrenceReservationInput = {
  occurrenceKey: string;
  trackKey: string;
  episodeKey: string;
  channelId: string;
  plannedStart: string;
  plannedEnd: string;
  sourceMediaId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  broadcastDate?: string | null;
  at?: string;
};

export type OccurrenceAttemptInput = {
  attemptId: string;
  occurrenceKey: string;
  startedAt: string;
  outcome: AttemptOutcome;
  sourceOffsetMs?: number;
  attemptIndex?: number;
  endedAt?: string | null;
  at?: string;
};

export type SourceIntervalInput = {
  intervalId: string;
  occurrenceKey: string;
  sourceStartMs: number;
  sourceEndMs: number;
  evidence: string;
  /** Observation time for a published interval; defaults to `at`. */
  publishedAt?: string;
  /** Observation time for an aired interval; defaults to `at`. */
  airedAt?: string;
  attemptId?: string | null;
  sourceMediaId?: string;
  at?: string;
};

/**
 * Identity of one series track. Case, punctuation, spacing and a trailing
 * four-digit year are folded away exactly as the selector folds them, so a
 * rename that only changes spelling keeps one stable track instead of
 * splitting the completion floor in two.
 *
 * The key is deliberately channel-independent: one series is one logical track
 * shared by every channel that airs it, so two channels contend for the same
 * floor rather than each holding a partial one. A caller that wants an
 * intentional second track for the same series passes a non-empty
 * `separateTrack` discriminator.
 */
function normalizeSeriesKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\(\s*\d{4}\s*\)\s*$/, " ")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function seriesTrackKey(
  seriesTitle: string,
  separateTrack?: string | null,
): string {
  const normalized = normalizeSeriesKey(seriesTitle);
  const scope = separateTrack ? normalizeSeriesKey(separateTrack) : "";
  return scope ? `${normalized}\u001f${scope}` : normalized;
}

function pad(value: number): string {
  return Math.trunc(value).toString().padStart(6, "0");
}

function positionKey(
  season: number | null,
  episode: number | null,
  ordinal: number | null,
): string {
  if (season !== null && episode !== null)
    return `s${pad(season)}e${pad(episode)}`;
  return `o${pad(ordinal ?? 0)}`;
}

/** The comparable position of a stored episode identity. */
function positionOf(input: {
  season: number | null;
  episode: number | null;
  ordinal: number | null;
}): TrackPosition {
  const season = input.season ?? null;
  const episode = input.episode ?? null;
  const ordinal = input.ordinal ?? null;
  return {
    positionKey: positionKey(season, episode, ordinal),
    season,
    episode,
    ordinal,
  };
}

const isOrdered = (
  position: TrackPosition,
): position is TrackPosition & { season: number; episode: number } =>
  position.season !== null && position.episode !== null;

const isOrdinal = (position: TrackPosition): boolean => !isOrdered(position);

/**
 * Order two positions inside one track. Ordered and ordinal positions are not
 * comparable, so a mismatch sorts by the position key to stay deterministic:
 * the caller refuses the write rather than crediting across position systems.
 */
function comparePositions(left: TrackPosition, right: TrackPosition): number {
  if (isOrdered(left) && isOrdered(right)) {
    return left.season - right.season || left.episode - right.episode;
  }
  if (isOrdinal(left) && isOrdinal(right)) {
    return (left.ordinal ?? 0) - (right.ordinal ?? 0);
  }
  return left.positionKey.localeCompare(right.positionKey);
}

/**
 * The numerically immediate successor, mirroring the selector: the next
 * episode in the same season, or episode 1 of the following season. A gap
 * (missing or unavailable episode) is not a successor, and neither is a wrap
 * back to an earlier position.
 */
function isImmediateSuccessor(from: TrackPosition, to: TrackPosition): boolean {
  if (isOrdered(from) && isOrdered(to)) {
    if (to.season === from.season) return to.episode === from.episode + 1;
    return to.season === from.season + 1 && to.episode === 1;
  }
  if (isOrdinal(from) && isOrdinal(to)) {
    return to.ordinal === (from.ordinal ?? 0) + 1;
  }
  return false;
}

/** Whether a position describes the season-1 opener / ordinal 1. */
function isUnambiguousOpener(position: TrackPosition): boolean {
  if (isOrdered(position))
    return position.season === 1 && position.episode === 1;
  return position.ordinal === 1;
}

function describePosition(position: TrackPosition): string {
  return isOrdered(position)
    ? `S${position.season}E${position.episode}`
    : `ordinal ${position.ordinal ?? 0}`;
}

function expectedSuccessor(position: TrackPosition): string {
  if (isOrdered(position))
    return `S${position.season}E${position.episode + 1} or S${position.season + 1}E1`;
  return `ordinal ${(position.ordinal ?? 0) + 1}`;
}

/** Ordering inside one track: numbered episodes first, then ordinal fallbacks. */
function compareIdentities(
  left: EpisodeIdentityRecord,
  right: EpisodeIdentityRecord,
): number {
  if (left.season !== null && right.season !== null) {
    return (
      left.season - right.season || (left.episode ?? 0) - (right.episode ?? 0)
    );
  }
  if (left.season === null && right.season === null) {
    return (left.ordinal ?? 0) - (right.ordinal ?? 0);
  }
  return left.season === null ? 1 : -1;
}

type Coverage = { coveredMs: number; contiguous: boolean };

/**
 * Union coverage of source intervals over `[start, end)`. Contiguous means the
 * union reaches both ends without a gap; touching endpoints count as joined.
 */
function coverageOf(
  intervals: Array<{ sourceStartMs: number; sourceEndMs: number }>,
  start: number,
  end: number,
): Coverage {
  const clipped = intervals
    .map((interval) => [
      Math.max(interval.sourceStartMs, start),
      Math.min(interval.sourceEndMs, end),
    ])
    .filter(([intervalStart, intervalEnd]) => intervalEnd > intervalStart)
    .sort((left, right) => left[0] - right[0]);
  if (!clipped.length || end <= start)
    return { coveredMs: 0, contiguous: false };
  let cursor = start;
  let coveredMs = 0;
  let contiguous = true;
  for (const [intervalStart, intervalEnd] of clipped) {
    if (intervalStart > cursor) contiguous = false;
    if (intervalEnd > cursor) {
      coveredMs += intervalEnd - Math.max(cursor, intervalStart);
      cursor = intervalEnd;
    }
  }
  if (cursor < end) contiguous = false;
  return { coveredMs, contiguous };
}

/**
 * The transactional Stage 1 airing ledger. Every mutating method runs inside a
 * `better-sqlite3` transaction and is safe to replay: a duplicate callback with
 * the same caller-supplied id and the same payload is a no-op that reports the
 * stored record, while the same id carrying different evidence is refused as an
 * `id-conflict` rather than silently overwriting the audit trail.
 */
export function createAiringLedger(database: MarkTvDatabase) {
  const now = () => new Date().toISOString();
  const read = <T>(sql: string, ...parameters: unknown[]) => {
    const row = database.prepare(sql).get(...parameters) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  };
  const readAll = <T>(sql: string, ...parameters: unknown[]) =>
    (database.prepare(sql).all(...parameters) as Array<{ json: string }>).map(
      (row) => JSON.parse(row.json) as T,
    );

  const refusal = <T = never>(
    reason: AiringRefusalReason,
    detail: string,
  ): AiringWriteResult<T> => ({ ok: false, reason, detail });
  const accepted = <T>(value: T, created: boolean): AiringWriteResult<T> => ({
    ok: true,
    created,
    value,
  });

  const seriesTrack = (trackKey: string) =>
    read<SeriesTrackRecord>(
      "SELECT json FROM airing_series_tracks WHERE track_key = ?",
      trackKey,
    );
  const episodeIdentity = (episodeKey: string) =>
    read<EpisodeIdentityRecord>(
      "SELECT json FROM airing_episode_identities WHERE episode_key = ?",
      episodeKey,
    );
  const episodeIdentities = (trackKey: string) =>
    readAll<EpisodeIdentityRecord>(
      "SELECT json FROM airing_episode_identities WHERE track_key = ?",
      trackKey,
    ).sort(compareIdentities);
  const trackHold = (trackKey: string) =>
    read<TrackHold>(
      "SELECT json FROM airing_track_holds WHERE track_key = ?",
      trackKey,
    );
  const occurrence = (occurrenceKey: string) =>
    read<OccurrenceReservation>(
      "SELECT json FROM airing_occurrence_reservations WHERE occurrence_key = ?",
      occurrenceKey,
    );
  const occurrencesForTrack = (trackKey: string) =>
    readAll<OccurrenceReservation>(
      "SELECT json FROM airing_occurrence_reservations WHERE track_key = ? ORDER BY created_at, occurrence_key",
      trackKey,
    );
  const attemptsFor = (occurrenceKey: string) =>
    readAll<OccurrenceAttempt>(
      "SELECT json FROM airing_occurrence_attempts WHERE occurrence_key = ? ORDER BY attempt_index",
      occurrenceKey,
    );
  const publishedIntervals = (occurrenceKey: string) =>
    readAll<SourceInterval>(
      "SELECT json FROM airing_published_source_intervals WHERE occurrence_key = ? ORDER BY source_start_ms, interval_id",
      occurrenceKey,
    );
  const airedIntervals = (occurrenceKey: string) =>
    readAll<SourceInterval>(
      "SELECT json FROM airing_aired_source_intervals WHERE occurrence_key = ? ORDER BY source_start_ms, interval_id",
      occurrenceKey,
    );
  const activeOccurrence = (trackKey: string) =>
    read<ActiveOccurrence>(
      "SELECT json FROM airing_active_occurrences WHERE track_key = ?",
      trackKey,
    );
  const completionFloor = (trackKey: string) =>
    read<CompletionFloor>(
      "SELECT json FROM airing_completion_floors WHERE track_key = ?",
      trackKey,
    );

  const ensureSeriesTrack = database.transaction((input: SeriesTrackInput) => {
    const at = input.at ?? now();
    const trackKey = seriesTrackKey(input.seriesTitle, input.separateTrack);
    const trackScope = input.separateTrack
      ? normalizeSeriesKey(input.separateTrack)
      : null;
    const requestedInitial = input.initialPosition
      ? positionOf({
          season: input.initialPosition.season ?? null,
          episode: input.initialPosition.episode ?? null,
          ordinal: input.initialPosition.ordinal ?? null,
        })
      : null;
    const existing = seriesTrack(trackKey);
    if (existing) {
      const updated: SeriesTrackRecord = {
        ...existing,
        title: input.seriesTitle,
        // A rename never splits the track; it only refreshes the display title.
        initialPosition: requestedInitial ?? existing.initialPosition,
        updatedAt: at,
      };
      database
        .prepare(
          "UPDATE airing_series_tracks SET title = ?, updated_at = ?, json = ? WHERE track_key = ?",
        )
        .run(
          updated.title,
          updated.updatedAt,
          JSON.stringify(updated),
          trackKey,
        );
      return accepted(updated, false);
    }
    const record: SeriesTrackRecord = {
      trackKey,
      channelId: input.channelId,
      seriesKey: normalizeSeriesKey(input.seriesTitle),
      trackScope,
      initialPosition: requestedInitial,
      title: input.seriesTitle,
      createdAt: at,
      updatedAt: at,
    };
    database
      .prepare(
        "INSERT INTO airing_series_tracks(track_key, channel_id, series_key, track_scope, title, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.trackKey,
        record.channelId,
        record.seriesKey,
        record.trackScope ?? "",
        record.title,
        at,
        at,
        JSON.stringify(record),
      );
    return accepted(record, true);
  });

  /**
   * Records a trustworthy explicit start position for a track the ledger did
   * not observe from its opener - for example a floor migrated from stronger
   * evidence than a generated schedule. Until this exists (or the track is
   * credited from an unambiguous opener) a later episode cannot be credited
   * merely because it is the first one registered.
   */
  const establishInitialPosition = database.transaction(
    (input: InitialPositionInput) => {
      const at = input.at ?? now();
      const track = seriesTrack(input.trackKey);
      if (!track)
        return refusal<SeriesTrackRecord>(
          "unknown-track",
          `no track ${input.trackKey}`,
        );
      const position = positionOf({
        season: input.season ?? null,
        episode: input.episode ?? null,
        ordinal: input.ordinal ?? null,
      });
      if (!isOrdered(position) && position.ordinal === null) {
        return refusal<SeriesTrackRecord>(
          "missing-position",
          "a season/episode pair or an ordinal is required",
        );
      }
      const record: SeriesTrackRecord = {
        ...track,
        initialPosition: position,
        updatedAt: at,
      };
      database
        .prepare(
          "UPDATE airing_series_tracks SET updated_at = ?, json = ? WHERE track_key = ?",
        )
        .run(at, JSON.stringify(record), input.trackKey);
      return accepted(record, false);
    },
  );

  const holdTrack = database.transaction(
    (input: {
      trackKey: string;
      reason: TrackHoldReason;
      detail?: string;
      occurrenceKey?: string;
      at?: string;
    }) => {
      const at = input.at ?? now();
      const existing = trackHold(input.trackKey);
      const record: TrackHold = {
        trackKey: input.trackKey,
        reason: input.reason,
        detail: input.detail ?? null,
        occurrenceKey: input.occurrenceKey ?? null,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      database
        .prepare(
          "INSERT INTO airing_track_holds(track_key, reason, detail, occurrence_key, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(track_key) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, occurrence_key = excluded.occurrence_key, updated_at = excluded.updated_at, json = excluded.json",
        )
        .run(
          record.trackKey,
          record.reason,
          record.detail,
          record.occurrenceKey,
          record.createdAt,
          at,
          JSON.stringify(record),
        );
      return accepted(record, existing === undefined);
    },
  );

  const releaseTrackHold = database.transaction(
    (trackKey: string, at?: string) => {
      void (at ?? now());
      return (
        database
          .prepare("DELETE FROM airing_track_holds WHERE track_key = ?")
          .run(trackKey).changes > 0
      );
    },
  );

  const ensureEpisodeIdentity = database.transaction(
    (input: EpisodeIdentityInput) => {
      const at = input.at ?? now();
      const season = input.season ?? null;
      const episode = input.episode ?? null;
      const ordinal = input.ordinal ?? null;
      const track = seriesTrack(input.trackKey);
      if (!track)
        return refusal<EpisodeIdentityRecord>(
          "unknown-track",
          `no track ${input.trackKey}`,
        );
      if ((season === null || episode === null) && ordinal === null) {
        holdTrack({
          trackKey: input.trackKey,
          reason: "missing-position",
          detail: input.episodeKey,
          at,
        });
        return refusal<EpisodeIdentityRecord>(
          "missing-position",
          `${input.episodeKey} has neither a season/episode pair nor an ordinal`,
        );
      }
      const key = positionKey(season, episode, ordinal);
      const current = episodeIdentity(input.episodeKey);
      if (current) {
        if (
          current.trackKey !== input.trackKey ||
          current.positionKey !== key
        ) {
          holdTrack({
            trackKey: input.trackKey,
            reason: "ambiguous-position",
            detail: `${input.episodeKey} moved from ${current.positionKey} to ${key}`,
            at,
          });
          return refusal<EpisodeIdentityRecord>(
            "ambiguous-position",
            `${input.episodeKey} changed position`,
          );
        }
        const updated: EpisodeIdentityRecord = {
          ...current,
          title: input.title,
          updatedAt: at,
        };
        database
          .prepare(
            "UPDATE airing_episode_identities SET title = ?, updated_at = ?, json = ? WHERE episode_key = ?",
          )
          .run(
            updated.title,
            updated.updatedAt,
            JSON.stringify(updated),
            input.episodeKey,
          );
        return accepted(updated, false);
      }
      const occupant = database
        .prepare(
          "SELECT episode_key FROM airing_episode_identities WHERE track_key = ? AND position_key = ?",
        )
        .get(input.trackKey, key) as { episode_key: string } | undefined;
      if (occupant) {
        holdTrack({
          trackKey: input.trackKey,
          reason: "ambiguous-position",
          detail: `${input.episodeKey} and ${occupant.episode_key} both claim ${key}`,
          at,
        });
        return refusal<EpisodeIdentityRecord>(
          "ambiguous-position",
          `${key} is already held by ${occupant.episode_key}`,
        );
      }
      const record: EpisodeIdentityRecord = {
        episodeKey: input.episodeKey,
        trackKey: input.trackKey,
        title: input.title,
        season,
        episode,
        ordinal,
        positionKey: key,
        createdAt: at,
        updatedAt: at,
      };
      database
        .prepare(
          "INSERT INTO airing_episode_identities(episode_key, track_key, title, season, episode, ordinal, position_key, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.episodeKey,
          record.trackKey,
          record.title,
          record.season,
          record.episode,
          record.ordinal,
          record.positionKey,
          at,
          at,
          JSON.stringify(record),
        );
      return accepted(record, true);
    },
  );

  const reserveOccurrence = database.transaction(
    (input: OccurrenceReservationInput) => {
      const at = input.at ?? now();
      if (
        !input.occurrenceKey ||
        Number.isNaN(input.sourceStartMs) ||
        Number.isNaN(input.sourceEndMs)
      ) {
        return refusal<OccurrenceReservation>(
          "invalid-interval",
          "source interval and key are required",
        );
      }
      if (
        !Number.isFinite(input.sourceStartMs) ||
        !Number.isFinite(input.sourceEndMs) ||
        input.sourceEndMs <= input.sourceStartMs
      ) {
        return refusal<OccurrenceReservation>(
          "invalid-interval",
          `source interval ${input.sourceStartMs}..${input.sourceEndMs} is empty`,
        );
      }
      const existing = occurrence(input.occurrenceKey);
      if (existing) {
        const same =
          existing.trackKey === input.trackKey &&
          existing.episodeKey === input.episodeKey &&
          existing.channelId === input.channelId &&
          existing.sourceMediaId === input.sourceMediaId &&
          existing.sourceStartMs === input.sourceStartMs &&
          existing.sourceEndMs === input.sourceEndMs;
        if (!same) {
          return refusal<OccurrenceReservation>(
            "id-conflict",
            `${input.occurrenceKey} already reserved differently`,
          );
        }
        return accepted(existing, false);
      }
      if (!seriesTrack(input.trackKey)) {
        return refusal<OccurrenceReservation>(
          "unknown-track",
          `no track ${input.trackKey}`,
        );
      }
      const hold = trackHold(input.trackKey);
      if (hold)
        return refusal<OccurrenceReservation>("track-held", hold.reason);
      const identity = episodeIdentity(input.episodeKey);
      if (!identity || identity.trackKey !== input.trackKey) {
        return refusal<OccurrenceReservation>(
          "unknown-episode",
          `${input.episodeKey} is not on ${input.trackKey}`,
        );
      }
      const record: OccurrenceReservation = {
        occurrenceKey: input.occurrenceKey,
        trackKey: input.trackKey,
        episodeKey: input.episodeKey,
        channelId: input.channelId,
        broadcastDate: input.broadcastDate ?? null,
        plannedStart: input.plannedStart,
        plannedEnd: input.plannedEnd,
        sourceMediaId: input.sourceMediaId,
        sourceStartMs: input.sourceStartMs,
        sourceEndMs: input.sourceEndMs,
        state: "reserved",
        createdAt: at,
        updatedAt: at,
      };
      database
        .prepare(
          "INSERT INTO airing_occurrence_reservations(occurrence_key, track_key, episode_key, channel_id, broadcast_date, planned_start, planned_end, source_media_id, source_start_ms, source_end_ms, state, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.occurrenceKey,
          record.trackKey,
          record.episodeKey,
          record.channelId,
          record.broadcastDate,
          record.plannedStart,
          record.plannedEnd,
          record.sourceMediaId,
          record.sourceStartMs,
          record.sourceEndMs,
          record.state,
          at,
          at,
          JSON.stringify(record),
        );
      return accepted(record, true);
    },
  );

  const setOccurrenceState = (
    occurrenceKey: string,
    state: OccurrenceState,
    at: string,
  ) => {
    const current = occurrence(occurrenceKey);
    if (!current) return;
    const updated: OccurrenceReservation = { ...current, state, updatedAt: at };
    database
      .prepare(
        "UPDATE airing_occurrence_reservations SET state = ?, updated_at = ?, json = ? WHERE occurrence_key = ?",
      )
      .run(state, at, JSON.stringify(updated), occurrenceKey);
  };

  const recordAttempt = database.transaction(
    (input: OccurrenceAttemptInput) => {
      const at = input.at ?? now();
      const reservation = occurrence(input.occurrenceKey);
      if (!reservation) {
        return refusal<OccurrenceAttempt>(
          "unknown-occurrence",
          `no occurrence ${input.occurrenceKey}`,
        );
      }
      const existing = read<OccurrenceAttempt>(
        "SELECT json FROM airing_occurrence_attempts WHERE attempt_id = ?",
        input.attemptId,
      );
      if (existing) {
        const same =
          existing.occurrenceKey === input.occurrenceKey &&
          existing.startedAt === input.startedAt &&
          existing.outcome === input.outcome &&
          existing.sourceOffsetMs === (input.sourceOffsetMs ?? 0);
        if (!same)
          return refusal<OccurrenceAttempt>(
            "id-conflict",
            `${input.attemptId} already recorded`,
          );
        return accepted(existing, false);
      }
      const maxIndex = database
        .prepare(
          "SELECT MAX(attempt_index) AS value FROM airing_occurrence_attempts WHERE occurrence_key = ?",
        )
        .get(input.occurrenceKey) as { value: number | null };
      const record: OccurrenceAttempt = {
        attemptId: input.attemptId,
        occurrenceKey: input.occurrenceKey,
        attemptIndex: input.attemptIndex ?? (maxIndex.value ?? 0) + 1,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        outcome: input.outcome,
        sourceOffsetMs: input.sourceOffsetMs ?? 0,
        createdAt: at,
        updatedAt: at,
      };
      database
        .prepare(
          "INSERT INTO airing_occurrence_attempts(attempt_id, occurrence_key, attempt_index, started_at, ended_at, outcome, source_offset_ms, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.attemptId,
          record.occurrenceKey,
          record.attemptIndex,
          record.startedAt,
          record.endedAt,
          record.outcome,
          record.sourceOffsetMs,
          at,
          at,
          JSON.stringify(record),
        );
      if (record.outcome === "started")
        setOccurrenceState(record.occurrenceKey, "active", at);
      return accepted(record, true);
    },
  );

  const recordInterval = (
    table:
      "airing_published_source_intervals" | "airing_aired_source_intervals",
    timestampColumn: "published_at" | "aired_at",
    input: SourceIntervalInput,
  ) => {
    const at = input.at ?? now();
    const observedAt = input.publishedAt ?? input.airedAt ?? at;
    const reservation = occurrence(input.occurrenceKey);
    if (!reservation) {
      return refusal<SourceInterval>(
        "unknown-occurrence",
        `no occurrence ${input.occurrenceKey}`,
      );
    }
    if (
      !Number.isFinite(input.sourceStartMs) ||
      !Number.isFinite(input.sourceEndMs) ||
      input.sourceEndMs <= input.sourceStartMs
    ) {
      return refusal<SourceInterval>(
        "invalid-interval",
        `source interval ${input.sourceStartMs}..${input.sourceEndMs} is empty`,
      );
    }
    const existing = read<SourceInterval>(
      `SELECT json FROM ${table} WHERE interval_id = ?`,
      input.intervalId,
    );
    if (existing) {
      const same =
        existing.occurrenceKey === input.occurrenceKey &&
        existing.sourceStartMs === input.sourceStartMs &&
        existing.sourceEndMs === input.sourceEndMs &&
        existing.evidence === input.evidence &&
        existing.sourceMediaId ===
          (input.sourceMediaId ?? reservation.sourceMediaId);
      if (!same)
        return refusal<SourceInterval>(
          "id-conflict",
          `${input.intervalId} already recorded`,
        );
      return accepted(existing, false);
    }
    const record: SourceInterval = {
      intervalId: input.intervalId,
      occurrenceKey: input.occurrenceKey,
      attemptId: input.attemptId ?? null,
      sourceMediaId: input.sourceMediaId ?? reservation.sourceMediaId,
      sourceStartMs: input.sourceStartMs,
      sourceEndMs: input.sourceEndMs,
      observedAt,
      evidence: input.evidence,
      createdAt: at,
    };
    database
      .prepare(
        `INSERT INTO ${table}(interval_id, occurrence_key, attempt_id, source_media_id, source_start_ms, source_end_ms, ${timestampColumn}, evidence, created_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.intervalId,
        record.occurrenceKey,
        record.attemptId,
        record.sourceMediaId,
        record.sourceStartMs,
        record.sourceEndMs,
        record.observedAt,
        record.evidence,
        at,
        JSON.stringify(record),
      );
    return accepted(record, true);
  };

  const recordPublishedInterval = database.transaction(
    (input: SourceIntervalInput) =>
      recordInterval(
        "airing_published_source_intervals",
        "published_at",
        input,
      ),
  );
  const recordAiredInterval = database.transaction(
    (input: SourceIntervalInput) =>
      recordInterval("airing_aired_source_intervals", "aired_at", input),
  );

  /**
   * Durable per-creative coverage for a pod (SC06).
   *
   * The computation lives in `src/continuity/podExposure.ts` and is NOT
   * duplicated here: this persists its result, so the recorded figures and the
   * tested figures cannot drift apart. That matters because the case is about
   * honesty - "record 30/15/0 seconds for members, not three completed ads" - and
   * a second implementation of the arithmetic would be a second chance to get it
   * wrong.
   *
   * Replaying an identical exposure is idempotent; the same id carrying
   * different evidence is refused as `id-conflict` rather than overwriting the
   * record, matching every other write in this ledger. A refusal leaves the
   * database unchanged.
   */
  /**
   * Reads one stored exposure. Returns `unreadable` rather than throwing or
   * reporting "absent", because treating a corrupt row as absent would let the
   * next write replace it - the one outcome this record must not allow. Callers
   * refuse the write instead, which leaves the database unchanged.
   */
  const readPodExposure = (
    exposureId: string,
  ): { record?: PodExposureRecord; unreadable: boolean } => {
    const row = database
      .prepare(
        "SELECT json FROM airing_pod_member_exposure WHERE exposure_id = ?",
      )
      .get(exposureId) as { json?: string } | undefined;
    if (row?.json === undefined) {
      return { unreadable: false };
    }
    try {
      return {
        record: JSON.parse(row.json) as PodExposureRecord,
        unreadable: false,
      };
    } catch {
      return { unreadable: true };
    }
  };

  const podExposure = (exposureId: string): PodExposureRecord | undefined =>
    readPodExposure(exposureId).record;

  const podExposuresForPod = (podId: string): PodExposureRecord[] =>
    (
      database
        .prepare(
          "SELECT json FROM airing_pod_member_exposure WHERE pod_id = ? ORDER BY recorded_at, exposure_id",
        )
        .all(podId) as Array<{ json: string }>
    ).flatMap((row) => {
      try {
        return [JSON.parse(row.json) as PodExposureRecord];
      } catch {
        return [];
      }
    });

  const recordPodExposure = database.transaction((input: PodExposureInput) => {
    const at = input.at ?? new Date().toISOString();
    const computed = recordPartialExposure(input.members, input.aired, {
      podStartMs: input.podStartMs,
    });
    const existing = readPodExposure(input.exposureId);
    if (existing.unreadable) {
      return refusal<PodExposureRecord>(
        "id-conflict",
        `${input.exposureId} exists but is unreadable; refusing to overwrite it`,
      );
    }
    if (existing.record !== undefined) {
      const same =
        existing.record.podId === input.podId &&
        existing.record.channelId === input.channelId &&
        existing.record.airedStartMs === input.aired.startMs &&
        existing.record.airedEndMs === input.aired.endMs &&
        JSON.stringify(existing.record.members) ===
          JSON.stringify(computed.members);
      if (!same) {
        return refusal<PodExposureRecord>(
          "id-conflict",
          `${input.exposureId} already recorded`,
        );
      }
      return accepted(existing.record, false);
    }
    const record: PodExposureRecord = {
      exposureId: input.exposureId,
      podId: input.podId,
      channelId: input.channelId,
      airedStartMs: input.aired.startMs,
      airedEndMs: input.aired.endMs,
      members: computed.members,
      podAiredMs: computed.podAiredMs,
      podAiredSeconds: computed.podAiredSeconds,
      podCompleted: computed.podCompleted,
      recordedAt: at,
    };
    database
      .prepare(
        "INSERT INTO airing_pod_member_exposure(exposure_id, pod_id, channel_id, aired_start_ms, aired_end_ms, pod_aired_ms, recorded_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.exposureId,
        record.podId,
        record.channelId,
        record.airedStartMs,
        record.airedEndMs,
        record.podAiredMs,
        record.recordedAt,
        JSON.stringify(record),
      );
    return accepted(record, true);
  });

  const beginOccurrence = database.transaction(
    (input: {
      trackKey: string;
      occurrenceKey: string;
      attemptId?: string | null;
      sourceMediaId?: string;
      sourceOffsetMs?: number;
      at?: string;
    }) => {
      const at = input.at ?? now();
      const reservation = occurrence(input.occurrenceKey);
      if (!reservation || reservation.trackKey !== input.trackKey) {
        return refusal<ActiveOccurrence>(
          "unknown-occurrence",
          `no occurrence ${input.occurrenceKey} on ${input.trackKey}`,
        );
      }
      if (reservation.state === "completed") {
        return refusal<ActiveOccurrence>(
          "already-credited",
          `${input.occurrenceKey} is completed`,
        );
      }
      if (reservation.state === "abandoned") {
        return refusal<ActiveOccurrence>(
          "id-conflict",
          `${input.occurrenceKey} was abandoned`,
        );
      }
      const requestedOffset = input.sourceOffsetMs ?? reservation.sourceStartMs;
      if (
        !Number.isFinite(requestedOffset) ||
        requestedOffset < reservation.sourceStartMs ||
        requestedOffset > reservation.sourceEndMs
      ) {
        return refusal<ActiveOccurrence>(
          "invalid-interval",
          `source offset ${requestedOffset} is outside ${reservation.sourceStartMs}..${reservation.sourceEndMs}`,
        );
      }
      const existing = activeOccurrence(input.trackKey);
      if (existing) {
        if (existing.occurrenceKey !== input.occurrenceKey) {
          // A second occurrence cannot take over the track while the first is
          // still live. Starting E11 while E10 is active or interrupted would
          // silently abandon an in-progress airing, so the caller has to finish
          // it or clear it explicitly first.
          return refusal<ActiveOccurrence>(
            "occurrence-in-progress",
            `${existing.occurrenceKey} is still ${existing.state} on ${input.trackKey}; complete or clear it before starting ${input.occurrenceKey}`,
          );
        }
        // Duplicate callback for the same occurrence: idempotent. Keep the
        // furthest recorded source offset and never forget a recorded
        // interruption, so a reconnect that replays "start at 0" cannot rewind
        // the playhead or clear an interruption.
        const record: ActiveOccurrence = {
          ...existing,
          attemptId: existing.attemptId ?? input.attemptId ?? null,
          sourceMediaId:
            existing.sourceMediaId ||
            input.sourceMediaId ||
            reservation.sourceMediaId,
          sourceOffsetMs: Math.max(existing.sourceOffsetMs, requestedOffset),
          updatedAt: at,
        };
        writeActive(record, at);
        return accepted(record, false);
      }
      const record: ActiveOccurrence = {
        trackKey: input.trackKey,
        occurrenceKey: input.occurrenceKey,
        attemptId: input.attemptId ?? null,
        sourceMediaId: input.sourceMediaId ?? reservation.sourceMediaId,
        sourceOffsetMs: requestedOffset,
        state: "active",
        interruptedAt: null,
        resumedAt: null,
        updatedAt: at,
      };
      database
        .prepare(
          "INSERT INTO airing_active_occurrences(track_key, occurrence_key, attempt_id, source_media_id, source_offset_ms, state, interrupted_at, resumed_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.trackKey,
          record.occurrenceKey,
          record.attemptId,
          record.sourceMediaId,
          record.sourceOffsetMs,
          record.state,
          record.interruptedAt,
          record.resumedAt,
          at,
          JSON.stringify(record),
        );
      setOccurrenceState(record.occurrenceKey, "active", at);
      return accepted(record, true);
    },
  );

  const writeActive = (record: ActiveOccurrence, at: string) => {
    database
      .prepare(
        "UPDATE airing_active_occurrences SET source_offset_ms = ?, state = ?, interrupted_at = ?, resumed_at = ?, updated_at = ?, json = ? WHERE track_key = ?",
      )
      .run(
        record.sourceOffsetMs,
        record.state,
        record.interruptedAt,
        record.resumedAt,
        at,
        JSON.stringify(record),
        record.trackKey,
      );
  };

  const advanceOccurrenceOffset = database.transaction(
    (input: { trackKey: string; sourceOffsetMs: number; at?: string }) => {
      const at = input.at ?? now();
      const active = activeOccurrence(input.trackKey);
      if (!active)
        return refusal<ActiveOccurrence>(
          "no-active-occurrence",
          `no active occurrence on ${input.trackKey}`,
        );
      const reservation = occurrence(active.occurrenceKey);
      if (
        !reservation ||
        !Number.isFinite(input.sourceOffsetMs) ||
        input.sourceOffsetMs > reservation.sourceEndMs
      ) {
        return refusal<ActiveOccurrence>(
          "invalid-interval",
          `source offset ${input.sourceOffsetMs} is outside the active occurrence`,
        );
      }
      if (input.sourceOffsetMs < active.sourceOffsetMs) {
        return refusal<ActiveOccurrence>(
          "offset-regression",
          `${input.sourceOffsetMs} < ${active.sourceOffsetMs}`,
        );
      }
      const record: ActiveOccurrence = {
        ...active,
        sourceOffsetMs: input.sourceOffsetMs,
        updatedAt: at,
      };
      writeActive(record, at);
      return accepted(record, false);
    },
  );

  const interruptOccurrence = database.transaction(
    (input: { trackKey: string; sourceOffsetMs?: number; at?: string }) => {
      const at = input.at ?? now();
      const active = activeOccurrence(input.trackKey);
      if (!active)
        return refusal<ActiveOccurrence>(
          "no-active-occurrence",
          `no active occurrence on ${input.trackKey}`,
        );
      const reservation = occurrence(active.occurrenceKey);
      if (
        !reservation ||
        (input.sourceOffsetMs !== undefined &&
          (!Number.isFinite(input.sourceOffsetMs) ||
            input.sourceOffsetMs > reservation.sourceEndMs))
      ) {
        return refusal<ActiveOccurrence>(
          "invalid-interval",
          `source offset ${input.sourceOffsetMs} is outside the active occurrence`,
        );
      }
      if (
        input.sourceOffsetMs !== undefined &&
        input.sourceOffsetMs < active.sourceOffsetMs
      ) {
        return refusal<ActiveOccurrence>(
          "offset-regression",
          `${input.sourceOffsetMs} < ${active.sourceOffsetMs}`,
        );
      }
      const record: ActiveOccurrence = {
        ...active,
        sourceOffsetMs: input.sourceOffsetMs ?? active.sourceOffsetMs,
        state: "interrupted",
        interruptedAt: at,
        updatedAt: at,
      };
      writeActive(record, at);
      setOccurrenceState(record.occurrenceKey, "interrupted", at);
      return accepted(record, false);
    },
  );

  const resumeActiveOccurrence = database.transaction(
    (input: { trackKey: string; at?: string }) => {
      const at = input.at ?? now();
      const active = activeOccurrence(input.trackKey);
      if (!active)
        return refusal<ActiveOccurrence>(
          "no-active-occurrence",
          `no active occurrence on ${input.trackKey}`,
        );
      if (active.state === "active") return accepted(active, false);
      const record: ActiveOccurrence = {
        ...active,
        state: "active",
        resumedAt: at,
        updatedAt: at,
      };
      writeActive(record, at);
      setOccurrenceState(record.occurrenceKey, "active", at);
      return accepted(record, false);
    },
  );

  /**
   * The explicit clear that lets another occurrence start. Completion clears
   * the active row on its own; this is for an occurrence that was abandoned
   * (cancelled, superseded, failed) without completing. It is the only way to
   * release the track outside a successful completion.
   */
  const clearActiveOccurrence = database.transaction(
    (input: { trackKey: string; occurrenceKey?: string; at?: string }) => {
      const at = input.at ?? now();
      const active = activeOccurrence(input.trackKey);
      if (!active)
        return refusal<ActiveOccurrence>(
          "no-active-occurrence",
          `no active occurrence on ${input.trackKey}`,
        );
      if (input.occurrenceKey && input.occurrenceKey !== active.occurrenceKey) {
        return refusal<ActiveOccurrence>(
          "active-occurrence-mismatch",
          `${active.occurrenceKey} is active on ${input.trackKey}, not ${input.occurrenceKey}`,
        );
      }
      database
        .prepare("DELETE FROM airing_active_occurrences WHERE track_key = ?")
        .run(input.trackKey);
      setOccurrenceState(active.occurrenceKey, "abandoned", at);
      return accepted(active, false);
    },
  );

  const evaluateOccurrence = (
    occurrenceKey: string,
  ): OccurrenceEvaluation | undefined => {
    const reservation = occurrence(occurrenceKey);
    if (!reservation) return undefined;
    const start = reservation.sourceStartMs;
    const end = reservation.sourceEndMs;
    const published = publishedIntervals(occurrenceKey).filter(
      (interval) => interval.sourceMediaId === reservation.sourceMediaId,
    );
    const aired = airedIntervals(occurrenceKey).filter(
      (interval) => interval.sourceMediaId === reservation.sourceMediaId,
    );
    const publishedCoverage = coverageOf(published, start, end);
    const airedCoverage = coverageOf(aired, start, end);
    const explicitAiredInterval = aired.length > 0;
    return {
      occurrenceKey,
      sourceStartMs: start,
      sourceEndMs: end,
      publishedCoverageMs: publishedCoverage.coveredMs,
      airedCoverageMs: airedCoverage.coveredMs,
      contiguousPublished: publishedCoverage.contiguous,
      explicitAiredInterval,
      contiguousAired: airedCoverage.contiguous,
      complete:
        publishedCoverage.contiguous &&
        explicitAiredInterval &&
        airedCoverage.contiguous,
    };
  };

  const completeOccurrence = database.transaction(
    (input: { occurrenceKey: string; at?: string }) => {
      const at = input.at ?? now();
      const reservation = occurrence(input.occurrenceKey);
      if (!reservation) {
        return refusal<CompletionCredit>(
          "unknown-occurrence",
          `no occurrence ${input.occurrenceKey}`,
        );
      }
      const evaluation = evaluateOccurrence(input.occurrenceKey)!;
      if (!evaluation.complete) {
        const gaps = [
          evaluation.contiguousPublished
            ? undefined
            : "published coverage is not contiguous",
          evaluation.explicitAiredInterval
            ? undefined
            : "no explicit aired interval",
          evaluation.contiguousAired
            ? undefined
            : "aired coverage is not contiguous",
        ].filter((item): item is string => item !== undefined);
        return refusal<CompletionCredit>(
          "insufficient-evidence",
          gaps.join("; "),
        );
      }
      const hold = trackHold(reservation.trackKey);
      if (hold) return refusal<CompletionCredit>("track-held", hold.reason);
      const floor = completionFloor(reservation.trackKey);
      const identity = episodeIdentity(reservation.episodeKey);
      if (!identity || identity.trackKey !== reservation.trackKey) {
        return refusal<CompletionCredit>(
          "unknown-episode",
          `${reservation.episodeKey} is not registered`,
        );
      }
      const position = positionOf(identity);
      if (floor) {
        if (floor.completedOccurrenceKey === input.occurrenceKey) {
          return accepted({ credited: true, floor, evaluation }, false);
        }
        const floorPosition = positionOf(floor);
        const order = comparePositions(position, floorPosition);
        if (order <= 0) {
          return refusal<CompletionCredit>(
            "already-credited",
            `${reservation.episodeKey} (${describePosition(position)}) is at or behind the floor ${describePosition(floorPosition)}`,
          );
        }
        // Gap-aware: a successor is the numerically next episode, not merely the
        // next identity that happens to be registered. A missing E11 leaves the
        // floor at E10 and E12 is still predecessor-incomplete.
        if (!isImmediateSuccessor(floorPosition, position)) {
          return refusal<CompletionCredit>(
            "predecessor-incomplete",
            `${expectedSuccessor(floorPosition)} must be credited before ${reservation.episodeKey}`,
          );
        }
      } else {
        // No floor yet. Refuse to treat "first registered" as "first aired": a
        // gap-adjacent or late-registered episode must not become the floor just
        // because it arrived before its predecessors. Only the unambiguous
        // opener, or an explicit migrated/initial position, may open the track.
        const initial =
          seriesTrack(reservation.trackKey)?.initialPosition ?? null;
        if (initial) {
          const order = comparePositions(position, initial);
          if (order < 0) {
            return refusal<CompletionCredit>(
              "already-credited",
              `${reservation.episodeKey} (${describePosition(position)}) is behind the initial position ${describePosition(initial)}`,
            );
          }
          if (position.positionKey !== initial.positionKey) {
            return refusal<CompletionCredit>(
              "predecessor-incomplete",
              `${describePosition(initial)} must be credited before ${reservation.episodeKey}`,
            );
          }
        } else if (!isUnambiguousOpener(position)) {
          return refusal<CompletionCredit>(
            "predecessor-incomplete",
            `${reservation.episodeKey} (${describePosition(position)}) cannot open ${reservation.trackKey}; credit an unambiguous opener or establish an explicit initial position`,
          );
        }
      }
      const credited: CompletionFloor = {
        trackKey: reservation.trackKey,
        season: identity.season,
        episode: identity.episode,
        ordinal: identity.ordinal,
        positionKey: identity.positionKey,
        completedEpisodeKey: identity.episodeKey,
        completedOccurrenceKey: reservation.occurrenceKey,
        completedAt: at,
        updatedAt: at,
      };
      database
        .prepare(
          "INSERT INTO airing_completion_floors(track_key, season, episode, ordinal, position_key, completed_episode_key, completed_occurrence_key, completed_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(track_key) DO UPDATE SET season = excluded.season, episode = excluded.episode, ordinal = excluded.ordinal, position_key = excluded.position_key, completed_episode_key = excluded.completed_episode_key, completed_occurrence_key = excluded.completed_occurrence_key, completed_at = excluded.completed_at, updated_at = excluded.updated_at, json = excluded.json",
        )
        .run(
          credited.trackKey,
          credited.season,
          credited.episode,
          credited.ordinal,
          credited.positionKey,
          credited.completedEpisodeKey,
          credited.completedOccurrenceKey,
          credited.completedAt,
          at,
          JSON.stringify(credited),
        );
      setOccurrenceState(reservation.occurrenceKey, "completed", at);
      const active = activeOccurrence(reservation.trackKey);
      if (active?.occurrenceKey === reservation.occurrenceKey) {
        database
          .prepare("DELETE FROM airing_active_occurrences WHERE track_key = ?")
          .run(reservation.trackKey);
      }
      return accepted({ credited: true, floor: credited, evaluation }, true);
    },
  );

  return {
    ensureSeriesTrack,
    seriesTrack,
    establishInitialPosition,
    ensureEpisodeIdentity,
    episodeIdentity,
    episodeIdentities,
    holdTrack,
    trackHold,
    releaseTrackHold,
    reserveOccurrence,
    occurrence,
    occurrencesForTrack,
    recordAttempt,
    attemptsFor,
    recordPublishedInterval,
    recordAiredInterval,
    recordPodExposure,
    podExposure,
    podExposuresForPod,
    publishedIntervals,
    airedIntervals,
    beginOccurrence,
    advanceOccurrenceOffset,
    interruptOccurrence,
    resumeActiveOccurrence,
    clearActiveOccurrence,
    activeOccurrence,
    evaluateOccurrence,
    completeOccurrence,
    completionFloor,
  };
}

export type AiringLedger = ReturnType<typeof createAiringLedger>;
