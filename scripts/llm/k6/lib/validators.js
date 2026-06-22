// Response validators for LLM scenarios.
//
// Each validator returns a flat object suitable for feeding directly into k6
// Rate/Counter metrics so we can answer the ticket's "malformed
// structured-output rate" question.

export function validateTranslationResponse(responseJson, expectedKeys) {
  // Defaults assume worst case so a missing/empty response counts as a failure.
  const out = {
    parsed: false,
    valid: false,
    missingKeys: expectedKeys.length,
    presentKeys: 0,
    extraKeys: 0,
    emptyValues: 0,
  };

  let content = null;
  try {
    content = responseJson && responseJson.choices && responseJson.choices[0]
      ? responseJson.choices[0].message && responseJson.choices[0].message.content
      : null;
  } catch (_) {
    return out;
  }
  if (typeof content !== "string" || content.length === 0) return out;

  let obj;
  try {
    obj = JSON.parse(content);
  } catch (_) {
    return out;
  }
  out.parsed = true;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return out;

  const present = new Set(Object.keys(obj));
  const missing = expectedKeys.filter((k) => !present.has(k));
  out.missingKeys = missing.length;
  out.presentKeys = expectedKeys.length - missing.length;
  out.extraKeys = present.size - out.presentKeys;
  for (const k of expectedKeys) {
    const v = obj[k];
    if (typeof v !== "string" || v.length === 0) out.emptyValues++;
  }
  out.valid = out.missingKeys === 0 && out.emptyValues === 0;
  return out;
}

// Generic structural validator: parses choices[0].message.content as JSON
// and checks that every key in `requiredKeys` is present (any non-null value
// other than empty string counts as "present"). Used by survey-gen and
// chart-gen where the schema is fixed and large.
export function validateStructuredResponse(responseJson, requiredKeys) {
  const out = {
    parsed: false,
    valid: false,
    missingKeys: requiredKeys.length,
    presentKeys: 0,
  };
  let content = null;
  try {
    content = responseJson && responseJson.choices && responseJson.choices[0]
      ? responseJson.choices[0].message && responseJson.choices[0].message.content
      : null;
  } catch (_) {
    return out;
  }
  if (typeof content !== "string" || content.length === 0) return out;
  let obj;
  try {
    obj = JSON.parse(content);
  } catch (_) {
    return out;
  }
  out.parsed = true;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return out;
  const missing = requiredKeys.filter((k) => {
    const v = obj[k];
    if (v === undefined || v === null) return true;
    if (typeof v === "string" && v.length === 0) return true;
    if (Array.isArray(v) && v.length === 0) return false; // empty array still counts as present
    return false;
  });
  out.missingKeys = missing.length;
  out.presentKeys = requiredKeys.length - missing.length;
  out.valid = out.missingKeys === 0;
  return out;
}

export function tokenUsage(responseJson) {
  try {
    const u = responseJson && responseJson.usage;
    if (!u) return { prompt: 0, completion: 0, total: 0 };
    return {
      prompt: u.prompt_tokens || 0,
      completion: u.completion_tokens || 0,
      total: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    };
  } catch (_) {
    return { prompt: 0, completion: 0, total: 0 };
  }
}
