#!/usr/bin/env python3
"""Verify every MarkTV clip can be probed and decoded with the expected profile."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import subprocess
from pathlib import Path


def probe(ffprobe: str, path: Path) -> dict:
    data = json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,width,height,avg_frame_rate,sample_rate,channels",
        "-of", "json", str(path)
    ], text=True))
    video = next(stream for stream in data["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in data["streams"] if stream["codec_type"] == "audio")
    return {
        "duration_seconds": float(data["format"]["duration"]),
        "width": int(video["width"]), "height": int(video["height"]),
        "frame_rate": video["avg_frame_rate"], "audio_sample_rate": int(audio["sample_rate"]),
        "audio_channels": int(audio["channels"]),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()

    manifest_path = args.output_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    clips_dir = args.output_dir / "clips"
    if not clips_dir.is_dir():
        clips_dir = args.output_dir
    records = manifest["clips"]
    expected = {record["filename"] for record in records}
    actual = {path.name for path in clips_dir.glob("*.mp4")}
    failures: list[dict] = []
    warnings: list[dict] = []
    source = Path(manifest.get("source_file", manifest.get("source")))
    source_profile_info = probe(args.ffprobe, source)
    source_profile = (source_profile_info["width"], source_profile_info["height"], source_profile_info["frame_rate"], source_profile_info["audio_sample_rate"], source_profile_info["audio_channels"])

    if actual != expected:
        failures.append({
            "check": "file set",
            "missing": sorted(expected - actual),
            "unexpected": sorted(actual - expected),
        })

    for record in records:
        path = clips_dir / record["filename"]
        info = record.get("output_probe") or probe(args.ffprobe, path)
        expected_duration = record.get("duration_seconds", record.get("duration"))
        delta = abs(info["duration_seconds"] - expected_duration)
        if delta > 0.30:
            failures.append({"clip_number": record["clip_number"], "check": "duration", "delta_seconds": round(delta, 3)})
        elif delta > 0.10:
            warnings.append({"clip_number": record["clip_number"], "check": "duration", "delta_seconds": round(delta, 3)})
        profile = (info["width"], info["height"], info["frame_rate"], info["audio_sample_rate"], info["audio_channels"])
        if profile != source_profile:
            failures.append({"clip_number": record["clip_number"], "check": "profile", "actual": profile})

    def decode(record: dict) -> dict:
        path = clips_dir / record["filename"]
        command = [
            args.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        return {
            "clip_number": record["clip_number"],
            "exit_code": result.returncode,
            "decoder_messages": result.stderr.strip(),
        }

    decode_results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as executor:
        futures = [executor.submit(decode, record) for record in records]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            decode_results.append(result)
            if result["exit_code"] != 0:
                failures.append({"clip_number": result["clip_number"], "check": "full decode", "messages": result["decoder_messages"]})
            elif result["decoder_messages"]:
                warnings.append({"clip_number": result["clip_number"], "check": "decoder messages", "messages": result["decoder_messages"]})

    decode_results.sort(key=lambda item: item["clip_number"])
    report = {
        "status": "pass" if not failures else "fail",
        "clip_count_manifest": len(records),
        "clip_count_on_disk": len(actual),
        "stream_copy_count": sum(record.get("processing") == "stream copy" for record in records),
        "reencoded_count": sum(record.get("processing") != "stream copy" for record in records),
        "total_output_bytes": sum((clips_dir / record["filename"]).stat().st_size for record in records if (clips_dir / record["filename"]).exists()),
        "source_sha256": sha256(source),
        "failures": failures,
        "warnings": warnings,
        "decode_results": decode_results,
    }
    (args.output_dir / "verification_report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key not in {"decode_results"}}, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
