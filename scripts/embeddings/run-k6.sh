#!/usr/bin/env bash
# Wrapper for the embeddings k6 scenarios.
#
# Mirrors the rate-limit wrapper: prefers a local k6 binary, falls back to
# Docker. Passes through all relevant env vars to k6.
#
# Usage:
#   ./run-k6.sh <scenario> <profile> [json-out-path]
#
#   scenario : direct-tei | hub-enrichment | hub-search
#   profile  : depends on the scenario (see each script's header)
#
# Env (forwarded to k6 -e):
#   Direct TEI       : TEI_URL TEI_API_KEY MODEL TEI_USE_QA_PREFIX
#   Hub scenarios    : HUB_URL HUB_API_KEY TENANT_ID BUCKET
#   Tuning overrides : RATE DURATION MAX_VUS LIMIT MIN_SCORE
#
# Examples:
#   TEI_URL=http://localhost:8080 TEI_API_KEY=devkey MODEL=Alibaba-NLP/gte-multilingual-base \
#     ./run-k6.sh direct-tei latency
#
#   HUB_URL=http://localhost:8080 HUB_API_KEY=devkey \
#     ./run-k6.sh hub-enrichment baseline
#
#   HUB_URL=http://localhost:8080 HUB_API_KEY=devkey \
#     ./run-k6.sh hub-search warm report/runs/$(date -u +%Y%m%dT%H%M%SZ)/search.json

set -euo pipefail

SCENARIO="${1:-}"
PROFILE="${2:-}"
JSON_OUT="${3:-}"
K6_DOCKER_IMAGE="${K6_DOCKER_IMAGE:-grafana/k6:latest}"

if [[ -z "$SCENARIO" || -z "$PROFILE" ]]; then
  echo "usage: ./run-k6.sh <direct-tei|hub-enrichment|hub-search> <profile> [json-out]" >&2
  exit 1
fi

case "$SCENARIO" in
  direct-tei|hub-enrichment|hub-search) ;;
  *) echo "invalid scenario: $SCENARIO" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K6_SCRIPT_REL="scripts/embeddings/k6/${SCENARIO}.js"
K6_SCRIPT_ABS="$REPO_ROOT/$K6_SCRIPT_REL"

if [[ ! -f "$K6_SCRIPT_ABS" ]]; then
  echo "script not found: $K6_SCRIPT_ABS" >&2
  exit 1
fi

env_args=()
for key in TEI_URL TEI_API_KEY MODEL TEI_USE_QA_PREFIX \
           HUB_URL HUB_API_KEY TENANT_ID BUCKET \
           RATE DURATION MAX_VUS LIMIT MIN_SCORE; do
  if [[ -n "${!key:-}" ]]; then
    env_args+=(-e "$key=${!key}")
  fi
done
env_args+=(-e "PROFILE=$PROFILE")

extra_args=()
if [[ -n "$JSON_OUT" ]]; then
  mkdir -p "$(dirname "$JSON_OUT")"
  extra_args+=(--summary-export "$JSON_OUT")
fi

echo "== k6 scenario=$SCENARIO profile=$PROFILE =="

if command -v k6 >/dev/null 2>&1; then
  (cd "$REPO_ROOT" && k6 run "${env_args[@]}" "${extra_args[@]}" "$K6_SCRIPT_REL")
else
  if ! docker info >/dev/null 2>&1; then
    echo "docker is required for the k6 fallback, but the Docker daemon is not reachable" >&2
    exit 1
  fi
  docker_args=(run --rm -i -v "$REPO_ROOT:/workspace" -w /workspace)
  # Apple Silicon: docker.sock host.docker.internal already maps to host;
  # adding the host-gateway flag covers Linux too.
  docker_args+=(--add-host=host.docker.internal:host-gateway)
  for arg in "${env_args[@]}"; do
    docker_args+=("$arg")
  done
  docker_args+=("$K6_DOCKER_IMAGE" run)
  if [[ -n "$JSON_OUT" ]]; then
    docker_args+=(--summary-export "/workspace/${JSON_OUT#"$REPO_ROOT/"}")
  fi
  docker_args+=("/workspace/$K6_SCRIPT_REL")
  docker "${docker_args[@]}"
fi
