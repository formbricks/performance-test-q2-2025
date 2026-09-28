#!/usr/bin/env bash

set -euo pipefail

PROFILE="${1:-smoke}"
BASE_URL="${FORMBRICKS_URL:?FORMBRICKS_URL is required}"
BASE_URL="${BASE_URL%/}"
APP_DEPLOYMENT="${APP_DEPLOYMENT:-formbricks}"
POD_SELECTOR="${POD_SELECTOR:-app.kubernetes.io/instance=formbricks-artemis,app.kubernetes.io/component=formbricks}"
MAX_HEALTH_SECONDS="${MAX_HEALTH_SECONDS:-5}"
MAX_HPA_MEMORY_UTILIZATION="${MAX_HPA_MEMORY_UTILIZATION:-85}"
KUBECTL_REQUEST_TIMEOUT="${KUBECTL_REQUEST_TIMEOUT:-10s}"
LIMITED_HPA_CONFIRMATION="I_ACCEPT_NO_AUTOSCALING_HEADROOM"

case "$PROFILE" in
  smoke|baseline|load|stress|spike|soak) ;;
  *) printf 'preflight: unknown profile: %s\n' "$PROFILE" >&2; exit 1 ;;
esac

for command_name in curl jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'preflight: %s is required\n' "$command_name" >&2
    exit 1
  fi
done

temp_dir="$(mktemp -d)"
cleanup() {
  rm -r -- "$temp_dir"
}
trap cleanup EXIT

health_body="$temp_dir/health.json"
read -r health_status health_seconds < <(
  curl --silent --show-error --connect-timeout 5 --max-time "$MAX_HEALTH_SECONDS" \
    --output "$health_body" --write-out '%{http_code} %{time_total}\n' "$BASE_URL/api/v2/health"
)

main_database="$(jq -r '.data.main_database // false' "$health_body")"
cache_database="$(jq -r '.data.cache_database // false' "$health_body")"
printf '%s api_health status=%s seconds=%s main_database=%s cache_database=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$health_status" "$health_seconds" "$main_database" "$cache_database"

if [[ "$health_status" != "200" || "$main_database" != "true" || "$cache_database" != "true" ]]; then
  printf 'preflight: application health check failed\n' >&2
  exit 1
fi
if awk -v observed="$health_seconds" -v ceiling="$MAX_HEALTH_SECONDS" 'BEGIN { exit !(observed > ceiling) }'; then
  printf 'preflight: health endpoint exceeded %ss\n' "$MAX_HEALTH_SECONDS" >&2
  exit 1
fi

if [[ -z "${NAMESPACE:-}" ]]; then
  printf '%s kubernetes skipped reason=NAMESPACE_unset\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi
if ! command -v kubectl >/dev/null 2>&1; then
  printf 'preflight: kubectl is required when NAMESPACE is set\n' >&2
  exit 1
fi

kubectl_args=()
if [[ -n "${KUBECTL_CONTEXT:-}" ]]; then
  kubectl_args+=(--context "$KUBECTL_CONTEXT")
fi
kubectl_args+=(--request-timeout "$KUBECTL_REQUEST_TIMEOUT")

deployment_json="$temp_dir/deployment.json"
pods_json="$temp_dir/pods.json"
hpa_json="$temp_dir/hpa.json"

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" get deployment "$APP_DEPLOYMENT" -o json >"$deployment_json"
kubectl "${kubectl_args[@]}" -n "$NAMESPACE" get pods -l "$POD_SELECTOR" -o json >"$pods_json"

desired_replicas="$(jq -r '.spec.replicas // 0' "$deployment_json")"
ready_replicas="$(jq -r '.status.readyReplicas // 0' "$deployment_json")"
available_replicas="$(jq -r '.status.availableReplicas // 0' "$deployment_json")"
pod_count="$(jq -r '.items | length' "$pods_json")"
unready_pods="$(jq -r '[.items[] | select(any(.status.containerStatuses[]?; .ready != true))] | length' "$pods_json")"
restart_count="$(jq -r '[.items[].status.containerStatuses[]?.restartCount] | add // 0' "$pods_json")"
printf '%s kubernetes deployment=%s desired=%s ready=%s available=%s pods=%s unready=%s restarts=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP_DEPLOYMENT" "$desired_replicas" "$ready_replicas" \
  "$available_replicas" "$pod_count" "$unready_pods" "$restart_count"

if (( desired_replicas < 1 || ready_replicas != desired_replicas || available_replicas != desired_replicas )); then
  printf 'preflight: application deployment is not fully available\n' >&2
  exit 1
fi
if (( pod_count != desired_replicas || unready_pods != 0 || restart_count != 0 )); then
  printf 'preflight: application pods are unready or have restarted\n' >&2
  exit 1
fi

if kubectl "${kubectl_args[@]}" -n "$NAMESPACE" get hpa "$APP_DEPLOYMENT" -o json >"$hpa_json" 2>/dev/null; then
  current_replicas="$(jq -r '.status.currentReplicas // 0' "$hpa_json")"
  max_replicas="$(jq -r '.spec.maxReplicas // 0' "$hpa_json")"
  memory_utilization="$(jq -r '[.status.currentMetrics[]? | select(.type == "Resource" and .resource.name == "memory") | .resource.current.averageUtilization][0] // 0' "$hpa_json")"
  scaling_limited="$(jq -r 'any(.status.conditions[]?; .type == "ScalingLimited" and .status == "True")' "$hpa_json")"
  printf '%s hpa current=%s max=%s memory_utilization=%s scaling_limited=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$current_replicas" "$max_replicas" "$memory_utilization" "$scaling_limited"

  if (( memory_utilization >= MAX_HPA_MEMORY_UTILIZATION )); then
    printf 'preflight: HPA memory utilization reached the %s%% abort ceiling\n' \
      "$MAX_HPA_MEMORY_UTILIZATION" >&2
    exit 1
  fi
  if [[ "$scaling_limited" == "true" && "$current_replicas" == "$max_replicas" ]]; then
    if [[ "$PROFILE" == "smoke" ]]; then
      printf 'preflight: warning: HPA is at maximum replicas; smoke only\n' >&2
    elif [[ "${CONFIRM_LIMITED_HPA_CAPACITY:-}" != "$LIMITED_HPA_CONFIRMATION" ]]; then
      printf 'preflight: HPA has no scaling headroom; refusing %s without explicit capacity approval\n' \
        "$PROFILE" >&2
      exit 1
    fi
  fi
fi
