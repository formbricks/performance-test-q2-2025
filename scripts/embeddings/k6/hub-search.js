// Scenario 3: user-facing query embedding path.
//
// POST /v1/feedback-records/search/semantic is synchronous: Hub embeds the
// query through TEI and runs a pgvector similarity lookup before responding.
// Latency here is what users feel when they search.
//
// Profiles let you measure the same endpoint in three TEI states:
//   - warm    : low concurrency, TEI warm and idle
//   - cold    : single request after a TEI rollout (use with run-cold-start.sh)
//   - busy    : steady search load — meant to be run CONCURRENTLY with the
//               enrichment scenario in another process, to measure how search
//               latency degrades when workers are hammering the same TEI pod.
//
// Required env:
//   HUB_URL       — Hub base URL
//   HUB_API_KEY   — bearer token
//
// Optional env:
//   TENANT_ID     — defaults to formbricks-hub-test-tenant
//   PROFILE       — smoke | warm | cold | busy (default: smoke)
//   LIMIT         — search result limit (default 10)
//   MIN_SCORE     — minimum similarity (default 0.5)
//
// Run:
//   k6 run -e HUB_URL=... -e HUB_API_KEY=... -e PROFILE=warm k6/hub-search.js

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { pickQuery } from "./lib/payloads.js";
import { buildSummary } from "./lib/summary.js";

const HUB_URL = __ENV.HUB_URL;
const HUB_API_KEY = __ENV.HUB_API_KEY;
const TENANT_ID = __ENV.TENANT_ID || "formbricks-hub-test-tenant";
const PROFILE = __ENV.PROFILE || "smoke";
const LIMIT = Number(__ENV.LIMIT || 10);
const MIN_SCORE = Number(__ENV.MIN_SCORE || 0.5);

if (!HUB_URL) throw new Error("HUB_URL is required");
if (!HUB_API_KEY) throw new Error("HUB_API_KEY is required");

const searchLatency = new Trend("search_latency", true);

const PROFILES = {
  smoke: {
    scenarios: {
      smoke: { executor: "per-vu-iterations", vus: 1, iterations: 6, maxDuration: "30s" },
    },
  },
  warm: {
    scenarios: {
      warm: {
        executor: "constant-arrival-rate",
        rate: 2,
        timeUnit: "1s",
        duration: "5m",
        preAllocatedVUs: 5,
        maxVUs: 20,
      },
    },
  },
  // Single-shot, used by run-cold-start.sh right after a TEI restart.
  cold: {
    scenarios: {
      cold: { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: "60s" },
    },
  },
  // Sustained background search load — run alongside hub-enrichment.js.
  busy: {
    scenarios: {
      busy: {
        executor: "constant-arrival-rate",
        rate: 5,
        timeUnit: "1s",
        duration: "15m",
        preAllocatedVUs: 10,
        maxVUs: 50,
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
    http_req_duration: ["p(95)<3000"],
  },
};

export default function () {
  const q = pickQuery(TENANT_ID);
  const url = `${HUB_URL}/v1/feedback-records/search/semantic?limit=${LIMIT}&min_score=${MIN_SCORE}`;
  const res = http.post(
    url,
    JSON.stringify({ query: q.query, tenant_id: q.tenant_id }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HUB_API_KEY}`,
      },
      tags: { endpoint: "hub_search", lang: q.lang },
    },
  );

  check(res, {
    "status 200": (r) => r.status === 200,
    "has results array": (r) => {
      try {
        const j = r.json();
        return j && (Array.isArray(j.results) || Array.isArray(j.data) || Array.isArray(j));
      } catch (_) {
        return false;
      }
    },
  });

  searchLatency.add(res.timings.duration);
}

export function handleSummary(data) {
  return buildSummary(data, {
    scenario: `hub-search/${PROFILE}`,
    criteria: { maxFailRate: 0.01 },
  });
}
