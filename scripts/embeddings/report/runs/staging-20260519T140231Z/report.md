# Hub Embeddings Load Test - Staging Run

## Test Setup

- Date: 2026-05-19
- Cluster: `arn:aws:eks:eu-central-1:715841356175:cluster/core-eks`
- Namespace: `formbricks-stage`
- Test tenant: `load-test-20260519T140231Z`
- Model: `Alibaba-NLP/gte-multilingual-base`
- Embedding dimensions expected: `768`
- TEI image: `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9`
- Hub image: `ghcr.io/formbricks/hub@sha256:6c39b1143527137e881df785a5b668625a1fe3edb05485bb5ded19f813c8de88`
- k6: `v2.0.0`

The source dataset was `/Users/bhagya/Downloads/hub-combined-test-data5k.csv`, prepared into local ignored payload shards before running the test. Payload distribution after preparation: `5000` total, `2630` short, `2360` medium, `10` long.

## Scenarios Run

| Scenario | Profile | Target shape | Result |
|---|---:|---:|---|
| Direct TEI | `latency` | `RATE=1`, `DURATION=2m`, `MAX_VUS=10` | Passed functional checks, saturated latency |
| Hub enrichment | `baseline` | `RATE=1`, `DURATION=5m`, `MAX_VUS=10` | Passed ingest checks |
| Hub enrichment + search | `mid` + `warm` | enrichment `RATE=3`, search `2 rps`, `DURATION=5m` | Enrichment passed, search failed thresholds |

Smoke checks were rerun after fixing `run-k6.sh` without JSON output paths. Post-fix smoke results:

| Smoke scenario | Requests | Failure rate | p50 | p95 | Result |
|---|---:|---:|---:|---:|---|
| Direct TEI | `6` | `0%` | `2186ms` | `2381ms` | Pass |
| Hub enrichment | `5` | `0%` | `136ms` | `350ms` | Pass |
| Hub search | `6` | `0%` | `136ms` | `334ms` | Pass |

The original `smoke-*.log` files from this run captured the pre-fix wrapper failure and are intentionally not included as PR artifacts.

## Raw Results

### Direct TEI

- Summary artifact: `direct-tei-latency/direct-tei.log`
- Requests: `62`
- Failure rate: `0%`
- p50: `19.51s`
- p95: `21.77s`
- Average: `17.57s`
- Dropped iterations: `58`
- Peak TEI CPU: `6169m`
- Peak TEI memory: `3044Mi`

Interpretation: direct TEI calls were functionally correct and returned 768-dimensional embeddings, but the current single CPU TEI pod cannot sustain 1 rps without large queueing/latency.

### Async Hub Enrichment Baseline

- Summary artifact: `enrichment-baseline/enrichment.log`
- Requests: `300`
- Failure rate: `0%`
- Ingest p50: `137ms`
- Ingest p95: `157ms`
- Ingest average: `143ms`
- Completed embeddings at 30s post-run snapshot: `168 / 299`
- Embedding dimensions verified at snapshot: `768`
- Embedding latency p50 for completed rows: `85.3s`
- Embedding latency p95 for completed rows: `159.1s`
- Peak queue depth during sampled window: `146` pending, `6` running
- Peak TEI CPU: `6520m`
- Peak TEI memory: `3043Mi`

Interpretation: Hub ingestion stays fast because enrichment is async, but the CPU TEI backend is the bottleneck and queue drain time grows even at this low baseline.

### Mixed Enrichment + Search

- Enrichment summary artifact: `enrichment-search-mixed/enrichment.log`
- Search summary artifact: `enrichment-search-mixed/search.log`
- Enrichment requests: `901`
- Enrichment failure rate: `0%`
- Enrichment ingest p95: `155ms`
- Search requests: `520`
- Search failure rate: `11.54%`
- Search p50: `139ms`
- Search p95: `33.1s`
- Peak queue depth during sampled window: `932` pending, `7` running
- Peak TEI CPU: `6376m`
- Peak TEI memory: `3054Mi`

Interpretation: synchronous semantic search should not share the same under-provisioned CPU TEI capacity with concurrent enrichment at this profile. It needs lower expected QPS, isolated TEI capacity, more CPU/replicas, or GPU before production use.

## Kubernetes State

Final deployment state after the run:

| Deployment | Ready |
|---|---:|
| `formbricks-hub` | `1/1` |
| `formbricks-hub-worker` | `1/1` |
| `formbricks-hub-embeddings` | `1/1` |

No Hub, worker, or embeddings pod restarts were observed during the test. Earlier Formbricks app pod events in `k8s-events.txt` are unrelated staging scheduling/readiness churn and not specific to Hub embeddings.

## Cleanup

The synthetic test tenant `load-test-20260519T140231Z` was removed after the run. Cleanup deleted queued River jobs for that tenant, waited for running jobs to finish, then deleted the tenant's feedback records so embeddings cascaded through the database foreign key.

Post-cleanup River state for the embeddings queue:

| State | Count |
|---|---:|
| completed | `1` |

## Included Artifacts

- `environment.txt`: run metadata and cluster context.
- `direct-tei-latency/*`: direct TEI logs, k6 summary, queue depth, k8s metrics, k8s events, deployment describe, and SQL verification output.
- `enrichment-baseline/*`: async enrichment logs, k6 summary, queue depth, k8s metrics, k8s events, deployment describe, and SQL verification output.
- `enrichment-search-mixed/*`: mixed enrichment/search logs, k6 summaries, queue depth, k8s metrics, k8s events, deployment describe, and SQL verification output.
- `final-*.txt`: final staging deployment, pod, top, and event snapshots captured before cleanup.

## Verdict

The load-test harness is good enough to use for staging validation. The staging result shows the current single CPU TEI deployment works functionally but is not production-capacity-safe for concurrent enrichment and semantic search. For low-volume async enrichment only, it can ingest safely but will accumulate enrichment lag under sustained load. Before production rollout, validate either lower worker concurrency, more TEI CPU/replicas, separated search/enrichment TEI capacity, or GPU-backed serving.
