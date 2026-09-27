# Formbricks core performance suite

Human-supervised k6 workloads for the isolated Artemis environment. Each run creates a unique,
run-owned survey where needed, emits endpoint-tagged results, captures Kubernetes resource evidence,
and cleans up only objects carrying the exact run ID.

This is not a production test or an unattended CI load test. Read [RUNBOOK.md](RUNBOOK.md) before
using shared Artemis.

## Journeys

| Scenario | Requests per iteration | Purpose |
| --- | ---: | --- |
| `public-read` | 1 | Public environment configuration and cache/database reads |
| `public-survey` | 2 | Link survey page render followed by public environment loading |
| `management-read` | 1 | API-key auth, authorization, list query, counts, and serialization |
| `response-write` | 1 | Validation, response transaction, quota evaluation, and pipeline dispatch |
| `survey-lifecycle` | 3 | Authenticated survey create, read, and delete |
| `mixed` | ~1.64 | Deterministic 60/25/13/2 blend of public load, response write, management read, and lifecycle |

Mixed smoke invokes every journey once (seven HTTP requests); steady-state mixed profiles use the
deterministic blend above and average 1.64 HTTP requests per iteration.

Relevant Formbricks paths are `apps/web/app/s/[surveyId]/page.tsx`, the v1 client environment and
response route handlers, and the v3 survey route handlers plus `lib/operations.ts`.

## Profiles

Rates are iterations per second, not raw HTTP requests per second. `DURATION` changes only the hold
stage shown below.

| Profile | Default model | Intent | Execution gate |
| --- | --- | --- | --- |
| `smoke` | 1 VU × 1 iteration | Contract and fixture safety | Always first |
| `baseline` | 1 iter/s for 2m | Low-noise reference | Shared-safe, max 10 iter/s |
| `load` | ramp to 5 iter/s, hold 3m, ramp down | Expected operating load | Shared-safe, max 10 iter/s |
| `stress` | 25/50/100% of 20 iter/s | Find saturation boundary | Explicit approval required |
| `spike` | jump to 30 iter/s, hold 1m | Burst and recovery behavior | Explicit approval required |
| `soak` | 3 iter/s for 30m | Leaks, drift, and pool exhaustion | Explicit approval required |

The suite has hard ceilings of 50 iterations/s, 200 VUs, and profile-specific duration limits.
Production hosts are always rejected. Artemis is the only remote target accepted without a deliberate
non-production override. A preflight and continuous monitor stop runs on failed application/database/
cache health, unready or restarted pods, high memory, or unapproved HPA saturation.

## Thresholds and aborts

Global and endpoint-tagged request duration gates are p50 < 1s, p90 < 1.5s, p95 < 2s, and p99 < 5s.
HTTP failures must stay below 1%, checks at or above 99%, and dropped iterations and unexpected status
codes at zero. A run aborts after a 5% HTTP failure rate, three unexpected responses, or five dropped
iterations (immediately for smoke; after 30 seconds for longer profiles).

Override latency thresholds only before a run, record the reason, and never relax them after seeing a
failure.

## Quick start

Keep the filled environment file outside Git:

```bash
cp scripts/formbricks-core/config.example.env /tmp/formbricks-core.env
$EDITOR /tmp/formbricks-core.env
source /tmp/formbricks-core.env
cd scripts/formbricks-core
./run-full-suite.sh smoke public-read
./run-full-suite.sh smoke public-survey
./run-full-suite.sh smoke management-read
./run-full-suite.sh smoke response-write
./run-full-suite.sh smoke survey-lifecycle
./run-full-suite.sh smoke mixed
```

Only after all smoke paths, cleanup, Artemis health, telemetry, and HPA headroom are clean:

```bash
RATE=1 DURATION=2m ./run-full-suite.sh baseline mixed
RATE=5 DURATION=3m ./run-full-suite.sh load mixed
```

Stress, spike, and soak are implemented for approved maintenance windows. The runbook records their
expected impact and approval gate.

## Artifacts

Each run writes `report/runs/<run-id>/`:

| Artifact | Evidence |
| --- | --- |
| `metadata.txt`, `start.txt`, `end.txt` | Target, commit, profile, exact workload UTC window |
| `suite-start.txt`, `suite-end.txt` | Full fixture, collection, workload, and cleanup window |
| `preflight.txt`, `health-monitor.log` | Health, readiness, restart, and HPA abort evidence |
| `k6-summary.json`, `k6-summary.md` | Machine/human throughput, p50/p90/p95/p99, errors, checks |
| `k6-raw-summary.json`, `k6.log` | Raw k6 metrics and diagnostic output |
| `fixture*.json`, `cleanup*.txt`, `cleanup.log` | Synthetic ownership and verified deletion |
| `k8s-metrics.csv`, `final-top.txt`, `k8s-events.txt` | CPU, memory, restarts, OOM/probe evidence |
| `health-abort.txt` | Explicit health/capacity abort cause when a monitor stops k6 |
| `analysis.md` | SigNoz correlation, findings, limits, and remediation proposals |

No API key or cookie is written to these artifacts. Do not attach raw traces, logs, headers, or
customer data to the repository or ticket.

## Local validation

```bash
./tests/validate.sh
```

This performs Bash syntax checks, helper tests, guardrail assertions, every profile's `k6 inspect`, and
mock-server smoke runs for every journey. It never contacts Artemis.

The `Formbricks core suite validation` GitHub workflow runs the same offline command for relevant pull
requests and `main` pushes with read-only permissions. There is intentionally no scheduled or CI-based
Artemis workload; shared-environment runs stay human-supervised.
