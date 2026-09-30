#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
RUN_DIR="${2:-}"

if [[ "$ACTION" != "create" && "$ACTION" != "cleanup" ]]; then
  echo "usage: ./fixtures.sh <create|cleanup> <run-dir>" >&2
  exit 1
fi
if [[ -z "$RUN_DIR" ]]; then
  echo "run directory is required" >&2
  exit 1
fi

: "${FORMBRICKS_URL:?FORMBRICKS_URL is required}"
: "${FORMBRICKS_WORKSPACE_ID:?FORMBRICKS_WORKSPACE_ID is required}"
: "${FORMBRICKS_API_KEY:?FORMBRICKS_API_KEY is required}"
: "${RUN_ID:?RUN_ID is required}"

BASE_URL="${FORMBRICKS_URL%/}"
mkdir -p "$RUN_DIR"

api_curl() {
  curl --silent --show-error --fail-with-body --config - "$@" <<EOF
header = "Accept: application/json"
header = "Content-Type: application/json"
header = "x-api-key: ${FORMBRICKS_API_KEY}"
header = "User-Agent: formbricks-k6-fixtures/${RUN_ID}"
header = "X-Formbricks-Performance-Run: ${RUN_ID}"
EOF
}

create_fixture() {
  local payload="$RUN_DIR/fixture-create-payload.json"
  local response="$RUN_DIR/fixture-create-response.json"
  local collision_response="$RUN_DIR/fixture-collision-check.json"
  local fixture="$RUN_DIR/fixture.json"
  local question_id="perf-question"
  local survey_id

  if ! api_curl \
    --get \
    --data-urlencode "workspaceId=$FORMBRICKS_WORKSPACE_ID" \
    --data-urlencode "limit=250" \
    --data-urlencode "includeTotalCount=false" \
    --data-urlencode "filter[name][contains]=ENG-3309 $RUN_ID" \
    --output "$collision_response" \
    "$BASE_URL/api/v3/surveys"; then
    echo "unable to verify that RUN_ID is unused" >&2
    return 1
  fi
  if [[ "$(jq '.data | length' "$collision_response")" != "0" ]]; then
    echo "RUN_ID already owns survey fixtures; choose a new RUN_ID or run scoped cleanup" >&2
    return 2
  fi

  jq -n \
    --arg workspace_id "$FORMBRICKS_WORKSPACE_ID" \
    --arg run_id "$RUN_ID" \
    --arg question_id "$question_id" \
    '{
      workspaceId: $workspace_id,
      name: ("ENG-3309 " + $run_id + " response fixture"),
      type: "link",
      status: "inProgress",
      blocks: [{
        name: "Performance test block",
        elements: [{
          id: $question_id,
          type: "openText",
          headline: {"en-US": "Synthetic performance question"},
          required: false
        }]
      }]
    }' >"$payload"

  if ! api_curl \
    --request POST \
    --data-binary "@$payload" \
    --output "$response" \
    "$BASE_URL/api/v3/surveys?createdFrom=blank"; then
    echo "fixture creation failed; response follows" >&2
    sed -n '1,80p' "$response" >&2 || true
    return 1
  fi

  survey_id="$(jq -r '.data.id // .id // empty' "$response")"
  if [[ -z "$survey_id" ]]; then
    echo "fixture response did not contain a survey id" >&2
    sed -n '1,80p' "$response" >&2
    return 1
  fi

  jq -n \
    --arg run_id "$RUN_ID" \
    --arg survey_id "$survey_id" \
    --arg question_id "$question_id" \
    '{run_id: $run_id, survey_id: $survey_id, question_id: $question_id}' >"$fixture"

  echo "created fixture survey $survey_id"
}

cleanup_fixtures() {
  local fixture="$RUN_DIR/fixture.json"
  local list_response="$RUN_DIR/cleanup-list-response.json"
  local verify_response="$RUN_DIR/cleanup-verify-response.json"
  local ids_file="$RUN_DIR/cleanup-survey-ids.txt"
  local cleanup_log="$RUN_DIR/cleanup.log"
  local failed=0
  local expected_prefix="ENG-3309 $RUN_ID "

  : >"$ids_file"
  : >"$cleanup_log"

  if [[ -f "$fixture" ]]; then
    if [[ "$(jq -r '.run_id // empty' "$fixture")" != "$RUN_ID" ]]; then
      echo "fixture ownership does not match RUN_ID; refusing fixture deletion" | tee -a "$cleanup_log" >&2
      failed=1
    else
      jq -r '.survey_id // empty' "$fixture" >>"$ids_file"
    fi
  fi

  if api_curl \
    --get \
    --data-urlencode "workspaceId=$FORMBRICKS_WORKSPACE_ID" \
    --data-urlencode "limit=250" \
    --data-urlencode "includeTotalCount=false" \
    --data-urlencode "filter[name][contains]=ENG-3309 $RUN_ID" \
    --output "$list_response" \
    "$BASE_URL/api/v3/surveys"; then
    if ! jq -e --arg prefix "$expected_prefix" \
      'all(.data[]?; (.name | (type == "string" and startswith($prefix))))' \
      "$list_response" >/dev/null; then
      echo "cleanup search returned a survey outside the exact run prefix; refusing deletion" | tee -a "$cleanup_log" >&2
      failed=1
    else
      jq -r '.data[]?.id // empty' "$list_response" >>"$ids_file"
    fi
  else
    echo "unable to list interrupted lifecycle fixtures" | tee -a "$cleanup_log" >&2
    failed=1
  fi

  sort -u "$ids_file" -o "$ids_file"
  while IFS= read -r survey_id; do
    [[ -z "$survey_id" ]] && continue
    if api_curl \
      --request DELETE \
      --output /dev/null \
      "$BASE_URL/api/v3/surveys/$survey_id"; then
      echo "deleted survey $survey_id" | tee -a "$cleanup_log"
    else
      echo "failed to delete survey $survey_id" | tee -a "$cleanup_log" >&2
      failed=1
    fi
  done <"$ids_file"

  if api_curl \
    --get \
    --data-urlencode "workspaceId=$FORMBRICKS_WORKSPACE_ID" \
    --data-urlencode "limit=250" \
    --data-urlencode "includeTotalCount=false" \
    --data-urlencode "filter[name][contains]=ENG-3309 $RUN_ID" \
    --output "$verify_response" \
    "$BASE_URL/api/v3/surveys"; then
    if [[ "$(jq '.data | length' "$verify_response")" != "0" ]]; then
      echo "cleanup verification found remaining run-owned surveys" | tee -a "$cleanup_log" >&2
      failed=1
    fi
  else
    echo "unable to verify cleanup" | tee -a "$cleanup_log" >&2
    failed=1
  fi

  if (( failed == 0 )); then
    echo "complete" >"$RUN_DIR/cleanup-status.txt"
  else
    echo "incomplete" >"$RUN_DIR/cleanup-status.txt"
  fi
  return "$failed"
}

case "$ACTION" in
  create) create_fixture ;;
  cleanup) cleanup_fixtures ;;
esac
