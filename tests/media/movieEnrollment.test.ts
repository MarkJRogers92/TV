import { afterEach, expect, test } from "vitest";
import {
  eligibleMovieMediaIds,
  ensureMovieProgrammingPool,
  withinMovieRoot,
} from "../../src/media/movieEnrollment.js";
import {
  cleanupRepositoryFixtures,
  openMovieRepositories,
} from "../support/repositoryFixture.js";
import { movieFixture } from "../support/movieFixture.js";
import type { MediaItem } from "../../src/domain/models.js";

afterEach(async () => {
  await cleanupRepositoryFixtures();
});

const ROOT = "/Volumes/SSK Drive /MarkTV/Movies";
const ELSEWHERE = "/Volumes/Other Volume/Movies";

const movieAt = (id: string, path: string, title = id): MediaItem => ({
  id,
  source: "local-folder" as const,
  path,
  kind: "movie" as const,
  title,
  durationMs: 100 * 60_000,
  durationStatus: "ok" as const,
  available: true,
  tags: [],
});

test("root membership is a path rule, not a string prefix accident", () => {
  expect(withinMovieRoot(ROOT, `${ROOT}/Movie 1.mkv`)).toBe(true);
  expect(withinMovieRoot(`${ROOT}/`, `${ROOT}/Movie 1.mkv`)).toBe(true);
  expect(withinMovieRoot(ROOT, "/Volumes/SSK Drive /MarkTV/Movies 2/x.mkv")).toBe(
    false,
  );
  expect(withinMovieRoot(ROOT, `${ELSEWHERE}/x.mkv`)).toBe(false);
  // A catalogue entry with no path cannot contradict a root it does not name.
  expect(withinMovieRoot(ROOT, undefined)).toBe(true);
  // A channel enabled before the field existed is deliberately unscoped.
  expect(withinMovieRoot(undefined, `${ELSEWHERE}/x.mkv`)).toBe(true);
});

test("only movies inside the configured folder are eligible", () => {
  const { movies } = movieFixture({ movieCount: 2 });
  const items = [...movies, movieAt("movie-elsewhere", `${ELSEWHERE}/Other.mkv`)];
  expect(eligibleMovieMediaIds(items, ROOT)).toEqual(["movie-01", "movie-02"]);
  expect(eligibleMovieMediaIds(items, ELSEWHERE)).toEqual(["movie-elsewhere"]);
  expect(eligibleMovieMediaIds(items)).toEqual([
    "movie-01",
    "movie-02",
    "movie-elsewhere",
  ]);
});

test("excludes configured child roots from a broader movie pool", () => {
  const items = [
    movieAt("top-level-movie", `${ROOT}/Top Level.mkv`),
    movieAt("cult-movie-1", `${ROOT}/Cult/Cult One.mkv`),
    movieAt("cult-movie-2", `${ROOT}/Cult/Cult Two.mkv`),
  ];

  expect(eligibleMovieMediaIds(items, ROOT, [`${ROOT}/Cult`])).toEqual([
    "top-level-movie",
  ]);
  expect(eligibleMovieMediaIds(items, `${ROOT}/Cult`)).toEqual([
    "cult-movie-1",
    "cult-movie-2",
  ]);
});

test("enrolment adds only in-root films and never prunes stored inventory", async () => {
  const fixture = await openMovieRepositories();
  const channel = fixture.fixture.channel;
  const before = fixture.repositories.pools.get("movies")!.mediaIds;
  fixture.repositories.media.put(
    movieAt("movie-inside", `${ROOT}/New Arrival.mkv`, "New Arrival"),
  );
  fixture.repositories.media.put(
    movieAt("movie-outside", `${ELSEWHERE}/Elsewhere.mkv`, "Elsewhere"),
  );

  const outcomes = ensureMovieProgrammingPool(fixture.repositories, channel);
  const pool = fixture.repositories.pools.get("movies")!;
  expect(outcomes[0]).toMatchObject({ added: 1 });
  expect(pool.mediaIds).toContain("movie-inside");
  expect(pool.mediaIds).not.toContain("movie-outside");
  expect(pool.mediaIds).toEqual(expect.arrayContaining(before));

  // An unmounted volume is not evidence that the films are gone: nothing is
  // eligible, and the stored membership is kept exactly as it was.
  for (const item of fixture.repositories.media.list()) {
    if (item.kind === "movie")
      fixture.repositories.media.put({ ...item, available: false });
  }
  const afterUnmount = ensureMovieProgrammingPool(fixture.repositories, channel);
  expect(afterUnmount[0]).toMatchObject({ added: 0 });
  expect(fixture.repositories.pools.get("movies")!.mediaIds).toEqual(
    pool.mediaIds,
  );
  fixture.close();
});

test("a rotation never draws a film from a different root", async () => {
  const fixture = await openMovieRepositories();
  const channel = fixture.fixture.channel;
  fixture.repositories.media.put(
    movieAt("movie-outside", `${ELSEWHERE}/Elsewhere.mkv`, "Elsewhere"),
  );
  const pool = fixture.repositories.pools.get("movies")!;
  // Even a film that is a pool member is not drawn while it lives outside the
  // configured folder - and a pool that still lists it is not rewritten.
  fixture.repositories.pools.put({
    ...pool,
    mediaIds: [...pool.mediaIds, "movie-outside"],
  });
  const generated = await fixture.service.generate(channel, "2026-09-09");
  expect(generated.ok).toBe(true);
  expect(
    fixture.repositories.movieRotations.get("marktv-laughs")!.order,
  ).not.toContain("movie-outside");
  fixture.close();
});
