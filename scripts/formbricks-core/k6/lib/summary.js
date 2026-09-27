const ENDPOINT_METRICS = {
  public_environment_duration: "Public environment read",
  management_surveys_duration: "Management survey list",
  response_create_duration: "Response create",
  survey_create_duration: "Survey create",
  survey_get_duration: "Survey get",
  survey_delete_duration: "Survey delete",
};

function metricValue(metrics, name, stat) {
  return metrics[name]?.values?.[stat] ?? null;
}

function formatNumber(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(2);
}

function endpointSummary(metrics) {
  return Object.fromEntries(
    Object.entries(ENDPOINT_METRICS)
      .map(([metric, label]) => [
        metric,
        {
          label,
          count: metricValue(metrics, metric, "count"),
          p50_ms: metricValue(metrics, metric, "med"),
          p95_ms: metricValue(metrics, metric, "p(95)"),
          p99_ms: metricValue(metrics, metric, "p(99)"),
          max_ms: metricValue(metrics, metric, "max"),
        },
      ])
      .filter(([, value]) => value.count !== null && value.count > 0),
  );
}

function markdownSummary(summary) {
  const rows = Object.values(summary.endpoints)
    .map(
      (endpoint) =>
        `| ${endpoint.label} | ${endpoint.count} | ${formatNumber(endpoint.p50_ms)} | ${formatNumber(endpoint.p95_ms)} | ${formatNumber(endpoint.p99_ms)} | ${formatNumber(endpoint.max_ms)} |`,
    )
    .join("\n");

  return `# k6 result: ${summary.scenario}/${summary.profile}

- Run ID: \`${summary.run_id}\`
- Result: **${summary.result}**
- Requests: ${summary.http_reqs}
- HTTP failure rate: ${formatNumber(summary.http_req_failed_rate * 100)}%
- Check pass rate: ${formatNumber(summary.check_rate * 100)}%
- Dropped iterations: ${summary.dropped_iterations}
- Unexpected responses: ${summary.unexpected_responses}

| Endpoint | Count | p50 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows || "| No endpoint data | 0 | n/a | n/a | n/a | n/a |"}
`;
}

export function buildSummary(data, { runId, scenario, profile, markdownPath }) {
  const metrics = data.metrics;
  const summary = {
    run_id: runId,
    scenario,
    profile,
    duration_ms: data.state?.testRunDurationMs ?? null,
    http_reqs: metricValue(metrics, "http_reqs", "count") ?? 0,
    http_req_failed_rate: metricValue(metrics, "http_req_failed", "rate") ?? 0,
    check_rate: metricValue(metrics, "checks", "rate") ?? 0,
    dropped_iterations: metricValue(metrics, "dropped_iterations", "count") ?? 0,
    unexpected_responses: metricValue(metrics, "unexpected_responses", "count") ?? 0,
    endpoints: endpointSummary(metrics),
  };

  summary.result =
    summary.http_req_failed_rate < 0.01 &&
    summary.check_rate >= 0.99 &&
    summary.dropped_iterations === 0 &&
    summary.unexpected_responses === 0
      ? "PASS"
      : "FAIL";

  const outputs = {
    stdout: `FORMBRICKS_PERF_SUMMARY=${JSON.stringify(summary)}\n`,
  };
  if (markdownPath) {
    outputs[markdownPath] = markdownSummary(summary);
  }
  return outputs;
}
