#!/usr/bin/env bash
# Poll River queue + worker state for the embeddings queue, append one CSV row
# per sample. Intended to run in the background for the duration of a k6 run.
#
# Usage:
#   DATABASE_URL=postgres://... \
#   INTERVAL=1 \
#   OUT=report/runs/<ts>/queue-depth.csv \
#   ./collectors/queue-depth.sh
#
# Stop with Ctrl-C or `kill <pid>`. Writes a trailing line on EXIT.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
INTERVAL="${INTERVAL:-1}"
OUT="${OUT:?OUT path is required}"
QUEUE="${QUEUE:-embeddings}"

mkdir -p "$(dirname "$OUT")"
echo "ts_utc,pending,running,retryable,scheduled,completed_total,discarded_total,oldest_pending_age_s" >"$OUT"

cleanup() {
  echo "queue-depth collector stopped" >&2
}
trap cleanup EXIT

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  read -r pending running retryable scheduled completed discarded oldest <<<"$(
    psql "$DATABASE_URL" -At -F' ' -X -q -c "
      WITH q AS (
        SELECT state, attempted_at, scheduled_at
        FROM river_job
        WHERE queue = '${QUEUE}'
      )
      SELECT
        (SELECT count(*) FROM q WHERE state='available'),
        (SELECT count(*) FROM q WHERE state='running'),
        (SELECT count(*) FROM q WHERE state='retryable'),
        (SELECT count(*) FROM q WHERE state='scheduled'),
        (SELECT count(*) FROM q WHERE state='completed'),
        (SELECT count(*) FROM q WHERE state='discarded'),
        COALESCE(
          EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(scheduled_at, attempted_at))))::int,
          0
        )
      FROM q
      WHERE state IN ('available','retryable','scheduled');
    "
  )"
  echo "${ts},${pending:-0},${running:-0},${retryable:-0},${scheduled:-0},${completed:-0},${discarded:-0},${oldest:-0}" >>"$OUT"
  sleep "$INTERVAL"
done
