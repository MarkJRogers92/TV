import { describe, expect, test, vi } from "vitest";
import {
  collectPreflightEvidence,
  PREFLIGHT_MAX_BUFFER_BYTES,
  PREFLIGHT_TIMEOUT_MS,
  type PreflightRunner,
} from "../../src/preparation/preflight.js";

const probeJson = JSON.stringify({
  format: { duration: "120" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, start_time: "0", duration: "120", disposition: { default: 0 } },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, start_time: "0", duration: "120", disposition: { default: 1 } },
    { index: 2, codec_type: "video", codec_name: "hevc", width: 1280, height: 720, start_time: "0", duration: "120", disposition: { default: 1 } },
  ],
});

function fixtureRunner(options: {
  probe?: string;
  ffmpeg?: (args: readonly string[]) => Promise<void>;
  onCall?: (file: string, args: readonly string[], opts: { timeout: number; maxBuffer: number; shell: false }) => void;
} = {}): PreflightRunner {
  return async (file, args, opts) => {
    options.onCall?.(file, args, opts);
    if (file === "ffprobe") return { stdout: options.probe ?? probeJson, stderr: "" };
    await options.ffmpeg?.(args);
    return { stdout: "", stderr: "" };
  };
}

const versions = (size = "500") => ({
  path: "/approved/media/episode.mp4", sizeBytes: size, modifiedMs: "1720000000000",
  deviceId: "1", inode: "10",
});

describe("preparation preflight evidence", () => {
  test("metadata facts select default tracks and never imply a full decode", async () => {
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      runner: fixtureRunner(), statFile: async () => versions(),
    });

    expect(evidence.result).toBe("metadata_only");
    expect(evidence.metadata).toMatchObject({
      status: "passed", durationSeconds: 120, selectedVideoTrackIndex: 2, selectedAudioTrackIndex: 1,
    });
    expect(evidence.metadata.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 2, type: "video", codec: "hevc", selected: true, width: 1280, height: 720 }),
      expect.objectContaining({ index: 1, type: "audio", codec: "aac", selected: true, sampleRate: 48000, channels: 2 }),
    ]));
    expect(evidence.sampledDecode.status).toBe("deferred");
    expect(evidence.fullDecode.status).toBe("deferred");
    expect(evidence.result).not.toBe("fully_decoded");
    expect(evidence.sourceUnchanged).toBe(true);
  });

  test("sampled decode records exact distributed intervals and selected track mapping", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      level: "sampled",
      runner: fixtureRunner({ onCall: (file, args) => calls.push({ file, args }) }),
      statFile: async () => versions(),
    });

    expect(evidence.result).toBe("sampled");
    expect(evidence.sampledDecode).toEqual({ status: "passed", testedRanges: [
      { startSeconds: 0, durationSeconds: 2 },
      { startSeconds: 59, durationSeconds: 2 },
      { startSeconds: 118, durationSeconds: 2 },
    ] });
    const sampleCalls = calls.filter((call) => call.file === "ffmpeg");
    expect(sampleCalls).toHaveLength(3);
    expect(sampleCalls[0].args).toContain("0:2");
    expect(sampleCalls[0].args).toContain("/approved/media/episode.mp4");
    expect(sampleCalls[0].args).toContain("0:1");
    expect(sampleCalls[0].args).toContain("-xerror");
    expect(evidence.fullDecode.status).toBe("deferred");
  });

  test("full decode is the only fully-decoded result and tolerates informational reorder diagnostics", async () => {
    const calls: string[][] = [];
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      level: "full",
      runner: async (file, args, options) => {
        expect(options.shell).toBe(false);
        calls.push([file, ...args]);
        if (file === "ffprobe") return { stdout: probeJson, stderr: "" };
        return { stdout: "", stderr: "Past duration too large; adjusting." };
      },
      statFile: async () => versions(),
    });

    expect(evidence.result).toBe("fully_decoded");
    expect(evidence.fullDecode).toEqual({ status: "passed", testedRanges: [{ startSeconds: 0, durationSeconds: 120 }] });
    expect(calls[1]).toContain("0:2");
    expect(calls[1]).toContain("0:1");
  });

  test("a real selected-track decode failure is reported as corruption evidence", async () => {
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      level: "full",
      runner: fixtureRunner({ ffmpeg: async () => { throw Object.assign(new Error("invalid frame"), { code: 1 }); } }),
      statFile: async () => versions(),
    });

    expect(evidence.result).toBe("decode_error");
    expect(evidence.fullDecode).toMatchObject({ status: "failed", reason: "probe_or_decode_failed" });
  });

  test("tool timeout and missing media are unavailable evidence, not decode corruption", async () => {
    const timeoutRunner = fixtureRunner({ ffmpeg: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true }); } });
    const timedOut = await collectPreflightEvidence("/approved/media/episode.mp4", {
      level: "sampled", runner: timeoutRunner, statFile: async () => versions(),
    });
    expect(timedOut.result).toBe("unavailable");
    expect(timedOut.sampledDecode.status).toBe("unavailable");

    const missing = await collectPreflightEvidence("/missing.mp4", {
      runner: fixtureRunner(), statFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });
    expect(missing.result).toBe("unavailable");
    expect(missing.sourceBefore).toBeNull();
    expect(missing.metadata.reason).toBe("media_or_tool_unavailable");
  });

  test("records no-video or missing-duration metadata as unavailable", async () => {
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      runner: fixtureRunner({ probe: JSON.stringify({ format: { duration: "0" }, streams: [{ index: 0, codec_type: "audio" }] }) }),
      statFile: async () => versions(),
    });
    expect(evidence.result).toBe("unavailable");
    expect(evidence.metadata).toMatchObject({ status: "unavailable", durationSeconds: 0, reason: "no_readable_video_track" });
  });

  test("marks evidence stale when source version changes during the probe", async () => {
    let call = 0;
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      runner: fixtureRunner(), statFile: async () => versions(++call === 1 ? "500" : "501"),
    });
    expect(evidence.result).toBe("stale_source");
    expect(evidence.sourceUnchanged).toBe(false);
    expect(evidence.sourceBefore?.sizeBytes).toBe("500");
    expect(evidence.sourceAfter?.sizeBytes).toBe("501");
  });

  test("bounds timeout and output and invokes ffprobe without a shell", async () => {
    const calls = vi.fn();
    await collectPreflightEvidence("/approved/media/episode.mp4", {
      runner: fixtureRunner({ onCall: (...args) => calls(...args) }),
      statFile: async () => versions(),
    });
    expect(calls).toHaveBeenCalledWith("ffprobe", expect.any(Array), {
      timeout: PREFLIGHT_TIMEOUT_MS, maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES, shell: false,
    });
  });

  test("requests the real ffprobe disposition tokens, not a dotted path that emits nothing", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    await collectPreflightEvidence("/approved/media/episode.mp4", {
      runner: fixtureRunner({ onCall: (file, args) => calls.push({ file, args }) }),
      statFile: async () => versions(),
    });
    const probe = calls.find((call) => call.file === "ffprobe")!;
    const entries = probe.args[probe.args.indexOf("-show_entries") + 1];
    expect(entries).toContain("stream_disposition=default");
    expect(entries).toContain("stream_disposition=attached_pic");
    // `disposition.default` makes real ffprobe emit no disposition at all.
    expect(entries).not.toContain("disposition.default");
  });

  test("embedded cover art is not treated as a readable video track", async () => {
    const probe = JSON.stringify({
      format: { duration: "120" },
      streams: [
        { index: 0, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, duration: "120", disposition: { default: 1, attached_pic: 0 } },
        { index: 1, codec_type: "video", codec_name: "mjpeg", width: 64, height: 64, disposition: { default: 0, attached_pic: 1 } },
      ],
    });
    const evidence = await collectPreflightEvidence("/approved/media/song.m4a", {
      runner: fixtureRunner({ probe }), statFile: async () => versions(),
    });
    expect(evidence.result).toBe("unavailable");
    expect(evidence.metadata).toMatchObject({ status: "unavailable", reason: "no_readable_video_track" });
  });

  test("an ffprobe failure on an unreadable file is decode evidence, not unavailability", async () => {
    const evidence = await collectPreflightEvidence("/approved/media/broken.mkv", {
      runner: async () => { throw Object.assign(new Error("Invalid data found when processing input"), { code: 1 }); },
      statFile: async () => versions(),
    });
    expect(evidence.result).toBe("decode_error");
    expect(evidence.metadata.status).toBe("failed");
  });

  test("an unverifiable post-probe re-stat fails closed as unavailable, not stale_source", async () => {
    let call = 0;
    const evidence = await collectPreflightEvidence("/approved/media/episode.mp4", {
      runner: fixtureRunner(),
      statFile: async () => {
        call += 1;
        if (call === 1) return versions();
        throw Object.assign(new Error("i/o error"), { code: "EIO" });
      },
    });
    expect(evidence.result).toBe("unavailable");
    expect(evidence.sourceUnchanged).toBeNull();
    expect(evidence.sourceBefore).not.toBeNull();
  });

  test("stream duration is a fallback when the container omits its own duration", async () => {
    const probe = JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 1280, height: 720, duration: "90", disposition: { default: 1 } },
        { index: 1, codec_type: "audio", codec_name: "aac", duration: "90", disposition: { default: 1 } },
      ],
    });
    const evidence = await collectPreflightEvidence("/approved/media/fragmented.ts", {
      runner: fixtureRunner({ probe }), statFile: async () => versions(),
    });
    expect(evidence.result).toBe("metadata_only");
    expect(evidence.metadata).toMatchObject({ status: "passed", durationSeconds: 90 });
  });
});
