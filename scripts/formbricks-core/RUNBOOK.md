# Artemis performance runbook

## Scope and ownership

Use this suite only against `https://artemis.app.formbricks.com` and an isolated performance-testing
workspace. The API key must be test-only, limited to that workspace, and supplied through the process
environment. Do not paste it into commands, artifacts, issues, logs, or Git history.

The test operator owns target confirmation, preflight, telemetry observation, abort decisions, fixture
cleanup, and the final evidence report. Never schedule a shared-Artemis load profile unattended.

## Prerequisites

- `k6` 2.x, or Docker for the pinned fallback image.
- `curl` and `jq` for fixture management.
- `kubectl --context core-eks` access for capacity and resource evidence.
- A dedicated Artemis workspace with no customer data, integrations, webhooks, quotas, or automation.
- A read-write API key scoped to that workspace.
- Authenticated, read-only SigNoz MCP tools.

Copy `config.example.env` to a private file outside the repository, fill it, source it, then confirm only
presence—not values—of the required variables. `FORMBRICKS_API_KEY` and cookies are secrets.

## Preflight

1. Confirm the suite commit and a clean checkout.
2. Verify `GET /api/v2/health` is HTTP 200 with healthy database/cache status and record latency.
3. Confirm Argo reports `formbricks-artemis` Synced and Healthy.
4. Record ready/desired replicas, HPA current/target, requests/limits, the restart baseline, recent
   warning events, and `kubectl top` for application pods.
5. With SigNoz, confirm `formbricks-artemis` has recent trace activity, then record its top operations
   and a pre-run error/latency window.
6. Stop before load if pods are unready, restarting, OOMing, probe-failing, at a hard resource limit,
   or if the application/HPA is already degraded.

Artemis currently has a 2–3 replica application HPA. Three replicas removes autoscaling headroom. The
wrapper allows smoke but refuses baseline/load while the HPA is scaling-limited at maximum replicas.
Do not set `CONFIRM_LIMITED_HPA_CAPACITY=I_ACCEPT_NO_AUTOSCALING_HEADROOM` unless the user has approved
that exact exception and an operator is actively watching absolute memory against the container limit.

## Execution tiers

Every rate below is k6 iterations/s. Mixed traffic averages roughly 1.64 HTTP requests per iteration.

| Tier | Command | Approximate mixed HTTP rate | Expected impact |
| --- | --- | ---: | --- |
| Smoke | `./run-full-suite.sh smoke <scenario>` | one bounded iteration | Contract/cleanup only |
| Baseline | `RATE=1 DURATION=2m ./run-full-suite.sh baseline mixed` | ~1.64 req/s | Low, ~120 iterations |
| Load | `RATE=5 DURATION=3m ./run-full-suite.sh load mixed` | up to ~8.2 req/s | Moderate, ramp + hold |
| Stress | `RATE=20 DURATION=2m ./run-full-suite.sh stress mixed` | up to ~32.8 req/s | High; approval required |
| Spike | `RATE=30 DURATION=1m ./run-full-suite.sh spike mixed` | up to ~49.2 req/s | High burst; approval required |
| Soak | `RATE=3 DURATION=30m ./run-full-suite.sh soak mixed` | ~4.92 req/s | High cumulative writes; approval required |

Stress, spike, and soak require both explicit user approval for the exact traffic/window and
`CONFIRM_HIGH_IMPACT_PROFILE=I_APPROVE_SHARED_ARTEMIS_LOAD`. Their static validation does not require
this approval; execution does.

Run all six scenarios at smoke first. Inspect each run's summary, cleanup status, application health,
pod restarts/events, and SigNoz errors before continuing. On shared Artemis, run the 1 iter/s baseline
before considering a higher bounded load.

## Abort and rollback

k6 aborts on severe HTTP failures, unexpected statuses, or dropped work. The operator must also stop
immediately for sustained 5xx/429 responses, p99 deterioration, availability changes, new restarts,
OOM/probe events, database/cache/downstream errors, or unexpected side effects.

Press Ctrl-C once and let the wrapper stop collection and run cleanup. Do not change Artemis
configuration, scale workloads, flush caches, delete shared data, or loosen thresholds to make the run
pass. If cleanup is incomplete, retry only the exact run-owned cleanup:

```bash
RUN_ID=<run-id> ./fixtures.sh cleanup report/runs/<run-id>
```

The cleanup implementation verifies fixture ownership and exact `ENG-3309 <run-id> ` name prefixes,
then re-lists the run scope. Escalate an incomplete result; never broaden the deletion filter.

## SigNoz correlation

Use the exact `start.txt` and `end.txt` UTC values converted programmatically to Unix milliseconds.
Start with `service.name=formbricks-artemis`; use resource attributes
`deployment.environment=artemis` and `service.namespace=formbricks-artemis` only after confirming the
keys exist. Correlate tested operations by route/span name and, when captured, by
`user_agent.original=formbricks-k6/<run-id>` or the run ID header.

1. `signoz_list_services`: confirm the service and pre/post call, error, and p99 context.
2. `signoz_get_service_top_operations`: rank operations in the exact window.
3. `signoz_aggregate_traces`: count, error rate, p50, p90, p95, and p99 for each tested operation.
4. `signoz_search_traces`: find slow/error samples; inspect representative trace trees with
   `signoz_get_trace_details` and identify the dominant child span.
5. `signoz_aggregate_logs`/`signoz_search_logs`: check errors, timeouts, connection pools, rate limits,
   restarts, and run-ID messages without copying sensitive bodies.
6. Query only discovered, relevant metrics. Use Kubernetes artifacts when SigNoz metrics are missing.

Deployed SigNoz v0.89.0 compatibility is partial: do not use `signoz_get_org_overview`; broad aggregate
metric queries have timed out. The authenticated service/trace/log reads are the primary path. If
`signoz_list_metrics` returns the SigNoz UI HTML rather than metric metadata, record the metric catalog
as unavailable and do not retry an overlapping query. Never weaken the read-only MCP allowlist.

## Interpretation

A slow top-level request alone does not identify a bottleneck. For each finding, report:

- exact run ID, UTC window, workload, achieved throughput, and failed thresholds;
- service and operation plus aggregate latency/error evidence;
- representative trace ID or returned SigNoz link, with the dominant child span and time share;
- supporting log/resource evidence and affected Formbricks source path;
- confidence (`confirmed`, `probable`, or `hypothesis`), limitation, and a rerunnable command;
- prioritized code/infrastructure remediation and the signal that would validate it.

Likely source anchors are:

| Journey | Formbricks source |
| --- | --- |
| Public survey page | `apps/web/app/s/[surveyId]/page.tsx` |
| Environment state | `apps/web/app/api/v1/client/[workspaceId]/environment/route.ts` and `lib/` |
| Response creation | `apps/web/app/api/v1/client/[workspaceId]/responses/route.ts` and `lib/response.ts` |
| Survey list/create/delete | `apps/web/app/api/v3/surveys/route.ts`, `[surveyId]/route.ts`, `lib/operations.ts` |

Do not infer a database, cache, or downstream bottleneck without a child span, query/profile, or
resource signal showing it. Keep confirmed findings, hypotheses, unavailable signals, and test limits
separate.

## Troubleshooting

- `guardrail: target...`: use Artemis or a deliberately confirmed isolated non-production target.
- `high-impact; explicit approval is required`: do not bypass it; obtain approval for exact impact.
- Fixture create 401/403: confirm key scope and workspace ownership without printing the key.
- Fixture create 422: compare the payload with the deployed v3 survey contract before retrying.
- 429 responses: stop; record Envoy/application rate-limit evidence and do not raise the rate.
- Dropped iterations: stop; VU capacity or target latency cannot sustain the configured arrival rate.
- Missing SigNoz fields: discover valid resource/attribute keys once, then retry with an existing key.
- Missing metrics: retain k6 and Kubernetes evidence and document the unavailable signal.
