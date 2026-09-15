import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

export type LivePlayerHandle = { destroy: () => void };
export type LivePlayerFactory = (
  video: HTMLVideoElement,
  manifestUrl: string,
  onReady: () => void,
  onError: () => void,
) => LivePlayerHandle;

export const createBrowserLivePlayer: LivePlayerFactory = (
  video,
  manifestUrl,
  onReady,
  onError,
) => {
  if (Hls.isSupported()) {
    const hls = new Hls({
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, onReady);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onError();
    });
    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    return { destroy: () => hls.destroy() };
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    const ready = () => onReady();
    const failed = () => onError();
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

  onError();
  return { destroy: () => undefined };
};

export function WatchLive({
  channelId,
  createPlayer = createBrowserLivePlayer,
}: {
  channelId: string;
  createPlayer?: LivePlayerFactory;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "error">(
    "connecting",
  );
  const manifestUrl = `/api/v1/watch/${encodeURIComponent(channelId)}/stream.m3u8`;
  const vlcUrl = `/api/v1/watch/${encodeURIComponent(channelId)}/marktv-live.m3u`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setStatus("connecting");
    const player = createPlayer(
      video,
      manifestUrl,
      () => setStatus("live"),
      () => setStatus("error"),
    );
    return () => player.destroy();
  }, [channelId, createPlayer, manifestUrl]);

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
        <div aria-label="MarkTV watermark" className="marktv-watermark" role="img">
          <span aria-hidden="true">Mark</span>
          <strong aria-hidden="true">TV</strong>
        </div>
      </div>
      {status === "connecting" ? <p role="status">Connecting to live TV…</p> : null}
      {status === "live" ? <p className="live-status">● Live</p> : null}
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
