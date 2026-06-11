# Self-Hosted LLM Load Test — Results

> Copy this file to `report/runs/<timestamp>/report.md` and fill in. The
> sections map directly to ENG-1107's "Required Outputs" and "Acceptance
> Criteria" — every `_TBD_` is something the ticket explicitly asks for.

## 1. Test setup

- **Date** (UTC): _TBD_
- **Region / cluster**: _TBD_
- **Namespace**: _TBD_
- **Test workspace + org**: _TBD_ (must have AI smart-tools entitled and enabled)
- **k6 version**: _TBD_

### Model + runtime

| Field | Value |
|---|---|
| Qwen model | _TBD_ (e.g. `Qwen/Qwen2.5-7B-Instruct`) |
| Quantization | _TBD_ (none / AWQ-4bit / GPTQ / FP8) |
| vLLM image | _TBD_ (`vllm/vllm-openai:_TBD_`) |
| vLLM startup flags | _TBD_ (`--max-num-seqs`, `--max-model-len`, `--gpu-memory-utilization`, `--guided-decoding-backend`) |
| Structured-output backend | _TBD_ (outlines / xgrammar / lm-format-enforcer / off) |
| Served model name | _TBD_ |

### Hardware

| Field | Value |
|---|---|
| GPU type | _TBD_ (L4 / A10G / A100 / H100) |
| GPU count per pod | _TBD_ |
| GPU memory | _TBD_ GiB |
| Node instance type | _TBD_ |

### Pod resources

| Pod | CPU request / limit | Memory request / limit | Replicas |
|---|---|---|---|
| vLLM | _TBD_ | _TBD_ | _TBD_ |
| Formbricks web | _TBD_ | _TBD_ | _TBD_ |

### Persistence / cache

- vLLM model cache PVC: _TBD_ GiB, access mode _TBD_, mount _TBD_
- Hugging Face token source: _TBD_ (Secret name / not required because pre-cached)

## 2. Workload shape

| Workflow | Token shape | Fixture file |
|---|---|---|
| Translation | balanced prefill+decode (~3k in / ~3k out for large) | `data/prompts-translation.json` (10 fixtures) |
| Survey generation | decode-heavy (~500 in / ~3000 out) | `data/prompts-surveygen.json` (15 fixtures) |
| Chart generation | prefill-heavy (~2000 in / ~200 out) | `data/prompts-chartgen.json` (12 fixtures) |
| Web survey gen | same as survey-gen + Next.js overhead | reuses `prompts-surveygen.json` |

Per-profile rates actually used (fill from the run):

| Scenario | Profile | RATE | DURATION | MAX_VUS |
|---|---|---|---|---|
| translation | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| surveygen | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| chartgen | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| web | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| mixed | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## 3. Results

### 3.1 Direct LLM — Translation

| Metric | baseline | mid | burst | stress |
|---|---|---|---|---|
| p50 (ms) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| p95 (ms) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| p99 (ms) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Throughput (req/s) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Throughput (tokens/s, completion) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Error rate (5xx + timeouts) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Timeout rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Schema-valid rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Malformed-JSON rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Median prompt tokens | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Median completion tokens | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### 3.2 Direct LLM — Survey generation

| Metric | baseline | mid | burst | stress |
|---|---|---|---|---|
| p50 / p95 / p99 (ms) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Throughput (req/s, tokens/s) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Error rate / Timeout rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Schema-valid rate / Malformed-JSON rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### 3.3 Direct LLM — Chart generation

| Metric | baseline | mid | burst | stress |
|---|---|---|---|---|
| p50 / p95 / p99 (ms) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Throughput (req/s, tokens/s) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Error rate / Timeout rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Schema-valid rate / Malformed-JSON rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### 3.4 Web-mediated — POST /api/v3/surveys/generate

| Metric | baseline | mid | burst | stress |
|---|---|---|---|---|
| End-to-end p50 / p95 / p99 (ms) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 200 OK rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 429 rate-limited rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 502 bad-gateway rate (AI failure) | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 503 AI-unavailable rate | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Other error count | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### 3.5 Mixed (concurrent translation + chartgen + web)

| Metric | Value |
|---|---|
| Per-workflow p95 vs. isolated runs | _TBD_ (Δ in ms) |
| vLLM queue depth peak | _TBD_ |
| Did any workflow's SLA break under mixed load? | _TBD_ |

### 3.6 Cold start

| Mode | Time to Ready | First-request p50 |
|---|---|---|
| cache-warm rollout | _TBD_ s | _TBD_ ms |
| cache-cold first start | _TBD_ s | _TBD_ ms |

Rolling restart behavior under sustained baseline load: _TBD_.

vLLM unavailable for _TBD_ s during a baseline run: _TBD_ requests degraded
to 502/503, _TBD_ recovered automatically.

## 4. GPU and runtime metrics

From `gpu-metrics.csv` and `vllm-metrics.csv` during the **stress** run
(unless otherwise noted):

| Metric | Peak | Median |
|---|---|---|
| GPU utilization % | _TBD_ | _TBD_ |
| GPU memory used (MiB) | _TBD_ | _TBD_ |
| GPU temperature (°C) | _TBD_ | _TBD_ |
| GPU power (W) | _TBD_ | _TBD_ |
| vLLM running requests | _TBD_ | _TBD_ |
| vLLM waiting requests (queue) | _TBD_ | _TBD_ |
| KV cache usage % | _TBD_ | _TBD_ |
| Preemptions total | _TBD_ | — |

## 5. Pod metrics

From `k8s-metrics.csv` and `k8s-events.txt`:

| Pod | Peak CPU (m) | Peak memory (MiB) | Restarts | OOMs | Probe failures |
|---|---|---|---|---|---|
| vLLM | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Formbricks web | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## 6. Observed bottlenecks

_TBD_ — fill from the data above. Examples of what to look for:

- **KV cache thrash** — `vllm:num_preemptions_total` keeps climbing under
  load → max-num-seqs too high relative to KV cache budget.
- **Queue wait time** — `vllm:num_requests_waiting` stays high while
  `vllm:num_requests_running` is at the configured max → throughput is
  request-shaped, not GPU-shaped; raise `--max-num-seqs` if KV cache allows.
- **30-second timeouts** at the web layer — surveygen end-to-end p95 above
  ~28s while vLLM keeps generating → Formbricks's Next.js timeout is binding;
  surface as a recommendation to either raise it or cap output tokens.
- **Schema-invalid spikes** under stress → guided-decoding backend is being
  bypassed under load, or the model is being rate-limit-evicted mid-decode.
- **CPU throttle on web pod** during burst → web pod's CPU request is too
  low for the JSON validation cost on large surveys.

## 7. Production rollout recommendations

### 7.1 Max safe concurrency

For the tested model + GPU profile, the practical maximum is **_TBD_
concurrent requests** before either:
- p95 e2e latency exceeds _TBD_ ms, or
- error/timeout rate exceeds _TBD_ %, or
- vLLM preemption rate becomes non-zero.

### 7.2 Recommended settings

| Setting | Value | Rationale |
|---|---|---|
| Web request timeout (Next.js / AI client) | _TBD_ s | _TBD_ |
| vLLM `--max-num-seqs` | _TBD_ | _TBD_ |
| vLLM `--max-model-len` | _TBD_ | _TBD_ |
| vLLM `--gpu-memory-utilization` | _TBD_ | _TBD_ |
| vLLM `--guided-decoding-backend` | _TBD_ | _TBD_ |
| Readiness probe `initialDelaySeconds` | _TBD_ | _TBD_ |
| Startup probe `failureThreshold` × `periodSeconds` | _TBD_ × _TBD_ s | _TBD_ |
| Pod resource requests | _TBD_ | _TBD_ |
| HPA target | _TBD_ | _TBD_ |

### 7.3 Expected cold-start time

| Scenario | Expected p95 |
|---|---|
| cache-warm rollout | _TBD_ s |
| cache-cold first start | _TBD_ s |

## 8. Production rollout gates

Trip wires the team should set **before** enabling vLLM in EU prod or KSA prod:

| Gate | Threshold | Source signal |
|---|---|---|
| Auto-rollback if e2e p95 > | _TBD_ ms for _TBD_ minutes | Datadog / Grafana / Sentry |
| Auto-rollback if 5xx rate > | _TBD_ % for _TBD_ minutes | Datadog / Grafana |
| Auto-rollback if 429 rate > | _TBD_ % | Datadog / Grafana |
| Alert if GPU memory > | _TBD_ % for _TBD_ minutes | DCGM exporter |
| Alert if vLLM preemptions / min > | _TBD_ | vLLM /metrics |
| Manual hold gate if startup time > | _TBD_ s | deployment status |

## 9. Risk assessment

_TBD_. Cover at minimum:

- What happens to end-users when vLLM is overloaded (queued, timeout, 5xx)?
- What happens during a deploy / rolling restart?
- What's the blast radius if vLLM goes down? Which Formbricks features
  degrade vs. break?
- Is fallback to a cloud-hosted provider configured (env-var-swappable)?
- Cost upside vs. current setup, ballpark.

## 10. Follow-ups

(Open Linear tickets and reference IDs.)

- _TBD_ — chart change / new env / observability gap / blocker

## 11. Reproducibility

To rerun this exact configuration:

```bash
cd scripts/llm

# Env
export LLM_URL=_TBD_  LLM_API_KEY=_TBD_  MODEL=_TBD_
export FORMBRICKS_URL=_TBD_  FORMBRICKS_API_KEY=_TBD_  FORMBRICKS_WORKSPACE_ID=_TBD_
export VLLM_METRICS_URL=_TBD_
export NAMESPACE=_TBD_  POD_SELECTOR=_TBD_

# Scenarios used in this report
PROFILE=baseline ./run-full-suite.sh translation
PROFILE=baseline ./run-full-suite.sh surveygen
PROFILE=baseline ./run-full-suite.sh chartgen
PROFILE=baseline ./run-full-suite.sh web
PROFILE=mid      ./run-full-suite.sh mixed
PROFILE=stress   ./run-full-suite.sh surveygen
NAMESPACE=$NAMESPACE VLLM_DEPLOYMENT=_TBD_ \
  OUT=report/runs/_TBD_/cold-warm.json \
  ./run-cold-start.sh cache-warm
```
