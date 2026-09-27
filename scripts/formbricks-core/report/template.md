# Artemis performance test findings

## Run identity

| Field | Value |
| --- | --- |
| Run ID | _TBD_ |
| Window (UTC / Unix ms) | _TBD_ |
| Suite commit | _TBD_ |
| Artemis image digest / replicas | _TBD_ |
| Scenario / profile | _TBD_ |
| Configured / achieved rate | _TBD_ |
| Fixture cleanup | _complete / incomplete_ |

## Outcome

- Verdict: _PASS / FAIL / INCONCLUSIVE_
- Highest safe tested load: _TBD_
- First limiting signal: _TBD_
- Availability or side effects: _none / describe_

## k6 evidence

Copy the endpoint table from `k6-summary.md`. Add achieved iterations/s and requests/s, failure/check
rates, dropped iterations, unexpected responses, and every failed threshold. Do not erase or relax a
threshold after the run.

## SigNoz correlation

| Service / operation | Exact filter and UTC window | Calls / errors | p50 / p90 / p95 / p99 | Representative trace or returned link |
| --- | --- | ---: | --- | --- |
| _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

For each slow/error trace, name the dominant child span, its share of end-to-end time, and whether it
appears across percentile samples or only one outlier. Record unavailable metrics or incompatible MCP
calls as limitations; never treat a missing signal as zero.

## Resource evidence

| Signal | Before | Peak | After | Interpretation |
| --- | ---: | ---: | ---: | --- |
| App replicas / HPA | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| App CPU | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| App memory | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Restarts / warning events | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Confirmed findings

| Priority | Finding | Exact evidence | Affected source / infrastructure | Proposed remediation | Validation |
| --- | --- | --- | --- | --- | --- |
| _TBD_ | _TBD_ | k6 + trace/log/metric/resource evidence | exact path or component | bounded change | rerunnable command/signal |

## Hypotheses

| Confidence | Hypothesis | Supporting signal | Missing proof | Next query or rerun |
| --- | --- | --- | --- | --- |
| low / medium / high | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Remediation priorities

| Priority | Change | Expected effect | Verification signal | Owner / ticket |
| --- | --- | --- | --- | --- |
| _P0-P3_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Reproduction

Record the exact command with secret values removed, the run artifact directory, non-secret overrides,
and both suite and Artemis revisions.

## Limitations

- _Test-model, fixture, shared-environment, or sampling limitation._

## Unavailable signals

- _Signal/tool, exact attempted query, failure mode, and fallback evidence._

## Open gaps

- _Unexecuted profiles, missing credentials, or work requiring separate approval._

## Abort and rollback notes

- Abort trigger observed: _none / describe_
- Cleanup recovery required: _no / exact run-owned command_
- Artemis configuration changed: _must be no for this suite_
