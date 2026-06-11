#!/usr/bin/env bash
# Wrapper for the LLM k6 scenarios.
#
# Mirrors scripts/embeddings/run-k6.sh: prefer a local k6 binary, fall back
# to Docker. Forwards both the direct-LLM env block and the web-mediated env
# block so the same wrapper drives every scenario.
#
# Usage:
#   ./run-k6.sh <scenario> <profile> [json-out-path]
#
#   scenario : llm-direct-translation | llm-direct-surveygen | llm-direct-chartgen | web-survey-gen
#   profile  : depends on the scenario — see each k6/*.js header
#
# Env forwarded to k6 -e (only set what's relevant to the scenario):
#   Direct LLM        : LLM_URL LLM_API_KEY MODEL RESPONSE_FORMAT BUCKET MAX_TOKENS TEMPERATURE
#   Web-mediated      : FORMBRICKS_URL FORMBRICKS_API_KEY FORMBRICKS_WORKSPACE_ID
#   Tuning            : RATE DURATION MAX_VUS TIMEOUT
#
# Examples:
#   LLM_URL=http://localhost:8000/v1 MODEL=Qwen/Qwen2.5-7B-Instruct \
#     ./run-k6.sh llm-direct-translation smoke
#
#   FORMBRICKS_URL=https://app.staging.formbricks.com \
#     FORMBRICKS_API_KEY=fbk_... \
#     FORMBRICKS_WORKSPACE_ID=cmk... \
#     ./run-k6.sh web-survey-gen baseline report/runs/$(date -u +%Y%m%dT%H%M%SZ)/web.json

set -euo pipefail

SCENARIO="${1:-}"
PROFILE="${2:-}"
JSON_OUT="${3:-}"
K6_DOCKER_IMAGE="${K6_DOCKER_IMAGE:-grafana/k6:latest}"

case "$SCENARIO" in
  llm-direct-translation|llm-direct-surveygen|llm-direct-chartgen|web-survey-gen) ;;
  *)
    echo "usage: ./run-k6.sh <llm-direct-translation|llm-direct-surveygen|llm-direct-chartgen|web-survey-gen> <profile> [json-out]" >&2
    exit 1
    ;;
esac
if [[ -z "$PROFILE" ]]; then
  echo "profile is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K6_SCRIPT_REL="scripts/llm/k6/${SCENARIO}.js"
K6_SCRIPT_ABS="$REPO_ROOT/$K6_SCRIPT_REL"

if [[ ! -f "$K6_SCRIPT_ABS" ]]; then
  echo "script not found: $K6_SCRIPT_ABS" >&2
  exit 1
fi

env_args=()
for key in \
  LLM_URL LLM_API_KEY MODEL RESPONSE_FORMAT BUCKET MAX_TOKENS TEMPERATURE \
  FORMBRICKS_URL FORMBRICKS_API_KEY FORMBRICKS_WORKSPACE_ID \
  RATE DURATION MAX_VUS TIMEOUT
do
  if [[ -n "${!key:-}" ]]; then
    env_args+=(-e "$key=${!key}")
  fi
done
env_args+=(-e "PROFILE=$PROFILE")

echo "== k6 scenario=$SCENARIO profile=$PROFILE =="

if command -v k6 >/dev/null 2>&1; then
  extra=()
  if [[ -n "$JSON_OUT" ]]; then
    mkdir -p "$(dirname "$JSON_OUT")"
    extra+=(--summary-export "$JSON_OUT")
  fi
  (cd "$REPO_ROOT" && k6 run "${env_args[@]}" "${extra[@]}" "$K6_SCRIPT_REL")
else
  if ! docker info >/dev/null 2>&1; then
    echo "docker is required for the k6 fallback, but the Docker daemon is not reachable" >&2
    exit 1
  fi
  docker_args=(run --rm -i -v "$REPO_ROOT:/workspace" -w /workspace
               --add-host=host.docker.internal:host-gateway)
  for a in "${env_args[@]}"; do docker_args+=("$a"); done
  docker_args+=("$K6_DOCKER_IMAGE" run)
  if [[ -n "$JSON_OUT" ]]; then
    mkdir -p "$(dirname "$JSON_OUT")"
    docker_args+=(--summary-export "/workspace/${JSON_OUT#"$REPO_ROOT/"}")
  fi
  docker_args+=("/workspace/$K6_SCRIPT_REL")
  docker "${docker_args[@]}"
fi
