import { expect, test } from "vitest";
import { channelSchema, poolSchema } from "../../src/domain/models.js";
import { validateChannelConfiguration } from "../../src/domain/validation.js";

const ROOT = "/Volumes/SSK Drive /MarkTV/Movies";
const CULT_ROOT = `${ROOT}/Cult`;

test("describes the production-shaped Cult Movies channel", () => {
  const cultChannel = channelSchema.parse({
    id: "marktv-cult-movies",
    name: "MarkTV Cult Movies",
    number: 9,
    timezone: "America/Chicago",
    enabled: true,
    revision: "cult-movies-1",
    dayparts: [
      {
        id: "all-day",
        name: "All Day",
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "00:00",
        end: "00:00",
        priority: 1,
      },
    ],
    slots: [
      {
        id: "cult-movies",
        daypartId: "all-day",
        days: [],
        poolIds: ["cult-movies"],
        kind: "movie",
        fallbackPoolIds: [],
      },
    ],
    breakPolicy: {
      poolIds: ["ads"],
      stationIdPoolIds: [],
    },
    movieProgramming: {
      enabled: false,
      poolIds: ["cult-movies"],
      rootPath: CULT_ROOT,
    },
  });
  const pools = [
    poolSchema.parse({
      id: "cult-movies",
      name: "Cult Movies",
      kinds: ["movie"],
      mediaIds: [],
      mode: "shuffle",
      noRepeatMinutes: 1_440,
      weight: 1,
    }),
    poolSchema.parse({
      id: "ads",
      name: "Commercials",
      kinds: ["commercial"],
      mediaIds: [],
      mode: "shuffle",
      noRepeatMinutes: 120,
      weight: 1,
    }),
  ];

  expect(cultChannel.dayparts).toHaveLength(1);
  expect(cultChannel.dayparts[0]).toMatchObject({
    start: "00:00",
    end: "00:00",
  });
  expect(cultChannel.slots).toHaveLength(1);
  expect(cultChannel.slots[0]).toMatchObject({
    poolIds: ["cult-movies"],
    kind: "movie",
  });
  expect(cultChannel.breakPolicy.poolIds).toEqual(["ads"]);
  expect(cultChannel.movieProgramming).toMatchObject({
    enabled: false,
    poolIds: ["cult-movies"],
    rootPath: CULT_ROOT,
  });
  expect(validateChannelConfiguration(cultChannel, pools, [])).toEqual([]);
});
