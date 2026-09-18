/**
 * Live playback health check for WATCH LIVE.
 *
 * Complements `verify:restart`, which proves MarkTV itself restarts cleanly. This
 * one answers a different question: is the live stream actually playable right now?
 *
 * The check is the lockstep signature established on 2026-09-17: in a healthy
 * session, the window the playlist advertises and the set of segments retained on
 * disk are the SAME segments, so the first advertised segment number equals the
 * lowest segment number on disk. When Tunarr's advertised window collapses below
 * the retained floor - which it does when something requests an already-deleted
 * segment - every advertised segment is a 404 and `advertisedFirst < diskMin`.
 *
 * SAFETY RULE, and it is not optional: this script only ever requests segments
 * that are INSIDE the advertised window. Requesting a segment below the window is
 * exactly what triggers the collapse in the first place, so a "naive" version of
 * this check that probed every advertised segment would corrupt the very thing it
 * is measuring. The first and last entries are sampled because they are the
 * window's edges, and both are in-window.
 *
 * Side effect: it tunes in, and the master tune-in route is the only one that
 * creates a session. On an idle server this starts a transcode, which tears itself
 * down again after about 135s of no requests. That is deliberate - a playback check
 * that refuses to start playback cannot tell you whether playback works.
 */

const MARKTV = process.env.MARKTV_URL ?? "http://127.0.0.1:4177";
const STREAMS_DIR =
  process.env.TUNARR_STREAMS_DIR ??
  `${process.env.HOME}/Library/Preferences/tunarr/streams`;
const TIMEOUT_MS = Number(process.env.VERIFY_PLAYBACK_TIMEOUT_MS ?? 15_000);

async function get(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  return { response, body: await response.text() };
}

function segmentNumbers(playlist) {
  const numbers = [];
  for (const line of playlist.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const name = (trimmed.split(/[?#]/)[0] ?? "").split("/").pop() ?? "";
    const match = name.match(/(\d+)\.(ts|mp4|vtt)$/);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

const problems = [];
const result = { marktv: MARKTV };

const status = await (await fetch(`${MARKTV}/api/v1/tunarr/status`, {
  signal: AbortSignal.timeout(TIMEOUT_MS),
})).json();

if (!status.configured) {
  console.log(JSON.stringify({ ...result, healthy: false, reason: "not-configured" }));
  process.exit(1);
}

const { marktvChannelId, channelId } = status;
result.channel = marktvChannelId;

// Tune in. The master route is what creates a session upstream.
const master = await get(`${MARKTV}/api/v1/watch/${marktvChannelId}/stream.m3u8`);
result.masterStatus = master.response.status;
if (master.response.status !== 200) {
  problems.push(`master playlist returned ${master.response.status}`);
}

const variantPath = master.body
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line && !line.startsWith("#"));

if (!variantPath) {
  problems.push("master playlist contained no variant");
}

let numbers = [];
if (variantPath) {
  const media = await get(`${MARKTV}${variantPath}`);
  result.mediaStatus = media.response.status;
  result.rewrittenVariant = variantPath;
  if (media.response.status !== 200) {
    problems.push(`variant playlist returned ${media.response.status}`);
  } else {
    numbers = segmentNumbers(media.body);
    if (numbers.length === 0) problems.push("variant playlist advertised no segments");
  }
}

const advertisedFirst = numbers.length ? Math.min(...numbers) : null;
const advertisedLast = numbers.length ? Math.max(...numbers) : null;
result.advertised = { first: advertisedFirst, last: advertisedLast, count: numbers.length };

// The retained set, read straight off disk - no HTTP, so nothing to poison.
let disk = { min: null, max: null, count: 0 };
try {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(`${STREAMS_DIR}/stream_${channelId}`);
  const diskNumbers = entries
    .map((name) => name.match(/^data(\d+)\.ts$/))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  if (diskNumbers.length) {
    disk = {
      min: Math.min(...diskNumbers),
      max: Math.max(...diskNumbers),
      count: diskNumbers.length,
    };
  }
} catch (error) {
  problems.push(`could not read the segment directory: ${error.code ?? error}`);
}
result.disk = disk;

// The signature: the advertised floor must sit inside the retained range.
if (advertisedFirst !== null && disk.min !== null) {
  if (advertisedFirst < disk.min) {
    problems.push(
      `advertised window starts at ${advertisedFirst} but disk starts at ${disk.min} - ` +
        "the window has collapsed below the retained floor; these segments 404",
    );
  }
  if (advertisedFirst > disk.max) {
    problems.push(
      `advertised window starts at ${advertisedFirst} beyond disk max ${disk.max} - ` +
        "producer is behind the playlist",
    );
  }
}

// Sample ONLY the window edges. See the safety rule in the header.
async function sampleSegment(label, segmentNumber) {
  if (segmentNumber === null) return;
  const name = `data${String(segmentNumber).padStart(6, "0")}.ts`;
  const url = `${MARKTV}${variantPath}`.replace(/\/[^/]+$/, `/${name}`);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    result[label] = { name, status: response.status, bytes };
    if (response.status !== 200) problems.push(`${label} ${name} returned ${response.status}`);
    else if (bytes < 1024) problems.push(`${label} ${name} returned only ${bytes} bytes`);
  } catch (error) {
    result[label] = { name, error: String(error) };
    problems.push(`${label} ${name} failed: ${String(error)}`);
  }
}

await sampleSegment("firstSegment", advertisedFirst);
await sampleSegment("lastSegment", advertisedLast);

const healthy = problems.length === 0;
console.log(JSON.stringify({ ...result, healthy, problems }, null, 2));
process.exit(healthy ? 0 : 1);
