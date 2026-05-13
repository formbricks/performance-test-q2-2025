#!/usr/bin/env bash
# Poll Kubernetes metrics for the Hub embeddings stack. One CSV row per pod
# per sample.
#
# Captures CPU + memory from `kubectl top` and restart count from `kubectl get`.
# OOM/throttle/probe-failure events are dumped into a separate file once at the
# end (events stream is queried at stop-time).
#
# Usage:
#   NAMESPACE=hub \
#   INTERVAL=5 \
#   OUT=report/runs/<ts>/k8s-metrics.csv \
#   EVENTS_OUT=report/runs/<ts>/k8s-events.txt \
#   POD_SELECTOR='app.kubernetes.io/name=hub' \
#   ./collectors/k8s-metrics.sh

set -euo pipefail

: "${NAMESPACE:?NAMESPACE is required}"
INTERVAL="${INTERVAL:-5}"
OUT="${OUT:?OUT path is required}"
EVENTS_OUT="${EVENTS_OUT:-${OUT%.csv}-events.txt}"
POD_SELECTOR="${POD_SELECTOR:-}"

mkdir -p "$(dirname "$OUT")"
echo "ts_utc,pod,container,cpu_milli,memory_mi,restarts,phase" >"$OUT"

selector_args=()
if [[ -n "$POD_SELECTOR" ]]; then
  selector_args=(-l "$POD_SELECTOR")
fi

cleanup() {
  echo "k8s collector stopped — dumping events" >&2
  kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp >"$EVENTS_OUT" 2>&1 || true
}
trap cleanup EXIT

# Pre-build a pod→restart lookup we refresh every sample.
while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # restart counts and phase per pod
  declare -A restarts phase
  while IFS=$'\t' read -r pod r p; do
    [[ -z "$pod" ]] && continue
    restarts["$pod"]="$r"
    phase["$pod"]="$p"
  done < <(
    kubectl -n "$NAMESPACE" get pods "${selector_args[@]}" \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.phase}{"\n"}{end}' \
      2>/dev/null || true
  )

  # cpu/mem per pod-container
  if kubectl -n "$NAMESPACE" top pods --containers --no-headers "${selector_args[@]}" >/tmp/k8s-top.$$ 2>/dev/null; then
    while read -r pod container cpu mem _rest; do
      [[ -z "$pod" ]] && continue
      cpu_milli="${cpu%m}"
      [[ "$cpu_milli" == "$cpu" ]] && cpu_milli=$(( ${cpu:-0} * 1000 ))
      mem_mi="${mem%Mi}"
      [[ "$mem_mi" == "$mem" ]] && mem_mi="${mem%Gi}" && mem_mi=$(( ${mem_mi:-0} * 1024 ))
      echo "${ts},${pod},${container},${cpu_milli},${mem_mi},${restarts[$pod]:-0},${phase[$pod]:-unknown}" >>"$OUT"
    done </tmp/k8s-top.$$
    rm -f /tmp/k8s-top.$$
  else
    # metrics-server may be unavailable. Still emit a row with empties so we
    # can correlate restart/phase changes against time.
    for pod in "${!phase[@]}"; do
      echo "${ts},${pod},,,,${restarts[$pod]:-0},${phase[$pod]:-unknown}" >>"$OUT"
    done
  fi

  unset restarts phase
  declare -A restarts phase
  sleep "$INTERVAL"
done
