// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: compile a stored clause's templates (db.ts Slot and Ground) into JavaScript over cells for the cell machine,
// on the step model of wamc.ts (petta-wam 9934828). The head unifies with the argument registers, read mode against
// bound cells and write mode building for unbound ones, and returns the head-failure sign to the candidate loop on a
// clash. The body compiles to steps: tests, unification, arithmetic and calls, cut, and if-then-else, soft-cut,
// disjunction, negation, once/1, ignore/1 and forall/2 inline over in-clause choicepoints. The steps run in parts,
// functions whose switch resumes at any step a continuation, a choicepoint's alternative or the part before enters; a
// variable lives in a local unless a resume point lies between its definition and its last use, then in an environment
// slot. Ground compound literals are built anew at each use, as SWI does (a-hp-swi-gap); arithmetic runs arith.ts's
// functions and comparison on the operands' values.
// am[implements a-petta-cell-store.compile.steps]

import { appendFileSync } from "node:fs";
import { BINARY_FNS, UNARY_FNS, evalArith, numCompare, type Num } from "../arith";
import { Ground, Slot, type Clause } from "../db";
import { Cons, Float, NIL, Str, Struct, type Term } from "../terms";
import { ATM, ATV, BOX, HEAP_CELLS, INT, LIS, REF, STR, boxEq, type Heap } from "./heap";
import { ENV, HEADFAIL, K_ALT, type CellMachine, type ClauseFn } from "./machine";

/**
 * Generated characters in one part of a clause body: V8 leaves a function unoptimized past 61440 bytes of bytecode
 * (--max-optimized-bytecode-size), as wamc.ts found on translate_expr/4 (c-big-body-unoptimized).
 */
const PART_CHARS = 12000;
/**
 * A step allocates at most this many heap cells (a clause's literals and the variables it makes), so a step that starts
 * below HEAP_CELLS minus it cannot write past the heap; the check at the step's start makes a full heap a hard error.
 */
const STEP_CELLS = 1 << 20;
/** A file each compiled clause's source is appended to (PETTA_CELL_DUMP), for reading what was generated. */
const DUMP = process.env.PETTA_CELL_DUMP;
/** Goals that only test their arguments: they bind nothing and leave no choicepoint, so a condition of them needs none. */
const TESTS: Readonly<Record<string, string>> = {
  "var/1": "ISVAR",
  "nonvar/1": "!ISVAR",
  "atom/1": "ISATOM",
  "number/1": "ISNUM",
  "integer/1": "ISINT",
  "float/1": "ISFLOAT",
  "atomic/1": "ISATOMIC",
  "compound/1": "ISCOMPOUND",
  "callable/1": "ISCALLABLE",
  "is_list/1": "ISLIST",
  "ground/1": "GROUND",
  "==/2": "IDENT",
  "\\==/2": "!IDENT",
  "\\=/2": "NUNIFY",
};
const ARITH_TESTS = new Set(["=:=", "=\\=", "<", ">", "=<", ">="]);

/** The name and argument templates of a goal template; a ground holder's compound arguments stay holders. */
function view(t: Term): { name: string; args: Term[] } | null {
  if (t instanceof Ground) {
    const g = t.t;
    if (g instanceof Struct) return { name: g.name, args: g.args.map((a) => (a instanceof Struct || a instanceof Cons ? (new Ground(a) as unknown as Term) : a)) };
    if (typeof g === "string") return { name: g, args: [] };
    return null;
  }
  if (typeof t === "string") return { name: t, args: [] };
  if (t instanceof Struct) return { name: t.name, args: t.args };
  return null;
}

function isTest(t: Term): boolean {
  const g = view(t);
  if (g === null) return false;
  const key = g.name + "/" + g.args.length;
  if (key === "true/0" || key === "fail/0" || key === "false/0") return true;
  if (key === ",/2") return isTest(g.args[0]!) && isTest(g.args[1]!);
  return Object.hasOwn(TESTS, key) || (g.args.length === 2 && ARITH_TESTS.has(g.name));
}

/** The slot numbers in a template. */
function slotsOf(t: Term): number[] {
  const out: number[] = [];
  const st: Term[] = [t];
  while (st.length > 0) {
    const x = st.pop()!;
    if (x instanceof Slot) out.push(x.i);
    else if (x instanceof Ground) continue;
    else if (x instanceof Struct) st.push(...x.args);
    else if (x instanceof Cons) st.push(x.head, x.tail);
  }
  return out;
}

/** The cell of an atomic template. */
function atomicCell(hp: Heap, t: Term): number {
  if (typeof t === "string") return hp.atom(t);
  if (typeof t === "number" || typeof t === "bigint") return hp.int(t);
  if (t === NIL) return hp.NIL;
  if (t instanceof Float || t instanceof Str) return hp.box(t);
  throw new Error(`cell compiler: no cell for ${String(t)}`);
}

/** Cell helpers generated code calls, made once per machine. */
interface Runtime {
  readonly E: (c: number) => Num;
  readonly NUM: (v: Num) => number;
  readonly CMP: (op: string, x: Num, y: Num) => boolean;
  readonly [test: string]: unknown;
}
const runtimes = new WeakMap<CellMachine, Runtime>();
function runtime(cm: CellMachine): Runtime {
  let rt = runtimes.get(cm);
  if (rt !== undefined) return rt;
  const hp = cm.hp;
  const isVar = (c: number): boolean => {
    const t = hp.deref(c) & 7;
    return t === REF || t === ATV;
  };
  const isInt = (c0: number): boolean => {
    const c = hp.deref(c0);
    if ((c & 7) === INT) return true;
    if ((c & 7) !== BOX) return false;
    const v = hp.boxes[c >> 3];
    return typeof v === "number" || typeof v === "bigint";
  };
  const isFloat = (c0: number): boolean => {
    const c = hp.deref(c0);
    return (c & 7) === BOX && hp.boxes[c >> 3] instanceof Float;
  };
  const isCompound = (c: number): boolean => {
    const t = hp.deref(c) & 7;
    return t === STR || t === LIS;
  };
  // Identity (==/2): equal cells, or compounds of one functor whose arguments are identical; boxes by content.
  // Time: the cells visited.
  const ident = (x0: number, y0: number): boolean => {
    const st = [x0, y0];
    while (st.length > 0) {
      const y = hp.deref(st.pop()!), x = hp.deref(st.pop()!);
      if (x === y) continue;
      const tx = x & 7;
      if (tx !== (y & 7)) return false;
      if (tx === STR) {
        const px = x >> 3, py = y >> 3, f = hp.h[px]!;
        if (f !== hp.h[py]) return false;
        for (let i = hp.funArity[f >> 3]!; i >= 1; i--) st.push(hp.h[px + i]!, hp.h[py + i]!);
      } else if (tx === LIS) {
        st.push(hp.h[(x >> 3) + 1]!, hp.h[(y >> 3) + 1]!, hp.h[x >> 3]!, hp.h[y >> 3]!);
      } else if (tx !== BOX || !boxEq(hp.boxes[x >> 3], hp.boxes[y >> 3])) return false;
    }
    return true;
  };
  rt = {
    // A number cell's value; anything else is evaluated by arith.ts on its object term, errors included.
    E: (c0: number): Num => {
      const c = hp.deref(c0);
      const tag = c & 7;
      if (tag === INT) return c >> 3;
      if (tag === BOX) {
        const v = hp.boxes[c >> 3];
        if (typeof v === "number" || typeof v === "bigint" || v instanceof Float) return v;
      }
      return evalArith(hp.decode(c, new Map()));
    },
    NUM: (v: Num): number => (v instanceof Float ? hp.box(v) : hp.int(v)),
    CMP: numCompare,
    ISVAR: isVar,
    ISATOM: (c: number): boolean => {
      const d = hp.deref(c);
      return (d & 7) === ATM && d !== hp.NIL;
    },
    ISNUM: (c: number): boolean => isInt(c) || isFloat(c),
    ISINT: isInt,
    ISFLOAT: isFloat,
    ISATOMIC: (c: number): boolean => !isVar(c) && !isCompound(c),
    ISCOMPOUND: isCompound,
    ISCALLABLE: (c: number): boolean => {
      const d = hp.deref(c);
      return ((d & 7) === ATM && d !== hp.NIL) || isCompound(d);
    },
    ISLIST: (c0: number): boolean => {
      let c = hp.deref(c0);
      while ((c & 7) === LIS) c = hp.deref(hp.h[(c >> 3) + 1]!);
      return c === hp.NIL;
    },
    GROUND: (c0: number): boolean => {
      const st = [c0];
      while (st.length > 0) {
        const c = hp.deref(st.pop()!);
        const t = c & 7;
        if (t === REF || t === ATV) return false;
        if (t === STR) for (let i = hp.funArity[hp.h[c >> 3]! >> 3]!; i >= 1; i--) st.push(hp.h[(c >> 3) + i]!);
        else if (t === LIS) st.push(hp.h[c >> 3]!, hp.h[(c >> 3) + 1]!);
      }
      return true;
    },
    IDENT: ident,
    // \=/2: whether the two do not unify; the trial binds with every binding trailed and undoes them all.
    NUNIFY: (x: number, y: number): boolean => {
      const hb = hp.hb, mark = hp.tr, w = hp.wakeups.length;
      hp.hb = HEAP_CELLS;
      const ok = hp.unify(x, y);
      hp.undo(mark);
      hp.hb = hb;
      hp.wakeups.length = w;
      return !ok;
    },
    OVF: (): never => {
      throw new Error("cell heap exhausted");
    },
    WAKE: (): never => {
      throw new Error("cell engine: attribute wakeups are not built yet");
    },
  };
  runtimes.set(cm, rt);
  return rt;
}
const RT_NAMES = ["E", "NUM", "CMP", "ISVAR", "ISATOM", "ISNUM", "ISINT", "ISFLOAT", "ISATOMIC", "ISCOMPOUND", "ISCALLABLE", "ISLIST", "GROUND", "IDENT", "NUNIFY", "OVF", "WAKE"];

/** Statements building terms at the local heap top `t`, and whether there are any. */
class Build {
  readonly lines: string[] = [];
  heap = false;
}

type Label = { pc: number };
type Step =
  | { k: "test"; b: Build; js: string; else: Label | null }
  | { k: "exec"; b: Build; x: string; y: string }
  | { k: "set"; slot: number; b: Build; js: string }
  | { k: "call"; proc: string; b: Build; args: string[] }
  | { k: "cut"; cb: string }
  | { k: "jump"; to: Label }
  | { k: "cp"; h: number; alt: Label }
  | { k: "mark"; h: number }
  | { k: "cutto"; h: number }
  | { k: "commit"; h: number }
  | { k: "softcut"; h: number }
  | { k: "nafail"; h: number }
  | { k: "succeed" }
  | { k: "fail" };

/** The placeholder of slot i's value in step code, replaced once the slot's home (local or environment) is known. */
const ref = (i: number): string => `\u0001${i}\u0002`;

class BodyCompiler {
  readonly steps: Step[] = [];
  readonly consts: unknown[] = [];
  /** Slots: the clause's variables, then hidden slots for choicepoint indexes. */
  nslots: number;
  /** The goals that assign their output slot directly, with the slot (freshOutputs). */
  fresh = new Map<Term, number>();
  /** Step indexes where each slot is mentioned, for the locals' liveness. */
  readonly uses = new Map<number, number[]>();
  /** The step at which a slot is first set, for fresh outputs and hidden slots. */
  readonly setAt = new Map<number, number>();
  private names = 0;

  constructor(
    private readonly cm: CellMachine,
    readonly nvars: number,
    private readonly singleton: (i: number) => boolean,
  ) {
    this.nslots = nvars;
  }

  hidden(): number {
    return this.nslots++;
  }
  label(): Label {
    return { pc: -1 };
  }
  place(l: Label): void {
    l.pc = this.steps.length;
  }
  k(x: unknown): string {
    this.consts.push(x);
    return `K[${this.consts.length - 1}]`;
  }
  private useSlot(i: number): void {
    let u = this.uses.get(i);
    if (u === undefined) this.uses.set(i, (u = []));
    u.push(this.steps.length);
  }
  private push(s: Step, ...mentions: Term[]): void {
    for (const t of mentions) for (const i of slotsOf(t)) this.useSlot(i);
    this.steps.push(s);
  }
  /** A step reading or setting hidden slot h. */
  private pushHidden(s: Step, h: number, sets = false): void {
    if (sets) this.setAt.set(h, this.steps.length);
    this.useSlot(h);
    this.steps.push(s);
  }

  /** The cell of template `t` as a JS expression, its compound parts built fresh at the heap top `t` by `b`'s lines. */
  cell(t0: Term, b: Build): string {
    const t = t0 instanceof Ground ? t0.t : t0;
    if (t instanceof Slot) {
      if (this.singleton(t.i)) {
        b.heap = true;
        return "(H[t] = t << 3, t++ << 3)";
      }
      return ref(t.i);
    }
    const hp = this.cm.hp;
    if (t instanceof Cons) {
      b.heap = true;
      const q = `q${this.names++}`;
      b.lines.push(`const ${q} = t; t += 2;`);
      const h = this.cell(t.head, b);
      b.lines.push(`H[${q}] = ${h};`);
      const tl = this.cell(t.tail, b);
      b.lines.push(`H[${q} + 1] = ${tl};`);
      return `((${q} << 3) | ${LIS})`;
    }
    if (t instanceof Struct && t.args.length > 0) {
      b.heap = true;
      const q = `q${this.names++}`;
      const n = t.args.length;
      b.lines.push(`const ${q} = t; t += ${n + 1}; H[${q}] = ${hp.functor(t.name, n)};`);
      t.args.forEach((a, i) => {
        const v = this.cell(a, b);
        b.lines.push(`H[${q} + ${i + 1}] = ${v};`);
      });
      return `((${q} << 3) | ${STR})`;
    }
    return String(atomicCell(hp, t));
  }

  /** An arithmetic expression's value, evaluated in evalArith's order with its functions; the rest through E. */
  expr(t0: Term, b: Build): string {
    const t = t0 instanceof Ground ? t0.t : t0;
    if (t instanceof Slot) return `E(${this.cell(t, b)})`;
    if (typeof t === "number") return Object.is(t, -0) ? "-0" : String(t);
    if (typeof t === "bigint") return `${t}n`;
    if (t instanceof Float) return this.k(t);
    if (t instanceof Struct) {
      if (t.args.length === 1 && Object.hasOwn(UNARY_FNS, t.name)) return `${this.k(UNARY_FNS[t.name])}(${this.expr(t.args[0]!, b)})`;
      if (t.args.length === 2 && Object.hasOwn(BINARY_FNS, t.name))
        return `${this.k(BINARY_FNS[t.name])}(${this.expr(t.args[0]!, b)}, ${this.expr(t.args[1]!, b)})`;
    }
    return `E(${this.cell(t0, b)})`;
  }

  /** The boolean expression of a test goal (isTest), its terms built by `b`. */
  private testJS(t: Term, b: Build): string {
    const g = view(t)!;
    const key = g.name + "/" + g.args.length;
    if (key === "true/0") return "true";
    if (key === "fail/0" || key === "false/0") return "false";
    if (g.args.length === 2 && ARITH_TESTS.has(g.name)) return `CMP(${JSON.stringify(g.name)}, ${this.expr(g.args[0]!, b)}, ${this.expr(g.args[1]!, b)})`;
    return `${TESTS[key]}(${g.args.map((a) => this.cell(a, b)).join(", ")})`;
  }

  /** Tests in sequence, each going to `orElse` (or failing when null) when it does not hold. */
  private tests(t: Term, orElse: Label | null): void {
    const g = view(t)!;
    if (g.name === "," && g.args.length === 2) {
      this.tests(g.args[0]!, orElse);
      this.tests(g.args[1]!, orElse);
      return;
    }
    if (g.name === "true" && g.args.length === 0) return;
    const b = new Build();
    this.push({ k: "test", b, js: this.testJS(t, b), else: orElse }, t);
  }

  /** Compile goal `t` at this point of the body; `cb` is the JS expression of the choicepoint index its cut returns to. */
  goal(t: Term, cb: string): void {
    const g = view(t);
    if (g === null) throw new Error(`cell compiler: a goal that is not callable: ${String(t)}`);
    const { name, args } = g;
    const key = name + "/" + args.length;
    switch (key) {
      case "true/0":
        return;
      case "fail/0":
      case "false/0":
        this.push({ k: "fail" });
        return;
      case "!/0":
        if (cb !== "b0") this.useSlot(Number(cb.slice(1, -1)));
        this.push({ k: "cut", cb });
        return;
      case ",/2":
        this.goal(args[0]!, cb);
        this.goal(args[1]!, cb);
        return;
      case ";/2":
        this.disjunction(args[0]!, args[1]!, cb);
        return;
      case "->/2": {
        // (C -> T) alone: C's cut is local to it, C's choicepoints go at the commit, and a failing C fails the whole.
        const h = this.hidden();
        this.pushHidden({ k: "mark", h }, h, true);
        this.goal(args[0]!, ref(h));
        this.pushHidden({ k: "cutto", h }, h);
        this.goal(args[1]!, cb);
        return;
      }
      case "*->/2": {
        const h = this.hidden();
        this.pushHidden({ k: "mark", h }, h, true);
        this.goal(args[0]!, ref(h));
        this.goal(args[1]!, cb);
        return;
      }
      case "\\+/1":
        this.negation(args[0]!);
        return;
      case "once/1": {
        const h = this.hidden();
        this.pushHidden({ k: "mark", h }, h, true);
        this.goal(args[0]!, ref(h));
        this.pushHidden({ k: "cutto", h }, h);
        return;
      }
      case "ignore/1": {
        const h = this.hidden();
        const after = this.label();
        this.pushHidden({ k: "cp", h, alt: after }, h, true);
        this.goal(args[0]!, ref(h));
        this.pushHidden({ k: "commit", h }, h);
        this.place(after);
        return;
      }
      case "forall/2":
        // forall(C, A) is \+ (C, \+ A), as the interpreter rewrites it.
        this.negation(new Struct(",", [args[0]!, new Struct("\\+", [args[1]!])]));
        return;
      case "is/2": {
        const b = new Build();
        const s = this.fresh.get(t);
        if (s !== undefined) {
          this.setAt.set(s, this.steps.length);
          this.push({ k: "set", slot: s, b, js: `NUM(${this.expr(args[1]!, b)})` }, args[0]!, args[1]!);
        } else {
          const x = this.cell(args[0]!, b);
          this.push({ k: "exec", b, x, y: `NUM(${this.expr(args[1]!, b)})` }, args[0]!, args[1]!);
        }
        return;
      }
      case "=/2": {
        const b = new Build();
        const s = this.fresh.get(t);
        if (s !== undefined) {
          const other = args[0] instanceof Slot && args[0].i === s ? args[1]! : args[0]!;
          this.setAt.set(s, this.steps.length);
          this.push({ k: "set", slot: s, b, js: this.cell(other, b) }, args[0]!, args[1]!);
        } else {
          const x = this.cell(args[0]!, b);
          this.push({ k: "exec", b, x, y: this.cell(args[1]!, b) }, args[0]!, args[1]!);
        }
        return;
      }
    }
    if (isTest(t)) {
      this.tests(t, null);
      return;
    }
    const b = new Build();
    const cells = args.map((a) => this.cell(a, b));
    this.push({ k: "call", proc: this.k(this.cm.proc(name, args.length)), b, args: cells }, ...args);
  }

  /** (L ; R), with L an if-then-else or soft-cut condition or a plain branch. */
  private disjunction(left: Term, right: Term, cb: string): void {
    const l = view(left);
    const join = this.label();
    const orElse = this.label();
    if (l !== null && l.args.length === 2 && (l.name === "->" || l.name === "*->")) {
      const [c, then] = l.args as [Term, Term];
      if (l.name === "->" && isTest(c)) {
        this.tests(c, orElse);
      } else {
        const h = this.hidden();
        this.pushHidden({ k: "cp", h, alt: orElse }, h, true);
        this.goal(c, ref(h));
        this.pushHidden(l.name === "->" ? { k: "commit", h } : { k: "softcut", h }, h);
      }
      this.goal(then, cb);
    } else {
      this.push({ k: "cp", h: -1, alt: orElse });
      this.goal(left, cb);
    }
    this.push({ k: "jump", to: join });
    this.place(orElse);
    this.goal(right, cb);
    this.place(join);
  }

  /** \+ G: fails when G succeeds once; a pure test needs no choicepoint. */
  private negation(g: Term): void {
    const after = this.label();
    if (isTest(g)) {
      this.tests(g, after);
      this.push({ k: "fail" });
      this.place(after);
      return;
    }
    const h = this.hidden();
    this.pushHidden({ k: "cp", h, alt: after }, h, true);
    this.goal(g, ref(h));
    this.pushHidden({ k: "nafail", h }, h);
    this.place(after);
  }

  /** The step a continuation after step `pc` resumes at, following jumps; -1 when only `succeed` follows. */
  cont(pc: number): number {
    let t = pc;
    for (let n = 0; n <= this.steps.length; n++) {
      const s = this.steps[t]!;
      if (s.k === "jump") t = s.to.pc;
      else return s.k === "succeed" ? -1 : t;
    }
    return t;
  }
}

/**
 * Head unification as straight-line code over the argument registers: a slot's first occurrence takes the argument
 * as it is, a later one unifies; a constant is compared as a cell; a compound template matches a bound argument of
 * its shape argument by argument (read mode) or is built and bound to an unbound one (write mode). Every clash
 * returns the head-failure sign.
 */
class HeadCompiler {
  readonly lines: string[] = [];
  readonly set = new Set<number>();
  private names = 0;
  constructor(private readonly hp: Heap) {}

  arg(t: Term, src: string): void {
    this.lines.push(this.get(t, src));
  }

  /** Write mode: build template t at the heap top and give the cell pointing at it. */
  private build(t0: Term): [string, string] {
    const t = t0 instanceof Ground ? t0.t : t0;
    const q = `h${this.names++}`;
    if (t instanceof Cons) return [`const ${q} = t; t += 2; ${this.store(t.head, q)}${this.store(t.tail, `${q} + 1`)}`, `((${q} << 3) | ${LIS})`];
    const s = t as Struct;
    const n = s.args.length;
    let code = `const ${q} = t; t += ${n + 1}; H[${q}] = ${this.hp.functor(s.name, n)}; `;
    s.args.forEach((a, i) => {
      code += this.store(a, `${q} + ${i + 1}`);
    });
    return [code, `((${q} << 3) | ${STR})`];
  }
  private store(a0: Term, addr: string): string {
    const a = a0 instanceof Ground ? a0.t : a0;
    if (a instanceof Slot) {
      if (!this.set.has(a.i)) {
        this.set.add(a.i);
        return `H[${addr}] = (${addr}) << 3; v${a.i} = (${addr}) << 3; `;
      }
      return `H[${addr}] = v${a.i}; `;
    }
    if (!(a instanceof Cons || (a instanceof Struct && a.args.length > 0))) return `H[${addr}] = ${atomicCell(this.hp, a)}; `;
    const [code, cell] = this.build(a);
    return `${code}H[${addr}] = ${cell}; `;
  }
  private get(t0: Term, src: string): string {
    const t = t0 instanceof Ground ? t0.t : t0;
    if (t instanceof Slot) {
      if (!this.set.has(t.i)) {
        this.set.add(t.i);
        return `v${t.i} = ${src}; `;
      }
      return `if (!hp.unify(v${t.i}, ${src})) return HF; `;
    }
    const d = `d${this.names++}`;
    if (!(t instanceof Cons || (t instanceof Struct && t.args.length > 0))) {
      const C = atomicCell(this.hp, t);
      // A box (float, string, bigint) equals another by content, so a bound cell is compared through unification.
      if ((C & 7) === BOX)
        return `{ const ${d} = hp.deref(${src}); if ((${d} & 7) === 0) hp.bind(${d} >> 3, ${C}); else if (${d} !== ${C} && !hp.unify(${d}, ${C})) return HF; } `;
      // An atom or a small integer is one canonical cell (Heap.atom, Heap.int), so any other bound cell clashes; an
      // attributed variable takes it through unification, which records its wakeup.
      return `{ const ${d} = hp.deref(${src}); if (${d} !== ${C}) { if ((${d} & 7) === 0) hp.bind(${d} >> 3, ${C}); else if ((${d} & 7) !== ${ATV} || !hp.unify(${d}, ${C})) return HF; } } `;
    }
    const p = `p${this.names++}`;
    const before = new Set(this.set);
    let read: string;
    if (t instanceof Cons) read = `const ${p} = ${d} >> 3; ${this.get(t.head, `H[${p}]`)}${this.get(t.tail, `H[${p} + 1]`)}`;
    else {
      const s = t as Struct;
      read = `const ${p} = ${d} >> 3; if (H[${p}] !== ${this.hp.functor(s.name, s.args.length)}) return HF; `;
      s.args.forEach((a, i) => {
        read += this.get(a, `H[${p} + ${i + 1}]`);
      });
    }
    // Write mode starts from the slots set before this argument and sets the same ones read mode does.
    const after = new Set(this.set);
    for (const i of after) if (!before.has(i)) this.set.delete(i);
    const [code, cell] = this.build(t);
    for (const i of after) this.set.add(i);
    // An unbound attributed variable takes the built term through unification, which records its wakeup.
    return `{ const ${d} = hp.deref(${src}); if ((${d} & 7) === 0) { ${code}hp.bind(${d} >> 3, ${cell}); } else if ((${d} & 7) === ${t instanceof Cons ? LIS : STR}) { ${read}} else if ((${d} & 7) === ${ATV}) { ${code}hp.top = t; if (!hp.unify(${d}, ${cell})) return HF; } else return HF; } `;
  }
}

/**
 * The goals of the body's top conjunction whose first occurrence of a variable is the output of is/2 or =/2, with
 * that variable's slot: the step assigns it directly instead of making a variable and unifying it (wamc.ts).
 * `seen` holds the head's slots. Time: linear in the body.
 */
function freshOutputs(body: Term, seen: Set<number>): Map<Term, number> {
  const out = new Map<Term, number>();
  const fresh = (x: Term, other: Term): boolean => x instanceof Slot && !seen.has(x.i) && !slotsOf(other).includes(x.i);
  const walk = (g: Term): void => {
    const v = view(g);
    if (v !== null && v.name === "," && v.args.length === 2) {
      walk(v.args[0]!);
      walk(v.args[1]!);
      return;
    }
    if (v !== null && v.args.length === 2 && (v.name === "is" || v.name === "=")) {
      const [l, r] = v.args as [Term, Term];
      if (fresh(l, r) && !(v.name === "=" && fresh(r, l))) out.set(g, (l as unknown as Slot).i);
      else if (v.name === "=" && fresh(r, l) && !fresh(l, r)) out.set(g, (r as unknown as Slot).i);
    }
    for (const i of slotsOf(g)) seen.add(i);
  };
  walk(body);
  return out;
}

/**
 * Compile clause `c` for `cm`: the function `(b0, cc, pc)` runs from the head when pc is 0, and from step pc of its
 * body when a continuation or choicepoint resumes it, its environment current. Time: linear in the clause, plus V8
 * compiling the source on its first run.
 */
export function compileCellClause(cm: CellMachine, c: Clause): ClauseFn {
  const hp = cm.hp;
  const count = new Array<number>(c.nvars).fill(0);
  for (const i of [...slotsOf(c.head), ...slotsOf(c.body)]) count[i]!++;
  const singleton = (i: number): boolean => i < c.nvars && count[i] === 1;
  const bc = new BodyCompiler(cm, c.nvars, singleton);
  const hc = new HeadCompiler(hp);
  if (c.head instanceof Struct) c.head.args.forEach((t, i) => hc.arg(t, `A[${i}]`));
  const fact = c.body === "true";
  // Body steps start at 1; pc 0 is the head.
  bc.steps.push({ k: "fail" });
  if (!fact) {
    bc.fresh = freshOutputs(c.body, new Set(hc.set));
    bc.goal(c.body, "b0");
  }
  bc.steps.push({ k: "succeed" });
  const steps = bc.steps;
  const n = steps.length;
  const assigned = new Set(bc.fresh.values());
  // Every body variable exists before the body runs, so its bindings are trailed against the body's own choicepoints
  // and a resumed branch never meets a cell freed by a failed one; a fresh output is assigned by its goal instead,
  // and a variable occurring once is made where it occurs.
  const made: number[] = [];
  if (!fact) for (let k = 0; k < c.nvars; k++) if (!hc.set.has(k) && !assigned.has(k) && !singleton(k)) made.push(k);

  // Parts: runs of consecutive steps of at most PART_CHARS of code (estimated from the step's own size).
  const partOf = new Array<number>(n).fill(0);
  {
    let part = 0;
    let used = 0;
    for (let pc = 1; pc < n; pc++) {
      const est = JSON.stringify(steps[pc]).length + 40;
      if (used > 0 && used + est > PART_CHARS) {
        part++;
        used = 0;
      }
      partOf[pc] = part;
      used += est;
    }
  }
  // Resume points: where a continuation, a choicepoint's alternative or another part enters the body.
  const resume = new Set<number>();
  for (let pc = 1; pc < n; pc++) {
    const s = steps[pc]!;
    if (s.k === "call") {
      const t = bc.cont(pc + 1);
      if (t >= 0) resume.add(t);
    } else if (s.k === "cp") resume.add(s.alt.pc);
    if (pc > 1 && partOf[pc] !== partOf[pc - 1]) resume.add(pc);
  }
  // A slot is a local when no resume point lies after its definition and at or before its last use.
  const lastUse = new Array<number>(bc.nslots).fill(-1);
  for (const [i, u] of bc.uses) for (const p of u) if (p > lastUse[i]!) lastUse[i] = p;
  const defAt = (i: number): number => bc.setAt.get(i) ?? 0;
  const resumeList = [...resume].sort((a, b) => a - b);
  const perm = new Set<number>();
  for (let i = 0; i < bc.nslots; i++) if (resumeList.some((r) => r > defAt(i) && r <= lastUse[i]!)) perm.add(i);
  const env = resume.size > 0;
  const nslots = bc.nslots;
  const vx = (i: number): string => (perm.has(i) ? `S[e + ${ENV + i}]` : `v${i}`);
  const sub = (js: string): string => js.replace(/\u0001(\d+)\u0002/g, (_, i) => vx(Number(i)));
  const ids = new Map<number, number>();
  const idOf = (pc: number): number => {
    let id = ids.get(pc);
    if (id === undefined) {
      id = cm.CODE.push(null as never) - 1;
      ids.set(pc, id);
    }
    return id;
  };
  const leave = env ? "R[1] = S[e + 1]; R[0] = S[e];" : "";
  const goto = (t: number, k: number): string => (partOf[t] === k ? `pc = ${t}; continue;` : `return P[${partOf[t]}](0, 0, ${t});`);
  /** A step's terms built at the local heap top, then `body` with the values computed before the top is written back. */
  const withHeap = (b: Build, values: string, body: string): string =>
    b.heap
      ? `{ let t = hp.top; if (t > ${HEAP_CELLS - STEP_CELLS}) OVF(); ${sub(b.lines.join(" "))} ${sub(values)} hp.top = t; ${body} }`
      : `{ ${sub(values)} ${body} }`;
  const stepCode = (s: Step, pc: number, k: number): string => {
    switch (s.k) {
      case "test":
        return withHeap(s.b, `const ok = ${s.js};`, `if (!ok) { ${s.else === null ? "return cm.fail();" : goto(s.else.pc, k)} }`);
      case "exec":
        return withHeap(s.b, `const x = ${s.x}, y = ${s.y};`, "if (!hp.unify(x, y)) return cm.fail(); if (hp.wakeups.length !== 0) WAKE();");
      case "set":
        return withHeap(s.b, `const x = ${s.js};`, `${vx(s.slot)} = x;`);
      case "call": {
        const t = bc.cont(pc + 1);
        const values = s.args.length > 0 ? `const ${s.args.map((a, i) => `a${i} = ${a}`).join(", ")};` : "";
        const regs = s.args.map((_, i) => `A[${i}] = a${i};`).join(" ");
        return withHeap(s.b, values, `${regs} ${t < 0 ? leave : `R[1] = ${idOf(t)};`} return cm.callLater(${s.proc}, ${s.args.length}, cc);`);
      }
      case "cut":
        return `cm.cutTo(${sub(s.cb)});`;
      case "jump":
        return goto(s.to.pc, k);
      case "cp":
        return `{ const b = cm.pushCP(${K_ALT}, 0, cc, 0); S[b + 8] = ${idOf(s.alt.pc)}; ${s.h >= 0 ? `${vx(s.h)} = b;` : ""} }`;
      case "mark":
        return `${vx(s.h)} = R[2];`;
      case "cutto":
        return `cm.cutTo(${vx(s.h)});`;
      case "commit":
        return `cm.cutTo(S[${vx(s.h)}]);`;
      case "softcut":
        return `S[${vx(s.h)} + 8] = ${cm.FAILC};`;
      case "nafail":
        return `cm.cutTo(S[${vx(s.h)}]); return cm.fail();`;
      case "succeed":
        return `${leave} return CODE[R[1]];`;
      case "fail":
        return "return cm.fail();";
    }
  };
  const nparts = partOf[n - 1]! + 1;
  const declare = nslots > 0 ? `let ${Array.from({ length: nslots }, (_, i) => `v${i}`).join(", ")};` : "";
  // Every step's code first: generating it registers the resume points the parts' entries list.
  const code: string[] = [];
  for (let pc = 1; pc < n; pc++) code[pc] = stepCode(steps[pc]!, pc, partOf[pc]!);
  const parts: string[] = [];
  for (let k = 0; k < nparts; k++) {
    const out: string[] = [`(function part${k}(b0, cc, pc) {`, "const H = hp.h;", "let e = -1;", declare];
    if (k === 0) {
      out.push("if (pc === 0) {", `{ let t = hp.top; ${hc.lines.join("")} hp.top = t; }`, "if (hp.wakeups.length !== 0) WAKE();");
      if (made.length > 0) out.push(`{ let t = hp.top; ${made.map((i) => `v${i} = (H[t] = t << 3, t++ << 3);`).join(" ")} hp.top = t; }`);
      if (env) out.push(`e = cm.allocate(${nslots}, b0, cc);`, ...[...perm].filter((i) => i < c.nvars && (hc.set.has(i) || made.includes(i))).map((i) => `S[e + ${ENV + i}] = v${i};`));
      out.push("pc = 1;", "} else {", "e = R[0]; b0 = S[e + 2]; cc = S[e + 4];", "}");
    } else out.push("e = R[0]; b0 = S[e + 2]; cc = S[e + 4];");
    out.push("for (;;) {", "switch (pc) {");
    let last = 0;
    for (let pc = 1; pc < n; pc++)
      if (partOf[pc] === k) {
        out.push(`case ${pc}:`, code[pc]!);
        last = pc;
      }
    out.push("}");
    // Falling past this part's last step goes on at the next part's first.
    if (last + 1 < n) out.push(`return P[${k + 1}](0, 0, ${last + 1});`);
    out.push("}", "})");
    parts.push(out.join("\n"));
  }
  if (DUMP !== undefined) appendFileSync(DUMP, `// ${c.pred.name}/${c.pred.arity} clause ${c.seq}\n${parts.join(",\n")}\n\n`);
  const rt = runtime(cm);
  const P: ClauseFn[] = [];
  const factory = new Function("cm", "hp", "A", "S", "R", "CODE", "K", "HF", "P", ...RT_NAMES, `return [${parts.join(",\n")}];`) as (
    ...a: unknown[]
  ) => ClauseFn[];
  P.push(...factory(cm, hp, cm.A, cm.S, cm.R, cm.CODE, bc.consts, HEADFAIL, P, ...RT_NAMES.map((k) => rt[k])));
  for (const [pc, id] of ids) {
    const f = P[partOf[pc]!]!;
    cm.CODE[id] = () => f(0, 0, pc);
  }
  return P[0]!;
}
