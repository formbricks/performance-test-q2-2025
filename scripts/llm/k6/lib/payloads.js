// Shared fixture loader + OpenAI-chat-completion payload builder for the
// translation scenario.
//
// Fixtures live in data/prompts-translation.json and are loaded once per VU
// process via SharedArray. Each iteration's payload is constructed at runtime
// because:
//   - the system/user prompts depend on source/target language pair
//   - the JSON-schema variant of response_format embeds the expected key set,
//     which depends on the fixture's field count

import { SharedArray } from "k6/data";

const TRANSLATION_FIXTURES = new SharedArray("translation-fixtures", () => {
  const text = open("../../data/prompts-translation.json");
  return JSON.parse(text);
});

const SURVEYGEN_FIXTURES = new SharedArray("surveygen-fixtures", () => {
  const text = open("../../data/prompts-surveygen.json");
  return JSON.parse(text);
});

const CHARTGEN_FIXTURES = new SharedArray("chartgen-fixtures", () => {
  const text = open("../../data/prompts-chartgen.json");
  return JSON.parse(text);
});

export function fixtureCount(bucket) {
  if (!bucket) return TRANSLATION_FIXTURES.length;
  return TRANSLATION_FIXTURES.filter((f) => f.size_bucket === bucket).length;
}

export function pickTranslationFixture(bucket) {
  const pool = bucket
    ? TRANSLATION_FIXTURES.filter((f) => f.size_bucket === bucket)
    : TRANSLATION_FIXTURES;
  if (pool.length === 0) {
    throw new Error(`no translation fixtures for bucket=${bucket || "(all)"}`);
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// Build the system + user prompt pair exactly as Formbricks's
// translate-fields.ts does (modules/ee/ai-translation/lib/translate-fields.ts).
//
// Empty defaultText fields are echoed through in production without an LLM
// call; this script filters them out the same way.
export function buildTranslationMessages(fixture) {
  const translatable = fixture.fields.filter((f) => f.text && f.text.length > 0);
  const items = translatable.map((f, i) => ({
    id: `t${i}`,
    text: f.text,
    richText: f.richText,
  }));
  const expectedKeys = items.map((i) => i.id);
  const system =
    `You are a professional translator for survey content. ` +
    `Translate each item from ${fixture.source_language} to ${fixture.target_language}.\n\n` +
    `Rules:\n` +
    `- For rich text items (richText: true), preserve all HTML tags exactly. ` +
    `Only translate the text content within the tags.\n` +
    `- Preserve any {{variable}} patterns exactly — do not translate text inside double curly braces.\n` +
    `- Translate every item. Do not omit any keys.`;
  const user = JSON.stringify(items);
  return { system, user, expectedKeys };
}

// Build the OpenAI-compatible chat-completion request body.
//
// responseFormat: "json_object" (default — basic JSON mode) or "json_schema"
// (vLLM/OpenAI guided decoding — embeds the expected key set so the server
// enforces shape on the way out).
export function buildChatCompletionBody({
  model,
  messages,
  expectedKeys,
  temperature = 0,
  maxTokens = 8192,
  responseFormat = "json_object",
}) {
  const body = {
    model,
    messages: [
      { role: "system", content: messages.system },
      { role: "user", content: messages.user },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (responseFormat === "json_schema") {
    const properties = {};
    for (const k of expectedKeys) properties[k] = { type: "string" };
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "translation_response",
        strict: true,
        schema: {
          type: "object",
          properties,
          required: expectedKeys,
          additionalProperties: false,
        },
      },
    };
  } else if (responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

// --- Survey generation -----------------------------------------------------

const SURVEYGEN_ALLOWED_LOCALES = ["en-US", "de-DE", "es-ES", "fr-FR", "ja-JP", "pt-BR"];

export function pickSurveyGenFixture() {
  return SURVEYGEN_FIXTURES[Math.floor(Math.random() * SURVEYGEN_FIXTURES.length)];
}

export function surveyGenFixtureCount() {
  return SURVEYGEN_FIXTURES.length;
}

// Mirrors apps/web/app/api/v3/surveys/generate/prompt.ts. We rebuild the
// prompts in-script rather than importing from Formbricks so the test can run
// without the web app, but the structure stays in sync.
export function buildSurveyGenMessages(fixture, surveyType = "link") {
  const allowed = SURVEYGEN_ALLOWED_LOCALES.join(", ");
  const system = [
    "You generate concise Formbricks survey drafts.",
    "Return only data that matches the provided schema.",
    "Write all generated user-facing survey content in the same language as the user's request. " +
      "Detect the language from the request; if it clearly matches an allowed survey language, use that language. " +
      "If uncertain or no allowed survey language is a confident match, " +
      "use the preferred survey language from the user prompt.",
    "Return the survey language exactly as one of the allowed survey language codes from the user prompt.",
    `Allowed survey languages: ${allowed}.`,
    "Keep surveys focused: 3 to 6 questions is usually enough.",
    "Group questions into 1 to 8 blocks. Use one block for simple requests. " +
      "Use multiple blocks when the user asks for sections, pages, blocks, or clearly separate topics.",
    "Give each block a short, meaningful name. Use 1 to 4 questions per block.",
    "Rating-like questions must be single-question blocks: rating, csat, ces, nps, matrix, and ranking. " +
      "Do not place rating-like questions together in the same block.",
    "Use only these question types: openText, multipleChoiceSingle, multipleChoiceMulti, rating, csat, ces, nps, ranking, matrix, date.",
    "Use csat for satisfaction, ces for effort, nps for loyalty, ranking for priorities, " +
      "matrix for repeated row-and-column ratings, and date only when the requested feedback needs a date.",
    'For rating questions, set range to one of the string values "5", "7", or "10".',
    'For csat questions, set range to "5". For ces questions, set range to "5" or "7".',
    "Prefer clear, neutral question wording and short answer choices.",
    "Use required questions sparingly. Do not ask for sensitive personal data unless the prompt explicitly asks for it.",
    "Do not use file uploads, picture selection, address/contact collection, scheduling, CTA, consent, " +
      "embedded external forms, or any other question type outside the allowed list.",
    "Do not include branching, variables, hidden fields, URLs, files, scripts, markdown, HTML, or tracking instructions.",
    `The final product will be created as a ${surveyType} survey draft.`,
  ].join("\n");

  const user = [
    `Create a draft ${surveyType} survey from this request.`,
    "Include a name, optional description, useful questions, and a simple ending.",
    "If the request is broad, choose a practical customer-feedback survey structure.",
    "Return the questions inside blocks. Use multiple blocks only when useful or requested.",
    "Keep rating-like questions in their own single-question blocks: rating, csat, ces, nps, matrix, and ranking.",
    "Use the same language as the request for all generated survey text. " +
      "If the request language is unclear or cannot be matched to an allowed survey language, " +
      "use the preferred survey language.",
    "If you enable the welcome card, include a short button label in the same language.",
    `Allowed survey languages: ${allowed}.`,
    `Preferred survey language: ${fixture.preferred_language}.`,
    "Set the returned language to exactly one allowed survey language code.",
    "",
    "User request:",
    fixture.prompt,
  ].join("\n");

  return { system, user };
}

// --- Chart generation ------------------------------------------------------

export function pickChartGenFixture() {
  return CHARTGEN_FIXTURES[Math.floor(Math.random() * CHARTGEN_FIXTURES.length)];
}

export function chartGenFixtureCount() {
  return CHARTGEN_FIXTURES.length;
}

// Mirrors the prefill-heavy shape of generateAIChartAction: a long schema
// context (available measures/dimensions/chart types) plus a short user
// prompt. We inline a representative Cube-style schema context here so the
// payload size is realistic (~2k tokens of context).
const CHART_SCHEMA_CONTEXT = `Available measures (numeric aggregations you can request):
- responses.count — total number of survey responses
- responses.completed_count — responses where status = "completed"
- responses.in_progress_count — responses where status = "in_progress"
- responses.completion_rate — completed_count / count
- responses.avg_time_to_complete_seconds
- responses.median_time_to_complete_seconds
- responses.nps_score — net promoter score (promoters - detractors) / total * 100
- responses.csat_score — average CSAT 1-5
- responses.csat_top_box_rate — share of CSAT >= 4
- responses.ces_score — average customer effort score
- responses.sentiment_positive_rate
- responses.sentiment_negative_rate
- responses.sentiment_neutral_rate
- tickets.count
- tickets.avg_first_response_minutes
- tickets.avg_resolution_hours
- tickets.first_contact_resolution_rate
- users.active_count
- users.new_count
- users.churned_count

Available dimensions (categorical or time-based axes):
- responses.collected_at — daily granularity by default, can roll up to week, month, quarter
- responses.language
- responses.region
- responses.country
- responses.customer_segment — values: SMB, MidMarket, Enterprise
- responses.plan_tier — values: Free, Pro, Team, Enterprise
- responses.product_area
- responses.survey_type — values: link, in-app, email, webhook
- responses.survey_name
- responses.user_role
- responses.user_tenure_bucket — values: 0-6m, 6-12m, 12-24m, 24m+
- responses.sentiment_label — values: positive, neutral, negative
- responses.question_id
- responses.question_type
- responses.day_of_week
- responses.hour_of_day
- tickets.channel — values: email, chat, phone, social
- tickets.team
- tickets.agent_id
- tickets.priority — values: low, normal, high, urgent
- users.plan_tier
- users.region

Available filter operators:
- equals, notEquals, contains, notContains, gt, gte, lt, lte, set, notSet, inRange, notInRange

Available chart types:
- line — time series; requires a time dimension
- bar — categorical comparison
- stackedBar — categorical comparison with sub-segments
- pie — proportions; max 8 slices
- table — raw cross-tab
- heatmap — two categorical dimensions vs one measure
- number — single scalar value

Return a JSON object with these keys:
- measures (array of measure names from the list above; at least one)
- dimensions (array of dimension names from the list above; can be empty)
- filters (array of { dimension, operator, values })
- chartType (one of the allowed chart types)
- title (short human-readable title)
`;

export function buildChartGenMessages(fixture) {
  const system =
    "You are a data analyst assistant. Translate a natural-language request " +
    "into a structured chart query that the Formbricks analytics engine can " +
    "execute. Use only the measures, dimensions, operators, and chart types " +
    "listed in the schema below. Pick the chart type that best fits the " +
    "request.\n\n" +
    CHART_SCHEMA_CONTEXT;
  const user = `Request: ${fixture.prompt}`;
  return { system, user };
}

// Lightweight "expected key" descriptors for the validators.
export const SURVEYGEN_REQUIRED_KEYS = ["language", "name", "blocks", "ending"];
export const CHARTGEN_REQUIRED_KEYS = ["measures", "dimensions", "chartType"];
