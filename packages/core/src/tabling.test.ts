// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  buildEnv,
  initSt,
  mettaEval,
  registerAsyncGroundedOperation,
  registerGroundedOperation,
} from "./eval";
import { stdTable } from "./builtins";
import { parseAll } from "./parser";
import { standardTokenizer, preludeAtoms, runProgram } from "./runner";
import { analyzePurity, analyzeTableWorth, keyWellFormed, SPACE_READ_IMPURE_OPS } from "./tabling";
import { expr, sym, gint, gfloat } from "./atom";
import { format } from "./parser";
import { TableSpace } from "./table-space";

const atoms = (src: string) =>
  parseAll(src, standardTokenizer())
    .filter((t) => !t.bang)
    .map((t) => t.atom);

describe("purity analysis", () => {
  it("a pure arithmetic recursion is pure; a state-using one is not", () => {
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...atoms(
          "(= (fib $n) (unify $n 0 0 (unify $n 1 1 (+ (fib (- $n 1)) (fib (- $n 2))))))\n" +
            "(= (bump) (change-state! &s 1))\n" +
            "(= (viafib $n) (+ 1 (fib $n)))",
        ),
      ],
      stdTable(),
    );
    const pure = analyzePurity(env);
    expect(pure.has("fib")).toBe(true);
    expect(pure.has("viafib")).toBe(true);
    expect(pure.has("bump")).toBe(false);
  });

  it("impurity propagates to callers", () => {
    const env = buildEnv(
      [...preludeAtoms(), ...atoms("(= (a) (b))\n(= (b) (add-atom &self x))")],
      stdTable(),
    );
    const pure = analyzePurity(env);
    expect(pure.has("a")).toBe(false);
    expect(pure.has("b")).toBe(false);
  });

  it("treats custom sync and async grounded operations as impure by default", () => {
    const gt = stdTable();
    gt.set("host-tick", () => ({ tag: "ok", results: [gint(1)] }));
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...atoms("(= (through-sync) (host-tick))\n(= (through-async) (host-wait))"),
      ],
      gt,
    );
    env.agt.set("host-wait", async () => ({ tag: "ok", results: [gint(1)] }));

    const pure = analyzePurity(env);
    expect(pure.has("through-sync")).toBe(false);
    expect(pure.has("through-async")).toBe(false);
  });

  it("excludes effectful standard grounded operations transitively", () => {
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...atoms(
          "(= (clocked) (current-time))\n" +
            '(= (decoded) (json-decode "{\\"a\\": 1}"))\n' +
            "(= (freshened $x) (sealed () $x))",
        ),
      ],
      stdTable(),
    );

    const pure = analyzePurity(env);
    expect(pure.has("clocked")).toBe(false);
    expect(pure.has("decoded")).toBe(false);
    expect(pure.has("freshened")).toBe(false);
  });

  it("invalidates cached analysis when a host operation is registered", () => {
    const env = buildEnv([...preludeAtoms()], stdTable());
    env.tableSpace = new TableSpace();
    env.tablingDirty = false;
    env.pureFunctors = new Set(["host-wait"]);
    env.compiled = new Map();
    env.compileDirty = false;
    const key = env.tableSpace.key("ground", expr([sym("cached")]), 0);
    env.tableSpace.rememberCompleted(key, 0, [gint(1)]);

    registerAsyncGroundedOperation(env, "host-wait", async () => ({
      tag: "ok",
      results: [gint(1)],
    }));

    expect(env.tablingDirty).toBe(true);
    expect(env.tableSpace.stats()).toEqual({ entries: 0, answers: 0, approxCells: 0 });
    expect(env.compiled).toBeUndefined();
    expect(env.compileDirty).toBeUndefined();
  });

  it("re-evaluates a ground call after its host operation is registered", () => {
    const env = buildEnv([...preludeAtoms()], stdTable());
    const call = expr([sym("late-host-op")]);
    const [before, state] = mettaEval(env, 10_000, initSt(), [], call);
    expect(before.map((pair) => format(pair[0]))).toEqual(["(late-host-op)"]);

    registerGroundedOperation(env, "late-host-op", () => ({ tag: "ok", results: [gint(7)] }));
    const [after] = mettaEval(env, 10_000, state, [], call);
    expect(after.map((pair) => format(pair[0]))).toEqual(["7"]);
  });

  it("table-worth analysis admits branching recursion and rejects linear recursion", () => {
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...atoms(
          "(= (fib $n) (if (< $n 2) $n (+ (fib (- $n 1)) (fib (- $n 2)))))\n" +
            "(= (fact $n $acc) (if (< $n 2) $acc (fact (- $n 1) (* $acc $n))))",
        ),
      ],
      stdTable(),
    );
    const pure = analyzePurity(env);
    const worth = analyzeTableWorth(env, pure);
    expect(worth.has("fib")).toBe(true);
    expect(worth.has("fact")).toBe(false);
  });

  it("admits match as a versioned space read but keeps get-atoms impure", () => {
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...atoms(
          "(= (read $n) (unify $n 0 (match &self (p $x) $x) (pair (read (- $n 1)) (read (- $n 1)))))\n" +
            "(= (read-all) (get-atoms &self))",
        ),
      ],
      stdTable(),
    );
    const pure = analyzePurity(env);
    const spaceReadPure = analyzePurity(env, SPACE_READ_IMPURE_OPS);
    const spaceReadWorth = analyzeTableWorth(env, spaceReadPure);

    expect(pure.has("read")).toBe(false);
    expect(spaceReadPure.has("read")).toBe(true);
    expect(spaceReadWorth.has("read")).toBe(true);
    expect(spaceReadPure.has("read-all")).toBe(false);
  });

  it("structural table keys are stable and keyWellFormed rejects floats", () => {
    const tables = new TableSpace();
    const call = expr([sym("fib"), gint(30)]);
    expect(tables.key("ground", call, 0).tokens).toEqual(tables.key("ground", call, 0).tokens);
    expect(tables.key("ground", call, 0).tokens).not.toEqual(tables.key("ground", call, 1).tokens);
    expect(tables.key("ground-space-read", call, [2, 3]).tokens).toEqual(
      tables.key("ground-space-read", call, [2, 3]).tokens,
    );
    expect(tables.key("ground-space-read", call, [2, 3]).tokens).not.toEqual(
      tables.key("ground-space-read", call, [2, 4]).tokens,
    );
    expect(tables.key("ground-space-read", call, [2, 3]).tokens).not.toEqual(
      tables.key("ground", call, 2).tokens,
    );
    expect(keyWellFormed(call)).toBe(true);
    expect(keyWellFormed(expr([sym("g"), gfloat(1.5)]))).toBe(false);
  });
});

describe("tabling end to end", () => {
  it("tabled fib agrees with untabled (fib 20) and computes fib(30) fast", () => {
    const fib = "(= (fib $n) (unify $n 0 0 (unify $n 1 1 (+ (fib (- $n 1)) (fib (- $n 2))))))";
    const small = `${fib}\n!(fib 20)`;
    const untabled = runProgram(small, 100_000, new Map(), { tabling: false });
    const tabled = runProgram(small, 100_000, new Map(), { tabling: true });
    expect(tabled.map((r) => r.results.map(format))).toEqual(
      untabled.map((r) => r.results.map(format)),
    );
    // fib(30) is infeasible untabled (~35s); tabled it is instant and exact.
    const big = runProgram(`${fib}\n!(fib 30)`, 100_000, new Map(), { tabling: true });
    expect(big[0]!.results.map(format)).toEqual(["832040"]);
  });

  it("tabling preserves multiplicity of a pure function over many calls", () => {
    const src = "(= (tri $n) (if (< $n 1) 0 (+ $n (tri (- $n 1)))))\n!(+ (tri 5) (tri 5))";
    const tabled = runProgram(src, 100_000, new Map(), { tabling: true });
    expect(tabled[0]!.results.map(format)).toEqual(["30"]);
  });

  it("linear recursion is not tabled automatically but still evaluates correctly", () => {
    const src = "(= (fact $n $acc) (if (< $n 2) $acc (fact (- $n 1) (* $acc $n))))\n!(fact 8 1)";
    const tabled = runProgram(src, 100_000, new Map(), { tabling: true });
    const untabled = runProgram(src, 100_000, new Map(), { tabling: false });
    expect(tabled[0]!.results.map(format)).toEqual(untabled[0]!.results.map(format));
    expect(tabled[0]!.results.map(format)).toEqual(["40320"]);
  });
});

describe("tabling invalidation", () => {
  it("does not remember space-read answer bags cut by depth or work bounds", () => {
    const rules = `
      (fact a)
      (fact b)
      (= (read $n)
         (unify $n 0
           (match &self (fact $x) $x)
           (join (read (- $n 1)) (read (- $n 1)))))
      (= (join $x $y) ($x $y))
    `;
    const cases: ReadonlyArray<readonly [key: string, low: number, high: number, reason: string]> =
      [
        ["max-stack-depth", 3, 100, "StackOverflow"],
        ["mettascript-max-steps", 20, 100_000, "ResourceLimit"],
      ];

    for (const [key, low, high, reason] of cases) {
      const results = runProgram(
        `${rules}
         !(pragma! ${key} ${low})
         !(read 2)
         !(pragma! ${key} ${high})
         !(read 2)`,
        100_000,
        new Map(),
        { tabling: true },
      );
      const cut = results[1]!.results.map(format);
      const complete = results[3]!.results.map(format);

      expect(cut.some((result) => result.includes(reason))).toBe(true);
      expect(complete).toHaveLength(16);
      expect(complete.some((result) => result.includes("Overflow"))).toBe(false);
      expect(complete.some((result) => result.includes("ResourceLimit"))).toBe(false);
    }
  });

  it("runtime helper rule changes invalidate cached callers through the world rule version", () => {
    const src =
      "(= (fib $n) (if (< $n 2) (base) (+ (fib (- $n 1)) (fib (- $n 2)))))\n" +
      "!(add-atom &self (= (base) 1))\n" +
      "!(fib 3)\n" +
      "!(remove-atom &self (= (base) 1))\n" +
      "!(add-atom &self (= (base) 2))\n" +
      "!(fib 3)";
    const tabled = runProgram(src, 100_000, new Map(), { tabling: true });
    const untabled = runProgram(src, 100_000, new Map(), { tabling: false });
    const lastT = tabled[tabled.length - 1]!.results.map(format);
    const lastU = untabled[untabled.length - 1]!.results.map(format);
    expect(lastT).toEqual(lastU);
    expect(lastT).toEqual(["6"]);
  });

  it("static rule removals do not reuse cached answers from the full static graph", () => {
    const src =
      "(= (base) 1)\n" +
      "(= (fib $n) (if (< $n 2) (base) (+ (fib (- $n 1)) (fib (- $n 2)))))\n" +
      "!(fib 3)\n" +
      "!(remove-atom &self (= (base) 1))\n" +
      "!(fib 3)";
    const tabled = runProgram(src, 100_000, new Map(), { tabling: true });
    const untabled = runProgram(src, 100_000, new Map(), { tabling: false });
    expect(tabled.map((r) => r.results.map(format))).toEqual(
      untabled.map((r) => r.results.map(format)),
    );
  });
});

// A function defined at RUNTIME via add-atom (PeTTa's fibadd) lands in the per-world selfRules, not the
// static rule index, so it bypassed analyzePurity and ran un-memoised (exponential). It is now tabled with
// a rule-set-versioned key, which stays byte-identical to no-tabling even when the space mutates or the
// function is redefined.
describe("runtime-rule tabling (fibadd)", () => {
  const bothMatch = (src: string) => {
    const off = runProgram(src, 200_000_000, new Map(), { tabling: false });
    const on = runProgram(src, 200_000_000, new Map(), { tabling: true });
    expect(on.map((r) => r.results.map(format))).toEqual(off.map((r) => r.results.map(format)));
    return on;
  };

  it("a runtime-defined fib is memoised and correct", () => {
    const on = bothMatch(
      "!(add-atom &self (= (fib $N) (if (< $N 2) $N (+ (fib (- $N 1)) (fib (- $N 2))))))\n!(fib 22)",
    );
    expect(on[on.length - 1]!.results.map(format)).toEqual(["17711"]);
  });

  it("versions a runtime-defined branching space reader across fact writes", () => {
    bothMatch(
      "!(add-atom &self (= (read $n $x) " +
        "(unify $n 0 (match &self (fact $x) hit) " +
        "(join (read (- $n 1) $x) (read (- $n 1) $x)))))\n" +
        "!(add-atom &self (= (join hit hit) hit))\n" +
        "!(read 2 runtime)\n" +
        "!(add-atom &self (fact runtime))\n" +
        "!(read 2 runtime)",
    );
  });

  it("a linear runtime space reader is not worth tabling, so state changes show", () => {
    // (cnt) reads the space but has no branching recursion, so the table-worth gate leaves it untabled.
    bothMatch(
      "!(add-atom &self (= (cnt) (foldall + (match &self (foo $x) 1) 0)))\n" +
        "!(add-atom &self (foo a))\n!(cnt)\n!(add-atom &self (foo b))\n!(cnt)",
    );
  });

  it("redefining a runtime function does not serve a stale memo (version bumps)", () => {
    bothMatch(
      "!(add-atom &self (= (k $n) (* $n 10)))\n!(k 5)\n" +
        "!(add-atom &self (= (k $n) (* $n 100)))\n!(collapse (k 5))",
    );
  });
});

// A table is a pure memo, so refusing one can only cost time and never change a result. That is what
// lets admission watch the OUTCOME rather than trust the static call-graph guess: a functor that
// stores entry after entry and never reads one back is pure overhead, whatever the analysis thought.
describe("measured table utility", () => {
  const space = () => new TableSpace();
  const keyFor = (ts: TableSpace, call: string) =>
    ts.key("ground", parseAll(call, standardTokenizer())[0]!.atom, 0);

  it("keeps admitting a functor whose memo is read back", () => {
    const ts = space();
    for (let i = 0; i < 1000; i++) {
      const key = keyFor(ts, `(f ${i})`);
      ts.rememberCompleted(key, 0, [sym("answer")]);
      expect(ts.getCompleted(key)).toBeDefined();
    }

    expect(ts.admitsFunctor("f")).toBe(true);
    const utility = ts.functorUtilityOf("f");
    expect(utility?.inserts).toBe(1000);
    expect(utility?.hits).toBe(1000);
  });

  it("revokes a functor that stores entries and never reads one", () => {
    const ts = space();
    // Every call is distinct, so no entry can ever be read back — the accumulator-loop shape.
    for (let i = 0; i < 300; i++) ts.rememberCompleted(keyFor(ts, `(g ${i})`), 0, [sym("answer")]);

    expect(ts.admitsFunctor("g")).toBe(false);
    expect(ts.functorUtilityOf("g")?.hits).toBe(0);
    // Revocation is per functor: an unrelated one is untouched.
    expect(ts.admitsFunctor("f")).toBe(true);
  });

  it("does not revoke before the warm-up threshold", () => {
    const ts = space();
    for (let i = 0; i < 32; i++) ts.rememberCompleted(keyFor(ts, `(h ${i})`), 0, [sym("answer")]);

    expect(ts.admitsFunctor("h")).toBe(true);
  });

  it("a single read keeps a functor admitted for the rest of the run", () => {
    const ts = space();
    const read = keyFor(ts, "(i 0)");
    ts.rememberCompleted(read, 0, [sym("answer")]);
    expect(ts.getCompleted(read)).toBeDefined();
    for (let i = 1; i < 400; i++) ts.rememberCompleted(keyFor(ts, `(i ${i})`), 0, [sym("answer")]);

    expect(ts.admitsFunctor("i")).toBe(true);
  });
});
