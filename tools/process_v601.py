#!/usr/bin/env python3
"""Create independently usable MarkTV clips from Dave's Archives V601 reel."""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import json
import math
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Clip:
    clip_number: int
    start: float
    end: float
    duration: float
    detected_brand_title: str
    type: str
    category: str
    approximate_year_context: str
    confidence: str
    filename: str
    notes: str

# Segmentation tables live in the data/ directory beside this script rather than
# in the module. A new reel is then a new data file plus --data, instead of an
# edit to this code, and per-reel content stays out of the repository.

LEXICON: list = []
OMIT_RANGES: list = []
KEEP_SEPARATE: set = set()
MANUAL_SPANS: list = []


DEFAULT_DATA = Path(__file__).with_name("data") / "v601.json"


def load_data(path: Path) -> None:
    """Rebind the segmentation tables from a reel data file.

    JSON does not preserve every Python type: object keys come back as strings,
    and sets and tuples come back as lists. Each table is converted back to its
    original type explicitly, because the rest of this module relies on it.
    """
    if not path.is_file():
        raise SystemExit(f"reel data file not found: {path} (see --data)")
    global LEXICON, OMIT_RANGES, KEEP_SEPARATE, MANUAL_SPANS
    raw = json.loads(path.read_text())

    # Ordered from generic to specific where patterns can overlap. Caption spelling
    # errors are included deliberately because this reel uses automatic subtitles.
    LEXICON = [tuple(entry) for entry in raw["lexicon"]]

    OMIT_RANGES = [tuple(span) for span in raw["omit_ranges"]]

    # These brands occur as multiple distinct back-to-back spots. Do not merge a
    # normal-length pair merely because the product name is the same.
    KEEP_SEPARATE = set(raw["keep_separate"])

    # Dense areas where overlapping auto-captions obscured a short commercial or
    # station insert. These spans were checked directly against the five-second
    # contact sheets and nearby frame-level scene transitions.
    MANUAL_SPANS = [tuple(span) for span in raw["manual_spans"]]


def slug(text: str) -> str:
    text = text.replace("&", " and ").replace("'", "")
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")[:90] or "Unknown-Spot"


def stamp(value: float) -> str:
    ms = round(value * 1000)
    h, ms = divmod(ms, 3_600_000); m, ms = divmod(ms, 60_000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def scene_points(path: Path, start: float, end: float) -> tuple[list[float], dict[float, float]]:
    lines = path.read_text().splitlines(); scores = {round(start, 3): 1.0, round(end, 3): 1.0}
    for i in range(len(lines) - 1):
        mt = re.search(r"pts_time:([0-9.]+)", lines[i]); ms = re.search(r"=([0-9.]+)", lines[i + 1])
        if mt and ms:
            t = round(float(mt.group(1)), 3)
            if start < t < end: scores[t] = max(scores.get(t, 0), float(ms.group(1)))
    for n in range(math.ceil(start / 5), math.floor(end / 5) + 1):
        t = float(n * 5)
        if not any(abs(existing - t) < .25 for existing in scores): scores[t] = .02
    return sorted(scores), scores


def words(cues: list[dict], a: float, b: float) -> set[str]:
    stop = set("the a an and or to of in on for is are was were it this that with as at be been you your i we they he she his her our their from by but so not now new just".split())
    out = set()
    for cue in cues:
        if cue["end"] <= a or cue["start"] >= b: continue
        out |= {w for w in re.findall(r"[a-z]{3,}", cue["text"].lower()) if w not in stop}
    return out


def transcript(cues: list[dict], start: float, end: float) -> str:
    seen = []
    for cue in cues:
        if cue["end"] <= start or cue["start"] >= end: continue
        text = re.sub(r"\[[^]]+\]", "", cue["text"]).strip()
        if text and text not in seen: seen.append(text)
    return " ".join(seen)


def title_matches(text: str) -> list[str]:
    low = text.lower()
    return [title for title, pattern in LEXICON if re.search(pattern, low)]


def base_boundaries(points: list[float], scores: dict[float, float], cues: list[dict]) -> list[float]:
    semantic = []
    for point in points:
        left, right = words(cues, point - 10, point), words(cues, point, point + 10)
        semantic.append(.5 if not left or not right else 1 - len(left & right) / len(left | right))
    dp = [-1e18] * len(points); previous = [-1] * len(points); dp[0] = 0
    for j in range(1, len(points)):
        for i in range(j - 1, -1, -1):
            duration = points[j] - points[i]
            if duration > 67: break
            if duration < 8 or dp[i] < -1e17: continue
            target, base = min([(15, .35), (20, -.1), (30, 1.9), (45, .1), (60, .55)], key=lambda item: abs(duration - item[0]))
            value = dp[i] + base + 2.7 * scores[points[j]] + 1.9 * semantic[j] - 3.9 - .34 * abs(duration - target)
            if value > dp[j]: dp[j], previous[j] = value, i
    if previous[-1] < 0: raise RuntimeError("Could not build segmentation path")
    path = []; cursor = len(points) - 1
    while cursor >= 0: path.append(points[cursor]); cursor = previous[cursor]
    return list(reversed(path))


def refine(cuts: list[float], cues: list[dict], points: list[float], scores: dict[float, float], black: list[dict]) -> list[float]:
    candidates = set(cuts)
    # Strong black intervals are reliable broadcast seams.
    for interval in black:
        point = round(float(interval["end"]), 3)
        if interval["duration"] >= .18 and cuts[0] + 5 < point < cuts[-1] - 5:
            candidates.add(point); scores[point] = max(scores.get(point, 0), 1.1)
    # A newly named brand/title inside a selected block is evidence the duration
    # solver combined two short spots. Snap the caption event to the visual cut.
    for a, b in zip(cuts, cuts[1:]):
        events = []
        for cue in cues:
            if cue["end"] <= a or cue["start"] >= b: continue
            matches = title_matches(cue["text"])
            if matches and (not events or events[-1][1] != matches[-1]): events.append((float(cue["start"]), matches[-1]))
        for (prev_time, prev_title), (time, title) in zip(events, events[1:]):
            if title == prev_title or time - a < 5 or b - time < 5: continue
            nearby = [p for p in points if abs(p - time) <= 6 and scores.get(p, 0) >= .045]
            if nearby:
                candidates.add(max(nearby, key=lambda p: scores[p] - .025 * abs(p - time)))
    # Resolve clusters, preferring black/strong scene transitions. Five seconds
    # is retained for genuine station bumpers and very short promos.
    ordered = sorted(candidates)
    chosen = [ordered[0]]
    for point in ordered[1:-1]:
        if point - chosen[-1] >= 5: chosen.append(point)
        elif scores.get(point, 0) > scores.get(chosen[-1], 0): chosen[-1] = point
    if ordered[-1] - chosen[-1] < 5 and len(chosen) > 1: chosen.pop()
    chosen.append(ordered[-1])
    for a, b, _ in OMIT_RANGES:
        chosen.extend([a, b])
    chosen = sorted(set(chosen))
    return chosen


def similarity(left: str, right: str) -> float:
    a = set(re.findall(r"[a-z]{4,}", left.lower())); b = set(re.findall(r"[a-z]{4,}", right.lower()))
    return len(a & b) / max(1, len(a | b))


def merge_fragments(spans: list[tuple[float, float]], cues: list[dict]) -> list[tuple[float, float]]:
    """Rejoin internal black flashes and duration-solver cuts within one spot."""
    merged: list[tuple[float, float]] = []
    for span in spans:
        if not merged:
            merged.append(span); continue
        a, b = merged[-1]; c, d = span
        left_text, right_text = transcript(cues, a, b), transcript(cues, c, d)
        left, right = title_matches(left_text), title_matches(right_text)
        left_title = left[-1] if left else None; right_title = right[-1] if right else None
        combined = d - a; short_piece = min(b - a, d - c) < 18
        same = left_title is not None and left_title == right_title
        protected = same and left_title in KEEP_SEPARATE and not short_piece
        continuation = ((left_title is None) != (right_title is None)) and similarity(left_text, right_text) >= .075
        if combined <= 67 and ((same and not protected) or continuation): merged[-1] = (a, d)
        else: merged.append(span)
    return merged


def classify(text: str, start: float, end: float) -> tuple[str, str, str, str]:
    manual_title = next((title for a, b, title in MANUAL_SPANS if abs(a - start) < .01 and abs(b - end) < .01), None)
    matches = title_matches(text)
    title = manual_title or (matches[-1] if matches else "Unidentified vintage commercial or promo")
    low = title.lower()
    if any(x in low for x in ["channel 2 news", "new york 1 station"]): kind, category = "local station promo", "local television"
    elif any(x in low for x in ["spectrum paging", "kmeta camera", "hair replacement", "incon therapy"]): kind, category = "local commercial", "local service"
    elif any(x in low for x in ["tango and cash", "internal affairs", "born on the fourth"]): kind, category = "movie trailer", "theatrical film"
    elif any(x in low for x in ["ecofest"]): kind, category = "PSA", "public service or community event"
    elif any(x in low for x in ["bumper", "return bumper"]): kind, category = "bumper", "broadcast continuity"
    elif any(x in low for x in ["promo", "goodwill games", "monsterfest", "siskel", "weatherscope", "cnn", "tbs ", "bravo", "usa new", "blind date", "silk stalkings", "big easy", "wwf", "highlander", "beauty and the beast", "jake and the fatman", "wiseguy", "max monroe", "knots landing"]): kind, category = "network promo", "television"
    else: kind, category = "product commercial", "consumer product or service"
    context = "1990s mixed-source compilation"
    if "1998" in text or any(x in low for x in ["goodwill games", "nissan 1998"]): context = "1998"
    elif "1999" in text or "1999" in low: context = "1999"
    elif "1990" in text or any(x in low for x in ["mazda 626", "time magazine"]): context = "circa 1990"
    return title, kind, category, context


def encode(ffmpeg: str, source: Path, output: Path, start: float, end: float) -> None:
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{end-start:.3f}", "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-map_metadata", "-1", "-y", str(output)], check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, required=True); ap.add_argument("--signals", type=Path, required=True)
    ap.add_argument("--scenes", type=Path, required=True); ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--start", type=float, default=11.5); ap.add_argument("--end", type=float, default=4075.267)
    ap.add_argument("--ffmpeg", default="ffmpeg"); ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--manifests-only", action="store_true")
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA)
    args = ap.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    load_data(args.data)
    data = json.loads(args.signals.read_text()); cues = data["subtitle_cues"]
    points, scores = scene_points(args.scenes, args.start, args.end)
    cuts = refine(base_boundaries(points, scores, cues), cues, points, scores, data.get("black_intervals", []))
    spans = []
    for start, end in zip(cuts, cuts[1:]):
        if any(start >= a - .001 and end <= b + .001 for a, b, _ in OMIT_RANGES): continue
        spans.append((start, end))
    spans = merge_fragments(spans, cues)
    for zone_start, zone_end, _ in MANUAL_SPANS:
        spans = [(a, b) for a, b in spans if b <= zone_start + .001 or a >= zone_end - .001]
    spans.extend((a, b) for a, b, _ in MANUAL_SPANS)
    spans.sort()
    clips = []
    for number, (start, end) in enumerate(spans, 1):
        text = transcript(cues, start, end); title, kind, category, context = classify(text, start, end)
        boundary = scores.get(end, 0); confidence = "high" if not title.startswith("Unidentified") and boundary >= .10 else "medium"
        if title.startswith("Unidentified") or boundary < .045: confidence = "low"
        notes = "Boundary selected from transcript change plus video/audio transition."
        if boundary < .045: notes += " Low visual-transition score; review recommended."
        if title.startswith("Unidentified"): notes += " Captions did not expose a reliable brand or title."
        filename = f"{number:03d}_{slug(title)}.mp4"
        clips.append(Clip(number, start, end, end-start, title, kind, category, context, confidence, filename, notes))
    if not args.manifests_only:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(encode, args.ffmpeg, args.source, args.output / c.filename, c.start, c.end) for c in clips]
            for i, future in enumerate(futures, 1):
                future.result()
                if i % 20 == 0 or i == len(futures): print(f"encoded {i}/{len(futures)}", flush=True)
    fields = list(asdict(clips[0]).keys())
    with (args.output / "manifest.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields); writer.writeheader()
        for clip in clips:
            row = asdict(clip); row["start"] = stamp(clip.start); row["end"] = stamp(clip.end); row["duration"] = round(clip.duration, 3); writer.writerow(row)
    payload = {"source": str(args.source), "source_unchanged": True, "encoding": "H.264 CRF 16 veryfast; AAC 192 kb/s; source aspect ratio and frame rate preserved", "omitted_ranges": [{"start": stamp(a), "end": stamp(b), "reason": reason} for a,b,reason in OMIT_RANGES], "clips": [asdict(c) for c in clips]}
    (args.output / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    uncertain = [c for c in clips if c.confidence != "high"]
    with (args.output / "uncertain_boundaries.txt").open("w") as handle:
        handle.write(f"Review recommended for {len(uncertain)} of {len(clips)} clips.\n\n")
        for c in uncertain: handle.write(f"{c.clip_number:03d} {stamp(c.start)} - {stamp(c.end)} | {c.detected_brand_title} | {c.confidence} | {c.notes}\n")
    print(f"created manifest for {len(clips)} clips in {args.output}")


if __name__ == "__main__": main()
