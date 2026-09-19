#!/usr/bin/env bash
# Supervise Tunarr's API and active stream without treating an idle transcoder as a
# failure. Install this script and its policy helper together in ~/marktv-ops.

set -u

HOST="${TUNARR_WATCHDOG_HOST:-http://127.0.0.1:8000}"
HEALTH="${HOST}/api/system/health"
APP="${TUNARR_WATCHDOG_APP:-$HOME/Applications/Tunarr.app}"
OPS="${TUNARR_WATCHDOG_OPS:-$HOME/marktv-ops}"
LOG="$OPS/tunarr-watchdog.log"

INTERVAL="${TUNARR_WATCHDOG_INTERVAL:-30}"
THRESHOLD="${TUNARR_WATCHDOG_THRESHOLD:-3}"
RESTART_GRACE="${TUNARR_WATCHDOG_GRACE:-45}"
MAX_LOG_BYTES=1048576

DUMP_DIR="${TUNARR_WATCHDOG_DUMP_DIR:-$HOME/Library/Preferences/tunarr/logs}"
DUMP_WINDOW="${TUNARR_WATCHDOG_DUMP_WINDOW:-180}"
DUMP_THRESHOLD="${TUNARR_WATCHDOG_DUMP_THRESHOLD:-8}"
STREAM_STATE="$OPS/.tunarr-stream-recovery-at"
STREAM_POLICY="$OPS/tunarr-watchdog-policy.sh"
STREAM_COOLDOWN="${TUNARR_WATCHDOG_STREAM_COOLDOWN:-600}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt "$MAX_LOG_BYTES" ]; then
  tail -c 262144 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  log "log truncated (was over ${MAX_LOG_BYTES} bytes)"
fi

probe() {
  curl -s -o /dev/null -w '%{http_code}' -m 8 "$HEALTH" 2>/dev/null || echo 000
}

count_stream_dumps() {
  local since cutoff recovered
  since=$(( $(date +%s) - DUMP_WINDOW ))
  if [ -f "$STREAM_STATE" ]; then
    recovered=$(cat "$STREAM_STATE" 2>/dev/null || echo 0)
    case "$recovered" in ''|*[!0-9]*) recovered=0 ;; esac
    [ "$recovered" -gt "$since" ] && since="$recovered"
  fi
  cutoff=$(date -r "$since" '+%Y-%m-%d %H:%M:%S')
  find "$DUMP_DIR" -name 'ffmpeg-error-log-*.log' -newermt "$cutoff" 2>/dev/null \
    | wc -l | tr -d ' '
}

stream_recovery_allowed() {
  local last now
  now=$(date +%s)
  last=$(cat "$STREAM_STATE" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  [ $((now - last)) -ge "$STREAM_COOLDOWN" ]
}

active_viewers() {
  curl -s -m 5 "$HOST/api/sessions" 2>/dev/null \
    | grep -o '"numConnections":[0-9]*' | grep -o '[0-9]*' \
    | awk '{total += $1} END {print total + 0}'
}

recover_stream() {
  local dumps
  dumps=$(count_stream_dumps)
  log "ACTION: stream unhealthy - ${dumps} ffmpeg error dump(s) in ${DUMP_WINDOW}s while an active viewer is waiting and http=200; restarting the patched Tunarr service"
  date +%s > "$STREAM_STATE"
  if launchctl list 2>/dev/null | grep -q "com.marktv.tunarr-patched"; then
    launchctl kickstart -k "gui/$(id -u)/com.marktv.tunarr-patched" >/dev/null 2>&1 \
      || log "ERROR: kickstart of the patched service failed during stream recovery"
  else
    osascript -e 'quit app "Tunarr"' >/dev/null 2>&1 || true
    open -a "$APP" >/dev/null 2>&1 || log "ERROR: open -a failed during stream recovery"
  fi
  sleep "$RESTART_GRACE"
  log "post-stream-recovery health http=$(probe) dumps_since=${dumps}"
}

tunarr_process_alive() {
  pgrep -f "Tunarr.app/Contents/MacOS/tunarr-macos" >/dev/null 2>&1
}

recover() {
  if tunarr_process_alive; then
    log "ACTION: process is alive but unhealthy - quitting and relaunching"
    osascript -e 'quit app "Tunarr"' >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do tunarr_process_alive || break; sleep 1; done
    if tunarr_process_alive; then
      log "ACTION: quit did not take effect - terminating"
      pkill -TERM -f "Tunarr.app" >/dev/null 2>&1 || true
      sleep 3
      pkill -KILL -f "Tunarr.app" >/dev/null 2>&1 || true
      sleep 2
    fi
  else
    log "ACTION: process is gone - relaunching"
  fi

  if launchctl list 2>/dev/null | grep -q "com.marktv.tunarr-patched"; then
    log "ACTION: restarting the patched Tunarr service"
    launchctl kickstart -k "gui/$(id -u)/com.marktv.tunarr-patched" >/dev/null 2>&1 \
      || log "ERROR: kickstart of the patched service failed"
  else
    open -a "$APP" >/dev/null 2>&1 || log "ERROR: open -a failed"
  fi
  sleep "$RESTART_GRACE"

  local after
  after=$(probe)
  log "post-recovery health http=${after}"
  if [ "$after" != "200" ]; then
    log "WARNING: still unhealthy after recovery; will retry after ${THRESHOLD} more failures"
  fi
}

log "watchdog started (pid $$, interval ${INTERVAL}s, threshold ${THRESHOLD})"
failures=0

while true; do
  code=$(probe)
  dumps=$(count_stream_dumps)
  viewers=$(active_viewers)

  if [ "$code" != "200" ]; then
    failures=$((failures + 1))
    log "health check failed (${failures}/${THRESHOLD}) http=${code}"
    if [ "$failures" -ge "$THRESHOLD" ]; then
      recover
      failures=0
    fi
  elif /bin/bash "$STREAM_POLICY" "$dumps" "$viewers"; then
    if stream_recovery_allowed; then
      recover_stream
    else
      log "stream has ${dumps} fresh ffmpeg failures but is inside the ${STREAM_COOLDOWN}s cooldown - not restarting"
    fi
    failures=0
  else
    if [ "$failures" -gt 0 ]; then
      log "recovered without intervention (http=${code}) after ${failures} failure(s)"
    fi
    failures=0
  fi
  sleep "$INTERVAL"
done
