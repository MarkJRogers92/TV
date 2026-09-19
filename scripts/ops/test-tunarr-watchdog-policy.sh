#!/usr/bin/env bash
set -u

POLICY="$(cd "$(dirname "$0")" && pwd)/tunarr-watchdog-policy.sh"
failures=0

check_case() {
  expected="$1"
  dumps="$2"
  viewers="$3"
  label="$4"

  if /bin/bash "$POLICY" "$dumps" "$viewers"; then
    actual="recover"
  else
    actual="healthy"
  fi

  if [ "$actual" != "$expected" ]; then
    printf 'FAIL: %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    failures=$((failures + 1))
  fi
}

# A paused transcoder is normal while Tunarr has a future buffer. With no fresh
# FFmpeg failures, an active viewer must not turn that normal pause into a restart.
check_case healthy 0 1 "active viewer with no FFmpeg failures"
check_case healthy 7 1 "error count below threshold"

# Stream recovery is useful only for an active session. Old dumps must not restart
# an idle service that has nobody waiting for video.
check_case healthy 8 0 "threshold reached without an active viewer"

# A current cluster of failures while somebody is watching remains recoverable.
check_case recover 8 1 "threshold reached with an active viewer"
check_case recover 12 2 "threshold exceeded with active viewers"

if [ "$failures" -ne 0 ]; then
  exit 1
fi

printf 'PASS: watchdog stream-recovery policy\n'
