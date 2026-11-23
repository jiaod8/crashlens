/**
 * Analysis: turn parsed records into ranked hypotheses with evidence.
 * Deterministic, offline. Every claim is traceable to an input line or to a
 * rule stated here.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNFIX_HINT } from "./constants.mjs";

/**
 * Turn stack-frame locations into readable filesystem paths:
 * `file:///D:/x%20y/lib.js` -> `D:/x y/lib.js`.
 */
export function toFsPath(file) {
  if (!file) return file;
  let p = file;
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch { p = p.replace(/^file:\/\//i, ""); }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  try { p = decodeURIComponent(p); } catch { /* keep as-is */ }
  return p;
}

/** Third-party vs first-party path classification. */
export function classifyPath(file) {
  if (!file) return "unknown";
  if (/node_modules[\\/]/.test(file)) return "dependency";
  if (/[\\/](dist|build|out|lib|\.next|release)[\\/]/.test(file)) return "built";
  if (/^(node:|internal[\\/])/.test(file)) return "runtime";
  return "app";
}

/**
 * Paths that look locally modified — the highest-value signal in practice.
 * Only reports what can be evidenced: a sibling backup/reject file actually
 * present on disk, or a path that is itself a backup/scratch artifact.
 */
export function detectLocalModification(file) {
  if (!file) return null;
  const signals = [];
  if (/\.(orig|bak|old|backup|rej)(-[\w.-]+)?\b/i.test(file)) signals.push("backup-file");
  if (/[\\/](patched|tmp|scratch)[\\/]/i.test(file)) signals.push("scratch-dir");

  // The strongest evidence: this exact file has a sibling backup next to it.
  try {
    const dir = dirname(file);
    const base = basename(file);
    if (existsSync(dir)) {
      const isBackup = (n) => /\.(orig|bak|old|backup|rej)(-[\w.-]+)?$/i.test(n);
      const sibling = readdirSync(dir).find((n) => n !== base && n.startsWith(base) && isBackup(n));
      if (sibling) signals.push(`sibling-backup:${sibling}`);
    }
  } catch {
    /* unreachable path: no claim */
  }
  return signals.length ? signals : null;
}

/**
 * Score frames. Higher = more likely to be the place to look.
 * Rules are explicit so a reader can disagree with them.
 */
export function rankFrames(frames) {
  const seen = new Map();
  for (const f of frames) {
    const k = `${f.file ?? ""}:${f.line ?? ""}:${f.fn ?? ""}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return frames
    .map((f, index) => {
      const kind = classifyPath(f.file);
      const repeats = seen.get(`${f.file ?? ""}:${f.line ?? ""}:${f.fn ?? ""}`) ?? 1;
      let score = 0;
      if (kind === "app") score += 40;
      if (kind === "dependency") score += 25; // the bug may live upstream, but a patched dep matters
      if (kind === "built") score += 20;
      if (kind === "runtime") score -= 20;
      if (index === 0) score += 30; // innermost frame
      score += Math.min(repeats, 5) * 6;
      if (/anonymous|^$/.test(f.fn ?? "")) score -= 5;
      const fsPath = toFsPath(f.file);
      return { ...f, file: fsPath, index, kind, repeats, score, modified: detectLocalModification(fsPath) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Read a small window around a frame's line, if the file is reachable. */
export function sourceContext(frame, radius = 3) {
  if (!frame?.file || !frame.line) return null;
  try {
    if (!existsSync(frame.file)) return null;
    const lines = readFileSync(frame.file, "utf8").split("\n");
    if (frame.line > lines.length) return null;
    const start = Math.max(1, frame.line - radius);
    const end = Math.min(lines.length, frame.line + radius);
    return {
      file: frame.file,
      start,
      end,
      lines: lines.slice(start - 1, end).map((text, i) => ({
        n: start + i,
        text,
        hit: start + i === frame.line,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Recurrence verdict: does this failure look structural (will always happen on
 * this input) or incidental (timing/environment)?
 */
export function recurrenceVerdict(group, totalRecords) {
  const n = group.records.length;
  if (totalRecords <= 1) return { kind: "single", note: "one occurrence in this input" };
  const share = n / totalRecords;
  if (n >= 3 && share > 0.5) {
    return {
      kind: "dominant",
      note: `${n}/${totalRecords} records (${Math.round(share * 100)}%) — dominant failure shape; assume structural until proven otherwise`,
    };
  }
  if (n >= 3) return { kind: "repeated", note: `${n} identical-shape occurrences` };
  return { kind: "sporadic", note: `${n} occurrences` };
}

/**
 * Cross-record structural check: is there a precondition that all occurrences
 * share (e.g. every failure happens after a specific earlier event)?
 * Only reports what the input can actually show.
 */
export function sharedPrecondition(records) {
  if (records.length < 3) return null;
  const firstLines = records.map((r) => r.line);
  const span = Math.max(...firstLines) - Math.min(...firstLines);
  return {
    count: records.length,
    firstAt: Math.min(...firstLines),
    lastAt: Math.max(...firstLines),
    spread: span,
    note:
      span === 0
        ? "all occurrences on the same input line"
        : `occurrences spread across ${span} input lines`,
  };
}

/** Assemble the full analysis object for one input. */
export function analyze(text, { sourceName = "<input>", groups } = {}) {
  const all = groups ?? [];
  return all.map((group) => {
    const signature = group.records[0].signature;
    const spec = SIGNFIX_HINT[signature] ?? null;
    const frames = group.records[0].frames;
    const ranked = rankFrames(frames);
    const primary = ranked[0] ?? null;
    const context = primary ? sourceContext(primary) : null;
    const modifiedFrames = ranked.filter((f) => f.modified);
    return {
      signature,
      gist: group.gist,
      sample: group.sample,
      captured: group.records[0].captured,
      count: group.records.length,
      hypotheses: spec?.hypotheses ?? [],
      verify: spec?.verify ?? [],
      recurrence: recurrenceVerdict(group, all.reduce((n, g) => n + g.records.length, 0)),
      precondition: sharedPrecondition(group.records),
      rankedFrames: ranked.slice(0, 5),
      primaryFrame: primary,
      sourceContext: context,
      localModification: dedupeByFile(modifiedFrames),
      confidence: confidenceFor(group, primary, modifiedFrames),
    };
  });
}

/**
 * Confidence is about the *analysis*, not the cause: how much of the chain the
 * input actually supports.
 */
/** One entry per file, carrying the first line seen and all signals. */
function dedupeByFile(frames) {
  const byFile = new Map();
  for (const f of frames) {
    if (!byFile.has(f.file)) byFile.set(f.file, { file: f.file, line: f.line, signals: new Set() });
    for (const s of f.modified ?? []) byFile.get(f.file).signals.add(s);
  }
  const out = [...byFile.values()].map((v) => ({ ...v, signals: [...v.signals] }));
  return out.length ? out : null;
}

export function confidenceFor(group, primaryFrame, modifiedFrames) {
  let score = 30;
  const reasons = [];
  if (group.records[0].frames.length > 0) { score += 25; reasons.push("stack frames present"); }
  if (primaryFrame?.file) { score += 15; reasons.push(`resolved source location (${primaryFrame.kind})`); }
  if (modifiedFrames?.length) { score += 20; reasons.push("locally modified dependency in the path"); }
  if (group.records.length >= 3) { score += 10; reasons.push("repeated occurrences"); }
  const level = score >= 80 ? "high" : score >= 55 ? "medium" : "low";
  return { level, score, reasons };
}