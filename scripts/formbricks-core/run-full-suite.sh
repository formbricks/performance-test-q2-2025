#!/usr/bin/env bash

set -euo pipefail

PROFILE="${1:-}"
SCENARIO="${2:-mixed}"

case "$PROFILE" in
  smoke|baseline|load|stress|spike|soak) ;;
  *)
    echo "usage: ./run-full-suite.sh <smoke|baseline|load|stress|spike|soak> [public-read|public-survey|management-read|response-write|survey-lifecycle|mixed]" >&2
    exit 1
    ;;
esac
case "$SCENARIO" in
  public-read|public-survey|management-read|response-write|survey-lifecycle|mixed) ;;
  *) echo "invalid scenario: $SCENARIO" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_ID="${RUN_ID:-eng3309-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RUN_DIR="${RUN_DIR:-$SCRIPT_DIR/report/runs/$RUN_ID}"
K6_DOCKER_IMAGE="${K6_DOCKER_IMAGE:-grafana/k6:2.0.0}"

# shellcheck source=lib/guardrails.sh
# shellcheck disable=SC1091 -- SCRIPT_DIR resolves the checked-in helper at runtime.
source "$SCRIPT_DIR/lib/guardrails.sh"
validate_guardrails "$PROFILE"

: "${FORMBRICKS_URL:?FORMBRICKS_URL is required}"
: "${FORMBRICKS_WORKSPACE_ID:?FORMBRICKS_WORKSPACE_ID is required}"
if [[ "$SCENARIO" != "public-read" ]]; then
  : "${FORMBRICKS_API_KEY:?FORMBRICKS_API_KEY is required}"
fi

mkdir -p "$RUN_DIR"
export RUN_ID

fixture_needed=false
if [[ "$SCENARIO" == "public-survey" || "$SCENARIO" == "response-write" || "$SCENARIO" == "mixed" ]]; then
  fixture_needed=true
fi
cleanup_needed=false
if [[ "$fixture_needed" == "true" || "$SCENARIO" == "survey-lifecycle" ]]; then
  cleanup_needed=true
fi
cleanup_armed=false

collector_pid=""
monitor_pid=""
k6_pid=""
cleanup_done=false

stop_collector() {
  if [[ -n "$collector_pid" ]]; then
    kill "$collector_pid" 2>/dev/null || true
    wait "$collector_pid" 2>/dev/null || true
    collector_pid=""
  fi
}

stop_monitor() {
  if [[ -n "$monitor_pid" ]]; then
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
    monitor_pid=""
  fi
}

stop_k6() {
  if [[ -n "$k6_pid" ]] && kill -0 "$k6_pid" 2>/dev/null; then
    kill -TERM "$k6_pid" 2>/dev/null || true
    wait "$k6_pid" 2>/dev/null || true
  fi
  k6_pid=""
}

cleanup_fixture() {
  local cleanup_status=0
  if [[ "$cleanup_needed" == "true" && "$cleanup_armed" == "true" && "$cleanup_done" == "false" ]]; then
    if ! "$SCRIPT_DIR/fixtures.sh" cleanup "$RUN_DIR"; then
      cleanup_status=1
    fi
    cleanup_done=true
  fi
  return "$cleanup_status"
}

on_exit() {
  local exit_code=$?
  stop_monitor
  stop_k6
  stop_collector
  if ! cleanup_fixture; then
    exit_code=1
  fi
  exit "$exit_code"
}
trap on_exit EXIT INT TERM

suite_start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$suite_start_iso" >"$RUN_DIR/suite-start.txt"

if command -v k6 >/dev/null 2>&1; then
  k6_version="$(k6 version)"
else
  k6_version="docker:$K6_DOCKER_IMAGE"
fi

{
  echo "run_id=$RUN_ID"
  echo "scenario=$SCENARIO"
  echo "profile=$PROFILE"
  echo "formbricks_url=${FORMBRICKS_URL%/}"
  echo "configured_rate=${RATE:-$(default_rate_for_profile "$PROFILE")}"
  echo "configured_duration=${DURATION:-profile-default}"
  echo "configured_max_vus=${MAX_VUS:-$(default_max_vus_for_profile "$PROFILE")}"
  echo "git_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "k6_version=$k6_version"
  echo "kubectl_context=${KUBECTL_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo unavailable)}"
} >"$RUN_DIR/metadata.txt"

if ! "$SCRIPT_DIR/collectors/preflight.sh" "$PROFILE" >"$RUN_DIR/preflight.txt" 2>&1; then
  sed -n '1,120p' "$RUN_DIR/preflight.txt" >&2
  exit 1
fi

if [[ "$fixture_needed" == "true" ]]; then
  set +e
  "$SCRIPT_DIR/fixtures.sh" create "$RUN_DIR"
  fixture_status=$?
  set -e
  if (( fixture_status != 2 )); then
    cleanup_armed=true
  fi
  if (( fixture_status != 0 )); then
    exit "$fixture_status"
  fi
  FORMBRICKS_SURVEY_ID="$(jq -r '.survey_id' "$RUN_DIR/fixture.json")"
  FORMBRICKS_QUESTION_ID="$(jq -r '.question_id' "$RUN_DIR/fixture.json")"
  export FORMBRICKS_SURVEY_ID FORMBRICKS_QUESTION_ID
fi

if [[ -n "${NAMESPACE:-}" ]]; then
  OUT="$RUN_DIR/k8s-metrics.csv" \
    EVENTS_OUT="$RUN_DIR/k8s-events.txt" \
    INTERVAL="${K8S_INTERVAL:-5}" \
    POD_SELECTOR="${POD_SELECTOR:-}" \
    KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-}" \
    "$SCRIPT_DIR/collectors/k8s-metrics.sh" &
  collector_pid=$!
else
  echo "NAMESPACE not set; skipping Kubernetes resource collector" >&2
fi

sleep "${PRE_RUN_SETTLE_SECONDS:-2}"
if [[ "$SCENARIO" == "survey-lifecycle" ]]; then
  cleanup_armed=true
fi
start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$start_iso" >"$RUN_DIR/start.txt"
set +e
"$SCRIPT_DIR/run-k6.sh" \
  "$SCENARIO" \
  "$PROFILE" \
  "$RUN_DIR/k6-summary.json" \
  "$RUN_DIR/k6-summary.md" \
  "$RUN_DIR/k6-raw-summary.json" > >(tee "$RUN_DIR/k6.log") 2>&1 &
k6_pid=$!
PROFILE="$PROFILE" \
  K6_PID="$k6_pid" \
  OUT="$RUN_DIR/health-monitor.log" \
  ABORT_FILE="$RUN_DIR/health-abort.txt" \
  INTERVAL="${HEALTH_INTERVAL:-10}" \
  "$SCRIPT_DIR/collectors/health-monitor.sh" &
monitor_pid=$!
wait "$k6_pid"
k6_status=$?
k6_pid=""
set -e

stop_monitor
if [[ -f "$RUN_DIR/health-abort.txt" ]]; then
  k6_status=97
fi
end_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$end_iso" >"$RUN_DIR/end.txt"

stop_collector
cleanup_status=0
if ! cleanup_fixture; then
  cleanup_status=1
fi

suite_end_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$suite_end_iso" >"$RUN_DIR/suite-end.txt"

if [[ -n "${NAMESPACE:-}" ]]; then
  kubectl_context_args=()
  if [[ -n "${KUBECTL_CONTEXT:-}" ]]; then
    kubectl_context_args+=(--context "$KUBECTL_CONTEXT")
  fi
  kubectl "${kubectl_context_args[@]}" -n "$NAMESPACE" get deployments,pods -o wide >"$RUN_DIR/final-workloads.txt" 2>&1 || true
  kubectl "${kubectl_context_args[@]}" -n "$NAMESPACE" get hpa,pdb,pods -o wide >"$RUN_DIR/final-capacity.txt" 2>&1 || true
  kubectl "${kubectl_context_args[@]}" -n "$NAMESPACE" top pods --containers >"$RUN_DIR/final-top.txt" 2>&1 || true
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
