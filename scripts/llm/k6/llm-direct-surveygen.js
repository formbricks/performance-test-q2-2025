// Scenario: direct LLM /v1/chat/completions, survey-generation workload.
//
// Decode-heavy. Short prompt (~500 tokens system + a few sentences user) →
// large structured survey JSON (~3000 tokens). This shape stresses the GPU's
// decode loop, not prefill.
//
// Mirrors the prompt + decoding parameters that
// apps/web/app/api/v3/surveys/generate/service.ts uses in production:
//   - temperature 0.2
//   - max_tokens 3000
//   - structured output enforced via response_format
//
// Required env: LLM_URL, MODEL
// Optional env: LLM_API_KEY, PROFILE, RESPONSE_FORMAT, TIMEOUT, MAX_TOKENS,
//   TEMPERATURE, RATE, DURATION, MAX_VUS

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import {
  pickSurveyGenFixture,
  buildSurveyGenMessages,
  buildChatCompletionBody,
  SURVEYGEN_REQUIRED_KEYS,
} from "./lib/payloads.js";
import { validateStructuredResponse, tokenUsage } from "./lib/validators.js";
import { buildSummary } from "./lib/summary.js";

const LLM_URL = __ENV.LLM_URL;
const MODEL = __ENV.MODEL;
const LLM_API_KEY = __ENV.LLM_API_KEY || "";
const PROFILE = __ENV.PROFILE || "smoke";
const RESPONSE_FORMAT = __ENV.RESPONSE_FORMAT || "json_object";
const TIMEOUT = __ENV.TIMEOUT || "120s";
const MAX_TOKENS = Number(__ENV.MAX_TOKENS || 3000);
const TEMPERATURE = Number(__ENV.TEMPERATURE != null ? __ENV.TEMPERATURE : 0.2);
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
    preAllocatedVUs: Math.max(2, Math.ceil(rate * 6)),
    maxVUs,
  };
}

const PROFILES = {
  smoke: {
    scenarios: {
      smoke: { executor: "per-vu-iterations", vus: 1, iterations: 3, maxDuration: "5m" },
    },
  },
  baseline: { scenarios: { baseline: constantArrival(RATE ?? 0.1, DURATION ?? "5m", MAX_VUS ?? 10) } },
  mid: { scenarios: { mid: constantArrival(RATE ?? 0.5, DURATION ?? "5m", MAX_VUS ?? 30) } },
  burst: {
    scenarios: {
      burst: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: 10,
        maxVUs: MAX_VUS ?? 100,
        stages: [
          { target: 0.2, duration: "1m" },
          { target: 3, duration: "30s" },
          { target: 3, duration: "2m" },
          { target: 0.2, duration: "30s" },
          { target: 0.2, duration: "1m" },
        ],
      },
    },
  },
  stress: {
    scenarios: {
      stress: {
        executor: "ramping-arrival-rate",
        startRate: 0.1,
        timeUnit: "1s",
        preAllocatedVUs: 20,
        maxVUs: MAX_VUS ?? 200,
        stages: [
          { target: 0.5, duration: "2m" },
          { target: 1, duration: "2m" },
          { target: 2, duration: "2m" },
          { target: 4, duration: "2m" },
          { target: 8, duration: "2m" },
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
  const fixture = pickSurveyGenFixture();
  const messages = buildSurveyGenMessages(fixture);
  const body = buildChatCompletionBody({
    model: MODEL,
    messages,
    expectedKeys: SURVEYGEN_REQUIRED_KEYS,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    responseFormat: RESPONSE_FORMAT === "none" ? null : RESPONSE_FORMAT,
  });

  const headers = { "Content-Type": "application/json" };
  if (LLM_API_KEY) headers.Authorization = `Bearer ${LLM_API_KEY}`;

  const res = http.post(`${LLM_URL}/chat/completions`, JSON.stringify(body), {
    headers,
    timeout: TIMEOUT,
    tags: { endpoint: "chat_completions", fixture: fixture.name, workflow: "survey_gen" },
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
    ? validateStructuredResponse(parsed, SURVEYGEN_REQUIRED_KEYS)
    : { parsed: false, valid: false, missingKeys: SURVEYGEN_REQUIRED_KEYS.length };
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
    scenario: `llm-direct-surveygen/${PROFILE}`,
    criteria: { maxFailRate: 0.05, minSchemaValidRate: 0.9 },
  });
}
