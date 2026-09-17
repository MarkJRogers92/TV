import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Handler = (event: string, payload: unknown) => void;

const hlsMock = vi.hoisted(() => {
  const state = {
    handlers: {} as Record<string, Handler[]>,
    lastConfig: undefined as Record<string, unknown> | undefined,
    attachMedia: vi.fn(),
    destroy: vi.fn(),
    isSupported: vi.fn(() => true),
    loadSource: vi.fn(),
    recoverMediaError: vi.fn(),
    startLoad: vi.fn(),
    swapAudioCodec: vi.fn(),
    on: vi.fn((event: string, callback: Handler) => {
      (state.handlers[event] ??= []).push(callback);
    }),
    emit(event: string, payload?: unknown) {
      for (const callback of state.handlers[event] ?? []) callback(event, payload);
    },
    reset() {
      state.handlers = {};
      state.lastConfig = undefined;
    },
  };
  return state;
});

vi.mock("hls.js", () => {
  class MockHls {
    static Events = {
      ERROR: "hlsError",
      FRAG_CHANGED: "hlsFragChanged",
      MANIFEST_PARSED: "hlsManifestParsed",
    };
    static ErrorTypes = {
      MEDIA_ERROR: "mediaError",
      NETWORK_ERROR: "networkError",
      OTHER_ERROR: "otherError",
    };
    static ErrorDetails = {
      BUFFER_STALLED_ERROR: "bufferStalledError",
      FRAG_LOAD_ERROR: "fragLoadError",
    };
    static isSupported = hlsMock.isSupported;
    constructor(config: Record<string, unknown>) {
      hlsMock.lastConfig = config;
    }
    attachMedia = hlsMock.attachMedia;
    destroy = hlsMock.destroy;
    loadSource = hlsMock.loadSource;
    on = hlsMock.on;
    recoverMediaError = hlsMock.recoverMediaError;
    startLoad = hlsMock.startLoad;
    swapAudioCodec = hlsMock.swapAudioCodec;
  }
  return { default: MockHls };
});

import {
  createBrowserLivePlayer,
  LIVE_EDGE,
  livePlayerConfig,
  POSITION_PRESERVE_ATTEMPTS,
  RECOVERY_BUDGET,
  recoveryActionFor,
  recoveryDelayMs,
  StallWatchdog,
  WatchLive,
  type LivePlayerFactory,
} from "../../web/pages/WatchLive";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  hlsMock.reset();
  hlsMock.isSupported.mockReturnValue(true);
});

const fatal = (type: string) => ({
  details: "fragLoadError",
  fatal: true,
  type,
});

test("prefers HLS.js when Chromium also claims unreliable native HLS support", () => {
  const video = document.createElement("video");
  vi.spyOn(video, "canPlayType").mockReturnValue("maybe");

  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: vi.fn(),
  });

  expect(hlsMock.loadSource).toHaveBeenCalledWith("/live.m3u8");
  expect(hlsMock.attachMedia).toHaveBeenCalledWith(video);
  expect(video.getAttribute("src")).toBeNull();
});

test("never arms the forced jump to the live edge", () => {
  // hls.js's latency controller seeks with `media.currentTime = liveSyncPosition`
  // whenever the playhead is more than `liveMaxLatencyDurationCount *
  // targetduration` behind the edge. That seek can land in an unbuffered region
  // and freeze playback, which is the regression this guards.
  const video = document.createElement("video");
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: vi.fn(),
  });

  const config = hlsMock.lastConfig ?? {};
  expect(config.liveMaxLatencyDurationCount).toBeUndefined();
  expect(livePlayerConfig.liveSyncMode).toBe("buffered");
  // The producer runs at 1x, so distance behind the edge is the only reserve.
  // Six 4s segments is roughly the 20-30s of slack the channel is asked to keep.
  expect(livePlayerConfig.liveSyncDurationCount).toBeGreaterThanOrEqual(5);
  expect(livePlayerConfig.liveSyncDurationCount * 4).toBeGreaterThanOrEqual(20);
  expect(livePlayerConfig.maxBufferLength).toBeGreaterThanOrEqual(
    livePlayerConfig.liveSyncDurationCount * 4,
  );
  // Starting against a near-empty window pins playback to the live edge, where a
  // real-time producer can never build a reserve. The start window must be at
  // least as deep as the target latency for that reserve to exist at all.
  expect(livePlayerConfig.initialLiveManifestSize).toBeGreaterThanOrEqual(
    livePlayerConfig.liveSyncDurationCount,
  );
});

test("classifies fatal errors by class and treats the rest as unrecoverable", () => {
  expect(recoveryActionFor("networkError")).toBe("reload");
  expect(recoveryActionFor("mediaError")).toBe("recover-media");
  // Neither of these has a documented repair, so they must not be retried.
  expect(recoveryActionFor("otherError")).toBe("give-up");
  expect(recoveryActionFor("keySystemError")).toBe("give-up");
  // Backoff is bounded, so the loop can never spin.
  expect(recoveryDelayMs(0)).toBe(1000);
  expect(recoveryDelayMs(20)).toBe(15_000);
});

test("uses only recoverMediaError for media faults and never swapAudioCodec", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: vi.fn(),
  });

  // Several media faults in a row: no codec-specific step should ever appear.
  for (let round = 0; round < 3; round += 1) {
    act(() => hlsMock.emit("hlsError", fatal("mediaError")));
    act(() => vi.advanceTimersByTime(60_000));
  }

  expect(hlsMock.recoverMediaError).toHaveBeenCalled();
  expect(hlsMock.swapAudioCodec).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("does not reset or repair anything for a non-fatal error", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  const statuses: string[] = [];
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });

  act(() =>
    hlsMock.emit("hlsError", {
      details: "bufferStalledError",
      fatal: false,
      type: "otherError",
    }),
  );
  act(() => vi.advanceTimersByTime(60_000));

  // Non-fatal buffering is reported, never repaired by resetting the element.
  expect(hlsMock.recoverMediaError).not.toHaveBeenCalled();
  expect(hlsMock.startLoad).not.toHaveBeenCalled();
  expect(statuses).not.toContain("reconnecting");
  vi.useRealTimers();
});

test("collapses a burst of fatal errors into a single repair attempt", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: vi.fn(),
  });

  act(() => {
    hlsMock.emit("hlsError", fatal("networkError"));
    hlsMock.emit("hlsError", fatal("networkError"));
    hlsMock.emit("hlsError", fatal("networkError"));
  });
  act(() => vi.advanceTimersByTime(2_000));

  // Overlapping requests must not each consume budget and each fire a reload.
  expect(hlsMock.startLoad).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("never resets the retry budget without sustained healthy playback", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  let clock = 0;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => clock,
    set: (value: number) => {
      clock = value;
    },
  });
  Object.defineProperty(video, "paused", { configurable: true, get: () => false });
  Object.defineProperty(video, "seeking", { configurable: true, get: () => false });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });

  const statuses: string[] = [];
  const handle = createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });

  // Burn the whole budget with the clock pinned, then let the watchdog take over.
  for (let second = 0; second < 600; second += 1) {
    act(() => void vi.advanceTimersByTime(1_000));
  }
  expect(statuses).toContain("error");
  const spent = hlsMock.startLoad.mock.calls.length;

  // Brief progress, well under the healthy window: the budget must NOT refill.
  for (let second = 0; second < 10; second += 1) {
    clock += 1;
    act(() => void vi.advanceTimersByTime(1_000));
  }
  for (let second = 0; second < 300; second += 1) {
    act(() => void vi.advanceTimersByTime(1_000));
  }
  expect(hlsMock.startLoad.mock.calls.length).toBeLessThanOrEqual(
    Math.max(spent, RECOVERY_BUDGET) + 1,
  );
  expect(hlsMock.startLoad.mock.calls.length).toBeLessThanOrEqual(RECOVERY_BUDGET + 1);

  handle.destroy();
  vi.useRealTimers();
});

test("recovers a fatal network error by reloading at the current position", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    value: 120,
    writable: true,
  });
  const statuses: string[] = [];
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });

  act(() => hlsMock.emit("hlsError", fatal("networkError")));
  expect(statuses).toContain("reconnecting");

  act(() => vi.advanceTimersByTime(recoveryDelayMs(0)));
  expect(hlsMock.startLoad).toHaveBeenCalledWith(120);
  vi.useRealTimers();
});

test("repairs a media error with the media-element recovery calls", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: vi.fn(),
  });

  act(() => hlsMock.emit("hlsError", fatal("mediaError")));
  act(() => vi.advanceTimersByTime(recoveryDelayMs(0)));
  expect(hlsMock.recoverMediaError).toHaveBeenCalled();
  vi.useRealTimers();
});

test("falls back to the live edge when the saved position cannot be resumed", () => {
  // A live window slides on without a stalled client. Retrying the position it
  // was on can never succeed once that position leaves the window, so recovery
  // must eventually ask for the live edge instead of exhausting the budget on a
  // position that no longer exists — which parked the player on the error screen
  // at every programme boundary.
  vi.useFakeTimers();
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    value: 120,
    writable: true,
  });
  const notices: string[] = [];
  const handle = createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: (notice) => notices.push(notice),
    onStatus: vi.fn(),
  });

  for (let i = 0; i <= POSITION_PRESERVE_ATTEMPTS; i += 1) {
    act(() => hlsMock.emit("hlsError", fatal("networkError")));
    act(() => void vi.advanceTimersByTime(recoveryDelayMs(i) + 10));
  }

  const calls = hlsMock.startLoad.mock.calls;
  const targets = calls.map((call) => call[0]);
  expect(targets.slice(0, POSITION_PRESERVE_ATTEMPTS)).toEqual(
    Array(POSITION_PRESERVE_ATTEMPTS).fill(120),
  );
  expect(targets[POSITION_PRESERVE_ATTEMPTS]).toBe(LIVE_EDGE);
  // Asserting the requested target alone is not enough. hls.js replaces a -1
  // startPosition with lastCurrentTime unless skipSeekToStartPosition is set
  // (stream-controller.startLoad: `lastCurrentTime > 0 && startPosition === -1
  // && !skipSeekToStartPosition && this.initPTS.length`), which would resume the
  // abandoned position instead of escaping to the live edge. The flag is what
  // makes the escape real.
  expect(calls[POSITION_PRESERVE_ATTEMPTS][1]).toBe(true);
  expect(notices.join(" ")).toMatch(/live edge/i);

  handle.destroy();
  vi.useRealTimers();
});

test("escalates a media error to the live edge once the position budget is spent", () => {
  // recoverMediaError() resumes internally at media.currentTime
  // (recoverMediaError -> startLoad(time)), so on its own it can never escape a
  // position that has left the live window. Without the follow-up escape the
  // notice above it would announce the live edge while playback resumed the
  // very position it was trying to abandon.
  vi.useFakeTimers();
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    value: 120,
    writable: true,
  });
  const notices: string[] = [];
  const handle = createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: (notice) => notices.push(notice),
    onStatus: vi.fn(),
  });

  for (let i = 0; i <= POSITION_PRESERVE_ATTEMPTS; i += 1) {
    act(() => hlsMock.emit("hlsError", fatal("mediaError")));
    act(() => void vi.advanceTimersByTime(recoveryDelayMs(i) + 10));
  }

  expect(hlsMock.recoverMediaError).toHaveBeenCalled();
  const calls = hlsMock.startLoad.mock.calls;
  const escape = calls[calls.length - 1];
  expect(escape[0]).toBe(LIVE_EDGE);
  expect(escape[1]).toBe(true);
  expect(notices.join(" ")).toMatch(/live edge/i);

  handle.destroy();
  vi.useRealTimers();
});

test("stops and reports failure once recovery attempts are exhausted", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  const statuses: string[] = [];
  createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });

  for (let attempt = 0; attempt < RECOVERY_BUDGET; attempt += 1) {
    act(() => hlsMock.emit("hlsError", fatal("networkError")));
    act(() => vi.advanceTimersByTime(recoveryDelayMs(attempt)));
  }
  act(() => hlsMock.emit("hlsError", fatal("networkError")));

  expect(statuses).toContain("error");
  expect(hlsMock.startLoad.mock.calls.length).toBeLessThanOrEqual(
    RECOVERY_BUDGET,
  );
  vi.useRealTimers();
});

test("does not treat a paused player, a seek, or a hidden tab as a stall", () => {
  const watchdog = new StallWatchdog();
  watchdog.reset(0, 10);
  const base = { currentTime: 10, nowMs: 0 };

  // Deliberately paused: the clock is expected to stand still.
  expect(
    watchdog.sample({ ...base, nowMs: 30_000, playing: false, seeking: false, hidden: false, readyState: 4 }),
  ).toBe("ok");
  // In-flight seek.
  expect(
    watchdog.sample({ ...base, nowMs: 60_000, playing: true, seeking: true, hidden: false, readyState: 4 }),
  ).toBe("ok");
  // Backgrounded tab.
  expect(
    watchdog.sample({ ...base, nowMs: 90_000, playing: true, seeking: false, hidden: true, readyState: 4 }),
  ).toBe("ok");
  // Nothing decoded yet.
  expect(
    watchdog.sample({ ...base, nowMs: 120_000, playing: true, seeking: false, hidden: false, readyState: 1 }),
  ).toBe("ok");
});

test("escalates a genuine stall from buffering to recovery", () => {
  const watchdog = new StallWatchdog(4_000, 12_000);
  watchdog.reset(0, 10);
  const stalled = {
    currentTime: 10,
    playing: true,
    seeking: false,
    hidden: false,
    readyState: 4,
  };

  expect(watchdog.sample({ ...stalled, nowMs: 2_000 })).toBe("ok");
  expect(watchdog.sample({ ...stalled, nowMs: 5_000 })).toBe("buffering");
  expect(watchdog.sample({ ...stalled, nowMs: 13_000 })).toBe("recover");
});

test("reports Live only once frames are actually progressing", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  let clock = 0;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => clock,
    set: (value: number) => {
      clock = value;
    },
  });
  Object.defineProperty(video, "paused", { configurable: true, get: () => false });
  Object.defineProperty(video, "seeking", { configurable: true, get: () => false });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });

  const statuses: string[] = [];
  const handle = createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });

  act(() => hlsMock.emit("hlsManifestParsed"));
  // Parsing a playlist must not be reported as playback.
  expect(statuses).toEqual(["buffering"]);

  // A poll with a stationary clock is still not playback.
  act(() => void vi.advanceTimersByTime(1000));
  expect(statuses).not.toContain("live");

  clock = 4;
  act(() => void vi.advanceTimersByTime(1000));
  expect(statuses).toContain("live");

  handle.destroy();
  vi.useRealTimers();
});

test("reports a paused player as paused rather than reconnecting", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  let paused = false;
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => paused,
  });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });

  const statuses: string[] = [];
  const handle = createBrowserLivePlayer(video, "/live.m3u8", {
    onNotice: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });

  paused = true;
  act(() => void video.dispatchEvent(new Event("pause")));
  expect(statuses).toContain("paused");

  // Long idle time while paused must not be treated as a stall to recover from.
  act(() => void vi.advanceTimersByTime(60_000));
  expect(statuses).not.toContain("reconnecting");
  expect(statuses).not.toContain("error");

  handle.destroy();
  vi.useRealTimers();
});

test("reports Live through the component only after playback is under way", async () => {
  const createPlayer: LivePlayerFactory = (video) => {
    // Parsing a playlist is not playback.
    hlsMock.emit("hlsManifestParsed");
    video.currentTime = 5;
    return { destroy: () => undefined };
  };

  render(<WatchLive channelId="marktv-laughs" createPlayer={createPlayer} />);

  expect(screen.queryByText("● Live")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toBeVisible();
});

test("keeps one player instance across unrelated re-renders", () => {
  const destroy = vi.fn();
  const first: LivePlayerFactory = () => ({ destroy });
  const second: LivePlayerFactory = () => ({ destroy: vi.fn() });

  const { rerender } = render(
    <WatchLive channelId="marktv-laughs" createPlayer={first} />,
  );
  // A caller passing a fresh inline factory must not tear down the element.
  rerender(<WatchLive channelId="marktv-laughs" createPlayer={second} />);
  rerender(<WatchLive channelId="marktv-laughs" createPlayer={second} />);

  expect(destroy).not.toHaveBeenCalled();
});

test("rebuilds the player when the channel actually changes", () => {
  const destroy = vi.fn();
  const createPlayer: LivePlayerFactory = () => ({ destroy });

  const { rerender } = render(
    <WatchLive channelId="marktv-laughs" createPlayer={createPlayer} />,
  );
  rerender(<WatchLive channelId="another-channel" createPlayer={createPlayer} />);

  expect(destroy).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Download VLC playlist" })).toHaveAttribute(
    "href",
    "/api/v1/watch/another-channel/marktv-live.m3u",
  );
});

test("loads the selected channel in a browser player and offers a VLC fallback", async () => {
  const destroy = vi.fn();
  const createPlayer = vi.fn<LivePlayerFactory>((_video, _manifestUrl, callbacks) => {
    callbacks.onStatus("live");
    return { destroy };
  });

  const { unmount } = render(
    <WatchLive channelId="marktv-laughs" createPlayer={createPlayer} />,
  );

  expect(screen.getByRole("heading", { name: "Watch Live" })).toBeVisible();
  const video = screen.getByLabelText("MarkTV live channel");
  expect(video).toHaveAttribute("controls");
  expect(screen.queryByLabelText("MarkTV watermark")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(createPlayer).toHaveBeenCalledWith(
      video,
      "/api/v1/watch/marktv-laughs/stream.m3u8",
      expect.objectContaining({ onNotice: expect.any(Function), onStatus: expect.any(Function) }),
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
  const createPlayer: LivePlayerFactory = (_video, _manifestUrl, callbacks) => {
    callbacks.onStatus("error");
    return { destroy: () => undefined };
  };

  render(<WatchLive channelId="marktv-laughs" createPlayer={createPlayer} />);

  expect(
    await screen.findByRole("alert", {
      name: "The browser player could not start. Download the VLC playlist instead.",
    }),
  ).toBeVisible();
});
