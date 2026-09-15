#!/usr/bin/env python3
"""Print selected boundary signals and transcript windows from analysis JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def stamp(value: float) -> str:
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    seconds = value % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def compact(cues: list[dict], start: float, end: float) -> str:
    seen: list[str] = []
    for cue in cues:
        if cue["end"] <= start or cue["start"] >= end:
            continue
        text = cue["text"].replace("\t", " ").replace("\n", " ")
        if text not in seen:
            seen.append(text)
    return " / ".join(seen)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis", type=Path)
    parser.add_argument("start", type=float)
    parser.add_argument("end", type=float)
    parser.add_argument("--window", type=float, default=3.0)
    args = parser.parse_args()

    data = json.loads(args.analysis.read_text())
    cues = data["subtitle_cues"]
    print("seam_start\tseam_end\tblack\tbefore\tafter")
    for interval in data["black_intervals"]:
        point = (interval["start"] + interval["end"]) / 2
        if point < args.start or point > args.end:
            continue
        before = compact(cues, point - args.window, point)
        after = compact(cues, point, point + args.window)
        print(
            f"{stamp(interval['start'])}\t{stamp(interval['end'])}\t{interval['duration']:.3f}\t"
            f"{before}\t{after}"
        )


if __name__ == "__main__":
    main()
