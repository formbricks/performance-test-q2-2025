// Scenario: web-mediated survey-generation.
//
// Drives the one Formbricks AI feature that is reachable via a real HTTP
// route: POST /api/v3/surveys/generate. The web app validates the prompt,
// calls vLLM through its OpenAI-compatible client, parses the response
// against the Zod schema, and returns the survey draft.
//
// This is the only scenario in this suite that measures Next.js/web-pod
// overhead in addition to LLM latency. The other three scenarios isolate
// vLLM.
//
// Production rate limit on this route is 10 requests / minute / organization
// (rateLimitConfigs.api.v3SurveyGenerate). At rates above ~0.16 rps you will
// see 429s — that is expected, and `rate_limited` is recorded separately
// from other errors so the report can distinguish them.
//
// Required env:
//   FORMBRICKS_URL          — e.g. https://app.staging.formbricks.com
//   FORMBRICKS_API_KEY      — fbk_... management API key with readWrite on
//                             the target workspace
//   FORMBRICKS_WORKSPACE_ID — workspace id the API key has access to
//
// Optional env:
//   PROFILE   — smoke | baseline | mid | burst | stress (default: smoke)
//   TIMEOUT   — k6 HTTP timeout, default 60s (Formbricks's Next.js layer
//               caps at ~30s; pad to capture timeout failures)
//   RATE / DURATION / MAX_VUS — override constant-arrival profiles

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { pickSurveyGenFixture, surveyGenFixtureCount } from "./lib/payloads.js";
import { buildSummary } from "./lib/summary.js";

const FORMBRICKS_URL = __ENV.FORMBRICKS_URL;
const FORMBRICKS_API_KEY = __ENV.FORMBRICKS_API_KEY;
const FORMBRICKS_WORKSPACE_ID = __ENV.FORMBRICKS_WORKSPACE_ID;
const PROFILE = __ENV.PROFILE || "smoke";
const TIMEOUT = __ENV.TIMEOUT || "60s";
const RATE = __ENV.RATE ? Number(__ENV.RATE) : null;
const DURATION = __ENV.DURATION || null;
const MAX_VUS = __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : null;

if (!FORMBRICKS_URL) throw new Error("FORMBRICKS_URL is required");
if (!FORMBRICKS_API_KEY) throw new Error("FORMBRICKS_API_KEY is required");
if (!FORMBRICKS_WORKSPACE_ID) throw new Error("FORMBRICKS_WORKSPACE_ID is required");
if (surveyGenFixtureCount() === 0) throw new Error("no surveygen fixtures loaded");

const latencyOk = new Trend("latency_ok", true);
const generated = new Rate("generated_ok");
const rateLimited = new Rate("rate_limited");
const aiUnavailable = new Rate("ai_unavailable");
const badGateway = new Rate("bad_gateway");
const otherErrors = new Counter("other_errors");

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
      smoke: { executor: "per-vu-iterations", vus: 1, iterations: 3, maxDuration: "3m" },
    },
  },
  // Below the per-org rate limit. Used to characterize warm steady-state.
  baseline: { scenarios: { baseline: constantArrival(RATE ?? 0.1, DURATION ?? "10m", MAX_VUS ?? 10) } },
  // At the per-org rate limit. Expect ~0% 429 if the request rate is tuned
  // exactly at 10/min; bump RATE up to deliberately exercise the limiter.
  mid: { scenarios: { mid: constantArrival(RATE ?? 0.16, DURATION ?? "10m", MAX_VUS ?? 10) } },
  // Deliberately above the limit. The headline metric for this profile is
  // rate_limited — confirms the limiter does what we expect under spikes.
  burst: {
    scenarios: {
      burst: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: 10,
        maxVUs: MAX_VUS ?? 50,
        stages: [
          { target: 0.1, duration: "1m" },
          { target: 2, duration: "30s" },
          { target: 2, duration: "2m" },
          { target: 0.1, duration: "30s" },
          { target: 0.1, duration: "2m" },
        ],
      },
    },
  },
  // Push hard. We expect mostly 429s; surface anything else (timeouts, 5xx).
  stress: {
    scenarios: {
      stress: {
        executor: "ramping-arrival-rate",
        startRate: 0.5,
        timeUnit: "1s",
        preAllocatedVUs: 20,
        maxVUs: MAX_VUS ?? 100,
        stages: [
          { target: 1, duration: "1m" },
          { target: 5, duration: "1m" },
          { target: 10, duration: "1m" },
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
    // Don't fail the run when rate-limited responses dominate the mix —
    // they are the expected outcome of the burst/stress profiles.
    other_errors: ["count==0"],
  },
};

export default function () {
  const fixture = pickSurveyGenFixture();
  const body = {
    workspaceId: FORMBRICKS_WORKSPACE_ID,
    prompt: fixture.prompt,
    type: "link",
    language: fixture.preferred_language,
  };

  const res = http.post(`${FORMBRICKS_URL}/api/v3/surveys/generate`, JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": FORMBRICKS_API_KEY,
    },
    timeout: TIMEOUT,
    tags: { endpoint: "v3_surveys_generate", fixture: fixture.name, workflow: "survey_gen_web" },
  });

  // Classify the response. The web layer returns documented status codes for
  // each failure class — see route.ts.
  const status = res.status;
  if (status === 200 || status === 201) {
    generated.add(true);
    rateLimited.add(false);
    aiUnavailable.add(false);
    badGateway.add(false);
    latencyOk.add(res.timings.duration);
  } else if (status === 429) {
    generated.add(false);
    rateLimited.add(true);
    aiUnavailable.add(false);
    badGateway.add(false);
  } else if (status === 503) {
    generated.add(false);
    rateLimited.add(false);
    aiUnavailable.add(true);
    badGateway.add(false);
  } else if (status === 502) {
    generated.add(false);
    rateLimited.add(false);
    aiUnavailable.add(false);
    badGateway.add(true);
  } else {
    generated.add(false);
    rateLimited.add(false);
    aiUnavailable.add(false);
    badGateway.add(false);
    otherErrors.add(1);
  }

  check(res, {
    "no surprise status": (r) =>
      r.status === 200 ||
      r.status === 201 ||
      r.status === 400 ||
      r.status === 422 ||
      r.status === 429 ||
      r.status === 502 ||
      r.status === 503,
  });
}

export function handleSummary(data) {
  return buildSummary(data, {
    scenario: `web-survey-gen/${PROFILE}`,
    criteria: {},
  });
}
