import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

export type LivePlayerStatus =
  | "connecting"
  | "buffering"
  | "live"
  | "reconnecting"
  | "paused"
  | "error";

export type LivePlayerHandle = { destroy: () => void };

export type LivePlayerCallbacks = {
  onStatus: (status: LivePlayerStatus) => void;
  onNotice: (notice: string) => void;
};

export type LivePlayerFactory = (
  video: HTMLVideoElement,
  manifestUrl: string,
  callbacks: LivePlayerCallbacks,
) => LivePlayerHandle;

/**
 * Stability-first configuration for a real-time producer.
 *
 * The channel is produced by ffmpeg running with `-readrate 1`, so the live edge
 * advances at exactly wall-clock speed. That makes the distance the player sits
 * behind the edge the *only* thing that can be held in reserve: the client can
 * never buffer further ahead than that. `liveSyncDurationCount` is therefore the
 * single knob that buys protection, and six 4-second segments is about 24s.
 *
 * `liveMaxLatencyDurationCount` is deliberately NOT set. hls.js defaults it to
 * Infinity, and a finite value arms this branch in its latency controller:
 *
 *     if (currentTime < end - maxLatency) {
 *       media.currentTime = liveSyncPosition;
 *     }
 *
 * which seeks straight to the live edge — a position that may not be buffered at
 * all. On this producer the playhead legitimately drifts past a few segments
 * behind the edge, so a finite value here produces exactly the "random jump to
 * live then freeze" failure. `liveSyncMode: "buffered"` is the matching guard for
 * the cases where a resync is genuinely required: it lands on the next buffered
 * range instead of an unbuffered live-edge position.
 */
export const livePlayerConfig = {
  liveSyncDurationCount: 6,
  liveSyncMode: "buffered" as const,
  // hls.js refuses to choose a start fragment until the live playlist holds at
  // least this many fragments. The default of 1 starts playback against a
  // near-empty window, which pins the player to the live edge; because the
  // producer advances at real time, a player at the edge can never build a
  // reserve and starves on every segment boundary. Waiting for a window at
  // least as deep as the target latency is what actually creates the reserve.
  initialLiveManifestSize: 6,
  // Cap the forward buffer at roughly the reserve the channel is asked to keep.
  // `maxMaxBufferLength` is what actually binds: hls.js raises the effective
  // target to `8 * maxBufferSize / bitrate` first, so leaving this high lets a
  // burst-produced window be swallowed whole, pushing playback a minute or more
  // behind the live edge for no extra resilience.
  //
  // Measured, not assumed: raising this to 50s to ride out commercial-break
  // gaps made continuity WORSE (0.942x -> 0.839x of wall clock) and tripped a
  // recovery. The producer is the long pole, and a deeper buffer does not make
  // a slow producer faster — it only adds latency.
  maxBufferLength: 30,
  maxMaxBufferLength: 30,
  backBufferLength: 30,
  manifestLoadingMaxRetry: 4,
  manifestLoadingRetryDelay: 1000,
  levelLoadingMaxRetry: 5,
  levelLoadingRetryDelay: 1000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 1000,
};

/** Total recovery attempts before playback is reported as failed. */
export const RECOVERY_BUDGET = 8;

/** Sustained progress for this long replenishes the recovery budget. */
export const RECOVERY_HEALTHY_MS = 30_000;

/** A forward jump larger than this is reported rather than done silently. */
export const VISIBLE_RESYNC_SECONDS = 10;

/** hls.js sentinel: start at the live edge rather than at a given position. */
export const LIVE_EDGE = -1;

/**
 * How many attempts try to resume where the viewer actually was before giving
 * up on that position. A live window of ~80s at 4s segments holds only ~20
 * segments, so a stalled client that cannot reload will fall out of it within
 * seconds; retrying past this point cannot succeed.
 */
export const POSITION_PRESERVE_ATTEMPTS = 3;

export type RecoveryAction =
  | "reload"
  | "recover-media"
  | "give-up";

/**
 * Chooses a repair for a FATAL hls.js error from its class alone.
 *
 * Deliberately does not consult `details`, and deliberately has no
 * `swapAudioCodec` step: hls.js already swaps the audio codec inside
 * `recoverMediaError()` when the failure is an incompatible append, so a
 * separate audio step would only add an extra failure mode. No AAC-specific
 * fault has been reproduced on this channel, so no codec-specific fallback is
 * warranted. Ordinary buffering never reaches here — that is the watchdog's
 * job, and it is driven by real progress rather than by error events.
 */
export function recoveryActionFor(type: string): RecoveryAction {
  if (type === Hls.ErrorTypes.MEDIA_ERROR) return "recover-media";
  if (type === Hls.ErrorTypes.NETWORK_ERROR) return "reload";
  return "give-up";
}

/** Exponential backoff for recovery attempts, capped at 15s. */
export function recoveryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export type WatchdogInput = {
  nowMs: number;
  currentTime: number;
  playing: boolean;
  seeking: boolean;
  hidden: boolean;
  readyState: number;
};

export type WatchdogVerdict = "ok" | "buffering" | "recover";

/**
 * Detects a stall from real playback progress rather than from playlist parsing.
 *
 * A pause, an in-flight seek, a hidden tab and an element that has not yet
 * decoded anything are all legitimate reasons for the clock to stand still, so
 * each resets the quiet period instead of counting toward recovery. That is what
 * keeps a deliberately paused player from becoming a reconnect loop.
 */
export class StallWatchdog {
  private lastTime = 0;
  private lastChangeMs = 0;
  private armed = false;

  constructor(
    private readonly bufferingAfterMs = 4_000,
    private readonly recoverAfterMs = 12_000,
  ) {}

  reset(nowMs: number, currentTime: number) {
    this.lastTime = currentTime;
    this.lastChangeMs = nowMs;
    this.armed = true;
  }

  sample(input: WatchdogInput): WatchdogVerdict {
    if (!this.armed) {
      this.reset(input.nowMs, input.currentTime);
      return "ok";
    }
    if (
      !input.playing ||
      input.seeking ||
      input.hidden ||
      input.readyState < 2
    ) {
      this.lastChangeMs = input.nowMs;
      this.lastTime = input.currentTime;
      return "ok";
    }
    if (input.currentTime > this.lastTime + 0.1) {
      this.lastTime = input.currentTime;
      this.lastChangeMs = input.nowMs;
      return "ok";
    }
    const quietMs = input.nowMs - this.lastChangeMs;
    if (quietMs >= this.recoverAfterMs) return "recover";
    if (quietMs >= this.bufferingAfterMs) return "buffering";
    return "ok";
  }
}

export const createBrowserLivePlayer: LivePlayerFactory = (
  video,
  manifestUrl,
  callbacks,
) => {
  if (Hls.isSupported()) {
    const hls = new Hls(livePlayerConfig);
    const watchdog = new StallWatchdog();
    let destroyed = false;
    let attempt = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let healthySinceMs: number | null = null;
    let resumeFrom: number | null = null;
    let lastStatus: LivePlayerStatus = "connecting";

    const report = (status: LivePlayerStatus) => {
      if (destroyed || status === lastStatus) return;
      lastStatus = status;
      callbacks.onStatus(status);
    };

    // Only ever called once the clock has genuinely advanced between polls, so
    // Live means frames are being rendered rather than bytes being appended.
    const markHealthy = () => {
      report("live");
      if (healthySinceMs === null) healthySinceMs = Date.now();
      if (Date.now() - healthySinceMs >= RECOVERY_HEALTHY_MS) {
        attempt = 0;
        healthySinceMs = Date.now();
      }
    };

    /** Any interruption restarts the clock that a budget reset depends on. */
    const breakHealth = () => {
      healthySinceMs = null;
    };

    const clearRecoveryTimer = () => {
      if (recoveryTimer !== null) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    };

    /**
     * The single gate for every repair attempt, whatever asked for it.
     *
     * Both the error handler and the watchdog funnel through here so the retry
     * budget cannot be bypassed. A recovery that is already scheduled swallows
     * new requests rather than queueing: without that, a burst of fatal errors
     * (or a watchdog tick landing mid-backoff) would burn the whole budget
     * without a single repair actually running.
     */
    const requestRecovery = (action: RecoveryAction) => {
      if (destroyed) return;
      if (action === "give-up" || attempt >= RECOVERY_BUDGET) {
        report("error");
        return;
      }
      if (recoveryTimer !== null) return;
      // Keep the viewer where they were for the first few attempts. But a live
      // playlist slides on without them, so once the target has left the window
      // no amount of retrying will load it — that just burns the whole budget on
      // a position that no longer exists and parks on the error screen. After a
      // few honest attempts, reload at the live edge and say so.
      const preserving = attempt < POSITION_PRESERVE_ATTEMPTS;
      const position = video.currentTime;
      resumeFrom = preserving ? position : null;
      if (!preserving) {
        callbacks.onNotice(
          "Live TV moved past the buffered point. Playback resumed at the live edge.",
        );
      }
      breakHealth();
      report("reconnecting");
      const delay = recoveryDelayMs(attempt);
      attempt += 1;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (destroyed) return;
        watchdog.reset(Date.now(), position);
        try {
          try {
            // recoverMediaError() re-attaches the media element, which is what
            // clears a broken decoder state. It also resumes internally at
            // media.currentTime (recoverMediaError -> startLoad(time)), so on
            // its own it can never escape a position that has left the live
            // window -- it has to be followed by the escape below.
            if (action === "recover-media") {
              hls.recoverMediaError();
            }
            if (!preserving) {
              // Asking for the live edge needs the second argument, or hls.js
              // silently overrides it. stream-controller.startLoad() does:
              //
              //   if (lastCurrentTime > 0 && startPosition === -1 &&
              //       !skipSeekToStartPosition && this.initPTS.length)
              //     startPosition = lastCurrentTime;
              //
              // Every one of those conditions holds on a player that has
              // already been playing -- the only situation this branch runs in.
              // So `startLoad(-1)` resumes the very position we are abandoning,
              // and the escalation silently does nothing. Passing true keeps
              // startPosition at -1, which setStartPosition() then resolves to
              // liveSyncPosition for a live playlist (getInitialLiveFragment).
              hls.startLoad(LIVE_EDGE, true);
            } else if (action !== "recover-media") {
              // A positive position asks for exactly where playback was.
              // (recoverMediaError() has already resumed at that position.)
              hls.startLoad(position);
            }
          } catch {
            report("error");
          }
        } catch {
          report("error");
        }
      }, delay);
    };

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // Parsing a playlist is not playback. The element has merely been told
      // about the media; nothing has been rendered yet.
      report("buffering");
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) {
        // Non-fatal errors are informational. Buffering in particular must not
        // trigger a media-element reset; the watchdog owns that decision.
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR)
          report("buffering");
        return;
      }
      requestRecovery(recoveryActionFor(data.type));
    });

    hls.loadSource(manifestUrl);
    hls.attachMedia(video);

    const onPlaying = () => {
      if (resumeFrom !== null && video.currentTime - resumeFrom > VISIBLE_RESYNC_SECONDS) {
        callbacks.onNotice(
          "Live content moved ahead while reconnecting. Playback resumed near the live edge.",
        );
      }
      resumeFrom = null;
      watchdog.reset(Date.now(), video.currentTime);
      markHealthy();
    };
    const onPause = () => report("paused");
    const onWaiting = () => {
      if (!video.paused) report("buffering");
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);

    // One poll drives both the stall watchdog and the Live verdict. Progress is
    // measured by comparing the clock across polls rather than by trusting an
    // event, which is what makes `Live` mean "playing" and not "loading".
    let lastSeenTime = video.currentTime;
    watchdog.reset(Date.now(), video.currentTime);
    watchdogTimer = setInterval(() => {
      if (destroyed) return;
      const currentTime = video.currentTime;
      const progressed = currentTime > lastSeenTime + 0.05;
      lastSeenTime = currentTime;
      const verdict = watchdog.sample({
        nowMs: Date.now(),
        currentTime,
        playing: !video.paused && !video.ended,
        seeking: video.seeking,
        hidden:
          typeof document !== "undefined" && document.visibilityState === "hidden",
        readyState: video.readyState,
      });
      if (!video.paused && progressed) markHealthy();
      else if (verdict === "buffering") {
        // Stalling is an interruption: it must reset the health clock that a
        // retry-budget reset depends on, so a marginal stream cannot slowly
        // earn back budget it has not actually earned.
        breakHealth();
        report("buffering");
      }
      if (verdict === "recover") {
        watchdog.reset(Date.now(), currentTime);
        requestRecovery("reload");
      }
    }, 1000);

    return {
      destroy: () => {
        destroyed = true;
        clearRecoveryTimer();
        if (watchdogTimer !== null) clearInterval(watchdogTimer);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("waiting", onWaiting);
        hls.destroy();
      },
    };
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    const ready = () => callbacks.onStatus("live");
    const failed = () => callbacks.onStatus("error");
    video.addEventListener("canplay", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.src = manifestUrl;
    return {
      destroy: () => {
        video.removeEventListener("canplay", ready);
        video.removeEventListener("error", failed);
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  callbacks.onStatus("error");
  return { destroy: () => undefined };
};

const statusLabels: Record<LivePlayerStatus, string> = {
  connecting: "Connecting to live TV…",
  buffering: "Buffering…",
  live: "● Live",
  reconnecting: "Reconnecting…",
  paused: "Paused",
  error: "",
};

export function WatchLive({
  channelId,
  createPlayer = createBrowserLivePlayer,
}: {
  channelId: string;
  createPlayer?: LivePlayerFactory;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<LivePlayerStatus>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const vlcUrl = `/api/v1/watch/${encodeURIComponent(channelId)}/marktv-live.m3u`;

  // Held in a ref so that a caller passing an inline factory — or any unrelated
  // re-render of the page around it — cannot tear down a playing element. The
  // effect below depends on the channel alone.
  const createPlayerRef = useRef(createPlayer);
  createPlayerRef.current = createPlayer;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const manifestUrl = `/api/v1/watch/${encodeURIComponent(channelId)}/stream.m3u8`;
    setStatus("connecting");
    setNotice(null);
    const player = createPlayerRef.current(video, manifestUrl, {
      onStatus: setStatus,
      onNotice: setNotice,
    });
    return () => player.destroy();
  }, [channelId]);

  return (
    <section className="watch-live-page">
      <p className="eyebrow">MarkTV live channel</p>
      <h2>Watch Live</h2>
      <div className="live-player-frame">
        <video
          aria-label="MarkTV live channel"
          autoPlay
          controls
          playsInline
          ref={videoRef}
        />
      </div>
      {status === "live" ? <p className="live-status">{statusLabels.live}</p> : null}
      {status !== "live" && status !== "error" && status !== "paused" ? (
        <p role="status">{statusLabels[status]}</p>
      ) : null}
      {status === "paused" ? <p role="status">{statusLabels.paused}</p> : null}
      {notice ? (
        <p className="player-notice" role="status">
          {notice}
        </p>
      ) : null}
      {status === "error" ? (
        <p
          aria-label="The browser player could not start. Download the VLC playlist instead."
          role="alert"
        >
          The browser player could not start. Download the VLC playlist instead.
        </p>
      ) : null}
      <p className="player-help">
        If the browser player does not start, use the same channel in VLC.
      </p>
      <a className="secondary-action" download href={vlcUrl}>
        Download VLC playlist
      </a>
    </section>
  );
}
