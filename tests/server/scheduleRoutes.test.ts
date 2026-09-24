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
  const dataDir = await mkdtemp(join(tmpdir(), "marktv-schedule-routes-"));
  directories.push(dataDir);
  return buildApp({ dataDir, now });
}

type App = Awaited<ReturnType<typeof buildApp>>;

/** Generates and returns one stored schedule, so a test can name it exactly. */
async function generate(app: App, date: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/schedules/generate",
    payload: { channelId: "marktv-laughs", date },
  });
  expect(response.statusCode).toBe(200);
  return response.json().schedule;
}

const latest = (app: App, query = "") =>
  app.inject(`/api/v1/schedules/latest?channelId=marktv-laughs${query}`);

test("answers with the schedule for the requested date, not the newest one stored", async () => {
  // 17:00Z is noon in America/Chicago on the 17th.
  const app = await appAt(() => new Date("2026-09-17T17:00:00Z"));
  const today = await generate(app, "2026-09-17");
  const tomorrow = await generate(app, "2026-09-18");
  expect(tomorrow.id).not.toBe(today.id);

  // The quiet-hours pass stores tomorrow's schedule last, so insertion order is
  // exactly what a date-aware read must not follow.
  expect((await latest(app)).json().id).toBe(today.id);
  expect((await latest(app, "&date=2026-09-18")).json().id).toBe(tomorrow.id);
  await app.close();
});

test("defaults to the broadcast date in the channel's timezone", async () => {
  // 03:30Z is 22:30 on the 16th in America/Chicago, so the channel's current
  // broadcast date is still the 16th even though the 17th is already generated
  // and is the newest row.
  const app = await appAt(() => new Date("2026-09-17T03:30:00Z"));
  const sixteenth = await generate(app, "2026-09-16");
  await generate(app, "2026-09-17");

  const current = (await latest(app)).json();
  expect(current.id).toBe(sixteenth.id);
  expect(current.date).toBe("2026-09-16");
  await app.close();
});

test("returns null when nothing is stored for the requested date", async () => {
  const app = await appAt(() => new Date("2026-09-17T17:00:00Z"));
  await generate(app, "2026-09-18");

  // Tomorrow's pre-generation must not be answered as today's lineup.
  expect((await latest(app)).json()).toBeNull();
  expect((await latest(app, "&date=2026-09-25")).json()).toBeNull();
  await app.close();
});

test("rejects a malformed date query and an unknown channel", async () => {
  const app = await appAt(() => new Date("2026-09-17T17:00:00Z"));

  const invalid = await latest(app, "&date=2026-02-31");
  expect(invalid.statusCode).toBe(422);
  expect(invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });

  const missing = await app.inject(
    "/api/v1/schedules/latest?channelId=not-a-channel",
  );
  expect(missing.statusCode).toBe(404);
  await app.close();
});

test("reports what is on the air from today's schedule, not tomorrow's", async () => {
  const now = () => new Date("2026-09-17T23:12:00Z");
  const app = await appAt(now);
  const today = await generate(app, "2026-09-17");
  const tomorrow = await generate(app, "2026-09-18");
  const instant = now().toISOString();
  const onAirNow = today.entries.find(
    (entry: { start: string; end: string }) =>
      entry.start <= instant && entry.end > instant,
  );
  expect(onAirNow).toBeDefined();

  const air = (await app.inject("/api/v1/channels/marktv-laughs/air")).json();
  // Compare the entry's START, not its title: both days can open with the same
  // generic flex block, so a title check cannot tell which day was answered.
  expect(air.nowPlaying?.start).toBe(onAirNow.start);
  // The newest row is tomorrow's, so an insertion-ordered read would have
  // answered with its first entry instead - a different date, hence a different
  // start.
  expect(tomorrow.entries[0]?.start).not.toBe(onAirNow.start);
  await app.close();
});

test("generates today's schedule for the air status even when only tomorrow's exists", async () => {
  const app = await appAt(() => new Date("2026-09-17T17:00:00Z"));
  // Nothing for today: the newest stored row is tomorrow's, which must not be
  // reported as today's programming nor satisfy the request for today.
  await generate(app, "2026-09-18");

  const air = await app.inject("/api/v1/channels/marktv-laughs/air");
  expect(air.statusCode).toBe(200);
  expect((await latest(app)).json().date).toBe("2026-09-17");
  await app.close();
});
