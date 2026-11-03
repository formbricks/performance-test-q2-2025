# Artemis: policy tests versus capacity tests

These are different experiments. A successful policy test demonstrates admission
control. A capacity run measures the application at **5 global journeys/second**;
it does not establish maximum capacity or full application coverage.

## Before execution

- Obtain approval for the shared Artemis window. Never target production, disable
  gateway protection, or spoof forwarding headers.
- Provision four stable regional SSH workers with **independent real egress IPs**.
  Four pods behind one NAT are one client. Use the normal public Artemis route.
- Install native k6 (the suite currently pins 2.0.0 for its Docker fallback),
  Python 3, Bash, curl, jq, git and kubectl. Capacity does not support Docker:
  cancellation must directly stop the generator.
- Put the same committed, clean suite revision on every worker. Set up read-only
  Kubernetes access to `core-eks` / `formbricks-artemis` for the collectors.
- Store the existing suite environment settings in a private, worker-local file:
  workspace ID and a temporary workspace-scoped Manage API key are required.
  The coordinator never transfers credentials. Keep the file outside the repo.
- Use a low-rate request from each worker and correlate Envoy logs to verify the
  source IPs **seen by the gateway**. Capture the current policy and approved
  dataset cardinalities. Check clock synchronization on all workers.
- Copy `capacity.example.json`, replace the revision, hostnames, paths, IPs,
  evidence reference and existing-data counts. The evidence fields are operator
  attestations, not automatic proof. Do not use the example documentation IPs.

The capacity profile fixes RATE=5 globally and divides both start and target rates
by the worker count using k6's `timeUnit`. Four workers each hold 1.25 journeys/s.
The 60/25/13/2 mixed workload is deterministically interleaved. It averages
63.75 protected requests/minute per worker, and its worst-case 100% protected
traffic rate is 75/minute. No worker may exceed the configured 80/minute budget.
All HTTP 429s invalidate capacity results; gateway provenance requires Envoy logs.
Requests explicitly negotiate gzip, including in ordinary suite runs.

## Capacity execution

From `scripts/formbricks-core`:

```bash
# Offline manifest validation only; no SSH connections or traffic.
python3 capacity.py run --manifest /path/to/capacity.json --output /path/to/new-results

# Only after the window and runner setup have been approved:
python3 capacity.py run --manifest /path/to/capacity.json --output /path/to/new-results --execute-approved
python3 capacity-report.py /path/to/new-results
```

Each worker performs existing preflight checks, creates its own run-owned fixture,
and waits 60 seconds before announcing readiness. Once all are ready, the
coordinator releases the start barrier. The schedule is a 1-minute ramp from
1 to 5 global journeys/s, 3-minute hold, and 1-minute ramp down to zero.
Each worker's VU ceiling is 20 (80 total for four workers); VUs are not client IPs.
Worker timestamps must be within 2 seconds. The coordinator has bounded readiness
and execution timeouts. A worker failure, Ctrl-C, or loss of the control stream
stops the other generators; remote workers also have a 10-minute watchdog.

Existing health monitors and fixture cleanup run independently on each worker.
Results are copied back even after failures. If a worker is unreachable, classify
the run incomplete and recover its artifacts/verify its exact run-owned cleanup
when connectivity returns. Do not claim that disconnected cleanup succeeded.
Use the existing `fixtures.sh cleanup` procedure with that worker's exact RUN_ID
and directory; never delete by a broad prefix.

The report merges request-level samples, not worker percentiles. It checks worker
threshold results, schedule duration, total journey count, each minute of the
hold, start skew, dropped work and HTTP 429s. Its best classification is
`CLIENT_CHECKS_PASSED_REQUIRES_GATEWAY_AND_RESOURCE_REVIEW`, **not automatic acceptance**.
Retain Envoy counts, per-pod traces/latency/resources, DB/cache health, before/after
fixture counts and exact cleanup evidence. An HTTP 429 counter alone cannot prove
which layer rejected a request. Keep aborted runs and their evidence.

## Separate policy experiment

Use a dedicated source IP and do not overlap this with the capacity run or other
traffic from that IP. First run the ordinary low-rate public-read baseline and
confirm successful requests. Then, in an approved window:

```bash
CONFIRM_POLICY_TEST=I_APPROVE_ARTEMIS_POLICY_TEST \
  k6 run k6/policy.js
```

Export FORMBRICKS_URL (exact Artemis URL), FORMBRICKS_WORKSPACE_ID and a unique
RUN_ID beforehand. This bounded, read-only probe sends 3 requests/s for 2 minutes
and expects both successful requests and HTTP 429s, with no other statuses or
dropped work. Correlate `formbricks-k6-policy/<RUN_ID>` in Envoy logs to establish
the rejection source and verify counts against the active bucket/reset behavior.
Do not call its expected 429s backend failures, or treat its threshold success as
proof of an exact 100/minute policy without gateway evidence. Wait for bucket
recovery before reusing the IP.

## Handoff

Run `tests/validate.sh` before publishing the suite revision. Repeat the capacity
experiment under comparable app revision, data and infrastructure conditions.
Keep reusable setup instructions in the engineering guide; store experiment
results separately. Record actionable bottlenecks with trace/query evidence and
distinguish hypotheses from measured causes. Runner provisioning and live
execution are separate from the harness change.
