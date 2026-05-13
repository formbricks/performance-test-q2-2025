#!/usr/bin/env node
// Read the augmented Hub test CSV and emit JSON payload shards for k6.
//
// Output files written to <out>/:
//   all.json        — every eligible payload, in original order
//   short.json      — value_text length < 100
//   medium.json     — value_text length 100..299
//   long.json       — value_text length >= 300
//
// Each file is an array of objects matching the
// `POST /v1/feedback-records` request body. Per-request fields that must be
// unique (submission_id) are mutated at runtime by k6, not here.
//
// Usage:
//   node scripts/embeddings/data/prepare-payloads.js \
//     --input ~/Downloads/hub-combined-test-data5k.csv \
//     --out scripts/embeddings/data/payloads

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ";") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toIso(collectedAt) {
  // CSV format: "2026-01-22 08:10:40" → "2026-01-22T08:10:40Z"
  if (!collectedAt) return null;
  const trimmed = collectedAt.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;
  return trimmed.replace(" ", "T") + "Z";
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      out: { type: "string" },
      tenant: { type: "string", default: "formbricks-hub-test-tenant" },
    },
  });
  if (!values.input || !values.out) {
    console.error("error: --input and --out are required");
    process.exit(2);
  }
  const inputPath = values.input.replace(/^~/, process.env.HOME ?? "");
  const outDir = path.resolve(values.out);
  fs.mkdirSync(outDir, { recursive: true });

  const text = fs.readFileSync(inputPath, "utf8");
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const required = [
    "field_id",
    "field_label",
    "field_type",
    "language",
    "response_id",
    "source_id",
    "source_name",
    "source_type",
    "value_text",
    "collected_at",
  ];
  for (const k of required) {
    if (!(k in idx)) {
      console.error(`error: missing column "${k}"`);
      process.exit(2);
    }
  }

  const all = [];
  const short = [];
  const medium = [];
  const long = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length !== header.length) continue;
    if (r[idx.field_type] !== "text") continue;
    const valueText = r[idx.value_text];
    if (!valueText || valueText.length === 0) continue;

    const payload = {
      tenant_id: values.tenant,
      submission_id: r[idx.response_id],
      source_type: r[idx.source_type] || "survey",
      source_id: r[idx.source_id] || undefined,
      source_name: r[idx.source_name] || undefined,
      field_id: r[idx.field_id],
      field_label: r[idx.field_label] || undefined,
      field_type: "text",
      value_text: valueText,
      language: r[idx.language] || undefined,
      collected_at: toIso(r[idx.collected_at]) || undefined,
    };
    // strip undefined
    for (const k of Object.keys(payload)) {
      if (payload[k] === undefined) delete payload[k];
    }
    all.push(payload);
    if (valueText.length < 100) short.push(payload);
    else if (valueText.length < 300) medium.push(payload);
    else long.push(payload);
  }

  const writes = [
    ["all.json", all],
    ["short.json", short],
    ["medium.json", medium],
    ["long.json", long],
  ];
  for (const [name, arr] of writes) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, JSON.stringify(arr));
    console.error(`${name}: ${arr.length} payloads → ${p}`);
  }
}

main();
