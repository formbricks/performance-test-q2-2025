#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDRAILS="$SCRIPT_DIR/../lib/guardrails.sh"

run_guardrail() {
  # The child shell intentionally expands its positional parameters.
  # shellcheck disable=SC2016
  env -i PATH="$PATH" \
    FORMBRICKS_URL="$1" \
    RUN_ID="$2" \
    RATE="$3" \
    MAX_VUS="$4" \
    DURATION="${8:-}" \
    ALLOW_NON_ARTEMIS_TARGET="${5:-}" \
    CONFIRM_HIGH_IMPACT_PROFILE="${6:-}" \
    bash -c 'set -euo pipefail; source "$1"; validate_guardrails "$2"' _ "$GUARDRAILS" "$7"
}

expect_pass() {
  if ! "$@" >/dev/null 2>&1; then
    printf 'expected guardrail pass: %q ' "$@" >&2
    printf '\n' >&2
    exit 1
  fi
}

expect_fail() {
  if "$@" >/dev/null 2>&1; then
    printf 'expected guardrail failure: %q ' "$@" >&2
    printf '\n' >&2
    exit 1
  fi
}

expect_pass run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 1 10 "" "" baseline
expect_pass run_guardrail "http://127.0.0.1:18080" "eng3309-test" 1 10 "" "" smoke
expect_fail run_guardrail "https://app.formbricks.com" "eng3309-test" 1 10 \
  "I_UNDERSTAND_NON_PRODUCTION_ONLY" "" baseline
expect_fail run_guardrail "https://app.formbricks.com/api" "eng3309-test" 1 10 \
  "I_UNDERSTAND_NON_PRODUCTION_ONLY" "" baseline
expect_fail run_guardrail "https://other.example.com" "eng3309-test" 1 10 "" "" baseline
expect_fail run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 11 100 "" "" load
expect_fail run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 20 100 "" "" stress
expect_pass run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 20 100 "" \
  "I_APPROVE_SHARED_ARTEMIS_LOAD" stress
expect_fail run_guardrail "https://artemis.app.formbricks.com" "bad-run-id" 1 10 "" "" smoke
expect_pass run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 1 20 "" "" baseline 10m
expect_fail run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 1 20 "" "" baseline 11m
expect_fail run_guardrail "https://artemis.app.formbricks.com" "eng3309-test" 1 20 "" "" baseline forever

printf 'guardrail tests passed\n'
