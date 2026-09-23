import { expect, test } from "vitest";
import type { MediaItem } from "../../src/domain/models.js";
import { classifyExistingContinuityAssets } from "../../src/continuity/catalog.js";

const item = (title: string, kind: MediaItem["kind"] = "bumper"): MediaItem => ({
  id: title,
  source: "local-folder",
  path: `/station/${title}.mp4`,
  kind,
  title,
  durationMs: 5_000,
  durationStatus: "ok",
  available: true,
  tags: [],
});

test("classifies existing voiced bumpers without making scoped material evergreen", () => {
  const assets = classifyExistingContinuityAssets([
    item("marktv-up-next-roseanne"),
    item("marktv-return-from-commercial"),
    item("marktv-technical-difficulties"),
    item("marktv-id-late-night-not-judging", "station-id"),
    item("marktv-id-late-night-317am", "station-id"),
    item("marktv-id-primary", "station-id"),
    item("marktv-up-next-generic"),
    item("6388d1f92a71131f9915-03-back-to-the-show"),
    item("bf9b1b0eb401b53541ab-09-please-stand-by-cables"),
  ]);

  expect(assets.find((asset) => asset.mediaId === "marktv-up-next-roseanne")).toMatchObject({
    role: "next",
    targetSlug: "roseanne",
    scope: "title",
    airReady: true,
  });
  expect(assets.find((asset) => asset.mediaId === "marktv-return-from-commercial")).toMatchObject({
    role: "return",
    scope: "evergreen",
  });
  expect(assets.find((asset) => asset.mediaId === "marktv-technical-difficulties")).toMatchObject({
    role: "interruption",
    airReady: false,
  });
  expect(assets.find((asset) => asset.mediaId === "marktv-id-late-night-not-judging")?.personaId).toBe("overnight");
  expect(assets.find((asset) => asset.mediaId === "marktv-id-late-night-317am")).toMatchObject({
    airReady: false,
    rejectReason: "UNSCOPED_CLOCK_CLAIM",
  });
  expect(assets.find((asset) => asset.mediaId === "marktv-id-primary")?.personaId).toBe("network");
  expect(assets.find((asset) => asset.mediaId === "marktv-up-next-generic")).toMatchObject({
    role: "next",
    scope: "evergreen",
    targetSlug: undefined,
  });
  expect(
    assets.find((asset) => asset.mediaId === "6388d1f92a71131f9915-03-back-to-the-show"),
  ).toMatchObject({ role: "return", airReady: true });
  expect(
    assets.find((asset) => asset.mediaId === "bf9b1b0eb401b53541ab-09-please-stand-by-cables"),
  ).toMatchObject({ role: "interruption", airReady: false });
});

test("does not report rendered silent general cards as voice coverage", () => {
  const general = item("d8912e9a4f80e672167a-01-youre-still-here", "station-id");
  general.path = "/station/general-cards-generated/d8912e9a4f80e672167a-01-youre-still-here.mp4";
  general.tags = ["continuity", "visual-only", "user-approved-legacy-card"];
  expect(classifyExistingContinuityAssets([general])[0]).toMatchObject({
    airReady: true,
    voicePresent: false,
  });
});

test("fails closed on voiced assets with missing or invalid channel, role, or scope tags", () => {
  const base = item("Unclassified voiced asset");
  base.tags = [
    "voiced-continuity",
    "continuity-channel=marktv-laughs",
    "continuity-channel=marktv-laughs",
    "continuity-role=surprise",
    "continuity-scope=clock",
  ];
  expect(classifyExistingContinuityAssets([base])[0]).toMatchObject({
    airReady: false,
    rejectReason: "INVALID_ASSET_METADATA",
  });
});

test("classifies only an explicit shared-channel allowlist", () => {
  const shared = item("MarkTV break bumper");
  shared.tags = [
    "voiced-continuity", "continuity-channel=marktv-laughs",
    "continuity-shared-channels=marktv-movies,marktv-cult-movies",
    "continuity-role=break", "continuity-scope=evergreen",
    "continuity-map=MARKTV_BREAK_OUT_001",
  ];
  expect(classifyExistingContinuityAssets([shared])[0]).toMatchObject({
    airReady: true,
    channelId: "marktv-laughs",
    channelIds: ["marktv-movies", "marktv-cult-movies"],
  });
  shared.tags[2] = "continuity-shared-channels=marktv-unknown";
  expect(classifyExistingContinuityAssets([shared])[0]).toMatchObject({
    airReady: false,
    rejectReason: "INVALID_ASSET_METADATA",
  });
});
