// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: record PeTTa's own result for every example in a PeTTa checkout: silent stdout, stderr, exit
// status and wall time, one JSON file per example, run the way PeTTa's test.sh runs it.
// am[implements a-mettascript-petta-1104.oracle]
//
// Usage: node scripts/petta-oracle.mjs --petta=<PeTTa checkout> --out=<dir> [--jobs=N] [--timeout=S]
//          [--filter=<substring>]
// Each example runs as `sh run.sh ./examples/<name>.metta --silent [--strict|--strict-det]` from the checkout
// root with stdin closed, PETTA_STACK_LIMIT=3g, and the mode flag test.sh's mode_arg_for_test gives it.
// The timeout contains examples known to run unbounded (repl and greedy_chess loop on end-of-file with stdin
// closed, printing without end); a timed-out run is recorded as such, never dropped. Each stream keeps its first
// CAP bytes and counts the rest, since those two print hundreds of megabytes before the timeout.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unrecognised argument ${a}`);
    return [m[1], m[2] ?? "1"];
  }),
);
if (!args.petta || !args.out) throw new Error("usage: --petta=<PeTTa checkout> --out=<dir>");
const PETTA = resolve(args.petta);
const OUT = resolve(args.out);
const JOBS = Number(args.jobs ?? 2);
const TIMEOUT_MS = Number(args.timeout ?? 300) * 1000;
const FILTER = args.filter ?? "";
mkdirSync(OUT, { recursive: true });

// test.sh: strictdet_* and fail_strictdet_* run with --strict-det; strict_* and fail_strict_* with --strict.
export function modeFlag(name) {
  if (/^(fail_)?strictdet_/.test(name)) return "--strict-det";
  if (/^(fail_)?strict_/.test(name)) return "--strict";
  return "";
}

const names = readdirSync(join(PETTA, "examples"))
  .filter((f) => f.endsWith(".metta"))
  .map((f) => f.slice(0, -".metta".length))
  .filter((n) => n.includes(FILTER))
  .sort();

const CAP = 1 << 20;

// The first CAP bytes of a stream plus its total length. A UTF-8 character split at the cap decodes as U+FFFD;
// comparisons of truncated records use the same cap on both sides, so both split at the same byte.
function capture() {
  const chunks = [];
  let kept = 0;
  let total = 0;
  return {
    push: (d) => {
      total += d.length;
      if (kept < CAP) {
        const part = d.subarray(0, CAP - kept);
        chunks.push(part);
        kept += part.length;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    bytes: () => total,
  };
}

function runOne(name) {
  const mode = modeFlag(name);
  const argv = ["run.sh", `./examples/${name}.metta`, "--silent", ...(mode ? [mode] : [])];
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn("sh", argv, {
      cwd: PETTA,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PETTA_STACK_LIMIT: "3g" },
      detached: true,
    });
    const out = capture();
    const err = capture();
    child.stdout.on("data", out.push);
    child.stderr.on("data", err.push);
    let timedOut = false;
    // Kill the whole process group: run.sh's swipl is a grandchild of this spawn.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, TIMEOUT_MS);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      const rec = {
        name,
        mode,
        argv,
        status,
        signal,
        timedOut,
        ms: Math.round(performance.now() - t0),
        stdout: out.text(),
        stderr: err.text(),
        stdoutBytes: out.bytes(),
        stderrBytes: err.bytes(),
        truncated: out.bytes() > CAP || err.bytes() > CAP,
      };
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify(rec, null, 1));
      done(rec);
    });
  });
}

// Time: sum of example runtimes / JOBS wall-clock. Space: one stdout/stderr buffer per running job.
let next = 0;
const summary = [];
async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const r = await runOne(name);
    summary.push({ name, status: r.status, timedOut: r.timedOut, ms: r.ms });
    process.stdout.write(`${r.timedOut ? "TIMEOUT" : r.status} ${r.ms}ms ${name}\n`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
summary.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(OUT, "_summary.json"), JSON.stringify(summary, null, 1));
