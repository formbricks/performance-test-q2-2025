# Self-Hosted LLM Load Test (Qwen / vLLM)

Load tests the Formbricks self-hosted LLM runtime — **Qwen served by vLLM**
through an OpenAI-compatible endpoint — under realistic Formbricks AI
traffic patterns (translation, chart generation, survey generation).

Companion to `scripts/embeddings/`, which tests the Hub embeddings pipeline.
The two tests are independent — the LLM runtime is called by the Formbricks
**XM Suite web app**, not by Hub.

Implements ENG-1107.

## What this exercises

Four scenarios mapped to the four workflows the ticket asks about:

| Script | Workflow | Path |
|---|---|---|
| `k6/llm-direct-translation.js` | AI survey translation | direct → vLLM `/v1/chat/completions` |
| `k6/llm-direct-surveygen.js` | AI survey generation (smart-tools) | direct → vLLM |
| `k6/llm-direct-chartgen.js` | AI chart generation | direct → vLLM |
| `k6/web-survey-gen.js` | Survey-gen via the real HTTP route | Formbricks web → vLLM |

Plus a concurrent **mixed** mode in `run-full-suite.sh` that runs three
workflows in parallel to cover the ticket's "concurrent mixed traffic"
requirement.

Plus `run-cold-start.sh` for the cold-start / rollout-restart scenario.

## Layout

```
scripts/llm/
├── README.md                            this file
├── package.json                         "type": "module"
├── .gitignore                           ignores report/runs/**
├── data/
│   ├── prompts-translation.json         translation fixtures (10)
│   ├── prompts-surveygen.json           survey-gen fixtures (15)
│   └── prompts-chartgen.json            chart-gen fixtures (12)
├── k6/
│   ├── llm-direct-translation.js        scenario 1
│   ├── llm-direct-surveygen.js          scenario 2
│   ├── llm-direct-chartgen.js           scenario 3
│   ├── web-survey-gen.js                scenario 4
│   └── lib/
│       ├── payloads.js                  fixture loaders + OpenAI body builders
│       ├── summary.js                   structured PASS/FAIL summary
│       └── validators.js                schema-validity + token usage
├── collectors/
│   ├── vllm-metrics.sh                  scrape vLLM /metrics → CSV
│   ├── gpu-metrics.sh                   kubectl exec nvidia-smi → CSV
│   └── k8s-metrics.sh                   kubectl top + events → CSV
├── run-k6.sh                            single-scenario wrapper
├── run-cold-start.sh                    vLLM rollout + readiness timing
├── run-full-suite.sh                    orchestrator
└── report/
    ├── template.md                      fill against ENG-1107 acceptance criteria
    └── runs/                            per-run artifacts (gitignored)
```

## Prerequisites

- Node 20+ (fixtures are plain JSON, no build step)
- `k6` locally **or** Docker (the wrapper falls back to `grafana/k6:latest`)
- `kubectl` configured for the EKS cluster running Formbricks + vLLM
- A Formbricks **management API key** (`fbk_…`) with read/write access to
  the test workspace, on an org that has AI smart-tools entitled + enabled

## Run the full test (end-to-end on staging EKS)

```bash
# 1. Cluster + port-forwards
aws eks update-kubeconfig --name <cluster> --region <region>
kubectl -n formbricks-stage port-forward svc/vllm 8000:8000 &
# (Formbricks web is reachable at its staging URL — no port-forward needed)

# 2. Env
export LLM_URL=http://localhost:8000/v1
export LLM_API_KEY=<token-if-required>
export MODEL=Qwen/Qwen2.5-7B-Instruct           # whatever ENG-1103 lands on
export RESPONSE_FORMAT=json_schema              # vLLM with guided decoding
export VLLM_METRICS_URL=http://localhost:8000/metrics

export FORMBRICKS_URL=https://app.staging.formbricks.com
export FORMBRICKS_API_KEY=fbk_...
export FORMBRICKS_WORKSPACE_ID=cmk...

export NAMESPACE=formbricks-stage
export POD_SELECTOR='app.kubernetes.io/name in (vllm,formbricks-web)'

# 3. Smoke (~1 minute) — confirm the wiring
cd scripts/llm
./run-k6.sh llm-direct-translation smoke
./run-k6.sh llm-direct-surveygen   smoke
./run-k6.sh llm-direct-chartgen    smoke
./run-k6.sh web-survey-gen         smoke

# 4. The four scenarios. Each writes report/runs/<timestamp>/.
PROFILE=baseline ./run-full-suite.sh translation
PROFILE=baseline ./run-full-suite.sh surveygen
PROFILE=baseline ./run-full-suite.sh chartgen
PROFILE=baseline ./run-full-suite.sh web
PROFILE=mid      ./run-full-suite.sh mixed
PROFILE=stress   ./run-full-suite.sh surveygen     # find the ceiling

# 5. Cold start
NAMESPACE=$NAMESPACE VLLM_DEPLOYMENT=vllm \
  OUT=report/runs/$(date -u +%Y%m%dT%H%M%SZ)/cold-warm.json \
  ./run-cold-start.sh cache-warm

# 6. Fill report/template.md from report/runs/<timestamps>/
cp report/template.md report/runs/<ts>/report.md
# Then replace every _TBD_ from the artifacts in that run dir.
```

Expected wall-clock time at default profiles: roughly **60–90 minutes** of
scenarios + ~10 min for cold-start measurements + ~30 min stress.

## Env vars in one table

| Var | Used by | Required for |
|---|---|---|
| `LLM_URL` | direct-LLM scenarios | translation / surveygen / chartgen |
| `LLM_API_KEY` | direct-LLM scenarios | only if vLLM is auth-gated |
| `MODEL` | direct-LLM scenarios | translation / surveygen / chartgen |
| `RESPONSE_FORMAT` | direct-LLM scenarios | optional (`json_object` default, `json_schema` for vLLM guided decoding, `none` to skip) |
| `FORMBRICKS_URL` | web-survey-gen | web scenario |
| `FORMBRICKS_API_KEY` | web-survey-gen | web scenario |
| `FORMBRICKS_WORKSPACE_ID` | web-survey-gen | web scenario |
| `VLLM_METRICS_URL` | vllm-metrics collector | per-run vLLM `/metrics` scrape |
| `NAMESPACE` | gpu/k8s collectors + cold-start | k8s-based collectors |
| `POD_SELECTOR` | gpu/k8s collectors | optional, limits scope |
| `VLLM_DEPLOYMENT` | cold-start | `run-cold-start.sh` |
| `PROFILE` | all scripts | `smoke`/`baseline`/`mid`/`burst`/`stress` |
| `RATE` / `DURATION` / `MAX_VUS` / `TIMEOUT` | all scripts | optional overrides |

## Profiles

The profiles are dialed down significantly compared to embeddings —
chat-completion latency is 10–100× slower per request than embedding, so the
same RPS would be wildly unrealistic. Override `RATE`/`DURATION` per run
when you want to push outside the defaults.

| Profile | translation | surveygen | chartgen | web |
|---|---|---|---|---|
| `smoke` | 3 iters / 1 VU | 3 iters / 1 VU | 3 iters / 1 VU | 3 iters / 1 VU |
| `baseline` | 0.2 rps × 5m | 0.1 rps × 5m | 0.5 rps × 5m | 0.1 rps × 10m |
| `mid` | 1 rps × 5m | 0.5 rps × 5m | 2 rps × 5m | 0.16 rps × 10m (rate-limit edge) |
| `burst` | ramp 0.5→5→0.5 | ramp 0.2→3→0.2 | ramp 1→10→1 | ramp 0.1→2→0.1 (>limit) |
| `stress` | ladder 0.5→8 | ladder 0.5→8 | ladder 1→16 | ladder 1→10 |

**Web mode is bound by the per-org rate limit** (10 req/min on
`POST /api/v3/surveys/generate`). At RATE > 0.16 you will see 429s — that's
expected and `rate_limited` is recorded separately from other errors.

## Metrics every direct-LLM scenario records

| Metric | Type | Meaning |
|---|---|---|
| `http_req_duration` | k6 built-in | wall-clock from request send to last byte |
| `prompt_tokens` | Trend | input tokens reported by the server's `usage` |
| `completion_tokens` | Trend | output tokens (drives GPU cost) |
| `tokens_per_sec` | Trend | per-request decode throughput |
| `schema_valid` | Rate | response parsed AND every required key present |
| `malformed_json` | Rate | response content was not valid JSON — the "malformed structured-output rate" the ticket asks for |
| `missing_keys` | Rate | JSON parsed but a required key was missing/empty |
| `latency_small/medium/large` | Trend | translation-only — `http_req_duration` bucketed by fixture size |

Web-survey-gen has its own classification: `generated_ok`, `rate_limited`,
`ai_unavailable`, `bad_gateway`, `other_errors`.

## Collectors

Run alongside scenarios via `run-full-suite.sh`. Each writes a CSV into the
run's artifact dir.

| Collector | Captures | Requires |
|---|---|---|
| `vllm-metrics.sh` | vLLM Prometheus `/metrics` — queue depth, KV cache %, preemptions, tokens/sec counters | `VLLM_METRICS_URL` |
| `gpu-metrics.sh` | GPU util %, memory, temperature, power per GPU per pod | `NAMESPACE`, in-cluster nvidia-smi |
| `k8s-metrics.sh` | kubectl top (cpu/mem) + restart counts + phase + events at end | `NAMESPACE` |

## Known limitations

- **Server-action workflows not driven directly.** Three of the four
  Formbricks AI workflows (translation, chart-gen, example-responses) are
  Next.js Server Actions, not public HTTP endpoints. We exercise them by
  hitting vLLM directly with the same prompt shapes Formbricks would send
  — that measures the runtime under realistic load but does not include
  the web-pod CPU/memory overhead for those three. Web-pod overhead is
  measured only via the `web-survey-gen.js` scenario, which uses the real
  HTTP route.
- **Long-text translation fixtures are sparse.** Real Formbricks
  translation calls can hit hundreds of fields. Our largest fixture has 56
  fields. Numbers for "very large translation jobs" should be flagged as
  limited coverage if your real production is bigger.
- **No streaming.** Formbricks doesn't stream AI responses today; we don't
  test it. If streaming is added, add a separate `k6/web-streaming.js`.

## What gets generated per run

```
report/runs/<timestamp>/
├── start.txt / end.txt
├── translation.json / translation.log       (when applicable)
├── surveygen.json / surveygen.log
├── chartgen.json / chartgen.log
├── web.json / web.log
├── vllm-metrics.csv
├── gpu-metrics.csv
├── k8s-metrics.csv
├── k8s-events.txt
├── k8s-describe.txt
├── final-deployments.txt
├── final-top.txt
└── cold-warm.json / cold-cold.json          (when applicable)
```

Then fill `report/template.md` from these. Every `_TBD_` in the template
maps to a specific artifact via the table in §5 of the template itself.
