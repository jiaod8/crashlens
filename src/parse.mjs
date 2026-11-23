/**
 * Log ingestion: split a raw log into error records and parse stack frames.
 * No dependencies, no network, no AI. Everything here is deterministic.
 */

import { unwrapLines } from "./ingest.mjs";

const ANSI = /\u001b\[[0-9;]*m/g;

/** Strip ANSI colors and normalize CRLF. */
export function normalizeText(text) {
  return String(text).replace(ANSI, "").replace(/\r\n?/g, "\n");
}

/**
 * Error signatures we can recognize. Order matters: first match wins.
 * `gist` describes the failure shape, `hypotheses` are root-cause families to
 * investigate (never assertions of the one true cause).
 */
export const SIGNATURES = [
  {
    id: "null-property-access",
    re: /Cannot read propert(?:y|ies) of (?:null|undefined) \(reading '([^']+)'\)/i,
    gist: "a property was read from null/undefined",
    hypotheses: [
      "A value is null/undefined at this call site because an upstream producer is allowed to return nothing — check the producer's contract, not just this line.",
      "The value comes from a lookup (map.get / find / query) whose miss path was never handled.",
      "A value crosses an async boundary (await, callback, event) and a guard that existed before the await no longer covers it.",
      "A projection/serialization layer dropped the field: the object exists but the field does not.",
      "TypeScript `!` non-null assertion or a `as X` cast silenced a branch the runtime still takes.",
    ],
    verify: [
      "Log the producer's return value immediately before this frame, with the input that triggered it.",
      "Search the producer for `return null` / `return undefined` and enumerate every caller.",
      "Check whether the failing input is structurally different from the working inputs (empty array, missing field, replayed/rewound history).",
    ],
  },
  {
    id: "not-iterable",
    re: /(\S+) is not iterable|([\w.]+) is not a function|object is not iterable/i,
    gist: "a value's runtime type disagrees with what the code assumed",
    hypotheses: [
      "A shape changed upstream (array -> object, sync -> promise) and this call site was not updated.",
      "Two contract owners disagree: the producer documents one type, the consumer assumes another.",
      "A local patch or wrapper rewrote the value's shape for one code path only.",
    ],
    verify: [
      "Log `typeof` / `Array.isArray` / constructor of the value right before the failing operation.",
      "Diff the producer's declared return type against what is actually returned on this path.",
    ],
  },
  {
    id: "max-call-stack",
    re: /Maximum call stack size exceeded|RangeError: Maximum call stack/i,
    gist: "unbounded recursion or a reactive cycle",
    hypotheses: [
      "A recursive walker has no depth bound or no visited-set.",
      "An observer/effect re-triggers the write that notified it.",
      "Getter/setter indirection recurses (a property reads itself through a proxy).",
    ],
    verify: [
      "Print the repeating frame cycle — the same 2-5 frames repeating identifies the cycle.",
      "Add a depth counter and log the depth at failure.",
    ],
  },
  {
    id: "oom",
    re: /heap out of memory|JavaScript heap|std::bad_alloc|OutOfMemoryError|Cannot allocate memory/i,
    gist: "memory exhaustion",
    hypotheses: [
      "An unbounded cache/array grows per request and is never trimmed.",
      "A retention path keeps large objects alive (closure capture, global map, event listener).",
      "A single oversized payload is loaded fully into memory instead of streamed.",
    ],
    verify: [
      "Take a heap snapshot at failure and diff two snapshots taken minutes apart.",
      "Check whether memory grows with request count or with payload size.",
    ],
  },
  {
    id: "module-missing",
    re: /Cannot find module '([^']+)'|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i,
    gist: "module resolution failure",
    hypotheses: [
      "The dependency is a devDependency or an optional peer, absent in the installed tree.",
      "ESM vs CJS interop: the specifier resolves under `require` but not under `import`.",
      "A packaging step omitted the file from the shipped artifact.",
    ],
    verify: [
      "Resolve the specifier from the failing file's directory, not the project root.",
      "List the installed tree and confirm the package is actually present at that depth.",
    ],
  },
  {
    id: "file-missing",
    re: /ENOENT: no such file or directory, (?:open|stat|scandir) '([^']+)'/i,
    gist: "a path that was expected to exist does not",
    hypotheses: [
      "A relative path is resolved against a different working directory at runtime than at development time.",
      "The file is generated at build time and the consumer reads it before generation.",
      "Path casing or separators differ between platforms.",
    ],
    verify: [
      "Log `process.cwd()` and the fully resolved absolute path at the failure site.",
      "Confirm the file exists at that absolute path on the failing machine.",
    ],
  },
  {
    id: "port-in-use",
    re: /EADDRINUSE/i,
    gist: "the listening port is already bound",
    hypotheses: [
      "A previous instance did not exit (crash, or a detached child).",
      "Two components are configured with the same port.",
    ],
    verify: ["List the process holding the port before retrying."],
  },
  {
    id: "connection",
    re: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i,
    gist: "a network peer was unreachable or dropped the connection",
    hypotheses: [
      "The peer is down or not yet started (startup ordering, race).",
      "A proxy or DNS resolver in the runtime environment differs from the one used in testing.",
      "A load balancer or TLS terminator has a shorter timeout than the client.",
    ],
    verify: [
      "Connect to the same host:port from the failing process, not from your shell.",
      "Compare resolver output inside the runtime environment.",
    ],
  },
  {
    id: "promise-unhandled",
    re: /UnhandledPromiseRejection|unhandledRejection|Unhandled 'error' event/i,
    gist: "an async failure had no handler",
    hypotheses: [
      "A floating promise (no await, no .catch) — the caller moved on before the failure.",
      "An event emitter emitted 'error' with no listener.",
    ],
    verify: [
      "Install a process-level handler that prints the full rejection reason and stack.",
      "Search for calls to the failing async function whose result is not awaited.",
    ],
  },
  {
    id: "assertion",
    re: /AssertionError|assertion failed|expected .* to (?:equal|be|match)/i,
    gist: "an explicit invariant was violated",
    hypotheses: [
      "An assumption that held in development does not hold in the current data/environment.",
      "Two components were updated at different times and their contract drifted.",
    ],
    verify: ["Print both sides of the assertion at failure, not just which one failed."],
  },
  {
    id: "native-crash",
    re: /Segmentation fault|SIGSEGV|SIGABRT|EXC_BAD_ACCESS|0xc0000005|Bus error/i,
    gist: "native memory fault",
    hypotheses: [
      "Use-after-free or out-of-bounds access in native code or an FFI boundary.",
      "A native addon was built against a different runtime ABI than the one loading it.",
    ],
    verify: [
      "Reproduce under a native debugger and capture the faulting address and backtrace.",
      "Confirm the addon's ABI tag matches the runtime's.",
    ],
  },
  {
    id: "timeout",
    re: /timed? out|TimeoutError|DEADLINE_EXCEEDED|context deadline exceeded/i,
    gist: "an operation exceeded its deadline",
    hypotheses: [
      "The deadline is shorter than the operation's p99 latency.",
      "A downstream dependency degraded; the timeout is a symptom, not the fault.",
      "A retry loop multiplied the effective latency.",
    ],
    verify: ["Measure the operation's latency distribution, not a single sample."],
  },
];

/** One stack frame: `{ fn, file, line, column, raw, native }`. */
const FRAME_PATTERNS = [
  // V8 / Node / Chromium: at fn (file:line:col) | at file:line:col | at fn (native)
  /^\s*at\s+(?:(.*?)\s+\()?(?:(.+?):(\d+):(\d+)|(native)|(unknown location))\)?\s*$/,
  // Firefox / Safari: fn@file:line:col
  /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/,
  // Native: #0 0x00007f.. in fn file:line
  /^\s*#\d+\s+0x[0-9a-f]+\s+in\s+(.+?)(?:\s+(.+?):(\d+))?\s*$/i,
];

/**
 * Parse stack frames out of a text blob.
 * @returns {{fn:string|null,file:string|null,line:number|null,column:number|null,raw:string,native:boolean}[]}
 */
export function parseFrames(text) {
  const frames = [];
  for (const line of normalizeText(text).split("\n")) {
    for (const re of FRAME_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      let fn = null;
      let file = null;
      let ln = null;
      let col = null;
      let native = false;
      if (re === FRAME_PATTERNS[0]) {
        fn = m[1] ?? null;
        if (m[2]) { file = m[2]; ln = Number(m[3]); col = Number(m[4]); }
        else if (m[5] === "native") native = true;
      } else if (re === FRAME_PATTERNS[1]) {
        fn = m[1] || null;
        file = m[2]; ln = Number(m[3]); col = Number(m[4]);
      } else {
        fn = m[1] ?? null;
        if (m[2]) { file = m[2]; ln = Number(m[3]); }
        native = !m[2];
      }
      frames.push({ fn, file, line: ln, column: col, raw: line.trim(), native });
      break;
    }
  }
  return frames;
}

/**
 * Split a raw log into error records.
 * An error record starts at a line matching a signature and extends over the
 * following indented/`at ` lines (the stack) plus any continuation lines.
 * Structured (JSONL) input is unwrapped first so signatures match the message,
 * not the envelope.
 */
export function extractRecords(text, sourceName = "<input>") {
  const entries = unwrapLines(text);
  const lines = entries.map((e) => e.text);
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const sig = SIGNATURES.find((s) => s.re.test(line));
    if (!sig) continue;
    const match = sig.re.exec(line);
    const body = [line];
    let j = i + 1;
    while (j < lines.length && j - i < 200) {
      const next = lines[j];
      if (!next.trim()) {
        if (!/^\s*at\s|^\s*#\d+\s|^\s*[^@\s]*@/.test(lines[j + 1] ?? "")) break;
      } else if (/^\s*at\s|^\s*#\d+\s+0x|^\s*[^@\s]*@.+:\d+/.test(next)) {
        body.push(next);
      } else if (/^\s{2,}\S/.test(next) || /^(Caused by|Suppressed|Error:|TypeError|RangeError|ReferenceError)/.test(next)) {
        body.push(next);
      } else if (SIGNATURES.some((s) => s.re.test(next))) {
        break; // next record starts
      } else {
        body.push(next);
      }
      j += 1;
    }
    records.push({
      source: sourceName,
      line: i + 1,
      signature: sig.id,
      gist: sig.gist,
      message: line.trim(),
      captured: match?.[1] ?? null,
      context: nearestContext(entries, i),
      frames: parseFrames(body.join("\n")),
      raw: body.join("\n"),
    });
    i = j - 1;
  }
  return records;
}

/** The closest structured-record metadata at or before `index`. */
function nearestContext(entries, index) {
  for (let k = index; k >= 0 && k > index - 400; k -= 1) {
    if (entries[k]?.context) return entries[k].context;
  }
  return null;
}

/**
 * Group records by failure shape: strip volatile tokens (numbers, hex, ids,
 * absolute paths) so the same failure in different requests collapses together.
 */
export function groupRecords(records) {
  const groups = new Map();
  for (const r of records) {
    const key = normalizeKey(r.message);
    if (!groups.has(key)) groups.set(key, { key, signature: r.signature, gist: r.gist, sample: r.message, records: [] });
    groups.get(key).records.push(r);
  }
  return [...groups.values()].sort((a, b) => b.records.length - a.records.length);
}

export function normalizeKey(message) {
  return message
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#id")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "#path")
    .replace(/\/[^\s'"]+/g, "#path")
    .replace(/\b\d+(\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}