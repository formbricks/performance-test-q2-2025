#!/usr/bin/env node
// Augment hub-combined-test-data5k.csv with multilingual rows.
//
// Strategy:
//   - Keep ~60% rows English (unchanged).
//   - Convert ~10% each to de, es, fr, ja.
//   - Replace value_text with a length-similar phrase from the pre-translated
//     pool in phrases.js. Update the `language` column.
//   - Preserve total row count (5000) and approximate length distribution.
//   - Back up the original to <name>.original.csv next to the input.
//
// Usage:
//   node scripts/embeddings/data/augment.js \
//     --input ~/Downloads/hub-combined-test-data5k.csv
//
// The script overwrites the input file in place.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pickPhrase } from "./phrases.js";

const SEED = 0xc0ffee;
let rngState = SEED;
function rand() {
  // Mulberry32 — deterministic, good enough for sampling.
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const TARGET_LANG_MIX = [
  { lang: "en", weight: 0.6 },
  { lang: "de", weight: 0.1 },
  { lang: "es", weight: 0.1 },
  { lang: "fr", weight: 0.1 },
  { lang: "ja", weight: 0.1 },
];

// Minimal CSV parser for the Hub test dataset format (semicolon-delimited,
// double-quote escaping, embedded newlines allowed inside quoted fields).
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
      // ignore — handled by the following \n
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

function csvField(value) {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(";") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function serializeCsv(header, rows) {
  const lines = [header.map(csvField).join(";")];
  for (const r of rows) lines.push(r.map(csvField).join(";"));
  return lines.join("\n") + "\n";
}

function assignTargetLanguages(n) {
  // Build a deterministic shuffled language assignment that respects the
  // target mix exactly (no random drift).
  const counts = TARGET_LANG_MIX.map(({ lang, weight }) => ({
    lang,
    count: Math.round(weight * n),
  }));
  const sum = counts.reduce((a, b) => a + b.count, 0);
  // Adjust for rounding to land on n exactly.
  counts[0].count += n - sum;
  const flat = [];
  for (const { lang, count } of counts) {
    for (let i = 0; i < count; i++) flat.push(lang);
  }
  // Fisher–Yates with our deterministic RNG.
  for (let i = flat.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [flat[i], flat[j]] = [flat[j], flat[i]];
  }
  return flat;
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
    },
  });
  if (!values.input) {
    console.error("error: --input <path-to-csv> is required");
    process.exit(2);
  }
  const inputPath = values.input.replace(/^~/, process.env.HOME ?? "");
  const text = fs.readFileSync(inputPath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error("error: CSV has no data rows");
    process.exit(2);
  }
  const header = rows[0];
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);
  const langIdx = header.indexOf("language");
  const textIdx = header.indexOf("value_text");
  const typeIdx = header.indexOf("field_type");
  if (langIdx < 0 || textIdx < 0 || typeIdx < 0) {
    console.error("error: expected language, value_text, field_type columns");
    process.exit(2);
  }

  // Only augment rows that have non-empty text and field_type=text.
  const eligibleIdx = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (r[typeIdx] === "text" && r[textIdx] && r[textIdx].length > 0) {
      eligibleIdx.push(i);
    }
  }

  const targetLangs = assignTargetLanguages(eligibleIdx.length);
  let translated = 0;
  for (let k = 0; k < eligibleIdx.length; k++) {
    const i = eligibleIdx[k];
    const targetLang = targetLangs[k];
    if (targetLang === "en") continue; // keep English rows as-is
    const r = dataRows[i];
    const targetLen = r[textIdx].length;
    r[textIdx] = pickPhrase(targetLang, targetLen);
    r[langIdx] = targetLang;
    translated++;
  }

  const backupPath = inputPath.replace(/\.csv$/, ".original.csv");
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(inputPath, backupPath);
    console.error(`backed up original → ${backupPath}`);
  } else {
    console.error(`backup already exists, leaving ${backupPath} untouched`);
  }
  fs.writeFileSync(inputPath, serializeCsv(header, dataRows));

  const langCounts = {};
  for (const r of dataRows) {
    const lang = r[langIdx] || "(empty)";
    langCounts[lang] = (langCounts[lang] || 0) + 1;
  }
  console.error(`wrote ${dataRows.length} rows → ${inputPath}`);
  console.error(`translated ${translated} rows`);
  console.error("language mix:", langCounts);
}

main();
