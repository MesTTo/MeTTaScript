// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: differential property test of the native term builtins on cells (builtins.ts), and of the text builtins
// through the bridge (bridge.ts), against the object machine's builtins: random arguments over shared and attributed variables, small and big integers, floats with -0.0 and NaN,
// strings, atoms with '[]' and [], compounds, proper and partial lists and pairs, each call run on both engines, its
// answers compared in order with the arguments' bindings and, when it throws, the error term. A call the cell engine
// can only answer with a generator it does not have yet is skipped.
// am[verifies a-petta-cell-store.builtins.terms]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { installBuiltins } from "../builtins";
import { installConsult } from "../consult";
import { installLibrary } from "../library";
import { Machine } from "../machine";
import { Cons, Float, NIL, PrologError, Str, Struct, Var, deref, mkVar, type Term } from "../terms";
import { installTermBuiltins } from "./builtins";
import { compileCellClause, installInlineBuiltins } from "./compile";
import { CellMachine } from "./machine";

/** A canonical text of terms, variables numbered by first occurrence, attributes shown. */
function canon(ts: Term[]): string {
  const names = new Map<Var, number>();
  // A cyclic term with sharing, X = g(X, X), doubles at every level: a node budget keeps the text finite, the same
  // prefix on both engines.
  let budget = 2000;
  const one = (t0: Term, depth: number): string => {
    if (depth > 30 || --budget < 0) return "…";
    const t = deref(t0);
    if (t instanceof Var) {
      let n = names.get(t);
      if (n === undefined) names.set(t, (n = names.size));
      return `_${n}${t.attrs !== null && t.attrs.size > 0 ? `{${[...t.attrs.keys()].join(",")}}` : ""}`;
    }
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "number") return `i${t}`;
    if (typeof t === "bigint") return `b${t}`;
    if (t instanceof Float) return `f${Object.is(t.v, -0) ? "-0" : t.v}`;
    if (t instanceof Str) return `s${JSON.stringify(t.s)}`;
    if (t === NIL) return "[]";
    if (t instanceof Cons) return `[${one(t.head, depth + 1)}|${one(t.tail, depth + 1)}]`;
    if (t instanceof Struct) return `${JSON.stringify(t.name)}(${t.args.map((a) => one(a, depth + 1)).join(",")})`;
    return String(t);
  };
  return ts.map((t) => one(t, 0)).join(", ");
}

type Outcome = { answers: string[]; error: string | null };

function run(solve: (each: () => boolean) => void, show: () => string): Outcome {
  const answers: string[] = [];
  try {
    solve(() => {
      answers.push(show());
      return answers.length < 20;
    });
    return { answers, error: null };
  } catch (e) {
    if (e instanceof PrologError) return { answers, error: canon([e.ball]) };
    // A JS error the object builtin raises itself (atom_length/2 of a code beyond Unicode raises RangeError) must
    // be raised alike; one the cell engine raises for what it lacks is no outcome.
    if (e instanceof Error && !/not built yet/.test(e.message)) return { answers, error: `js ${e.name}` };
    throw e;
  }
}

/** An object machine as PeTTa sets one up. */
function objectMachine(): Machine {
  const m = new Machine();
  installBuiltins(m);
  installLibrary(m);
  installConsult(m);
  return m;
}
/**
 * The machines every case runs on, made once: a cell machine holds a gigabyte of typed arrays, so one per case
 * exhausts the JS heap. Calls leave nothing behind: solveAll undoes every binding and the heap top is reset after.
 */
let shared: { m: Machine; cm: CellMachine } | null = null;
function machines(): { m: Machine; cm: CellMachine } {
  if (shared === null) {
    const m = objectMachine();
    const cm = new CellMachine(objectMachine());
    cm.compile = compileCellClause;
    installInlineBuiltins(cm);
    installTermBuiltins(cm);
    shared = { m, cm };
  }
  return shared;
}

/** Run name(args) on the object machine and on the cell machine over the same variables. */
function both(name: string, args: Term[], pool: Var[]): { want: Outcome; got: Outcome | null } {
  const { m, cm } = machines();
  const want = run((each) => m.solveAll(new Struct(name, args), each), () => canon(args));
  const hp = cm.hp;
  const top = hp.top;
  const vars = new Map<Var, number>();
  // The pool's cells first, in the order its variables were made, so a cell's age is its variable's.
  for (const v of pool) hp.encode(v, vars);
  const cells = args.map((a) => hp.encode(a, vars));
  cells.forEach((c, i) => (cm.A[i] = c));
  try {
    const got = run(
      (each) => cm.solveAll(cm.proc(name, args.length), args.length, each),
      () => {
        const back = new Map<number, Var>();
        return canon(cells.map((c) => hp.decode(c, back)));
      },
    );
    return { want, got };
  } catch (e) {
    // A mode only a generator answers waits for the nondeterministic bridge.
    if (e instanceof Error && /not built yet/.test(e.message)) return { want, got: null };
    throw e;
  } finally {
    hp.top = top;
  }
}

/** Random arguments over a pool of four variables, the last attributed. */
function pool(): Var[] {
  const vs = [mkVar(), mkVar(), mkVar(), mkVar()];
  vs[3]!.attrs = new Map([["m", "x"]]);
  return vs;
}
function atomic(): fc.Arbitrary<Term> {
  return fc.oneof(
    fc.constantFrom<Term>("a", "b", "foo", "[]", NIL, "-", "<", "@<", "@>=", "[|]"),
    fc.integer({ min: -3, max: 3 }),
    fc.constantFrom<Term>(2 ** 40, 2n ** 70n, -(2n ** 70n), new Float(1), new Float(1.5), new Float(-0), new Float(0), new Float(NaN), new Str("s"), new Str("")),
  );
}
function term(vs: Var[], depth: number): fc.Arbitrary<Term> {
  // An empty pool gives ground terms.
  const leaf = vs.length === 0 ? atomic() : fc.oneof({ weight: 3, arbitrary: atomic() }, { weight: 2, arbitrary: fc.constantFrom<Term>(...vs) });
  if (depth <= 0) return leaf;
  const sub = term(vs, depth - 1);
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    { weight: 1, arbitrary: sub.map((x) => new Struct("f", [x]) as Term) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([x, y]) => new Struct("g", [x, y]) as Term) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([x, y]) => new Struct("-", [x, y]) as Term) },
    { weight: 2, arbitrary: list(sub, vs) },
  );
}
/** A proper list, a partial one ending in a pool variable, or one ending in an atom. */
function list(el: fc.Arbitrary<Term>, vs: Var[]): fc.Arbitrary<Term> {
  return fc
    .tuple(fc.array(el, { maxLength: 4 }), fc.oneof({ weight: 4, arbitrary: fc.constant<Term>(NIL) }, { weight: 1, arbitrary: fc.constantFrom<Term>(...vs, "z") }))
    .map(([items, tail]) => items.reduceRight<Term>((t, x) => new Cons(x, t), tail));
}

/** One builtin's argument generators, over a fresh pool each run. */
const CASES: [string, (vs: Var[]) => fc.Arbitrary<Term>[]][] = [
  ["compare", (vs) => [fc.oneof(fc.constantFrom<Term>(...vs), fc.constantFrom<Term>("<", "=", ">", "x")), term(vs, 2), term(vs, 2)]],
  ["@<", (vs) => [term(vs, 2), term(vs, 2)]],
  ["@>=", (vs) => [term(vs, 2), term(vs, 2)]],
  ["==", (vs) => [term(vs, 2), term(vs, 2)]],
  ["\\==", (vs) => [term(vs, 2), term(vs, 2)]],
  ["=@=", (vs) => [term(vs, 2), term(vs, 2)]],
  ["subsumes_term", (vs) => [term(vs, 2), term(vs, 2)]],
  // An arity of 2^40 would have the object builtin make that many variables, so arities stay small.
  ["functor", (vs) => [term(vs, 1), fc.oneof(fc.constantFrom<Term>(...vs), atomic()), fc.oneof(fc.constantFrom<Term>(...vs), fc.integer({ min: -1, max: 3 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>("a", NIL, new Float(1), new Str("s")))]],
  ["arg", (vs) => [fc.oneof(fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs), atomic()), term(vs, 2), term(vs, 1)]],
  ["=..", (vs) => [term(vs, 2), fc.oneof(term(vs, 1), list(term(vs, 1), vs))]],
  ["copy_term", (vs) => [term(vs, 2), term(vs, 1)]],
  ["cyclic_term", (vs) => [term(vs, 2)]],
  ["term_variables", (vs) => [term(vs, 2), term(vs, 1)]],
  // A partial list with a length that is no integer has the object builtin enumerate lengths forever, so lengths
  // are integers or variables.
  // length(L, L) has the object builtin enumerate forever too, so a variable length is a fresh one.
  ["length", (vs) => [fc.oneof(list(term(vs, 1), vs), term(vs, 1)), fc.oneof(fc.integer({ min: -1, max: 5 }) as fc.Arbitrary<Term>, fc.constant(null).map(() => mkVar() as Term))]],
  ["msort", (vs) => [fc.oneof(list(term(vs, 1), vs), term(vs, 1)), term(vs, 1)]],
  ["sort", (vs) => [fc.oneof(list(term(vs, 1), vs), term(vs, 1)), term(vs, 1)]],
  ["keysort", (vs) => [fc.oneof(list(term(vs, 1), vs), list(fc.tuple(term(vs, 1), term(vs, 1)).map(([k, v]) => new Struct("-", [k, v]) as Term), vs)), term(vs, 1)]],
  // Text builtins run through the bridge (bridge.ts): their results must come back as the object builtin gives them.
  ["atom_length", (vs) => [fc.oneof(text(vs), term(vs, 1)), fc.oneof(fc.integer({ min: -1, max: 4 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs), atomic())]],
  ["atom_chars", (vs) => [fc.oneof(text(vs), fc.constantFrom<Term>(...vs)), fc.oneof(chars(vs), fc.constantFrom<Term>(...vs))]],
  ["atom_codes", (vs) => [fc.oneof(text(vs), fc.constantFrom<Term>(...vs)), fc.oneof(codes(vs), fc.constantFrom<Term>(...vs))]],
  ["char_code", (vs) => [fc.oneof(fc.constantFrom<Term>("a", "é", "ab"), fc.constantFrom<Term>(...vs)), fc.oneof(fc.integer({ min: 96, max: 99 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs))]],
  ["atom_number", (vs) => [fc.oneof(fc.constantFrom<Term>("12", "1.5", "x", "0x1f", "-3"), fc.constantFrom<Term>(...vs)), fc.oneof(fc.integer({ min: -3, max: 12 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs))]],
  ["number_codes", (vs) => [fc.oneof(fc.integer({ min: -3, max: 30 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs)), fc.oneof(codes(vs), fc.constantFrom<Term>(...vs))]],
  // Deterministic modes: the first two arguments bound (splitting an atom needs the generator).
  ["atom_concat", (vs) => [text(vs), text(vs), fc.oneof(text(vs), fc.constantFrom<Term>(...vs))]],
  ["atom_string", (vs) => [fc.oneof(text(vs), fc.constantFrom<Term>(...vs)), fc.oneof(text(vs), fc.constantFrom<Term>(...vs))]],
  ["string_concat", (vs) => [text(vs), text(vs), fc.oneof(text(vs), fc.constantFrom<Term>(...vs))]],
  ["string_chars", (vs) => [fc.oneof(text(vs), fc.constantFrom<Term>(...vs)), fc.oneof(chars(vs), fc.constantFrom<Term>(...vs))]],
  ["string_codes", (vs) => [fc.oneof(text(vs), fc.constantFrom<Term>(...vs)), fc.oneof(codes(vs), fc.constantFrom<Term>(...vs))]],
  ["upcase_atom", (vs) => [fc.oneof(text(vs), fc.constantFrom<Term>(...vs)), fc.oneof(text(vs), fc.constantFrom<Term>(...vs))]],
  // Deterministic modes: the start and the length given.
  ["sub_atom", (vs) => [text(vs), fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term>, fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term>, fc.oneof(fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs)), fc.oneof(text(vs), fc.constantFrom<Term>(...vs))]],
  // A written unbound variable is named by its engine's numbering, so a written term is ground.
  ["term_to_atom", (vs) => [fc.oneof(term([], 2), fc.constantFrom<Term>(...vs)), fc.oneof(fc.constantFrom<Term>("f(X, Y, X)", "[1, 2 | T]", "'a b'", "g(", "\"s\""), fc.constantFrom<Term>(...vs))]],
];

/** Text arguments: atoms with letters, digits, spaces and accents, strings, numbers. */
function text(_vs: Var[]): fc.Arbitrary<Term> {
  return fc.oneof(fc.constantFrom<Term>("", "a", "ab", "abc", "a b", "é", "12", "x1", "[]", NIL), fc.constantFrom<Term>(new Str(""), new Str("ab"), new Str("é z")), fc.integer({ min: -3, max: 30 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(new Float(1.5)));
}
/** Character and code lists, some partial or with a wrong element. */
function chars(vs: Var[]): fc.Arbitrary<Term> {
  return list(fc.oneof(fc.constantFrom<Term>("a", "b", "é", " ", "1"), fc.constantFrom<Term>(...vs), fc.constantFrom<Term>("ab", 3)), vs);
}
function codes(vs: Var[]): fc.Arbitrary<Term> {
  return list(fc.oneof(fc.integer({ min: 48, max: 122 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs), fc.constantFrom<Term>("a", -1)), vs);
}

describe("native term builtins on cells", () => {
  for (const [name, gen] of CASES)
    it(`${name} answers and throws as the object builtin`, () => {
      fc.assert(
        fc.property(fc.constant(null).chain(() => {
          const vs = pool();
          return fc.tuple(fc.constant(vs), fc.tuple(...gen(vs)));
        }), ([vs, args]) => {
          const { want, got } = both(name, args, vs);
          fc.pre(got !== null);
          expect(got).toStrictEqual(want);
        }),
        { numRuns: 300 },
      );
    });

  it("sort/4 answers and throws as the object builtin", () => {
    fc.assert(
      fc.property(fc.constant(null).chain(() => {
        const vs = pool();
        const pairs = list(fc.tuple(term(vs, 1), term(vs, 1)).map(([k, v]) => new Struct("g", [k, v]) as Term), vs);
        return fc.tuple(fc.constant(vs), fc.tuple(
          fc.oneof(fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term>, fc.constantFrom<Term>(...vs)),
          fc.oneof(fc.constantFrom<Term>("@<", "@>", "@=<", "@>=", "x"), fc.constantFrom<Term>(...vs)),
          fc.oneof(pairs, term(vs, 1)),
          term(vs, 1),
        ));
      }), ([vs, args]) => {
        const { want, got } = both("sort", args, vs);
        fc.pre(got !== null);
        expect(got).toStrictEqual(want);
      }),
      { numRuns: 300 },
    );
  });

  it("cyclic_term/1 tells a cyclic term from an acyclic one sharing subterms", () => {
    const x = mkVar();
    const cyclic = (t: Term): Term => new Struct(",", [new Struct("=", [x, t]), new Struct("cyclic_term", [x])]);
    const { m, cm } = machines();
    for (const [goal, expected] of [[cyclic(new Struct("f", [x])), 1], [cyclic(new Struct("f", ["a"])), 0]] as const) {
      let n = 0;
      m.solveAll(goal, () => void n++);
      expect(n).toBe(expected);
      const hp = cm.hp;
      const vars = new Map<Var, number>();
      cm.A[0] = hp.encode((goal as Struct).args[0]!, vars);
      cm.A[1] = hp.encode((goal as Struct).args[1]!, vars);
      let k = 0;
      cm.solveAll(cm.proc(",", 2), 2, () => void k++);
      expect(k).toBe(expected);
    }
  });
});
