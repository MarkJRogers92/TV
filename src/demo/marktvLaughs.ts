import type { Repositories } from "../db/repositories.js";
import type { Channel, MediaItem, Pool } from "../domain/models.js";

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

const interstitial = (
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

export function demo(timezone = "America/Chicago"): {
  channel: Channel;
  pools: Pool[];
  media: MediaItem[];
} {
  const media = [
    ...Array.from({ length: 12 }, (_, index) =>
      episode("Apartment 4B", index + 1),
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      episode("Space Neighbors", index + 1),
    ),
    interstitial(
      "wacky-weekend",
      "movie",
      "The Wacky Weekend Movie",
      5_400_000,
    ),
    interstitial("ad-1", "commercial", "Fictional Soda", 30_000),
    interstitial("bumper-1", "bumper", "MarkTV Laughs Bumper", 15_000),
    interstitial("filler-1", "filler", "Fictional Community Calendar", 60_000),
    interstitial("id-1", "station-id", "MarkTV Laughs ID", 15_000),
  ];
  const pools: Pool[] = [
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
      id: "movies",
      name: "Movies",
      kinds: ["movie"],
      mediaIds: ["wacky-weekend"],
      mode: "shuffle",
      noRepeatMinutes: 10_080,
      weight: 1,
    },
    {
      id: "ads",
      name: "Commercials",
      kinds: ["commercial"],
      mediaIds: ["ad-1"],
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
  return {
    channel: {
      id: "marktv-laughs",
      name: "MarkTV Laughs",
      number: 7,
      timezone,
      enabled: true,
      revision: "demo-2",
      dayparts: [
        {
          id: "morning",
          name: "Morning",
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "06:00",
          end: "12:00",
          priority: 1,
        },
        {
          id: "daytime",
          name: "Daytime",
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "12:00",
          end: "17:00",
          priority: 1,
        },
        {
          id: "evening",
          name: "Evening",
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "17:00",
          end: "20:00",
          priority: 1,
        },
        {
          id: "late-night",
          name: "Late Night",
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "20:00",
          end: "00:00",
          priority: 1,
        },
        {
          id: "overnight",
          name: "Overnight",
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "00:00",
          end: "06:00",
          priority: 1,
        },
      ],
      slots: [
        {
          id: "friday-movie",
          days: [5, 6],
          time: "20:00",
          poolIds: ["movies"],
          kind: "movie",
          fallbackPoolIds: [],
          movieMidroll: {
            intervalMinutes: 30,
            breakMinutes: 3,
            minimumMinutes: 60,
            maxBreaks: 4,
            tailBufferMinutes: 0,
            strategy: "lazy",
          },
        },
        ...["morning", "daytime", "evening", "late-night", "overnight"].map(
          (daypartId): Channel["slots"][number] => ({
            id: `${daypartId}-shows`,
            daypartId,
            days: [],
            poolIds: ["apartment-4b", "space-neighbors"],
            kind: "episode",
            fallbackPoolIds: [],
          }),
        ),
      ],
      breakPolicy: {
        boundaryMinutes: 30,
        poolIds: ["ads", "bumpers", "filler"],
        stationIdPoolIds: ["ids"],
        cooldownMinutes: 120,
      },
    },
    pools,
    media,
  };
}

export function seedDemoIfEmpty(
  repositories: Repositories,
  timezone: string,
): void {
  repositories.transaction(() => {
    if (
      repositories.channels.list().length ||
      repositories.pools.list().length ||
      repositories.media.list().length
    )
      return;
    const seeded = demo(timezone);
    repositories.channels.put(seeded.channel);
    seeded.pools.forEach((pool) => repositories.pools.put(pool));
    seeded.media.forEach((item) => repositories.media.put(item));
  });
}
