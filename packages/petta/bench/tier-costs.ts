// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: measure what a clause costs the cell engine cold, compiled and to compile, on synthetic facts and rules of
// varied size, as rows of nanoseconds per try over runs of consecutive tries; and derive from those rows, by the
// cost-benefit rule, the tries a clause of each kind and size should run cold before it is compiled, the F + W / cells
// fit of those tries per kind of code that cell/machine.ts TIERS holds, and the AIC and AICc of that fit beside the
// forms nested in it and the clamp it replaced.
// Usage:
//   node --expose-gc --import tsx packages/petta/bench/tier-costs.ts measure [--preds=N] [--sets=R] [--repeats=K] > rows.tsv
//   node --import tsx packages/petta/bench/tier-costs.ts derive rows.tsv
// am[implements a-petta-speed-general-1108.tier]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { installBuiltins } from "../src/builtins";
import { consultClpfd, installClpfd } from "../src/clpfd";
import { installConsult } from "../src/consult";
import { consultLibrary, installLibrary } from "../src/library";
import { Machine } from "../src/machine";
import { readClauses } from "../src/prolog-reader";
import { Struct } from "../src/terms";
import { installTermBuiltins } from "../src/cell/builtins";
import { compileCellClause, installInlineBuiltins } from "../src/cell/compile";
import { CellMachine, compileAfter } from "../src/cell/machine";
import { clauseCells, headProgram, large } from "../src/cell/headprog";
import type { Clause } from "../src/db";

const arg = (name: string, dflt: number): number => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : Number(a.slice(name.length + 3));
};

type Kind = "fact" | "rule";
/** The configurations measured: a kind and the depth m of its clauses (clauseOf), from a few cells to several hundred. */
const CONFIGS: [Kind, number][] = [
  ...[1, 2, 4, 8, 16, 32, 64, 128].map((m): [Kind, number] => ["fact", m]),
  ...[1, 2, 4, 8, 16, 32, 64].map((m): [Kind, number] => ["rule", m]),
];
/**
 * Runs of consecutive tries each phase times, after the clause's first try: the cold tries up to the compiling one
 * (COMPILE_AFTER, the 32nd, with tiering off), that try alone, then doubling runs of compiled tries to the 8192nd, over
 * which V8 takes the generated code from its interpreter to optimised code and a fact is recompiled with an inline head
 * (compile.ts HOT_AFTER).
 */
const RUNS = [1, 30, 1, 8, 24, 64, 128, 256, 512, 1024, 2048, 4096];
/** The runs a control set held cold times, to the 1024th try: cold tries cost the same however many came before. */
const COLD_RUNS = RUNS.slice(0, 9);

/**
 * Atom j of predicate p in set u, distinct across sets and predicates: generated code holds a clause's atoms and
 * functors as literals and V8 caches `new Function` by its source text, one compile and one feedback vector for every
 * clause of the same text (Compiler::GetFunctionFromEval's eval cache), which would share the costs measured here. A
 * head argument past headprog.ts BUILD_NODES runs through a term program held outside the source, so clauses with such
 * heads share one text here as they do in programs.
 */
const atom = (u: string, p: number, j: number): string => `c${u}_${p}_${j}`;
/** A nested argument f(a0, f(a1, ... tail)) of depth m over predicate p's atoms. */
const nest = (u: string, p: number, m: number, tail: string): string => {
  let s = tail;
  for (let j = m - 1; j >= 0; j--) s = `f(${atom(u, p, j)}, ${s})`;
  return s;
};

/**
 * Predicate p of set u at depth m: a fact matching a depth-m argument, or a rule with a depth-m head and m body goals,
 * calls with a structured argument, unifications building a structure and arithmetic in turn, the goals a translated
 * MeTTa function's clause is made of. Returns the clause's text and a goal its head matches.
 */
function clauseOf(kind: Kind, u: string, p: number, m: number): { text: string; call: string } {
  const name = `t${u}_${p}`;
  const call = `${name}(${nest(u, p, m, "7")}, _)`;
  if (kind === "fact") return { text: `${name}(${nest(u, p, m, "7")}, done).`, call };
  const goals = Array.from({ length: m }, (_, j) =>
    j % 3 === 0 ? `h(g(N, ${atom(u, p, j)}), Y${j})` : j % 3 === 1 ? `Y${j} = k(N, ${atom(u, p, j)})` : `Y${j} is N * ${j + 2} + 1`,
  );
  return { text: `${name}(${nest(u, p, m, "N")}, R) :- ${goals.join(", ")}, R = done.`, call };
}

function machine(): CellMachine {
  const m = new Machine();
  installBuiltins(m);
  installLibrary(m);
  consultLibrary(m);
  installConsult(m);
  installClpfd(m);
  consultClpfd(m);
  const cm = new CellMachine(m);
  cm.compile = compileCellClause;
  installInlineBuiltins(cm);
  installTermBuiltins(cm);
  return cm;
}

const consult = (cm: CellMachine, text: string): void => {
  for (const c of readClauses(text)) cm.om.addClause(c, true);
};

let runs = 0;
/**
 * Milliseconds for `n` tries of every goal in conjunction `calls`, through a fresh run predicate calling loop/2: each
 * iteration runs the conjunction and fails back, so the heap stays as it was and no collection's cost falls on the
 * later runs (the failure-driven loop of the classic Prolog benchmark harnesses). V8's heap is collected first.
 */
function timeRun(cm: CellMachine, calls: string, n: number): number {
  const name = `run_${runs++}`;
  consult(cm, `${name} :- loop(${n}, (${calls})).`);
  globalThis.gc?.();
  const t0 = performance.now();
  cm.solveAll(cm.proc(name, 0), 0, () => false);
  return performance.now() - t0;
}

/**
 * One process's rows for `kind` at depth `m`: a set whose clauses are compiled at their 32nd try warms the engine,
 * then `sets` fresh sets of `preds` predicates are timed tiered and as many held cold, interleaved, every run's cost
 * net of the run's own (the loop called zero times). Rows: kind, clause cells, set, curve, first and last try of the
 * run, nanoseconds per try.
 */
function measureOne(kind: Kind, m: number, preds: number, sets: number, tag: string): void {
  const cm = machine();
  cm.tiered = false;
  consult(cm, "e(_, ok).\nh(_, ok).\nloop(N, G) :- N > 0, !, (call(G), fail ; true), N1 is N - 1, loop(N1, G).\nloop(_, _).");
  timeRun(cm, "e(1, _), h(1, _)", 20000);
  const make = (u: string, cold: boolean): { calls: string; cells: number } => {
    const cs = Array.from({ length: preds }, (_, p) => clauseOf(kind, u, p, m));
    consult(cm, cs.map((c) => c.text).join("\n"));
    const clauses: Clause[] = cs.map((_, p) => cm.om.db.get(`t${u}_${p}`, 2)!.clauses[0]!);
    // A control set's clauses start cold with tries to spare, as the cold path leaves them between tries.
    if (cold) for (const c of clauses) c.cell = kind === "fact" ? 2 ** 30 : { prog: headProgram(cm.hp, c), left: 2 ** 30 };
    return { calls: cs.map((c) => c.call).join(", "), cells: clauseCells(clauses[0]!, 1 << 20) };
  };
  const run = (u: string, curve: "tiered" | "cold", runList: number[], emit: boolean): void => {
    const { calls, cells } = make(u, curve === "cold");
    const net = Math.min(timeRun(cm, calls, 0), timeRun(cm, calls, 0));
    let first = 1;
    for (const n of runList) {
      const ms = timeRun(cm, calls, n) - net;
      if (emit) console.log([kind, cells, tag, curve, first, first + n - 1, ((ms * 1e6) / (preds * n)).toFixed(1)].join("\t"));
      first += n;
    }
  };
  run(`${tag}w`, "tiered", RUNS, false);
  for (let s = 0; s < sets; s++) {
    run(`${tag}s${s}`, "tiered", RUNS, true);
    run(`${tag}c${s}`, "cold", COLD_RUNS, true);
  }
  const u = process.cpuUsage();
  console.log(`# cpu_ms ${Math.round((u.user + u.system) / 1000)}`);
}

/**
 * Cores other processes kept busy, on average, from `from` (busy core milliseconds and a time) to now, less `own`
 * milliseconds of CPU this benchmark's processes took: the rule of the rows harness (scripts/petta-compare.mjs).
 */
const busyNow = (): [number, number] => [cpus().reduce((s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.irq, 0), performance.now()];
const otherCores = (from: [number, number], own: number): number => {
  const [b, t] = busyNow();
  return (b - from[0] - own) / (t - from[1]);
};
/** Other work, in cores, at which a configuration waits or is run again: the rows harness's QUIET_CORES. */
const QUIET_CORES = 1.5;

/**
 * Every configuration, `repeats` times over, each in a process of its own so no configuration's code warms another's,
 * in turn so a slow spell on the host spreads over all of them. A configuration runs once a five-second sample of
 * other work is under QUIET_CORES, and runs again if its own window was not.
 */
function measure(): void {
  const preds = arg("preds", 200), sets = arg("sets", 3), repeats = arg("repeats", 2);
  console.log(`# node ${process.version} v8 ${process.versions.v8} preds ${preds} sets ${sets} repeats ${repeats}`);
  console.log(["kind", "cells", "set", "curve", "first", "last", "ns_per_try"].join("\t"));
  const self = fileURLToPath(import.meta.url);
  for (let r = 0; r < repeats; r++)
    for (const [kind, m] of CONFIGS)
      for (;;) {
        const before = busyNow();
        spawnSync("sleep", ["5"]);
        const base = otherCores(before, 0);
        if (base >= QUIET_CORES) {
          process.stderr.write(`waiting: ${base.toFixed(2)} other cores busy\n`);
          spawnSync("sleep", ["25"]);
          continue;
        }
        const from = busyNow();
        const out = spawnSync(process.execPath, [...process.execArgv, self, "one", kind, String(m), String(preds), String(sets), `${r}${kind[0]}${m}`], { encoding: "utf8", maxBuffer: 1 << 26 });
        if (out.status !== 0) throw new Error(`${kind} ${m}: exit ${out.status}\n${out.stderr}`);
        const cpu = /^# cpu_ms (\d+)$/m.exec(out.stdout);
        if (cpu === null) throw new Error(`${kind} ${m}: no CPU time reported`);
        const other = otherCores(from, Number(cpu[1]));
        const quiet = other < QUIET_CORES;
        console.log(`# ${kind} ${m} other_cores before ${base.toFixed(2)} during ${other.toFixed(2)}${quiet ? "" : ", run again"}`);
        if (quiet) {
          process.stdout.write(out.stdout.replace(/^# cpu_ms \d+\n/m, ""));
          break;
        }
        spawnSync("sleep", ["25"]);
      }
}

/** A row's key: kind, cells, curve, first and last try. */
type Row = { kind: Kind; cells: number; curve: string; first: number; last: number; ns: number };

/**
 * The kinds of code TIERS (cell/machine.ts) fits apart, in its order: rules, facts whose head is generated node by
 * node, and facts whose head runs through the term-program matcher.
 * am[implements a-petta-speed-general-1108.tier-derive]
 */
const REGIMES = ["rule", "inlineFact", "matchedFact"] as const;
type Regime = (typeof REGIMES)[number];

/** A model of a kind's break-even tries n at s cells, fitted to ln n: its parameters and residual sum of squares. */
type Fit = { model: string; k: number; params: Record<string, number>; rss: number };

/** The mean of `xs` and the sum of their squared deviations from it. */
const centred = (xs: number[]): { mean: number; ss: number } => {
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  return { mean, ss: xs.reduce((a, x) => a + (x - mean) ** 2, 0) };
};

/**
 * n = F and n = W / s fitted to ln n at sizes `s`: ln F is the mean of ln n, ln W the mean of ln n + ln s.
 * am[implements a-petta-speed-general-1108.tier-derive]
 */
const fitF = (y: number[]): Fit => {
  const c = centred(y);
  return { model: "F", k: 1, params: { F: Math.exp(c.mean) }, rss: c.ss };
};
const fitW = (s: number[], y: number[]): Fit => {
  const c = centred(y.map((v, i) => v + Math.log(s[i]!)));
  return { model: "W / s", k: 1, params: { W: Math.exp(c.mean) }, rss: c.ss };
};

/**
 * n = F + W / s, F and W at least 0, fitted to ln n at sizes `s`. As W (φ + 1 / s) with φ = F / W, the best ln W for a
 * given φ is the mean of ln n - ln(φ + 1 / s), so the fit searches φ alone: a scan of ln φ from 1e-8 / max s to
 * 1e8 / min s, a golden-section search between the best scan point's neighbours, and the bounds φ = 0 (n = W / s) and
 * W = 0 (n = F). Time: 2100 evaluations of |s| terms.
 * am[implements a-petta-speed-general-1108.tier-derive]
 */
function fitFW(s: number[], y: number[]): Fit {
  const at = (phi: number): { mean: number; ss: number } => centred(y.map((v, i) => v - Math.log(phi + 1 / s[i]!)));
  const ss = (x: number): number => at(Math.exp(x)).ss;
  const lo = Math.log(1e-8 / Math.max(...s)), hi = Math.log(1e8 / Math.min(...s)), steps = 2000;
  const u = (i: number): number => lo + ((hi - lo) * i) / steps;
  let bi = 0, bss = Infinity;
  for (let i = 0; i <= steps; i++) {
    const r = ss(u(i));
    if (r < bss) [bi, bss] = [i, r];
  }
  const g = (Math.sqrt(5) - 1) / 2;
  let a = u(Math.max(0, bi - 1)), b = u(Math.min(steps, bi + 1));
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = ss(x1), f2 = ss(x2);
  for (let i = 0; i < 100; i++) {
    if (f1 < f2) {
      b = x2, x2 = x1, f2 = f1;
      x1 = b - g * (b - a), f1 = ss(x1);
    } else {
      a = x1, x1 = x2, f1 = f2;
      x2 = a + g * (b - a), f2 = ss(x2);
    }
  }
  const phi = Math.exp((a + b) / 2), inner = at(phi), slope = at(0), flat = centred(y);
  const fits: [number, number, number][] = [
    [phi * Math.exp(inner.mean), Math.exp(inner.mean), inner.ss],
    [0, Math.exp(slope.mean), slope.ss],
    [Math.exp(flat.mean), 0, flat.ss],
  ];
  const [F, W, rss] = fits.reduce((p, q) => (q[2] < p[2] ? q : p));
  return { model: "F + W / s", k: 2, params: { F, W }, rss };
}

/**
 * n = max(F, min(M, W / s)), the clamp the tier rule had before, fitted to ln n at ascending sizes `s`. It is
 * W / clip(s, W / M, W / F), so ln n = w - clip(ln s, b1, b2) with w = ln W, b1 = w - ln M and b2 = w - ln F, b1 ≤ b2;
 * for given b1 and b2 the best w is the mean of ln n + clip(ln s, b1, b2), and the residual sum of squares is a convex
 * quadratic in (b1, b2) on each cell between consecutive ln s, so its least is exact: on each cell, the quadratic's
 * stationary point where the cell holds it, or the least on one of the cell's edges, where it is a parabola in the
 * edge's parameter. Where no size is held at M, M is W / the least size, the least M that fits the same, and where
 * none is held at F, F is W / the greatest size. Null with fewer than two sizes. Time: |s|^2 / 2 cells of 13
 * evaluations of |s| terms.
 * am[implements a-petta-speed-general-1108.tier-derive]
 */
function fitClamp(s: number[], y: number[]): Fit | null {
  const l = s.map(Math.log), n = l.length;
  const at = (b1: number, b2: number): { mean: number; ss: number } => centred(y.map((v, i) => v + Math.min(b2, Math.max(b1, l[i]!))));
  const best = { b1: 0, b2: 0, rss: Infinity };
  const consider = ([b1, b2]: [number, number]): void => {
    const r = at(b1, b2).ss;
    if (r < best.rss) Object.assign(best, { b1, b2, rss: r });
  };
  const centre = (xs: number[]): number[] => {
    const m = centred(xs).mean;
    return xs.map((x) => x - m);
  };
  const dot = (p: number[], q: number[]): number => p.reduce((acc, x, i) => acc + x * q[i]!, 0);
  for (let j = 0; j + 1 < n; j++)
    for (let k = j; k + 1 < n; k++) {
      // The cell b1 in [l_j, l_j+1], b2 in [l_k, l_k+1], b1 ≤ b2: a rectangle, or a triangle where both share an
      // interval.
      const [lj, lj1, lk, lk1] = [l[j]!, l[j + 1]!, l[k]!, l[k + 1]!];
      const cell: [number, number][] = j < k ? [[lj, lk], [lj1, lk], [lj1, lk1], [lj, lk1]] : [[lj, lj], [lj, lj1], [lj1, lj1]];
      for (let e = 0; e < cell.length; e++) {
        const [p, q] = [cell[e]!, cell[(e + 1) % cell.length]!];
        const along = (t: number): [number, number] => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
        const [q0, qh, q1] = [0, 0.5, 1].map((t) => at(...along(t)).ss) as [number, number, number];
        const curve = 2 * (q0 - 2 * qh + q1), rise = 4 * qh - 3 * q0 - q1;
        consider(along(0));
        if (curve > 0) consider(along(Math.min(1, Math.max(0, -rise / (2 * curve)))));
      }
      // In the cell, clip(ln s, b1, b2) is b1 at sizes 0 to j, b2 past k and ln s between, so the centred
      // ln n + clip(ln s, b1, b2) is r + b1 a + b2 c, a and c the centred indicators of the two clipped groups.
      const a = centre(l.map((_, i) => (i <= j ? 1 : 0))), c = centre(l.map((_, i) => (i > k ? 1 : 0)));
      const r = centre(y.map((v, i) => (i <= j || i > k ? v : v + l[i]!)));
      const [haa, hac, hcc, ga, gc] = [dot(a, a), dot(a, c), dot(c, c), dot(a, r), dot(c, r)];
      const det = haa * hcc - hac * hac;
      if (det > 1e-12) {
        const b1 = (gc * hac - ga * hcc) / det, b2 = (ga * hac - gc * haa) / det;
        if (b1 >= lj && b1 <= lj1 && b2 >= lk && b2 <= lk1 && b1 <= b2) consider([b1, b2]);
      }
    }
  if (best.rss === Infinity) return null;
  const w = at(best.b1, best.b2).mean;
  return { model: "max(F, min(M, W / s))", k: 3, params: { F: Math.exp(w - best.b2), M: Math.exp(w - best.b1), W: Math.exp(w) }, rss: best.rss };
}

/**
 * The cold tries a clause should run before it is compiled, from the measured rows, by Arnold et al.'s rule for
 * adaptive optimisation (Jalapeño, OOPSLA 2000), which is also the rent-or-buy break-even (Karlin et al. 1988): a clause
 * tried n times is taken to be tried n times more, so it is compiled at the least n where the compiling try and the
 * n - 1 compiled tries after it cost no more than n cold tries. Per configuration the fastest of its sets is taken for
 * each run. Prints kind, cells, cold ns per try (tries 2 to 31; the cold control's last run beside it), the compiling
 * try's ns, compiled ns per try over each run, the break-even tries within the runs measured, and the break-even
 * projected past them at the last run's cost per try.
 * Then, per kind of code a clause compiles to by compileAfter's dispatch (cell/machine.ts), it fits the finite
 * break-evens in log space by least squares as F, W / s, F + W / s (F and W at least 0) and the clamp
 * max(F, min(M, W / s)) the tier rule had before, each with its AIC, n ln(RSS / n) + 2k over n sizes and k
 * parameters, and its AICc, AIC + 2k(k + 1) / (n - k - 1) where n > k + 1, the correction for few sizes (Hurvich and
 * Tsai 1989); prints the F + W / s fits in whole tries, bounded to the sizes they were fitted on, as TIERS; and checks
 * compileAfter against them at every configuration, exiting 1 where it differs.
 * am[implements a-petta-speed-general-1108.tier-derive]
 */
function derive(file: string): void {
  const rows: Row[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const f = line.split("\t");
    if (f.length !== 7 || f[0] === "kind" || line.startsWith("#")) continue;
    rows.push({ kind: f[0] as Kind, cells: Number(f[1]), curve: f[3]!, first: Number(f[4]), last: Number(f[5]), ns: Number(f[6]) });
  }
  const best = new Map<string, number>();
  for (const r of rows) {
    const k = [r.kind, r.cells, r.curve, r.first, r.last].join(" ");
    best.set(k, Math.min(best.get(k) ?? Infinity, r.ns));
  }
  const get = (kind: Kind, cells: number, curve: string, first: number, last: number): number => best.get([kind, cells, curve, first, last].join(" ")) ?? NaN;
  const configs = [...new Set(rows.map((r) => `${r.kind} ${r.cells}`))].map((s) => s.split(" ")).map(([k, c]) => [k as Kind, Number(c)] as const);
  // Each configuration's clause, consulted as measureOne consults it: the kind of code it compiles to, by
  // compileAfter's dispatch, and the tries compileAfter gives it.
  const cm = machine();
  const clauses = new Map<string, Clause>();
  for (const [kind, m] of CONFIGS) {
    const u = `d${kind[0]}${m}`;
    consult(cm, clauseOf(kind, u, 0, m).text);
    const c = cm.om.db.get(`t${u}_0`, 2)!.clauses[0]!;
    clauses.set(`${kind} ${clauseCells(c, 1 << 20)}`, c);
  }
  const regimeOf = (c: Clause): Regime => (c.body !== "true" ? "rule" : c.head instanceof Struct && c.head.args.some(large) ? "matchedFact" : "inlineFact");
  const points: { kind: Kind; cells: number; regime: Regime; tries: number; c: Clause }[] = [];
  const spans: [number, number][] = [];
  for (let first = 1, i = 0; i < RUNS.length; first += RUNS[i]!, i++) spans.push([first, first + RUNS[i]! - 1]);
  const compiledSpans = spans.slice(3);
  console.log(["kind", "cells", "cold_ns", "cold_ctl_ns", "compile_try_ns", ...compiledSpans.map(([a, b]) => `ns_${a}_${b}`), "break_even", "projected"].join("\t"));
  for (const [kind, cells] of configs.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])) {
    const c = clauses.get(`${kind} ${cells}`);
    if (c === undefined) throw new Error(`${file}: the ${kind} rows at ${cells} cells match no configuration in CONFIGS`);
    const cold = get(kind, cells, "tiered", 2, 31);
    const coldCtl = get(kind, cells, "cold", spans[8]![0], spans[8]![1]);
    const compileTry = get(kind, cells, "tiered", 32, 32);
    const hot = compiledSpans.map(([a, b]) => get(kind, cells, "tiered", a, b));
    // C(n): the compiling try, then the compiled tries after it at their run's cost per try.
    let breakEven = compileTry <= cold ? 1 : 0;
    let cost = compileTry, n = 1;
    for (let i = 0; i < compiledSpans.length; i++)
      for (let t = compiledSpans[i]![0]; t <= compiledSpans[i]![1]; t++) {
        cost += hot[i]!;
        n++;
        if (breakEven === 0 && cost <= n * cold) breakEven = n;
      }
    // Past the last run, compiled tries are taken to cost what the last run's did: C(n) = C(N) + (n - N) h, which
    // n cold tries match from n = (C(N) - N h) / (cold - h), and never where h is no less than a cold try.
    const h = hot[hot.length - 1]!;
    const projected = breakEven > 0 ? breakEven : h < cold ? Math.ceil((cost - n * h) / (cold - h)) : Infinity;
    console.log([kind, cells, cold.toFixed(0), coldCtl.toFixed(0), compileTry.toFixed(0), ...hot.map((x) => x.toFixed(0)), breakEven > 0 ? breakEven : "never", projected].join("\t"));
    points.push({ kind, cells, regime: regimeOf(c), tries: projected, c });
  }
  console.log(`\n${["tier", "sizes", "cells", "model", "k", "rss", "aic", "aicc", "fit"].join("\t")}`);
  const tiers = new Map<Regime, { floor: number; work: number; cells: [number, number] }>();
  for (const regime of REGIMES) {
    const pts = points.filter((p) => p.regime === regime && Number.isFinite(p.tries)).sort((p, q) => p.cells - q.cells);
    if (pts.length === 0) continue;
    const s = pts.map((p) => p.cells), y = pts.map((p) => Math.log(p.tries));
    const fw = fitFW(s, y);
    for (const f of [fitF(y), fitW(s, y), fw, fitClamp(s, y)]) {
      if (f === null) continue;
      const n = s.length, aic = n * Math.log(f.rss / n) + 2 * f.k;
      const aicc = n > f.k + 1 ? (aic + (2 * f.k * (f.k + 1)) / (n - f.k - 1)).toFixed(2) : "-";
      const fit = Object.entries(f.params).map(([p, v]) => `${p} ${v.toFixed(1)}`).join(" ");
      console.log([regime, n, `${s[0]}-${s[n - 1]}`, f.model, f.k, f.rss.toFixed(4), aic.toFixed(2), aicc, fit].join("\t"));
    }
    tiers.set(regime, { floor: Math.round(fw.params.F!), work: Math.round(fw.params.W!), cells: [s[0]!, s[s.length - 1]!] });
  }
  console.log("\n# TIERS (cell/machine.ts): each kind's F + W / s in whole tries, bounded to the sizes it was fitted on");
  for (const [regime, t] of tiers) console.log(`  ${regime}: { floor: ${t.floor}, work: ${t.work}, cells: [${t.cells.join(", ")}] },`);
  const differ = points.filter((p) => {
    const t = tiers.get(p.regime);
    return t === undefined || compileAfter(p.c, true) !== Math.round(t.floor + t.work / Math.max(t.cells[0], Math.min(t.cells[1], p.cells)));
  });
  for (const p of differ) console.log(`# ${p.kind} at ${p.cells} cells: compileAfter gives ${compileAfter(p.c, true)} tries, these TIERS another`);
  const verdict = differ.length === 0 ? "gives every configuration these TIERS' tries" : `differs from these TIERS at ${differ.length} configurations`;
  console.log(`# compileAfter ${verdict}`);
  if (differ.length > 0) process.exitCode = 1;
}

const [mode, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (mode === "measure") measure();
else if (mode === "one") measureOne(rest[0] as Kind, Number(rest[1]), Number(rest[2]), Number(rest[3]), rest[4]!);
else if (mode === "derive") derive(rest[0]!);
else throw new Error("usage: tier-costs.ts measure | derive ROWS");
