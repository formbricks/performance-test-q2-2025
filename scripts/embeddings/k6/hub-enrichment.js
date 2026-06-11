// Scenario 2: Hub async enrichment path.
//
// POSTs feedback records into Hub at a steady or bursty rate. Each ingest
// returns synchronously after Hub writes the record and enqueues a River
// job; the actual embedding work happens out-of-band on hub-worker.
//
// This script records INGEST latency only. End-to-end embedding latency
// (record-created → embedding-persisted) is captured by the SQL collectors
// alongside this run.
//
// Required env:
//   HUB_URL       — Hub base URL (e.g. http://hub-api.svc.cluster.local:8080)
//   HUB_API_KEY   — bearer token
//
// Optional env:
//   TENANT_ID     — defaults to formbricks-hub-test-tenant
//   PROFILE       — smoke | baseline | mid | burst (default: smoke)
//   RATE          — override constant rate (req/s) for baseline/mid
//   DURATION      — override duration (e.g. "10m") for baseline/mid
//   MAX_VUS       — override maxVUs for baseline/mid
//   BUCKET        — short | medium | long | all (default: all)
//
// Run:
//   k6 run -e HUB_URL=... -e HUB_API_KEY=... -e PROFILE=baseline \
//          k6/hub-enrichment.js

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { pickPayload, lengthBucket } from "./lib/payloads.js";
import { buildSummary } from "./lib/summary.js";

const HUB_URL = __ENV.HUB_URL;
const HUB_API_KEY = __ENV.HUB_API_KEY;
const TENANT_ID = __ENV.TENANT_ID || "formbricks-hub-test-tenant";
const PROFILE = __ENV.PROFILE || "smoke";
const BUCKET = __ENV.BUCKET || "all";

if (!HUB_URL) throw new Error("HUB_URL is required");
if (!HUB_API_KEY) throw new Error("HUB_API_KEY is required");

const latencyShort = new Trend("latency_short", true);
const latencyMedium = new Trend("latency_medium", true);
const latencyLong = new Trend("latency_long", true);

function constantArrival(rate, duration, maxVUs) {
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Math.max(2, Math.ceil(rate / 2)),
    maxVUs,
  };
}

const RATE = __ENV.RATE ? Number(__ENV.RATE) : null;
const DURATION = __ENV.DURATION || null;
const MAX_VUS = __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : null;

const PROFILES = {
  smoke: {
    scenarios: {
      smoke: {
        executor: "per-vu-iterations",
        vus: 1,
        iterations: 5,
        maxDuration: "1m",
      },
    },
  },
  baseline: {
    scenarios: {
      baseline: constantArrival(RATE ?? 1, DURATION ?? "10m", MAX_VUS ?? 10),
    },
  },
  mid: {
    scenarios: {
      mid: constantArrival(RATE ?? 10, DURATION ?? "15m", MAX_VUS ?? 50),
    },
  },
  burst: {
    scenarios: {
      burst: {
        executor: "ramping-arrival-rate",
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: 20,
        maxVUs: MAX_VUS ?? 200,
        stages: [
          { target: 5, duration: "1m" },
          { target: 100, duration: "30s" },
          { target: 100, duration: "2m" },
          { target: 5, duration: "30s" },
          { target: 5, duration: "5m" },
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
    http_req_duration: ["p(95)<2000"],
  },
};

export default function () {
  const payload = pickPayload(BUCKET);
  payload.tenant_id = TENANT_ID;
  const bucket = lengthBucket(payload.value_text);

  const res = http.post(`${HUB_URL}/v1/feedback-records`, JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HUB_API_KEY}`,
    },
    tags: { endpoint: "hub_ingest", length_bucket: bucket },
  });

  check(res, {
    "status 201 or 200": (r) => r.status === 201 || r.status === 200,
    "no 5xx": (r) => r.status < 500,
  });

  const dur = res.timings.duration;
  if (bucket === "short") latencyShort.add(dur);
  else if (bucket === "medium") latencyMedium.add(dur);
  else latencyLong.add(dur);
}

export function handleSummary(data) {
  return buildSummary(data, {
    scenario: `hub-enrichment/${PROFILE}`,
    criteria: { maxFailRate: 0.01 },
  });
}
