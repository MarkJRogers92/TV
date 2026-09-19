#!/usr/bin/env bash
# Decide whether stream-level recovery is warranted.
#
# A missing ffmpeg process is intentionally NOT an input. Tunarr pauses ffmpeg while
# its advertised HLS head is far enough ahead, so process absence is normal and must
# never restart an otherwise healthy session.

set -u

dumps="${1:-0}"
viewers="${2:-0}"
threshold="${TUNARR_WATCHDOG_DUMP_THRESHOLD:-8}"

case "$dumps:$viewers:$threshold" in
  *[!0-9:]*|:*|*::*|*:) exit 1 ;;
esac

[ "$viewers" -gt 0 ] && [ "$dumps" -ge "$threshold" ]
