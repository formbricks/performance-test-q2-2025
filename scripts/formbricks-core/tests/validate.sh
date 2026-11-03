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
  shellcheck -x \
    "$SUITE_DIR"/*.sh \
    "$SUITE_DIR"/collectors/*.sh \
    "$SUITE_DIR"/lib/*.sh \
    "$SCRIPT_DIR"/*.sh
fi

node --test "$SCRIPT_DIR"/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 "$SCRIPT_DIR/capacity_test.py"
"$SCRIPT_DIR/guardrails.test.sh"

export FORMBRICKS_URL="http://127.0.0.1:18080"
export FORMBRICKS_WORKSPACE_ID="workspace00000000000000001"
export FORMBRICKS_API_KEY="local-test-key"
export FORMBRICKS_SURVEY_ID="survey000000000000000001"
export FORMBRICKS_QUESTION_ID="perf-question"
export RUN_ID="eng3309-inspect"
export CONFIRM_HIGH_IMPACT_PROFILE="I_APPROVE_SHARED_ARTEMIS_LOAD"

TEST_MODE=capacity WORKER_COUNT=4 WORKER_INDEX=0 CAPACITY_COORDINATED=1 \
  PROFILE=load SCENARIO=mixed RATE=5 \
  k6 inspect --include-system-env-vars "$SUITE_DIR/k6/formbricks-core.js" >/dev/null
if TEST_MODE=capacity WORKER_COUNT=4 WORKER_INDEX=0 CAPACITY_COORDINATED=1 \
  PROFILE=load SCENARIO=mixed RATE=6 \
  k6 inspect --include-system-env-vars "$SUITE_DIR/k6/formbricks-core.js" >/dev/null 2>&1; then
  echo "capacity budget guard failed" >&2
  exit 1
fi
if k6 inspect --include-system-env-vars "$SUITE_DIR/k6/policy.js" >/dev/null 2>&1; then
  echo "policy approval guard failed" >&2
  exit 1
fi
CONFIRM_POLICY_TEST=I_APPROVE_ARTEMIS_POLICY_TEST \
  FORMBRICKS_URL=https://artemis.app.formbricks.com \
  k6 inspect --include-system-env-vars "$SUITE_DIR/k6/policy.js" >/dev/null

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

capacity_pids=()
for worker in 0 1 2 3; do
  TEST_MODE=capacity WORKER_COUNT=4 WORKER_INDEX="$worker" CAPACITY_COORDINATED=1 \
    PROFILE=load SCENARIO=mixed RATE=5 RUN_ID="eng3309-local-capacity-w$worker" \
    SUMMARY_JSON="$tmp_dir/capacity-$worker.json" \
    k6 run --out "json=$tmp_dir/capacity-$worker.jsonl" \
      "$SCRIPT_DIR/capacity-local.js" >"$tmp_dir/capacity-$worker.log" 2>&1 &
  capacity_pids+=("$!")
done
capacity_failed=0
for pid in "${capacity_pids[@]}"; do
  wait "$pid" || capacity_failed=1
done
if (( capacity_failed )); then
  for worker in 0 1 2 3; do tail -40 "$tmp_dir/capacity-$worker.log"; done
  exit 1
fi
for worker in 0 1 2 3; do
  jq -e '.result == "PASS"' "$tmp_dir/capacity-$worker.json" >/dev/null
  [[ -s "$tmp_dir/capacity-$worker.jsonl" ]]
done

git -C "$REPO_ROOT" diff --check
printf 'Formbricks core suite validation passed\n'
