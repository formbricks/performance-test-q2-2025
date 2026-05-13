# Hub Embeddings Load Test

Load tests the self-hosted Hub embeddings pipeline: TEI serving
`Alibaba-NLP/gte-multilingual-base` through an OpenAI-compatible
`/v1/embeddings` endpoint, with Hub configured via `EMBEDDING_PROVIDER=openai`
and `hub-worker` draining River jobs against it.

Maps directly to the four test scenarios in the ENG ticket:

| Script | Scenario |
|---|---|
| `k6/direct-tei.js` | 1 — TEI baseline (no Hub in the path) |
| `k6/hub-enrichment.js` | 2 — async enrichment via `POST /v1/feedback-records` + worker |
| `k6/hub-search.js` | 3 — query-embedding path via `POST /v1/feedback-records/search/semantic` |
| `run-cold-start.sh` | 4 — cold start and rollout behavior |

## Run the full test (end-to-end)

The minimal sequence to produce the full result set. Each step is detailed in
the corresponding section below.

```bash
cd scripts/embeddings

# (1) Prepare the dataset (one-time, results in data/payloads/*.json)
node data/augment.js          --input /path/to/hub-feedback.csv
node data/prepare-payloads.js --input /path/to/hub-feedback.csv --out data/payloads

# (2) Point the scripts at the SUT (EKS Hub + TEI + Postgres)
kubectl -n hub port-forward svc/hub-postgres 5432:5432 &
export DATABASE_URL='postgres://reader:...@localhost:5432/hub?sslmode=disable'
export HUB_URL=http://localhost:8080  HUB_API_KEY=...
export TEI_URL=http://localhost:8081/v1  TEI_API_KEY=...
export MODEL=Alibaba-NLP/gte-multilingual-base
export NAMESPACE=hub  POD_SELECTOR='app.kubernetes.io/name=hub'

# (3) Sanity-check the wiring (a few requests each, ~1 min total)
./run-k6.sh direct-tei     smoke
./run-k6.sh hub-enrichment smoke
./run-k6.sh hub-search     smoke

# (4) The four scenarios. Each writes report/runs/<timestamp>/.
PROFILE=sweep                       ./run-full-suite.sh direct-tei          # scenario 1
PROFILE=baseline                    ./run-full-suite.sh enrichment          # scenario 2 — 24/7 volume
PROFILE=mid SEARCH_PROFILE=busy     ./run-full-suite.sh enrichment+search   # scenario 2 + 3 mixed
PROFILE=burst                       ./run-full-suite.sh enrichment          # scenario 2 — burst

# Scenario 4 — cold start (one warm rollout, one cold cache)
NAMESPACE=hub TEI_DEPLOYMENT=hub-embeddings \
  OUT=report/runs/$(date -u +%Y%m%dT%H%M%SZ)/cold-warm.json \
  ./run-cold-start.sh cache-warm

# (5) Fill report/template.md from report/runs/<timestamps>/.
cp report/template.md report/runs/<ts>/report.md
# Then fill in the _TBD_ fields from the artifacts in that run dir.
```

Total wall-clock time at the default profiles: roughly **45–60 minutes** of
scenarios + ~5–10 min for cold-start measurements.

## Layout

```
scripts/embeddings/
  data/
    phrases.js                 static multilingual phrase pool
    augment.js                 rewrites the CSV with multilingual coverage
    prepare-payloads.js        CSV → JSON shards for k6 SharedArray
    queries.json               hand-curated semantic-search queries
    payloads/                  generated; ignored by k6 if rerun
  k6/
    direct-tei.js              scenario 1
    hub-enrichment.js          scenario 2
    hub-search.js              scenario 3
    lib/{payloads,summary}.js  shared helpers
  collectors/
    queue-depth.sh             polls river_job during a run
    k8s-metrics.sh             kubectl top + events
    enrichment-latency.sql     post-run end-to-end latency
    verify-embeddings.sql      post-run 768-dim + model name check
  run-k6.sh                    single-scenario wrapper, prefers local k6
  run-cold-start.sh            TEI restart timing (warm and cold cache)
  run-full-suite.sh            orchestrates collectors + k6 + post-run SQL
  report/
    template.md                copy + fill per run
    runs/<timestamp>/          artifacts dumped here by run-full-suite.sh
```

## Prerequisites

- Node 20+ (for the data scripts).
- `k6` locally, or Docker (`run-k6.sh` falls back to the `grafana/k6` image).
- `kubectl` configured for the cluster running Hub.
- `psql` 14+.
- Read access to the Hub Postgres (or a port-forward — see below).

## Step 1 — augment and prepare the dataset

Supply your own Hub feedback CSV. The repo does not ship one; the file must
be obtained out-of-band (internal share, an existing Hub export, etc.) and
its path passed via `--input`.

**Required CSV format** (semicolon-delimited, double-quote escaping, UTF-8):

```
collected_at;field_id;field_label;field_type;language;response_id;source_id;source_name;source_type;tenant_id;value_boolean;value_date;value_number;value_text
```

Only rows where `field_type=text` and `value_text` is non-empty produce
embedding jobs. Other field types are kept in the CSV (so it round-trips
cleanly) but ignored when building payloads.

The augment script overwrites the input file in place, rewriting ~40% of
eligible rows into German, Spanish, French, and Japanese from a static
phrase pool. The original is backed up to `*.original.csv` next to the input.

```bash
cd scripts/embeddings
node data/augment.js          --input /path/to/hub-feedback.csv
node data/prepare-payloads.js --input /path/to/hub-feedback.csv --out data/payloads
```

After this you should have:

```
data/payloads/all.json     ~5000 payloads
data/payloads/short.json   length < 100 chars
data/payloads/medium.json  length 100..299 chars
data/payloads/long.json    length >= 300 chars
```

**Known gap:** the typical Hub test dataset has very few long-form entries
(max ~1k chars). The long bucket is usually small; results for "near
support-ticket length" inputs should be flagged as limited coverage in the
report if that's true of your CSV too.

## Step 2 — point at the system under test (EKS)

```bash
# Port-forward Postgres for the SQL collectors (read-only credentials are fine).
kubectl -n hub port-forward svc/hub-postgres 5432:5432 &
export DATABASE_URL='postgres://reader:...@localhost:5432/hub?sslmode=disable'

# Point at the Hub / TEI Services. Use port-forward or run k6 from inside the cluster.
export HUB_URL=http://localhost:8080            # or in-cluster URL
export HUB_API_KEY=...
export TEI_URL=http://localhost:8081/v1         # internal hub-embeddings Service
export TEI_API_KEY=...
export MODEL=Alibaba-NLP/gte-multilingual-base

export NAMESPACE=hub
export POD_SELECTOR='app.kubernetes.io/name=hub'
```

## Step 3 — run scenarios

### Smoke (sanity)

```bash
./run-k6.sh direct-tei      smoke
./run-k6.sh hub-enrichment  smoke
./run-k6.sh hub-search      smoke
```

### Full runs (artifacts under `report/runs/<ts>/`)

```bash
# Scenario 1: TEI baseline ramp-up to find saturation.
PROFILE=sweep ./run-full-suite.sh direct-tei

# Scenario 2: baseline 24/7 enrichment.
PROFILE=baseline ./run-full-suite.sh enrichment

# Scenario 2+3: mid-volume enrichment with concurrent search load
# (the realistic mixed load).
PROFILE=mid SEARCH_PROFILE=busy ./run-full-suite.sh enrichment+search

# Scenario 2: burst.
PROFILE=burst ./run-full-suite.sh enrichment
```

### Scenario 4 — cold start

```bash
NAMESPACE=hub TEI_DEPLOYMENT=hub-embeddings \
  OUT=report/runs/$(date -u +%Y%m%dT%H%M%SZ)/cold-warm.json \
  ./run-cold-start.sh cache-warm

# Destructive — wipes the model cache PVC. Confirms when run.
NAMESPACE=hub TEI_DEPLOYMENT=hub-embeddings \
  OUT=report/runs/$(date -u +%Y%m%dT%H%M%SZ)/cold-cold.json \
  ./run-cold-start.sh cache-cold
```

## Step 4 — read the artifacts

Each `run-full-suite.sh` run writes into `report/runs/<timestamp>/`:

```
start.txt                  run start ISO timestamp
end.txt                    run end ISO timestamp
enrichment.json            k6 summary export
enrichment.log             k6 stdout (incl. machine-readable summary block)
search.json / search.log   if applicable
direct-tei.json / log      if applicable
queue-depth.csv            River pending/running/oldest_age per second
k8s-metrics.csv            kubectl top + restart count per pod per 5s
k8s-events.txt             all namespace events at run end (OOM, Evicted, ...)
k8s-describe.txt           kubectl describe pods at run end
enrichment-latency.txt     end-to-end latency p50/p95/p99 (from SQL)
verify-embeddings.txt      768-dim + model name + coverage check
```

## Step 5 — fill the report

`report/template.md` mirrors the ticket's acceptance criteria one-for-one
(setup, workload shape, p50/p95/p99 per scenario, queue depth, CPU/memory,
restarts, cold-start, AWS cost, Helm defaults verdict, follow-ups).

```bash
cp report/template.md report/runs/<timestamp>/report.md
```

Then replace each `_TBD_` field by reading the corresponding artifact in
that run dir. Sources, in order of the template's sections:

| Template section | Source artifact(s) |
|---|---|
| 3. Direct TEI baseline | `direct-tei.json`, `direct-tei.log` |
| 3. Hub enrichment | `enrichment.log`, `enrichment-latency.txt`, `verify-embeddings.txt`, `queue-depth.csv` |
| 3. Search / query embedding | `search.json`, `search.log` |
| 3. Cold start | `cold-warm.json`, `cold-cold.json` |
| 4. Resource usage | `k8s-metrics.csv`, `k8s-events.txt`, `k8s-describe.txt` |
| 6. AWS cost estimate | hand-fill from current pricing snapshot |
| 7. Verdict on Helm defaults | hand-fill from observations in §3–§5 |
| 8. Follow-ups | open Linear tickets and reference IDs here |

Attach the filled `report.md` and the entire `report/runs/<timestamp>/`
directory to the ENG ticket as the deliverable.

## Workload shape used

| Bucket | Approx length | Source |
|---|---|---|
| short | < 100 chars | augmented Hub CSV |
| medium | 100–300 chars | augmented Hub CSV |
| long | ≥ 300 chars | augmented Hub CSV — sparse (~10 rows) |

| Language | Share |
|---|---|
| English | ~60% |
| German | ~10% |
| Spanish | ~10% |
| French | ~10% |
| Japanese | ~10% |

| Profile | Driver | Shape |
|---|---|---|
| `baseline` | enrichment | 1 req/s for 10m |
| `mid` | enrichment | 10 req/s for 15m |
| `burst` | enrichment | ramp 1 → 100 → 5 over ~10m |
| `latency` | direct-tei | 2 req/s for 2m |
| `sweep` | direct-tei | ramp 1 → 60 req/s over ~5m |
| `warm` | search | 2 req/s for 5m |
| `busy` | search | 5 req/s for 15m (run alongside `mid` enrichment) |

Override per run with `RATE=`, `DURATION=`, `MAX_VUS=`. Record the exact
numbers you used in the report so the run is reproducible.

## What the Helm defaults look like (ENG-849)

For context when interpreting results:

| Component | Default |
|---|---|
| TEI image | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9` |
| TEI args | `--dtype float16` |
| TEI resources | req 4 CPU / 8Gi mem · lim 8Gi mem |
| TEI replicas | 1 |
| TEI cache PVC | 10Gi RWO at `/data` |
| Worker replicas | 1 |
| Worker resources | req 100m / 256Mi · lim 500m / 512Mi |
| `EMBEDDING_MAX_CONCURRENT` | 5 |
| HPA | disabled (min 1, max 2, CPU 70% if enabled) |

The result document should explicitly say whether these defaults are
acceptable for low-to-mid volume production, or which ones need adjustment.
