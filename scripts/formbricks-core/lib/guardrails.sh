#!/usr/bin/env bash

# Shared shell guardrails for every Formbricks core k6 entrypoint.

readonly ARTEMIS_URL="https://artemis.app.formbricks.com"
readonly NON_ARTEMIS_CONFIRMATION="I_UNDERSTAND_NON_PRODUCTION_ONLY"
readonly HIGH_IMPACT_CONFIRMATION="I_APPROVE_SHARED_ARTEMIS_LOAD"
readonly ABSOLUTE_MAX_RATE=50
readonly ABSOLUTE_MAX_VUS=200
readonly SAFE_MAX_RATE=10
readonly SAFE_MAX_VUS=100

default_rate_for_profile() {
  case "$1" in
    smoke|baseline) printf '1\n' ;;
    load) printf '5\n' ;;
    stress) printf '20\n' ;;
    spike) printf '30\n' ;;
    soak) printf '3\n' ;;
    *)
      fail_guardrail "unknown profile: $1"
      return 1
      ;;
  esac
}

default_max_vus_for_profile() {
  case "$1" in
    smoke) printf '1\n' ;;
    baseline) printf '20\n' ;;
    load|soak) printf '50\n' ;;
    stress|spike) printf '100\n' ;;
    *)
      fail_guardrail "unknown profile: $1"
      return 1
      ;;
  esac
}

duration_to_seconds() {
  local duration="$1"
  local value unit

  if [[ ! "$duration" =~ ^([1-9][0-9]*)(s|m|h)$ ]]; then
    fail_guardrail "duration must use a positive whole number followed by s, m, or h"
    return 1
  fi

  value="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[2]}"
  case "$unit" in
    s) printf '%s\n' "$value" ;;
    m) printf '%s\n' "$((value * 60))" ;;
    h) printf '%s\n' "$((value * 3600))" ;;
  esac
}

fail_guardrail() {
  printf 'guardrail: %s\n' "$1" >&2
  return 1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

validate_run_id() {
  local run_id="$1"
  if [[ ! "$run_id" =~ ^eng3309-[A-Za-z0-9._-]+$ ]]; then
    fail_guardrail "RUN_ID must start with eng3309- and contain only letters, digits, dot, underscore, or dash"
  fi
}

validate_target() {
  local target="${1%/}"

  case "$target" in
    "$ARTEMIS_URL") return 0 ;;
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://host.docker.internal|http://host.docker.internal:*) return 0 ;;
    https://app.formbricks.com|https://app.formbricks.com:*|https://app.formbricks.com/*|https://api.formbricks.com|https://api.formbricks.com:*|https://api.formbricks.com/*)
      fail_guardrail "production Formbricks targets are always forbidden"
      return 1
      ;;
  esac

  if [[ "$target" != https://* ]]; then
    fail_guardrail "non-local targets must use HTTPS"
    return 1
  fi
  if [[ "${ALLOW_NON_ARTEMIS_TARGET:-}" != "$NON_ARTEMIS_CONFIRMATION" ]]; then
    fail_guardrail "target must be $ARTEMIS_URL (set ALLOW_NON_ARTEMIS_TARGET=$NON_ARTEMIS_CONFIRMATION only for another isolated non-production environment)"
    return 1
  fi
}

validate_load_controls() {
  local profile="$1"
  local rate="${RATE:-}"
  local max_vus="${MAX_VUS:-}"
  local iterations="${ITERATIONS:-}"
  local duration="${DURATION:-}"
  local max_duration="${MAX_DURATION:-}"
  local timeout="${TIMEOUT:-}"
  local duration_seconds
  local duration_ceiling

  default_rate_for_profile "$profile" >/dev/null

  if [[ -n "$rate" ]] && ! is_positive_integer "$rate"; then
    fail_guardrail "RATE must be a positive integer"
    return 1
  fi
  if [[ -n "$max_vus" ]] && ! is_positive_integer "$max_vus"; then
    fail_guardrail "MAX_VUS must be a positive integer"
    return 1
  fi
  if [[ -n "$iterations" ]] && ! is_positive_integer "$iterations"; then
    fail_guardrail "ITERATIONS must be a positive integer"
    return 1
  fi

  rate="${rate:-$(default_rate_for_profile "$profile")}"
  max_vus="${max_vus:-$(default_max_vus_for_profile "$profile")}"
  iterations="${iterations:-1}"

  if (( rate > ABSOLUTE_MAX_RATE )); then
    fail_guardrail "RATE=$rate exceeds the absolute ceiling of $ABSOLUTE_MAX_RATE iterations/s"
    return 1
  fi
  if (( max_vus > ABSOLUTE_MAX_VUS )); then
    fail_guardrail "MAX_VUS=$max_vus exceeds the absolute ceiling of $ABSOLUTE_MAX_VUS"
    return 1
  fi
  if [[ "$profile" == "smoke" ]] && (( iterations > 5 )); then
    fail_guardrail "smoke ITERATIONS=$iterations exceeds the ceiling of 5"
    return 1
  fi

  case "$profile" in
    smoke) duration_ceiling=120 ;;
    baseline) duration_ceiling=600 ;;
    load|stress) duration_ceiling=900 ;;
    spike) duration_ceiling=300 ;;
    soak) duration_ceiling=7200 ;;
  esac

  if [[ -n "$duration" ]]; then
    duration_seconds="$(duration_to_seconds "$duration")" || return 1
    if (( duration_seconds > duration_ceiling )); then
      fail_guardrail "$profile DURATION=$duration exceeds the ${duration_ceiling}s hold-stage ceiling"
      return 1
    fi
  fi
  if [[ -n "$max_duration" ]]; then
    duration_seconds="$(duration_to_seconds "$max_duration")" || return 1
    if [[ "$profile" != "smoke" ]]; then
      fail_guardrail "MAX_DURATION is only valid for smoke"
      return 1
    fi
    if (( duration_seconds > duration_ceiling )); then
      fail_guardrail "smoke MAX_DURATION=$max_duration exceeds the ${duration_ceiling}s ceiling"
      return 1
    fi
  fi
  if [[ -n "$timeout" ]]; then
    duration_seconds="$(duration_to_seconds "$timeout")" || return 1
    if (( duration_seconds > 60 )); then
      fail_guardrail "TIMEOUT=$timeout exceeds the 60s per-request ceiling"
      return 1
    fi
  fi
  if [[ "$profile" == "baseline" || "$profile" == "load" ]]; then
    if (( rate > SAFE_MAX_RATE )); then
      fail_guardrail "$profile RATE=$rate exceeds the shared-environment ceiling of $SAFE_MAX_RATE iterations/s"
      return 1
    fi
    if (( max_vus > SAFE_MAX_VUS )); then
      fail_guardrail "$profile MAX_VUS=$max_vus exceeds the shared-environment ceiling of $SAFE_MAX_VUS"
      return 1
    fi
  fi
  if [[ "$profile" == "stress" || "$profile" == "spike" || "$profile" == "soak" ]]; then
    if [[ "${CONFIRM_HIGH_IMPACT_PROFILE:-}" != "$HIGH_IMPACT_CONFIRMATION" ]]; then
      fail_guardrail "$profile is high-impact; explicit approval is required before execution"
      return 1
    fi
  fi
}

validate_guardrails() {
  local profile="$1"
  : "${FORMBRICKS_URL:?FORMBRICKS_URL is required}"
  : "${RUN_ID:?RUN_ID is required}"
  validate_run_id "$RUN_ID"
  validate_target "$FORMBRICKS_URL"
  validate_load_controls "$profile"
}
