import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "../../src/server/app.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function appAt(now: () => Date) {
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-movie-routes-"));
  directories.push(dataDir);
  return buildApp({ dataDir, now });
}

type App = Awaited<ReturnType<typeof buildApp>>;
const status = async (app: App, channelId = "marktv-laughs") =>
  await app.inject(`/api/v1/channels/${channelId}/movie-programming`);
const control = async (
  app: App,
  payload: Record<string, unknown>,
  channelId = "marktv-laughs",
) =>
  await app.inject({
    method: "PUT",
    url: `/api/v1/channels/${channelId}/movie-programming`,
    payload,
  });

const MOVIE_ROOT = "/Volumes/__marktv_missing_volume__/MarkTV/Movies";

const storedSchedule = async (app: App, date: string) =>
  (
    await app.inject(
      `/api/v1/schedules/latest?channelId=marktv-laughs&date=${date}`,
    )
  ).json();

const generate = async (app: App, date: string) =>
  await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: "marktv-laughs", date },
  });

test("movie programming is off until the operator turns it on", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  const response = await status(app);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    channelId: "marktv-laughs",
    enabled: false,
    upcoming: [],
  });
  await app.close();
});

test("turning the feature on enrols the movie pool and reports a preview", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  const enabled = await control(app, {
    enabled: true,
    poolIds: ["movies"],
    rootPath: "/Volumes/__marktv_missing_volume__/MarkTV/Movies",
  });
  expect(enabled.statusCode).toBe(200);
  expect(enabled.json().movieProgramming).toMatchObject({
    enabled: true,
    poolIds: ["movies"],
    lookaheadDays: 8,
  });

  const pool = (
    await app.inject("/api/v1/pools")
  )
    .json()
    .find((candidate: { id: string }) => candidate.id === "movies");
  expect(pool.kinds).toEqual(["movie"]);
  expect(pool.mediaIds).toContain("wacky-weekend");

  const preview = await status(app);
  expect(preview.statusCode).toBe(200);
  const body = preview.json();
  expect(body).toMatchObject({
    enabled: true,
    rootPath: "/Volumes/__marktv_missing_volume__/MarkTV/Movies",
    // The folder is not mounted on the test machine, which must be reported.
    rootAvailable: false,
    movieCount: 1,
  });
  expect(body.upcoming.length).toBeGreaterThan(0);
  expect(body.upcoming[0]).toMatchObject({
    date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    anchor: expect.stringMatching(/^\d{2}:\d{2}$/),
    title: expect.any(String),
    consumes: expect.any(Boolean),
  });
  // An unreachable folder and a one-movie rotation are both said out loud rather
  // than left to be discovered on air.
  expect(body.degraded.join("\n")).toMatch(/not exist/i);
  expect(body.degraded.join("\n")).toMatch(/repeat/i);
  await app.close();
});

test("the control can be switched off again", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  await control(app, { enabled: true, poolIds: ["movies"], rootPath: MOVIE_ROOT });
  const off = await control(app, { enabled: false });
  expect(off.statusCode).toBe(200);
  expect((await status(app)).json()).toMatchObject({
    enabled: false,
    upcoming: [],
  });
  await app.close();
});

test("enabling without a movie pool or folder is refused", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  // Enabled with nothing to draw from is a channel that claims to have movie
  // programming and can never schedule a film.
  const noPool = await control(app, { enabled: true });
  expect(noPool.statusCode).toBe(422);
  expect(noPool.json().issues.map((issue: { path: string }) => issue.path)).toContain(
    "movieProgramming.poolIds",
  );
  const noRoot = await control(app, { enabled: true, poolIds: ["movies"] });
  expect(noRoot.statusCode).toBe(422);
  expect(
    noRoot.json().issues.map((issue: { path: string }) => issue.path),
  ).toContain("movieProgramming.rootPath");
  // Nothing was written: the channel is still off and still has no configuration.
  expect((await status(app)).json()).toMatchObject({ enabled: false });
  await app.close();
});

test("enabling invalidates tomorrow's unpublished schedule and keeps today's", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  // A day already on air, and a pre-generated day that is still only a plan.
  expect((await generate(app, "2026-09-07")).statusCode).toBe(200);
  expect((await generate(app, "2026-09-08")).statusCode).toBe(200);
  expect(await storedSchedule(app, "2026-09-08")).not.toBeNull();

  const enabled = await control(app, {
    enabled: true,
    poolIds: ["movies"],
    rootPath: MOVIE_ROOT,
  });
  expect(enabled.statusCode).toBe(200);

  // The plan for tomorrow was built from a channel with no movie programming, so
  // it is gone rather than left to air. Today's schedule is being broadcast and
  // is untouched.
  expect(await storedSchedule(app, "2026-09-08")).toBeNull();
  expect(await storedSchedule(app, "2026-09-07")).not.toBeNull();
  await app.close();
});

test("disabling invalidates tomorrow's movie schedule and keeps today's", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  await control(app, {
    enabled: true,
    poolIds: ["movies"],
    rootPath: MOVIE_ROOT,
  });
  expect((await generate(app, "2026-09-07")).statusCode).toBe(200);
  expect((await generate(app, "2026-09-08")).statusCode).toBe(200);
  const planned = await storedSchedule(app, "2026-09-08");
  expect(planned).not.toBeNull();

  const off = await control(app, { enabled: false });
  expect(off.statusCode).toBe(200);

  // Tomorrow still planned movies; it cannot be allowed to air them after the
  // feature was switched off.
  expect(await storedSchedule(app, "2026-09-08")).toBeNull();
  expect(await storedSchedule(app, "2026-09-07")).not.toBeNull();
  await app.close();
});

test("changing the movie configuration invalidates tomorrow's schedule too", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  await control(app, {
    enabled: true,
    poolIds: ["movies"],
    rootPath: MOVIE_ROOT,
  });
  expect((await generate(app, "2026-09-07")).statusCode).toBe(200);
  expect((await generate(app, "2026-09-08")).statusCode).toBe(200);

  const changed = await control(app, { enabled: true, weekendAnchor: "20:00" });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().movieProgramming.weekendAnchor).toBe("20:00");

  // Tomorrow planned its features at 19:00, which is no longer the configuration.
  expect(await storedSchedule(app, "2026-09-08")).toBeNull();
  expect(await storedSchedule(app, "2026-09-07")).not.toBeNull();
  await app.close();
});

test("an unknown channel is a 404 for both halves of the control", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  expect((await status(app, "nope")).statusCode).toBe(404);
  expect((await control(app, { enabled: true }, "nope")).statusCode).toBe(404);
  await app.close();
});

test("a malformed control body is refused without touching the channel", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  const response = await control(app, { enabled: "yes" });
  expect(response.statusCode).toBe(422);
  expect((await status(app)).json()).toMatchObject({ enabled: false });
  await app.close();
});

test("a generated day includes the movie the status endpoint promised", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  await control(app, {
    enabled: true,
    poolIds: ["movies"],
    rootPath: MOVIE_ROOT,
  });
  const generated = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: "marktv-laughs", date: "2026-09-09" },
  });
  expect(generated.statusCode).toBe(200);
  const schedule = generated.json().schedule;
  const movie = schedule.entries.find(
    (entry: { movieOccurrenceKey?: string }) =>
      entry.movieOccurrenceKey === "2026-09-09:nightly",
  );
  expect(movie).toBeTruthy();
  const promised = (await status(app))
    .json()
    .upcoming.find(
      (airing: { date: string; position: string }) =>
        airing.date === "2026-09-09" && airing.position === "nightly",
    );
  expect(promised.mediaId).toBe(movie.mediaId);
  await app.close();
});

test("[OP07] the weekend encore setting updates live, without a restart", async () => {
  const app = await appAt(() => new Date("2026-09-07T12:00:00Z"));
  const enabled = await control(app, {
    enabled: true,
    poolIds: ["movies"],
    rootPath: MOVIE_ROOT,
  });
  expect(enabled.statusCode).toBe(200);
  // Defaults to on so the approved weekend behaviour is preserved.
  expect(enabled.json().movieProgramming.weekendOpenerEncoreEnabled).toBe(true);

  const off = await control(app, { weekendOpenerEncoreEnabled: false });
  expect(off.statusCode).toBe(200);
  expect(off.json().movieProgramming.weekendOpenerEncoreEnabled).toBe(false);

  // A fresh read reflects the change, with no whole-stack restart.
  const read = await app.inject("/api/v1/channels/marktv-laughs");
  expect(read.json().movieProgramming.weekendOpenerEncoreEnabled).toBe(false);
  await app.close();
});
