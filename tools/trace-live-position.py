#!/usr/bin/env python3
"""Traces what Tunarr is ACTUALLY transcoding against the schedule that MarkTV pushed.

Why this exists: the channel's HLS `PROGRAM-DATE-TIME` and the EPG can both be
offset from wall clock, and Tunarr's own `now_playing` is derived from the same
internal clock as the guide -- so neither can settle whether the delivered
content is current. The ffmpeg command line is the ground truth: it names the
exact source file being transcoded.

Method
------
The channel loops a fixed 24h lineup whose origin is the channel's `startTime`.
For each transcode the script computes the lineup position that "now" should
correspond to, looks up which scheduled entry occupies it, and compares that
entry's source file with the file ffmpeg is actually reading. A match means the
delivered content is the content scheduled for now; a mismatch means the
channel is running behind, and the gap is quantified.

Usage: tools/trace-live-position.py [seconds]
"""
import datetime as dt
import glob
import json
import os
import re
import sys
import time

HOME = os.path.expanduser("~")
LOG = f"{HOME}/Library/Preferences/tunarr/logs/tunarr.log"
EXPORT_GLOB = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "data",
    "exports",
    "*.marktv.json",
)

def load_schedule():
    newest = max(glob.glob(EXPORT_GLOB), key=os.path.getmtime)
    with open(newest) as handle:
        doc = json.load(handle)
    entries = []
    for entry in doc.get("entries", []):
        if not entry.get("path"):
            continue
        entries.append(
            {
                "start": dt.datetime.fromisoformat(
                    entry["start"].replace("Z", "+00:00")
                ),
                "end": dt.datetime.fromisoformat(entry["end"].replace("Z", "+00:00")),
                "path": entry["path"],
                "file": os.path.basename(entry["path"]),
                "title": entry.get("title"),
                "kind": entry.get("kind"),
            }
        )
    entries.sort(key=lambda e: e["start"])
    return newest, doc, entries


def main() -> None:
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    export_path, doc, entries = load_schedule()
    channel_start = dt.datetime.fromisoformat(
        doc["entries"][0]["start"].replace("Z", "+00:00")
    )
    duration = dt.timedelta(milliseconds=doc["generation"]["durationMs"])
    print(f"schedule export : {os.path.basename(export_path)}")
    print(f"lineup origin   : {channel_start.isoformat()}  loop={duration}")
    print(f"entries         : {len(entries)}")
    print()

    size = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    print(f"{'wall(UTC)':>9} {'expected local':>15} {'delivered file':<44} {'sched@now':<28} {'delta':>9}")
    print("-" * 112)
    deadline = time.time() + seconds
    seen = set()
    while time.time() < deadline:
        time.sleep(2)
        try:
            if os.path.getsize(LOG) < size:
                size = 0
            with open(LOG, "r", errors="replace") as handle:
                handle.seek(size)
                chunk = handle.read()
                size = handle.tell()
        except OSError:
            continue
        for line in chunk.splitlines():
            if '"args"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            args = record.get("args")
            if not args or "-i " not in args:
                continue
            stamp = dt.datetime.fromtimestamp(
                record["time"] / 1000, dt.timezone.utc
            )
            match = re.search(r"-i (\S+)", args)
            if not match:
                continue
            source = match.group(1)
            key = (round(stamp.timestamp()), source)
            if key in seen:
                continue
            seen.add(key)

            # Which lineup position does this instant correspond to?
            offset = (stamp - channel_start) % duration
            expected_at = channel_start + offset
            current = None
            for entry in entries:
                if entry["start"] <= expected_at < entry["end"]:
                    current = entry
                    break

            delta = ""
            if current:
                if os.path.basename(source) == current["file"]:
                    delta = "LIVE"
                else:
                    # Find the entry this file belongs to, nearest the expected time.
                    best = None
                    for entry in entries:
                        if entry["file"] != os.path.basename(source):
                            continue
                        gap = (expected_at - entry["start"]).total_seconds()
                        if best is None or abs(gap) < abs(best):
                            best = gap
                    delta = f"{best / 60:+.1f} min" if best is not None else "unknown"

            print(
                f"{stamp.strftime('%H:%M:%S')} "
                f"{expected_at.astimezone().strftime('%H:%M:%S'):>15} "
                f"{os.path.basename(source)[:43]:<44} "
                f"{(current['file'][:27] if current else '-'):<28} "
                f"{delta:>9}"
            )


if __name__ == "__main__":
    main()
