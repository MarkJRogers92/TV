import type {
  Channel,
  MediaItem,
  MovieProgramming,
  Pool,
} from "../../src/domain/models.js";

/**
 * A channel configured for movie programming, plus a library to schedule from.
 *
 * Shared by the engine, storage, service and simulation suites so they all test
 * the same shape of configuration rather than four subtly different ones.
 */
export type MovieFixtureOptions = {
  movieCount?: number;
  movieMinutes?: number;
  /** Durations of the individual ad spots the breaks may be built from. */
  adSeconds?: number[];
  programming?: Partial<MovieProgramming>;
  timezone?: string;
};

const episode = (show: string, number: number): MediaItem => ({
  id: `${show.toLowerCase().replaceAll(" ", "-")}-${number}`,
  source: "placeholder",
  kind: "episode",
  title: `${show} ${number}`,
  showTitle: show,
  season: 1,
  episode: number,
  durationMs: 1_380_000,
  durationStatus: "ok",
  available: true,
  tags: [],
});

const spot = (
  id: string,
  kind: MediaItem["kind"],
  title: string,
  durationMs: number,
): MediaItem => ({
  id,
  source: "placeholder",
  kind,
  title,
  durationMs,
  durationStatus: "ok",
  available: true,
  tags: [],
});

export function movieFixture(options: MovieFixtureOptions = {}) {
  const timezone = options.timezone ?? "America/Chicago";
  const movieCount = options.movieCount ?? 30;
  const movieMinutes = options.movieMinutes ?? 110;
  const adSeconds = options.adSeconds ?? [30, 30, 30, 30, 60, 15];
  const movies: MediaItem[] = Array.from({ length: movieCount }, (_, index) => ({
    id: `movie-${String(index + 1).padStart(2, "0")}`,
    source: "local-folder" as const,
    path: `/Volumes/SSK Drive /MarkTV/Movies/Movie ${index + 1} (20${String(index).padStart(2, "0")}).mkv`,
    kind: "movie" as const,
    title: `Movie ${index + 1}`,
    durationMs: movieMinutes * 60_000,
    durationStatus: "ok" as const,
    available: true,
    tags: [],
  }));
  const media: MediaItem[] = [
    ...movies,
    ...Array.from({ length: 12 }, (_, index) => episode("Apartment 4B", index + 1)),
    ...Array.from({ length: 12 }, (_, index) => episode("Space Neighbors", index + 1)),
    ...adSeconds.map((seconds, index) =>
      spot(`ad-${index + 1}`, "commercial", `Fictional Ad ${index + 1}`, seconds * 1000),
    ),
    spot("bumper-1", "bumper", "MarkTV Laughs Bumper", 15_000),
    spot("filler-1", "filler", "Fictional Community Calendar", 60_000),
    spot("id-1", "station-id", "MarkTV Laughs ID", 15_000),
  ];
  const pools: Pool[] = [
    {
      id: "movies",
      name: "Movies",
      kinds: ["movie"],
      mediaIds: movies.map((movie) => movie.id),
      mode: "shuffle",
      noRepeatMinutes: 0,
      weight: 1,
    },
    {
      id: "apartment-4b",
      name: "Apartment 4B",
      kinds: ["episode"],
      mediaIds: media
        .filter((item) => item.showTitle === "Apartment 4B")
        .map((item) => item.id),
      mode: "chronological",
      noRepeatMinutes: 720,
      weight: 2,
    },
    {
      id: "space-neighbors",
      name: "Space Neighbors",
      kinds: ["episode"],
      mediaIds: media
        .filter((item) => item.showTitle === "Space Neighbors")
        .map((item) => item.id),
      mode: "chronological",
      noRepeatMinutes: 720,
      weight: 1,
    },
    {
      id: "ads",
      name: "Commercials",
      kinds: ["commercial"],
      mediaIds: media
        .filter((item) => item.kind === "commercial")
        .map((item) => item.id),
      mode: "shuffle",
      noRepeatMinutes: 120,
      weight: 1,
    },
    {
      id: "bumpers",
      name: "Bumpers",
      kinds: ["bumper"],
      mediaIds: ["bumper-1"],
      mode: "shuffle",
      noRepeatMinutes: 120,
      weight: 1,
    },
    {
      id: "filler",
      name: "General filler",
      kinds: ["filler"],
      mediaIds: ["filler-1"],
      mode: "shuffle",
      noRepeatMinutes: 120,
      weight: 1,
    },
    {
      id: "ids",
      name: "Station IDs",
      kinds: ["station-id"],
      mediaIds: ["id-1"],
      mode: "shuffle",
      noRepeatMinutes: 120,
      weight: 1,
    },
  ];
  const channel: Channel = {
    id: "marktv-laughs",
    name: "MarkTV Laughs",
    number: 7,
    timezone,
    enabled: true,
    revision: "movie-programming-1",
    dayparts: [
      { id: "morning", name: "Morning", days: [0, 1, 2, 3, 4, 5, 6], start: "06:00", end: "12:00", priority: 1 },
      { id: "daytime", name: "Daytime", days: [0, 1, 2, 3, 4, 5, 6], start: "12:00", end: "17:00", priority: 1 },
      { id: "evening", name: "Evening", days: [0, 1, 2, 3, 4, 5, 6], start: "17:00", end: "20:00", priority: 1 },
      { id: "late-night", name: "Late Night", days: [0, 1, 2, 3, 4, 5, 6], start: "20:00", end: "00:00", priority: 1 },
      { id: "overnight", name: "Overnight", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "06:00", priority: 1 },
    ],
    slots: ["morning", "daytime", "evening", "late-night", "overnight"].map(
      (daypartId) => ({
        id: `${daypartId}-shows`,
        daypartId,
        days: [],
        poolIds: ["apartment-4b", "space-neighbors"],
        kind: "episode" as const,
        fallbackPoolIds: [],
        episodeMidroll: {
          targetMinutes: [7.5, 15] as [number, number],
          searchWindowMinutes: 1.5,
          breakMinutes: 2.5,
          minimumSegmentMinutes: 2,
          tailBufferMinutes: 2,
        },
      }),
    ),
    movieProgramming: {
      enabled: true,
      poolIds: ["movies"],
      rootPath: "/Volumes/SSK Drive /MarkTV/Movies",
      nightlyAnchor: "02:00",
      weekendAnchor: "19:00",
      bridgePoolIds: ["ads", "bumpers", "filler"],
      bridgeMinSeconds: 60,
      bridgeMaxSeconds: 120,
      lookaheadDays: 8,
      breakPolicy: {
        targetMinutes: 2,
        maxMinutes: 2.5,
        protectionMinutes: 15,
        shortMaxMinutes: 110,
      },
      ...options.programming,
    },
    breakPolicy: {
      boundaryMinutes: 30,
      poolIds: ["ads", "bumpers", "filler"],
      stationIdPoolIds: ["ids"],
      cooldownMinutes: 120,
    },
  };
  return { channel, pools, media, movies };
}
