import { DateTime } from "luxon";
import type { MediaItem, Schedule, ScheduleEntry } from "../domain/models.js";
import type { ContinuityAiring, ContinuityContext } from "./types.js";
import { normalizeMovieTitle, normalizeSeriesTitle } from "./wording.js";

type Input = {
  schedules: Schedule[];
  media: MediaItem[];
  insertionInstant: string;
  managedLineup: boolean;
};

const editorial = (entry: ScheduleEntry) =>
  entry.kind === "episode" || entry.kind === "movie";

const logicalAiringId = (entry: ScheduleEntry) =>
  entry.kind === "movie" && entry.movieOccurrenceKey
    ? entry.movieOccurrenceKey
    : entry.id;

const sameEditorialTitle = (
  left: ContinuityAiring | null,
  right: ContinuityAiring,
) =>
  Boolean(
    left &&
      (left.showTitle ?? left.title).localeCompare(
        right.showTitle ?? right.title,
        undefined,
        { sensitivity: "base" },
      ) === 0,
  );

export function deriveContinuityContext(input: Input): ContinuityContext {
  if (!input.schedules.length) throw new Error("Continuity context requires a finalized schedule");
  const schedules = [...input.schedules].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const primary = schedules.find((candidate) =>
    candidate.entries.some(
      (entry) => entry.start <= input.insertionInstant && entry.end > input.insertionInstant,
    ),
  ) ?? schedules[0];
  const entries = schedules.flatMap((schedule) => schedule.entries).sort((left, right) =>
    left.start.localeCompare(right.start),
  );
  const mediaById = new Map(input.media.map((item) => [item.id, item]));
  const usableEditorial = (entry: ScheduleEntry) => {
    if (!editorial(entry) || !entry.mediaId) return false;
    const media = mediaById.get(entry.mediaId);
    return Boolean(
      media?.available && media.path && media.durationMs && media.durationStatus === "ok",
    );
  };
  const toAiring = (entry: ScheduleEntry, current: ContinuityAiring | null): ContinuityAiring => {
    const media = entry.mediaId ? mediaById.get(entry.mediaId) : undefined;
    // Episodes are named by the series; a film is always named by its own
    // title, even if a scanned record accidentally carries a show title. Either
    // way the catalog is authoritative when the entry only carries an internal
    // label, and a scanned all-lower-case series name is presented the way a
    // card should read it.
    const isMovie = entry.kind === "movie";
    const showTitle = isMovie ? undefined : normalizeSeriesTitle(media?.showTitle);
    const title = isMovie
      ? normalizeMovieTitle(media?.title ?? entry.title)!
      : showTitle ?? normalizeMovieTitle(media?.title ?? entry.title)!;
    return {
      airingId: logicalAiringId(entry),
      mediaId: entry.mediaId!,
      title,
      showTitle,
      start: entry.start,
      kind: entry.kind as "episode" | "movie",
      movieOccurrenceKey: entry.movieOccurrenceKey,
      movieRole: entry.movieRole,
      sameSeriesAsCurrent: sameEditorialTitle(current, {
        airingId: logicalAiringId(entry),
        mediaId: entry.mediaId!,
        title,
        showTitle: media?.showTitle,
        start: entry.start,
        kind: entry.kind as "episode" | "movie",
        movieOccurrenceKey: entry.movieOccurrenceKey,
        movieRole: entry.movieRole,
        sameSeriesAsCurrent: false,
      }),
      ...(entry.sourceOffsetMs ? { alreadyStarted: true } : {}),
    };
  };

  const containing = entries.find(
    (entry) =>
      usableEditorial(entry) &&
      entry.start <= input.insertionInstant &&
      entry.end > input.insertionInstant,
  );
  const previous = [...entries]
    .reverse()
    .find((entry) => usableEditorial(entry) && entry.end <= input.insertionInstant);
  const currentEntry = containing ?? previous;
  const current = currentEntry ? toAiring(currentEntry, null) : null;
  const after = containing?.end ?? input.insertionInstant;
  /**
   * NEXT names the immediately following scheduled programme.
   *
   * It deliberately does not step over an unusable airing to advertise a later
   * one: a card that says "NEXT Roseanne" while the slot Tunarr will actually
   * play is something else would be a lie, so an unavailable immediate airing
   * simply produces no NEXT card.
   */
  const immediateNext = entries.find(
    (entry) =>
      editorial(entry) &&
      entry.start >= after &&
      entry.id !== currentEntry?.id &&
      logicalAiringId(entry) !== (currentEntry ? logicalAiringId(currentEntry) : undefined),
  );
  const nextEntry = immediateNext && usableEditorial(immediateNext) ? immediateNext : undefined;
  const next = nextEntry ? toAiring(nextEntry, current) : null;
  const nextIndex = nextEntry ? entries.indexOf(nextEntry) : -1;
  const laterEntry = (() => {
    if (!next) return undefined;
    // A useful "later" programme is distinct from both what is on now and what
    // is on next; a NEXT/LATER card that named the same series twice would be
    // noise rather than information.
    const candidates = entries
      .slice(nextIndex + 1)
      .filter((entry) => {
        if (!usableEditorial(entry)) return false;
        const candidate = toAiring(entry, current);
        return (
          !sameEditorialTitle(next, candidate) &&
          !sameEditorialTitle(current, candidate)
        );
      });
    if (!candidates.length) return undefined;
    // Prefer something that actually follows within 30-120 minutes; otherwise
    // fall back to the first distinct programme so the card is never empty.
    const lower = Date.parse(input.insertionInstant) + 30 * 60_000;
    const upper = Date.parse(input.insertionInstant) + 120 * 60_000;
    return (
      candidates.find((entry) => {
        const at = Date.parse(entry.start);
        return at >= lower && at <= upper;
      }) ?? candidates[0]
    );
  })();
  const later = laterEntry ? toAiring(laterEntry, current) : null;

  const local = DateTime.fromISO(input.insertionInstant, { setZone: true }).setZone(primary.timezone);
  const overnight = local.hour < 6;
  /**
   * Time-relative promotions stay on after midnight.
   *
   * The context window already restricts them to genuinely future airings, and
   * the director relabels them (THE 2 AM MOVIE / THE LATE MOVIE) so a promotion
   * that airs at 1 AM never claims a programme is "tonight" when it is not.
   */
  const allowTimeRelativePromos = input.managedLineup;
  const windowStart = overnight ? local : local.startOf("day").set({ hour: 18 });
  const windowEnd = overnight
    ? local.startOf("day").set({ hour: 6 })
    : local.plus({ days: 1 }).startOf("day").set({ hour: 6 });
  /**
   * Programmes that may be promoted as something that is still ahead.
   *
   * A film that crossed midnight from the previous day is one logical airing
   * spread over several entries; only its first entry is a promotion candidate
   * and a resumed tail is never advertised as a new premiere.
   */
  const seenLogical = new Set<string>();
  const promotable = entries.filter((entry) => {
    if (!usableEditorial(entry)) return false;
    if (entry.start < input.insertionInstant) return false;
    const logical = logicalAiringId(entry);
    if (seenLogical.has(logical)) return false;
    seenLogical.add(logical);
    return !entry.sourceOffsetMs;
  });
  const tonight = allowTimeRelativePromos
    ? promotable
        .filter((entry) => {
          const at = Date.parse(entry.start);
          return at >= Math.max(Date.parse(input.insertionInstant), windowStart.toMillis()) &&
            at < windowEnd.toMillis();
        })
        .map((entry) => toAiring(entry, current))
    : [];

  /**
   * The configured weekend double feature.
   *
   * Derived from the movie-programming roles the scheduler wrote, never from
   * "two films that happen to be on this weekend": an opener and its closer
   * share an occurrence key prefix, which is what makes them one block.
   */
  let weekendPair: [ContinuityAiring, ContinuityAiring] | null = null;
  if (allowTimeRelativePromos) {
    const weekendMovies = promotable.filter((entry) => entry.kind === "movie");
    const openers = weekendMovies.filter((entry) => entry.movieRole === "weekend-opener");
    for (const opener of openers) {
      const prefix = opener.movieOccurrenceKey?.split(":")[0];
      const closer = weekendMovies.find(
        (entry) =>
          entry !== opener &&
          (entry.movieRole === "weekend-closer" || entry.movieRole === "encore") &&
          entry.start > opener.start &&
          (prefix
            ? entry.movieOccurrenceKey?.startsWith(prefix)
            : DateTime.fromISO(entry.start, { setZone: true })
                .setZone(primary.timezone)
                .toISODate() ===
              DateTime.fromISO(opener.start, { setZone: true })
                .setZone(primary.timezone)
                .toISODate()),
      );
      if (closer) {
        weekendPair = [toAiring(opener, current), toAiring(closer, current)];
        break;
      }
    }
  }

  return {
    channelId: primary.channelId,
    scheduleId: primary.id,
    // The schedule ID contains the generation fingerprint. Channel revision
    // alone cannot distinguish two regenerated lineups with different media.
    scheduleRevision: primary.id,
    timezone: primary.timezone,
    insertionInstant: input.insertionInstant,
    current,
    returnTarget: containing ? current : null,
    next,
    later,
    tonight,
    weekendPair,
    presentationLabel: overnight ? "OVERNIGHT" : tonight.length ? "TONIGHT" : "COMING UP",
    allowTimeRelativePromos,
    managedLineup: input.managedLineup,
  };
}
