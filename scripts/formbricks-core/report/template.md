# Artemis performance test findings

## Run identity

| Field | Value |
| --- | --- |
| Run ID | _TBD_ |
| Window (UTC) | _TBD_ |
| Git commit | _TBD_ |
| Scenario / profile | _TBD_ |
| Requested rate and duration | _TBD_ |
| Artemis image revision / replicas | _TBD_ |

## Outcome

- Verdict: _PASS / FAIL / INCONCLUSIVE_
- Highest safe tested load: _TBD_
- First limiting resource or dependency: _TBD_
- Cleanup: _complete / incomplete_

## k6 results

Copy the endpoint table from `k6-summary.md`, then add achieved request rate, failed request rate,
checks, and dropped iterations. Explain any threshold failure; do not erase or relax it after the run.

## SigNoz evidence

| Finding | Query/filter and time window | Evidence | Confidence |
| --- | --- | --- | --- |
| _TBD_ | _TBD_ | trace ID, dashboard, or screenshot | measured / inferred |

For slow requests, name the dominant child span, its share of end-to-end time, and whether the pattern
appears across p95/p99 traces or only in an outlier. Include error status/code for failures.

## Resource evidence

Summarize CPU, memory, restarts, OOM/probe events, and replica behavior from the Kubernetes artifacts.
Note missing metrics rather than treating blanks as zero.

## Findings and follow-ups

| Priority | Layer | Finding | Proposed change | Owner / ticket |
| --- | --- | --- | --- | --- |
| _TBD_ | code / query / cache / dependency / infrastructure | _TBD_ | _TBD_ | _TBD_ |

## Reproduction

Record the exact command with secret values removed, relevant non-secret environment overrides, and the
artifact directory. Link the GitOps and suite revisions used for the run.

## Open gaps

- _TBD_
