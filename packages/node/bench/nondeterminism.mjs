// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Head-to-head subprocess benchmark for nondeterministic workloads reported against MeTTa TS.
// Inputs retain the reported query shapes. The harness validates direct output after timing so a
// benchmark assertion cannot trigger a different evaluator optimization.
//
// Usage:
//   pnpm bench:nondeterminism
//   PETTA_DIR=/path/to/PeTTa pnpm bench:nondeterminism
//   node packages/node/bench/nondeterminism.mjs --engine=ts --filter=fib

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { arg, benchDir, cliPath } from "./bench-common.mjs";

const casesDir = resolve(benchDir, "nondeterminism");
const pettaDir = resolve(process.env.PETTA_DIR ?? resolve(benchDir, "../../../../PeTTa"));
const pettaRunner = join(pettaDir, "run.sh");
const requestedEngine = arg("engine", "both");
const runs = Number(arg("runs", "15"));
const timeoutSeconds = Number(arg("timeout", "120"));
const timeoutMs = timeoutSeconds * 1000;
const filter = arg("filter", "");
const maxOutputBytes = 1 << 27;
const rssPollMs = 25;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node packages/node/bench/nondeterminism.mjs [options]

Options:
  --engine=both|ts|petta  Engines to run (default: both)
  --runs=N                Successful samples per engine and case (default: 15)
  --timeout=SECONDS       Per-process timeout (default: 120)
  --filter=TEXT           Run fixture names containing TEXT

Set PETTA_DIR to a PeTTa checkout containing run.sh.`);
  process.exit(0);
}

if (!Number.isSafeInteger(runs) || runs < 1) {
  console.error("--runs must be a positive integer");
  process.exit(2);
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error("--timeout must be a positive number of seconds");
  process.exit(2);
}
if (!existsSync(cliPath)) {
  console.error(`Missing MeTTa TS CLI: ${cliPath}`);
  console.error(
    "Build it first with: pnpm -r --filter @metta-ts/core --filter @metta-ts/node build",
  );
  process.exit(2);
}

if (!new Set(["both", "ts", "petta"]).has(requestedEngine)) {
  console.error(`Invalid --engine=${requestedEngine}; expected both, ts, or petta`);
  process.exit(2);
}

let engine = requestedEngine;
if ((engine === "both" || engine === "petta") && !existsSync(pettaRunner)) {
  if (engine === "petta") {
    console.error(`Missing PeTTa runner: ${pettaRunner}`);
    console.error("Set PETTA_DIR to a PeTTa checkout containing run.sh");
    process.exit(2);
  }
  console.warn(`PeTTa not found at ${pettaDir}; running MeTTa TS only`);
  engine = "ts";
}

function describeCheckout(path) {
  try {
    return execFileSync("git", ["-C", path, "describe", "--always", "--dirty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unversioned";
  }
}

function defaultChildEnv(kind) {
  const env = { ...process.env };
  if (kind !== "ts") return env;
  for (const key of Object.keys(env)) if (key.startsWith("METTA_")) delete env[key];
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  return env;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function resultRegion(kind, output) {
  if (kind !== "petta") return output;
  const lastDebugReset = output.lastIndexOf("\u001b[0m");
  return lastDebugReset < 0 ? output : output.slice(lastDebugReset + 4);
}

function numericResults(kind, output) {
  return resultRegion(kind, output).match(/-?\d+(?:\.\d+)?/g) ?? [];
}

function firstMismatch(values, expected) {
  if (values.length !== expected.length)
    return `expected ${expected.length} results, found ${values.length}`;
  const index = values.findIndex((value, i) => value !== expected[i]);
  return index < 0
    ? null
    : `result ${index} differs: expected ${expected[index]}, found ${values[index]}`;
}

const crossProductExpected = [];
for (let x = 1; x <= 22; x++)
  for (let y = 1; y <= 22; y++)
    for (let z = 1; z <= 22; z++)
      for (let w = 1; w <= 22; w++) crossProductExpected.push(String(w + x * y * z));

const fibDistinctMemo = new Map();
function fibDistinct(n) {
  const cached = fibDistinctMemo.get(n);
  if (cached !== undefined) return cached;
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const key = String(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  if (n < 2) add(BigInt(n));
  else
    for (const left of fibDistinct(n - 1))
      for (const right of fibDistinct(n - 2)) add(left + right);
  add(42n);
  fibDistinctMemo.set(n, out);
  return out;
}

const compareIntegerStrings = (left, right) => {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

const fibExpected = fibDistinct(7).map(String).sort(compareIntegerStrings);

function balancedTerms(output, head) {
  const terms = [];
  let residue = "";
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf(`(${head}`, cursor);
    if (start < 0) {
      residue += output.slice(cursor);
      break;
    }
    residue += output.slice(cursor, start);
    let depth = 0;
    let end = start;
    for (; end < output.length; end++) {
      const ch = output[end];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (depth !== 0) return { terms, error: `unterminated (${head} result` };
    terms.push(output.slice(start, end).replace(/\s+/g, " ").trim());
    cursor = end;
  }
  return { terms, residue, error: null };
}

const bfcExpected = new Map([
  [
    "bfc-jarr.metta",
    [
      "(MkSized 13 (: (mp (mp ax₂ (mp ax₁ (mp (mp ax₂ ax₂) (mp ax₁ ax₁)))) ax₁) (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))",
      "(MkSized 13 (: (mp (mp ax₂ (mp (mp ax₂ (mp ax₁ ax₂)) ax₁)) (mp ax₁ ax₁)) (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))",
    ],
  ],
  [
    "bfc-loowoz.metta",
    [
      "(MkSized 19 (: (mp (mp ax₂ (mp ax₁ ax₂)) (mp (mp ax₂ (mp ax₁ (mp (mp ax₂ ax₂) (mp ax₁ ax₁)))) ax₁)) (→ (→ (→ 𝜑 𝜓) (→ 𝜑 𝜒)) (→ (→ 𝜓 𝜑) (→ 𝜓 𝜒)))))",
      "(MkSized 19 (: (mp (mp ax₂ (mp ax₁ ax₂)) (mp (mp ax₂ (mp (mp ax₂ (mp ax₁ ax₂)) ax₁)) (mp ax₁ ax₁))) (→ (→ (→ 𝜑 𝜓) (→ 𝜑 𝜒)) (→ (→ 𝜓 𝜑) (→ 𝜓 𝜒)))))",
      "(MkSized 19 (: (mp (mp ax₂ (mp ax₁ (mp (mp ax₂ (mp ax₁ ax₂)) (mp (mp ax₂ ax₂) (mp ax₁ ax₁))))) ax₁) (→ (→ (→ 𝜑 𝜓) (→ 𝜑 𝜒)) (→ (→ 𝜓 𝜑) (→ 𝜓 𝜒)))))",
    ],
  ],
]);

function validateBfc(kind, output, expected) {
  const region = resultRegion(kind, output);
  const target = kind === "ts" ? (region.trim().split(/\r?\n/).at(-1) ?? "") : region;
  const extracted = balancedTerms(target, "MkSized");
  if (extracted.error !== null) return extracted.error;
  if (kind === "ts") {
    const punctuation = extracted.residue.replace(/\s+/g, "");
    const expectedPunctuation = `[${",".repeat(Math.max(0, expected.length - 1))}]`;
    if (punctuation !== expectedPunctuation)
      return `unexpected content in final result group: ${extracted.residue.trim().slice(0, 200)}`;
  } else if (!/^\s*(?:\$_[A-Za-z0-9]+\s*)?$/.test(extracted.residue)) {
    return `unexpected content around proof results: ${extracted.residue.trim().slice(0, 200)}`;
  }
  return firstMismatch(extracted.terms, expected);
}

const validators = new Map([
  ...[...bfcExpected].map(([file, expected]) => [
    file,
    (kind, output) => validateBfc(kind, output, expected),
  ]),
  [
    "superpose-cross-product.metta",
    (kind, output) => firstMismatch(numericResults(kind, output), crossProductExpected),
  ],
  [
    "tuple-concat.metta",
    (kind, output) => {
      const values = numericResults(kind, output);
      const expected = Array.from({ length: 20 }, (_, index) => String(index + 1));
      return values.length === expected.length &&
        values.every((value, index) => value === expected[index])
        ? null
        : `expected distinct values 1..20, found ${values.join(" ").slice(0, 200)}`;
    },
  ],
  [
    "tabled-nondeterministic-fib.metta",
    (kind, output) =>
      firstMismatch(numericResults(kind, output).sort(compareIntegerStrings), fibExpected),
  ],
]);

function processTreeRssKb(rootPid) {
  if (process.platform !== "linux") return null;
  const pending = [rootPid];
  const seen = new Set();
  let total = 0;
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (rss !== null) total += Number(rss[1]);
    } catch {
      continue;
    }
    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      if (children !== "") pending.push(...children.split(/\s+/).map(Number));
    } catch {
      // A process can exit between its status and children reads.
    }
  }
  return total;
}

function stopProcessTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child may have exited between the timer and signal.
  }
}

function classify(kind, file, result, ms) {
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const checks = (output.match(/✅/g) ?? []).length;
  const failures = (output.match(/❌/g) ?? []).length;
  const base = { ms, peakRssKb: result.peakRssKb };
  if (result.timedOut) return { ...base, status: "timeout", detail: `${timeoutMs / 1000}s limit` };
  if (result.outputLimit)
    return { ...base, status: "error", detail: `${maxOutputBytes >> 20} MiB output limit` };
  if (result.error !== undefined)
    return { ...base, status: "error", detail: String(result.error.message ?? result.error) };
  if (result.status !== 0)
    return {
      ...base,
      status: "error",
      detail: `exit ${result.status}: ${output.trim().slice(-500)}`,
    };
  if (failures > 0) return { ...base, status: "fail", detail: `${failures} failed assertion(s)` };
  const validator = validators.get(basename(file));
  const validationError = validator?.(kind, output) ?? null;
  if (validationError !== null) return { ...base, status: "fail", detail: validationError };
  if (checks === 0 && validator === undefined)
    return { ...base, status: "fail", detail: "no assertion or output validator ran" };
  return {
    ...base,
    status: "pass",
    detail: checks > 0 ? `${checks} assertion(s)` : "validated output",
  };
}

async function runOnce(kind, file) {
  const command = kind === "ts" ? process.execPath : "sh";
  const args = kind === "ts" ? [cliPath, file] : [pettaRunner, file];
  const start = performance.now();
  const child = spawn(command, args, {
    cwd: kind === "ts" ? undefined : pettaDir,
    env: defaultChildEnv(kind),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputLimit = false;
  let timedOut = false;
  let error;
  let peakRssKb = processTreeRssKb(child.pid);

  const append = (target, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      outputLimit = true;
      stopProcessTree(child, "SIGTERM");
      return target;
    }
    return target + chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  child.on("error", (cause) => {
    error = cause;
  });

  const rssTimer = setInterval(() => {
    const rss = processTreeRssKb(child.pid);
    if (rss !== null && (peakRssKb === null || rss > peakRssKb)) peakRssKb = rss;
  }, rssPollMs);
  const timeout = setTimeout(() => {
    timedOut = true;
    stopProcessTree(child, "SIGTERM");
  }, timeoutMs);
  let forceKill;
  const armForceKill = () => {
    if (forceKill !== undefined) return;
    forceKill = setTimeout(() => stopProcessTree(child, "SIGKILL"), 1_000);
  };
  const terminationWatcher = setInterval(() => {
    if (timedOut || outputLimit) armForceKill();
  }, 25);

  const { status, signal } = await new Promise((resolveClose) => {
    child.once("close", (status, signal) => resolveClose({ status, signal }));
  });
  clearInterval(rssTimer);
  clearInterval(terminationWatcher);
  clearTimeout(timeout);
  clearTimeout(forceKill);
  return classify(
    kind,
    file,
    { stdout, stderr, status, signal, error, timedOut, outputLimit, peakRssKb },
    performance.now() - start,
  );
}

async function runCase(kind, file) {
  const attempts = [];
  for (let i = 0; i < runs; i++) {
    const attempt = await runOnce(kind, file);
    attempts.push(attempt);
    if (attempt.status !== "pass") break;
  }
  return summarizeAttempts(attempts);
}

function summarizeAttempts(attempts) {
  const successful = attempts.filter((attempt) => attempt.status === "pass");
  const complete = successful.length === runs;
  const last = attempts.at(-1);
  const peakRssValues = successful
    .map((attempt) => attempt.peakRssKb)
    .filter((value) => value !== null);
  return {
    attempts,
    status: complete
      ? "pass"
      : last?.status === "pass"
        ? "incomplete"
        : (last?.status ?? "not-run"),
    detail: complete
      ? `${runs} pass`
      : last?.status === "pass"
        ? `${successful.length}/${runs} pass; paired engine stopped`
        : (last?.detail ?? "no attempts"),
    medianMs: complete ? median(successful.map((attempt) => attempt.ms)) : null,
    peakRssKb: peakRssValues.length === 0 ? null : Math.max(...peakRssValues),
  };
}

async function runPair(file) {
  const attempts = { petta: [], ts: [] };
  for (let i = 0; i < runs; i++) {
    const order = i % 2 === 0 ? ["petta", "ts"] : ["ts", "petta"];
    let failed = false;
    for (const kind of order) {
      const attempt = await runOnce(kind, file);
      attempts[kind].push(attempt);
      if (attempt.status !== "pass") failed = true;
    }
    if (failed) return [summarizeAttempts(attempts.petta), summarizeAttempts(attempts.ts)];
  }
  return [summarizeAttempts(attempts.petta), summarizeAttempts(attempts.ts)];
}

const files = readdirSync(casesDir)
  .filter((file) => file.endsWith(".metta"))
  .filter((file) => filter === "" || file.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(
    filter === "" ? "No benchmark cases found" : `No benchmark cases match --filter=${filter}`,
  );
  process.exit(2);
}

const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);
const displayMs = (run) => {
  if (run === null) return "-";
  return run.medianMs === null ? `${run.status}*` : run.medianMs.toFixed(1);
};
const displayRss = (run) => {
  if (run?.peakRssKb === null || run?.peakRssKb === undefined) return "-";
  return (run.peakRssKb / 1024).toFixed(1);
};

console.log("MeTTa TS nondeterminism benchmark");
console.log(`  cases=${files.length} runs=${runs} timeout=${timeoutMs / 1000}s engine=${engine}`);
if (engine !== "ts") console.log(`  PeTTa=${pettaDir}`);
if (engine !== "ts") console.log(`  PeTTa revision=${describeCheckout(pettaDir)}`);
console.log("");
console.log(
  pad("case", 34),
  padLeft("PeTTa ms", 12),
  padLeft("MiB", 8),
  padLeft("MeTTa TS ms", 14),
  padLeft("MiB", 8),
  padLeft("speedup", 10),
);
console.log("-".repeat(90));

let failed = false;
for (const file of files) {
  const path = join(casesDir, file);
  let petta = null;
  let ts = null;
  if (engine === "both") [petta, ts] = await runPair(path);
  else if (engine === "petta") petta = await runCase("petta", path);
  else ts = await runCase("ts", path);
  const speedup =
    petta !== null && petta.medianMs !== null && ts !== null && ts.medianMs !== null
      ? petta.medianMs / ts.medianMs
      : null;
  failed ||= petta?.status !== undefined && petta.status !== "pass";
  failed ||= ts?.status !== undefined && ts.status !== "pass";
  console.log(
    pad(basename(file, ".metta"), 34),
    padLeft(displayMs(petta), 12),
    padLeft(displayRss(petta), 8),
    padLeft(displayMs(ts), 14),
    padLeft(displayRss(ts), 8),
    padLeft(speedup === null ? "-" : `${speedup.toFixed(2)}x`, 10),
  );
  if (petta !== null && petta.status !== "pass") console.log(`  PeTTa: ${petta.detail}`);
  if (ts !== null && ts.status !== "pass") console.log(`  MeTTa TS: ${ts.detail}`);
  if (petta !== null)
    console.log(
      `  PeTTa samples: ${petta.attempts.map((attempt) => attempt.ms.toFixed(1)).join(", ")} ms`,
    );
  if (ts !== null)
    console.log(
      `  MeTTa TS samples: ${ts.attempts.map((attempt) => attempt.ms.toFixed(1)).join(", ")} ms`,
    );
}

console.log(
  "\nTimings are subprocess medians and include runtime startup. Both-engine runs alternate engine order between paired attempts. Memory is the maximum sampled process-tree RSS across runs on Linux. speedup = PeTTa / MeTTa TS.",
);
if (failed) process.exitCode = 1;
