import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectLog } from "../src/index.mjs";
import { parseFrames, extractRecords, groupRecords, normalizeKey } from "../src/parse.mjs";
import { unwrapLines, unwrapLine, ingestionProfile } from "../src/ingest.mjs";
import { rankFrames, detectLocalModification, toFsPath, confidenceFor } from "../src/analyze.mjs";
import { renderMarkdown, renderSummary } from "../src/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "crashlens.mjs");

test("parses V8, Firefox and native frames", () => {
  const v8 = parseFrames(`    at visit (D:\\app\\lib\\index.js:35:25)`);
  assert.equal(v8[0].fn, "visit");
  assert.equal(v8[0].file, "D:\\app\\lib\\index.js");
  assert.equal(v8[0].line, 35);
  assert.equal(v8[0].column, 25);

  const bare = parseFrames("\tat /srv/app/index.js:12:3");
  assert.equal(bare[0].fn, null);
  assert.equal(bare[0].file, "/srv/app/index.js");

  const ff = parseFrames("someFn@https://x.test/app.js:10:5");
  assert.equal(ff[0].fn, "someFn");
  assert.equal(ff[0].line, 10);

  const native = parseFrames("    at native");
  assert.equal(native[0].native, true);
});

test("recognizes a null-property crash and captures the property name", () => {
  const text = [
    "TypeError: Cannot read properties of null (reading 'content')",
    "    at visit (D:\\app\\lib\\a.js:35:25)",
    "    at run (D:\\app\\lib\\a.js:37:9)",
  ].join("\n");
  const records = extractRecords(text, "t.log");
  assert.equal(records.length, 1);
  assert.equal(records[0].signature, "null-property-access");
  assert.equal(records[0].captured, "content");
  assert.equal(records[0].frames.length, 2);
});

test("record spans the whole stack and stops at the next error", () => {
  const text = [
    "ERROR boom",
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "    at a (f.js:1:1)",
    "    at b (f.js:2:2)",
    "EADDRINUSE: address already in use",
    "    at listen (net.js:1:1)",
  ].join("\n");
  const records = extractRecords(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].frames.length, 2);
  assert.equal(records[1].signature, "port-in-use");
});

test("unwraps JSONL envelopes and keeps context", () => {
  const line = JSON.stringify({
    time: "2026-11-19T06:16:44Z",
    level: "error",
    source: "agent",
    message: "TypeError: Cannot read properties of null (reading 'content')\n    at visit (a.js:35:25)",
  });
  const u = unwrapLine(line);
  assert.ok(u);
  assert.match(u.text, /Cannot read properties/);
  assert.equal(u.context.level, "error");
  assert.equal(u.context.source, "agent");

  const entries = unwrapLines(line);
  assert.equal(entries.length, 2); // message line + frame line
  assert.equal(ingestionProfile(entries).dialect, "jsonl");

  const records = extractRecords(line, "s.jsonl");
  assert.equal(records.length, 1);
  assert.equal(records[0].frames.length, 1);
  assert.equal(records[0].context.source, "agent");
});

test("non-JSON lines pass through untouched", () => {
  assert.equal(unwrapLine("plain text"), null);
  assert.equal(unwrapLine("{not json}"), null);
  assert.equal(unwrapLine('["array"]'), null);
});

test("groups the same failure across volatile ids and timestamps", () => {
  const a = "TypeError: Cannot read properties of null (reading 'content')";
  assert.equal(normalizeKey(a), normalizeKey(a));

  const g1 = "EADDRINUSE 127.0.0.1:8326";
  const g2 = "EADDRINUSE 127.0.0.1:9999";
  assert.equal(normalizeKey(g1), normalizeKey(g2));

  const records = [
    ...extractRecords(`TypeError: Cannot read properties of null (reading 'content')\n    at v (a.js:1:1)`, "a"),
    ...extractRecords(`TypeError: Cannot read properties of null (reading 'content')\n    at v (a.js:1:1)`, "b"),
    ...extractRecords(`EADDRINUSE: address already in use 127.0.0.1:1`, "c"),
  ];
  const groups = groupRecords(records);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].records.length, 2); // sorted by count desc
});

test("ranks application frames above runtime frames", () => {
  const frames = [
    { fn: "tick", file: "node:internal/timers:1:1", line: 1 },
    { fn: "handler", file: "D:\\app\\src\\server.js", line: 10 },
  ].map((f) => ({ ...f, column: 1, raw: "", native: false }));
  const ranked = rankFrames(frames);
  assert.equal(ranked[0].fn, "handler");
  assert.equal(ranked[0].kind, "app");
});

test("detects a locally modified dependency by its sibling backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "cl-"));
  mkdirSync(join(dir, "node_modules", "pkg", "lib"), { recursive: true });
  const file = join(dir, "node_modules", "pkg", "lib", "index.js");
  writeFileSync(file, "// lib\n");
  assert.equal(detectLocalModification(file), null);

  writeFileSync(`${file}.orig-20261119`, "// lib\n");
  const signals = detectLocalModification(file);
  assert.ok(signals.some((s) => s.startsWith("sibling-backup:")));
});

test("normalizes file URLs into filesystem paths", () => {
  assert.match(toFsPath("file:///D:/x%20y/lib.js"), /^D:[\\/]x y[\\/]lib\.js$/);
  assert.equal(toFsPath("/srv/app.js"), "/srv/app.js");
  assert.equal(toFsPath(null), null);
});

test("confidence reflects the evidence present", () => {
  const thin = { records: [{ frames: [], signature: "timeout" }] };
  assert.equal(confidenceFor(thin, null, null).level, "low");

  const rich = {
    records: [
      { frames: [{ file: "D:\\app\\a.js", line: 1 }] },
      { frames: [] },
      { frames: [] },
    ],
  };
  const high = confidenceFor(rich, { file: "D:\\app\\a.js", kind: "app" }, [{ file: "D:\\app\\a.js" }]);
  assert.equal(high.level, "high");
});

test("renders a report that states its own limits", () => {
  const text = [
    "TypeError: Cannot read properties of null (reading 'content')",
    "    at visit (D:\\app\\node_modules\\pkg\\lib\\index.js:35:25)",
  ].join("\n");
  const { records, analyses } = inspectLog(text, { source: "x.log" });
  const md = renderMarkdown(analyses, { source: "x.log", records: records.length, toolVersion: "test" });
  assert.match(md, /# Crash analysis/);
  assert.match(md, /## Verdict/);
  assert.match(md, /### Hypotheses/);
  assert.match(md, /Hypotheses are candidates, not verdicts/);
  assert.ok(renderSummary(analyses, { source: "x.log", records: records.length }).length > 0);
});

test("CLI analyzes a file end to end", () => {
  const out = execFileSync(process.execPath, [bin, join(here, "fixtures", "node-null.log")], { encoding: "utf8" });
  assert.match(out, /# Crash analysis/);
  assert.match(out, /null/);
});

test("CLI exits 1 when nothing looks like a failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "cl-"));
  const f = join(dir, "clean.log");
  writeFileSync(f, "all good\nnothing to see\n");
  let code = 0;
  try {
    execFileSync(process.execPath, [bin, f], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 1);
});

test("CLI emits JSON when asked", () => {
  const out = execFileSync(process.execPath, [bin, join(here, "fixtures", "node-null.log"), "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.analyses));
  assert.ok(parsed.meta.records >= 4);
});