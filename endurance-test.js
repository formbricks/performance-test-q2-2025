import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export let options = {
    scenarios: {
        createSurvey: {
            executor: 'constant-arrival-rate',
            rate: 2,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'createSurvey',
        },
        getSurvey: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'getSurvey',
        },
        updateSurvey: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'updateSurvey',
        },
        publishSurvey: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'publishSurvey',
        },
        addDisplay: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'addDisplay',
        },
        createAndUpdateResponse: {
            executor: 'constant-arrival-rate',
            rate: 3,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 20,
            exec: 'createAndUpdateResponse',
        },
        getEnvironment: {
            executor: 'constant-arrival-rate',
            rate: 3,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 20,
            exec: 'getEnvironment',
        },
        postUser: {
            executor: 'constant-arrival-rate',
            rate: 3,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 20,
            exec: 'postUser',
        },
        listUsers: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'listUsers',
        },
        listRoles: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'listRoles',
        },
        listTeams: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: '1s',
            duration: '8h',
            preAllocatedVUs: 1,
            maxVUs: 10,
            exec: 'listTeams',
        },
    },
};

const BASE_URL = __ENV.FORMBRICKS_BASE_URL || 'https://stage.app.formbricks.com';
const ENV_ID = __ENV.FORMBRICKS_ENV_ID || 'default_env_id';
const ORG_ID = __ENV.FORMBRICKS_ORG_ID || 'default_org_id';
const API_KEY = __ENV.FORMBRICKS_API_KEY || 'your_api_key';

let headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': API_KEY,
    'Accept': 'application/json'
};

const metrics = {
    createResponseLatency: new Trend('create_response_latency', { isTime: true }),
    getSurveyLatency: new Trend('get_survey_latency', { isTime: true }),
    updateResponseLatency: new Trend('update_response_latency', { isTime: true }),
    getEnvLatency: new Trend('get_env_latency', { isTime: true }),
    postUserLatency: new Trend('post_user_latency', { isTime: true }),

    // Added for createSurvey
    createSurveyLatency: new Trend('create_survey_latency', { isTime: true }),
    createSurveyCount: new Counter('create_survey_count'),
    createSurveyErrors: new Counter('create_survey_errors'),


    // Added deleteSurvey metrics
    deleteSurveyLatency: new Trend('delete_survey_latency', { isTime: true }),
    deleteSurveyCount: new Counter('delete_survey_count'),
    deleteSurveyErrors: new Counter('delete_survey_errors'),

    getSurveyCount: new Counter('get_survey_count'),
    getSurveyErrors: new Counter('get_survey_errors'),

    createResponseCount: new Counter('create_response_count'),
    createResponseErrors: new Counter('create_response_errors'),

    updateResponseCount: new Counter('update_response_count'),
    updateResponseErrors: new Counter('update_response_errors'),

    getEnvCount: new Counter('get_env_count'),
    getEnvErrors: new Counter('get_env_errors'),

    postUserCount: new Counter('post_user_count'),
    postUserErrors: new Counter('post_user_errors'),

    errorRate: new Rate('errors'),

    listUsersLatency: new Trend('list_users_latency', { isTime: true }),
    listUsersCount: new Counter('list_users_count'),
    listUsersErrors: new Counter('list_users_errors'),

    addDisplayLatency: new Trend('add_display_latency', { isTime: true }),
    addDisplayCount: new Counter('add_display_count'),
    addDisplayErrors: new Counter('add_display_errors'),

    listRolesLatency: new Trend('list_roles_latency', { isTime: true }),
    listRolesCount: new Counter('list_roles_count'),
    listRolesErrors: new Counter('list_roles_errors'),

    listTeamsLatency: new Trend('list_teams_latency', { isTime: true }),
    listTeamsCount: new Counter('list_teams_count'),
    listTeamsErrors: new Counter('list_teams_errors'),

    updateUserLatency: new Trend('update_user_latency', { isTime: true }),
    updateUserCount: new Counter('update_user_count'),
    updateUserErrors: new Counter('update_user_errors'),

    updateSurveyLatency: new Trend('update_survey_latency', { isTime: true }),
    updateSurveyCount: new Counter('update_survey_count'),
    updateSurveyErrors: new Counter('update_survey_errors'),

    publishSurveyLatency: new Trend('publish_survey_latency', { isTime: true }),
    publishSurveyCount: new Counter('publish_survey_count'),
    publishSurveyErrors: new Counter('publish_survey_errors'),

    getEnvironmentLatency: new Trend('get_environment_latency', { isTime: true }),
    getEnvironmentCount: new Counter('get_environment_count'),
    getEnvironmentErrors: new Counter('get_environment_errors'),
};

// Shared state for survey and response IDs per VU
let state = {
    surveyId: null,
    responseId: null,
};

function buildSurveyPayload(index) {
    return JSON.stringify({
        environmentId: ENV_ID,
        name: `Example Survey ${index}`,
        status: 'draft',
        type: 'link',
        displayOption: 'displayOnce',
        questions: [
            {
                headline: { default: "What would you like to know?" },
                id: uuidv4(),
                inputType: "text",
                placeholder: { default: "Type your answer here..." },
                required: true,
                subheader: { default: "This is an example survey." },
                type: "openText"
            },
            {
                choices: [
                    { id: uuidv4(), label: { default: "Sun ☀️" } },
                    { id: uuidv4(), label: { default: "Ocean 🌊" } },
                    { id: uuidv4(), label: { default: "Palms 🌴" } }
                ],
                headline: { default: "What's important on vacay?" },
                id: uuidv4(),
                required: true,
                shuffleOption: "none",
                type: "multipleChoiceMulti"
            }
        ],
        welcomeCard: {
            enabled: true,
            headline: { default: "Welcome!" },
            html: { default: "<p>Thanks for providing your feedback - let's go!</p>" }
        }
    });
}

export function setup() {
    const surveyIds = [];
    for (let i = 0; i < 50; i++) {
        const payload = buildSurveyPayload(i);
        const res = http.post(`${BASE_URL}/api/v1/management/surveys`, payload, { headers });
        if (res.status === 200 || res.status === 201) {
            surveyIds.push(JSON.parse(res.body).data.id);
        } else {
            console.error(`Survey creation failed [${i}]: ${res.status} - ${res.body}`);
        }
    }
    return { surveyIds };
}

export function teardown(data) {
    const surveyIds = data?.surveyIds || [];
    for (const id of surveyIds) {
        const res = http.del(`${BASE_URL}/api/v1/management/surveys/${id}`, null, { headers });
        if (res.status !== 200 && res.status !== 204) {
            console.warn(`Failed to delete survey ${id}: ${res.status}`);
        } else {
            console.log(`Deleted survey from setup: ${id}`);
        }
    }
}

export function createSurvey() {
    const payload = buildSurveyPayload(Math.floor(Math.random() * 1000));
    const res = http.post(`${BASE_URL}/api/v1/management/surveys`, payload, { headers });

    // Add latency metric
    metrics.createSurveyLatency.add(res.timings.duration);
    // Add request count metric
    metrics.createSurveyCount.add(1);
    // Add error tracking metric
    if (res.status !== 200 && res.status !== 201) {
        metrics.createSurveyErrors.add(1);
        metrics.errorRate.add(1);
        throw new Error(`Create survey failed: ${res.status} - ${res.body}`);
    }
    const surveyId = JSON.parse(res.body).data.id;
    console.log(`Created survey with ID: ${surveyId}`);

    // Immediately delete the survey
    const delRes = http.del(`${BASE_URL}/api/v1/management/surveys/${surveyId}`, null, { headers });
    metrics.deleteSurveyLatency.add(delRes.timings.duration);
    metrics.deleteSurveyCount.add(1);
    if (delRes.status !== 200 && delRes.status !== 204) {
        metrics.deleteSurveyErrors.add(1);
        metrics.errorRate.add(1);

        throw new Error(`Failed to delete survey ${surveyId}: ${delRes.status} - ${delRes.body}`);
    }
    console.log(`Deleted survey with ID: ${surveyId}`);
}

export function getSurvey(data) {
    let surveyId = data?.surveyIds[Math.floor(Math.random() * data.surveyIds.length)];
    if (!surveyId) {
        throw new Error('No surveyId available for getSurvey');
    }
    let res = http.get(`${BASE_URL}/api/v1/management/surveys/${surveyId}`, { headers });
    metrics.getSurveyLatency.add(res.timings.duration);
    metrics.getSurveyCount.add(1);
    if (res.status !== 200) {
        metrics.getSurveyErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ GET Survey failed: ${res.status} - ${res.body}`);
    }
    console.log(`Survey fetched with ID: ${surveyId}`);
}

export function updateSurvey(data) {
    let surveyId = data?.surveyIds[Math.floor(Math.random() * data.surveyIds.length)];
    if (!surveyId) {
        throw new Error('No surveyId available for updateSurvey');
    }
    // Fetch survey first
    let getRes = http.get(`${BASE_URL}/api/v1/management/surveys/${surveyId}`, { headers });
    if (getRes.status !== 200) {
        metrics.errorRate.add(1);
        throw new Error(`Survey fetch failed: ${getRes.status} - ${getRes.body}`);
    }
    let survey = JSON.parse(getRes.body).data;

    // Modify questions similarly as in setup
    survey.questions.pop();

    let firstQ = survey.questions[0];
    firstQ.type = "multipleChoiceSingle";
    delete firstQ.inputType;
    firstQ.choices = [
        { id: "opt1", label: { default: "Yes" } },
        { id: "opt2", label: { default: "No" } }
    ];

    let dup = JSON.parse(JSON.stringify(firstQ));
    dup.id = uuidv4();
    dup.headline.default += " (copy)";
    survey.questions.push(dup);

    let putRes = http.put(`${BASE_URL}/api/v1/management/surveys/${surveyId}`, JSON.stringify(survey), { headers });
    if (putRes.status !== 200 && putRes.status !== 201) {
        metrics.errorRate.add(1);
        metrics.updateSurveyErrors.add(1);
        throw new Error(`Survey update failed: ${putRes.status} - ${putRes.body}`);
    }
    metrics.updateSurveyLatency.add(putRes.timings.duration);
    metrics.updateSurveyCount.add(1);
    console.log(`Survey updated with ID: ${putRes.status}`);
}

export function publishSurvey(data) {
    let surveyId = data?.surveyIds[Math.floor(Math.random() * data.surveyIds.length)];
    if (!surveyId) {
        throw new Error('No surveyId available for publishSurvey');
    }
    // Fetch survey first
    let getRes = http.get(`${BASE_URL}/api/v1/management/surveys/${surveyId}`, { headers });
    if (getRes.status !== 200) {
        metrics.errorRate.add(1);
        throw new Error(`Survey fetch failed: ${getRes.status} - ${getRes.body}`);
    }
    let survey = JSON.parse(getRes.body).data;

    survey.status = "inProgress";

    let publishRes = http.put(`${BASE_URL}/api/v1/management/surveys/${surveyId}`, JSON.stringify(survey), { headers });
    if (publishRes.status !== 200 && publishRes.status !== 201) {
        metrics.errorRate.add(1);
        metrics.publishSurveyErrors.add(1);
        throw new Error(`Survey publish failed: ${publishRes.status} - ${publishRes.body}`);
    }
    metrics.publishSurveyLatency.add(publishRes.timings.duration);
    metrics.publishSurveyCount.add(1);
    console.log(`Survey published with ID: ${publishRes.status}`);
}

export function addDisplay(data) {
    let surveyId = data?.surveyIds[Math.floor(Math.random() * data.surveyIds.length)];
    if (!surveyId) {
        throw new Error('No surveyId available for addDisplay');
    }
    let res = http.post(`${BASE_URL}/api/v1/client/${ENV_ID}/displays`, JSON.stringify({
        surveyId: surveyId,
    }), { headers });
    metrics.addDisplayLatency.add(res.timings.duration);
    metrics.addDisplayCount.add(1);
    if (res.status !== 200) {
        metrics.addDisplayErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ ADD Display failed: ${res.status} - ${res.body}`);
    }
    console.log(`Display added with ID: ${res.status}`);
}

export function createAndUpdateResponse(data) {
    // Step 1: create response
    let surveyId = data?.surveyIds[Math.floor(Math.random() * data.surveyIds.length)];
    console.log(`Survey ID: ${surveyId}`);
    if (!surveyId) {
        throw new Error('No surveyId available for createAndUpdateResponse');
    }
    let res = http.post(`${BASE_URL}/api/v1/client/${ENV_ID}/responses`, JSON.stringify({
        data: { feedback: ["Good"] },
        finished: false,
        language: 'default',
        surveyId: surveyId,
    }), { headers });

    if (res.status !== 200) {
        metrics.createResponseErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ CREATE Response failed: ${res.status} - ${res.body}`);
        return;
    }
    metrics.createResponseLatency.add(res.timings.duration);
    metrics.createResponseCount.add(1);

    const responseId = JSON.parse(res.body).data.id;
    console.log(`Response created with ID: ${res.status}`);

    // Step 2: update the same response
    let updateRes = http.put(`${BASE_URL}/api/v1/client/${ENV_ID}/responses/${responseId}`, JSON.stringify({
        data: { feedback: ["Updated"] },
        finished: true
    }), { headers });

    metrics.updateResponseLatency.add(updateRes.timings.duration);
    metrics.updateResponseCount.add(1);

    if (updateRes.status !== 200) {
        metrics.updateResponseErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ UPDATE Response failed: ${updateRes.status} - ${updateRes.body}`);
    }
    console.log(`Response updated with ID: ${updateRes.status}`);
}

export function getEnvironment() {
    let res = http.get(`${BASE_URL}/api/v1/client/${ENV_ID}/environment`, { headers });
    metrics.getEnvLatency.add(res.timings.duration);
    metrics.getEnvCount.add(1);
    if (res.status !== 200) {
        metrics.getEnvErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ GET Environment failed: ${res.status} - ${res.body}`);
    }

    console.log(`Environment fetched with ID: ${res.status}`);
}

export function postUser() {
    let res = http.post(`${BASE_URL}/api/v1/client/${ENV_ID}/user`, JSON.stringify({
        userId: `user-${Math.random().toString(36).substr(2, 9)}`,
        attributes: { plan: "premium" }
    }), { headers });
    metrics.postUserLatency.add(res.timings.duration);
    metrics.postUserCount.add(1);
    if (res.status !== 200) {
        metrics.postUserErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ POST User failed: ${res.status} - ${res.body}`);
    }
    console.log(`User created with ID: ${res.status}`);
}

export function listUsers() {
    let res = http.get(`${BASE_URL}/api/v2/organizations/${ORG_ID}/users`, { headers });
    metrics.listUsersLatency.add(res.timings.duration);
    metrics.listUsersCount.add(1);
    if (res.status !== 200) {
        metrics.listUsersErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ List Users failed: ${res.status} - ${res.body}`);
    }
    console.log(`Users listed with ID: ${res.status}`);
}

export function listRoles() {
    let res = http.get(`${BASE_URL}/api/v2/roles`, { headers });
    metrics.listRolesLatency.add(res.timings.duration);
    metrics.listRolesCount.add(1);
    if (res.status !== 200) {
        metrics.listRolesErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ List Roles failed: ${res.status} - ${res.body}`);
    }
    console.log(`Roles listed with ID: ${res.status}`);
}

export function listTeams() {
    let res = http.get(`${BASE_URL}/api/v2/organizations/${ORG_ID}/teams`, { headers });
    metrics.listTeamsLatency.add(res.timings.duration);
    metrics.listTeamsCount.add(1);
    if (res.status !== 200) {
        metrics.listTeamsErrors.add(1);
        metrics.errorRate.add(1);
        console.error(`❌ List Teams failed: ${res.status} - ${res.body}`);
    }
    console.log(`Teams listed with ID: ${res.status}`);
}
