// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { gint, sym, type Atom } from "./atom";
import { setOutputSink, stdTable, type GroundFn } from "./builtins";
import { buildEnv, initSt, mettaEval, registerGroundedOperation, type AsyncGroundFn } from "./eval";
import {
  registerBuiltinGroundedOperation,
  registeredBuiltinGroundedOperations,
} from "./grounded-extensions";
import { format, parseAll } from "./parser";
import { preludeAtoms, runProgram, runProgramAsync, standardTokenizer } from "./runner";
import { TableSpace } from "./table-space";

const FUZZ_CASE_TYPE = "(: _fuzz-eval-case (-> Atom Number Number Atom Atom))";

function printed(src: string): string[][] {
  return runProgram(`${FUZZ_CASE_TYPE}\n${src}`).map((query) => query.results.map(format));
}

function parseAtom(src: string): Atom {
  const parsed = parseAll(src, standardTokenizer());
  if (parsed.length !== 1) throw new Error(`expected one atom, got ${parsed.length}`);
  return parsed[0]!.atom;
}

let restoreOutput: ((line: string) => void) | undefined;
afterEach(() => {
  if (restoreOutput !== undefined) setOutputSink(restoreOutput);
  restoreOutput = undefined;
});

describe("built-in grounded operation extensions", () => {
  it("registers an operation idempotently and installs it in every fresh environment", () => {
    const op: GroundFn = () => ({ tag: "ok", results: [gint(73)] });
    registerBuiltinGroundedOperation("_fuzz-test-global-op", op, "Pure");
    registerBuiltinGroundedOperation("_fuzz-test-global-op", op, "Pure");

    const registrations = registeredBuiltinGroundedOperations().filter(
      (entry) => entry.name === "_fuzz-test-global-op",
    );
    expect(registrations).toEqual([
      { name: "_fuzz-test-global-op", operation: op, effect: "Pure" },
    ]);
    expect(runProgram("!(_fuzz-test-global-op)")[0]!.results.map(format)).toEqual(["73"]);
  });

  it("rejects a conflicting registration", () => {
    const first: GroundFn = () => ({ tag: "ok", results: [sym("first")] });
    registerBuiltinGroundedOperation("_fuzz-test-conflict", first, "Pure");
    expect(() =>
      registerBuiltinGroundedOperation(
        "_fuzz-test-conflict",
        () => ({ tag: "ok", results: [sym("second")] }),
        "Pure",
      ),
    ).toThrow(/already registered/);
    expect(() => registerBuiltinGroundedOperation("_fuzz-test-conflict", first, "Host")).toThrow(
      /already registered/,
    );
  });
});

describe("_fuzz-eval-case result capture", () => {
  it("keeps the complete ordered result bag, including duplicates", () => {
    const result = printed(
      "!(_fuzz-eval-case (superpose (first second first)) 10000 100 Sandboxed)",
    )[0]!;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^\(FuzzCaseOutcome Completed \(first second first\) [0-9]+\)$/);
  });

  it("distinguishes a zero-result property from an Empty atom", () => {
    const out = printed(`
      !(_fuzz-eval-case (superpose ()) 10000 100 Sandboxed)
      !(_fuzz-eval-case Empty 10000 100 Sandboxed)
    `);
    expect(out[0]![0]).toMatch(/^\(FuzzCaseOutcome Completed \(\) [0-9]+\)$/);
    expect(out[1]![0]).toMatch(/^\(FuzzCaseOutcome Completed \(Empty\) [0-9]+\)$/);
  });

  it("does not evaluate the lazy body before installing the effect barrier", () => {
    const lines: string[] = [];
    restoreOutput = setOutputSink((line) => lines.push(line));
    const result = printed(
      "!(_fuzz-eval-case (println! should-not-print) 10000 100 Sandboxed)",
    )[0]![0]!;

    expect(lines).toEqual([]);
    expect(result).toContain("(EffectDenied Host println!)");
    expect(result).toContain("(FuzzEffectDenied Host println!)");
  });
});

describe("_fuzz-eval-case rollback", () => {
  it("restores added facts, removed static atoms, and runtime rules", () => {
    const out = printed(`
      (kept 1)
      !(_fuzz-eval-case
          (let $_ (add-atom &self (case-fact 2))
            (let $_ (remove-atom &self (kept 1))
              (let $_ (add-atom &self (= (case-only) 9))
                (superpose ((case-only)
                            (collapse (match &self (case-fact $x) $x))
                            (collapse (match &self (kept $x) $x)))))))
          10000 100 Sandboxed)
      !(case-only)
      !(collapse (match &self (case-fact $x) $x))
      !(collapse (match &self (kept $x) $x))
    `);

    expect(out[0]![0]).toContain("(9 (2) ())");
    expect(out[1]).toEqual(["(case-only)"]);
    expect(out[2]).toEqual(["()"]);
    expect(out[3]).toEqual(["(1)"]);
  });

  it("restores named spaces, state cells, and tokens", () => {
    const out = printed(`
      !(bind! &case-space (new-space))
      !(bind! &case-state (new-state 2))
      !(_fuzz-eval-case
          (let $added (add-atom &case-space (inside 3))
            (let $changed (change-state! &case-state 4)
              (let $bound (bind! case-token changed)
                (get-state &case-state))))
          10000 100 Sandboxed)
      !(collapse (get-atoms &case-space))
      !(get-state &case-state)
      ! case-token
    `);

    expect(out[2]![0]).toContain("(4)");
    expect(out[3]).toEqual(["()"]);
    expect(out[4]).toEqual(["2"]);
    expect(out[5]).toEqual(["case-token"]);
  });

  it("rolls back on ordinary errors and resource cutoffs", () => {
    const out = printed(`
      !(_fuzz-eval-case
          (let $_ (add-atom &self (from-error))
            (Error subject failure))
          10000 100 Sandboxed)
      !(collapse (match &self (from-error) found))
      !(_fuzz-eval-case
          (let $_ (add-atom &self (from-cutoff))
            (collapse (match &self $x $x)))
          1 100 Sandboxed)
      !(collapse (match &self (from-cutoff) found))
    `);

    expect(out[0]![0]).toContain("(Error subject failure)");
    expect(out[1]).toEqual(["()"]);
    expect(out[2]![0]).toContain("ResourceLimit");
    expect(out[3]).toEqual(["()"]);
  });

  it("restores evaluator caches invalidated by a case-local runtime rule", () => {
    const env = buildEnv([...preludeAtoms(), parseAtom(FUZZ_CASE_TYPE)], stdTable());
    const tables = new TableSpace();
    env.tableSpace = tables;
    env.tablingDirty = true;
    env.compiled = new Map();
    env.compileDirty = true;
    env.compiledComplete = false;
    const caseCall = parseAtom(
      "(_fuzz-eval-case (let $added (add-atom &self (= (case-rule) 1)) (case-rule)) 10000 100 Sandboxed)",
    );
    const [, warmedState] = mettaEval(env, 100_000, initSt(), [], caseCall);
    const compiled = env.compiled;
    const pureFunctors = env.pureFunctors;
    const compileDirty = env.compileDirty;
    const compiledComplete = env.compiledComplete;
    const tablingDirty = env.tablingDirty;
    tables.clear();
    const tableKey = tables.key("ground", parseAtom("(cached-call)"), 0);
    tables.rememberCompleted(tableKey, 0, [gint(11)]);

    mettaEval(env, 100_000, warmedState, [], caseCall);

    expect(env.tableSpace).toBe(tables);
    expect(env.tableSpace.stats()).toEqual({ entries: 1, answers: 1, approxCells: 2 });
    expect(env.compiled).toBe(compiled);
    expect(env.compileDirty).toBe(compileDirty);
    expect(env.compiledComplete).toBe(compiledComplete);
    expect(env.pureFunctors).toBe(pureFunctors);
    expect(env.tablingDirty).toBe(tablingDirty);
  });

  it("keeps generated ids monotone even though their worlds are rolled back", () => {
    const out = printed(`
      !(new-space)
      !(_fuzz-eval-case (new-space) 10000 100 Sandboxed)
      !(new-space)
    `);
    const before = out[0]![0]!;
    const inside = /\((&space-[0-9]+)\)/.exec(out[1]![0]!)?.[1];
    const after = out[2]![0]!;
    expect([before, inside, after]).toEqual(["&space-0", "&space-1", "&space-2"]);
  });

  it("applies a case-local depth allowance and restores the outer allowance", () => {
    const deep = "(S ".repeat(20) + "Z" + ")".repeat(20);
    const shallow = "(S ".repeat(4) + "Z" + ")".repeat(4);
    const out = printed(`
      (= (deep Z) done)
      (= (deep (S $n)) (wrap (deep $n)))
      !(_fuzz-eval-case (deep ${deep}) 10000 5 Sandboxed)
      !(deep ${shallow})
    `);
    expect(out[0]![0]).toContain("(FuzzCaseOutcome StackOverflow");
    expect(out[0]![0]).toContain("StackOverflow");
    expect(out[1]).toEqual(["(wrap (wrap (wrap (wrap done))))"]);
  });
});

describe("_fuzz-eval-case effect policy", () => {
  it("denies unknown host operations before calling them", () => {
    let calls = 0;
    const env = buildEnv(
      [...preludeAtoms(), parseAtom(FUZZ_CASE_TYPE), parseAtom("(: host-probe (-> Number))")],
      stdTable(),
    );
    registerGroundedOperation(env, "host-probe", () => {
      calls += 1;
      return { tag: "ok", results: [gint(1)] };
    });

    const [pairs] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parseAtom("(_fuzz-eval-case (host-probe) 10000 100 Sandboxed)"),
    );
    expect(calls).toBe(0);
    expect(pairs.map((pair) => format(pair[0]))[0]).toContain("(EffectDenied Host host-probe)");
  });

  it("allows operations explicitly registered as pure", () => {
    let calls = 0;
    const env = buildEnv(
      [...preludeAtoms(), parseAtom(FUZZ_CASE_TYPE), parseAtom("(: pure-probe (-> Number))")],
      stdTable(),
    );
    registerGroundedOperation(
      env,
      "pure-probe",
      () => {
        calls += 1;
        return { tag: "ok", results: [gint(7)] };
      },
      "Pure",
    );

    const [pairs] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parseAtom("(_fuzz-eval-case (pure-probe) 10000 100 Sandboxed)"),
    );
    expect(calls).toBe(1);
    expect(pairs.map((pair) => format(pair[0]))[0]).toMatch(
      /^\(FuzzCaseOutcome Completed \(7\) [0-9]+\)$/,
    );
  });

  it("denies time, randomness, import, and concurrent host work", () => {
    const out = printed(`
      !(_fuzz-eval-case (current-time) 10000 100 Sandboxed)
      !(_fuzz-eval-case (random-int 0 10) 10000 100 Sandboxed)
      !(_fuzz-eval-case (import! &self json) 10000 100 Sandboxed)
      !(_fuzz-eval-case (race 1 2) 10000 100 Sandboxed)
    `);
    expect(out[0]![0]).toContain("(EffectDenied Host current-time)");
    expect(out[1]![0]).toContain("(EffectDenied Host random-int)");
    expect(out[2]![0]).toContain("(EffectDenied Host import!)");
    expect(out[3]![0]).toContain("(EffectDenied AsyncHost race)");
  });

  it("denies every standard output and file operation before execution", () => {
    const lines: string[] = [];
    restoreOutput = setOutputSink((line) => lines.push(line));
    const out = printed(`
      !(_fuzz-eval-case (print! hidden) 10000 100 Sandboxed)
      !(_fuzz-eval-case (println! hidden) 10000 100 Sandboxed)
      !(_fuzz-eval-case (trace! hidden retained) 10000 100 Sandboxed)
      !(_fuzz-eval-case (file-open! "/path/that/does/not/exist" "r") 10000 100 Sandboxed)
    `);
    expect(lines).toEqual([]);
    expect(out[0]![0]).toContain("(EffectDenied Host print!)");
    expect(out[1]![0]).toContain("(EffectDenied Host println!)");
    expect(out[2]![0]).toContain("(EffectDenied Host println!)");
    expect(out[3]![0]).toContain("(EffectDenied Host file-open!)");
  });

  it("allows declared world effects and rolls their changes back", () => {
    let calls = 0;
    const env = buildEnv(
      [...preludeAtoms(), parseAtom(FUZZ_CASE_TYPE), parseAtom("(: world-probe (-> Atom))")],
      stdTable(),
    );
    registerGroundedOperation(
      env,
      "world-probe",
      () => {
        calls += 1;
        return {
          tag: "ok",
          results: [sym("changed")],
          effects: [
            {
              kind: "addAtom",
              space: sym("&self"),
              atom: parseAtom("(world-effect leaked)"),
            },
          ],
        };
      },
      "World",
    );
    let state = initSt();
    const [, afterCase] = mettaEval(
      env,
      100_000,
      state,
      [],
      parseAtom("(_fuzz-eval-case (world-probe) 10000 100 Sandboxed)"),
    );
    state = afterCase;
    const [matches] = mettaEval(
      env,
      100_000,
      state,
      [],
      parseAtom("(collapse (match &self (world-effect $x) $x))"),
    );
    expect(calls).toBe(1);
    expect(matches.map((pair) => format(pair[0]))).toEqual(["()"]);
  });

  it("allows host effects only when ExternalEffects is requested explicitly", () => {
    const lines: string[] = [];
    restoreOutput = setOutputSink((line) => lines.push(line));
    const out = printed("!(_fuzz-eval-case (println! external-line) 10000 100 ExternalEffects)");
    expect(lines).toEqual(["external-line"]);
    expect(out[0]![0]).toMatch(/^\(FuzzCaseOutcome Completed \(\(\)\) [0-9]+\)$/);
  });

  it("does not let a nested case escalate a sandboxed policy", () => {
    const out = printed(`
      !(_fuzz-eval-case
          (_fuzz-eval-case (println! forbidden) 10000 100 ExternalEffects)
          10000 100 Sandboxed)
    `);
    expect(out[0]![0]).toContain("fuzz effect policy cannot be escalated");
  });

  it("denies async grounded operations before awaiting them", async () => {
    let calls = 0;
    const operation: AsyncGroundFn = async () => {
      calls += 1;
      return { tag: "ok", results: [gint(5)] };
    };
    const out = await runProgramAsync(
      `${FUZZ_CASE_TYPE}
       (: async-probe (-> Number))
       !(_fuzz-eval-case (async-probe) 10000 100 Sandboxed)`,
      new Map([["async-probe", operation]]),
    );
    expect(calls).toBe(0);
    expect(out[0]!.results.map(format)[0]).toContain("(EffectDenied AsyncHost async-probe)");
  });
});
