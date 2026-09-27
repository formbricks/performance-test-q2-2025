#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SUITE_DIR/../.." && pwd)"

for script in \
  "$SUITE_DIR/fixtures.sh" \
  "$SUITE_DIR/run-full-suite.sh" \
  "$SUITE_DIR/run-k6.sh" \
  "$SUITE_DIR/collectors/health-monitor.sh" \
  "$SUITE_DIR/collectors/k8s-metrics.sh" \
  "$SUITE_DIR/collectors/preflight.sh" \
  "$SUITE_DIR/lib/guardrails.sh" \
  "$SCRIPT_DIR/guardrails.test.sh" \
  "$SCRIPT_DIR/validate.sh"; do
  bash -n "$script"
done

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck \
    "$SUITE_DIR"/*.sh \
    "$SUITE_DIR"/collectors/*.sh \
    "$SUITE_DIR"/lib/*.sh \
    "$SCRIPT_DIR"/*.sh
fi

node --test "$SCRIPT_DIR"/*.test.mjs
"$SCRIPT_DIR/guardrails.test.sh"

export FORMBRICKS_URL="http://127.0.0.1:18080"
export FORMBRICKS_WORKSPACE_ID="workspace00000000000000001"
export FORMBRICKS_API_KEY="local-test-key"
export FORMBRICKS_SURVEY_ID="survey000000000000000001"
export FORMBRICKS_QUESTION_ID="perf-question"
export RUN_ID="eng3309-inspect"
export CONFIRM_HIGH_IMPACT_PROFILE="I_APPROVE_SHARED_ARTEMIS_LOAD"

for profile in smoke baseline load stress spike soak; do
  for scenario in public-read public-survey management-read response-write survey-lifecycle mixed; do
    SCENARIO="$scenario" PROFILE="$profile" \
      k6 inspect --include-system-env-vars "$SUITE_DIR/k6/formbricks-core.js" >/dev/null
  done
done

tmp_dir="$(mktemp -d)"
mock_pid=""
cleanup() {
  if [[ -n "$mock_pid" ]]; then
    kill "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
  rm -r -- "$tmp_dir"
}
trap cleanup EXIT

MOCK_PORT=18080 node "$SCRIPT_DIR/mock-api.mjs" >"$tmp_dir/mock.log" 2>&1 &
mock_pid=$!
for _ in {1..50}; do
  if curl --silent --fail "http://127.0.0.1:18080/health" >/dev/null; then
    break
  fi
  sleep 0.1
done
curl --silent --fail "http://127.0.0.1:18080/health" >/dev/null

unset NAMESPACE
unset CONFIRM_HIGH_IMPACT_PROFILE
export PRE_RUN_SETTLE_SECONDS=0
export HEALTH_INTERVAL=1
for scenario in public-read public-survey management-read response-write survey-lifecycle mixed; do
  export RUN_ID="eng3309-local-${scenario}"
  export RUN_DIR="$tmp_dir/$scenario"
  "$SUITE_DIR/run-full-suite.sh" smoke "$scenario" >/dev/null
  jq -e '.result == "PASS"' "$RUN_DIR/k6-summary.json" >/dev/null
done

git -C "$REPO_ROOT" diff --check
printf 'Formbricks core suite validation passed\n'
