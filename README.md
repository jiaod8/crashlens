# crashlens

**Turn a raw crash log into a ranked root-cause report with evidence.**

```bash
$ crashlens desktop-next-2026-11-19.0.jsonl
crashlens — desktop-next-2026-11-19.0.jsonl
6 record(s) / 4 shape(s)

1. [  3x  50%] Cannot read properties of null (reading 'content')
   a property was read from null/undefined
   → offloadOldestImages @ …/dsh-compaction-image-offload/lib/index.js:35
   ⚠ locally modified file in path
   confidence: high
```

No network, no account, no LLM call. Every finding traces to a line in your input.

---

## Why

A stack trace tells you *where* execution died. It does not tell you:

- which frame is worth reading first (the innermost one is often a stdlib line)
- whether this failure is structural (will happen on every request) or incidental
- whether one of the files in the path was modified locally, which silently breaks the contract the rest of the code was written against
- which of several plausible causes to test first

`crashlens` does that pass for you, deterministically, in under a second.

## Install

```bash
npm i -g crashlens
# or, from a checkout
node bin/crashlens.mjs --help
```

Requires Node 18+. No dependencies.

## Usage

```bash
crashlens app.log                     # full Markdown report to stdout
crashlens app.log --md report.md      # report to file, summary to terminal
crashlens -  < app.log                # read stdin
crashlens svc.log worker.log --json   # machine-readable output
crashlens app.log --environment "Node 24 / Windows 11"
```

| Option | Meaning |
|---|---|
| `--md <path>` | write the full Markdown report |
| `--json` | emit structured JSON instead of the summary |
| `--environment <s>` | label the runtime in the report |
| `--source <name>` | override the report title |
| `--no-source` | do not read source files |

Exit codes: `0` analyzed, `1` nothing recognizable, `2` bad usage.

## What it recognizes

| Shape | Example |
|---|---|
| null/undefined access | `Cannot read properties of null (reading 'x')` |
| type contract break | `x is not iterable`, `y is not a function` |
| unbounded recursion | `Maximum call stack size exceeded` |
| memory exhaustion | `heap out of memory`, `bad_alloc` |
| resolution failures | `Cannot find module`, `ENOENT` |
| binding conflicts | `EADDRINUSE` |
| network | `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND` |
| async orphans | `UnhandledPromiseRejection`, `Unhandled 'error' event` |
| violated invariants | `AssertionError` |
| native faults | `SIGSEGV`, `EXC_BAD_ACCESS`, `0xc0000005` |
| timeouts | `TimeoutError`, `DEADLINE_EXCEEDED`, `context deadline exceeded` |

Input dialects: plain text, and JSONL/logfmt-style envelopes (the human text in
`message`/`msg`/`error`/`stack`, the rest kept as context).

## What the report contains

1. **Verdict** — dominant failure, occurrence share, analysis confidence
2. **Failure shapes** — every distinct shape, grouped across volatile ids/timestamps
3. **Where to look** — frames ranked by *app > dependency > built > runtime*, with repeat counts
4. **Source** — a window around the suspect line, read from disk when reachable
5. **Local modification** — flagged when a file in the path has a backup sibling
   (`.orig`, `.bak`, `.orig-20260101`, …). This is the highest-signal finding in
   practice: a local patch changes a contract other code was written against.
6. **Hypotheses** — ranked candidates for this failure shape
7. **How to confirm** — the specific experiment that kills or supports each one

## Design principles

- **Deterministic.** Same input, same report. No model calls, no ranking drift.
- **Traceable.** Every line of the report cites an input line, a frame, or a
  rule that is written in `src/`.
- **Honest about limits.** Hypotheses are labelled as candidates. Confidence
  measures how much evidence the *input* provides, not certainty about the cause.
- **Zero dependencies.** One file in, one report out, works offline and in CI.

## Limits

- It does not run your program, so it cannot prove a cause — only rank them.
- Source windows require the file to exist at the logged path on the machine
  running crashlens.
- Minified bundles produce useless frames; feed it source-mapped or unminified logs.
- Empty or message-less stack traces are rejected rather than guessed at.

## Library use

```js
import { inspectLog } from "crashlens";

const { records, analyses } = inspectLog(rawLogText, { source: "app.log" });
for (const a of analyses) {
  console.log(a.sample, a.count, a.primaryFrame?.file, a.confidence.level);
}
```

## License

MIT