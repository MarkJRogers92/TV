import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { voicedAssetRule, voicedAssetTags } from "./voicedAssets.js";

export type CsvRecord = Record<string, string>;
export type VoicedImportItem = {
  baseName: string;
  videoPath: string;
  videoSha256: string;
  durationMs: number;
  kind: "bumper" | "station-id";
  title: string;
  tags: string[];
};

/** Small RFC 4180 reader for the two-column/quoted manifest fields we consume. */
export function parseCsv(text: string): CsvRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field.length || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  const [headers, ...data] = rows;
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw new Error("CSV has missing or duplicate headers");
  return data.map((values, rowIndex) => {
    if (values.length !== headers.length)
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]!]));
  });
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeChild = (root: string, candidate: string) => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const path = relative(resolvedRoot, resolvedCandidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Validate both manifests and return only unique, decoded, verified video assets. */
export function buildVoicedImportPlan(input: {
  sourceRoot: string;
  destinationRoot: string;
  channelId?: string;
  manifest: CsvRecord[];
  videos: CsvRecord[];
}): VoicedImportItem[] {
  if (input.manifest.length !== 26)
    throw new Error(`Expected 26 rename-map rows, received ${input.manifest.length}`);
  const verifiedVideos = new Map(input.videos.map((row) => [row.new_base_name, row]));
  if (verifiedVideos.size !== 25 || input.videos.length !== 25)
    throw new Error(`Expected 25 unique video verification rows, received ${input.videos.length}`);
  const seenBases = new Set<string>();
  const plan: VoicedImportItem[] = [];
  for (const row of input.manifest) {
    const baseName = row.new_base_name;
    if (!baseName || seenBases.has(baseName))
      throw new Error(`Missing or duplicate rename-map base name: ${baseName ?? ""}`);
    seenBases.add(baseName);
    if (row.video_status === "excluded_byte_identical_audio") {
      if (row.video_path || row.video_sha256 || !row.duplicate_video_of)
        throw new Error(`Duplicate audio row ${baseName} has inconsistent video fields`);
      continue;
    }
    if (row.video_status !== "rendered_decode_verified" || row.duplicate_video_of)
      throw new Error(`Video ${baseName} is not approved for import: ${row.video_status}`);
    const checked = verifiedVideos.get(baseName);
    if (!checked || checked.full_decode_validation !== "passed")
      throw new Error(`Video ${baseName} has no successful decode record`);
    for (const hash of [row.source_audio_sha256, row.destination_image_sha256, checked.video_sha256])
      if (!sha256Pattern.test(hash ?? "")) throw new Error(`Invalid SHA-256 in manifest row for ${baseName}`);
    if (
      row.video_sha256 !== checked.video_sha256 ||
      row.source_audio_sha256 !== checked.audio_source_sha256 ||
      row.destination_image_sha256 !== checked.image_sha256
    ) throw new Error(`Manifest hash linkage does not agree for ${baseName}`);
    const audioSeconds = Number(row.duration_seconds);
    const videoSeconds = Number(checked.video_duration_seconds);
    const manifestVideoSeconds = Number(row.video_duration_seconds);
    const videoStreamSeconds = Number(checked.video_stream_duration_seconds);
    const audioStreamSeconds = Number(checked.audio_stream_duration_seconds);
    if (
      ![audioSeconds, videoSeconds, manifestVideoSeconds, videoStreamSeconds, audioStreamSeconds].every(Number.isFinite) ||
      Math.abs(audioSeconds - videoSeconds) > 0.02 ||
      Math.abs(manifestVideoSeconds - videoSeconds) > 0.001 ||
      Math.abs(audioSeconds - audioStreamSeconds) > 0.02 ||
      Math.abs(audioSeconds - videoStreamSeconds) > 0.04
    ) throw new Error(`Audio/video duration mismatch for ${baseName}`);
    if (
      checked.video_codec !== "h264" || checked.video_width !== "1920" ||
      checked.video_height !== "1080" || checked.video_fps !== "30/1" ||
      checked.video_pixel_format !== "yuv420p" || checked.audio_codec !== "aac" ||
      checked.audio_sample_rate !== "48000" || checked.audio_channels !== "2"
    ) throw new Error(`Video ${baseName} does not match the approved media profile`);
    const videoPath = resolve(row.video_path);
    const expectedSource = resolve(input.sourceRoot, "videos", `${baseName}.mp4`);
    if (videoPath !== expectedSource || !safeChild(input.sourceRoot, videoPath))
      throw new Error(`Video ${baseName} is outside the prepared videos folder`);
    const destinationPath = resolve(input.destinationRoot, `${baseName}.mp4`);
    if (!safeChild(input.destinationRoot, destinationPath))
      throw new Error(`Invalid destination path for ${baseName}`);
    const rule = voicedAssetRule(baseName);
    plan.push({
      baseName,
      videoPath,
      videoSha256: row.video_sha256,
      durationMs: Math.round(videoSeconds * 1_000),
      kind: rule.kind,
      title: baseName.replaceAll("_", " "),
      tags: voicedAssetTags(baseName, row.match_type, input.channelId ?? "marktv-laughs"),
    });
  }
  if (seenBases.size !== 26 || plan.length !== 25)
    throw new Error(`Expected 25 importable videos after duplicate exclusion, found ${plan.length}`);
  return plan;
}

export function localMediaId(path: string) {
  return `local-${Buffer.from(resolve(path)).toString("base64url")}`;
}

export function isPathInside(root: string, candidate: string) {
  return safeChild(root, candidate) || resolve(root) === resolve(candidate);
}

export function videoFileName(item: VoicedImportItem) {
  return basename(item.videoPath);
}
