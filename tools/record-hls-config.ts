/**
 * Records the EFFECTIVE hls.js configuration the browser player runs.
 *
 * The values that matter for live stability are not only the ones MarkTV sets:
 * hls.js merges them over its own defaults and then re-derives some of them
 * (for example `maxMaxBufferLength` clamps the buffer target that
 * `maxBufferLength` alone appears to set). Reading the merged config is the
 * only way to state what the player actually does.
 *
 * Run: npx vite-node tools/record-hls-config.ts
 */
import Hls from "hls.js";
import { livePlayerConfig } from "../web/pages/WatchLive";

const hls = new Hls(livePlayerConfig);
const config = hls.config as Record<string, unknown>;

const recorded = {
  marktvSupplied: livePlayerConfig,
  effective: Object.fromEntries(
    [
      "liveSyncDurationCount",
      "liveMaxLatencyDurationCount",
      "liveMaxLatencyDuration",
      "liveSyncMode",
      "initialLiveManifestSize",
      "maxBufferLength",
      "maxMaxBufferLength",
      "maxBufferSize",
      "backBufferLength",
      "liveDurationInfinity",
      "lowLatencyMode",
      "maxLiveSyncPlaybackRate",
      "startPosition",
      "manifestLoadingMaxRetry",
      "levelLoadingMaxRetry",
      "fragLoadingMaxRetry",
      "liveSyncOnStallIncrease",
    ].map((key) => [key, config[key]]),
  ),
};

// JSON.stringify maps Infinity to null, which would silently misreport the
// latency ceiling. Render non-finite numbers by name instead.
const show = (value: unknown): unknown =>
  typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
const render = (obj: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, show(v)]));

console.log(
  JSON.stringify(
    { marktvSupplied: render(recorded.marktvSupplied), effective: render(recorded.effective) },
    null,
    2,
  ),
);
