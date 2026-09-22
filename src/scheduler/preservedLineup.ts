import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  broadcastDateSchema,
  mediaKinds,
  type Channel,
  type MediaItem,
  type MediaKind,
  type PreservedLineupSource,
  type Schedule,
  type ScheduleEntry,
} from "../domain/models.js";
import type { Repositories } from "../db/repositories.js";
import { canonicalJson, fingerprint } from "./random.js";

/**
 * Preserved imported lineup: an immutable archive plus a pure day-slicer.
 *
 * Some channels are not programmed by MarkTV's selection engine at all. They
 * mirror a lineup somebody else already built - a movie channel whose exact film
 * order and start instants the operator approved - and the only faithful thing a
 * scheduler can do with them is replay what was imported. So this module never
 * selects anything: it slices a requested broadcast day out of a normalized,
 * immutable archive, preserving order, start instants and mid-file offsets.
 *
 * Three properties matter more than convenience here.
 *
 * 1. **Nothing is reselected.** Every airing on the day comes from the archive, in
 *    archive order. No pool is consulted, no cooldown applies, no movie is swapped
 *    for a shorter one to close a gap.
 * 2. **Determinism is arithmetic, not luck.** Entry boundaries are rounded at the
 *    *cumulative* position (in a compensated sum) rather than per entry, so the
 *    fractional lengths imported commercial breaks carry cannot accumulate into a
 *    visible drift: a movie that starts at an integer instant in the archive still
 *    starts at exactly that instant four thousand commercials later.
 * 3. **Failure is closed.** A missing, malformed, unapproved, out-of-coverage or
 *    unmappable archive refuses the day. The ordinary scheduler is never a
 *    fallback, because airing a scheduled-from-scratch day on a preserved channel
 *    is a different product, not a degraded one.
 *
 * ## Normalized archive format (schema version 1)
 *
 * Stored as one `settings` row: `preserved-lineup:<sourceId>` -> archive JSON.
 * The parent that converts a live Tunarr snapshot owns producing this shape; the
 * worker never reads Tunarr.
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "sourceId": "channel-8-movies",          // must match the binding
 *   "generatedAt": "2026-09-22T18:00:00Z",   // optional provenance, not identity
 *   "entries": [
 *     {
 *       "startTime": 1789794000000,          // epoch ms, exact broadcast start
 *       "mediaId": "movie-042",              // MarkTV catalog id
 *       "kind": "movie",                     // episode|movie|commercial|filler|station-id|bumper
 *       "durationMs": 7020000,               // exact length; may be fractional
 *       "sourceOffsetMs": 0,                 // optional: offset into the media file
 *       "title": "The Long Goodbye"          // optional; catalog title is preferred
 *     }
 *   ],
 *   "digest": "…"                            // sha256 of the content, recomputed on read
 * }
 * ```
 *
 * Contract the converter must satisfy (validated, not assumed):
 *
 * - Entries are chronological and tile the archive with no gap and no overlap.
 * - `entries[0].startTime` is the archive anchor; every later `startTime` equals
 *   the cumulative-rounded boundary, i.e.
 *   `startTime(i) === Math.round(anchor + Σ durationMs(0…i-1))`.
 *   `preservedLineupStartTimes()` below computes exactly that array, and is the
 *   intended way for the converter to fill the field in.
 * - Durations are the *source* durations: movies are whole milliseconds, imported
 *   commercial breaks may be fractional. Fractions are absorbed by boundary
 *   rounding, never by stretching a program.
 * - `sourceOffsetMs` is where playback begins inside the media file. The converter
 *   sets it for an entry that was already mid-file when the snapshot was taken;
 *   the slicer adds the elapsed wall time when a film is cut by a day boundary.
 * - The archive is expressed in the channel's timezone; days are sliced against
 *   the channel's local midnight, which is why DST days come out 23 or 25 hours
 *   long exactly as they air.
 */

export const preservedLineupSettingPrefix = "preserved-lineup:";

export function preservedLineupSettingKey(sourceId: string): string {
  return `${preservedLineupSettingPrefix}${sourceId}`;
}

export const preservedLineupCycles = ["once", "repeat"] as const;
export type PreservedLineupCycle = (typeof preservedLineupCycles)[number];

export const preservedLineupEntrySchema = z.object({
  /** Exact broadcast start instant of this airing, epoch milliseconds. */
  startTime: z.number().int().nonnegative(),
  /** MarkTV catalog id the entry was mapped to. */
  mediaId: z.string().min(1),
  kind: z.enum(mediaKinds),
  /**
   * Exact source length. Whole milliseconds for programs, fractional for the
   * imported commercial breaks that is why boundaries are rounded cumulatively.
   */
  durationMs: z.number().positive(),
  /** Offset into the media file where this airing begins, when not zero. */
  sourceOffsetMs: z.number().nonnegative().optional(),
  /** Optional imported title; the catalog title wins when the item exists. */
  title: z.string().min(1).optional(),
});
export type PreservedLineupEntry = z.infer<typeof preservedLineupEntrySchema>;

export const preservedLineupArchiveSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.string().min(1),
  generatedAt: z.string().min(1).optional(),
  entries: z.array(preservedLineupEntrySchema).min(1),
  digest: z.string().min(1).optional(),
});
export type PreservedLineupArchive = z.infer<typeof preservedLineupArchiveSchema>;

export type PreservedLineupIssueCode =
  | "PRESERVED_LINEUP_MISSING"
  | "PRESERVED_LINEUP_INVALID"
  | "PRESERVED_LINEUP_DIGEST_MISMATCH"
  | "PRESERVED_LINEUP_OUT_OF_RANGE"
  | "PRESERVED_LINEUP_EXHAUSTED"
  | "PRESERVED_LINEUP_COVERAGE_GAP"
  | "PRESERVED_LINEUP_MEDIA_MISSING"
  | "PRESERVED_LINEUP_MEDIA_UNAVAILABLE";

export type PreservedLineupIssue = {
  code: PreservedLineupIssueCode;
  path: string;
  message: string;
};

export type PreservedLineupNormalization =
  | { ok: true; archive: PreservedLineupArchive }
  | { ok: false; issues: PreservedLineupIssue[] };

const issue = (
  code: PreservedLineupIssueCode,
  path: string,
  message: string,
): PreservedLineupIssue => ({ code, path, message });

/**
 * Cumulative boundaries with compensated summation.
 *
 * The archive carries ~43k entries whose fractional commercial lengths would,
 * summed naively, drift by a fraction of a millisecond and - worse - drift
 * differently depending on the order the runtime happens to add them. Kahan
 * compensation makes the running total accurate to a few microseconds over a
 * full year, so `Math.round` lands on the same integer boundary every time the
 * same archive is sliced, on any machine.
 */
function cumulativeBoundaries(
  anchorMs: number,
  entries: ReadonlyArray<{ durationMs: number }>,
): number[] {
  const boundaries = new Array<number>(entries.length + 1);
  boundaries[0] = anchorMs;
  let total = 0;
  let compensation = 0;
  for (const [index, entry] of entries.entries()) {
    const addend = entry.durationMs - compensation;
    const next = total + addend;
    compensation = next - total - addend;
    total = next;
    boundaries[index + 1] = Math.round(anchorMs + total);
  }
  return boundaries;
}

/**
 * The canonical start instant of every entry, anchored at the first one.
 *
 * Exported so the converter that normalizes a live snapshot can write the exact
 * `startTime` values this module validates against instead of re-deriving them.
 */
export function preservedLineupStartTimes(
  anchorMs: number,
  entries: ReadonlyArray<{ durationMs: number }>,
): number[] {
  return cumulativeBoundaries(anchorMs, entries);
}

/**
 * Content digest of a normalized archive.
 *
 * Over the content only, in canonical JSON: provenance timestamps and a
 * previously stored `digest` field are not part of identity, so re-storing the
 * same lineup mints the same schedule revision.
 */
export function preservedLineupDigest(
  archive: Pick<PreservedLineupArchive, "schemaVersion" | "sourceId" | "entries">,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: archive.schemaVersion,
        sourceId: archive.sourceId,
        entries: archive.entries,
      }),
    )
    .digest("hex");
}

/**
 * Validate and canonicalize an archive as read from storage.
 *
 * Returns issues rather than throwing: this runs inside schedule generation, and
 * a corrupt row has to become a refused day, not an exception escaping through
 * the scheduler.
 */
export function normalizePreservedLineup(
  raw: unknown,
): PreservedLineupNormalization {
  const parsed = preservedLineupArchiveSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_INVALID",
          first?.path.join(".") || "archive",
          first?.message ?? "Preserved lineup archive is not a valid v1 archive",
        ),
      ],
    };
  }
  const archive = parsed.data;
  const boundaries = cumulativeBoundaries(
    archive.entries[0].startTime,
    archive.entries,
  );
  for (const [index, entry] of archive.entries.entries()) {
    if (entry.startTime !== boundaries[index])
      return {
        ok: false,
        issues: [
          issue(
            "PRESERVED_LINEUP_INVALID",
            `entries.${index}.startTime`,
            `Entry start ${entry.startTime} does not match its cumulative boundary ${boundaries[index]}: the archive must tile its span without gap or overlap`,
          ),
        ],
      };
  }
  const digest = preservedLineupDigest(archive);
  if (archive.digest && archive.digest !== digest)
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_DIGEST_MISMATCH",
          "digest",
          `Stored archive digest ${archive.digest} does not match its content (${digest})`,
        ),
      ],
    };
  return { ok: true, archive: { ...archive, digest } };
}

/**
 * Read the archive bound to a channel.
 *
 * Missing and malformed are distinguished, and both are terminal: generation
 * fails closed, it never falls back to ordinary selection.
 */
export function readPreservedLineup(
  repositories: Repositories,
  binding: PreservedLineupSource,
): PreservedLineupNormalization {
  const key = preservedLineupSettingKey(binding.sourceId);
  const stored = repositories.settings.get(key)?.value;
  if (stored === undefined)
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_MISSING",
          "channel.preservedLineup",
          `No preserved lineup archive is stored at ${key}`,
        ),
      ],
    };
  const normalized = normalizePreservedLineup(stored);
  if (normalized.ok === false) return normalized;
  if (binding.digest && binding.digest !== normalized.archive.digest)
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_DIGEST_MISMATCH",
          "channel.preservedLineup.digest",
          `Channel is bound to archive ${binding.digest} but ${key} holds ${normalized.archive.digest}`,
        ),
      ],
    };
  return normalized;
}

/**
 * Normalize and store an archive, for the import path that owns the snapshot.
 *
 * The stored row is the normalized archive *with* its digest, so a later reader
 * can prove the content it sliced is the content that was imported.
 */
export function writePreservedLineup(
  repositories: Repositories,
  raw: unknown,
): PreservedLineupNormalization {
  const normalized = normalizePreservedLineup(raw);
  if (normalized.ok === false) return normalized;
  repositories.settings.put(
    preservedLineupSettingKey(normalized.archive.sourceId),
    normalized.archive,
  );
  return normalized;
}

/** One archive airing, clipped to the requested broadcast day. */
export type PreservedLineupClip = {
  /** Index of the archive entry this clip came from, for diagnostics. */
  sourceIndex: number;
  mediaId: string;
  kind: MediaKind;
  title?: string;
  /** Broadcast start, epoch ms - always inside the requested day. */
  start: number;
  end: number;
  durationMs: number;
  /** Offset into the media file where this clipped airing begins. */
  sourceOffsetMs: number;
};

export type PreservedLineupSlice =
  | { ok: true; clips: PreservedLineupClip[] }
  | { ok: false; issues: PreservedLineupIssue[] };

/**
 * Slice exactly one broadcast day out of the archive.
 *
 * Pure: the same archive, date, timezone and cycle always produce the same clips,
 * and nothing is consulted beyond them. Only the requested day is materialized -
 * the caller builds one schedule, which is what keeps a year-long archive from
 * becoming a year of stored schedules (retention stays at its existing 90).
 *
 * Day boundaries come from the channel timezone, so a DST day is 23 or 25 hours
 * of archive exactly as it airs. A program straddling either boundary is clipped
 * at it, and the continuation keeps its place: the tail that airs tomorrow starts
 * at the day start with `sourceOffsetMs` advanced by the elapsed wall time, so the
 * film resumes rather than restarting.
 */
export function slicePreservedLineupDay(input: {
  archive: PreservedLineupArchive;
  date: string;
  timezone: string;
  cycle: PreservedLineupCycle;
}): PreservedLineupSlice {
  const parsedDate = broadcastDateSchema.safeParse(input.date);
  const start = parsedDate.success
    ? DateTime.fromISO(input.date, { zone: input.timezone }).startOf("day")
    : DateTime.invalid("invalid date");
  if (!start.isValid)
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_INVALID",
          "date",
          `Cannot slice ${input.date} in ${input.timezone}`,
        ),
      ],
    };
  const end = start.plus({ days: 1 });
  const dayStartMs = start.toMillis();
  const dayEndMs = end.toMillis();
  if (dayEndMs <= dayStartMs)
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_INVALID",
          "date",
          `Broadcast day ${input.date} has no duration in ${input.timezone}`,
        ),
      ],
    };

  const { entries } = input.archive;
  const boundaries = cumulativeBoundaries(entries[0].startTime, entries);
  const archiveStart = boundaries[0];
  const archiveEnd = boundaries[boundaries.length - 1];
  const span = archiveEnd - archiveStart;
  const dayMs = dayEndMs - dayStartMs;
  if (span < dayMs)
    return {
      ok: false,
      issues: [
        issue(
          "PRESERVED_LINEUP_OUT_OF_RANGE",
          "entries",
          `Archive spans ${span}ms, shorter than the ${dayMs}ms broadcast day ${input.date}, so it cannot be sliced or repeated`,
        ),
      ],
    };

  // Placement on the archive's own timeline. `once` must land inside it entirely;
  // a day that only half-exists is refused rather than partly filled, because a
  // half-preserved day is exactly the degraded product this channel must not air.
  let offset = 0;
  if (dayStartMs < archiveStart || dayEndMs > archiveEnd) {
    if (input.cycle !== "repeat")
      return {
        ok: false,
        issues: [
          dayEndMs > archiveEnd
            ? issue(
                "PRESERVED_LINEUP_EXHAUSTED",
                "entries",
                `Archive coverage ends ${new Date(archiveEnd).toISOString()} and does not reach the end of broadcast day ${input.date}`,
              )
            : issue(
                "PRESERVED_LINEUP_OUT_OF_RANGE",
                "entries",
                `Archive coverage begins ${new Date(archiveStart).toISOString()}, after the start of broadcast day ${input.date}`,
              ),
        ],
      };
    offset = Math.floor((dayStartMs - archiveStart) / span) * span;
    // Floor places the window inside the archive's own period; the guard keeps a
    // future change to the arithmetic from slicing outside the coverage.
    if (dayStartMs - offset < archiveStart || dayStartMs - offset >= archiveEnd)
      return {
        ok: false,
        issues: [
          issue(
            "PRESERVED_LINEUP_OUT_OF_RANGE",
            "entries",
            `Archive covers ${new Date(archiveStart).toISOString()}–${new Date(archiveEnd).toISOString()}, which cannot be tiled onto broadcast day ${input.date}`,
          ),
        ],
      };
  }
  const windowStart = dayStartMs - offset;
  const windowEnd = dayEndMs - offset;

  // Where this day sits on the archive's own timeline. A looping archive whose
  // span is not a whole number of days runs off its end mid-day, and a loop means
  // exactly that the end is followed by the start: the day continues from the top
  // of the archive rather than being refused or, worse, ending early.
  const windows =
    windowEnd <= archiveEnd
      ? [{ start: windowStart, end: windowEnd, shift: 0 }]
      : [
          { start: windowStart, end: archiveEnd, shift: 0 },
          {
            start: archiveStart,
            end: archiveStart + (windowEnd - archiveEnd),
            shift: span,
          },
        ];

  const clips: PreservedLineupClip[] = [];
  for (const window of windows) {
    let covered = window.start;
    for (const [index, entry] of entries.entries()) {
      const entryStart = boundaries[index];
      const entryEnd = boundaries[index + 1];
      if (entryEnd <= window.start) continue;
      if (entryStart >= window.end) break;
      const clipStart = Math.max(entryStart, window.start);
      const clipEnd = Math.min(entryEnd, window.end);
      if (clipStart > covered)
        return {
          ok: false,
          issues: [
            issue(
              "PRESERVED_LINEUP_COVERAGE_GAP",
              `entries.${index}`,
              `Archive has no airing between ${new Date(covered).toISOString()} and ${new Date(clipStart).toISOString()}`,
            ),
          ],
        };
      if (clipEnd <= clipStart) continue;
      clips.push({
        sourceIndex: index,
        mediaId: entry.mediaId,
        kind: entry.kind,
        ...(entry.title ? { title: entry.title } : {}),
        // Clip positions are matched on the archive's own timeline and then moved
        // back onto the requested day: a repeated archive still airs at this
        // day's instants, it does not air last week's.
        start: clipStart + offset + window.shift,
        end: clipEnd + offset + window.shift,
        durationMs: clipEnd - clipStart,
        // A clipped film resumes a fixed number of milliseconds further into the
        // file than the archive entry itself began. Both halves of the film
        // therefore point at one continuous source, which is what lets Tunarr
        // continue it instead of replaying the opening.
        sourceOffsetMs: Math.round(
          (entry.sourceOffsetMs ?? 0) + (clipStart - entryStart),
        ),
      });
      covered = clipEnd;
    }
    if (covered !== window.end)
      return {
        ok: false,
        issues: [
          issue(
            "PRESERVED_LINEUP_COVERAGE_GAP",
            "entries",
            `Archive coverage stops at ${new Date(covered).toISOString()}, before the end of broadcast day ${input.date}`,
          ),
        ],
      };
  }
  return { ok: true, clips };
}

export type PreservedLineupBuild =
  | { ok: true; schedule: Schedule }
  | { ok: false; issues: PreservedLineupIssue[] };

/**
 * Build the stored schedule for one preserved broadcast day.
 *
 * The archive decides what airs and when; the catalog only supplies the local
 * path and title the rest of the pipeline needs to play it. An archive entry
 * whose MarkTV media id is absent - or has no usable path - refuses the day
 * instead of dropping the airing, because dropping a program silently rewrites
 * the lineup the operator approved.
 *
 * The archive digest is folded into the schedule identity, so a re-imported
 * lineup is a new revision even for a date that was already generated.
 */
export function buildPreservedLineupSchedule(input: {
  channel: Channel;
  binding: PreservedLineupSource;
  archive: PreservedLineupArchive;
  date: string;
  media: readonly MediaItem[];
  now: Date;
}): PreservedLineupBuild {
  const slice = slicePreservedLineupDay({
    archive: input.archive,
    date: input.date,
    timezone: input.channel.timezone,
    cycle: input.binding.cycle,
  });
  if (slice.ok === false) return slice;

  const digest = input.archive.digest ?? preservedLineupDigest(input.archive);
  const mediaById = new Map(input.media.map((item) => [item.id, item]));
  const zone = input.channel.timezone;
  const start = DateTime.fromISO(input.date, { zone }).startOf("day");
  const end = start.plus({ days: 1 });
  const entries: ScheduleEntry[] = [];
  for (const clip of slice.clips) {
    const item = mediaById.get(clip.mediaId);
    if (!item)
      return {
        ok: false,
        issues: [
          issue(
            "PRESERVED_LINEUP_MEDIA_MISSING",
            `entries.${clip.sourceIndex}`,
            `Preserved airing ${clip.mediaId} is not in the MarkTV catalog`,
          ),
        ],
      };
    if (!item.path)
      return {
        ok: false,
        issues: [
          issue(
            "PRESERVED_LINEUP_MEDIA_UNAVAILABLE",
            `entries.${clip.sourceIndex}`,
            `Preserved airing ${clip.mediaId} (${item.title}) has no local path`,
          ),
        ],
      };
    entries.push({
      id: `preserved-${clip.start}`,
      start: new Date(clip.start).toISOString(),
      end: new Date(clip.end).toISOString(),
      localStart: DateTime.fromMillis(clip.start, { zone }).toFormat("HH:mm"),
      localEnd: DateTime.fromMillis(clip.end, { zone }).toFormat("HH:mm"),
      durationMs: clip.durationMs,
      ...(clip.sourceOffsetMs > 0
        ? { sourceOffsetMs: clip.sourceOffsetMs }
        : {}),
      kind: clip.kind,
      title: clip.title ?? item.title,
      mediaId: clip.mediaId,
      path: item.path,
      source: input.binding.sourceId,
      selectionExplanation: `Preserved ${input.binding.sourceId} lineup, import entry ${clip.sourceIndex}`,
    });
  }

  const generationId = fingerprint({
    channel: input.channel.id,
    date: input.date,
    preservedLineup: {
      sourceId: input.binding.sourceId,
      digest,
      cycle: input.binding.cycle,
    },
  });
  const seed = `${input.channel.id}:${input.date}:${generationId}`;
  return {
    ok: true,
    schedule: {
      id: `${input.channel.id}-${input.date}-${generationId}`,
      channelId: input.channel.id,
      date: input.date,
      timezone: zone,
      seed,
      revision: input.channel.revision,
      generatedAt: input.now.toISOString(),
      durationMs: end.toMillis() - start.toMillis(),
      entries,
      diagnostics: [
        {
          code: "PRESERVED_LINEUP_APPLIED",
          message: `Preserved lineup ${input.binding.sourceId}: ${entries.length} airings from archive ${digest.slice(0, 12)}`,
        },
      ],
      channelName: input.channel.name,
      channelNumber: input.channel.number,
      breakPolicy: input.channel.breakPolicy,
    },
  };
}
