#!/usr/bin/env bash
# Scrape vLLM's Prometheus /metrics endpoint every $INTERVAL seconds and write
# the key gauges/counters into a CSV. Intended to run in the background
# alongside a k6 scenario.
#
# vLLM exposes /metrics at the same host:port as /v1/chat/completions. If you
# port-forwarded the vLLM Service on :8000, use:
#   VLLM_METRICS_URL=http://localhost:8000/metrics
#
# Captured columns (one row per sample):
#   ts_utc                                  ISO 8601 UTC
#   running_requests                        vllm:num_requests_running
#   waiting_requests                        vllm:num_requests_waiting
#   gpu_cache_usage_pct                     vllm:gpu_cache_usage_perc * 100
#   cpu_cache_usage_pct                     vllm:cpu_cache_usage_perc * 100
#   preemptions_total                       vllm:num_preemptions_total
#   prompt_tokens_total                     vllm:prompt_tokens_total
#   generation_tokens_total                 vllm:generation_tokens_total
#   e2e_p95_seconds                         vllm:e2e_request_latency_seconds (0.95 quantile if exposed)
#
# Counters (*_total) are emitted as cumulative; compute deltas in post-processing.
#
# Usage:
#   VLLM_METRICS_URL=http://localhost:8000/metrics \
#   INTERVAL=1 \
#   OUT=report/runs/<ts>/vllm-metrics.csv \
#   ./collectors/vllm-metrics.sh

set -euo pipefail

: "${VLLM_METRICS_URL:?VLLM_METRICS_URL is required}"
: "${OUT:?OUT path is required}"
INTERVAL="${INTERVAL:-1}"

mkdir -p "$(dirname "$OUT")"
echo "ts_utc,running_requests,waiting_requests,gpu_cache_usage_pct,cpu_cache_usage_pct,preemptions_total,prompt_tokens_total,generation_tokens_total,e2e_p95_seconds" >"$OUT"

cleanup() { echo "vllm-metrics collector stopped" >&2; }
trap cleanup EXIT

# Extract a non-summary, non-histogram gauge/counter by exact metric name.
# Returns "" if absent.
extract_scalar() {
  local body="$1" name="$2"
  echo "$body" | awk -v n="$name" '
    $0 !~ /^#/ {
      # tolerate {labels} after the metric name
      idx = index($0, "{")
      mn = (idx > 0) ? substr($0, 1, idx - 1) : $1
      if (mn == n) { print $NF; exit }
    }'
}

# Extract a single histogram quantile by metric name + quantile label.
extract_quantile() {
  local body="$1" name="$2" q="$3"
  echo "$body" | awk -v n="$name" -v q="$q" '
    $0 !~ /^#/ {
      if ($1 ~ "^"n"{" && $1 ~ "quantile=\""q"\"") { print $NF; exit }
    }'
}

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  body="$(curl -sf -m 5 "$VLLM_METRICS_URL" 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    echo "${ts},,,,,,,," >>"$OUT"
    sleep "$INTERVAL"
    continue
  fi

  running="$(extract_scalar "$body" "vllm:num_requests_running")"
  waiting="$(extract_scalar "$body" "vllm:num_requests_waiting")"
  gpu_cache="$(extract_scalar "$body" "vllm:gpu_cache_usage_perc")"
  cpu_cache="$(extract_scalar "$body" "vllm:cpu_cache_usage_perc")"
  preempt="$(extract_scalar "$body" "vllm:num_preemptions_total")"
  prompt_total="$(extract_scalar "$body" "vllm:prompt_tokens_total")"
  gen_total="$(extract_scalar "$body" "vllm:generation_tokens_total")"
  e2e_p95="$(extract_quantile "$body" "vllm:e2e_request_latency_seconds" "0.95")"

  # convert ratio to percentage where applicable
  if [[ -n "$gpu_cache" ]]; then gpu_cache_pct=$(awk -v v="$gpu_cache" 'BEGIN{printf "%.2f", v*100}'); else gpu_cache_pct=""; fi
  if [[ -n "$cpu_cache" ]]; then cpu_cache_pct=$(awk -v v="$cpu_cache" 'BEGIN{printf "%.2f", v*100}'); else cpu_cache_pct=""; fi

  echo "${ts},${running:-},${waiting:-},${gpu_cache_pct},${cpu_cache_pct},${preempt:-},${prompt_total:-},${gen_total:-},${e2e_p95:-}" >>"$OUT"
  sleep "$INTERVAL"
done
