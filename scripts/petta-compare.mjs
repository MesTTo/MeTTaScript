// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: score the petta engine against PeTTa's own results: run each vendored ee5cacb example through
// packages/petta's CLI the way test.sh runs it and compare with its oracle record, writing a per-example table;
// with --petta, also run PeTTa itself on SWI-Prolog beside it and measure both engines' wall time and peak
// resident set per example, on a quiet host, against g-petta-speed-1105.
// am[implements a-mettascript-petta-1104.oracle]
//
// Usage: node scripts/petta-compare.mjs [--jobs=N] [--timeout=S] [--filter=substr] [--names=a,b]
//          [--class=normal,strict,fail] [--out=file.json]
//          [--petta=<PeTTa ee5cacb checkout> [--repeat=N] [--rows=file.tsv]]
// Verdicts: match, mismatch (stdout or exit class differs), error (engine crash), timeout. Rules:
//  - normal and strict examples match when stdout is byte-identical and the exit class (0, non-zero, timeout)
//    agrees; test_datetime's clock readings are masked on both sides, since PeTTa's own runs differ there;
//  - fail_* examples match when the run exits non-zero printing one of test.sh's type-error phrases;
//  - examples PeTTa ran past the oracle's 300 s cap match when ours also runs past this run's cap and the
//    stdout both printed agrees over their common length.
// With --petta each example runs on PeTTa (`sh run.sh`, as the oracle ran it) and on ours, alternating, --repeat
// times in the same worker, each under GNU time for its peak resident set; a row keeps the fastest wall time and
// the largest peak of each engine. PeTTa's own output is judged against the oracle too: the first disagreement
// means this host's setup is not the oracle's (the swipl on PATH, or a library PeTTa loads), so the sweep stops there
// and writes nothing.
// At --jobs=1 each example's runs are checked against other work on the host: when other processes averaged
// QUIET_CORES or more over the example's window (the busy time of every core less the runs' own CPU time), the example
// runs again once the host is quiet, so no row times a neighbour's gate; each row keeps the other work its window saw.
// The examples PeTTa itself runs unbounded run to a 10 s cap on both and stay out of the totals.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname } from "node:os";
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
const UNBOUNDED_MS = 10000;
const FILTER = args.filter ?? "";
const NAMES = args.names ? new Set(args.names.split(",")) : null;
const CLASSES = new Set((args.class ?? "normal,strict,fail").split(","));
const OUT = args.out ? resolve(args.out) : null;
const PETTA = args.petta ? resolve(args.petta) : null;
const REPEAT = Number(args.repeat ?? 1);
const ROWS = args.rows ? resolve(args.rows) : null;
const CAP = 65536;
// GNU time's -q leaves its one format line as the last line of stderr, whatever the command's exit: /usr/bin/time on
// Linux, Homebrew's gtime where /usr/bin/time is BSD's (macOS, c-measure-hosts-1107).
// am[implements a-petta-cell-store.measure]
const TIME = ["/usr/bin/time", "gtime"].find((t) => spawnSync(t, ["-q", "-f", "%M", "true"]).status === 0) ?? "/usr/bin/time";
const MEASURE = PETTA !== null;
if (MEASURE && spawnSync(TIME, ["-q", "-f", "%M", "true"]).status !== 0) throw new Error(`${TIME} is not GNU time with -q`);
if (ROWS && !MEASURE) throw new Error("--rows needs --petta");

// Other work on the host while a measured example runs, in cores: the CPU time all cores spent busy (os.cpus()'s
// tick counters), less what this process and the example's runs took (GNU time's %U + %S over each run's process
// tree), over the wall time. Exact at --jobs=1, where no other run of ours overlaps an example's window.
// am[implements a-petta-next-1108.speed.quietrows]
const CHECKED = MEASURE && JOBS === 1;
// A window is clean while other work averaged under 1.5 cores: on the Mac mini the idle desktop takes 0.6 to 1.0 cores,
// a gate in its OrbStack VM 3.5 to 5.6, and each busy neighbour core already slows the cell engine by 3 to 6 percent
// (c-mac-other-cores-1108), so the bound sits half a core above the idle desktop.
// am[rests-on c-mac-other-cores-1108]
const QUIET_CORES = 1.5;
let childMs = 0;
const mark = () => {
  const u = process.cpuUsage();
  const busy = cpus().reduce((s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.irq, 0);
  return { t: performance.now(), busy, own: (u.user + u.system) / 1000 + childMs };
};
const otherCores = (m) => {
  const n = mark();
  return (n.busy - m.busy - (n.own - m.own)) / (n.t - m.t);
};
const clock = () => new Date().toTimeString().slice(0, 8);
/** Wait until a 5 s window finds other work on the host under QUIET_CORES, logging when a wait starts and ends. */
async function quietHost() {
  for (let waited = false; ; waited = true) {
    const m = mark();
    await new Promise((r) => setTimeout(r, 5000));
    const other = otherCores(m);
    if (other < QUIET_CORES) {
      if (waited) process.stdout.write(`${clock()} quiet: other work takes ${other.toFixed(2)} cores\n`);
      return;
    }
    if (!waited) process.stdout.write(`${clock()} waiting: other work takes ${other.toFixed(2)} cores\n`);
  }
}

const FAIL_RE =
  /Type mismatch|Type conflict|Determinism check failed|Conflicting determinism declarations|Deterministic function .* overlapping clauses|Deterministic function .* is not exhaustive|Strict mode rejected residual runtime type goal|Strict mode cannot express the unresolved nominal intersection|SpaceOf declaration .* rejects existing row|Strict mode requires a declared or inferable type|No matching typed overload|Declared output type variable|Declared parametric parameter|Arrows are prefix|--strict-det requires|Effect-polymorphic declaration|Effect variable|car-atom expects a non-empty expression|Syntax error|is unbound: a -\[.*\]-> function requires bound arguments|is not a proper list: its -\[.*\]-> proof requires a bound proper list/;

// test_datetime prints the wall clock: mask its readings, the one place two PeTTa runs disagree.
const NORMALIZE = {
  test_datetime: (s) => s.replace(/\(\d+\.\d+\)/g, "(<time>)").replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, "<datetime>").replace(/\d\d:\d\d:\d\d/g, "<clock>"),
};

const classOf = (n) => (n.startsWith("fail_") ? "fail" : /^(strict|strictdet)_/.test(n) ? "strict" : "normal");
const names = readdirSync(join(corpus, "examples"))
  .filter((f) => f.endsWith(".metta"))
  .map((f) => f.slice(0, -6))
  .filter((n) => n.includes(FILTER) && (NAMES === null || NAMES.has(n)) && CLASSES.has(classOf(n)))
  .sort();
// git_import's oracle run found its repository already cloned under repos/ (its stdout has no "Cloning ..."
// line), as any run after the first does; give this run, and PeTTa's when measured, the same starting state.
// am[implements a-mettascript-petta-1104.oracle]
for (const base of PETTA ? [corpus, PETTA] : [corpus]) {
  const repo = join(base, "repos/test_metta_lib");
  if (names.includes("git_import") && !existsSync(repo)) {
    const r = spawnSync("git", ["clone", "--depth", "1", "https://github.com/rTreutlein/test_metta_lib.git", repo], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`cloning git_import's repository failed: ${r.error ?? r.status}`);
  }
}

/**
 * One run of argv in cwd with stdin closed, killed with its whole process group at the cap (run.sh's swipl and
 * time's command are grandchildren). Measured runs go under GNU time, whose last stderr line, cut from the stderr
 * returned, gives the peak resident set of the run's process tree in KB and its CPU time, added to childMs; a run
 * killed at its cap prints no such line, so its cpuMs is null.
 * am[implements a-petta-speed-1105.baseline]
 */
function run(argv, cwd, env, capMs) {
  const full = MEASURE ? [TIME, "-q", "-f", "@@petta-rss %M %U %S", ...argv] : argv;
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn(full[0], full.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let tail = "";
    child.stdout.on("data", (d) => {
      if (out.length < CAP * 2) out = Buffer.concat([out, d]);
    });
    child.stderr.on("data", (d) => {
      if (err.length < CAP) err = Buffer.concat([err, d]);
      tail = (tail + d.toString("latin1")).slice(-128);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, capMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      let stderr = err.toString("utf8");
      let rssKB = null;
      let cpuMs = null;
      const m = MEASURE ? /@@petta-rss (\d+) ([\d.]+) ([\d.]+)\n$/.exec(tail) : null;
      if (m) {
        rssKB = Number(m[1]);
        cpuMs = (Number(m[2]) + Number(m[3])) * 1000;
        childMs += cpuMs;
        stderr = stderr.replace(/@@petta-rss [\d. ]+\n$/, "");
      }
      done({ status, signal, timedOut, ms, rssKB, cpuMs, stdout: out.toString("utf8"), stderr });
    });
  });
}

const ours = (name, mode, capMs) => run([process.execPath, cli, `./examples/${name}.metta`, "--silent", ...(mode ? [mode] : [])], corpus, process.env, capMs);
const petta = (name, mode, capMs) =>
  run(["sh", "run.sh", `./examples/${name}.metta`, "--silent", ...(mode ? [mode] : [])], PETTA, { ...process.env, PETTA_STACK_LIMIT: "3g" }, capMs);

function judge(name, oracle, r) {
  const cls = (st) => (st === "timeout" ? "timeout" : st === 0 ? "0" : "nonzero");
  const got = r.timedOut ? "timeout" : r.status === 0 ? "0" : "nonzero";
  if (name.startsWith("fail_")) {
    if (got === "nonzero" && FAIL_RE.test(r.stdout + r.stderr)) return "match";
    return got === "timeout" ? "timeout" : "mismatch";
  }
  if (oracle.status === "timeout") {
    if (!r.timedOut) return "mismatch";
    const n = Math.min(oracle.stdout.length, r.stdout.length, CAP);
    return oracle.stdout.slice(0, n) === r.stdout.slice(0, n) ? "match" : "mismatch";
  }
  if (r.timedOut) return "timeout";
  const norm = NORMALIZE[name] ?? ((s) => s);
  if (norm(r.stdout) === norm(oracle.stdout) && cls(oracle.status) === got) return "match";
  if (!r.stdout && r.stderr && /^(Error|TypeError|RangeError|ReferenceError)|\n\s+at /.test(r.stderr)) return "error";
  return "mismatch";
}

// Over repeats: the first non-matching verdict wins, the fastest wall time and the largest peak are kept.
function fold(acc, verdict, r) {
  if (acc === null) return { verdict, r, ms: r.ms, rssKB: r.rssKB };
  return {
    verdict: acc.verdict === "match" ? verdict : acc.verdict,
    r: acc.verdict === "match" && verdict !== "match" ? r : acc.r,
    ms: Math.min(acc.ms, r.ms),
    rssKB: acc.rssKB === null || r.rssKB === null ? (acc.rssKB ?? r.rssKB) : Math.max(acc.rssKB, r.rssKB),
  };
}

const results = [];
let next = 0;
// The first example whose PeTTa run disagrees with its oracle; workers take no further example once it is set.
// am[addresses i-bench-wrong-swipl]
let pettaBroken = null;
// Time: REPEAT x (PeTTa's + ours) runtime per example, over JOBS workers, again for each window other work overlapped.
// Space: one capped stdout/stderr pair per job.
async function worker() {
  while (next < names.length && pettaBroken === null) {
    const name = names[next++];
    const oracle = JSON.parse(readFileSync(join(corpus, "oracle", name + ".json"), "utf8"));
    const unbounded = oracle.status === "timeout";
    const capMs = MEASURE && unbounded ? UNBOUNDED_MS : TIMEOUT_MS;
    let o, p, other;
    // A window holding a run killed at its cap has no CPU account, so it is kept unchecked: such rows are untimed
    // (unbounded) or a timeout verdict. am[implements a-petta-next-1108.speed.quietrows]
    for (;;) {
      o = p = null;
      const window = CHECKED ? mark() : null;
      let accounted = true;
      for (let i = 0; i < REPEAT; i++) {
        if (PETTA) {
          const r = await petta(name, oracle.mode, capMs);
          accounted &&= r.cpuMs !== null;
          p = fold(p, judge(name, oracle, r), r);
          if (p.verdict !== "match") {
            pettaBroken ??= { name, verdict: p.verdict, stderr: r.stderr.slice(0, 1000) };
            return;
          }
        }
        const r = await ours(name, oracle.mode, capMs);
        accounted &&= r.cpuMs !== null;
        o = fold(o, judge(name, oracle, r), r);
      }
      other = window !== null && accounted ? otherCores(window) : null;
      if (other === null || other < QUIET_CORES) break;
      process.stdout.write(`${clock()} again ${name}: other work took ${other.toFixed(2)} cores\n`);
      await quietHost();
    }
    const rec = { name, verdict: o.verdict, status: o.r.timedOut ? "timeout" : o.r.status, oracleStatus: oracle.status, ms: o.ms };
    if (MEASURE) Object.assign(rec, { rssKB: o.rssKB, unbounded, otherCores: other, petta: { verdict: p.verdict, ms: p.ms, rssKB: p.rssKB } });
    if (o.verdict !== "match") {
      rec.stdout = o.r.stdout.slice(0, 2000);
      rec.stderr = o.r.stderr.slice(0, 2000);
      rec.expected = oracle.stdout.slice(0, 2000);
    }
    results.push(rec);
    if (!OUT) {
      const timing = MEASURE ? ` petta ${p.ms}ms ${p.rssKB}KB ours ${o.rssKB}KB${other === null ? "" : ` other ${other.toFixed(2)}`}` : "";
      process.stdout.write(`${o.verdict.padEnd(8)} ${String(o.ms).padStart(6)}ms ${name}${timing}\n`);
    }
  }
}
if (CHECKED) await quietHost();
await Promise.all(Array.from({ length: JOBS }, worker));
if (pettaBroken !== null) {
  const swipl = spawnSync("swipl", ["--version"], { encoding: "utf8" }).stdout.trim();
  process.stderr.write(
    `PeTTa's own run of ${pettaBroken.name} gives ${pettaBroken.verdict} against its oracle (${swipl}): this host's ` +
      `setup differs from the oracle's (its SWI, or a library PeTTa loads, such as a Python module), so no rows are written\n${pettaBroken.stderr}\n`,
  );
  process.exit(1);
}
results.sort((a, b) => a.name.localeCompare(b.name));
const summary = {};
for (const r of results) {
  const k = classOf(r.name);
  summary[k] ??= { match: 0, mismatch: 0, error: 0, timeout: 0 };
  summary[k][r.verdict]++;
}

// g-petta-speed-1105 over the bounded normal and strict examples, read as c-speed-bound-reading says: total wall
// time at most 2x PeTTa's; each example at most max(5x PeTTa's, PeTTa's + 0.5 s); each peak at most 2x PeTTa's
// + 150 MB. am[implements a-petta-speed-1105.baseline] am[rests-on c-speed-bound-reading]
const slow = (r) => r.ms > Math.max(5 * r.petta.ms, r.petta.ms + 500);
const heavy = (r) => r.rssKB === null || r.petta.rssKB === null || r.rssKB > 2 * r.petta.rssKB + 150 * 1024;
if (MEASURE) {
  const timed = results.filter((r) => classOf(r.name) !== "fail" && !r.unbounded);
  const pettaS = timed.reduce((s, r) => s + r.petta.ms, 0) / 1000;
  const oursS = timed.reduce((s, r) => s + r.ms, 0) / 1000;
  summary.speed = {
    examples: timed.length,
    pettaS: +pettaS.toFixed(1),
    oursS: +oursS.toFixed(1),
    ratio: +(oursS / pettaS).toFixed(2),
    slow: timed.filter(slow).length,
    heavy: timed.filter(heavy).length,
    met: oursS <= 2 * pettaS && !timed.some(slow) && !timed.some(heavy) && results.every((r) => r.verdict === "match"),
  };
}
console.log(JSON.stringify(summary));
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
if (ROWS) {
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout.trim();
  const swipl = spawnSync("swipl", ["--version"], { encoding: "utf8" }).stdout.trim();
  const head = [
    `# g-petta-speed-1105 rows: node scripts/petta-compare.mjs ${process.argv.slice(2).join(" ")}`,
    `# host ${hostname()}; petta ${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain", "--untracked-files=no") ? "+dirty" : ""}; node ${process.version}; ${swipl}; PeTTa ${spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PETTA, encoding: "utf8" }).stdout.trim() || "unknown"}`,
    `# ms: fastest of ${REPEAT} wall times; rss_kb: largest peak resident set; slow: ours > max(5 x petta, petta + 500 ms); heavy: ours > 2 x petta + 150 MB; unbounded: PeTTa itself runs past any cap, so both ran to ${UNBOUNDED_MS / 1000} s and the row is out of the totals; other_cores: other work on the host during the example's runs, in cores${CHECKED ? `, the example run again while it reached ${QUIET_CORES}` : ""}`,
    `# ${JSON.stringify(summary.speed)}`,
    ["name", "class", "verdict", "petta_verdict", "petta_ms", "petta_rss_kb", "ours_ms", "ours_rss_kb", "slow", "heavy", "unbounded", "other_cores"].join("\t"),
  ];
  const rows = results.map((r) =>
    [r.name, classOf(r.name), r.verdict, r.petta.verdict, r.petta.ms, r.petta.rssKB, r.ms, r.rssKB, r.unbounded ? "" : +slow(r), r.unbounded ? "" : +heavy(r), +r.unbounded, r.otherCores === null ? "" : r.otherCores.toFixed(2)].join("\t"),
  );
  writeFileSync(ROWS, [...head, ...rows, ""].join("\n"));
}
