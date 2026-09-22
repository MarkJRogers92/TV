import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database.js";
import {
  createRepositories,
  type Repositories,
} from "../../src/db/repositories.js";
import { ScheduleService } from "../../src/server/scheduleService.js";
import { movieFixture, type MovieFixtureOptions } from "./movieFixture.js";

const directories: string[] = [];

export async function cleanupRepositoryFixtures() {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
}

export type RepositoryFixture = {
  dataDir: string;
  repositories: Repositories;
  /** Reopens the same data directory, as a restart would. */
  reopen: () => Repositories;
  fixture: ReturnType<typeof movieFixture>;
  service: ScheduleService;
  close: () => void;
};

export function makeScheduleService(
  repositories: Repositories,
  dataDir: string,
  now: () => Date,
) {
  return new ScheduleService(
    repositories,
    dataDir,
    now,
    async () => join(dataDir, "export.json"),
  );
}

export async function openMovieRepositories(
  options: MovieFixtureOptions & { now?: () => Date } = {},
): Promise<RepositoryFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-movie-programming-"));
  directories.push(dataDir);
  const repositories = createRepositories(openDatabase(dataDir));
  const fixture = movieFixture(options);
  repositories.channels.put(fixture.channel);
  for (const pool of fixture.pools) repositories.pools.put(pool);
  for (const item of fixture.media) repositories.media.put(item);
  const now = options.now ?? (() => new Date("2026-09-07T12:00:00.000Z"));
  return {
    dataDir,
    repositories,
    reopen: () => {
      repositories.close();
      return createRepositories(openDatabase(dataDir));
    },
    fixture,
    service: makeScheduleService(repositories, dataDir, now),
    close: () => repositories.close(),
  };
}
