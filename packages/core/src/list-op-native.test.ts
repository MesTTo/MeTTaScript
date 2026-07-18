// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface DiffCase {
  readonly name: string;
  readonly src: string;
}

const FOLD_CASES: readonly DiffCase[] = [
  {
    name: "ground arithmetic fold",
    src: `
      !(foldl-atom (1 2 3 4) 0 $a $b (+ $a $b))
    `,
  },
  {
    name: "list-building fold",
    src: `
      !(foldl-atom (1 2 3) () $a $b (cons-atom $b $a))
    `,
  },
  {
    name: "nondeterministic fold op keeps branch order",
    src: `
      (= (pick $a $b) $a)
      (= (pick $a $b) $b)
      !(foldl-atom (1 2) 0 $a $b (pick $a $b))
    `,
  },
  {
    name: "fold substitutions are sequential",
    src: `
      !(foldl-atom (1) $b $a $b (pair $a $b))
    `,
  },
  {
    name: "fold keeps free variables structured accumulators and boundary lists",
    src: `
      (= (fresh-out) $fresh)
      !(foldl-atom () (seed $z) $a $b (pair $a $b $free))
      !(foldl-atom (solo) (seed $z) $a $b (pair $a $b $free))
      !(fresh-out)
    `,
  },
  {
    name: "fold keeps pattern-binding overlap semantics",
    src: `
      (= (remove-857 $list $elem)
        (if-decons-expr $list $head $tail
          (unify $elem $head ($head $tail) (let ($res $ntail) (remove-857 $tail $elem) ($res (cons-atom $head $ntail))))
          (() $list)))
      (= (overlap-857 $list1 $list2)
        (foldl-atom $list1 (() () $list2) $accum $elem
          (let ($left $intersection $right) $accum
            (let ($res $nright) (remove-857 $right $elem)
              (if (== $res ())
                ((cons-atom $elem $left) $intersection $right)
                ($left (cons-atom $res $intersection) $nright))))))
      !(overlap-857 (a b c) (b c d))
    `,
  },
];

const INERT_CASES: readonly DiffCase[] = [
  {
    name: "size-atom over structured inert data",
    src: `
      !(size-atom (((Inheritance A B) (stv 0.5 0.9)) ((Inheritance B C) (stv 0.7 0.8)) ((Similarity C D) (stv 0.6 0.6))))
    `,
  },
  {
    name: "nested inert expression-headed data",
    src: `
      !(size-atom (((Sentence (Inheritance A B)) (Truth (stv 1.0 0.9))) ((Sentence (Evaluation P A)) (Truth (stv 0.5 0.7)))))
    `,
  },
  {
    name: "expression-headed partial application still reduces",
    src: `
      !(size-atom (((partial + (1)) 2) ((Inheritance A B) (stv 0.5 0.9))))
    `,
  },
];

const MAP_FILTER_CASES: readonly DiffCase[] = [
  {
    name: "ground map and filter over data lists",
    src: `
      !(map-atom (1 2 3) $x (eval (* $x 2)))
      !(filter-atom (1 2 3 4) $x (eval (== (% $x 2) 0)))
    `,
  },
  {
    name: "nondeterministic map keeps prelude cartesian order",
    src: `
      !(map-atom (a b) $x (superpose ($x (pair $x))))
    `,
  },
  {
    name: "free variables from map keep the same fresh names",
    src: `
      (= (fresh-out) $fresh)
      !(map-atom (a b) $x (foo $y))
      !(fresh-out)
    `,
  },
  {
    name: "two sequential map-atoms keep the counter aligned",
    src: `
      (= (fresh-out) $fresh)
      !(map-atom (a b) $x (foo $y))
      !(map-atom (c) $x (bar $z))
      !(fresh-out)
    `,
  },
  {
    name: "nested, empty, and single-item lists",
    src: `
      !(map-atom ((a b) () (c)) $x (wrap $x))
      !(map-atom () $x (wrap $x))
      !(filter-atom (solo) $x True)
    `,
  },
  {
    name: "filter keeps original elements and nondeterministic order",
    src: `
      !(filter-atom (1 2) $x (superpose (True False)))
    `,
  },
  {
    name: "filter non-Bool predicate follows the prelude",
    src: `
      !(filter-atom (1 2) $x maybe)
    `,
  },
  {
    name: "user-function map and filter stay byte-identical",
    src: `
      (= (dbl $x) (* $x 2))
      (= (even-num $x) (== (% $x 2) 0))
      !(map-atom (1 2 3) $x (dbl $x))
      !(filter-atom (1 2 3 4) $x (even-num $x))
    `,
  },
];

const CHILD = String.raw`
  import { expr, variable } from "./packages/core/src/atom";
  import { setOutputSink, setRawSink, stdTable } from "./packages/core/src/builtins";
  import { addAtomToEnv, buildEnv, initSt, mettaEval } from "./packages/core/src/eval";
  import { withBuiltinModules } from "./packages/core/src/extensions";
  import { parseAll, format } from "./packages/core/src/parser";
  import { pettaStdlibAtoms } from "./packages/core/src/petta-stdlib";
  import { preludeAtoms, standardTokenizer } from "./packages/core/src/runner";
  import { stdlibAtoms } from "./packages/core/src/stdlib";
  import { analyzePurity, analyzeTableWorth, MODED_IMPURE_OPS } from "./packages/core/src/tabling";
  import { TableSpace } from "./packages/core/src/table-space";

  const cases = JSON.parse(Buffer.from(process.env.METTA_NATIVE_DIFF_CASES, "base64").toString());

  function buildDefaultTestEnv() {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms()], stdTable());
    env.imports = withBuiltinModules(new Map());
    env.tableSpace = new TableSpace();
    env.pureFunctors = analyzePurity(env);
    env.modedPureFunctors = analyzePurity(env, MODED_IMPURE_OPS);
    env.tableWorth = analyzeTableWorth(env, env.pureFunctors);
    env.modedTableWorth = analyzeTableWorth(env, env.modedPureFunctors);
    env.tablingDirty = false;
    env.compiled = new Map();
    env.compileDirty = true;
    return env;
  }

  function normalizeVars(atom, names = new Map()) {
    switch (atom.kind) {
      case "var": {
        let name = names.get(atom.name);
        if (name === undefined) {
          name = "_" + String(names.size);
          names.set(atom.name, name);
        }
        return variable(name);
      }
      case "expr":
        return expr(atom.items.map((item) => normalizeVars(item, names)));
      default:
        return atom;
    }
  }

  function runCase(src) {
    const env = buildDefaultTestEnv();
    let st = initSt();
    const results = [];
    const restoreOutput = setOutputSink(() => {});
    const restoreRaw = setRawSink(() => {});
    try {
      for (const { atom, bang } of parseAll(src, standardTokenizer())) {
        if (!bang) {
          addAtomToEnv(env, atom);
          continue;
        }
        const [pairs, st2] = mettaEval(env, 100_000, st, [], atom);
        st = st2;
        results.push({
          query: format(atom),
          results: pairs.map((pair) => format(normalizeVars(pair[0]))),
        });
      }
    } finally {
      setOutputSink(restoreOutput);
      setRawSink(restoreRaw);
    }
    return { results };
  }

  console.log(JSON.stringify(cases.map((testCase) => ({
    name: testCase.name,
    ...runCase(testCase.src),
  }))));
`;

function runWithEnv(cases: readonly DiffCase[], env: Record<string, string>): unknown {
  const encodedCases = Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
  const out = execFileSync("pnpm", ["exec", "tsx", "-e", CHILD], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      METTA_NATIVE_DIFF_CASES: encodedCases,
      ...env,
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(out);
}

function runNativeFold(enabled: boolean): unknown {
  return runWithEnv(FOLD_CASES, {
    METTA_NATIVE_FOLD: enabled ? "1" : "0",
  });
}

describe("native foldl-atom", () => {
  it("matches the prelude recursion up to variable renaming", () => {
    expect(runNativeFold(true)).toEqual(runNativeFold(false));
  }, 60_000);
});

describe("inert data tuple short-circuit", () => {
  it("matches the interpret-tuple fallback up to variable renaming", () => {
    expect(runWithEnv(INERT_CASES, { METTA_CTOR_SC: "1" })).toEqual(
      runWithEnv(INERT_CASES, { METTA_CTOR_SC: "0" }),
    );
  }, 60_000);
});

describe("native map-atom and filter-atom", () => {
  it("matches the prelude recursion up to variable renaming", () => {
    expect(
      runWithEnv(MAP_FILTER_CASES, { METTA_NATIVE_MAP: "1", METTA_NATIVE_FILTER: "1" }),
    ).toEqual(runWithEnv(MAP_FILTER_CASES, { METTA_NATIVE_MAP: "0", METTA_NATIVE_FILTER: "0" }));
  }, 60_000);
});
