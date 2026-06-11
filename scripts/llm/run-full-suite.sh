#!/usr/bin/env bash
# Orchestrate one LLM load-test run:
#   1. Start background collectors (vLLM /metrics, GPU nvidia-smi, kubectl top + events).
#   2. Run the chosen k6 scenario(s).
#   3. Stop collectors, dump final cluster state.
#   4. Bundle everything into report/runs/<ts>/.
#
# Modes:
#   translation       direct LLM translation (balanced prefill+decode)
#   surveygen         direct LLM survey generation (decode-heavy)
#   chartgen          direct LLM chart generation (prefill-heavy)
#   web               web-mediated POST /api/v3/surveys/generate
#   mixed             translation + chartgen + web concurrently
#                     (the ticket's "concurrent mixed traffic" scenario)
#
# Env (forwarded to the k6 layer; see run-k6.sh for the full list):
#   Direct-LLM modes : LLM_URL, MODEL, optional LLM_API_KEY, MAX_TOKENS, RESPONSE_FORMAT
#   Web mode         : FORMBRICKS_URL, FORMBRICKS_API_KEY, FORMBRICKS_WORKSPACE_ID
#   Collectors       : VLLM_METRICS_URL, NAMESPACE, POD_SELECTOR
#   Profile + tuning : PROFILE (default baseline), RATE, DURATION, MAX_VUS, TIMEOUT
#
# Usage examples:
#
#   # Just translation, baseline volume
#   PROFILE=baseline ./run-full-suite.sh translation
#
#   # Stress survey-gen until it breaks
#   PROFILE=stress ./run-full-suite.sh surveygen
#
#   # Concurrent mixed traffic (the realistic load)
#   PROFILE=mid ./run-full-suite.sh mixed
#
#   # Web-mediated burst (exercises the rate limiter)
#   PROFILE=burst ./run-full-suite.sh web

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:-}"
case "$MODE" in
  translation|surveygen|chartgen|web|mixed) ;;
  *)
    echo "usage: ./run-full-suite.sh <translation|surveygen|chartgen|web|mixed>" >&2
    exit 1
    ;;
esac

PROFILE_DEFAULT="baseline"
PROFILE="${PROFILE:-$PROFILE_DEFAULT}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${RUN_DIR:-$SCRIPT_DIR/report/runs/$TS}"
mkdir -p "$RUN_DIR"
echo "run dir: $RUN_DIR"

START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$START_ISO" >"$RUN_DIR/start.txt"
echo "mode=$MODE profile=$PROFILE" >>"$RUN_DIR/start.txt"

cleanup_pids=()
cleanup() {
  for pid in "${cleanup_pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

start_collectors() {
  if [[ -n "${VLLM_METRICS_URL:-}" ]]; then
    OUT="$RUN_DIR/vllm-metrics.csv" INTERVAL="${VLLM_INTERVAL:-1}" \
      "$SCRIPT_DIR/collectors/vllm-metrics.sh" &
    cleanup_pids+=("$!")
  else
    echo "VLLM_METRICS_URL not set — skipping vllm-metrics collector" >&2
  fi
  if [[ -n "${NAMESPACE:-}" ]]; then
    OUT="$RUN_DIR/gpu-metrics.csv" INTERVAL="${GPU_INTERVAL:-5}" \
      POD_SELECTOR="${POD_SELECTOR:-}" \
      "$SCRIPT_DIR/collectors/gpu-metrics.sh" &
    cleanup_pids+=("$!")
    OUT="$RUN_DIR/k8s-metrics.csv" \
      EVENTS_OUT="$RUN_DIR/k8s-events.txt" \
      INTERVAL="${K8S_INTERVAL:-5}" \
      POD_SELECTOR="${POD_SELECTOR:-}" \
      "$SCRIPT_DIR/collectors/k8s-metrics.sh" &
    cleanup_pids+=("$!")
  else
    echo "NAMESPACE not set — skipping kubectl-based collectors" >&2
  fi
}

run_k6() {
  local scenario="$1" profile="$2" tag="${3:-$1}"
  "$SCRIPT_DIR/run-k6.sh" "$scenario" "$profile" "$RUN_DIR/${tag}.json" \
    | tee "$RUN_DIR/${tag}.log"
}

case "$MODE" in
  translation|surveygen|chartgen)
    start_collectors
    sleep 2
    run_k6 "llm-direct-$MODE" "$PROFILE" "$MODE"
    ;;
  web)
    start_collectors
    sleep 2
    run_k6 "web-survey-gen" "$PROFILE" "web"
    ;;
  mixed)
    # Three k6 processes in parallel: translation + chartgen against vLLM
    # plus web-survey-gen through Formbricks. Each writes its own .log/.json.
    start_collectors
    sleep 2
    "$SCRIPT_DIR/run-k6.sh" llm-direct-translation "$PROFILE" "$RUN_DIR/translation.json" \
      >"$RUN_DIR/translation.log" 2>&1 &
    t_pid=$!
    "$SCRIPT_DIR/run-k6.sh" llm-direct-chartgen "$PROFILE" "$RUN_DIR/chartgen.json" \
      >"$RUN_DIR/chartgen.log" 2>&1 &
    c_pid=$!
    "$SCRIPT_DIR/run-k6.sh" web-survey-gen "$PROFILE" "$RUN_DIR/web.json" \
      | tee "$RUN_DIR/web.log"
    wait "$t_pid" "$c_pid" || true
    ;;
esac

END_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$END_ISO" >"$RUN_DIR/end.txt"

if [[ -n "${NAMESPACE:-}" ]]; then
  kubectl -n "$NAMESPACE" describe pods >"$RUN_DIR/k8s-describe.txt" 2>&1 || true
  kubectl -n "$NAMESPACE" get deployments -o wide >"$RUN_DIR/final-deployments.txt" 2>&1 || true
  kubectl -n "$NAMESPACE" top pods --containers 2>&1 | tee "$RUN_DIR/final-top.txt" >/dev/null || true
fi

echo "run complete: $RUN_DIR"
ls -la "$RUN_DIR"
