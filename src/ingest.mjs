/**
 * Ingestion: reduce many log dialects to a stream of (text, context) lines.
 *
 * Real crash logs are rarely plain text. The two shapes that matter most:
 *   - JSONL: every line is one JSON object; the human text lives in
 *     `message` / `msg` / `error` / `stack` and the rest is context.
 *   - Prefixed text: `2026-... ERROR service: message`.
 *
 * Unwrapping first is what lets the signature matcher see the actual error
 * instead of a wall of JSON.
 */

const TEXT_FIELDS = ["message", "msg", "error", "err", "stack", "trace", "reason", "detail", "details"];
const LEVEL_FIELDS = ["level", "lvl", "severity", "logLevel"];
const CONTEXT_FIELDS = ["source", "logger", "module", "component", "service", "pluginId", "pid", "runId", "time", "timestamp", "ts"];

/** Flatten an error-ish JSON value into text (string, {message,stack}, nested). */
function valueToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueToText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const parts = [];
    for (const k of ["message", "msg", "name", "stack", "code", "reason"]) {
      if (v[k] != null) parts.push(valueToText(v[k]));
    }
    if (!parts.length) {
      try { return JSON.stringify(v); } catch { return ""; }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Try to read one line as a structured record.
 * @returns {{text:string, context:object|null, structured:boolean}|null}
 */
export function unwrapLine(line) {
  const s = line.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const context = {};
  for (const k of LEVEL_FIELDS) if (obj[k] != null) context.level = String(obj[k]);
  for (const k of CONTEXT_FIELDS) if (obj[k] != null) context[k] = obj[k];
  if (obj.fields && typeof obj.fields === "object") {
    for (const k of ["pluginId", "subsystem", "component", "module"]) {
      if (obj.fields[k] != null && context[k] == null) context[k] = obj.fields[k];
    }
  }

  const parts = [];
  for (const k of TEXT_FIELDS) {
    if (obj[k] != null) parts.push(valueToText(obj[k]));
  }
  if (obj.data && typeof obj.data === "object") {
    for (const k of ["message", "error", "stack"]) if (obj.data[k] != null) parts.push(valueToText(obj.data[k]));
  }
  const text = parts.filter(Boolean).join("\n").trim();
  if (!text) return null;
  return { text, context: Object.keys(context).length ? context : null, structured: true };
}

/**
 * Normalize raw log text into entries. Multi-line values inside a JSON record
 * are expanded back into separate lines so stack parsing works unchanged.
 * @returns {{text:string, context:object|null, structured:boolean}[]}
 */
export function unwrapLines(text) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const u = unwrapLine(raw);
    if (u) {
      for (const l of u.text.split("\n")) out.push({ text: l, context: u.context, structured: true });
    } else {
      out.push({ text: raw, context: null, structured: false });
    }
  }
  return out;
}

/** How much of the input was structured — useful as a trust signal. */
export function ingestionProfile(entries) {
  const structured = entries.filter((e) => e.structured).length;
  const total = entries.length || 1;
  return {
    lines: entries.length,
    structuredLines: structured,
    ratio: structured / total,
    dialect: structured / total > 0.5 ? "jsonl" : "text",
  };
}