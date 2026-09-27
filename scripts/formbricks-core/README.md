# Formbricks core performance suite

Repeatable, human-supervised k6 workloads for the Formbricks web application. The suite is designed for
the isolated Artemis environment and produces a run bundle that can be correlated with SigNoz traces,
logs, metrics, and Kubernetes resource samples.

This is not a production test or a CI gate. A person must approve the target, load profile, and cleanup
result for every run.

## Workloads

| Scenario | Route | Purpose |
| --- | --- | --- |
| `public-read` | `GET /api/v1/client/{workspaceId}/environment` | Public survey configuration and cache/database reads |
| `management-read` | `GET /api/v3/surveys` | Auth, authorization, list query, counts, and serialization |
| `response-write` | `POST /api/v1/client/{workspaceId}/responses` | Validation, response transaction, quota evaluation, and pipeline dispatch |
| `survey-lifecycle` | `POST/GET/DELETE /api/v3/surveys` | Authenticated create/read/delete write path |
| `mixed` | Weighted 70/20/8/2 blend of the above | Representative concurrent traffic |

The response fixture is a dedicated link survey created at run start. Its name and every lifecycle
survey contain the unique run ID. Cleanup deletes the fixture and searches for lifecycle leftovers with
that run ID, including objects left by an interrupted k6 iteration.

## Guardrails

- Use only the designated Artemis workspace and a test-only API key with read-write access to it.
- Start with `smoke`; raise `RATE` one step at a time while watching errors, latency, and pod saturation.
- Stop on sustained 5xx responses, p99 regression, dropped iterations, restarts, OOM events, or cleanup
  failure. Do not work around a guardrail by increasing thresholds during the run.
- Do not target production, shared customer workspaces, or surveys with integrations/webhooks.
- Keep the run bundle. Do not attach API keys, cookies, raw customer data, or unredacted secret output.

## Prerequisites

- `k6` 2.x, or Docker for the pinned fallback image.
- `curl` and `jq` for fixture lifecycle management.
- `kubectl` access to Artemis for resource evidence (optional for local script validation).
- SigNoz MCP configured with the read-only tool allowlist from the GitOps runbook.

Copy the example environment file to a shell-local file outside Git, fill it, then source it:

```bash
cp scripts/formbricks-core/config.example.env /tmp/formbricks-core.env
$EDITOR /tmp/formbricks-core.env
source /tmp/formbricks-core.env
```

Never commit the filled file.

## Run sequence

Run one smoke pass per individual path before mixed traffic:

```bash
cd scripts/formbricks-core
./run-full-suite.sh smoke public-read
./run-full-suite.sh smoke management-read
./run-full-suite.sh smoke response-write
./run-full-suite.sh smoke survey-lifecycle
./run-full-suite.sh smoke mixed
```

Then establish a low-rate baseline and step up to the agreed ceiling:

```bash
RATE=2 DURATION=10m ./run-full-suite.sh baseline mixed
RATE=20 MAX_VUS=100 ./run-full-suite.sh step mixed
RATE=5 DURATION=30m ./run-full-suite.sh soak mixed
```

The `step` profile ramps through 25%, 50%, and 100% of `RATE`. Defaults are p95 under 2 seconds, p99
under 5 seconds, less than 1% failed requests, at least 99% checks, zero dropped iterations, and zero
unexpected statuses. Override latency thresholds only before a run and record why in the report.

## Artifacts

Every run writes `report/runs/<run-id>/`:

| Artifact | Evidence |
| --- | --- |
| `metadata.txt`, `start.txt`, `end.txt` | Target, commit, profile, exact SigNoz time window |
| `k6.log`, `k6-summary.json`, `k6-summary.md` | Throughput, failures, checks, p50/p95/p99/max |
| `fixture*.json`, `cleanup*.txt`, `cleanup.log` | Synthetic object ownership and deletion proof |
| `k8s-metrics.csv`, `final-top.txt`, `k8s-events.txt` | CPU, memory, restarts, OOM/probe events |
| `k8s-describe.txt`, `final-workloads.txt` | Final deployment and pod state |
| `analysis.md` | Structured findings and follow-ups |

The API key is passed through process environment and is never written to these artifacts.

## Analyze with SigNoz MCP

Use the run start/end timestamps, `deployment.environment=artemis`,
`service.namespace=formbricks-artemis`, and the application service name from Artemis. Narrow traces by
the tested HTTP route and, where available, `user_agent.original=formbricks-k6/<run-id>`.

Ask the MCP tools in this order:

1. `signoz_list_services` and `signoz_get_service_top_operations` to confirm service/operation names.
2. `signoz_aggregate_traces` for request count, error rate, p50, p95, and p99 per tested operation.
3. `signoz_search_traces` for the slowest/error traces; inspect representative traces with
   `signoz_get_trace_details` and identify the longest child spans.
4. `signoz_aggregate_logs` and `signoz_search_logs` for errors, timeouts, pool pressure, rate limiting,
   restarts, and run-ID-correlated messages.
5. `signoz_list_metrics`/`signoz_query_metrics` for pod CPU, memory, event-loop/runtime, database pool,
   and request metrics available in the exact window.

Record the exact query/filter and evidence link or trace ID for every conclusion. Distinguish a measured
fact from a hypothesis. A code-level issue needs a trace span or profile/query explaining where time was
spent; a slow top-level request alone is not enough.

## Cleanup recovery

The wrapper always attempts cleanup, including on interruption. If `cleanup-status.txt` says
`incomplete`, keep the same environment and run ID and retry:

```bash
RUN_ID=<run-id> ./fixtures.sh cleanup report/runs/<run-id>
```

Do not delete unrelated surveys. The cleanup search is intentionally constrained to names containing
both `ENG-3309` and the exact run ID.
