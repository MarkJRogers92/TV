# tools/

Python helpers used while preparing MarkTV source reels. They are not part of
the Node application, and nothing in `npm test` exercises them.

## Requirements

```
pip install -r requirements.txt
```

`ffmpeg` and `ffprobe` must also be on `PATH`; pip does not install them.

## General utilities

| Script | Purpose |
|---|---|
| `analyze_compilation.py` | Extract black-frame seams and nearby subtitle cues into a signals JSON. |
| `make_contact_sheets.py` | Timestamped contact sheets from any video. |
| `make_clip_sample_sheet.py` | First/middle/last-frame QA sheet for selected exported clips. |
| `report_signals.py` | Print boundary signals and transcript windows from a signals JSON. |
| `transcribe_faster_whisper.py` | Timestamped JSON transcript for boundary analysis. |
| `verify_commercial_outputs.py` | Probe and fully decode every clip described by a manifest. |

Run any of them with `--help` for the full argument list.

## Reel processors

Three scripts cut a specific source reel into clips plus a manifest. Each one's
per-reel answer key — boundary timestamps, caption lexicons and title tables —
lives in a JSON data file rather than in the code, so a new reel is a new data
file:

```
<script> ... --data path/to/reel.json
```

The default is `data/<name>.json` beside the script. **That directory is
gitignored on purpose**: these tables are hand-curated for one particular source
reel, so they are supplied locally rather than published. A fresh clone reports
`reel data file not found: … (see --data)` until one is provided.

### Data contract

JSON does not round-trip every Python type, so each table is converted back to
its original type on load — the reason is recorded in each `load_data`. A file
matching the shapes below loads correctly. Note in particular that **JSON object
keys are always strings**.

**`process_commercial_reel.py`** — default `data/commercial-reel.json`

| Key | JSON shape | Restored as |
|---|---|---|
| `specs` | array of objects with `end`, `title`, `kind`, `category`, `context`, `confidence`, `notes` | `list[Spec]` |
| `start_overrides` | object keyed by clip number | `dict[int, float]` — keys `int()`-converted |

**`process_v601.py`** — default `data/v601.json`

| Key | JSON shape | Restored as |
|---|---|---|
| `lexicon` | array of `[name, regex]` | list of tuples |
| `omit_ranges` | array of `[start, end, reason]` | list of tuples |
| `keep_separate` | array of names | `set` |
| `manual_spans` | array of `[start, end, title]` | list of tuples |

**`segment_marktv_reels.py`** — default `data/segment-reels.json`

| Key | JSON shape | Restored as |
|---|---|---|
| `lexicon` | array of `[name, regex]` | list of tuples |
| `reel15_labels` | array of `[second, label]` | list of tuples |
| `reel15_cuts` | array of numbers | list |

`--reel` still selects between the two reels this script knows (`reel15` and
`vol500`), and each branch applies different boundary logic, so adding a third
reel needs a code path as well as a data file.

### Interaction with the media

`process_v601.py` and `segment_marktv_reels.py` plan their cuts from `--signals`
(black-frame and subtitle analysis) and `--scenes` (scene scores) without
reading the media, and only invoke `ffmpeg` to write the resulting clips.
`process_commercial_reel.py` additionally probes the source with `ffprobe` for
its duration and keyframes, so it needs the media itself present.

Keep `--output` outside the repository tree. The processors invoke `ffmpeg`
with `-y`, and a run pointed at an already-populated directory will re-encode
for hours.
