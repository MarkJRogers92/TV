import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { MediaItem, Schedule, ScheduleEntry } from "../../src/domain/models.js";
import type { Repositories } from "../../src/db/repositories.js";
import {
  prepareContinuityMedia,
  selectContinuityOutputRoot,
} from "../../src/continuity/prepare.js";
import { defaultContinuityConfig } from "../../src/continuity/types.js";
import {
  cleanupRepositoryFixtures,
  openMovieRepositories,
} from "../support/repositoryFixture.js";

afterEach(cleanupRepositoryFixtures);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const fakeRepositories = (roots: string[]) =>
  ({
    settings: {
      list: () =>
        roots.map((path, index) => ({
          id: `media-root:${index}`,
          value: { id: `${index}`, path, lastScannedAt: null, diagnostics: [] },
        })),
    },
  }) as unknown as Repositories;

const mediaItem = (
  id: string,
  kind: MediaItem["kind"],
  durationMs: number,
  path: string,
  title = id,
  showTitle?: string,
): MediaItem => ({
  id,
  source: "local-folder",
  path,
  kind,
  title,
  showTitle,
  durationMs,
  durationStatus: "ok",
  available: true,
  tags: [],
});

const scheduleEntry = (
  id: string,
  startMs: number,
  durationMs: number,
  kind: ScheduleEntry["kind"],
  mediaId: string,
): ScheduleEntry => ({
  id,
  start: new Date(startMs).toISOString(),
  end: new Date(startMs + durationMs).toISOString(),
  localStart: "",
  localEnd: "",
  durationMs,
  kind,
  title: id,
  mediaId,
  path: `/media/${mediaId}.mp4`,
});

const start = Date.parse("2026-09-20T23:00:00.000Z");
const breakableSchedule = (): Schedule => {
  const entries = [
    scheduleEntry("roseanne-1", start, 20 * 60_000, "episode", "roseanne-1"),
    scheduleEntry("id-1", start + 20 * 60_000, 5_000, "station-id", "id-1"),
    scheduleEntry("commercial-1", start + 20 * 60_000 + 5_000, 25_000, "commercial", "commercial-1"),
    scheduleEntry("roseanne-2", start + 20 * 60_000 + 30_000, 20 * 60_000, "episode", "roseanne-2"),
  ];
  return {
    id: "schedule-2026-09-20",
    channelId: "marktv-laughs",
    date: "2026-09-20",
    timezone: "America/Chicago",
    seed: "seed",
    revision: "revision-1",
    generatedAt: "2026-09-20T12:00:00.000Z",
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
    entries,
    diagnostics: [],
  };
};

const breakableMedia = () => [
  mediaItem("roseanne-1", "episode", 20 * 60_000, "/media/roseanne-1.mp4", "Pilot", "Roseanne"),
  mediaItem("roseanne-2", "episode", 20 * 60_000, "/media/roseanne-2.mp4", "Next", "Roseanne"),
  mediaItem("id-1", "station-id", 5_000, "/media/id-1.mp4", "marktv-id-primary"),
  mediaItem("commercial-1", "commercial", 25_000, "/media/commercial-1.mp4"),
  mediaItem("next-roseanne", "bumper", 5_000, "/media/next.mp4", "marktv-up-next-roseanne"),
];

describe("selectContinuityOutputRoot", () => {
  test("picks the existing commercial root rather than hardcoding a volume", () => {
    const media = [mediaItem("ad", "commercial", 30_000, "/Volumes/misc/ad.mp4", "ad")];
    expect(
      selectContinuityOutputRoot({
        repositories: fakeRepositories(["/Volumes/Shows", "/Volumes/Archive"]),
        media,
      }),
    ).toBeUndefined();
    expect(
      selectContinuityOutputRoot({
        repositories: fakeRepositories(["/Volumes/Shows", "/Volumes/Commercials"]),
        media,
      }),
    ).toBe(join("/Volumes/Commercials", "generated", "continuity"));
  });

  test("prefers the root that already holds the channel's commercials", () => {
    const media = [
      mediaItem("ad", "commercial", 30_000, "/Volumes/Ads/2019/ad.mp4", "ad"),
    ];
    expect(
      selectContinuityOutputRoot({
        repositories: fakeRepositories(["/Volumes/Shows", "/Volumes/Ads"]),
        media,
      }),
    ).toBe(join("/Volumes/Ads", "generated", "continuity"));
  });

  test("honours an explicit override and skips when no root is mapped", () => {
    expect(
      selectContinuityOutputRoot({
        repositories: fakeRepositories([]),
        media: [],
        override: "/tmp/verify-cards",
      }),
    ).toBe("/tmp/verify-cards");
    expect(
      selectContinuityOutputRoot({
        repositories: fakeRepositories([]),
        media: [],
      }),
    ).toBeUndefined();
  });
});

describe("prepareContinuityMedia", () => {
  test("skips preparation when no eligible output root can be determined", async () => {
    const fixture = await openMovieRepositories();
    const schedule = breakableSchedule();
    const media = breakableMedia();
    const result = await prepareContinuityMedia({
      repositories: fixture.repositories,
      channel: fixture.fixture.channel,
      schedule,
      media,
      config: { ...defaultContinuityConfig, enabled: true },
      history: [],
    });
    expect(result.prepared).toEqual([]);
    expect(result.media).toEqual(media);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CONTINUITY_NO_OUTPUT_ROOT" }),
    );
  });

  test("is a no-op when the director is off", async () => {
    const fixture = await openMovieRepositories();
    const media = breakableMedia();
    const result = await prepareContinuityMedia({
      repositories: fixture.repositories,
      channel: fixture.fixture.channel,
      schedule: breakableSchedule(),
      media,
      config: { ...defaultContinuityConfig, enabled: false },
      history: [],
    });
    expect(result.media).toBe(media);
    expect(result.prepared).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("[SC08] returns the original media when the render tool cannot run", async () => {
    const fixture = await openMovieRepositories();
    const outputRoot = await mkdtemp(join(tmpdir(), "marktv-continuity-prepare-"));
    temporaryDirectories.push(outputRoot);
    const media = breakableMedia();
    const result = await prepareContinuityMedia({
      repositories: fixture.repositories,
      channel: fixture.fixture.channel,
      schedule: breakableSchedule(),
      media,
      config: { ...defaultContinuityConfig, enabled: true },
      history: [],
      outputRoot,
      ffmpeg: "/nonexistent/ffmpeg",
      // Registration is stubbed out so the test never touches a real catalog.
      register: false,
    });
    expect(result.prepared).toEqual([]);
    expect(result.media).toEqual(media);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "CONTINUITY_RENDER_FAILED",
      ),
    ).toBe(true);
    expect(
      fixture.repositories.media
        .list()
        .some((item) => item.tags.includes("schedule-scoped-continuity")),
    ).toBe(false);
  });
});
