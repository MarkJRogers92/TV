import { describe, expect, test } from "vitest";
import { demo } from "../../src/demo/marktvLaughs.js";
import { channelSchema } from "../../src/domain/models.js";
import { validateChannelConfiguration } from "../../src/domain/validation.js";

test("rejects an invalid IANA timezone at the domain boundary", () => {
  const { channel } = demo();
  expect(
    channelSchema.safeParse({ ...channel, timezone: "Chicago-ish" }).success,
  ).toBe(false);
});

describe("validateChannelConfiguration", () => {
  test("rejects equal-priority overlapping dayparts but permits a higher-priority override", () => {
    const { channel, pools, media } = demo();
    channel.dayparts = [
      {
        id: "morning",
        name: "Morning",
        days: [1],
        start: "06:00",
        end: "12:00",
        priority: 1,
      },
      {
        id: "overlap",
        name: "Overlap",
        days: [1],
        start: "11:00",
        end: "13:00",
        priority: 1,
      },
    ];
    expect(validateChannelConfiguration(channel, pools, media)).toContainEqual(
      expect.objectContaining({ code: "DAYPART_OVERLAP" }),
    );

    channel.dayparts[1].priority = 2;
    expect(
      validateChannelConfiguration(channel, pools, media),
    ).not.toContainEqual(expect.objectContaining({ code: "DAYPART_OVERLAP" }));
  });

  test("validates pool references from slots, fallbacks, and break policies", () => {
    const { channel, pools, media } = demo();
    channel.slots[0].poolIds = ["missing-primary"];
    channel.slots[0].fallbackPoolIds = ["missing-fallback"];
    channel.breakPolicy.poolIds = ["missing-break"];
    channel.breakPolicy.stationIdPoolIds = ["missing-id"];

    const issues = validateChannelConfiguration(channel, pools, media);
    expect(
      issues.filter((issue) => issue.code === "MISSING_POOL"),
    ).toHaveLength(4);
  });

  test("validates slot dayparts and pool member kinds", () => {
    const { channel, pools, media } = demo();
    channel.slots[0].daypartId = "missing-daypart";
    pools
      .find((pool) => pool.id === "apartment-4b")!
      .mediaIds.push("wacky-weekend");

    expect(validateChannelConfiguration(channel, pools, media)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_DAYPART",
          path: "slots.friday-movie.daypartId",
        }),
        expect.objectContaining({
          code: "POOL_KIND_MISMATCH",
          path: "pools.apartment-4b.mediaIds",
        }),
      ]),
    );
  });

  test("reports missing pool members and unusable durations", () => {
    const { channel, pools, media } = demo();
    pools[0].mediaIds.push("missing-item");
    media[0].durationMs = null;
    media[0].durationStatus = "missing";

    const issues = validateChannelConfiguration(channel, pools, media);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_MEDIA_ITEM",
          path: "pools.apartment-4b.mediaIds",
        }),
        expect.objectContaining({ code: "MISSING_DURATION" }),
      ]),
    );
  });

  test("rejects unsupported boundary and movie break values", () => {
    const { channel, pools, media } = demo();
    channel.breakPolicy.boundaryMinutes = 17;
    channel.slots[0].movieMidroll!.maxBreaks = 1.5;

    expect(
      validateChannelConfiguration(channel, pools, media).filter(
        (issue) => issue.code === "INVALID_BREAK_POLICY",
      ),
    ).toHaveLength(2);
  });

  test("rejects program pools used as filler and non-station pools used for IDs", () => {
    const { channel, pools, media } = demo();
    channel.breakPolicy.poolIds = ["apartment-4b"];
    channel.breakPolicy.stationIdPoolIds = ["ads"];

    expect(
      validateChannelConfiguration(channel, pools, media).filter(
        (issue) => issue.code === "INVALID_BREAK_POLICY",
      ),
    ).toEqual([
      expect.objectContaining({ path: "breakPolicy.poolIds" }),
      expect.objectContaining({ path: "breakPolicy.stationIdPoolIds" }),
    ]);
  });
});
