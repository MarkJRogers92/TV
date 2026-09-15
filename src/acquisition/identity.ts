import type { WantedEpisode } from "./models.js";

/**
 * Episode identity helpers for the Wanted workflow. `episodeKey` and
 * `normalizedSeriesTitle` are re-exported from the durable acquisition model so
 * the public API helper and the SQLite unique identity can never drift.
 */
export { episodeKey, normalizedSeriesTitle } from "./models.js";

/**
 * The minimum human metadata needed to build a Stremio search query. A full
 * `WantedEpisode` satisfies it, and callers may omit `episodeTitle`.
 */
export type StremioSearchable = Pick<
  WantedEpisode,
  "seriesTitle" | "season" | "episode"
> & { episodeTitle?: string | null };

/** Human-readable `S03E04` code with zero-padded season and episode numbers. */
export function seasonEpisodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/**
 * MarkTV's only Stremio integration point: open the official app on a search
 * for this episode. MarkTV never scrapes Stremio, and the query is the human
 * series title plus `SxxExx` and the optional episode title, URI-encoded into
 * the exact `stremio:///search?search=` form.
 */
export function stremioSearchUrl(wanted: StremioSearchable): string {
  const episodeTitle = wanted.episodeTitle?.trim();
  const query = [
    wanted.seriesTitle.trim(),
    seasonEpisodeCode(wanted.season, wanted.episode),
    episodeTitle ? episodeTitle : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return `stremio:///search?search=${encodeURIComponent(query)}`;
}
