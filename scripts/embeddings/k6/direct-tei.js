// Scenario 1: direct TEI baseline.
//
// Hits the TEI /v1/embeddings endpoint with no Hub in the request path. Mixes
// short/medium/long inputs drawn from the augmented Hub dataset, records
// p50/p95/p99 per length bucket, and validates that the response embedding is
// 768-dimensional.
//
// Required env:
//   TEI_URL      — base URL ending in /v1 (e.g. http://tei.embeddings.svc/v1)
//   TEI_API_KEY  — bearer token; set to anything if TEI auth is disabled
//   MODEL        — model name used by TEI (Alibaba-NLP/gte-multilingual-base)
//
// Optional env:
//   PROFILE              — smoke | latency | sweep | burst (default: smoke)
//   TEI_USE_QA_PREFIX    — "true" (default) | "false"
//   RATE/DURATION/MAX_VUS — override the latency profile shape
//
// Run:
//   k6 run -e TEI_URL=... -e TEI_API_KEY=... -e MODEL=... -e PROFILE=latency \
//          k6/direct-tei.js

import http from "k6/http";
import { check, fail } from "k6";
import { Trend, Rate } from "k6/metrics";
import { pickPayload, teiBody, lengthBucket } from "./lib/payloads.js";
import { buildSummary } from "./lib/summary.js";

const TEI_URL = __ENV.TEI_URL;
const TEI_API_KEY = __ENV.TEI_API_KEY || "";
const MODEL = __ENV.MODEL || "Alibaba-NLP/gte-multilingual-base";
const USE_QA_PREFIX = (__ENV.TEI_USE_QA_PREFIX || "true").toLowerCase() === "true";
const PROFILE = __ENV.PROFILE || "smoke";
const RATE = __ENV.RATE ? Number(__ENV.RATE) : null;
const DURATION = __ENV.DURATION || null;
const MAX_VUS = __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : null;

if (!TEI_URL) throw new Error("TEI_URL is required");

const latencyShort = new Trend("latency_short", true);
const latencyMedium = new Trend("latency_medium", true);
const latencyLong = new Trend("latency_long", true);
const dimMismatch = new Rate("dim_mismatch");

function constantArrival(rate, duration, maxVUs) {
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Math.max(2, Math.ceil(rate)),
    maxVUs,
  };
}

const PROFILES = {
  smoke: {
    scenarios: {
      smoke: {
        executor: "per-vu-iterations",
        vus: 1,
        iterations: 6,
        maxDuration: "30s",
      },
    },
  },
  latency: {
    scenarios: {
      warm_serial: constantArrival(RATE ?? 2, DURATION ?? "2m", MAX_VUS ?? 20),
    },
  },
  sweep: {
    scenarios: {
      ramp: {
        executor: "ramping-arrival-rate",
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: 5,
        maxVUs: 100,
        stages: [
          { target: 5, duration: "1m" },
          { target: 10, duration: "1m" },
          { target: 20, duration: "1m" },
          { target: 40, duration: "1m" },
          { target: 60, duration: "1m" },
          { target: 0, duration: "30s" },
        ],
      },
    },
  },
  burst: {
    scenarios: {
      burst: {
        executor: "ramping-arrival-rate",
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: 50,
        maxVUs: 200,
        stages: [
          { target: 5, duration: "30s" },
          { target: 100, duration: "10s" },
          { target: 100, duration: "1m" },
          { target: 5, duration: "10s" },
          { target: 5, duration: "30s" },
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
    http_req_failed: ["rate<0.01"],
    dim_mismatch: ["rate==0"],
  },
};

export default function () {
  const payload = pickPayload("all");
  const bucket = lengthBucket(payload.value_text);
  const body = teiBody(payload, MODEL, USE_QA_PREFIX);

  const res = http.post(`${TEI_URL}/embeddings`, JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEI_API_KEY}`,
    },
    tags: { endpoint: "tei_embeddings", length_bucket: bucket },
  });

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has embedding": (r) => {
      try {
        const j = r.json();
        return j && j.data && j.data[0] && Array.isArray(j.data[0].embedding);
      } catch (_) {
        return false;
      }
    },
  });

  if (ok) {
    try {
      const dim = res.json().data[0].embedding.length;
      dimMismatch.add(dim !== 768);
    } catch (_) {
      dimMismatch.add(true);
    }
  }

  const dur = res.timings.duration;
  if (bucket === "short") latencyShort.add(dur);
  else if (bucket === "medium") latencyMedium.add(dur);
  else latencyLong.add(dur);
}

export function handleSummary(data) {
  return buildSummary(data, {
    scenario: `direct-tei/${PROFILE}`,
    criteria: { maxFailRate: 0.01 },
  });
}
