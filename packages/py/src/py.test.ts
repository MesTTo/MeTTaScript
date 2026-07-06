// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Unit + property tests for the py-call surface over MockPyBridge (no Python needed).
// The marshalling expectations are the janus parity table observed against live PeTTa; the
// differential suite (py-differential.test.ts) holds the same programs to byte-parity with PeTTa.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { MeTTa, S, E, ValueAtom, GroundedAtom } from "@metta-ts/hyperon";
import type { Atom } from "@metta-ts/hyperon";
import { atomToPy, pyToAtom, registerPyInterop } from "./py";
import { MockPyBridge } from "./py-mock";

const runA = async (m: MeTTa, q: string): Promise<string[]> =>
  (await m.runAsync(q))[0]!.map((a) => a.toString());

const fresh = (): { m: MeTTa; b: MockPyBridge } => {
  const m = new MeTTa();
  const b = new MockPyBridge();
  registerPyInterop(m, b);
  return { m, b };
};

// The semantics gate: everything below builds on these two engine facts (proven by hand first,
// kept as a test so a core change that breaks either fails HERE, not deep inside py-call).
describe("spike gate: registered async op argument semantics", () => {
  it("reduces argument subterms but keeps unknown-head specs and quote wrappers as data", async () => {
    const m = new MeTTa();
    let seen: string[] = [];
    m.registerAsyncOperation("dummy", (args) => {
      seen = args.map((a) => a.toString());
      return Promise.resolve([args[0]!]);
    });
    await m.runAsync('!(dummy (str (+ 1 2)) (quote (eval "x" 1 2)))');
    expect(seen).toEqual(["(str 3)", '(quote (eval "x" 1 2))']);
  });
});

describe("py-call dispatch", () => {
  it("bare head calls a builtin", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (str 5))")).toEqual(["5"]);
  });

  it("mod.fn head calls a module function, module split on the LAST dot", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-call (operator.add "ab" "cd"))')).toEqual(["abcd"]);
    expect(await runA(m, "!(py-call (sample.pkg.double 21))")).toEqual(["42"]);
  });

  it(".method head calls a method on a live handle", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-call (.get (py-call (sample.point 3 4)) "x"))')).toEqual(["3"]);
  });

  it(".method with a symbol target treats it as a module name (PeTTa Obj-as-module)", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (.double sample.pkg 21))")).toEqual(["42"]);
  });

  it("string head is coerced like a symbol head (PeTTa atom_string)", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-call ("str" 7))')).toEqual(["7"]);
  });

  it("quote-wrapped spec unwraps (the eval collision guard)", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-call (quote (eval "2 ** 10" 0 0)))')).toEqual(["1024"]);
  });

  it("a Python error becomes an (Error ...) atom, not a crash", async () => {
    const { m } = fresh();
    const r = await runA(m, "!(py-call (sample.boom))");
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Error");
    expect(r[0]).toContain("boom failed");
  });

  it("py-call reached in a sync run throws AsyncInSyncError", () => {
    const { m } = fresh();
    expect(() => m.run("!(py-call (str 5))")).toThrow(/async grounded operation/);
  });
});

describe("marshalling (janus parity table)", () => {
  it("True/False/None come back as (@ true)/(@ false)/(@ none)", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (bool 1))")).toEqual(["(@ true)"]);
    expect(await runA(m, "!(py-call (bool 0))")).toEqual(["(@ false)"]);
    expect(await runA(m, "!(py-call (sample.none))")).toEqual(["(@ none)"]);
  });

  it("@-terms round-trip back into Python as True/False/None", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (str (py-call (bool 1))))")).toEqual(["True"]);
    expect(await runA(m, "!(py-call (str (py-call (sample.none))))")).toEqual(["None"]);
  });

  it("Python lists deep-convert to expressions", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (quote (eval \"[1, 2.5, 'x', True, None]\" 0 0)))")).toEqual([
      "(1 2.5 x (@ true) (@ none))",
    ]);
  });

  it("MeTTa expressions convert to Python lists", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (len (1 2 3)))")).toEqual(["3"]);
  });

  it("non-primitive results stay opaque handles that round-trip", async () => {
    const { m } = fresh();
    const [dictPrint] = await runA(m, "!(py-call (dict))");
    expect(dictPrint).toBeDefined();
    expect(dictPrint).not.toContain("("); // opaque token, not a converted structure
    expect(await runA(m, '!(py-call (.get (py-call (sample.point 3 4)) "y"))')).toEqual(["4"]);
  });

  it("Python str results are Symbols (print bare); MeTTa Strings go in as str", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-call (str "abc"))')).toEqual(["abc"]);
  });
});

describe("PY_METTA_SRC helpers", () => {
  it("py-eval evaluates an expression string in fresh dicts", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-eval "2 ** 10")')).toEqual(["1024"]);
  });

  it("py-str folds a list into one string via str + operator.add", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-str (a b 1))")).toEqual(["ab1"]);
  });

  it("py-import makes a module available and returns unit", async () => {
    const { m, b } = fresh();
    expect(await runA(m, '!(py-import "./libx.py")')).toEqual(["()"]);
    expect(b.imported).toContain("libx");
  });
});

describe("py-atom family (Hyperon surface)", () => {
  it("py-atom resolves a callable into an applicable grounded atom", async () => {
    const { m } = fresh();
    expect(await runA(m, "!((py-atom sample.pkg.double) 21)")).toEqual(["42"]);
  });

  it("py-atom resolves a bare builtin (getattr fallback, no exec fallback)", async () => {
    const { m } = fresh();
    expect(await runA(m, "!((py-atom str) 5)")).toEqual(["5"]);
  });

  it("py-atom carries a declared type on the grounded atom", async () => {
    const { m } = fresh();
    const r = (await m.runAsync("!(py-atom sample.pkg.double (-> Number Number))"))[0]![0]!;
    expect(r).toBeInstanceOf(GroundedAtom);
    expect((r as GroundedAtom).groundedType().toString()).toBe("(-> Number Number)");
  });

  it("py-atom resolves a non-callable to its value", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-atom sample.answer)")).toEqual(["42"]);
  });

  it("py-atom on an unresolvable path errors", async () => {
    const { m } = fresh();
    const r = await runA(m, "!(py-atom nosuch.thing)");
    expect(r[0]).toContain("Error");
  });

  it("py-dot resolves an attribute relative to a live object", async () => {
    const { m } = fresh();
    expect(await runA(m, "!((py-dot (py-call (sample.point 3 4)) magnitude))")).toEqual(["5"]);
  });

  it("py-list / py-tuple build nested collections", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-call (len (py-list (1 (2 3) 4))))")).toEqual(["3"]);
    expect(await runA(m, "!(py-call (len (py-tuple (1 2))))")).toEqual(["2"]);
  });

  it("py-dict builds from pairs, symbol keys as strings", async () => {
    const { m } = fresh();
    expect(await runA(m, '!(py-call (.get (py-dict ((a 1) ("b" 2))) "a"))')).toEqual(["1"]);
  });

  it("py-chain folds the | operator", async () => {
    const { m } = fresh();
    expect(await runA(m, "!(py-chain (1 2 4))")).toEqual(["7"]);
  });

  it("an applied py-atom under the sync runner throws", async () => {
    const { m } = fresh();
    const opAtom = (await m.runAsync("!(py-atom sample.pkg.double)"))[0]![0]!;
    m.registerAtom("dbl", opAtom);
    expect(() => m.run("!(dbl 21)")).toThrow(/synchronous evaluation/);
  });
});

describe("marshalling properties", () => {
  const bridge = new MockPyBridge();

  const primitive: fc.Arbitrary<Atom> = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }).map((n) => ValueAtom(n) as Atom),
    fc.boolean().map((v) => E(S("@"), S(v ? "true" : "false")) as Atom),
    fc.constant(E(S("@"), S("none")) as Atom),
  );

  const { atom } = fc.letrec<{ atom: Atom; list: Atom }>((tie) => ({
    atom: fc.oneof({ maxDepth: 3, withCrossShrink: true }, primitive, tie("list")),
    list: fc.array(tie("atom"), { maxLength: 4 }).map((xs) => E(...xs) as Atom),
  }));

  it("primitive/list marshalling round-trips atom -> py -> atom", () => {
    fc.assert(
      fc.property(atom, (a) => {
        const round = pyToAtom(atomToPy(a, bridge), bridge);
        expect(round.toString()).toBe(a.toString());
      }),
      { numRuns: 300 },
    );
  });

  it("strings survive the boundary as their content (String in, Symbol out)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (s) => {
        const out = pyToAtom(atomToPy(ValueAtom(s), bridge), bridge);
        expect(out.toString()).toBe(S(s).toString());
      }),
      { numRuns: 200 },
    );
  });
});
