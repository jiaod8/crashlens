#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectLog } from "../src/index.mjs";
import { renderMarkdown, renderSummary } from "../src/report.mjs";

const VERSION = "0.1.0";

const HELP = `crashlens ${VERSION} — turn a raw crash log into a ranked root-cause report.

Usage
  crashlens <file...>            analyze one or more log files (or "-" for stdin)
  cat log.txt | crashlens -

Options
  --md <path>       write a full Markdown report
  --json            print machine-readable JSON instead of the terminal summary
  --environment <s> label the environment (e.g. "Node 24 / Windows 11")
  --source <name>   title to show in the report (default: file name)
  --no-source       do not read source files for context
  -h, --help        show this help
  -v, --version     print version

Exit codes
  0  analysis produced
  1  no recognizable failure found
  2  bad usage

Every finding traces to a line in the input. Hypotheses are candidates ranked by
evidence, not verdicts.`;

function parseArgs(argv) {
  const opts = { files: [], md: null, json: false, environment: null, source: null, readSource: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--no-source") opts.readSource = false;
    else if (a === "--md") opts.md = argv[++i];
    else if (a === "--environment") opts.environment = argv[++i];
    else if (a === "--source") opts.source = argv[++i];
    else if (a === "-") opts.files.push("-");
    else if (a.startsWith("-")) {
      console.error(`crashlens: unknown option ${a}`);
      process.exit(2);
    } else opts.files.push(a);
  }
  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (!opts.files.length) { console.error(HELP); process.exit(2); }

  const texts = [];
  for (const f of opts.files) {
    if (f === "-") texts.push({ name: opts.source ?? "<stdin>", text: await readStdin() });
    else {
      if (!existsSync(f)) { console.error(`crashlens: no such file: ${f}`); process.exit(2); }
      if (statSync(f).isDirectory()) { console.error(`crashlens: is a directory: ${f}`); process.exit(2); }
      texts.push({ name: opts.source ?? basename(f), text: readFileSync(f, "utf8") });
    }
  }

  const merged = texts.map((t) => t.text).join("\n");
  const source = texts.length === 1 ? texts[0].name : texts.map((t) => t.name).join(", ");
  const { records, analyses } = inspectLog(merged, { source });

  if (!records.length) {
    console.error("crashlens: no recognizable failure signature in the input.");
    console.error("Supported shapes: null/undefined access, not-iterable, stack overflow, OOM, missing module/file,");
    console.error("EADDRINUSE, ECONN*, unhandled rejection, assertion, native fault (SIGSEGV), timeouts.");
    console.error("If this is a plain stack trace without a message, prepend the error line or open an issue with a sample.");
    process.exit(1);
  }

  const meta = {
    source,
    records: records.length,
    environment: opts.environment,
    generatedAt: new Date().toISOString(),
    toolVersion: VERSION,
  };

  if (opts.json) {
    console.log(JSON.stringify({ meta, analyses }, null, 2));
    return;
  }

  const md = renderMarkdown(analyses, meta);
  if (opts.md) {
    writeFileSync(resolve(opts.md), md);
    console.error(`crashlens: report written to ${resolve(opts.md)}`);
  }
  if (opts.md) console.log(renderSummary(analyses, meta));
  else console.log(md);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`crashlens: ${err?.stack ?? err}`);
    process.exit(2);
  });
}