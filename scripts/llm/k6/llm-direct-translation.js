// Scenario: direct LLM /v1/chat/completions, translation workload.
//
// Hits the LLM endpoint with translation prompts shaped exactly the way
// Formbricks's translate-fields.ts builds them. No Formbricks web in the path
// — this isolates the runtime ceiling for the translation workload.
//
// Required env:
//   LLM_URL    — base URL ending in /v1 (e.g. http://vllm.svc.cluster.local:8000/v1)
//   MODEL      — model name as the server knows it (e.g. "Qwen/Qwen2.5-7B-Instruct")
//
// Optional env:
//   LLM_API_KEY      — bearer token; omit if the server is unauthenticated
//   PROFILE          — smoke | baseline | mid | burst | stress (default: smoke)
//   RESPONSE_FORMAT  — json_object (default) | json_schema (vLLM guided
//                      decoding) | none
//   BUCKET           — small | medium | large (default: any)
//   TIMEOUT          — k6 HTTP timeout, default 120s
//   MAX_TOKENS       — server-side cap on completion length, default 8192
//   TEMPERATURE      — default 0 (matches Formbricks production)
//   RATE / DURATION / MAX_VUS — override constant-arrival profiles
//
// Run:
//   k6 run -e LLM_URL=http://localhost:8000/v1 -e MODEL=Qwen/Qwen2.5-7B-Instruct \
//          -e PROFILE=smoke k6/llm-direct-translation.js

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import {
  pickTranslationFixture,
  buildTranslationMessages,
  buildChatCompletionBody,
} from "./lib/payloads.js";
import { validateTranslationResponse, tokenUsage } from "./lib/validators.js";
import { buildSummary } from "./lib/summary.js";

const LLM_URL = __ENV.LLM_URL;
const MODEL = __ENV.MODEL;
const LLM_API_KEY = __ENV.LLM_API_KEY || "";
const PROFILE = __ENV.PROFILE || "smoke";
const RESPONSE_FORMAT = __ENV.RESPONSE_FORMAT || "json_object";
const BUCKET = __ENV.BUCKET || null;
const TIMEOUT = __ENV.TIMEOUT || "120s";
const MAX_TOKENS = Number(__ENV.MAX_TOKENS || 8192);
const TEMPERATURE = Number(__ENV.TEMPERATURE || 0);
const RATE = __ENV.RATE ? Number(__ENV.RATE) : null;
const DURATION = __ENV.DURATION || null;
const MAX_VUS = __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : null;

if (!LLM_URL) throw new Error("LLM_URL is required");
if (!MODEL) throw new Error("MODEL is required");

const promptTokens = new Trend("prompt_tokens");
const completionTokens = new Trend("completion_tokens");
const tokensPerSec = new Trend("tokens_per_sec");
const latencySmall = new Trend("latency_small", true);
const latencyMedium = new Trend("latency_medium", true);
const latencyLarge = new Trend("latency_large", true);
const schemaValid = new Rate("schema_valid");
const malformedJson = new Rate("malformed_json");
const missingKeys = new Rate("missing_keys");

function constantArrival(rate, duration, maxVUs) {
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Math.max(2, Math.ceil(rate * 4)),
    maxVUs,
  };
}

const PROFILES = {
  smoke: {
    scenarios: {
      smoke: {
        executor: "per-vu-iterations",
        vus: 1,
        iterations: 3,
        maxDuration: "3m",
      },
    },
  },
  baseline: {
    scenarios: {
      baseline: constantArrival(RATE ?? 0.2, DURATION ?? "5m", MAX_VUS ?? 10),
    },
  },
  mid: {
    scenarios: {
      mid: constantArrival(RATE ?? 1, DURATION ?? "5m", MAX_VUS ?? 30),
    },
  },
  burst: {
    scenarios: {
      burst: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: 10,
        maxVUs: MAX_VUS ?? 100,
        stages: [
          { target: 0.5, duration: "1m" },
          { target: 5, duration: "30s" },
          { target: 5, duration: "2m" },
          { target: 0.5, duration: "30s" },
          { target: 0.5, duration: "1m" },
        ],
      },
    },
  },
  stress: {
    scenarios: {
      stress: {
        executor: "ramping-arrival-rate",
        startRate: 0.2,
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
    schema_valid: ["rate>0.95"],
  },
};

export default function () {
  const fixture = pickTranslationFixture(BUCKET);
  const messages = buildTranslationMessages(fixture);
  const body = buildChatCompletionBody({
    model: MODEL,
    messages,
    expectedKeys: messages.expectedKeys,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    responseFormat: RESPONSE_FORMAT === "none" ? null : RESPONSE_FORMAT,
  });

  const headers = { "Content-Type": "application/json" };
  if (LLM_API_KEY) headers.Authorization = `Bearer ${LLM_API_KEY}`;

  const res = http.post(`${LLM_URL}/chat/completions`, JSON.stringify(body), {
    headers,
    timeout: TIMEOUT,
    tags: {
      endpoint: "chat_completions",
      fixture: fixture.name,
      size_bucket: fixture.size_bucket,
      target_lang: fixture.target_language,
    },
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
    } catch (_) {
      parsed = null;
    }
  }

  const validation = parsed
    ? validateTranslationResponse(parsed, messages.expectedKeys)
    : { parsed: false, valid: false, missingKeys: messages.expectedKeys.length };
  schemaValid.add(validation.valid);
  malformedJson.add(!validation.parsed);
  missingKeys.add(validation.parsed && validation.missingKeys > 0);

  const usage = parsed ? tokenUsage(parsed) : { prompt: 0, completion: 0, total: 0 };
  if (usage.prompt > 0) promptTokens.add(usage.prompt);
  if (usage.completion > 0) completionTokens.add(usage.completion);
  if (usage.completion > 0 && res.timings.duration > 0) {
    tokensPerSec.add(usage.completion / (res.timings.duration / 1000));
  }

  const dur = res.timings.duration;
  const bucket = fixture.size_bucket;
  if (bucket === "small") latencySmall.add(dur);
  else if (bucket === "medium") latencyMedium.add(dur);
  else latencyLarge.add(dur);
}

export function handleSummary(data) {
  return buildSummary(data, {
    scenario: `llm-direct-translation/${PROFILE}`,
    criteria: { maxFailRate: 0.05, minSchemaValidRate: 0.95 },
  });
}
