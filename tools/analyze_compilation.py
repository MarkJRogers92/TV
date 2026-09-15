#!/usr/bin/env python3
"""Extract black-frame seams and nearby subtitle cues from a commercial reel."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Cue:
    start: float
    end: float
    text: str


def seconds(value: str) -> float:
    hours, minutes, rest = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(rest)


def stamp(value: float) -> str:
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    secs = value % 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def read_srt(path: Path) -> list[Cue]:
    blocks = re.split(r"\r?\n\r?\n", path.read_text(errors="replace").strip())
    cues: list[Cue] = []
    for block in blocks:
        lines = block.splitlines()
        timing_index = next((i for i, line in enumerate(lines) if " --> " in line), None)
        if timing_index is None:
            continue
        start, end = lines[timing_index].split(" --> ", 1)
        text = " ".join(line.strip() for line in lines[timing_index + 1 :] if line.strip())
        cues.append(Cue(seconds(start), seconds(end), text))
    return cues


def detect_black(ffmpeg: str, source: Path) -> list[dict[str, float]]:
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-vf",
        "blackdetect=d=0.04:pix_th=0.10",
        "-an",
        "-f",
        "null",
        "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    pattern = re.compile(
        r"black_start:(?P<start>[0-9.]+) black_end:(?P<end>[0-9.]+) "
        r"black_duration:(?P<duration>[0-9.]+)"
    )
    return [{key: float(value) for key, value in match.groupdict().items()} for match in pattern.finditer(result.stderr)]


def nearby(cues: list[Cue], point: float, before: bool) -> str:
    if before:
        relevant = [cue for cue in cues if cue.start < point and cue.end >= point - 5]
        relevant = relevant[-3:]
    else:
        relevant = [cue for cue in cues if cue.end > point and cue.start <= point + 5]
        relevant = relevant[:3]
    seen: list[str] = []
    for cue in relevant:
        cleaned = cue.text.replace("\t", " ").replace("\n", " ")
        if cleaned not in seen:
            seen.append(cleaned)
    return " / ".join(seen)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("subtitles", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    cues = read_srt(args.subtitles)
    black = detect_black(args.ffmpeg, args.source)
    payload = {
        "source": str(args.source),
        "subtitles": str(args.subtitles),
        "black_intervals": black,
        "subtitle_cues": [asdict(cue) for cue in cues],
    }
    args.output.write_text(json.dumps(payload, indent=2) + "\n")

    print("start\tend\tduration\tbefore\tafter")
    for interval in black:
        point = (interval["start"] + interval["end"]) / 2
        print(
            f"{stamp(interval['start'])}\t{stamp(interval['end'])}\t{interval['duration']:.3f}\t"
            f"{nearby(cues, point, True)}\t{nearby(cues, point, False)}"
        )


if __name__ == "__main__":
    main()
