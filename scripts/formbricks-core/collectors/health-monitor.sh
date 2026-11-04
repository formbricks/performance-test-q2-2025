#!/usr/bin/env bash

set -euo pipefail

PROFILE="${PROFILE:?PROFILE is required}"
K6_PID="${K6_PID:?K6_PID is required}"
OUT="${OUT:?OUT is required}"
ABORT_FILE="${ABORT_FILE:?ABORT_FILE is required}"
INTERVAL="${INTERVAL:-10}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: >"$OUT"
while kill -0 "$K6_PID" 2>/dev/null; do
  if ! "$SCRIPT_DIR/preflight.sh" "$PROFILE" >>"$OUT" 2>&1; then
    printf '%s monitor_abort reason=health_or_capacity_guardrail\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$OUT"
    printf 'health or capacity degraded; terminating k6\n' >"$ABORT_FILE"
    printf 'health monitor: health or capacity degraded; terminating k6\n' >&2
    kill -TERM "$K6_PID" 2>/dev/null || true
    exit 1
  fi
  sleep "$INTERVAL"
done
