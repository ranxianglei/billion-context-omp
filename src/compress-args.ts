import { logWarn } from "./log.js";

/**
 * Lenient parsing of compress tool arguments (issue #121).
 *
 * The strict JSON.parse in compressToolArgs silently drops fold blocks when
 * the model emits malformed args (code fences, trailing commas, stringified
 * content, truncated arrays). Weak/local models hit this at high rates.
 * This module salvages what it can and logs evidence on total failure so the
 * root cause is locatable instead of a silent no-op.
 */

/**
 * Salvage complete range objects from a truncated JSON array.
 * Scans for top-level {...} entries inside the outermost [ ... ] and parses
 * each one independently. Returns the salvaged objects, or null if none.
 */
function salvageArrayEntries(text: string): unknown[] | null {
  const arrStart = text.indexOf("[");
  if (arrStart === -1) return null;

  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;

  for (let i = arrStart; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 1) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 1 && objStart !== -1) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* skip malformed entry */ }
        objStart = -1;
      }
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Lenient JSON parse with progressive repair and salvage.
 * Returns the parsed value (object or array), or null on total failure
 * (with evidence logged).
 */
export function lenientJsonParse(raw: string): unknown {
  // Strip markdown code fences (```json ... ``` or ``` ... ```).
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(text);
  } catch { /* fall through to repair */ }

  // Remove trailing commas before } or ] (common LLM artifact), then retry.
  const repaired = text.replace(/,(\s*[}\]])/g, "$1");
  if (repaired !== text) {
    try {
      return JSON.parse(repaired);
    } catch { /* fall through to salvage */ }
  }

  // Salvage: the object opened but the content array was truncated mid-entry.
  const m = text.match(/"content"\s*:\s*(\[[\s\S]*)$/);
  if (m) {
    const salvaged = salvageArrayEntries(m[1]!);
    if (salvaged) {
      const prefix = text.slice(0, m.index!);
      const topic = prefix.match(/"topic"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const obj: Record<string, unknown> = { content: salvaged };
      if (topic) {
        try { obj.topic = JSON.parse(`"${topic[1]}"`); } catch { obj.topic = topic[1]; }
      }
      return obj;
    }
  }

  logWarn("compress-args", {
    event: "parse-failed",
    rawLen: raw.length,
    rawPreview: raw.slice(0, 800),
  });
  return null;
}
