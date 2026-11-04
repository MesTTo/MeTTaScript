// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: score the petta engine against PeTTa's own results: run each vendored ee5cacb example through
// packages/petta's CLI the way test.sh runs it and compare with its oracle record, writing a per-example table.
// am[implements a-mettascript-petta-1104.oracle]
//
// Usage: node scripts/petta-compare.mjs [--jobs=N] [--timeout=S] [--filter=substr] [--out=file.json] [--names=a,b]
// Verdicts: match, mismatch (stdout or exit class differs), error (engine crash), timeout. Rules:
//  - normal and strict examples match when stdout is byte-identical and the exit class (0, non-zero, timeout)
//    agrees; test_datetime's clock readings are masked on both sides, since PeTTa's own runs differ there;
//  - fail_* examples match when the run exits non-zero printing one of test.sh's type-error phrases;
//  - examples PeTTa ran past the oracle's 300 s cap match when ours also runs past this run's cap and the
//    stdout both printed agrees over their common length.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const corpus = join(root, "packages/petta/corpus/ee5cacb");
const cli = join(root, "packages/petta/dist/cli.js");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);
const JOBS = Number(args.jobs ?? 4);
const TIMEOUT_MS = Number(args.timeout ?? 60) * 1000;
const FILTER = args.filter ?? "";
const NAMES = args.names ? new Set(args.names.split(",")) : null;
const OUT = args.out ? resolve(args.out) : null;
const CAP = 65536;

const FAIL_RE =
  /Type mismatch|Type conflict|Determinism check failed|Conflicting determinism declarations|Deterministic function .* overlapping clauses|Deterministic function .* is not exhaustive|Strict mode rejected residual runtime type goal|Strict mode cannot express the unresolved nominal intersection|SpaceOf declaration .* rejects existing row|Strict mode requires a declared or inferable type|No matching typed overload|Declared output type variable|Declared parametric parameter|Arrows are prefix|--strict-det requires|Effect-polymorphic declaration|Effect variable|car-atom expects a non-empty expression|Syntax error|is unbound: a -\[.*\]-> function requires bound arguments|is not a proper list: its -\[.*\]-> proof requires a bound proper list/;

// test_datetime prints the wall clock: mask its readings, the one place two PeTTa runs disagree.
const NORMALIZE = {
  test_datetime: (s) => s.replace(/\(\d+\.\d+\)/g, "(<time>)").replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, "<datetime>").replace(/\d\d:\d\d:\d\d/g, "<clock>"),
};

const names = readdirSync(join(corpus, "examples"))
  .filter((f) => f.endsWith(".metta"))
  .map((f) => f.slice(0, -6))
  .filter((n) => n.includes(FILTER) && (NAMES === null || NAMES.has(n)))
  .sort();
// git_import's oracle run found its repository already cloned under repos/ (its stdout has no "Cloning ..."
// line), as any run after the first does; give this run the same starting state.
// am[implements a-mettascript-petta-1104.oracle]
const GIT_IMPORT_REPO = join(corpus, "repos/test_metta_lib");
if (names.includes("git_import") && !existsSync(GIT_IMPORT_REPO)) {
  const r = spawnSync("git", ["clone", "--depth", "1", "https://github.com/rTreutlein/test_metta_lib.git", GIT_IMPORT_REPO], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`cloning git_import's repository failed: ${r.error ?? r.status}`);
}

function run(name, mode) {
  const argv = [cli, `./examples/${name}.metta`, "--silent", ...(mode ? [mode] : [])];
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, argv, { cwd: corpus, stdio: ["ignore", "pipe", "pipe"] });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on("data", (d) => {
      if (out.length < CAP * 2) out = Buffer.concat([out, d]);
    });
    child.stderr.on("data", (d) => {
      if (err.length < CAP) err = Buffer.concat([err, d]);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, timedOut, ms: Math.round(performance.now() - t0), stdout: out.toString("utf8"), stderr: err.toString("utf8") });
    });
  });
}

function judge(name, oracle, r) {
  const cls = (st) => (st === "timeout" ? "timeout" : st === 0 ? "0" : "nonzero");
  const ours = r.timedOut ? "timeout" : r.status === 0 ? "0" : "nonzero";
  if (name.startsWith("fail_")) {
    if (ours === "nonzero" && FAIL_RE.test(r.stdout + r.stderr)) return "match";
    return ours === "timeout" ? "timeout" : "mismatch";
  }
  if (oracle.status === "timeout") {
    if (!r.timedOut) return "mismatch";
    const n = Math.min(oracle.stdout.length, r.stdout.length, CAP);
    return oracle.stdout.slice(0, n) === r.stdout.slice(0, n) ? "match" : "mismatch";
  }
  if (r.timedOut) return "timeout";
  const norm = NORMALIZE[name] ?? ((s) => s);
  if (norm(r.stdout) === norm(oracle.stdout) && cls(oracle.status) === ours) return "match";
  if (!r.stdout && r.stderr && /^(Error|TypeError|RangeError|ReferenceError)|\n\s+at /.test(r.stderr)) return "error";
  return "mismatch";
}

const results = [];
let next = 0;
async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const oracle = JSON.parse(readFileSync(join(corpus, "oracle", name + ".json"), "utf8"));
    const r = await run(name, oracle.mode);
    const verdict = judge(name, oracle, r);
    const rec = { name, verdict, status: r.timedOut ? "timeout" : r.status, oracleStatus: oracle.status, ms: r.ms };
    if (verdict !== "match") {
      rec.stdout = r.stdout.slice(0, 2000);
      rec.stderr = r.stderr.slice(0, 2000);
      rec.expected = oracle.stdout.slice(0, 2000);
    }
    results.push(rec);
    if (!OUT) process.stdout.write(`${verdict.padEnd(8)} ${String(r.ms).padStart(6)}ms ${name}\n`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
results.sort((a, b) => a.name.localeCompare(b.name));
const cls = (n) => (n.startsWith("fail_") ? "fail" : /^(strict|strictdet)_/.test(n) ? "strict" : "normal");
const summary = {};
for (const r of results) {
  const k = cls(r.name);
  summary[k] ??= { match: 0, mismatch: 0, error: 0, timeout: 0 };
  summary[k][r.verdict]++;
}
console.log(JSON.stringify(summary));
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
