#!/usr/bin/env bash

set -euo pipefail

SCENARIO="${1:-}"
PROFILE="${2:-}"
JSON_OUT="${3:-}"
SUMMARY_MD="${4:-}"
RAW_JSON_OUT="${5:-}"
K6_DOCKER_IMAGE="${K6_DOCKER_IMAGE:-grafana/k6:2.0.0}"

case "$SCENARIO" in
  public-read|public-survey|management-read|response-write|survey-lifecycle|mixed) ;;
  *)
    echo "usage: ./run-k6.sh <public-read|public-survey|management-read|response-write|survey-lifecycle|mixed> <smoke|baseline|load|stress|spike|soak> [json-out] [summary-md] [raw-json-out]" >&2
    exit 1
    ;;
esac
case "$PROFILE" in
  smoke|baseline|load|stress|spike|soak) ;;
  *)
    echo "invalid profile: $PROFILE" >&2
    exit 1
    ;;
esac

: "${RUN_ID:?RUN_ID is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K6_SCRIPT_REL="scripts/formbricks-core/k6/formbricks-core.js"

# shellcheck source=lib/guardrails.sh
# shellcheck disable=SC1091 -- SCRIPT_DIR resolves the checked-in helper at runtime.
source "$SCRIPT_DIR/lib/guardrails.sh"
validate_guardrails "$PROFILE"

extra_args=()
for path in "$JSON_OUT" "$SUMMARY_MD" "$RAW_JSON_OUT"; do
  if [[ -n "$path" ]]; then
    mkdir -p "$(dirname "$path")"
  fi
done
if [[ -n "$RAW_JSON_OUT" ]]; then
  extra_args+=(--summary-export "$RAW_JSON_OUT")
fi

echo "== k6 run_id=$RUN_ID scenario=$SCENARIO profile=$PROFILE =="

if command -v k6 >/dev/null 2>&1; then
  cd "$REPO_ROOT"
  exec env \
    SCENARIO="$SCENARIO" \
    PROFILE="$PROFILE" \
    RUN_ID="$RUN_ID" \
    SUMMARY_JSON="$JSON_OUT" \
    SUMMARY_MD="$SUMMARY_MD" \
    k6 run --tag "performance_run=$RUN_ID" "${extra_args[@]}" "$K6_SCRIPT_REL"
fi

if ! docker info >/dev/null 2>&1; then
  echo "k6 is not installed and the Docker daemon is not reachable" >&2
  exit 1
fi

for path in "$JSON_OUT" "$SUMMARY_MD" "$RAW_JSON_OUT"; do
  if [[ -n "$path" && "$path" != "$REPO_ROOT"/* ]]; then
    echo "Docker fallback requires output paths under $REPO_ROOT" >&2
    exit 1
  fi
done

docker_args=(run --rm -i -v "$REPO_ROOT:/workspace" -w /workspace)
docker_args+=(--add-host=host.docker.internal:host-gateway)
for key in FORMBRICKS_URL FORMBRICKS_WORKSPACE_ID FORMBRICKS_API_KEY \
           FORMBRICKS_SURVEY_ID FORMBRICKS_QUESTION_ID RATE DURATION MAX_VUS \
           ITERATIONS MAX_DURATION P50_MS P90_MS P95_MS P99_MS TIMEOUT \
           ALLOW_NON_ARTEMIS_TARGET CONFIRM_HIGH_IMPACT_PROFILE; do
  if [[ -n "${!key:-}" ]]; then
    docker_args+=(-e "$key")
  fi
done
docker_args+=(-e "SCENARIO=$SCENARIO" -e "PROFILE=$PROFILE" -e "RUN_ID=$RUN_ID")
if [[ -n "$SUMMARY_MD" ]]; then
  docker_args+=(-e "SUMMARY_MD=/workspace/${SUMMARY_MD#"$REPO_ROOT/"}")
fi
if [[ -n "$JSON_OUT" ]]; then
  docker_args+=(-e "SUMMARY_JSON=/workspace/${JSON_OUT#"$REPO_ROOT/"}")
fi
docker_args+=("$K6_DOCKER_IMAGE" run --tag "performance_run=$RUN_ID")
if [[ -n "$RAW_JSON_OUT" ]]; then
  docker_args+=(--summary-export "/workspace/${RAW_JSON_OUT#"$REPO_ROOT/"}")
fi
docker_args+=("/workspace/$K6_SCRIPT_REL")

exec docker "${docker_args[@]}"
