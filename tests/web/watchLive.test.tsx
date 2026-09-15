import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hlsMock = vi.hoisted(() => ({
  attachMedia: vi.fn(),
  destroy: vi.fn(),
  isSupported: vi.fn(() => true),
  loadSource: vi.fn(),
  on: vi.fn(),
}));

vi.mock("hls.js", () => {
  class MockHls {
    static Events = { ERROR: "error", MANIFEST_PARSED: "manifestParsed" };
    static isSupported = hlsMock.isSupported;
    attachMedia = hlsMock.attachMedia;
    destroy = hlsMock.destroy;
    loadSource = hlsMock.loadSource;
    on = hlsMock.on;
  }
  return { default: MockHls };
});

import {
  createBrowserLivePlayer,
  WatchLive,
  type LivePlayerFactory,
} from "../../web/pages/WatchLive";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  hlsMock.isSupported.mockReturnValue(true);
});

test("prefers HLS.js when Chromium also claims unreliable native HLS support", () => {
  const video = document.createElement("video");
  vi.spyOn(video, "canPlayType").mockReturnValue("maybe");

  createBrowserLivePlayer(video, "/live.m3u8", vi.fn(), vi.fn());

  expect(hlsMock.loadSource).toHaveBeenCalledWith("/live.m3u8");
  expect(hlsMock.attachMedia).toHaveBeenCalledWith(video);
  expect(video.getAttribute("src")).toBeNull();
});

test("loads the selected channel in a browser player and offers a VLC fallback", async () => {
  const destroy = vi.fn();
  const createPlayer = vi.fn<LivePlayerFactory>(
    (_video, _manifestUrl, onReady) => {
      onReady();
      return { destroy };
    },
  );

  const { unmount } = render(
    <WatchLive channelId="marktv-laughs" createPlayer={createPlayer} />,
  );

  expect(screen.getByRole("heading", { name: "Watch Live" })).toBeVisible();
  const video = screen.getByLabelText("MarkTV live channel");
  expect(video).toHaveAttribute("controls");
  const playerFrame = video.parentElement;
  expect(playerFrame).not.toBeNull();
  expect(
    within(playerFrame as HTMLElement).getByLabelText("MarkTV watermark"),
  ).toHaveTextContent("MarkTV");
  await waitFor(() =>
    expect(createPlayer).toHaveBeenCalledWith(
      video,
      "/api/v1/watch/marktv-laughs/stream.m3u8",
      expect.any(Function),
      expect.any(Function),
    ),
  );
  expect(await screen.findByText("● Live")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Download VLC playlist" }),
  ).toHaveAttribute(
    "href",
    "/api/v1/watch/marktv-laughs/marktv-live.m3u",
  );

  unmount();
  expect(destroy).toHaveBeenCalledOnce();
});

test("shows a useful fallback when browser playback fails", async () => {
  const createPlayer: LivePlayerFactory = (
    _video,
    _manifestUrl,
    _onReady,
    onError,
  ) => {
    onError();
    return { destroy: () => undefined };
  };

  render(<WatchLive channelId="marktv-laughs" createPlayer={createPlayer} />);

  expect(
    await screen.findByRole("alert", {
      name: "The browser player could not start. Download the VLC playlist instead.",
    }),
  ).toBeVisible();
});
