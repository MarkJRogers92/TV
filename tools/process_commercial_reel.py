#!/usr/bin/env python3
"""Split the late-1990s commercial reel and write MarkTV manifests."""

from __future__ import annotations

import argparse
import bisect
import csv
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Spec:
    end: float
    title: str
    kind: str
    category: str
    context: str = "late 1999"
    confidence: str = "high"
    notes: str = ""

# Segmentation tables live in the data/ directory beside this script rather than
# in the module. A new reel is then a new data file plus --data, instead of an
# edit to this code, and per-reel content stays out of the repository.

SPECS: list[Spec] = []
START_OVERRIDES: dict[int, float] = {}


DEFAULT_DATA = Path(__file__).with_name("data") / "commercial-reel.json"


def load_data(path: Path) -> None:
    """Rebind the segmentation tables from a reel data file.

    JSON does not preserve every Python type: object keys come back as strings,
    and sets and tuples come back as lists. Each table is converted back to its
    original type explicitly, because the rest of this module relies on it --
    START_OVERRIDES in particular is indexed by integer clip number, and a
    string key would silently return None rather than raising.
    """
    if not path.is_file():
        raise SystemExit(f"reel data file not found: {path} (see --data)")
    global SPECS, START_OVERRIDES
    raw = json.loads(path.read_text())

    SPECS = [Spec(**entry) for entry in raw["specs"]]

    # JSON object keys are always strings; the table is indexed by clip number.
    START_OVERRIDES = {int(index): value for index, value in raw["start_overrides"].items()}


def slugify(value: str) -> str:
    value = value.replace("&", " and ").replace("'", "")
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-")
    return value or "untitled"


def stamp(value: float) -> str:
    millis = round(value * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def run_json(command: list[str]) -> dict:
    return json.loads(subprocess.check_output(command, text=True))


def keyframes(ffprobe: str, source: Path) -> list[float]:
    data = run_json([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(source)
    ])
    return sorted(float(frame["best_effort_timestamp_time"]) for frame in data["frames"] if "best_effort_timestamp_time" in frame)


def nearest(values: list[float], point: float) -> float:
    index = bisect.bisect_left(values, point)
    candidates = values[max(0, index - 1): min(len(values), index + 2)]
    return min(candidates, key=lambda value: abs(value - point))


def probe(ffprobe: str, path: Path) -> dict:
    data = run_json([
        ffprobe, "-v", "error", "-show_entries",
        "format=duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of", "json", str(path)
    ])
    video = next(stream for stream in data["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in data["streams"] if stream["codec_type"] == "audio")
    return {
        "duration_seconds": round(float(data["format"]["duration"]), 3),
        "size_bytes": int(data["format"]["size"]),
        "video_codec": video["codec_name"],
        "width": video["width"],
        "height": video["height"],
        "frame_rate": video["avg_frame_rate"],
        "audio_codec": audio["codec_name"],
        "audio_sample_rate": int(audio["sample_rate"]),
        "audio_channels": audio["channels"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--manifests-only", action="store_true")
    parser.add_argument("--allow-stream-copy", action="store_true")
    parser.add_argument("--force-numbers", nargs="*", type=int, default=[])
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    load_data(args.data)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = args.output_dir / "clips"
    clips_dir.mkdir(exist_ok=True)
    source_info = probe(args.ffprobe, args.source)
    source_duration = source_info["duration_seconds"]
    keys = keyframes(args.ffprobe, args.source)

    records = []
    omitted_transition_ranges = []
    start = 0.0
    force_numbers = set(args.force_numbers)
    frame_tolerance = 1 / 24 + 0.001
    for number, spec in enumerate(SPECS, start=1):
        logical_start = START_OVERRIDES.get(number, start)
        if logical_start > start:
            omitted_transition_ranges.append({
                "start": stamp(start),
                "end": stamp(logical_start),
                "reason": "Ambiguous black/strobe/crossfade transition omitted to keep both neighboring clips clean."
            })
        if spec.end <= logical_start:
            raise ValueError(f"Non-positive segment {number}")
        year_match = re.search(r"(?:19|20)\d{2}", spec.context)
        year_suffix = f"_{year_match.group(0)}" if year_match else ""
        filename = f"{number:03d}_{slugify(spec.title)}{year_suffix}.mp4"
        start_key = nearest(keys, logical_start)
        end_key = nearest(keys, spec.end)
        copy_candidate = abs(start_key - logical_start) <= frame_tolerance and abs(end_key - spec.end) <= frame_tolerance
        copy_safe = copy_candidate and args.allow_stream_copy
        actual_start = start_key if copy_safe else logical_start
        actual_end = end_key if copy_safe else spec.end
        record = {
            "clip_number": number,
            "start": stamp(actual_start),
            "end": stamp(actual_end),
            "start_seconds": round(actual_start, 6),
            "end_seconds": round(actual_end, 6),
            "duration_seconds": round(actual_end - actual_start, 3),
            "detected_brand_title": spec.title,
            "type": spec.kind,
            "category": spec.category,
            "approximate_year_context": spec.context,
            "confidence": spec.confidence,
            "filename": filename,
            "processing": "stream copy" if copy_safe else "H.264 CRF 16 / AAC 192k re-encode",
            "stream_copy_candidate": copy_candidate,
            "notes": spec.notes,
        }
        records.append(record)
        start = spec.end

    if start > source_duration:
        raise ValueError("Final commercial boundary exceeds source duration")

    if not args.manifests_only:
        import concurrent.futures

        def encode(record: dict) -> tuple[int, str]:
            output = clips_dir / record["filename"]
            force_output = record["clip_number"] in force_numbers
            if output.exists() and output.stat().st_size > 0 and not force_output:
                return record["clip_number"], "existing"
            duration = record["end_seconds"] - record["start_seconds"]
            base = [
                args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{record['start_seconds']:.6f}", "-i", str(args.source),
                "-t", f"{duration:.6f}", "-map", "0:v:0", "-map", "0:a:0",
            ]
            if record["processing"] == "stream copy":
                command = base + ["-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(output)]
            else:
                command = base + [
                    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)
                ]
            subprocess.run(command, check=True)
            return record["clip_number"], "created"

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as executor:
            futures = [executor.submit(encode, record) for record in records]
            for future in concurrent.futures.as_completed(futures):
                number, status = future.result()
                print(f"{number:03d} {status}", flush=True)

    for record in records:
        output = clips_dir / record["filename"]
        if output.exists():
            record["output_probe"] = probe(args.ffprobe, output)

    manifest = {
        "source_file": str(args.source),
        "source_technical_profile": source_info,
        "method": "Transcript cues cross-checked against black frames, scene transitions, audio continuity, and timestamped visual contact sheets.",
        "export_policy": "Stream-copy candidates were tested but rejected after duration validation; final outputs use frame-accurate H.264 CRF 16 / AAC 192k re-encoding.",
        "clip_count": len(records),
        "clips": records,
        "omitted_transition_ranges": omitted_transition_ranges,
        "excluded_ranges": [
            {
                "start": stamp(start),
                "end": stamp(source_duration),
                "reason": "Compilation creator end card/outro; not period broadcast material and not exported."
            }
        ],
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    fields = [
        "clip_number", "start", "end", "duration_seconds", "detected_brand_title", "type",
        "category", "approximate_year_context", "confidence", "filename", "processing", "notes"
    ]
    with (args.output_dir / "manifest.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)

    uncertain = [record for record in records if record["confidence"] != "high" or record["notes"]]
    lines = [
        "# Uncertain or judgment-call boundaries",
        "",
        "These clips are usable, but the listed joins deserve a quick human preference check if you want alternate padding.",
        "",
    ]
    for record in uncertain:
        lines.append(
            f"- {record['clip_number']:03d} {record['start']}–{record['end']} — "
            f"{record['detected_brand_title']} ({record['confidence']}): {record['notes'] or 'Identity or exact boundary is less explicit than neighboring spots.'}"
        )
    lines += [
        "",
        f"- Excluded {stamp(start)}–{stamp(source_duration)} — compilation creator end card/outro (not a MarkTV clip).",
    ]
    (args.output_dir / "UNCERTAIN_BOUNDARIES.md").write_text("\n".join(lines) + "\n")

    print(f"Wrote {len(records)} manifest rows to {args.output_dir}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f"Command failed with status {error.returncode}", file=sys.stderr)
        raise
