const ENDPOINT_METRICS = {
  public_environment_duration: "Public environment read",
  public_survey_page_duration: "Public survey page",
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
          p90_ms: metricValue(metrics, metric, "p(90)"),
          p95_ms: metricValue(metrics, metric, "p(95)"),
          p99_ms: metricValue(metrics, metric, "p(99)"),
          max_ms: metricValue(metrics, metric, "max"),
        },
      ])
      .filter(([, value]) => value.count !== null && value.count > 0),
  );
}

function failedThresholds(metrics) {
  const failed = [];
  for (const [metricName, metric] of Object.entries(metrics)) {
    for (const [threshold, result] of Object.entries(metric.thresholds || {})) {
      if (result.ok === false) failed.push(`${metricName}: ${threshold}`);
    }
  }
  return failed;
}

function markdownSummary(summary) {
  const rows = Object.values(summary.endpoints)
    .map(
      (endpoint) =>
        `| ${endpoint.label} | ${endpoint.count} | ${formatNumber(endpoint.p50_ms)} | ${formatNumber(endpoint.p90_ms)} | ${formatNumber(endpoint.p95_ms)} | ${formatNumber(endpoint.p99_ms)} | ${formatNumber(endpoint.max_ms)} |`,
    )
    .join("\n");
  const failed = summary.failed_thresholds.length
    ? summary.failed_thresholds.map((threshold) => `- ${threshold}`).join("\n")
    : "- None";

  return `# k6 result: ${summary.scenario}/${summary.profile}

- Run ID: \`${summary.run_id}\`
- Result: **${summary.result}**
- Configured arrival rate: ${summary.configured_rate} iterations/s
- Achieved iterations: ${summary.iterations} (${formatNumber(summary.iterations_per_second)}/s)
- HTTP requests: ${summary.http_reqs} (${formatNumber(summary.http_reqs_per_second)}/s)
- HTTP failure rate: ${formatNumber(summary.http_req_failed_rate * 100)}%
- Check pass rate: ${formatNumber(summary.check_rate * 100)}%
- Dropped iterations: ${summary.dropped_iterations}
- Unexpected responses: ${summary.unexpected_responses}

| Endpoint | Count | p50 ms | p90 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows || "| No endpoint data | 0 | n/a | n/a | n/a | n/a | n/a |"}

## Failed thresholds

${failed}
`;
}

export function buildSummary(
  data,
  { duration, jsonPath, markdownPath, maxVUs, profile, rate, runId, scenario },
) {
  const metrics = data.metrics;
  const failures = failedThresholds(metrics);
  const summary = {
    run_id: runId,
    scenario,
    profile,
    configured_rate: rate,
    configured_duration: duration,
    configured_max_vus: maxVUs,
    duration_ms: data.state?.testRunDurationMs ?? null,
    iterations: metricValue(metrics, "iterations", "count") ?? 0,
    iterations_per_second: metricValue(metrics, "iterations", "rate") ?? 0,
    http_reqs: metricValue(metrics, "http_reqs", "count") ?? 0,
    http_reqs_per_second: metricValue(metrics, "http_reqs", "rate") ?? 0,
    http_req_failed_rate: metricValue(metrics, "http_req_failed", "rate") ?? 0,
    check_rate: metricValue(metrics, "checks", "rate") ?? 0,
    dropped_iterations: metricValue(metrics, "dropped_iterations", "count") ?? 0,
    unexpected_responses: metricValue(metrics, "unexpected_responses", "count") ?? 0,
    failed_thresholds: failures,
    endpoints: endpointSummary(metrics),
  };

  summary.result = failures.length === 0 ? "PASS" : "FAIL";

  const outputs = {
    stdout: `FORMBRICKS_PERF_SUMMARY=${JSON.stringify(summary)}\n`,
  };
  if (jsonPath) outputs[jsonPath] = `${JSON.stringify(summary, null, 2)}\n`;
  if (markdownPath) outputs[markdownPath] = markdownSummary(summary);
  return outputs;
}
