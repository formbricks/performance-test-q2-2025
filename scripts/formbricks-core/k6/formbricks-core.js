import http from "k6/http";
import { check } from "k6";
import execution from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import { buildSummary } from "./lib/summary.js";

const ARTEMIS_URL = "https://artemis.app.formbricks.com";
const NON_ARTEMIS_CONFIRMATION = "I_UNDERSTAND_NON_PRODUCTION_ONLY";
const HIGH_IMPACT_CONFIRMATION = "I_APPROVE_SHARED_ARTEMIS_LOAD";
const ABSOLUTE_MAX_RATE = 50;
const ABSOLUTE_MAX_VUS = 200;
const SAFE_MAX_RATE = 10;
const SAFE_MAX_VUS = 100;

const BASE_URL = (__ENV.FORMBRICKS_URL || "").replace(/\/$/, "");
const WORKSPACE_ID = __ENV.FORMBRICKS_WORKSPACE_ID;
const API_KEY = __ENV.FORMBRICKS_API_KEY;
const SURVEY_ID = __ENV.FORMBRICKS_SURVEY_ID;
const QUESTION_ID = __ENV.FORMBRICKS_QUESTION_ID;
const RUN_ID = __ENV.RUN_ID || "formbricks-perf-unset";
const SCENARIO = __ENV.SCENARIO || "mixed";
const PROFILE = __ENV.PROFILE || "smoke";
const SUMMARY_JSON = __ENV.SUMMARY_JSON;
const SUMMARY_MD = __ENV.SUMMARY_MD;
const DURATION = __ENV.DURATION;
const PROFILE_DEFAULT_MAX_VUS = {
  smoke: 1,
  baseline: 20,
  load: 50,
  stress: 100,
  spike: 100,
  soak: 50,
};
const MAX_VUS = Number(__ENV.MAX_VUS || PROFILE_DEFAULT_MAX_VUS[PROFILE] || 20);
const P50_MS = Number(__ENV.P50_MS || 1000);
const P90_MS = Number(__ENV.P90_MS || 1500);
const P95_MS = Number(__ENV.P95_MS || 2000);
const P99_MS = Number(__ENV.P99_MS || 5000);

const PROFILE_DEFAULT_RATE = {
  smoke: 1,
  baseline: 1,
  load: 5,
  stress: 20,
  spike: 30,
  soak: 3,
};
const RATE = Number(__ENV.RATE || PROFILE_DEFAULT_RATE[PROFILE] || 1);

const PROFILE_MAX_DURATION_SECONDS = {
  smoke: 120,
  baseline: 600,
  load: 900,
  stress: 900,
  spike: 300,
  soak: 7200,
};

const SCENARIOS = [
  "public-read",
  "public-survey",
  "management-read",
  "response-write",
  "survey-lifecycle",
  "mixed",
];
const PROFILES = ["smoke", "baseline", "load", "stress", "spike", "soak"];

function isLocalTarget(target) {
  return /^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/.test(target);
}

function durationToSeconds(name, value) {
  if (!value) return null;
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) throw new Error(`${name} must use a positive whole number followed by s, m, or h`);
  const multiplier = { s: 1, m: 60, h: 3600 }[match[2]];
  return Number(match[1]) * multiplier;
}

function validateConfiguration() {
  if (!BASE_URL) throw new Error("FORMBRICKS_URL is required");
  if (/^https:\/\/(app|api)\.formbricks\.com(?::\d+)?(?:\/|$)/.test(BASE_URL)) {
    throw new Error("production Formbricks targets are always forbidden");
  }
  if (
    BASE_URL !== ARTEMIS_URL &&
    !isLocalTarget(BASE_URL) &&
    __ENV.ALLOW_NON_ARTEMIS_TARGET !== NON_ARTEMIS_CONFIRMATION
  ) {
    throw new Error(`target must be ${ARTEMIS_URL}; another isolated non-production target needs explicit confirmation`);
  }
  if (!WORKSPACE_ID) throw new Error("FORMBRICKS_WORKSPACE_ID is required");
  if (!SCENARIOS.includes(SCENARIO)) throw new Error(`unknown SCENARIO: ${SCENARIO}`);
  if (!PROFILES.includes(PROFILE)) throw new Error(`unknown PROFILE: ${PROFILE}`);
  if (!/^eng3309-[A-Za-z0-9._-]+$/.test(RUN_ID)) {
    throw new Error("RUN_ID must start with eng3309- and contain only safe characters");
  }
  if (!Number.isInteger(RATE) || RATE < 1 || RATE > ABSOLUTE_MAX_RATE) {
    throw new Error(`RATE must be an integer between 1 and ${ABSOLUTE_MAX_RATE}`);
  }
  if (!Number.isInteger(MAX_VUS) || MAX_VUS < 1 || MAX_VUS > ABSOLUTE_MAX_VUS) {
    throw new Error(`MAX_VUS must be an integer between 1 and ${ABSOLUTE_MAX_VUS}`);
  }
  if (["baseline", "load"].includes(PROFILE) && (RATE > SAFE_MAX_RATE || MAX_VUS > SAFE_MAX_VUS)) {
    throw new Error(`shared-environment ${PROFILE} runs are capped at RATE=${SAFE_MAX_RATE}, MAX_VUS=${SAFE_MAX_VUS}`);
  }
  const durationSeconds = durationToSeconds("DURATION", DURATION);
  if (durationSeconds && durationSeconds > PROFILE_MAX_DURATION_SECONDS[PROFILE]) {
    throw new Error(`${PROFILE} DURATION exceeds its hold-stage ceiling`);
  }
  const maxDurationSeconds = durationToSeconds("MAX_DURATION", __ENV.MAX_DURATION);
  if (maxDurationSeconds && PROFILE !== "smoke") {
    throw new Error("MAX_DURATION is only valid for smoke");
  }
  if (maxDurationSeconds && maxDurationSeconds > PROFILE_MAX_DURATION_SECONDS.smoke) {
    throw new Error("smoke MAX_DURATION exceeds its ceiling");
  }
  const timeoutSeconds = durationToSeconds("TIMEOUT", __ENV.TIMEOUT);
  if (timeoutSeconds && timeoutSeconds > 60) {
    throw new Error("TIMEOUT exceeds the 60s per-request ceiling");
  }
  if (
    ["stress", "spike", "soak"].includes(PROFILE) &&
    __ENV.CONFIRM_HIGH_IMPACT_PROFILE !== HIGH_IMPACT_CONFIRMATION
  ) {
    throw new Error(`${PROFILE} is high-impact and requires explicit approval before execution`);
  }
  if (["management-read", "survey-lifecycle", "mixed"].includes(SCENARIO) && !API_KEY) {
    throw new Error(`FORMBRICKS_API_KEY is required for ${SCENARIO}`);
  }
  if (["public-survey", "response-write", "mixed"].includes(SCENARIO) && !SURVEY_ID) {
    throw new Error(`FORMBRICKS_SURVEY_ID is required for ${SCENARIO}`);
  }
  if (["response-write", "mixed"].includes(SCENARIO) && !QUESTION_ID) {
    throw new Error(`FORMBRICKS_QUESTION_ID is required for ${SCENARIO}`);
  }
  for (const [name, value] of Object.entries({ P50_MS, P90_MS, P95_MS, P99_MS })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  if (!(P50_MS <= P90_MS && P90_MS <= P95_MS && P95_MS <= P99_MS)) {
    throw new Error("latency thresholds must be ordered P50_MS <= P90_MS <= P95_MS <= P99_MS");
  }
}

validateConfiguration();

const unexpectedResponses = new Counter("unexpected_responses");
const publicEnvironmentDuration = new Trend("public_environment_duration", true);
const publicSurveyPageDuration = new Trend("public_survey_page_duration", true);
const managementSurveysDuration = new Trend("management_surveys_duration", true);
const responseCreateDuration = new Trend("response_create_duration", true);
const surveyCreateDuration = new Trend("survey_create_duration", true);
const surveyGetDuration = new Trend("survey_get_duration", true);
const surveyDeleteDuration = new Trend("survey_delete_duration", true);

function profileOptions(exec) {
  switch (PROFILE) {
    case "smoke":
      return {
        executor: "per-vu-iterations",
        exec,
        vus: 1,
        iterations: Number(__ENV.ITERATIONS || 1),
        maxDuration: __ENV.MAX_DURATION || "1m",
      };
    case "baseline":
      return {
        executor: "constant-arrival-rate",
        exec,
        rate: RATE,
        timeUnit: "1s",
        duration: DURATION || "2m",
        preAllocatedVUs: Math.min(MAX_VUS, Math.max(5, RATE * 2)),
        maxVUs: MAX_VUS,
      };
    case "load":
      return {
        executor: "ramping-arrival-rate",
        exec,
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: Math.min(MAX_VUS, Math.max(10, RATE * 2)),
        maxVUs: MAX_VUS,
        stages: [
          { target: RATE, duration: "1m" },
          { target: RATE, duration: DURATION || "3m" },
          { target: 0, duration: "1m" },
        ],
      };
    case "stress":
      return {
        executor: "ramping-arrival-rate",
        exec,
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: Math.min(MAX_VUS, Math.max(20, RATE * 2)),
        maxVUs: MAX_VUS,
        stages: [
          { target: Math.max(1, Math.round(RATE * 0.25)), duration: "1m" },
          { target: Math.max(2, Math.round(RATE * 0.5)), duration: "1m" },
          { target: RATE, duration: DURATION || "2m" },
          { target: 0, duration: "1m" },
        ],
      };
    case "spike":
      return {
        executor: "ramping-arrival-rate",
        exec,
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: Math.min(MAX_VUS, Math.max(20, RATE * 2)),
        maxVUs: MAX_VUS,
        stages: [
          { target: RATE, duration: "15s" },
          { target: RATE, duration: DURATION || "1m" },
          { target: 1, duration: "30s" },
          { target: 0, duration: "15s" },
        ],
      };
    case "soak":
      return {
        executor: "constant-arrival-rate",
        exec,
        rate: RATE,
        timeUnit: "1s",
        duration: DURATION || "30m",
        preAllocatedVUs: Math.min(MAX_VUS, Math.max(10, RATE * 2)),
        maxVUs: MAX_VUS,
      };
    default:
      throw new Error(`unknown PROFILE: ${PROFILE}`);
  }
}

const scenarioExecutors = {
  "public-read": "publicRead",
  "public-survey": "publicSurvey",
  "management-read": "managementRead",
  "response-write": "responseWrite",
  "survey-lifecycle": "surveyLifecycle",
  mixed: "mixedWorkload",
};

const endpointsByScenario = {
  "public-read": ["public_environment"],
  "public-survey": ["public_survey_page", "public_environment"],
  "management-read": ["management_surveys"],
  "response-write": ["response_create"],
  "survey-lifecycle": ["survey_create", "survey_get", "survey_delete"],
  mixed: [
    "public_survey_page",
    "public_environment",
    "management_surveys",
    "response_create",
    "survey_create",
    "survey_get",
    "survey_delete",
  ],
};

function latencyThresholds() {
  return [
    `p(50)<${P50_MS}`,
    `p(90)<${P90_MS}`,
    `p(95)<${P95_MS}`,
    `p(99)<${P99_MS}`,
  ];
}

function buildThresholds() {
  const abortDelay = PROFILE === "smoke" ? "0s" : "30s";
  const thresholds = {
    checks: ["rate>=0.99"],
    http_req_failed: [
      "rate<0.01",
      { threshold: "rate<0.05", abortOnFail: true, delayAbortEval: abortDelay },
    ],
    http_req_duration: latencyThresholds(),
    dropped_iterations: [
      "count==0",
      { threshold: "count<5", abortOnFail: true, delayAbortEval: abortDelay },
    ],
    unexpected_responses: [
      "count==0",
      { threshold: "count<3", abortOnFail: true, delayAbortEval: abortDelay },
    ],
  };

  for (const endpoint of endpointsByScenario[SCENARIO]) {
    thresholds[`http_req_duration{endpoint:${endpoint}}`] = latencyThresholds();
    thresholds[`http_req_failed{endpoint:${endpoint}}`] = ["rate<0.01"];
  }
  return thresholds;
}

export const options = {
  scenarios: {
    [SCENARIO]: profileOptions(scenarioExecutors[SCENARIO]),
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
  thresholds: buildThresholds(),
  tags: { performance_run: RUN_ID, profile: PROFILE, test_scenario: SCENARIO },
};

function publicParams(endpoint, accept = "application/json") {
  return {
    headers: {
      Accept: accept,
      "User-Agent": `formbricks-k6/${RUN_ID}`,
      "X-Formbricks-Performance-Run": RUN_ID,
    },
    tags: { endpoint, profile: PROFILE, run_id: RUN_ID, test_scenario: SCENARIO },
    timeout: __ENV.TIMEOUT || "15s",
  };
}

function managementParams(endpoint) {
  const params = publicParams(endpoint);
  params.headers["Content-Type"] = "application/json";
  params.headers["x-api-key"] = API_KEY;
  return params;
}

function parseJSON(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

function recordUnexpected(response, expectedStatuses, endpoint) {
  if (!expectedStatuses.includes(response.status)) {
    unexpectedResponses.add(1, { endpoint, status: String(response.status) });
  }
}

export function publicRead() {
  const endpoint = "public_environment";
  const response = http.get(
    `${BASE_URL}/api/v1/client/${WORKSPACE_ID}/environment`,
    publicParams(endpoint),
  );
  publicEnvironmentDuration.add(response.timings.duration);
  recordUnexpected(response, [200], endpoint);
  check(response, {
    "public environment returns 200": (res) => res.status === 200,
    "public environment returns data": (res) => Boolean(parseJSON(res)?.data),
  });
}

export function publicSurvey() {
  const endpoint = "public_survey_page";
  const pageResponse = http.get(
    `${BASE_URL}/s/${encodeURIComponent(SURVEY_ID)}?performanceRun=${encodeURIComponent(RUN_ID)}`,
    publicParams(endpoint, "text/html"),
  );
  publicSurveyPageDuration.add(pageResponse.timings.duration);
  recordUnexpected(pageResponse, [200], endpoint);
  check(pageResponse, {
    "public survey page returns 200": (res) => res.status === 200,
    "public survey page returns html": (res) => String(res.headers["Content-Type"] || "").includes("text/html"),
  });
  publicRead();
}

export function managementRead() {
  const endpoint = "management_surveys";
  const response = http.get(
    `${BASE_URL}/api/v3/surveys?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&limit=20&includeTotalCount=true`,
    managementParams(endpoint),
  );
  managementSurveysDuration.add(response.timings.duration);
  recordUnexpected(response, [200], endpoint);
  check(response, {
    "management list returns 200": (res) => res.status === 200,
    "management list returns an array": (res) => Array.isArray(parseJSON(res)?.data),
  });
}

export function responseWrite() {
  const endpoint = "response_create";
  const payload = {
    surveyId: SURVEY_ID,
    finished: true,
    data: {
      [QUESTION_ID]: `Synthetic performance response ${RUN_ID} ${__VU}-${__ITER}`,
    },
    meta: {
      source: "link",
      url: `${BASE_URL}/s/${SURVEY_ID}?performanceRun=${encodeURIComponent(RUN_ID)}`,
    },
  };
  const params = publicParams(endpoint);
  params.headers["Content-Type"] = "application/json";
  const response = http.post(
    `${BASE_URL}/api/v1/client/${WORKSPACE_ID}/responses`,
    JSON.stringify(payload),
    params,
  );
  responseCreateDuration.add(response.timings.duration);
  recordUnexpected(response, [200], endpoint);
  check(response, {
    "response create returns 200": (res) => res.status === 200,
    "response create returns an id": (res) => Boolean(parseJSON(res)?.data?.id || parseJSON(res)?.id),
  });
}

function lifecyclePayload() {
  return {
    workspaceId: WORKSPACE_ID,
    name: `ENG-3309 ${RUN_ID} lifecycle ${__VU}-${__ITER}`,
    type: "link",
    status: "draft",
    blocks: [
      {
        name: "Performance test block",
        elements: [
          {
            id: `perf-question-${__VU}-${__ITER}`,
            type: "openText",
            headline: { "en-US": "Synthetic performance question" },
            required: false,
          },
        ],
      },
    ],
  };
}

export function surveyLifecycle() {
  const createEndpoint = "survey_create";
  const createResponse = http.post(
    `${BASE_URL}/api/v3/surveys?createdFrom=blank`,
    JSON.stringify(lifecyclePayload()),
    managementParams(createEndpoint),
  );
  surveyCreateDuration.add(createResponse.timings.duration);
  recordUnexpected(createResponse, [201], createEndpoint);
  const surveyId = parseJSON(createResponse)?.data?.id || parseJSON(createResponse)?.id;
  const created = check(createResponse, {
    "survey create returns 201": (res) => res.status === 201,
    "survey create returns an id": () => Boolean(surveyId),
  });

  if (!created || !surveyId) return;

  const getEndpoint = "survey_get";
  const getResponse = http.get(
    `${BASE_URL}/api/v3/surveys/${encodeURIComponent(surveyId)}`,
    managementParams(getEndpoint),
  );
  surveyGetDuration.add(getResponse.timings.duration);
  recordUnexpected(getResponse, [200], getEndpoint);
  check(getResponse, { "survey get returns 200": (res) => res.status === 200 });

  const deleteEndpoint = "survey_delete";
  const deleteResponse = http.del(
    `${BASE_URL}/api/v3/surveys/${encodeURIComponent(surveyId)}`,
    null,
    managementParams(deleteEndpoint),
  );
  surveyDeleteDuration.add(deleteResponse.timings.duration);
  recordUnexpected(deleteResponse, [204], deleteEndpoint);
  check(deleteResponse, { "survey delete returns 204": (res) => res.status === 204 });
}

export function mixedWorkload() {
  if (PROFILE === "smoke") {
    publicSurvey();
    responseWrite();
    managementRead();
    surveyLifecycle();
    return;
  }
  const bucket = execution.scenario.iterationInTest % 100;
  if (bucket < 60) publicSurvey();
  else if (bucket < 85) responseWrite();
  else if (bucket < 98) managementRead();
  else surveyLifecycle();
}

export function handleSummary(data) {
  return buildSummary(data, {
    duration: DURATION || null,
    maxVUs: MAX_VUS,
    profile: PROFILE,
    rate: RATE,
    runId: RUN_ID,
    scenario: SCENARIO,
    jsonPath: SUMMARY_JSON,
    markdownPath: SUMMARY_MD,
  });
}
