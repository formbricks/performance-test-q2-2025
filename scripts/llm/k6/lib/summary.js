// Structured PASS/FAIL summary emitter — mirrors scripts/embeddings/k6/lib/summary.js.

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
    tokens: {
      prompt_p50: get("prompt_tokens", "med"),
      prompt_p95: get("prompt_tokens", "p(95)"),
      completion_p50: get("completion_tokens", "med"),
      completion_p95: get("completion_tokens", "p(95)"),
      tokens_per_sec_p50: get("tokens_per_sec", "med"),
      tokens_per_sec_p95: get("tokens_per_sec", "p(95)"),
    },
    schema: {
      valid_rate: get("schema_valid", "rate"),
      malformed_json_rate: get("malformed_json", "rate"),
      missing_keys_rate: get("missing_keys", "rate"),
    },
    checks: {
      passes: get("checks", "passes") || 0,
      fails: get("checks", "fails") || 0,
    },
  };

  const buckets = ["small", "medium", "large"];
  summary.by_size = Object.fromEntries(
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
    if (!cmp(value, threshold)) failures.push(`${label}: ${value} vs ${threshold}`);
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
    if (criteria.minSchemaValidRate != null) {
      checkCriterion(
        "schema_valid_rate",
        summary.schema.valid_rate,
        criteria.minSchemaValidRate,
        (a, b) => a >= b,
      );
    }
  }

  summary.result = failures.length === 0 ? "PASS" : "FAIL";
  summary.failures = failures;

  return {
    stdout:
      textSummary(data, { indent: " ", enableColors: false }) +
      "\n" +
      JSON.stringify(summary) +
      "\n",
  };
}
