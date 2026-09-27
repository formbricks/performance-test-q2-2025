# ENG-3309 Artemis preflight and validation

## Status

At `2026-09-27T19:27:06Z`, Artemis returned HTTP 200 from `/health` in 686 ms. A follow-up
`/api/v2/health` check returned HTTP 200 in 309 ms with both main database and cache healthy. Argo
reported the `formbricks-artemis` application Synced and Healthy. The application deployment was 3/3 ready with no
container restarts or namespace warning events.

At `2026-09-27T19:31:12Z`, the suite's live `smoke` preflight passed with healthy dependencies and all
three application pods ready. The same preflight for `baseline` exited non-zero because the HPA was
`ScalingLimited` at its three-replica maximum and memory had risen to 80% of request. No k6 workload
was sent.

No live k6 workload was generated. `FORMBRICKS_WORKSPACE_ID` and `FORMBRICKS_API_KEY` were absent from
the task environment, and no private Formbricks/Artemis performance environment file was present in
the existing performance checkout or `/tmp`. The suite deliberately cannot create its isolated survey
fixture or prove cleanup without a workspace-scoped read-write test key. Health-only traffic is not a
substitute for the requested journey smoke test.

## Capacity preflight

| Signal | Observation |
| --- | --- |
| App image | `staging-artemis@sha256:c20ebaf8b385f9683aa5ae0ffbc1355ac755bd3a8fd6e3abc72b90f8fe2123fe` |
| App replicas | 3 ready; HPA current/desired 3, min/max 2/3 |
| HPA utilization | CPU 0% of 60% target; memory 73% at 19:27 and 80% at 19:31, versus 60% target |
| App pod usage | 4–5m CPU and 736–767 MiB memory per pod |
| App requests/limits | 500m CPU / 1 GiB memory request; 2 GiB memory limit |
| Stability | Zero app restarts; zero namespace warning events |

The service was healthy and well below its container limit, but the HPA was already at its maximum
replica count because memory exceeded the scaling target. Smoke is safe to attempt with credentials;
baseline/load remain gated until scaling headroom returns or the user explicitly approves the exact
capacity exception with active observation.

## SigNoz read-path validation

The authenticated, read-only MCP connection successfully listed services, top operations, trace field
keys, log field keys, and log field values. In the preceding six-hour ambient window:

- `formbricks-artemis` trace activity was present with no errors in the service summary.
- The generic top-level `GET` operation had 104 calls and a 393.5 ms p99.
- 9,214 Prisma database-query spans had an 11.9 ms p99; 120 AuthZed relationship reads had a 63.6 ms
  p99. These are ambient observations, not ENG-3309 workload findings.
- `user_agent.original` is available for future `formbricks-k6/<run-id>` trace correlation.

Compatibility limits observed against deployed SigNoz v0.89.0:

- `signoz_list_metrics` returned the SigNoz UI HTML rather than metric catalog data.
- Artemis log aggregation and a one-row log search returned no matching rows in the six-hour window,
  even though `service.name=formbricks-artemis` is a discovered value.
- `signoz_get_org_overview` remains unsupported and was not called; broad aggregate metric queries were
  not retried after the known timeout.

No trace/log content or credential value is included here.

## Local suite validation

`./tests/validate.sh` passed. It covered Bash syntax, two Node summary tests, twelve guardrail cases,
all 36 profile/scenario `k6 inspect` combinations, and mock API smoke runs for public read, public
survey, management read, response write, survey lifecycle, and mixed traffic. Every mock run produced
passing JSON/Markdown summaries and completed exact run-owned cleanup.

## Required next action

Provide a workspace ID and read-write API key for an isolated Artemis performance workspace through a
private environment file. Then run all scenario smokes. Run `RATE=1 DURATION=2m` baseline only if
cleanup, availability, telemetry, and HPA headroom are clean or the user explicitly approves the exact
capacity exception. Stress, spike, and soak still require separate approval for their traffic/window.
