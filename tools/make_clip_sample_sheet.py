#!/usr/bin/env python3
"""Create a first/middle/last-frame sheet for selected exported clips."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def frame(ffmpeg: str, path: Path, at: float) -> Image.Image:
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}", "-i", str(path),
        "-frames:v", "1", "-vf", "scale=320:180", "-f", "image2pipe", "-vcodec", "png", "-"
    ]
    data = subprocess.check_output(command)
    import io
    return Image.open(io.BytesIO(data)).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("sheet", type=Path)
    parser.add_argument("numbers", nargs="+", type=int)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    manifest = json.loads((args.output_dir / "manifest.json").read_text())
    by_number = {record["clip_number"]: record for record in manifest["clips"]}
    font = ImageFont.load_default(size=16)
    cells = []
    for number in args.numbers:
        record = by_number[number]
        clips_dir = args.output_dir / "clips"
        if not clips_dir.is_dir():
            clips_dir = args.output_dir
        path = clips_dir / record["filename"]
        duration = record.get("output_probe", {}).get("duration_seconds", record.get("duration", record.get("duration_seconds")))
        positions = [min(0.25, duration / 4), duration / 2, max(0, duration - 0.25)]
        for label, position in zip(("START", "MID", "END"), positions):
            image = frame(args.ffmpeg, path, position)
            draw = ImageDraw.Draw(image)
            title = f"{number:03d} {label} {record['detected_brand_title'][:30]}"
            draw.rectangle((0, 0, 320, 24), fill=(0, 0, 0))
            draw.text((4, 3), title, fill=(255, 255, 255), font=font)
            cells.append(image)

    columns = 3
    rows = math.ceil(len(cells) / columns)
    sheet = Image.new("RGB", (columns * 320, rows * 180), "black")
    for index, image in enumerate(cells):
        sheet.paste(image, ((index % columns) * 320, (index // columns) * 180))
    args.sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.sheet, quality=92)
    print(args.sheet)


if __name__ == "__main__":
    main()
