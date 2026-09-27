#!/usr/bin/env bash

set -euo pipefail

PROFILE="${1:-}"
SCENARIO="${2:-mixed}"

case "$PROFILE" in
  smoke|baseline|step|soak) ;;
  *)
    echo "usage: ./run-full-suite.sh <smoke|baseline|step|soak> [public-read|management-read|response-write|survey-lifecycle|mixed]" >&2
    exit 1
    ;;
esac
case "$SCENARIO" in
  public-read|management-read|response-write|survey-lifecycle|mixed) ;;
  *) echo "invalid scenario: $SCENARIO" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_ID="${RUN_ID:-eng3309-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RUN_DIR="${RUN_DIR:-$SCRIPT_DIR/report/runs/$RUN_ID}"
K6_DOCKER_IMAGE="${K6_DOCKER_IMAGE:-grafana/k6:2.0.0}"

: "${FORMBRICKS_URL:?FORMBRICKS_URL is required}"
: "${FORMBRICKS_WORKSPACE_ID:?FORMBRICKS_WORKSPACE_ID is required}"
if [[ "$SCENARIO" != "public-read" ]]; then
  : "${FORMBRICKS_API_KEY:?FORMBRICKS_API_KEY is required}"
fi

mkdir -p "$RUN_DIR"
export RUN_ID

fixture_needed=false
if [[ "$SCENARIO" == "response-write" || "$SCENARIO" == "mixed" ]]; then
  fixture_needed=true
fi
cleanup_needed=false
if [[ "$fixture_needed" == "true" || "$SCENARIO" == "survey-lifecycle" ]]; then
  cleanup_needed=true
fi

collector_pid=""
cleanup_done=false

stop_collector() {
  if [[ -n "$collector_pid" ]]; then
    kill "$collector_pid" 2>/dev/null || true
    wait "$collector_pid" 2>/dev/null || true
    collector_pid=""
  fi
}

cleanup_fixture() {
  local cleanup_status=0
  if [[ "$cleanup_needed" == "true" && "$cleanup_done" == "false" ]]; then
    if ! "$SCRIPT_DIR/fixtures.sh" cleanup "$RUN_DIR"; then
      cleanup_status=1
    fi
    cleanup_done=true
  fi
  return "$cleanup_status"
}

on_exit() {
  local exit_code=$?
  stop_collector
  if ! cleanup_fixture; then
    exit_code=1
  fi
  exit "$exit_code"
}
trap on_exit EXIT INT TERM

start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$start_iso" >"$RUN_DIR/start.txt"

{
  echo "run_id=$RUN_ID"
  echo "scenario=$SCENARIO"
  echo "profile=$PROFILE"
  echo "formbricks_url=${FORMBRICKS_URL%/}"
  echo "workspace_id=$FORMBRICKS_WORKSPACE_ID"
  echo "git_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "k6_version=$(k6 version 2>/dev/null || echo docker:$K6_DOCKER_IMAGE)"
  echo "kubectl_context=$(kubectl config current-context 2>/dev/null || echo unavailable)"
} >"$RUN_DIR/metadata.txt"

if [[ "$fixture_needed" == "true" ]]; then
  "$SCRIPT_DIR/fixtures.sh" create "$RUN_DIR"
  FORMBRICKS_SURVEY_ID="$(jq -r '.survey_id' "$RUN_DIR/fixture.json")"
  FORMBRICKS_QUESTION_ID="$(jq -r '.question_id' "$RUN_DIR/fixture.json")"
  export FORMBRICKS_SURVEY_ID FORMBRICKS_QUESTION_ID
fi

if [[ -n "${NAMESPACE:-}" ]]; then
  OUT="$RUN_DIR/k8s-metrics.csv" \
    EVENTS_OUT="$RUN_DIR/k8s-events.txt" \
    INTERVAL="${K8S_INTERVAL:-5}" \
    POD_SELECTOR="${POD_SELECTOR:-}" \
    "$SCRIPT_DIR/collectors/k8s-metrics.sh" &
  collector_pid=$!
else
  echo "NAMESPACE not set; skipping Kubernetes resource collector" >&2
fi

sleep 2
set +e
"$SCRIPT_DIR/run-k6.sh" \
  "$SCENARIO" \
  "$PROFILE" \
  "$RUN_DIR/k6-summary.json" \
  "$RUN_DIR/k6-summary.md" 2>&1 | tee "$RUN_DIR/k6.log"
k6_status=${PIPESTATUS[0]}
set -e

stop_collector
cleanup_status=0
if ! cleanup_fixture; then
  cleanup_status=1
fi

end_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$end_iso" >"$RUN_DIR/end.txt"

if [[ -n "${NAMESPACE:-}" ]]; then
  kubectl -n "$NAMESPACE" get deployments,pods -o wide >"$RUN_DIR/final-workloads.txt" 2>&1 || true
  kubectl -n "$NAMESPACE" describe pods >"$RUN_DIR/k8s-describe.txt" 2>&1 || true
  kubectl -n "$NAMESPACE" top pods --containers >"$RUN_DIR/final-top.txt" 2>&1 || true
fi

cp "$SCRIPT_DIR/report/template.md" "$RUN_DIR/analysis.md"
echo "run complete: $RUN_DIR"

trap - EXIT INT TERM
if (( k6_status != 0 )); then
  echo "k6 thresholds or execution failed (exit=$k6_status)" >&2
  exit "$k6_status"
fi
if (( cleanup_status != 0 )); then
  echo "fixture cleanup was incomplete; see $RUN_DIR/cleanup.log" >&2
  exit 1
fi
