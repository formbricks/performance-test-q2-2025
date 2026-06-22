#!/usr/bin/env bash
# Poll GPU utilization, memory, temperature, and power via `kubectl exec` into
# the vLLM pod every $INTERVAL seconds. One CSV row per GPU per sample.
#
# Assumes the vLLM pod has the NVIDIA container toolkit available, which it
# does on standard GPU nodes (the runtime injects /usr/bin/nvidia-smi).
#
# Usage:
#   NAMESPACE=formbricks-stage \
#   POD_SELECTOR='app.kubernetes.io/name=vllm' \
#   INTERVAL=5 \
#   OUT=report/runs/<ts>/gpu-metrics.csv \
#   ./collectors/gpu-metrics.sh

set -euo pipefail

: "${NAMESPACE:?NAMESPACE is required}"
: "${OUT:?OUT path is required}"
INTERVAL="${INTERVAL:-5}"
POD_SELECTOR="${POD_SELECTOR:-}"

mkdir -p "$(dirname "$OUT")"
echo "ts_utc,pod,gpu_index,gpu_util_pct,mem_used_mib,mem_total_mib,temperature_c,power_w" >"$OUT"

selector_args=()
[[ -n "$POD_SELECTOR" ]] && selector_args=(-l "$POD_SELECTOR")

cleanup() { echo "gpu-metrics collector stopped" >&2; }
trap cleanup EXIT

# Cache the pod list and refresh once a minute. Otherwise every iteration
# round-trips a `kubectl get pods` even though pod identity rarely changes
# during a load test.
pods=()
last_refresh=0
refresh_pods() {
  mapfile -t pods < <(
    kubectl -n "$NAMESPACE" get pods "${selector_args[@]}" \
      -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}' \
      2>/dev/null
  )
}

while true; do
  now=$(date +%s)
  if (( now - last_refresh > 60 )); then
    refresh_pods
    last_refresh=$now
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  for pod in "${pods[@]}"; do
    [[ -z "$pod" ]] && continue
    out="$(
      kubectl -n "$NAMESPACE" exec "$pod" -- nvidia-smi \
        --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw \
        --format=csv,noheader,nounits 2>/dev/null || true
    )"
    [[ -z "$out" ]] && continue
    while IFS=, read -r idx util mem_used mem_total temp power; do
      idx="${idx// /}"
      util="${util// /}"
      mem_used="${mem_used// /}"
      mem_total="${mem_total// /}"
      temp="${temp// /}"
      power="${power// /}"
      echo "${ts},${pod},${idx},${util},${mem_used},${mem_total},${temp},${power}" >>"$OUT"
    done <<<"$out"
  done

  sleep "$INTERVAL"
done
