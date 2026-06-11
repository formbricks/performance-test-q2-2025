#!/usr/bin/env bash
# Measure TEI cold-start and rolling-restart behavior.
#
# Two modes:
#   cache-cold : delete the model cache PVC contents (so the model re-downloads
#                from Hugging Face), restart TEI, wait for ready, record time.
#   cache-warm : just `kubectl rollout restart`, PVC keeps cached weights.
#
# Optionally fires a single embedding probe via run-k6.sh once the pod is
# Ready, to capture first-request latency in addition to "ready" wall time.
#
# Usage:
#   NAMESPACE=hub \
#   TEI_DEPLOYMENT=hub-embeddings \
#   TEI_URL=http://hub-embeddings:8080/v1 TEI_API_KEY=... MODEL=Alibaba-NLP/gte-multilingual-base \
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
: "${TEI_DEPLOYMENT:?TEI_DEPLOYMENT is required}"
: "${OUT:?OUT path is required}"
: "${TEI_URL:?TEI_URL is required for the probe}"

PVC="${PVC:-$TEI_DEPLOYMENT}"
POD_SELECTOR="${POD_SELECTOR:-app.kubernetes.io/name=$TEI_DEPLOYMENT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
original_replicas="$(kubectl -n "$NAMESPACE" get deployment "$TEI_DEPLOYMENT" -o jsonpath='{.spec.replicas}')"
original_replicas="${original_replicas:-1}"
restore_replicas=false

restore_original_replicas() {
  if [[ "$restore_replicas" == "true" ]]; then
    kubectl -n "$NAMESPACE" scale deployment "$TEI_DEPLOYMENT" --replicas="$original_replicas" >/dev/null 2>&1 || true
  fi
}
trap restore_original_replicas EXIT

mkdir -p "$(dirname "$OUT")"

ts_start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ts_start=$(date +%s)

if [[ "$MODE" == "cache-cold" ]]; then
  echo "WARNING: cache-cold mode will delete the TEI model cache PVC ${PVC}."
  echo "         The model will need to re-download from Hugging Face."
  echo "         This is destructive and slow (minutes). Continue? [type 'yes']"
  read -r answer
  [[ "$answer" == "yes" ]] || { echo "aborted"; exit 1; }
  # Scale to zero so the volume can be safely emptied.
  restore_replicas=true
  kubectl -n "$NAMESPACE" scale deployment "$TEI_DEPLOYMENT" --replicas=0
  kubectl -n "$NAMESPACE" wait --for=delete pod -l "$POD_SELECTOR" --timeout=180s || true
  # Empty the PVC by binding it to a throwaway pod.
  kubectl -n "$NAMESPACE" run pvc-wiper --image=busybox --restart=Never --rm -i \
    --overrides="$(cat <<JSON
{ "spec": { "volumes":[{"name":"cache","persistentVolumeClaim":{"claimName":"$PVC"}}],
            "containers":[{"name":"wiper","image":"busybox","command":["sh","-c","rm -rf /data/* /data/.[!.]* 2>/dev/null; ls -la /data"],
                           "volumeMounts":[{"name":"cache","mountPath":"/data"}]}] } }
JSON
)" -- sh
  kubectl -n "$NAMESPACE" scale deployment "$TEI_DEPLOYMENT" --replicas="$original_replicas"
else
  kubectl -n "$NAMESPACE" rollout restart deployment "$TEI_DEPLOYMENT"
fi

echo "waiting for deployment $TEI_DEPLOYMENT to become Ready..."
kubectl -n "$NAMESPACE" rollout status deployment "$TEI_DEPLOYMENT" --timeout=15m
restore_replicas=false

ts_ready=$(date +%s)
ready_seconds=$(( ts_ready - ts_start ))
echo "deployment ready after ${ready_seconds}s"

# First-request probe through the cold pod.
probe_json="$(dirname "$OUT")/cold-start-probe.json"
TEI_URL="$TEI_URL" \
  TEI_API_KEY="${TEI_API_KEY:-}" \
  MODEL="${MODEL:-Alibaba-NLP/gte-multilingual-base}" \
  "$SCRIPT_DIR/run-k6.sh" direct-tei smoke "$probe_json" || true

ts_done=$(date +%s)

cat >"$OUT" <<JSON
{
  "mode": "$MODE",
  "namespace": "$NAMESPACE",
  "deployment": "$TEI_DEPLOYMENT",
  "started_at": "$ts_start_iso",
  "ready_seconds": $ready_seconds,
  "probe_total_seconds": $(( ts_done - ts_start )),
  "probe_summary": "$probe_json"
}
JSON

echo "wrote $OUT"
