// Shared payload loader + per-iteration mutators for the k6 scenarios.
//
// Payload shards are produced by data/prepare-payloads.js. They are loaded
// once per VU process via SharedArray to avoid duplicating ~5000 records
// across hundreds of VUs.

import { SharedArray } from "k6/data";
import exec from "k6/execution";

const BUCKETS = ["short", "medium", "long", "all"];

const SHARDS = Object.fromEntries(
  BUCKETS.map((b) => [
    b,
    new SharedArray(`payloads-${b}`, () => {
      const text = open(`../../data/payloads/${b}.json`);
      return JSON.parse(text);
    }),
  ]),
);

const QUERIES = new SharedArray("queries", () => {
  const text = open("../../data/queries.json");
  return JSON.parse(text);
});

const RUN_ID = `lt${Date.now().toString(36)}`;

export function bucketSize(bucket) {
  return SHARDS[bucket].length;
}

// Return a fresh payload object suitable for POST /v1/feedback-records.
// The base submission_id from the CSV is suffixed with VU + iteration + RUN_ID
// so each request creates a distinct record. value_text is preserved verbatim.
export function pickPayload(bucket = "all") {
  const shard = SHARDS[bucket];
  if (!shard || shard.length === 0) {
    throw new Error(`empty or unknown bucket: ${bucket}`);
  }
  const base = shard[Math.floor(Math.random() * shard.length)];
  const sid = `${base.submission_id}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${RUN_ID}`;
  return {
    ...base,
    submission_id: sid.slice(0, 255),
    collected_at: new Date().toISOString(),
  };
}

// Pick a search query. Returns { query, tenant_id, lang }.
export function pickQuery(tenantId) {
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  return {
    query: q.query,
    tenant_id: tenantId,
    lang: q.lang,
  };
}

// Build the OpenAI-compatible /embeddings body for a value_text.
// Wraps in "Question: ... \nAnswer: ..." to match Hub's production path.
// Set TEI_USE_QA_PREFIX=false in env to disable for a pure-text baseline.
export function teiBody({ value_text, field_label }, model, useQaPrefix = true) {
  const input =
    useQaPrefix && field_label
      ? `Question: ${field_label}\nAnswer: ${value_text}`
      : value_text;
  return {
    model,
    input,
    dimensions: 768,
  };
}

export function lengthBucket(text) {
  const n = (text || "").length;
  if (n < 100) return "short";
  if (n < 300) return "medium";
  return "long";
}
