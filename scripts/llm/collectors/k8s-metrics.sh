#!/usr/bin/env bash
# Poll Kubernetes metrics (cpu/mem via kubectl top + restart count + phase)
# for the vLLM and Formbricks web pods every $INTERVAL seconds.
#
# This is an adapted copy of scripts/embeddings/collectors/k8s-metrics.sh —
# same output shape, same awk-based unit parsing, just pointed at the LLM
# stack's namespace and pod selectors.
#
# Captures OOM, evicted, and probe-failure events into a separate file at
# EXIT so the post-run report can correlate restarts with events.
#
# Usage:
#   NAMESPACE=formbricks-stage \
#   POD_SELECTOR='app.kubernetes.io/name in (vllm,formbricks-web)' \
#   INTERVAL=5 \
#   OUT=report/runs/<ts>/k8s-metrics.csv \
#   EVENTS_OUT=report/runs/<ts>/k8s-events.txt \
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
[[ -n "$POD_SELECTOR" ]] && selector_args=(-l "$POD_SELECTOR")

cleanup() {
  echo "k8s collector stopped — dumping events" >&2
  kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp >"$EVENTS_OUT" 2>&1 || true
}
trap cleanup EXIT

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pods_file="/tmp/k8s-pods-llm.$$"
  top_file="/tmp/k8s-top-llm.$$"

  kubectl -n "$NAMESPACE" get pods "${selector_args[@]}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.phase}{"\n"}{end}' \
    >"$pods_file" 2>/dev/null || true

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
    awk -v ts="$ts" 'BEGIN { FS = "\t"; OFS = "," } NF >= 1 { print ts, $1, "", "", "", ($2 ? $2 : 0), ($3 ? $3 : "unknown") }' "$pods_file" >>"$OUT"
  fi

  rm -f "$pods_file" "$top_file"
  sleep "$INTERVAL"
done
