#!/usr/bin/env python3
"""Create timestamped contact sheets from a video using FFmpeg and Pillow."""

from __future__ import annotations

import argparse
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def stamp(seconds: float) -> str:
    whole = int(round(seconds))
    hours, remainder = divmod(whole, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--sheet-seconds", type=int, default=300)
    parser.add_argument("--interval", type=int, default=5)
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=180)
    parser.add_argument("--columns", type=int, default=10)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default(size=18)
    frame_bytes = args.width * args.height * 3
    sheet_count = math.ceil(args.duration / args.sheet_seconds)

    for sheet_index in range(sheet_count):
        start = sheet_index * args.sheet_seconds
        length = min(args.sheet_seconds, args.duration - start)
        frame_count = math.ceil(length / args.interval)
        command = [
            args.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(start),
            "-t",
            str(length),
            "-i",
            str(args.source),
            "-map",
            "0:v:0",
            "-vf",
            f"fps=1/{args.interval},scale={args.width}:{args.height}",
            "-frames:v",
            str(frame_count),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ]
        result = subprocess.run(command, capture_output=True, check=True)
        frames = []
        for index in range(frame_count):
            data = result.stdout[index * frame_bytes : (index + 1) * frame_bytes]
            if len(data) != frame_bytes:
                break
            frame = Image.frombytes("RGB", (args.width, args.height), data)
            draw = ImageDraw.Draw(frame)
            label = stamp(start + index * args.interval)
            draw.rectangle((0, 0, 94, 25), fill=(0, 0, 0))
            draw.text((5, 3), label, font=font, fill=(255, 255, 255))
            frames.append(frame)

        rows = math.ceil(len(frames) / args.columns)
        sheet = Image.new("RGB", (args.columns * args.width, rows * args.height), "black")
        for index, frame in enumerate(frames):
            x = (index % args.columns) * args.width
            y = (index // args.columns) * args.height
            sheet.paste(frame, (x, y))
        output = args.output_dir / f"sheet_{start // 60:03d}m.jpg"
        sheet.save(output, quality=90, optimize=True)
        print(output)


if __name__ == "__main__":
    main()
