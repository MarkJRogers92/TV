#!/usr/bin/env python3
"""Create a timestamped JSON transcript for boundary analysis."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", default="tiny.en")
    args = parser.parse_args()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(args.source), beam_size=5, vad_filter=True, word_timestamps=True)
    payload = {"language": info.language, "segments": []}
    for segment in segments:
        payload["segments"].append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "words": [{"start": word.start, "end": word.end, "word": word.word} for word in (segment.words or [])],
        })
        print(f"{segment.start:8.2f} {segment.end:8.2f} {segment.text.strip()}", flush=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
