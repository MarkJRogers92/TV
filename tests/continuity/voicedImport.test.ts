import { resolve } from "node:path";
import { expect, test } from "vitest";
import { buildVoicedImportPlan, type CsvRecord } from "../../src/continuity/voicedImport.js";

test("uses the decoded MP4 container duration rather than its shorter source audio", () => {
  const sourceRoot = "/prepared";
  const manifest: CsvRecord[] = [];
  const videos: CsvRecord[] = [];
  for (let index = 0; index < 25; index += 1) {
    const baseName = `test_asset_${index}`;
    const audioHash = "a".repeat(64);
    const imageHash = "b".repeat(64);
    const videoHash = "c".repeat(64);
    const audioDuration = index === 0 ? 8.32 : 5.2;
    const videoDuration = index === 0 ? 8.333333 : 5.2;
    manifest.push({
      new_base_name: baseName,
      video_status: "rendered_decode_verified",
      video_path: resolve(sourceRoot, "videos", `${baseName}.mp4`),
      video_sha256: videoHash,
      source_audio_sha256: audioHash,
      destination_image_sha256: imageHash,
      duration_seconds: String(audioDuration),
      video_duration_seconds: String(videoDuration),
      match_type: "fixture",
    });
    videos.push({
      new_base_name: baseName,
      video_sha256: videoHash,
      audio_source_sha256: audioHash,
      image_sha256: imageHash,
      video_duration_seconds: String(videoDuration),
      video_stream_duration_seconds: String(videoDuration),
      audio_stream_duration_seconds: String(audioDuration),
      video_codec: "h264",
      video_width: "1920",
      video_height: "1080",
      video_fps: "30/1",
      video_pixel_format: "yuv420p",
      audio_codec: "aac",
      audio_sample_rate: "48000",
      audio_channels: "2",
      full_decode_validation: "passed",
    });
  }
  manifest.push({
    new_base_name: "duplicate_audio",
    video_status: "excluded_byte_identical_audio",
    video_path: "",
    video_sha256: "",
    duplicate_video_of: "test_asset_0",
  });

  const imported = buildVoicedImportPlan({
    sourceRoot,
    destinationRoot: "/library/generated/voiced",
    manifest,
    videos,
  });
  expect(imported[0]?.durationMs).toBe(8_333);
});
