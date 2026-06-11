// Scenario: direct LLM /v1/chat/completions, chart-generation workload.
//
// Prefill-heavy. Large schema context (~2000 tokens of available
// measures/dimensions/chart types) plus a short natural-language prompt →
// small structured query (~200 tokens). This shape stresses the GPU's
// prefill (one big forward pass), not decode.
//
// Mirrors the prompt + decoding parameters that
// apps/web/modules/ee/analysis/charts/actions.ts uses in production:
//   - temperature 0
//   - small output
//   - structured output enforced via response_format
//
// Required env: LLM_URL, MODEL
// Optional env: LLM_API_KEY, PROFILE, RESPONSE_FORMAT, TIMEOUT, MAX_TOKENS,
//   TEMPERATURE, RATE, DURATION, MAX_VUS

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import {
  pickChartGenFixture,
  buildChartGenMessages,
  buildChatCompletionBody,
  CHARTGEN_REQUIRED_KEYS,
} from "./lib/payloads.js";
import { validateStructuredResponse, tokenUsage } from "./lib/validators.js";
import { buildSummary } from "./lib/summary.js";

const LLM_URL = __ENV.LLM_URL;
const MODEL = __ENV.MODEL;
const LLM_API_KEY = __ENV.LLM_API_KEY || "";
const PROFILE = __ENV.PROFILE || "smoke";
const RESPONSE_FORMAT = __ENV.RESPONSE_FORMAT || "json_object";
const TIMEOUT = __ENV.TIMEOUT || "120s";
const MAX_TOKENS = Number(__ENV.MAX_TOKENS || 1024);
const TEMPERATURE = Number(__ENV.TEMPERATURE || 0);
const RATE = __ENV.RATE ? Number(__ENV.RATE) : null;
const DURATION = __ENV.DURATION || null;
const MAX_VUS = __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : null;

if (!LLM_URL) throw new Error("LLM_URL is required");
if (!MODEL) throw new Error("MODEL is required");

const promptTokens = new Trend("prompt_tokens");
const completionTokens = new Trend("completion_tokens");
const tokensPerSec = new Trend("tokens_per_sec");
const schemaValid = new Rate("schema_valid");
const malformedJson = new Rate("malformed_json");
const missingKeys = new Rate("missing_keys");

function constantArrival(rate, duration, maxVUs) {
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Math.max(2, Math.ceil(rate * 3)),
    maxVUs,
  };
}

const PROFILES = {
  smoke: {
    scenarios: {
      smoke: { executor: "per-vu-iterations", vus: 1, iterations: 3, maxDuration: "3m" },
    },
  },
  baseline: { scenarios: { baseline: constantArrival(RATE ?? 0.5, DURATION ?? "5m", MAX_VUS ?? 10) } },
  mid: { scenarios: { mid: constantArrival(RATE ?? 2, DURATION ?? "5m", MAX_VUS ?? 30) } },
  burst: {
    scenarios: {
      burst: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: 10,
        maxVUs: MAX_VUS ?? 100,
        stages: [
          { target: 1, duration: "1m" },
          { target: 10, duration: "30s" },
          { target: 10, duration: "2m" },
          { target: 1, duration: "30s" },
          { target: 1, duration: "1m" },
        ],
      },
    },
  },
  stress: {
    scenarios: {
      stress: {
        executor: "ramping-arrival-rate",
        startRate: 0.5,
        timeUnit: "1s",
        preAllocatedVUs: 20,
        maxVUs: MAX_VUS ?? 200,
        stages: [
          { target: 1, duration: "2m" },
          { target: 2, duration: "2m" },
          { target: 4, duration: "2m" },
          { target: 8, duration: "2m" },
          { target: 16, duration: "2m" },
          { target: 0, duration: "30s" },
        ],
      },
    },
  },
};

const profile = PROFILES[PROFILE];
if (!profile) throw new Error(`unknown PROFILE: ${PROFILE}`);

export const options = {
  ...profile,
  thresholds: {
    http_req_failed: ["rate<0.05"],
    schema_valid: ["rate>0.9"],
  },
};

export default function () {
  const fixture = pickChartGenFixture();
  const messages = buildChartGenMessages(fixture);
  const body = buildChatCompletionBody({
    model: MODEL,
    messages,
    expectedKeys: CHARTGEN_REQUIRED_KEYS,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    responseFormat: RESPONSE_FORMAT === "none" ? null : RESPONSE_FORMAT,
  });

  const headers = { "Content-Type": "application/json" };
  if (LLM_API_KEY) headers.Authorization = `Bearer ${LLM_API_KEY}`;

  const res = http.post(`${LLM_URL}/chat/completions`, JSON.stringify(body), {
    headers,
    timeout: TIMEOUT,
    tags: { endpoint: "chat_completions", fixture: fixture.name, workflow: "chart_gen" },
  });

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has choices": (r) => {
      try {
        const j = r.json();
        return j && Array.isArray(j.choices) && j.choices.length > 0;
      } catch (_) {
        return false;
      }
    },
  });

  let parsed = null;
  if (ok) {
    try {
      parsed = res.json();
    } catch (_) {}
  }

  const v = parsed
    ? validateStructuredResponse(parsed, CHARTGEN_REQUIRED_KEYS)
    : { parsed: false, valid: false, missingKeys: CHARTGEN_REQUIRED_KEYS.length };
  schemaValid.add(v.valid);
  malformedJson.add(!v.parsed);
  missingKeys.add(v.parsed && v.missingKeys > 0);

  const usage = parsed ? tokenUsage(parsed) : { prompt: 0, completion: 0 };
  if (usage.prompt > 0) promptTokens.add(usage.prompt);
  if (usage.completion > 0) completionTokens.add(usage.completion);
  if (usage.completion > 0 && res.timings.duration > 0) {
    tokensPerSec.add(usage.completion / (res.timings.duration / 1000));
  }
}

export function handleSummary(data) {
  return buildSummary(data, {
    scenario: `llm-direct-chartgen/${PROFILE}`,
    criteria: { maxFailRate: 0.05, minSchemaValidRate: 0.9 },
  });
}
