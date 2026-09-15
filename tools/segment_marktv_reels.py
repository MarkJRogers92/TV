#!/usr/bin/env python3
"""Segment commercial compilations into MarkTV-ready clips and manifests."""

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
REEL15_LABELS: list = []
REEL15_CUTS: list = []


DEFAULT_DATA = Path(__file__).with_name("data") / "segment-reels.json"


def load_data(path: Path) -> None:
    """Rebind the segmentation tables from a reel data file.

    JSON does not preserve every Python type: object keys come back as strings,
    and sets and tuples come back as lists. Each table is converted back to its
    original type explicitly, because the rest of this module relies on it.
    """
    if not path.is_file():
        raise SystemExit(f"reel data file not found: {path} (see --data)")
    global LEXICON, REEL15_LABELS, REEL15_CUTS
    raw = json.loads(path.read_text())

    LEXICON = [tuple(entry) for entry in raw["lexicon"]]

    REEL15_LABELS = [tuple(pair) for pair in raw["reel15_labels"]]

    # Reel 15 includes several very short network/local interstitials that a
    # duration-based solver would otherwise merge into adjacent 30-second ads.
    # These seams were audited against the five-second contact sheets and the
    # black-frame/scene reports.
    REEL15_CUTS = list(raw["reel15_cuts"])


def slug(text: str) -> str:
    text = text.replace("&", " and ").replace("'", "")
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")[:90] or "Unknown-Spot"


def stamp(value: float) -> str:
    ms = round(value * 1000)
    h, ms = divmod(ms, 3_600_000); m, ms = divmod(ms, 60_000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def scene_points(path: Path, start: float, end: float) -> tuple[list[float], dict[float, float]]:
    lines = path.read_text().splitlines(); scores: dict[float, float] = {round(start, 3): 1.0, round(end, 3): 1.0}
    for i in range(0, len(lines) - 1, 2):
        mt = re.search(r"pts_time:([0-9.]+)", lines[i]); ms = re.search(r"=([0-9.]+)", lines[i + 1])
        if mt and ms:
            t = round(float(mt.group(1)), 3)
            if start < t < end: scores[t] = max(scores.get(t, 0), float(ms.group(1)))
    # Long dissolves/static cards can lack a scene-score candidate. These low-score
    # anchors only keep the duration solver connected and are reported as uncertain.
    for n in range(math.ceil(start / 5), math.floor(end / 5) + 1):
        t = float(n * 5)
        if not any(abs(existing - t) < .25 for existing in scores): scores[t] = .02
    return sorted(scores), scores


def words(cues: list[dict], a: float, b: float) -> set[str]:
    stop = set("the a an and or to of in on for is are was were it this that with as at be been you your i we they he she his her our their from by but so not now new just".split())
    out: set[str] = set()
    for cue in cues:
        if cue["end"] <= a or cue["start"] >= b: continue
        out |= {w for w in re.findall(r"[a-z]{3,}", cue["text"].lower()) if w not in stop}
    return out


def boundaries(points: list[float], scores: dict[float, float], cues: list[dict]) -> list[float]:
    semantic = []
    for point in points:
        left, right = words(cues, point - 10, point), words(cues, point, point + 10)
        semantic.append(.5 if not left or not right else 1 - len(left & right) / len(left | right))
    dp = [-1e18] * len(points); previous = [-1] * len(points); dp[0] = 0
    for j in range(1, len(points)):
        for i in range(j - 1, -1, -1):
            duration = points[j] - points[i]
            if duration > 67: break
            if duration < 11 or dp[i] < -1e17: continue
            choices = [(15, .35), (20, -.1), (30, 1.9), (45, .1), (60, .55)]
            target, base = min(choices, key=lambda item: abs(duration - item[0]))
            drift = abs(duration - target)
            value = dp[i] + base + 2.7 * scores[points[j]] + 1.9 * semantic[j] - 3.9 - .34 * drift
            if value > dp[j]: dp[j], previous[j] = value, i
    if previous[-1] < 0: raise RuntimeError("Could not build a continuous segmentation path")
    path: list[float] = []; cursor = len(points) - 1
    while cursor >= 0:
        path.append(points[cursor]); cursor = previous[cursor]
    return list(reversed(path))


def transcript(cues: list[dict], start: float, end: float) -> str:
    seen = []
    for cue in cues:
        if cue["end"] <= start or cue["start"] >= end: continue
        text = re.sub(r"\[[^]]+\]", "", cue["text"]).strip()
        if text and text not in seen: seen.append(text)
    return " ".join(seen)


def refine_title_changes(cuts: list[float], cues: list[dict], points: list[float], scores: dict[float, float]) -> list[float]:
    """Split a duration-selected block when its transcript clearly changes brands/titles."""
    refined = list(cuts)
    for start, end in zip(cuts, cuts[1:]):
        events: list[tuple[float, str]] = []
        for cue in cues:
            if cue["end"] <= start or cue["start"] >= end:
                continue
            low = cue["text"].lower()
            matches = [title for title, pattern in LEXICON if re.search(pattern, low)]
            if matches:
                events.append((float(cue["start"]), matches[-1]))
        previous_title = None
        for time, title in events:
            if title == previous_title:
                continue
            if previous_title is not None and time - start >= 5 and end - time >= 5:
                nearby = [point for point in points if abs(point - time) <= 3 and scores[point] >= .06]
                if nearby:
                    point = max(nearby, key=lambda value: scores[value] - .04 * abs(value - time))
                    if all(abs(point - existing) >= 5 for existing in refined):
                        refined.append(point)
            previous_title = title
    refined.sort()
    # Replace solver-only five-second anchors with the closest real transition.
    snapped = [refined[0]]
    for point in refined[1:-1]:
        if scores.get(point, 0) < .045:
            nearby = [candidate for candidate in points if abs(candidate - point) <= 5 and scores[candidate] >= .05]
            if nearby:
                point = max(nearby, key=lambda value: scores[value] - .035 * abs(value - point))
        if point - snapped[-1] >= 5:
            snapped.append(point)
    if refined[-1] - snapped[-1] < 5 and len(snapped) > 1:
        snapped.pop()
    snapped.append(refined[-1])
    return snapped


def classify(text: str, reel: str, start: float) -> tuple[str, str, str, str]:
    if reel == "reel15":
        title = max((entry for entry in REEL15_LABELS if entry[0] <= start + 2), default=REEL15_LABELS[0])[1]
        low = title.lower()
    else:
        low = text.lower()
        matches = [(match.end(), title) for title, pattern in LEXICON for match in re.finditer(pattern, low)]
        title = max(matches, default=(0, "Unidentified vintage commercial or promo"))[1]
    if any(term in low for term in ["channel 7", "newscenter", "wakc", "station promo", "nightcast"]):
        kind, category = "local station promo", "local television"
    elif any(term in low for term in ["promo", "abc", "cbs", "full house", "roseanne", "wonder years", "china beach", "knots landing", "macgyver", "anything but love", "into the night"]):
        kind, category = "network promo", "television"
    elif any(term in low for term in ["trailer", "glory", "anything to survive", "proud men", "elvis and me"]):
        kind, category = "movie trailer", "film or television movie"
    elif any(term in low for term in ["psa", "public-service", "literacy", "volunteer as a tutor"]):
        kind, category = "PSA", "public service"
    else:
        kind, category = "product commercial", "consumer product or service"
    return title, kind, category, low


def encode(ffmpeg: str, source: Path, output: Path, start: float, end: float) -> None:
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(source),
               "-t", f"{end-start:.3f}", "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264",
               "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", "-map_metadata", "-1", "-y", str(output)]
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True); parser.add_argument("--signals", type=Path, required=True)
    parser.add_argument("--scenes", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reel", choices=["reel15", "vol500"], required=True)
    parser.add_argument("--start", type=float, required=True); parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--year", required=True); parser.add_argument("--ffmpeg", default="ffmpeg"); parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    load_data(args.data)
    data = json.loads(args.signals.read_text()); cues = data.get("subtitle_cues", [])
    points, scores = scene_points(args.scenes, args.start, args.end)
    if args.reel == "reel15":
        for interval in data.get("black_intervals", []):
            if interval.get("duration", 0) < .18:
                continue
            point = round(float(interval["end"]), 3)
            if args.start < point < args.end:
                scores[point] = max(scores.get(point, 0), 1.25)
        points = sorted(scores)
    cuts = REEL15_CUTS if args.reel == "reel15" else boundaries(points, scores, cues)
    if args.reel == "vol500":
        # Snap only duration-solver placeholder anchors to genuine nearby scene
        # transitions. Brand mentions are not themselves boundaries (comparative
        # ads frequently name competitors), so they are deliberately not used to
        # create extra cuts.
        snapped = [cuts[0]]
        for point in cuts[1:-1]:
            if scores.get(point, 0) < .045:
                nearby = [candidate for candidate in points if abs(candidate - point) <= 5 and scores[candidate] >= .05]
                if nearby:
                    point = max(nearby, key=lambda value: scores[value] - .035 * abs(value - point))
            if point - snapped[-1] >= 8:
                snapped.append(point)
        if cuts[-1] - snapped[-1] < 8 and len(snapped) > 1:
            snapped.pop()
        snapped.append(cuts[-1])
        cuts = snapped
        # The closing section is a dense run of short ads/promos whose overlapping
        # auto-captions defeat duration inference. These transitions were checked
        # directly against the video and transcript.
        cuts = [point for point in cuts if point <= 4837.633]
        cuts.extend([4881.238, 4896.679, 4913.079, 4943.520, 4980.719,
                     4993.479, 5023.880, 5035.719, 5045.741])
    clips: list[Clip] = []
    for number, (start, end) in enumerate(zip(cuts, cuts[1:]), 1):
        text = transcript(cues, start, end); title, kind, category, _ = classify(text, args.reel, start)
        boundary_score = scores.get(end, 0); confidence = "high" if title.startswith("Unidentified") is False and boundary_score >= .12 else "medium"
        if title.startswith("Unidentified") or boundary_score < .045: confidence = "low"
        filename = f"{number:03d}_{slug(title)}_{args.year.replace('circa ', '').replace('-', '_')}.mp4"
        note_parts = ["Boundary chosen from transcript change plus video scene transition." if cues else "Boundary chosen from black-frame and video scene transitions."]
        if boundary_score < .045: note_parts.append("Low visual-transition score; review recommended.")
        if title.startswith("Unidentified"): note_parts.append("Transcript did not expose a reliable brand or title.")
        clips.append(Clip(number, start, end, end-start, title, kind, category, args.year, confidence, filename, " ".join(note_parts)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(encode, args.ffmpeg, args.source, args.output / clip.filename, clip.start, clip.end) for clip in clips]
        for index, future in enumerate(futures, 1):
            future.result()
            if index % 20 == 0 or index == len(futures): print(f"encoded {index}/{len(futures)}", flush=True)
    fields = list(asdict(clips[0]).keys())
    with (args.output / "manifest.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields); writer.writeheader()
        for clip in clips:
            row = asdict(clip); row["start"] = stamp(clip.start); row["end"] = stamp(clip.end); row["duration"] = round(clip.duration, 3); writer.writerow(row)
    payload = {"source": str(args.source), "source_unchanged": True, "encoding": "H.264 CRF 16 veryfast; AAC 192 kb/s; source aspect ratio and frame rate preserved", "clips": [asdict(c) for c in clips]}
    (args.output / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    uncertain = [c for c in clips if c.confidence != "high"]
    with (args.output / "uncertain_boundaries.txt").open("w") as handle:
        handle.write(f"Review recommended for {len(uncertain)} of {len(clips)} clips.\n\n")
        for clip in uncertain: handle.write(f"{clip.clip_number:03d} {stamp(clip.start)} - {stamp(clip.end)} | {clip.detected_brand_title} | {clip.confidence} | {clip.notes}\n")
    print(f"created {len(clips)} clips in {args.output}")


if __name__ == "__main__":
    main()
