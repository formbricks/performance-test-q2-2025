import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { buildSummary } from "./lib/summary.js";

const BASE_URL = (__ENV.FORMBRICKS_URL || "").replace(/\/$/, "");
const WORKSPACE_ID = __ENV.FORMBRICKS_WORKSPACE_ID;
const API_KEY = __ENV.FORMBRICKS_API_KEY;
const SURVEY_ID = __ENV.FORMBRICKS_SURVEY_ID;
const QUESTION_ID = __ENV.FORMBRICKS_QUESTION_ID;
const RUN_ID = __ENV.RUN_ID || "formbricks-perf-unset";
const SCENARIO = __ENV.SCENARIO || "mixed";
const PROFILE = __ENV.PROFILE || "smoke";
const SUMMARY_MD = __ENV.SUMMARY_MD;
const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION;
const MAX_VUS = Number(__ENV.MAX_VUS || 100);
const P95_MS = Number(__ENV.P95_MS || 2000);
const P99_MS = Number(__ENV.P99_MS || 5000);

if (!BASE_URL) throw new Error("FORMBRICKS_URL is required");
if (!WORKSPACE_ID) throw new Error("FORMBRICKS_WORKSPACE_ID is required");
if (!["public-read", "management-read", "response-write", "survey-lifecycle", "mixed"].includes(SCENARIO)) {
  throw new Error(`unknown SCENARIO: ${SCENARIO}`);
}
if (["management-read", "survey-lifecycle", "mixed"].includes(SCENARIO) && !API_KEY) {
  throw new Error(`FORMBRICKS_API_KEY is required for ${SCENARIO}`);
}
if (["response-write", "mixed"].includes(SCENARIO) && (!SURVEY_ID || !QUESTION_ID)) {
  throw new Error(`FORMBRICKS_SURVEY_ID and FORMBRICKS_QUESTION_ID are required for ${SCENARIO}`);
}

const unexpectedResponses = new Counter("unexpected_responses");
const publicEnvironmentDuration = new Trend("public_environment_duration", true);
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
        iterations: Number(__ENV.ITERATIONS || 5),
        maxDuration: __ENV.MAX_DURATION || "2m",
      };
    case "baseline":
      return {
        executor: "constant-arrival-rate",
        exec,
        rate: RATE,
        timeUnit: "1s",
        duration: DURATION || "5m",
        preAllocatedVUs: Math.max(10, RATE * 2),
        maxVUs: MAX_VUS,
      };
    case "step":
      return {
        executor: "ramping-arrival-rate",
        exec,
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: Math.max(20, RATE * 2),
        maxVUs: MAX_VUS,
        stages: [
          { target: Math.max(1, Math.round(RATE / 4)), duration: "2m" },
          { target: Math.max(2, Math.round(RATE / 2)), duration: "2m" },
          { target: RATE, duration: "3m" },
          { target: Math.max(1, Math.round(RATE / 4)), duration: "1m" },
        ],
      };
    case "soak":
      return {
        executor: "constant-arrival-rate",
        exec,
        rate: RATE,
        timeUnit: "1s",
        duration: DURATION || "30m",
        preAllocatedVUs: Math.max(10, RATE * 2),
        maxVUs: MAX_VUS,
      };
    default:
      throw new Error(`unknown PROFILE: ${PROFILE}`);
  }
}

const scenarioExecutors = {
  "public-read": "publicRead",
  "management-read": "managementRead",
  "response-write": "responseWrite",
  "survey-lifecycle": "surveyLifecycle",
  mixed: "mixedWorkload",
};

export const options = {
  scenarios: {
    [SCENARIO]: profileOptions(scenarioExecutors[SCENARIO]),
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
  thresholds: {
    checks: ["rate>=0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
    dropped_iterations: ["count==0"],
    unexpected_responses: ["count==0"],
  },
};

function publicParams(endpoint) {
  return {
    headers: {
      Accept: "application/json",
      "User-Agent": `formbricks-k6/${RUN_ID}`,
      "X-Formbricks-Performance-Run": RUN_ID,
    },
    tags: { endpoint, run_id: RUN_ID, test_scenario: SCENARIO },
    timeout: __ENV.TIMEOUT || "30s",
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

function recordUnexpected(response, expectedStatuses) {
  if (!expectedStatuses.includes(response.status)) {
    unexpectedResponses.add(1, { status: String(response.status) });
  }
}

export function publicRead() {
  const response = http.get(
    `${BASE_URL}/api/v1/client/${WORKSPACE_ID}/environment`,
    publicParams("public_environment"),
  );
  publicEnvironmentDuration.add(response.timings.duration);
  recordUnexpected(response, [200]);
  check(response, {
    "public environment returns 200": (res) => res.status === 200,
    "public environment returns data": (res) => Boolean(parseJSON(res)?.data),
  });
}

export function managementRead() {
  const response = http.get(
    `${BASE_URL}/api/v3/surveys?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&limit=20&includeTotalCount=true`,
    managementParams("management_surveys"),
  );
  managementSurveysDuration.add(response.timings.duration);
  recordUnexpected(response, [200]);
  check(response, {
    "management list returns 200": (res) => res.status === 200,
    "management list returns an array": (res) => Array.isArray(parseJSON(res)?.data),
  });
}

export function responseWrite() {
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
  const response = http.post(
    `${BASE_URL}/api/v1/client/${WORKSPACE_ID}/responses`,
    JSON.stringify(payload),
    {
      ...publicParams("response_create"),
      headers: {
        ...publicParams("response_create").headers,
        "Content-Type": "application/json",
      },
    },
  );
  responseCreateDuration.add(response.timings.duration);
  recordUnexpected(response, [200]);
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
  const createResponse = http.post(
    `${BASE_URL}/api/v3/surveys?createdFrom=blank`,
    JSON.stringify(lifecyclePayload()),
    managementParams("survey_create"),
  );
  surveyCreateDuration.add(createResponse.timings.duration);
  recordUnexpected(createResponse, [201]);
  const surveyId = parseJSON(createResponse)?.data?.id || parseJSON(createResponse)?.id;
  const created = check(createResponse, {
    "survey create returns 201": (res) => res.status === 201,
    "survey create returns an id": () => Boolean(surveyId),
  });

  if (!created || !surveyId) return;

  const getResponse = http.get(
    `${BASE_URL}/api/v3/surveys/${encodeURIComponent(surveyId)}`,
    managementParams("survey_get"),
  );
  surveyGetDuration.add(getResponse.timings.duration);
  recordUnexpected(getResponse, [200]);
  check(getResponse, { "survey get returns 200": (res) => res.status === 200 });

  const deleteResponse = http.del(
    `${BASE_URL}/api/v3/surveys/${encodeURIComponent(surveyId)}`,
    null,
    managementParams("survey_delete"),
  );
  surveyDeleteDuration.add(deleteResponse.timings.duration);
  recordUnexpected(deleteResponse, [204]);
  check(deleteResponse, { "survey delete returns 204": (res) => res.status === 204 });
}

export function mixedWorkload() {
  const pick = Math.random();
  if (pick < 0.7) publicRead();
  else if (pick < 0.9) responseWrite();
  else if (pick < 0.98) managementRead();
  else surveyLifecycle();
}

export function handleSummary(data) {
  return buildSummary(data, {
    runId: RUN_ID,
    scenario: SCENARIO,
    profile: PROFILE,
    markdownPath: SUMMARY_MD,
  });
}
