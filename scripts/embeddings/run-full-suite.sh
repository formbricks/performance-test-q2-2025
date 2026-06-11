#!/usr/bin/env bash
# Orchestrate one end-to-end embeddings load test run:
#   1. Start background collectors (River queue depth + kubectl top + events).
#   2. Run the chosen k6 scenarios.
#   3. Stop collectors, run post-run SQL (verify + enrichment latency).
#   4. Bundle everything into report/runs/<timestamp>/.
#
# Designed to be safe to interrupt — collectors are killed in EXIT.
#
# Usage examples:
#
#   # Mid-volume enrichment + concurrent search (the realistic mixed load):
#   PROFILE=mid SEARCH_PROFILE=busy ./run-full-suite.sh enrichment+search
#
#   # Baseline-only enrichment for the 24/7 number:
#   PROFILE=baseline ./run-full-suite.sh enrichment
#
#   # Direct TEI sweep without Hub:
#   PROFILE=sweep ./run-full-suite.sh direct-tei
#
# Required env:
#   HUB_URL, HUB_API_KEY        — for Hub scenarios
#   TEI_URL, TEI_API_KEY, MODEL — for direct-tei scenarios
#   DATABASE_URL                — for the SQL collectors
#   NAMESPACE                   — k8s namespace where Hub runs (for kubectl)
#   POD_SELECTOR                — label selector for the pods to monitor
#
# Optional:
#   PROFILE             — k6 enrichment/direct-tei profile (default: baseline / sweep)
#   SEARCH_PROFILE      — k6 search profile (default: busy)
#   TENANT_ID           — Hub tenant id (default: formbricks-hub-test-tenant)
#   RUN_DIR             — output dir (default: report/runs/<ts>)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:-}"
case "$MODE" in
  enrichment|enrichment+search|direct-tei|search) ;;
  *)
    echo "usage: ./run-full-suite.sh <enrichment|enrichment+search|direct-tei|search>" >&2
    exit 1
    ;;
esac

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${RUN_DIR:-$SCRIPT_DIR/report/runs/$TS}"
mkdir -p "$RUN_DIR"
echo "run dir: $RUN_DIR"

START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$START_ISO" >"$RUN_DIR/start.txt"

cleanup_pids=()
stop_collectors() {
  for pid in "${cleanup_pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  for pid in "${cleanup_pids[@]:-}"; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
  cleanup_pids=()
}
trap stop_collectors EXIT

start_collectors() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    OUT="$RUN_DIR/queue-depth.csv" INTERVAL="${QUEUE_INTERVAL:-1}" \
      "$SCRIPT_DIR/collectors/queue-depth.sh" &
    cleanup_pids+=("$!")
  else
    echo "DATABASE_URL not set — skipping queue-depth collector" >&2
  fi
  if [[ -n "${NAMESPACE:-}" ]]; then
    OUT="$RUN_DIR/k8s-metrics.csv" \
      EVENTS_OUT="$RUN_DIR/k8s-events.txt" \
      INTERVAL="${K8S_INTERVAL:-5}" \
      POD_SELECTOR="${POD_SELECTOR:-}" \
      "$SCRIPT_DIR/collectors/k8s-metrics.sh" &
    cleanup_pids+=("$!")
  else
    echo "NAMESPACE not set — skipping k8s-metrics collector" >&2
  fi
}

run_post_sql() {
  local end_iso="$1"
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL not set — skipping post-run SQL" >&2
    return
  fi
  local tenant="${TENANT_ID:-formbricks-hub-test-tenant}"
  psql "$DATABASE_URL" -X -A -F'|' \
    -v start="'${START_ISO}'" -v end="'${end_iso}'" -v tenant="'${tenant}'" \
    -f "$SCRIPT_DIR/collectors/enrichment-latency.sql" \
    >"$RUN_DIR/enrichment-latency.txt" 2>&1 || true
  psql "$DATABASE_URL" -X -A -F'|' \
    -v start="'${START_ISO}'" -v end="'${end_iso}'" -v tenant="'${tenant}'" \
    -f "$SCRIPT_DIR/collectors/verify-embeddings.sql" \
    >"$RUN_DIR/verify-embeddings.txt" 2>&1 || true
}

run_k6_with_tee() {
  local scenario="$1"
  local profile="$2"
  local json_out="$3"
  local log_out="$4"
  local rc

  set +e
  "$SCRIPT_DIR/run-k6.sh" "$scenario" "$profile" "$json_out" 2>&1 | tee "$log_out"
  rc=${PIPESTATUS[0]}
  set -e

  return "$rc"
}

run_k6_to_log() {
  local scenario="$1"
  local profile="$2"
  local json_out="$3"
  local log_out="$4"
  local rc

  set +e
  "$SCRIPT_DIR/run-k6.sh" "$scenario" "$profile" "$json_out" >"$log_out" 2>&1
  rc=$?
  set -e

  return "$rc"
}

run_rc=0

case "$MODE" in
  direct-tei)
    : "${TEI_URL:?TEI_URL is required}"
    : "${TEI_API_KEY:?TEI_API_KEY is required}"
    start_collectors
    sleep 2
    run_k6_with_tee direct-tei "${PROFILE:-sweep}" "$RUN_DIR/direct-tei.json" "$RUN_DIR/direct-tei.log" || run_rc=$?
    ;;
  enrichment)
    : "${HUB_URL:?HUB_URL is required}"
    : "${HUB_API_KEY:?HUB_API_KEY is required}"
    start_collectors
    sleep 2
    run_k6_with_tee hub-enrichment "${PROFILE:-baseline}" "$RUN_DIR/enrichment.json" "$RUN_DIR/enrichment.log" || run_rc=$?
    ;;
  search)
    : "${HUB_URL:?HUB_URL is required}"
    : "${HUB_API_KEY:?HUB_API_KEY is required}"
    start_collectors
    sleep 2
    run_k6_with_tee hub-search "${PROFILE:-warm}" "$RUN_DIR/search.json" "$RUN_DIR/search.log" || run_rc=$?
    ;;
  enrichment+search)
    : "${HUB_URL:?HUB_URL is required}"
    : "${HUB_API_KEY:?HUB_API_KEY is required}"
    start_collectors
    sleep 2
    run_k6_to_log hub-enrichment "${PROFILE:-mid}" "$RUN_DIR/enrichment.json" "$RUN_DIR/enrichment.log" &
    enrich_pid=$!
    run_k6_with_tee hub-search "${SEARCH_PROFILE:-busy}" "$RUN_DIR/search.json" "$RUN_DIR/search.log" || run_rc=$?
    wait "$enrich_pid" || run_rc=$?
    ;;
esac

END_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$END_ISO" >"$RUN_DIR/end.txt"

# Give workers a moment to drain queued jobs before we measure final state.
echo "sleeping 30s before post-run SQL to let workers drain..."
sleep 30
stop_collectors

run_post_sql "$END_ISO"

if [[ -n "${NAMESPACE:-}" ]]; then
  kubectl -n "$NAMESPACE" describe pods >"$RUN_DIR/k8s-describe.txt" 2>&1 || true
fi

echo "run complete: $RUN_DIR"
ls -la "$RUN_DIR"

if (( run_rc != 0 )); then
  echo "one or more k6 scenarios failed; artifacts were still collected (exit=${run_rc})" >&2
  exit "$run_rc"
fi
