import type { TunarrLineup } from "./types.js";

/** Detect an independently edited movie lineup before replacing its commercials. */
export function assertPreservedMovies(
  original: TunarrLineup,
  from: number,
  replacement: TunarrLineup,
  movieIds: ReadonlySet<string>,
): void {
  const length = replacement.reduce((sum, item) => sum + item.duration, 0);
  const movies = (items: TunarrLineup, start: number, stop: number) => {
    let cursor = 0;
    return items.flatMap((item) => {
      const left = Math.max(cursor, start);
      const right = Math.min(cursor + item.duration, stop);
      const offset = Number(item.startOffsetMs ?? 0) + left - cursor;
      cursor += item.duration;
      return right > left &&
        "id" in item &&
        typeof item.id === "string" &&
        movieIds.has(item.id)
        ? [{ id: item.id, start: left - start, end: right - start, offset }]
        : [];
    });
  };
  const before = movies(original, from, from + length);
  const after = movies(replacement, 0, length);
  // MarkTV uses integer milliseconds; imported Tunarr durations may be fractional.
  if (
    before.length !== after.length ||
    before.some((item, index) => {
      const other = after[index]!;
      return (
        item.id !== other.id ||
        Math.abs(item.start - other.start) > 1 ||
        Math.abs(item.end - other.end) > 1 ||
        Math.abs(item.offset - other.offset) > 1
      );
    })
  )
    throw new Error("Preserved movies no longer match the live lineup");
}

/** Replace a bounded day without discarding the rest of a preserved lineup. */
export function splicePreservedLineup(
  original: TunarrLineup,
  origin: number,
  windowStart: number,
  replacement: TunarrLineup,
): TunarrLineup {
  const valid = (items: TunarrLineup) =>
    items.length > 0 &&
    items.every((item) => Number.isFinite(item.duration) && item.duration > 0);
  if (
    !valid(original) ||
    !valid(replacement) ||
    !Number.isFinite(origin) ||
    !Number.isFinite(windowStart)
  )
    throw new Error("Invalid preserved lineup");
  const from = windowStart - origin;
  const duration = replacement.reduce((sum, item) => sum + item.duration, 0);
  const to = from + duration;
  const total = original.reduce((sum, item) => sum + item.duration, 0);
  if (from < 0 || to > total)
    throw new Error("Preserved lineup does not cover the requested day");
  const prefix: TunarrLineup = [];
  const suffix: TunarrLineup = [];
  const clip = (
    item: TunarrLineup[number],
    offset: number,
    length: number,
  ): TunarrLineup[number] => {
    if (offset === 0 && length === item.duration) return item;
    if (item.type === "content" || item.type === "filler")
      return {
        type: "content",
        id: item.id,
        duration: length,
        startOffsetMs: Number(item.startOffsetMs ?? 0) + offset,
      };
    if (item.type === "flex") return { ...item, duration: length };
    throw new Error("Unsupported preserved lineup boundary");
  };
  let cursor = 0;
  for (const item of original) {
    const end = cursor + item.duration;
    if (cursor < from) prefix.push(clip(item, 0, Math.min(end, from) - cursor));
    if (end > to)
      suffix.push(
        clip(item, Math.max(cursor, to) - cursor, end - Math.max(cursor, to)),
      );
    cursor = end;
  }
  return [...prefix, ...replacement, ...suffix];
}
