// Structured PASS/FAIL summary emitter, modeled on scripts/rate-limit/k6/.
//
// Produces a machine-readable JSON block on the last line of stdout so wrapper
// scripts can grep for it without parsing the whole k6 output.

import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

export function buildSummary(data, { scenario, criteria }) {
  const metrics = data.metrics;
  const get = (name, stat) =>
    metrics[name] && metrics[name].values && metrics[name].values[stat] != null
      ? metrics[name].values[stat]
      : null;

  const summary = {
    scenario,
    duration_ms: data.state ? data.state.testRunDurationMs : null,
    http_reqs: get("http_reqs", "count") || 0,
    http_req_failed_rate: get("http_req_failed", "rate") || 0,
    http_req_duration: {
      p50: get("http_req_duration", "med"),
      p95: get("http_req_duration", "p(95)"),
      p99: get("http_req_duration", "p(99)"),
      avg: get("http_req_duration", "avg"),
    },
    checks: {
      passes: get("checks", "passes") || 0,
      fails: get("checks", "fails") || 0,
    },
  };

  // Per-length-bucket latency trends if the scenario records them.
  const buckets = ["short", "medium", "long"];
  summary.by_length = Object.fromEntries(
    buckets
      .map((b) => [
        b,
        {
          count: get(`latency_${b}`, "count"),
          p50: get(`latency_${b}`, "med"),
          p95: get(`latency_${b}`, "p(95)"),
          p99: get(`latency_${b}`, "p(99)"),
        },
      ])
      .filter(([, v]) => v.count != null),
  );

  const failures = [];
  const checkCriterion = (label, value, threshold, cmp) => {
    if (value == null) {
      failures.push(`${label}: missing`);
      return;
    }
    const ok = cmp(value, threshold);
    if (!ok) failures.push(`${label}: ${value} vs ${threshold}`);
  };

  if (criteria) {
    if (criteria.maxFailRate != null) {
      checkCriterion(
        "http_req_failed_rate",
        summary.http_req_failed_rate,
        criteria.maxFailRate,
        (a, b) => a <= b,
      );
    }
    if (criteria.maxP95Ms != null) {
      checkCriterion("p95_ms", summary.http_req_duration.p95, criteria.maxP95Ms, (a, b) => a <= b);
    }
    if (criteria.maxP99Ms != null) {
      checkCriterion("p99_ms", summary.http_req_duration.p99, criteria.maxP99Ms, (a, b) => a <= b);
    }
    if (criteria.minChecks != null) {
      checkCriterion("checks_passes", summary.checks.passes, criteria.minChecks, (a, b) => a >= b);
    }
  }

  summary.result = failures.length === 0 ? "PASS" : "FAIL";
  summary.failures = failures;

  return {
    stdout: textSummary(data, { indent: " ", enableColors: false }) + "\n" + JSON.stringify(summary) + "\n",
  };
}
