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

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pods_file="/tmp/k8s-pods.$$"
  top_file="/tmp/k8s-top.$$"

  # restart counts and phase per pod
  kubectl -n "$NAMESPACE" get pods "${selector_args[@]}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.phase}{"\n"}{end}' \
    >"$pods_file" 2>/dev/null || true

  # cpu/mem per pod-container
  if kubectl -n "$NAMESPACE" top pods --containers --no-headers "${selector_args[@]}" >"$top_file" 2>/dev/null; then
    awk -v ts="$ts" '
      BEGIN { FS = "[ \t]+"; OFS = "," }
      function cpu_milli(v, n) {
        n = v
        if (v ~ /m$/) { sub(/m$/, "", n); return n + 0 }
        if (v ~ /u$/) { sub(/u$/, "", n); return int((n + 999) / 1000) }
        if (v ~ /n$/) { sub(/n$/, "", n); return int((n + 999999) / 1000000) }
        return (n + 0) * 1000
      }
      function memory_mi(v, n) {
        n = v
        if (v ~ /Mi$/) { sub(/Mi$/, "", n); return n + 0 }
        if (v ~ /Gi$/) { sub(/Gi$/, "", n); return (n + 0) * 1024 }
        if (v ~ /Ki$/) { sub(/Ki$/, "", n); return int((n + 1023) / 1024) }
        return int((n + 1048575) / 1048576)
      }
      FNR == NR {
        restarts[$1] = $2
        phase[$1] = $3
        next
      }
      NF >= 4 {
        pod = $1
        print ts, pod, $2, cpu_milli($3), memory_mi($4), (pod in restarts ? restarts[pod] : 0), (pod in phase ? phase[pod] : "unknown")
      }
    ' "$pods_file" "$top_file" >>"$OUT"
  else
    # metrics-server may be unavailable. Still emit a row with empties so we
    # can correlate restart/phase changes against time.
    awk -v ts="$ts" 'BEGIN { FS = "\t"; OFS = "," } NF >= 1 { print ts, $1, "", "", "", ($2 ? $2 : 0), ($3 ? $3 : "unknown") }' "$pods_file" >>"$OUT"
  fi

  rm -f "$pods_file" "$top_file"
  sleep "$INTERVAL"
done
