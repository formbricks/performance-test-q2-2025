import assert from "node:assert/strict";
import test from "node:test";
import { buildSummary } from "../k6/lib/summary.js";

function metric(values, thresholds) {
  return { values, thresholds };
}

test("buildSummary writes machine and human results with all requested percentiles", () => {
  const data = {
    state: { testRunDurationMs: 2000 },
    metrics: {
      checks: metric({ rate: 1 }),
      dropped_iterations: metric({ count: 0 }),
      http_req_failed: metric({ rate: 0 }, { "rate<0.01": { ok: true } }),
      http_reqs: metric({ count: 12, rate: 6 }),
      iterations: metric({ count: 6, rate: 3 }),
      public_survey_page_duration: metric({
        count: 6,
        med: 100,
        "p(90)": 150,
        "p(95)": 175,
        "p(99)": 200,
        max: 220,
      }),
      unexpected_responses: metric({ count: 0 }),
    },
  };

  const output = buildSummary(data, {
    duration: "2s",
    jsonPath: "summary.json",
    markdownPath: "summary.md",
    maxVUs: 10,
    profile: "baseline",
    rate: 3,
    runId: "eng3309-test",
    scenario: "public-survey",
  });
  const parsed = JSON.parse(output["summary.json"]);

  assert.equal(parsed.result, "PASS");
  assert.equal(parsed.http_reqs_per_second, 6);
  assert.equal(parsed.endpoints.public_survey_page_duration.p90_ms, 150);
  assert.match(output["summary.md"], /p50 ms \| p90 ms \| p95 ms \| p99 ms/);
});

test("buildSummary fails when any k6 threshold failed", () => {
  const output = buildSummary(
    {
      metrics: {
        checks: metric({ rate: 0.5 }, { "rate>=0.99": { ok: false } }),
        dropped_iterations: metric({ count: 0 }),
        http_req_failed: metric({ rate: 0 }),
        http_reqs: metric({ count: 1, rate: 1 }),
        iterations: metric({ count: 1, rate: 1 }),
        unexpected_responses: metric({ count: 0 }),
      },
    },
    {
      duration: null,
      jsonPath: "summary.json",
      maxVUs: 1,
      profile: "smoke",
      rate: 1,
      runId: "eng3309-test",
      scenario: "public-read",
    },
  );
  const parsed = JSON.parse(output["summary.json"]);

  assert.equal(parsed.result, "FAIL");
  assert.deepEqual(parsed.failed_thresholds, ["checks: rate>=0.99"]);
});
