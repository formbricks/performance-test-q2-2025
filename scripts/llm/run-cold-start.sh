#!/usr/bin/env bash
# Measure vLLM cold-start and rollout-restart behavior.
#
# Two modes:
#   cache-warm : `kubectl rollout restart` — model weights stay on disk (PVC).
#                Captures how fast the runtime can come back when the image is
#                cached and the weights are local.
#   cache-cold : scale to 0, wipe the model cache PVC, scale back up. The
#                model has to re-download from the configured weights source
#                (Hugging Face, S3, GCS) on first start. Captures the
#                worst-case rollout window.
#
# Both modes:
#   1. Record start time.
#   2. Trigger the restart.
#   3. Wait for the deployment to become Ready (rollout status, 15m timeout).
#   4. Fire a single chat-completion probe to the cold pod (smoke profile).
#   5. Write a JSON summary alongside the probe artifact.
#
# Usage:
#   NAMESPACE=formbricks-stage \
#   VLLM_DEPLOYMENT=vllm \
#   LLM_URL=http://localhost:8000/v1 LLM_API_KEY=... MODEL=Qwen/Qwen2.5-7B-Instruct \
#   OUT=report/runs/<ts>/cold-start.json \
#   ./run-cold-start.sh cache-warm

set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  cache-warm|cache-cold) ;;
  *)
    echo "usage: ./run-cold-start.sh <cache-warm|cache-cold>" >&2
    exit 1
    ;;
esac

: "${NAMESPACE:?NAMESPACE is required}"
: "${VLLM_DEPLOYMENT:?VLLM_DEPLOYMENT is required}"
: "${OUT:?OUT path is required}"
: "${LLM_URL:?LLM_URL is required for the probe}"
: "${MODEL:?MODEL is required for the probe}"

PVC="${PVC:-$VLLM_DEPLOYMENT}"
POD_SELECTOR="${POD_SELECTOR:-app.kubernetes.io/name=$VLLM_DEPLOYMENT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$(dirname "$OUT")"

original_replicas="$(kubectl -n "$NAMESPACE" get deployment "$VLLM_DEPLOYMENT" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
original_replicas="${original_replicas:-1}"
restore_replicas=false
restore_on_exit() {
  if [[ "$restore_replicas" == "true" ]]; then
    kubectl -n "$NAMESPACE" scale deployment "$VLLM_DEPLOYMENT" --replicas="$original_replicas" >/dev/null 2>&1 || true
  fi
}
trap restore_on_exit EXIT

ts_start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ts_start=$(date +%s)

if [[ "$MODE" == "cache-cold" ]]; then
  echo "WARNING: cache-cold mode will scale $VLLM_DEPLOYMENT to 0 and delete"
  echo "         the contents of PVC ${PVC}. The model weights will need to"
  echo "         re-download from the configured source on first start."
  echo "         This is destructive and slow (often >10 minutes). Continue? [type 'yes']"
  read -r answer
  [[ "$answer" == "yes" ]] || { echo "aborted"; exit 1; }
  restore_replicas=true
  kubectl -n "$NAMESPACE" scale deployment "$VLLM_DEPLOYMENT" --replicas=0
  kubectl -n "$NAMESPACE" wait --for=delete pod -l "$POD_SELECTOR" --timeout=300s || true
  kubectl -n "$NAMESPACE" run pvc-wiper-llm --image=busybox --restart=Never --rm -i \
    --overrides="$(cat <<JSON
{ "spec": { "volumes":[{"name":"cache","persistentVolumeClaim":{"claimName":"$PVC"}}],
            "containers":[{"name":"wiper","image":"busybox","command":["sh","-c","rm -rf /data/* /data/.[!.]* 2>/dev/null; ls -la /data"],
                           "volumeMounts":[{"name":"cache","mountPath":"/data"}]}] } }
JSON
)" -- sh
  kubectl -n "$NAMESPACE" scale deployment "$VLLM_DEPLOYMENT" --replicas="$original_replicas"
else
  kubectl -n "$NAMESPACE" rollout restart deployment "$VLLM_DEPLOYMENT"
fi

echo "waiting for deployment $VLLM_DEPLOYMENT to become Ready (timeout 15m)..."
kubectl -n "$NAMESPACE" rollout status deployment "$VLLM_DEPLOYMENT" --timeout=15m
restore_replicas=false

ts_ready=$(date +%s)
ready_seconds=$(( ts_ready - ts_start ))
echo "deployment ready after ${ready_seconds}s"

probe_json="$(dirname "$OUT")/cold-start-probe.json"
LLM_URL="$LLM_URL" LLM_API_KEY="${LLM_API_KEY:-}" MODEL="$MODEL" \
  "$SCRIPT_DIR/run-k6.sh" llm-direct-translation smoke "$probe_json" || true

ts_done=$(date +%s)

cat >"$OUT" <<JSON
{
  "mode": "$MODE",
  "namespace": "$NAMESPACE",
  "deployment": "$VLLM_DEPLOYMENT",
  "started_at": "$ts_start_iso",
  "ready_seconds": $ready_seconds,
  "probe_total_seconds": $(( ts_done - ts_start )),
  "probe_summary": "$probe_json"
}
JSON

echo "wrote $OUT"
