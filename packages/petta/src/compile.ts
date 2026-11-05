// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: compile a stored clause's body into a JavaScript function the machine runs in place of interpreting its
// goal terms. The body becomes a flat run of steps in a loop-switch, so a run can resume at any step: control
// constructs become jumps and the same choicepoints the interpreter pushes, tests and arithmetic run inline, every
// other goal goes through the machine's call path (Machine.callCell or callN), and the constructs the interpreter
// keeps (catch/3, call/1, the cleanup forms, halt, a variable goal) run as interpreted frames over the same
// variables. A step that binds returns to the machine before the next goal when it woke an attribute hook, so
// hooks run where they do under the interpreter. Choicepoints stay exactly where the interpreter leaves them:
// an if-then-else or negation whose condition is a pure test pushes none, and the interpreter's own pushes one
// and removes it before anything can observe it.
// am[implements a-petta-speed-1105.goal]

import { BINARY_FNS, UNARY_FNS, numCompare } from "./arith";
import { Ground, Slot, type Clause } from "./db";
import { Cons, Float, NIL, PrologError, Struct, Var, deref, instantiationError, mkVar, type Term } from "./terms";
import type { Frame, Machine } from "./machine";

/** A compiled body and the step to run it from; a frame whose goal is a Resume runs that body from that step. */
export class Resume {
  constructor(
    public fn: BodyFn,
    public readonly pc: number,
  ) {}
}

/** Runs a body from step `pc` with `f` as its activation (f.vars, f.next, f.cb, f.cc); false means failure. */
export type BodyFn = (m: Machine, f: Frame, pc: number) => boolean;

/**
 * Unifies a clause head's arguments with a call's, filling the activation's variable slots, as Machine.unifyHead does;
 * once they unify, it also makes the fresh variables of the body's slots, so the activation is ready to run.
 */
export type HeadFn = (m: Machine, args: Term[], v: (Term | undefined)[]) => boolean;

/**
 * A clause's compiled code: its head unification, where its body starts (null for a fact), and how many variable
 * slots an activation needs (clause variables, then cut heights).
 */
export interface Code {
  readonly head: HeadFn;
  readonly entry: Resume | null;
  readonly nslots: number;
}

/** What a body step does. Steps run in order; `test` and `jump` go to a label, every other step to the next one. */
type Label = { pc: number };
type Step =
  | { k: "test"; js: string; else: Label | null }
  | { k: "exec"; js: string }
  | { k: "set"; slot: number; js: string }
  | { k: "call"; cell: string; args: string }
  | { k: "calln"; goal: string; args: string }
  | { k: "fallback"; tpl: string; cb: string }
  | { k: "cut"; cb: string }
  | { k: "jump"; to: Label }
  | { k: "cp"; kind: "Alt" | "Soft" | "Not"; h: number; alt: Label }
  | { k: "mark"; h: number }
  | { k: "cutto"; h: number }
  | { k: "softcut"; h: number }
  | { k: "nafail"; h: number }
  | { k: "findall"; h: number; template: string; list: string; after: Label }
  | { k: "collect"; h: number }
  | { k: "throw"; js: string }
  | { k: "succeed" }
  | { k: "fail" };

/**
 * Goals that only test their arguments: they bind nothing, push no goal and leave no choicepoint, so an
 * if-then-else or negation over them needs no choicepoint. All are protected builtins (machine.ts PROTECTED), which
 * no clause can redefine, so the builtin found at compile time stays the one called.
 */
const TESTS = new Set([
  "==/2", "\\==/2", "@</2", "@>/2", "@=</2", "@>=/2", "var/1", "nonvar/1", "atom/1", "number/1", "integer/1",
  "float/1", "atomic/1", "compound/1", "callable/1", "is_list/1", "string/1", "ground/1", "\\=/2",
]);
const ARITH_TESTS = new Set(["=:=", "=\\=", "<", ">", "=<", ">="]);
/** Compound nodes of an argument built by generated constructor code; larger arguments go through inst or copyLiteral. */
const BUILD_NODES = 24;
/**
 * Generated characters in one part of a clause body. V8 leaves a function in its baseline tier when its bytecode
 * exceeds 61440 bytes (--max-optimized-bytecode-size), as translate_expr/4's 1309-line body did
 * (c-big-body-unoptimized); a part this size compiles to a fraction of that.
 * am[implements a-petta-speed-1105.goal.body-chunks]
 */
const PART_CHARS = 12000;

/** Compound nodes of a stored ground term, counted up to BUILD_NODES + 1. */
function size(t: Term): number {
  let n = 0;
  const st: Term[] = [t];
  while (st.length > 0 && n <= BUILD_NODES) {
    const x = st.pop()!;
    if (x instanceof Struct) {
      n++;
      st.push(...x.args);
    } else if (x instanceof Cons) {
      n++;
      st.push(x.head, x.tail);
    }
  }
  return n;
}
/** Constructs the interpreter runs (Machine.step's own cases that this compiler does not lower). */
const INTERPRETED = new Set([
  "halt/0", "halt/1", "call/1", "call_cleanup/2", "setup_call_cleanup/3", "catch/3",
  "$cut/1", "$softcut/1", "$nafail/1", "$scc_exit/1", "$fa_collect/1", "$catch_exit/1",
]);

/** The name and argument templates of a goal template; a ground holder's compound arguments stay holders, so each run copies them. */
function view(t: Term): { name: string; args: Term[] } | null {
  if (t instanceof Ground) {
    const g = t.t;
    if (g instanceof Struct) return { name: g.name, args: g.args.map((a) => (a instanceof Struct || a instanceof Cons ? (new Ground(a) as unknown as Term) : a)) };
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
  return TESTS.has(key) || (g.args.length === 2 && ARITH_TESTS.has(g.name));
}

class BodyCompiler {
  readonly steps: Step[] = [];
  readonly consts: unknown[] = [];
  nslots: number;
  /** The goals that assign their output slot directly, with the slot (freshOutputs). */
  fresh = new Map<Term, number>();

  constructor(
    private readonly m: Machine,
    nvars: number,
  ) {
    this.nslots = nvars;
  }

  private hidden(): number {
    return this.nslots++;
  }
  private label(): Label {
    return { pc: -1 };
  }
  private place(l: Label): void {
    l.pc = this.steps.length;
  }
  private k(x: unknown): string {
    this.consts.push(x);
    return `K[${this.consts.length - 1}]`;
  }

  /** A constant generated code reads, for the head compiler. */
  konst(x: unknown): string {
    return this.k(x);
  }

  /**
   * A call argument from its template: what Machine.inst gives for it (a ground part copied, as copyLiteral does),
   * as constructor code for the first BUILD_NODES compound nodes and through inst or copyLiteral beyond them.
   */
  arg(t: Term): string {
    const budget = { n: BUILD_NODES };
    return this.build(t, budget);
  }

  private build(t: Term, budget: { n: number }): string {
    if (t instanceof Slot) return `v[${t.i}]`;
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "number") return Object.is(t, -0) ? "-0" : String(t);
    if (typeof t === "bigint") return `${t}n`;
    if (t === NIL) return "NIL";
    if (t instanceof Ground) return budget.n >= size(t.t) ? this.build(t.t, budget) : `C(${this.k(t.t)})`;
    if (t instanceof Cons || t instanceof Struct) {
      if (--budget.n < 0) return `m.inst(${this.k(t)}, v)`;
      if (t instanceof Cons) return `new L(${this.build(t.head, budget)}, ${this.build(t.tail, budget)})`;
      return `new S(${JSON.stringify(t.name)}, [${t.args.map((a) => this.build(a, budget)).join(", ")}])`;
    }
    return this.k(t);
  }

  private args(ts: Term[]): string {
    return ts.length === 0 ? "EMPTY" : `[${ts.map((a) => this.arg(a)).join(", ")}]`;
  }

  /** An arithmetic expression's value, evaluated in evalArith's order with its functions; anything else through evalArith itself. */
  expr(t: Term): string {
    if (t instanceof Slot) return `E(v[${t.i}])`;
    if (typeof t === "number") return Object.is(t, -0) ? "-0" : String(t);
    if (typeof t === "bigint") return `${t}n`;
    if (t instanceof Float) return this.k(t);
    if (t instanceof Struct) {
      if (t.args.length === 1 && Object.hasOwn(UNARY_FNS, t.name)) return `${this.k(UNARY_FNS[t.name])}(${this.expr(t.args[0]!)})`;
      if (t.args.length === 2 && Object.hasOwn(BINARY_FNS, t.name))
        return `${this.k(BINARY_FNS[t.name])}(${this.expr(t.args[0]!)}, ${this.expr(t.args[1]!)})`;
    }
    if (t instanceof Ground) return `E(${this.k(t.t)})`;
    return `E(${this.arg(t)})`;
  }

  /** The boolean expression of a test goal (isTest). */
  private testJS(t: Term): string {
    const g = view(t)!;
    if (g.name === "true" && g.args.length === 0) return "true";
    if ((g.name === "fail" || g.name === "false") && g.args.length === 0) return "false";
    if (g.args.length === 2 && ARITH_TESTS.has(g.name)) return `cmp(${JSON.stringify(g.name)}, ${this.expr(g.args[0]!)}, ${this.expr(g.args[1]!)})`;
    const b = this.m.builtins.get(g.name + "/" + g.args.length)!;
    return `${this.k(b.det)}(m, ${this.args(g.args)})`;
  }

  /** Emit tests in sequence, each going to `orElse` (or failing when null) when it does not hold. */
  private tests(t: Term, orElse: Label | null): void {
    const g = view(t)!;
    if (g.name === "," && g.args.length === 2) {
      this.tests(g.args[0]!, orElse);
      this.tests(g.args[1]!, orElse);
      return;
    }
    if (g.name === "true" && g.args.length === 0) return;
    this.steps.push({ k: "test", js: this.testJS(t), else: orElse });
  }

  /** Compile goal `t` at this point of the body; `cb` is the JS expression of the choicepoint height its cut returns to. */
  goal(t: Term, cb: string): void {
    const g = view(t);
    if (g === null) {
      this.steps.push({ k: "fallback", tpl: this.k(t), cb });
      return;
    }
    const { name, args } = g;
    const key = name + "/" + args.length;
    switch (key) {
      case "true/0":
        return;
      case "fail/0":
      case "false/0":
        this.steps.push({ k: "fail" });
        return;
      case "!/0":
        this.steps.push({ k: "cut", cb });
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
        this.steps.push({ k: "mark", h });
        this.goal(args[0]!, `v[${h}]`);
        this.steps.push({ k: "cutto", h });
        this.goal(args[1]!, cb);
        return;
      }
      case "*->/2": {
        const h = this.hidden();
        this.steps.push({ k: "mark", h });
        this.goal(args[0]!, `v[${h}]`);
        this.goal(args[1]!, cb);
        return;
      }
      case "\\+/1":
        this.negation(args[0]!);
        return;
      case "once/1": {
        const h = this.hidden();
        this.steps.push({ k: "mark", h });
        this.goal(args[0]!, `v[${h}]`);
        this.steps.push({ k: "cutto", h });
        return;
      }
      case "ignore/1": {
        const h = this.hidden();
        const after = this.label();
        this.steps.push({ k: "cp", kind: "Alt", h, alt: after });
        this.goal(args[0]!, `(v[${h}] + 1)`);
        this.steps.push({ k: "cutto", h });
        this.place(after);
        return;
      }
      case "forall/2":
        // forall(C, A) is \+ (C, \+ A), as the interpreter rewrites it.
        this.negation(new Struct(",", [args[0]!, new Struct("\\+", [args[1]!])]));
        return;
      case "findall/3": {
        // A findall choicepoint collects each solution of the goal (cut local to it), as the interpreter's does; its
        // continuation is the step after the findall.
        const h = this.hidden();
        const after = this.label();
        this.steps.push({ k: "findall", h, template: this.arg(args[0]!), list: this.arg(args[2]!), after });
        this.goal(args[1]!, `(v[${h}] + 1)`);
        this.steps.push({ k: "collect", h });
        this.place(after);
        return;
      }
      case "throw/1":
        this.steps.push({ k: "throw", js: this.arg(args[0]!) });
        return;
      case "is/2":
        if (this.fresh.has(t)) this.steps.push({ k: "set", slot: this.fresh.get(t)!, js: this.expr(args[1]!) });
        else this.steps.push({ k: "exec", js: `m.unify(${this.arg(args[0]!)}, ${this.expr(args[1]!)})` });
        return;
      case "=/2": {
        const s = this.fresh.get(t);
        if (s !== undefined) {
          const other = args[0] instanceof Slot && args[0].i === s ? args[1]! : args[0]!;
          this.steps.push({ k: "set", slot: s, js: this.arg(other) });
        } else this.steps.push({ k: "exec", js: `m.unify(${this.arg(args[0]!)}, ${this.arg(args[1]!)})` });
        return;
      }
    }
    if (name === "call" && args.length > 1) {
      this.steps.push({ k: "calln", goal: this.arg(args[0]!), args: this.args(args.slice(1)) });
      return;
    }
    if (INTERPRETED.has(key)) {
      this.steps.push({ k: "fallback", tpl: this.k(t), cb });
      return;
    }
    if (isTest(t)) {
      this.steps.push({ k: "test", js: this.testJS(t), else: null });
      return;
    }
    this.steps.push({ k: "call", cell: this.k(this.m.procCell(name, args.length)), args: this.args(args) });
  }

  /** (L ; R), with L an if-then-else or soft-cut condition or a plain branch, as Machine.disjunction runs it. */
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
        this.steps.push({ k: "cp", kind: l.name === "->" ? "Alt" : "Soft", h, alt: orElse });
        this.goal(c, `(v[${h}] + 1)`);
        this.steps.push({ k: l.name === "->" ? "cutto" : "softcut", h });
      }
      this.goal(then, cb);
    } else {
      this.steps.push({ k: "cp", kind: "Alt", h: -1, alt: orElse });
      this.goal(left, cb);
    }
    this.steps.push({ k: "jump", to: join });
    this.place(orElse);
    this.goal(right, cb);
    this.place(join);
  }

  /** \+ G: fails when G succeeds once; a pure test needs no choicepoint. */
  private negation(g: Term): void {
    const after = this.label();
    if (isTest(g)) {
      this.tests(g, after);
      this.steps.push({ k: "fail" });
      this.place(after);
      return;
    }
    const h = this.hidden();
    this.steps.push({ k: "cp", kind: "Not", h, alt: after });
    this.goal(g, `(v[${h}] + 1)`);
    this.steps.push({ k: "nafail", h });
    this.place(after);
  }

  /** The resume point after step `pc`: null when only `succeed` follows, so the continuation is the activation's own. */
  private cont(pc: number): string {
    let t = pc;
    for (let n = 0; n <= this.steps.length; n++) {
      const s = this.steps[t]!;
      if (s.k === "jump") t = s.to.pc;
      else return s.k === "succeed" ? "null" : `RS[${t}]`;
    }
    return `RS[${t}]`;
  }

  /**
   * The body as functions `(m, f, pc)`, each a loop-switch over a run of consecutive steps of at most PART_CHARS of
   * code, and the part holding each step. Control within a body only moves forward (every label is placed after the
   * step that targets it) and backtracking resumes through RS, so control reaching a step of a later part calls that
   * part, `B[k]`, which nests at most one call per part. Time: linear in the steps.
   * am[implements a-petta-speed-1105.goal.body-chunks]
   */
  sources(): { parts: string[]; partOf: number[] } {
    this.steps.push({ k: "succeed" });
    const n = this.steps.length;
    const partOf: number[] = new Array<number>(n).fill(0);
    // Sizes as if every target were local, which differs from the final code by a few characters a jump.
    let part = 0;
    let used = 0;
    for (let pc = 0; pc < n; pc++) {
      const size = this.stepLines(this.steps[pc]!, pc, partOf, -1).join("\n").length + 12;
      if (used > 0 && used + size > PART_CHARS) {
        part++;
        used = 0;
      }
      partOf[pc] = part;
      used += size;
    }
    const parts: string[] = [];
    for (let k = 0; k <= part; k++) {
      const out: string[] = ["const v = f.vars;", "for (;;) {", "switch (pc) {"];
      let last = -1;
      for (let pc = 0; pc < n; pc++)
        if (partOf[pc] === k) {
          out.push(`case ${pc}:`, ...this.stepLines(this.steps[pc]!, pc, partOf, k));
          last = pc;
        }
      out.push("}");
      // Falling past this part's last step goes on at the next part's first.
      if (last + 1 < n) out.push(`return B[${k + 1}](m, f, ${last + 1});`);
      out.push("}");
      parts.push(out.join("\n"));
    }
    return { parts, partOf };
  }

  /** Go to step `t` from part `k`: a jump within the part, a call of the part holding `t` otherwise (k < 0: local). */
  private goto(t: number, partOf: number[], k: number): string {
    return k < 0 || partOf[t] === k ? `pc = ${t}; continue;` : `return B[${partOf[t]}](m, f, ${t});`;
  }

  /** The code of step `s` at `pc` in part `k` (k < 0 while sizing). */
  private stepLines(s: Step, pc: number, partOf: number[], k: number): string[] {
    const out: string[] = [];
    {
      switch (s.k) {
        case "test":
          out.push(`if (!(${s.js})) ${s.else === null ? "return false;" : `{ ${this.goto(s.else.pc, partOf, k)} }`}`);
          break;
        case "exec":
          out.push(`if (!(${s.js})) return false;`, `if (m.wakeups.length !== 0) return m.suspend(f, ${this.cont(pc + 1)});`);
          break;
        case "set":
          out.push(`v[${s.slot}] = ${s.js};`);
          break;
        case "call":
          out.push(`{ const r = m.callCell(${s.cell}, ${s.args}, f, ${this.cont(pc + 1)}); if (r !== 1) return r === 2; }`);
          break;
        case "calln":
          out.push(`{ const r = m.callN(${s.goal}, ${s.args}, f, ${this.cont(pc + 1)}); if (r !== 1) return r === 2; }`);
          break;
        case "fallback": {
          const c = this.cont(pc + 1);
          out.push(`m.goals = new Frame(${s.tpl}, ${c === "null" ? "f.next" : `new Frame(${c}, f.next, f.cb, f.cc, v)`}, ${s.cb}, f.cc, v);`, "return true;");
          break;
        }
        case "cut":
          out.push(`m.cutTo(${s.cb});`);
          break;
        case "jump":
          out.push(this.goto(s.to.pc, partOf, k));
          break;
        case "cp":
          out.push(`${s.h >= 0 ? `v[${s.h}] = ` : ""}m.pushResumeCP(${JSON.stringify(s.kind)}, ${this.cont(s.alt.pc)}, f);`);
          break;
        case "mark":
          out.push(`v[${s.h}] = m.cpHeight();`);
          break;
        case "cutto":
          out.push(`m.cutTo(v[${s.h}]);`);
          break;
        case "softcut":
          out.push(`m.softCut(v[${s.h}]);`);
          break;
        case "nafail":
          out.push(`m.cutTo(v[${s.h}]);`, "return false;");
          break;
        case "findall":
          out.push(`v[${s.h}] = m.pushFindall(${s.template}, ${s.list}, ${this.cont(s.after.pc)}, f);`);
          break;
        case "collect":
          out.push(`m.faCollect(v[${s.h}]);`, "return false;");
          break;
        case "throw":
          out.push(`throwBall(${s.js});`);
          break;
        case "succeed":
          out.push("return true;");
          break;
        case "fail":
          out.push("return false;");
          break;
      }
    }
    return out;
  }
}

/** throw/1 as Machine.step runs it: an unbound ball is an instantiation error, the ball is copied. */
function throwBall(ball: Term, copy: (t: Term) => Term): never {
  const b = deref(ball);
  if (b instanceof Var) throw instantiationError();
  throw new PrologError(copy(b));
}

/** What generated bodies reach by name. */
export interface Runtime {
  readonly Frame: typeof Frame;
  readonly E: (t: Term) => unknown;
  readonly C: (t: Term) => Term;
  readonly copy: (t: Term) => Term;
  readonly atomicEq: (x: Term, y: Term) => boolean;
}

/**
 * Head unification as straight-line code over the head template, mirroring Machine.unifyHead case for case: a
 * slot's first occurrence takes the call's argument as it is, a later one unifies; a ground literal goes through
 * unifyLiteral (which copies on binding); any other term binds a call variable to the template built with fresh
 * variables for slots not yet set (with bind, as unifyHead does), or matches a call term of its shape argument by
 * argument. Compound templates beyond BUILD_NODES nodes go through unifyHead itself.
 *
 * The head starts with a check that binds nothing: each argument after the first one whose template builds a term of
 * three or more compound nodes for a call variable is compared with the call's argument for a clash of functor, arity
 * or constant, so a candidate that fails on a later argument is rejected before that term is built. A failed head leaves nothing observable
 * (c-head-failure-invisible), and a call's arguments only gain structure while the head unifies, so the check
 * rejects exactly heads that would fail anyway.
 * am[implements a-petta-speed-1105.goal.head-precheck]
 */
class HeadCompiler {
  readonly lines: string[] = [];
  /** The binding-free check run before the arguments (precheck). */
  readonly pre: string[] = [];
  readonly set = new Set<number>();
  private temps = 0;
  constructor(private readonly body: BodyCompiler) {}

  /** Code unifying template `t` with the JS expression `a` (not yet dereferenced). */
  arg(t: Term, a: string): void {
    if (t instanceof Slot) {
      if (this.set.has(t.i)) this.lines.push(`if (!m.unify(v[${t.i}], ${a})) return false;`);
      else {
        this.lines.push(`v[${t.i}] = ${a};`);
        this.set.add(t.i);
      }
      return;
    }
    if (t instanceof Ground) {
      if (size(t.t) > BUILD_NODES) this.lines.push(`if (!m.unifyLiteral(${this.body.konst(t.t)}, ${a})) return false;`);
      else this.literal(t.t, a);
      return;
    }
    const d = `d${this.temps++}`;
    if (typeof t === "string" || typeof t === "number") {
      const lit = typeof t === "string" ? JSON.stringify(t) : Object.is(t, -0) ? "-0" : String(t);
      this.lines.push(`{ const ${d} = deref(${a}); if (${d} instanceof Var) m.bind(${d}, ${lit}); else if (${d} !== ${lit}) return false; }`);
      return;
    }
    if (!(t instanceof Struct || t instanceof Cons) || size(t) > BUILD_NODES) {
      // Other atomic terms (bigints, floats, strings, []) and large compounds: the generic code.
      const slots = slotsOf(t);
      this.lines.push(`if (!m.unifyHeadArg(${this.body.konst(t)}, ${a}, v)) return false;`);
      for (const i of slots) this.set.add(i);
      return;
    }
    // Bind a call variable to the instantiated template, or match a call term of the template's shape.
    const before = new Set(this.set);
    const built = this.build(t, before);
    this.lines.push(`{ const ${d} = deref(${a});`, `if (${d} instanceof Var) m.bind(${d}, ${built});`);
    if (t instanceof Cons) this.lines.push(`else if (${d} instanceof L) {`);
    else this.lines.push(`else if (${d} instanceof S && ${d}.name === ${JSON.stringify(t.name)} && ${d}.args.length === ${t.args.length}) {`);
    if (t instanceof Cons) {
      this.arg(t.head, `${d}.head`);
      this.arg(t.tail, `${d}.tail`);
    } else t.args.forEach((x, i) => this.arg(x, `${d}.args[${i}]`));
    this.lines.push("} else return false; }");
    // Both branches leave every slot of the template set.
    for (const i of slotsOf(t)) this.set.add(i);
  }

  /** The head function's statements: the check, then the arguments. */
  source(): string {
    return [...this.pre, ...this.lines].join("\n");
  }

  /**
   * Check code returning false when call argument `a` is bound to a term that cannot match template `t`: a clash of
   * functor, arity or constant, looked for through at most `budget.n` compound nodes, binding nothing.
   */
  precheck(t: Term, a: string, budget: { n: number }): void {
    if (t instanceof Slot) return;
    if (t instanceof Ground) {
      this.precheck(t.t, a, budget);
      return;
    }
    const d = `d${this.temps++}`;
    if (typeof t === "string" || typeof t === "number") {
      const lit = typeof t === "string" ? JSON.stringify(t) : Object.is(t, -0) ? "-0" : String(t);
      this.pre.push(`{ const ${d} = deref(${a}); if (!(${d} instanceof Var) && ${d} !== ${lit}) return false; }`);
      return;
    }
    if (t === NIL) {
      this.pre.push(`{ const ${d} = deref(${a}); if (!(${d} instanceof Var) && ${d} !== NIL) return false; }`);
      return;
    }
    if (t instanceof Struct || t instanceof Cons) {
      if (--budget.n < 0) return;
      const shape = t instanceof Cons ? `${d} instanceof L` : `${d} instanceof S && ${d}.name === ${JSON.stringify(t.name)} && ${d}.args.length === ${t.args.length}`;
      this.pre.push(`{ const ${d} = deref(${a}); if (!(${d} instanceof Var)) { if (!(${shape})) return false;`);
      if (t instanceof Cons) {
        this.precheck(t.head, `${d}.head`, budget);
        this.precheck(t.tail, `${d}.tail`, budget);
      } else t.args.forEach((x, i) => this.precheck(x, `${d}.args[${i}]`, budget));
      this.pre.push("} }");
      return;
    }
    this.pre.push(`{ const ${d} = deref(${a}); if (!(${d} instanceof Var) && !atomicEq(${this.body.konst(t)}, ${d})) return false; }`);
  }

  /**
   * Code unifying the stored ground literal `t` with `a`, as Machine.unifyLiteral does: a call variable is bound
   * (waking attribute hooks) to a fresh copy of the literal's part, a call term of the literal's shape is matched
   * argument by argument, atomic parts compare as atomicEq.
   */
  private literal(t: Term, a: string): void {
    const d = `d${this.temps++}`;
    const copy = this.copy(t);
    this.lines.push(`{ const ${d} = deref(${a});`, `if (${d} instanceof Var) m.bindVar(${d}, ${copy});`);
    if (typeof t === "string" || typeof t === "number") {
      const lit = typeof t === "string" ? JSON.stringify(t) : Object.is(t, -0) ? "-0" : String(t);
      this.lines.push(`else if (${d} !== ${lit}) return false; }`);
      return;
    }
    if (t instanceof Cons) {
      this.lines.push(`else if (${d} instanceof L) {`);
      this.literal(t.head, `${d}.head`);
      this.literal(t.tail, `${d}.tail`);
      this.lines.push("} else return false; }");
      return;
    }
    if (t instanceof Struct) {
      this.lines.push(`else if (${d} instanceof S && ${d}.name === ${JSON.stringify(t.name)} && ${d}.args.length === ${t.args.length}) {`);
      t.args.forEach((x, i) => this.literal(x, `${d}.args[${i}]`));
      this.lines.push("} else return false; }");
      return;
    }
    this.lines.push(`else if (!atomicEq(${this.body.konst(t)}, ${d})) return false; }`);
  }

  /** A fresh copy of a ground term, as copyLiteral makes it. */
  private copy(t: Term): string {
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "number") return Object.is(t, -0) ? "-0" : String(t);
    if (t === NIL) return "NIL";
    if (t instanceof Cons) return `new L(${this.copy(t.head)}, ${this.copy(t.tail)})`;
    if (t instanceof Struct) return `new S(${JSON.stringify(t.name)}, [${t.args.map((x) => this.copy(x)).join(", ")}])`;
    return this.body.konst(t);
  }

  /** The template built as Machine.inst builds it, slots not set before it made fresh once each. */
  private build(t: Term, set: Set<number>): string {
    if (t instanceof Slot) {
      if (set.has(t.i)) return `v[${t.i}]`;
      set.add(t.i);
      return `(v[${t.i}] = V())`;
    }
    if (t instanceof Ground) return `C(${this.body.konst(t.t)})`;
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "number") return Object.is(t, -0) ? "-0" : String(t);
    if (t === NIL) return "NIL";
    if (t instanceof Cons) return `new L(${this.build(t.head, set)}, ${this.build(t.tail, set)})`;
    if (t instanceof Struct) return `new S(${JSON.stringify(t.name)}, [${t.args.map((x) => this.build(x, set)).join(", ")}])`;
    return this.body.konst(t);
  }
}

/** The slot numbers in a template. */
function slotsOf(t: Term): number[] {
  const out: number[] = [];
  const st: Term[] = [t];
  while (st.length > 0) {
    const x = st.pop()!;
    if (x instanceof Slot) out.push(x.i);
    else if (x instanceof Struct) st.push(...x.args);
    else if (x instanceof Cons) st.push(x.head, x.tail);
  }
  return out;
}

/**
 * The goals of the body's top conjunction that assign a slot instead of unifying, with the slot: an is/2 whose left
 * side, or an =/2 one of whose sides, is a slot first occurring there, as the whole side, the other side not naming
 * it. Every run of the body passes that goal before any step can read the slot, and a choicepoint pushed before it
 * resumes at a step that passes it again, so the slot needs no variable of its own: the goal stores the value.
 * `seen` holds the head's slots. Time: linear in the body.
 * am[implements a-petta-speed-1105.goal.fresh-out]
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
 * Compile clause `c`: its head unification and, unless it is a fact, its body; the head ends by making a fresh
 * variable for each body slot no goal assigns. Time: linear in the clause, plus V8 compiling the source on its first
 * run.
 */
export function compileClauseCode(m: Machine, c: Clause, rt: Runtime): Code {
  const bc = new BodyCompiler(m, c.nvars);
  const head = c.head;
  const hc = new HeadCompiler(bc);
  if (head instanceof Struct) {
    // The arguments after the first whose term for a call variable takes three or more compound nodes to build are
    // checked before any argument binds; smaller builds cost less than checking a head that succeeds twice.
    // am[implements a-petta-speed-1105.goal.head-precheck]
    const first = head.args.findIndex((t) => size(t instanceof Ground ? t.t : t) >= 3);
    if (first >= 0) for (let i = first + 1; i < head.args.length; i++) hc.precheck(head.args[i]!, `args[${i}]`, { n: BUILD_NODES });
    head.args.forEach((t, i) => hc.arg(t, `args[${i}]`));
  }
  const fact = c.body === "true";
  let make = "";
  if (!fact) {
    bc.fresh = freshOutputs(c.body, new Set(hc.set));
    bc.goal(c.body, "f.cb");
    const assigned = new Set(bc.fresh.values());
    for (let k = 0; k < c.nvars; k++) if (!hc.set.has(k) && !assigned.has(k)) make += `v[${k}] = V();\n`;
  }
  const RS: Resume[] = [];
  const B: BodyFn[] = [];
  const body = fact ? null : bc.sources();
  // The head and body are parenthesized so V8 compiles them along with the factory rather than preparsing them and
  // parsing them again at their first call: 4% fewer instructions on strict_tuple_types and roman_test.
  const factory = new Function(
    "Frame", "E", "C", "cmp", "EMPTY", "NIL", "throwBall", "K", "RS", "S", "L", "deref", "Var", "V", "atomicEq", "B",
    `return [(function head(m, args, v) {\n${hc.source()}\n${make}return true;\n}), [${(body?.parts ?? []).map((p) => `(function body(m, f, pc) {\n${p}\n})`).join(", ")}]];`,
  ) as (...a: unknown[]) => [HeadFn, BodyFn[]];
  const [headFn, parts] = factory(rt.Frame, rt.E, rt.C, numCompare, [], NIL, (b: Term) => throwBall(b, rt.copy), bc.consts, RS, Struct, Cons, deref, Var, mkVar, rt.atomicEq, B);
  B.push(...parts);
  if (body !== null) for (let pc = 0; pc < bc.steps.length; pc++) RS.push(new Resume(B[body.partOf[pc]!]!, pc));
  return { head: headFn, entry: body === null ? null : RS[0]!, nslots: bc.nslots };
}
