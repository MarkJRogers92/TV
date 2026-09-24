import type { Repositories } from "../db/repositories.js";
import type { Channel, MediaItem, Pool } from "../domain/models.js";
import { normalize, sep } from "node:path";

/**
 * Keeps the movie pools the movie-programming feature draws from in step with the
 * library.
 *
 * The same shape as series enrolment, and for the same reason: a scanned film is
 * useless to the scheduler until a pool holds it, and asking an operator to
 * re-add every file by hand after each scan defeats the point of a root.
 *
 * Membership is a UNION, never a replacement. An unmounted volume cannot be
 * scanned at all - the root guard refuses before anything is written - but a
 * sweep that ran while a share was merely slow would otherwise prune films that
 * are still on it, and the rotation is built from these members, so pruning would
 * silently rewrite the bag. Movies therefore enter the pool and stay until an
 * operator removes them.
 */

export type MoviePoolOutcome = {
  channelId: string;
  poolId: string;
  created: boolean;
  added: number;
  movieCount: number;
};

/**
 * Whether a file sits inside the folder the feature was told to scan.
 *
 * The configured root is the feature's whole identity: a movie under a different
 * volume, or under the folder this channel used before the operator pointed it
 * somewhere else, is not part of this channel's library even when the catalog
 * still holds it. A channel with no root configured (enabled before this field
 * existed) is deliberately unscoped.
 */
export function withinMovieRoot(
  rootPath: string | undefined,
  path: string | undefined,
): boolean {
  if (!rootPath) return true;
  // Catalog entries with no path at all (the demo catalogue, and any record whose
  // file was never resolved) cannot be attributed to a folder either way, so they
  // are not excluded by a root they cannot contradict.
  if (!path) return true;
  const root = normalize(rootPath).replace(/[/\\]+$/, "");
  const candidate = normalize(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Local movie media that is actually playable and inside the configured root. */
export function eligibleMovieMediaIds(
  items: MediaItem[],
  rootPath?: string,
  excludedRootPaths: string[] = [],
): string[] {
  return items
    .filter(
      (item) =>
        item.kind === "movie" &&
        !item.sourceMediaId &&
        item.available &&
        (item.durationMs ?? 0) > 0 &&
        item.durationStatus !== "missing" &&
        withinMovieRoot(rootPath, item.path) &&
        !excludedRootPaths.some((excludedRoot) =>
          withinMovieRoot(excludedRoot, item.path),
        ),
    )
    .map((item) => item.id)
    .sort();
}

export function ensureMovieProgrammingPool(
  repositories: Repositories,
  channel: Channel,
): MoviePoolOutcome[] {
  const programming = channel.movieProgramming;
  if (!programming?.enabled) return [];
  const configuredRoots = repositories.channels
    .list()
    .map((candidate) => candidate.movieProgramming?.rootPath)
    .filter((root): root is string => Boolean(root));
  const exclusions = programming.rootPath
    ? configuredRoots.filter(
        (candidate) =>
          candidate !== programming.rootPath &&
          withinMovieRoot(programming.rootPath, candidate),
      )
    : [];
  const movies = eligibleMovieMediaIds(
    repositories.media.list(),
    programming.rootPath,
    exclusions,
  );
  const derivedMediaIds = new Set(
    repositories.media
      .list()
      .filter((item) => item.sourceMediaId)
      .map((item) => item.id),
  );
  const outcomes: MoviePoolOutcome[] = [];
  for (const poolId of programming.poolIds) {
    const existing = repositories.pools.get(poolId);
    // Keep the pool additive for ordinary inventory, but remove an entry once
    // catalog provenance proves it is a prepared rendition of another movie.
    const retainedMembers = (existing?.mediaIds ?? []).filter(
      (id) => !derivedMediaIds.has(id),
    );
    const members = [...new Set([...retainedMembers, ...movies])].sort();
    const removedDerived = (existing?.mediaIds ?? []).some((id) =>
      derivedMediaIds.has(id),
    );
    const added = members.filter(
      (id) => !(existing?.mediaIds ?? []).includes(id),
    ).length;
    if (existing && added === 0 && !removedDerived) {
      outcomes.push({
        channelId: channel.id,
        poolId,
        created: false,
        added: 0,
        movieCount: members.length,
      });
      continue;
    }
    const pool: Pool = {
      id: poolId,
      name: existing?.name ?? "Movies",
      kinds: existing?.kinds ?? ["movie"],
      // Only the members are owned here. Mode, cooldown and weight stay as the
      // operator left them, because selection of a movie slot is not this
      // feature's business.
      mediaIds: members,
      mode: existing?.mode ?? "shuffle",
      noRepeatMinutes: existing?.noRepeatMinutes ?? 0,
      weight: existing?.weight ?? 1,
    };
    repositories.pools.put(pool);
    outcomes.push({
      channelId: channel.id,
      poolId,
      created: !existing,
      added,
      movieCount: members.length,
    });
  }
  return outcomes;
}

/**
 * Runs for every channel, idempotently.
 *
 * Called at startup and after each successful media scan, which are exactly the
 * two moments the set of films can have changed.
 */
export function reconcileMovieProgramming(
  repositories: Repositories,
): MoviePoolOutcome[] {
  return repositories.channels
    .list()
    .flatMap((channel) => ensureMovieProgrammingPool(repositories, channel));
}
