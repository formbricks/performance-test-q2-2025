# Hub Embeddings Load Test — Results

> Copy this file to `report/runs/<timestamp>/report.md` and fill in. Mirrors
> the acceptance criteria in the ENG ticket. Anything marked _TBD_ must be
> filled before the report is considered complete.

## 1. Test setup

- **Date** (UTC): _TBD_
- **Cluster**: _TBD_ (region, instance types, node count, k8s version)
- **Hub chart version**: _TBD_ (commit / chart appVersion)
- **TEI image**: `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9`
- **Embedding model**: `Alibaba-NLP/gte-multilingual-base` (768 dims)
- **Helm values diff from defaults**: _TBD_ (paste full values used)
- **Pod resources at test time**:
  - TEI: requests/limits _TBD_
  - hub-worker: requests/limits _TBD_, `EMBEDDING_MAX_CONCURRENT=_TBD_`
  - hub-api: requests/limits _TBD_, replicas _TBD_

## 2. Workload shape

Dataset: 5000 rows from the augmented Hub test CSV.

- Language mix: en ~60%, de ~10%, es ~10%, fr ~10%, ja ~10%
- Length distribution (post-augmentation): short _N_, medium _N_, long _N_
- Coverage gap: the source dataset has very few long-form entries (~10
  rows). Long-text behavior is therefore under-sampled.

Profiles run (exact numbers — fill from your run):

| Profile | Driver | Rate | Duration | Notes |
|---|---|---|---|---|
| baseline | enrichment | _TBD_ req/s | _TBD_ | 24/7-volume proxy |
| mid | enrichment | _TBD_ req/s | _TBD_ | sustained background |
| burst | enrichment | ramp _TBD_ → _TBD_ | _TBD_ | backfill spike |
| sweep | direct-tei | ramp _TBD_ → _TBD_ | _TBD_ | TEI saturation |
| warm | search | _TBD_ req/s | _TBD_ | TEI idle |
| busy | search | _TBD_ req/s | _TBD_ | run concurrent with `mid` |

## 3. Raw results

### Scenario 1 — Direct TEI baseline

| Length | p50 (ms) | p95 (ms) | p99 (ms) | RPS | Error rate |
|---|---|---|---|---|---|
| short | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| medium | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| long | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

Saturation point (where error rate or p95 crosses _TBD_): **_TBD_ req/s**.

### Scenario 2 — Hub enrichment (async)

| Metric | baseline | mid | burst |
|---|---|---|---|
| Ingest p50 (ms) | _TBD_ | _TBD_ | _TBD_ |
| Ingest p95 (ms) | _TBD_ | _TBD_ | _TBD_ |
| Ingest p99 (ms) | _TBD_ | _TBD_ | _TBD_ |
| End-to-end embedding p50 (s) | _TBD_ | _TBD_ | _TBD_ |
| End-to-end embedding p95 (s) | _TBD_ | _TBD_ | _TBD_ |
| End-to-end embedding p99 (s) | _TBD_ | _TBD_ | _TBD_ |
| Max queue depth | _TBD_ | _TBD_ | _TBD_ |
| Queue drain time after load stop | _TBD_ | _TBD_ | _TBD_ |
| Retries | _TBD_ | _TBD_ | _TBD_ |
| Failures (discarded) | _TBD_ | _TBD_ | _TBD_ |

Verification: `embeddings.model = _TBD_`, dimension = **_TBD_** (must be 768).
Coverage (eligible records embedded): **_TBD_ %**.

### Scenario 3 — Search / query embedding

| State | p50 (ms) | p95 (ms) | p99 (ms) | Error rate |
|---|---|---|---|---|
| TEI warm, idle | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| TEI warm, busy (concurrent enrichment) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| TEI cold (right after rollout) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### Scenario 4 — Cold start

| Mode | Time to Ready | First-request p50 (ms) |
|---|---|---|
| cache-warm restart | _TBD_ s | _TBD_ |
| cache-cold first start | _TBD_ s | _TBD_ |

Rolling restart of `hub-worker` while load is running: queue grew by _TBD_
during the restart and drained in _TBD_ after pods were Ready.

Behavior when TEI is unavailable (manual scale to 0 for _TBD_ s during a
`baseline` run): worker retried _TBD_ jobs, _TBD_ were discarded after
`EMBEDDING_MAX_ATTEMPTS=3`.

## 4. Resource usage

Captured from `queue-depth.csv` and `k8s-metrics.csv`. Reproduce the peak
numbers here:

| Pod | Peak CPU (m) | Peak memory (MiB) | Restarts | OOMs | Throttle events |
|---|---|---|---|---|---|
| tei | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| hub-api | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| hub-worker | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| postgres | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

Pod restarts / readiness flaps / liveness failures during the run: _TBD_
(paste from `k8s-events.txt`).

## 5. Bottlenecks observed

_TBD_ — fill from the data above. Examples of what to look for:

- TEI CPU pegged at the request value before throughput peaks → CPU is the
  ceiling, increase CPU request OR scale to 2 replicas.
- Worker latency dominated by waiting on TEI → increase `EMBEDDING_MAX_CONCURRENT`
  or worker replicas.
- Queue depth grows unbounded under `mid` load → embedding throughput < ingest
  rate; ingest is fine but enrichment lag accumulates.
- Search p95 spikes when concurrent enrichment is active → TEI is the shared
  bottleneck; consider a separate TEI replica for search, or rate-limiting
  workers when search QPS is high.
- Postgres CPU climbs on search → vector index missing or `min_score` too low
  pulling too many rows.

## 6. AWS cost estimate (eu-central-1, 24/7)

| Component | Instance / size | Quantity | Monthly USD |
|---|---|---|---|
| EKS control plane | — | 1 | _TBD_ |
| Node group for Hub | _TBD_ | _TBD_ | _TBD_ |
| EBS for TEI cache (10Gi gp3) | gp3 | 1 | _TBD_ |
| RDS Postgres (or EBS) | _TBD_ | 1 | _TBD_ |
| ALB / data transfer | — | — | _TBD_ |
| **Total** | | | **_TBD_** |

Method: _TBD_ (pricing snapshot from `pricing.aws` on _TBD_, formulas used).

## 7. Verdict on Helm defaults

Stated explicitly per acceptance criterion:

- TEI default resources (4 CPU / 8Gi mem, 1 replica): **acceptable / needs change**
- Worker default resources (100m–500m / 256–512Mi, 1 replica): **acceptable / needs change**
- `EMBEDDING_MAX_CONCURRENT=5`: **acceptable / needs change**
- HPA off by default: **acceptable / needs change**

Recommended minimum production Helm values for low-to-mid volume:

```yaml
embeddings:
  enabled: true
  replicaCount: _TBD_
  resources:
    requests:
      cpu: "_TBD_"
      memory: _TBD_
    limits:
      memory: _TBD_
  autoscaling:
    enabled: _TBD_
    minReplicas: _TBD_
    maxReplicas: _TBD_
  persistence:
    size: _TBD_

worker:
  replicaCount: _TBD_
  resources:
    requests:
      cpu: _TBD_
      memory: _TBD_
    limits:
      cpu: _TBD_
      memory: _TBD_

# Hub embedding tuning (env on api + worker)
config:
  EMBEDDING_MAX_CONCURRENT: "_TBD_"
```

## 8. Follow-ups

(Captured as separate Linear tickets; reference IDs here once filed.)

- _TBD_ — chart change for _TBD_
- _TBD_ — observability gap: _TBD_
- _TBD_ — production blocker: _TBD_

## 9. Reproducibility

To rerun this exact configuration:

```bash
# 1. Augment + prepare dataset (one-time)
cd scripts/embeddings
node data/augment.js --input ~/Downloads/hub-combined-test-data5k.csv
node data/prepare-payloads.js --input ~/Downloads/hub-combined-test-data5k.csv --out data/payloads

# 2. Point at SUT
export HUB_URL=_TBD_ HUB_API_KEY=_TBD_
export TEI_URL=_TBD_ TEI_API_KEY=_TBD_ MODEL=Alibaba-NLP/gte-multilingual-base
export DATABASE_URL=_TBD_
export NAMESPACE=_TBD_ POD_SELECTOR=_TBD_

# 3. Repro the profiles used in this report
PROFILE=sweep ./run-full-suite.sh direct-tei
PROFILE=baseline ./run-full-suite.sh enrichment
PROFILE=mid SEARCH_PROFILE=busy ./run-full-suite.sh enrichment+search
PROFILE=burst ./run-full-suite.sh enrichment
NAMESPACE=$NAMESPACE TEI_DEPLOYMENT=_TBD_ OUT=report/runs/_TBD_/cold-warm.json ./run-cold-start.sh cache-warm
```
