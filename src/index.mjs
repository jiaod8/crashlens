export { extractRecords, groupRecords, parseFrames, normalizeKey, normalizeText, SIGNATURES } from "./parse.mjs";
export { analyze, rankFrames, classifyPath, detectLocalModification, sourceContext, recurrenceVerdict, confidenceFor } from "./analyze.mjs";
export { renderMarkdown, renderSummary } from "./report.mjs";

import { extractRecords, groupRecords } from "./parse.mjs";
import { analyze } from "./analyze.mjs";

/**
 * One-call convenience pipeline.
 * @param {string} text raw log content
 * @param {{source?:string}} options
 */
export function inspectLog(text, { source = "<input>" } = {}) {
  const records = extractRecords(text, source);
  const groups = groupRecords(records);
  const analyses = analyze(text, { sourceName: source, groups });
  return { records, groups, analyses };
}