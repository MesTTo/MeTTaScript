// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the resolution machine that runs PeTTa's translated Prolog: an iterative solver over goal terms
// with a heap continuation and a choicepoint stack, so recursion depth costs heap rather than JS stack.
// Cut, catch/throw, findall, negation, if-then-else and soft-cut are control frames on that stack, and the
// machine is reentrant so builtins and the translator can solve subgoals.
// am[implements a-pe-runtime]

import { readSync } from "node:fs";
import { Clause, Database, Slot, compileClause } from "./db";
import { OpTable } from "./prolog-reader";
import {
  Cons,
  Float,
  Halt,
  NIL,
  PrologError,
  Str,
  Struct,
  Var,
  deref,
  existenceError,
  instantiationError,
  mkList,
  mkStruct,
  mkVar,
  typeError,
  varCount,
  type Term,
} from "./terms";

/** A goal with its continuation, the choicepoint height its cut returns to, and its innermost catch. */
export class Frame {
  constructor(
    public readonly goal: Term,
    public readonly next: Frame | null,
    public readonly cb: number,
    public readonly cc: number,
  ) {}
}

const enum K {
  Clauses,
  Alt,
  Redo,
  Catch,
  Findall,
  Not,
  Soft,
  Barrier,
}

class CP {
  // Fields of every kind, set in one shape so the stack stays monomorphic.
  cands: Clause[] | null = null;
  idx = 0;
  len = 0;
  gen = 0;
  args: Term[] | null = null;
  alt: Frame | null = null;
  iter: Iterator<unknown> | null = null;
  catcher: Term = NIL;
  recovery: Term = NIL;
  results: Term[] | null = null;
  template: Term = NIL;
  list: Term = NIL;
  disabled = false;
  constructor(
    public readonly kind: K,
    public readonly trailTop: number,
    public readonly varMark: number,
    public readonly next: Frame | null,
    public readonly cb: number,
    public readonly cc: number,
  ) {}
}

export type DetBuiltin = (m: Machine, args: Term[]) => boolean;
export type NondetBuiltin = (m: Machine, args: Term[]) => Iterator<unknown>;
export interface Builtin {
  readonly det?: DetBuiltin;
  readonly nondet?: NondetBuiltin;
}

type TrailEntry = Var | (() => void);
const EMPTY: Term[] = [];

/** A stored clause's ground compound subterm, shared by every renaming instead of copied. */
class Ground {
  constructor(public readonly t: Term) {}
}

/** Rewrite a compiled clause so its ground compound subterms are Ground holders. */
function shareGround(t: Term): Term {
  const isGround = (x: Term): boolean => {
    if (x instanceof Slot) return false;
    if (x instanceof Cons) {
      let c: Term = x;
      while (c instanceof Cons) {
        if (!isGround(c.head)) return false;
        c = c.tail;
      }
      return isGround(c);
    }
    if (x instanceof Struct) return x.args.every(isGround);
    return true;
  };
  const conv = (x: Term): Term => {
    if (x instanceof Cons || x instanceof Struct) {
      if (isGround(x)) return new Ground(x) as unknown as Term;
      if (x instanceof Cons) return new Cons(conv(x.head), conv(x.tail));
      return new Struct(x.name, x.args.map(conv));
    }
    return x;
  };
  return conv(t);
}

/** A stored head stays a structure, since tryClauses unifies its arguments; only the arguments are shared. */
function shareHead(h: Term): Term {
  return h instanceof Struct ? new Struct(h.name, h.args.map(shareGround)) : h;
}

export class Machine {
  readonly db = new Database();
  readonly builtins = new Map<string, Builtin>();
  /** Predicates the engine's own library defines: assert/retract on them is a permission error. */
  readonly libraryPreds = new Set<string>();
  readonly globals = new Map<string, Term>();
  readonly flags = new Map<string, Term>();
  private goals: Frame | null = null;
  private readonly cps: CP[] = [];
  private trail: TrailEntry[] = [];
  /** Variables created at or after the newest choicepoint need no trail entry. */
  private trailBoundary = 0;
  private curCC = -1;
  readonly ops = new OpTable();
  private stdinBuf = "";
  private stdinEof = false;
  /** One line from stdin without its newline, or null at end of input. Blocks, as SWI's read does. */
  readLine: () => string | null = () => {
    for (;;) {
      const nl = this.stdinBuf.indexOf("\n");
      if (nl >= 0) {
        const line = this.stdinBuf.slice(0, nl);
        this.stdinBuf = this.stdinBuf.slice(nl + 1);
        return line;
      }
      if (this.stdinEof) {
        if (this.stdinBuf === "") return null;
        const rest = this.stdinBuf;
        this.stdinBuf = "";
        return rest;
      }
      const buf = Buffer.alloc(65536);
      let n = 0;
      try {
        n = readSync(0, buf, 0, buf.length, null);
      } catch {
        n = 0;
      }
      if (n === 0) this.stdinEof = true;
      else this.stdinBuf += buf.toString("utf8", 0, n);
    }
  };
  /** Output sink for stdout writes, set by the host. */
  out: (s: string) => void = (s) => process.stdout.write(s);
  err: (s: string) => void = (s) => process.stderr.write(s);

  // ---- trail and binding ----

  bind(v: Var, t: Term): void {
    v.ref = t;
    if (v.id < this.trailBoundary) this.trail.push(v);
  }

  /** Record an undo action for a backtrackable side effect (b_setval, put_attr). */
  trailUndo(fn: () => void): void {
    this.trail.push(fn);
  }

  trailMark(): number {
    return this.trail.length;
  }

  undoTo(mark: number): void {
    const tr = this.trail;
    for (let i = tr.length - 1; i >= mark; i--) {
      const e = tr[i]!;
      if (e instanceof Var) e.ref = null;
      else e();
    }
    tr.length = mark;
  }

  private pushCP(kind: K, next: Frame | null, cb: number, cc: number): CP {
    const vm = varCount();
    const cp = new CP(kind, this.trail.length, vm, next, cb, cc);
    this.cps.push(cp);
    this.trailBoundary = vm;
    return cp;
  }

  cutTo(h: number): void {
    if (this.cps.length > h) {
      this.cps.length = h;
      this.trailBoundary = h > 0 ? this.cps[h - 1]!.varMark : 0;
    }
  }

  /** Unify two terms, trailing bindings. Time: size of the smaller term; iterative over list spines. */
  unify(a: Term, b: Term): boolean {
    const stack: Term[] = [a, b];
    while (stack.length > 0) {
      let y = deref(stack.pop()!);
      let x = deref(stack.pop()!);
      if (x === y) continue;
      if (x instanceof Var) {
        if (y instanceof Var && y.id > x.id) {
          this.bindAttr(y, x);
          continue;
        }
        this.bindAttr(x, y);
        continue;
      }
      if (y instanceof Var) {
        this.bindAttr(y, x);
        continue;
      }
      if (x instanceof Cons) {
        if (!(y instanceof Cons)) return false;
        stack.push(x.tail, y.tail, x.head, y.head);
        continue;
      }
      if (x instanceof Struct) {
        if (!(y instanceof Struct) || x.name !== y.name || x.args.length !== y.args.length) return false;
        for (let i = x.args.length - 1; i >= 0; i--) stack.push(x.args[i]!, y.args[i]!);
        continue;
      }
      if (!atomicEq(x, y)) return false;
    }
    return true;
  }

  /** Attribute hooks run after unification; PeTTa's runtime attributes need none, so binding is plain. */
  private bindAttr(v: Var, t: Term): void {
    this.bind(v, t);
  }

  // ---- clause renaming ----

  private inst(t: Term, vars: (Term | undefined)[]): Term {
    if (t instanceof Slot) {
      const v = vars[t.i];
      if (v !== undefined) return v;
      const nv = mkVar();
      vars[t.i] = nv;
      return nv;
    }
    if (t instanceof Ground) return t.t;
    if (t instanceof Cons) {
      const first = new Cons(this.inst(t.head, vars), NIL);
      let last = first;
      let rest: Term = t.tail;
      while (rest instanceof Cons) {
        const cell = new Cons(this.inst(rest.head, vars), NIL);
        last.tail = cell;
        last = cell;
        rest = rest.tail;
      }
      last.tail = this.inst(rest, vars);
      return first;
    }
    if (t instanceof Struct) {
      const n = t.args.length;
      const args = new Array<Term>(n);
      for (let i = 0; i < n; i++) args[i] = this.inst(t.args[i]!, vars);
      return new Struct(t.name, args);
    }
    return t;
  }

  /** Unify a stored head argument with a call argument, binding slots to call subterms where they first occur. */
  private unifyHead(tpl: Term, act: Term, vars: (Term | undefined)[]): boolean {
    if (tpl instanceof Slot) {
      const v = vars[tpl.i];
      if (v === undefined) {
        vars[tpl.i] = act;
        return true;
      }
      return this.unify(v, act);
    }
    if (tpl instanceof Ground) return this.unify(tpl.t, act);
    act = deref(act);
    if (act instanceof Var) {
      this.bind(act, this.inst(tpl, vars));
      return true;
    }
    if (tpl instanceof Cons) {
      if (!(act instanceof Cons)) return false;
      return this.unifyHead(tpl.head, act.head, vars) && this.unifyHead(tpl.tail, act.tail, vars);
    }
    if (tpl instanceof Struct) {
      if (!(act instanceof Struct) || act.name !== tpl.name || act.args.length !== tpl.args.length) return false;
      for (let i = 0; i < tpl.args.length; i++) if (!this.unifyHead(tpl.args[i]!, act.args[i]!, vars)) return false;
      return true;
    }
    return atomicEq(tpl, act);
  }

  // ---- database interface ----

  /** assertz/asserta of a clause term `Head :- Body` or a fact. */
  addClause(clause: Term, atEnd: boolean): Clause {
    let head = deref(clause);
    let body: Term = "true";
    if (head instanceof Struct && head.name === ":-" && head.args.length === 2) {
      body = head.args[1]!;
      head = deref(head.args[0]!);
    }
    if (head instanceof Var) throw instantiationError();
    let name: string;
    let arity: number;
    if (typeof head === "string") [name, arity] = [head, 0];
    else if (head instanceof Struct) [name, arity] = [head.name, head.args.length];
    else throw typeError("callable", head);
    const key = name + "/" + arity;
    if (this.builtins.has(key) || this.libraryPreds.has(key))
      throw new PrologError(
        mkStruct("error", mkStruct("permission_error", "modify", "static_procedure", mkStruct("/", name, arity)), mkVar()),
      );
    const pred = this.db.ensure(name, arity);
    pred.dynamic = true;
    const c = compileClause(head, body);
    return this.db.addClause(pred, shareHead(c.head), shareGround(c.body), c.nvars, atEnd);
  }

  /** Define a library predicate from clause terms; such predicates are static to user asserts. */
  addLibraryClause(clause: Term): void {
    let head = deref(clause);
    let body: Term = "true";
    if (head instanceof Struct && head.name === ":-" && head.args.length === 2) {
      body = head.args[1]!;
      head = deref(head.args[0]!);
    }
    const [name, arity] = typeof head === "string" ? [head, 0] : [(head as Struct).name, (head as Struct).args.length];
    const pred = this.db.ensure(name, arity);
    const c = compileClause(head, body);
    this.db.addClause(pred, shareHead(c.head), shareGround(c.body), c.nvars, true);
    this.libraryPreds.add(name + "/" + arity);
  }

  /** The (Head, Body) of a stored clause, renamed apart. */
  clauseTerms(c: Clause): [Term, Term] {
    const vars: (Term | undefined)[] = new Array(c.nvars);
    return [this.inst(c.head, vars), this.inst(c.body, vars)];
  }

  /** Visible clauses of a predicate at the current generation, for clause/2 and retract/1. */
  visibleClauses(name: string, arity: number): Clause[] {
    const p = this.db.get(name, arity);
    if (p === undefined) return [];
    const gen = this.db.generation;
    return p.clauses.filter((c) => c.born <= gen && c.died > gen);
  }

  defBuiltin(name: string, arity: number, b: Builtin): void {
    this.builtins.set(name + "/" + arity, b);
  }

  // ---- solving ----

  /** Solve `goal` once; bindings persist on success. Exceptions propagate as PrologError. */
  solveOnce(goal: Term): boolean {
    const savedGoals = this.goals;
    const savedCC = this.curCC;
    const b = this.cps.length;
    this.pushCP(K.Barrier, null, b, savedCC);
    this.goals = new Frame(goal, null, b + 1, savedCC);
    try {
      const ok = this.run(b + 1);
      this.cutTo(b);
      return ok;
    } catch (e) {
      // run() already unwound to the barrier for an uncaught ball; drop it and our frame.
      this.cutTo(b);
      throw e;
    } finally {
      this.goals = savedGoals;
      this.curCC = savedCC;
    }
  }

  /** Solve `goal` for every solution, calling `each` after each one; `each` returning false stops. */
  solveAll(goal: Term, each: () => boolean | void): void {
    const savedGoals = this.goals;
    const savedCC = this.curCC;
    const b = this.cps.length;
    this.pushCP(K.Barrier, null, b, savedCC);
    this.goals = new Frame(goal, null, b + 1, savedCC);
    try {
      let ok = this.run(b + 1);
      while (ok) {
        if (each() === false) break;
        if (!this.backtrack(b + 1)) break;
        ok = this.run(b + 1);
      }
    } finally {
      const top = this.cps[b];
      if (top !== undefined && top.kind === K.Barrier) this.undoTo(top.trailTop);
      this.cutTo(b);
      this.goals = savedGoals;
      this.curCC = savedCC;
    }
  }

  /** Run goals until the continuation is empty (true) or backtracking falls to `base` (false). */
  private run(base: number): boolean {
    for (;;) {
      try {
        for (;;) {
          const f = this.goals;
          if (f === null) return true;
          this.goals = f.next;
          if (!this.step(f) && !this.backtrack(base)) return false;
        }
      } catch (e) {
        if (!(e instanceof PrologError)) throw e;
        if (!this.handleThrow(e, base)) throw e;
      }
    }
  }

  /**
   * Backtrack to the newest choicepoint at or above `base` that yields an alternative. Returns false, with the
   * trail undone to the barrier below `base`, when none does.
   */
  private backtrack(base: number): boolean {
    const cps = this.cps;
    while (cps.length > base) {
      const cp = cps[cps.length - 1]!;
      this.undoTo(cp.trailTop);
      switch (cp.kind) {
        case K.Clauses: {
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          if (this.tryClauses(cp.cands!, cp.idx, cp.len, cp.gen, cp.args!, cp.next, cp.cc)) return true;
          break;
        }
        case K.Alt:
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          this.goals = cp.alt;
          return true;
        case K.Soft:
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          if (cp.disabled) break;
          this.goals = cp.alt;
          return true;
        case K.Not:
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          this.goals = cp.next;
          return true;
        case K.Redo: {
          this.curCC = cp.cc;
          const r = cp.iter!.next();
          if (r.done) {
            cps.pop();
            this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
            break;
          }
          this.goals = cp.next;
          return true;
        }
        case K.Findall: {
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          if (this.unify(cp.list, mkList(cp.results!))) {
            this.goals = cp.next;
            return true;
          }
          break;
        }
        case K.Catch:
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          break;
        case K.Barrier:
          // Never popped here: the barrier belongs to the run that called this one.
          return false;
      }
    }
    if (cps.length > 0 && base > 0) {
      const bar = cps[base - 1];
      if (bar !== undefined) this.undoTo(bar.trailTop);
    }
    return false;
  }

  /** Unwind to the innermost catch whose catcher unifies with the ball; false if none is in this run. */
  private handleThrow(e: PrologError, base: number): boolean {
    const ball = copyTerm(e.ball);
    let c = this.curCC;
    while (c >= base) {
      const cp = this.cps[c];
      if (cp === undefined || cp.kind !== K.Catch) break;
      this.undoTo(cp.trailTop);
      this.cutTo(c);
      const mark = this.trail.length;
      if (this.unify(cp.catcher, ball)) {
        this.goals = new Frame(cp.recovery, cp.next, cp.cb, cp.cc);
        return true;
      }
      this.undoTo(mark);
      c = cp.cc;
    }
    // Not ours: unwind this run to its barrier so the caller resumes from a clean state.
    const bar = this.cps[base - 1];
    if (bar !== undefined) this.undoTo(bar.trailTop);
    this.cutTo(base);
    // Rethrow the copied ball so bindings undone here cannot change it.
    if (ball !== e.ball) throw new PrologError(ball);
    return false;
  }

  /** Try clauses cands[start..len) visible at `gen`; on a match push the rest as a choicepoint. */
  private tryClauses(
    cands: Clause[],
    start: number,
    len: number,
    gen: number,
    args: Term[],
    next: Frame | null,
    cc: number,
  ): boolean {
    const h = this.cps.length;
    for (let i = start; i < len; i++) {
      const c = cands[i]!;
      if (c.born > gen || c.died <= gen || !mayMatch(c.head, args)) continue;
      // Find whether a later clause could match, so a last match leaves no choicepoint.
      let j = i + 1;
      while (j < len) {
        const d = cands[j]!;
        if (d.born <= gen && d.died > gen && mayMatch(d.head, args)) break;
        j++;
      }
      let cp: CP | null = null;
      if (j < len) {
        cp = this.pushCP(K.Clauses, next, h, cc);
        cp.cands = cands;
        cp.idx = j;
        cp.len = len;
        cp.gen = gen;
        cp.args = args;
      }
      const mark = this.trail.length;
      const vars: (Term | undefined)[] = new Array(c.nvars);
      const head = c.head;
      let ok = true;
      if (head instanceof Struct)
        for (let k = 0; k < args.length; k++)
          if (!this.unifyHead(head.args[k]!, args[k]!, vars)) {
            ok = false;
            break;
          }
      if (ok) {
        const body = c.body;
        if (body !== "true") this.goals = new Frame(this.inst(body, vars), next, h, cc);
        else this.goals = next;
        return true;
      }
      this.undoTo(mark);
      if (cp !== null) {
        this.cps.pop();
        this.trailBoundary = this.cps.length > 0 ? this.cps[this.cps.length - 1]!.varMark : 0;
      }
      i = j - 1;
    }
    return false;
  }

  /** Execute one goal. Returns false on failure; may replace the continuation and push choicepoints. */
  private step(f: Frame): boolean {
    const g = deref(f.goal);
    this.curCC = f.cc;
    let name: string;
    let args: Term[];
    if (typeof g === "string") {
      name = g;
      args = EMPTY;
    } else if (g instanceof Struct) {
      name = g.name;
      args = g.args;
    } else if (g instanceof Var) {
      throw instantiationError();
    } else {
      throw typeError("callable", g);
    }
    switch (args.length) {
      case 0:
        if (name === "true") return true;
        if (name === "fail" || name === "false") return false;
        if (name === "!") {
          this.cutTo(f.cb);
          return true;
        }
        if (name === "halt") throw new Halt(0);
        break;
      case 1:
        if (name === "$cut") {
          this.cutTo(deref(args[0]!) as number);
          return true;
        }
        if (name === "$softcut") {
          const cp = this.cps[deref(args[0]!) as number];
          if (cp !== undefined && cp.kind === K.Soft) cp.disabled = true;
          return true;
        }
        if (name === "$nafail") {
          this.cutTo(deref(args[0]!) as number);
          return false;
        }
        if (name === "$fa_collect") {
          const cp = this.cps[deref(args[0]!) as number]!;
          cp.results!.push(copyTerm(cp.template));
          return false;
        }
        if (name === "\\+") {
          const h = this.cps.length;
          this.pushCP(K.Not, f.next, f.cb, f.cc);
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$nafail", h), null, h + 1, f.cc), h + 1, f.cc);
          return true;
        }
        if (name === "call") {
          this.goals = new Frame(args[0]!, f.next, this.cps.length, f.cc);
          return true;
        }
        if (name === "once") {
          const h = this.cps.length;
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$cut", h), f.next, f.cb, f.cc), h, f.cc);
          return true;
        }
        if (name === "ignore") {
          const h = this.cps.length;
          const alt = this.pushCP(K.Alt, f.next, f.cb, f.cc);
          alt.alt = f.next;
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$cut", h), f.next, f.cb, f.cc), h + 1, f.cc);
          return true;
        }
        if (name === "throw") {
          const ball = deref(args[0]!);
          if (ball instanceof Var) throw instantiationError();
          throw new PrologError(copyTerm(ball));
        }
        if (name === "halt") {
          const st = deref(args[0]!);
          throw new Halt(typeof st === "number" ? st : 0);
        }
        break;
      case 2:
        if (name === ",") {
          this.goals = new Frame(args[0]!, new Frame(args[1]!, f.next, f.cb, f.cc), f.cb, f.cc);
          return true;
        }
        if (name === ";") return this.disjunction(args[0]!, args[1]!, f);
        if (name === "->") {
          const h = this.cps.length;
          this.goals = new Frame(
            args[0]!,
            new Frame(mkStruct("$cut", h), new Frame(args[1]!, f.next, f.cb, f.cc), f.cb, f.cc),
            h,
            f.cc,
          );
          return true;
        }
        if (name === "*->") {
          this.goals = new Frame(args[0]!, new Frame(args[1]!, f.next, f.cb, f.cc), this.cps.length, f.cc);
          return true;
        }
        if (name === "forall") {
          const g2 = mkStruct("\\+", mkStruct(",", args[0]!, mkStruct("\\+", args[1]!)));
          this.goals = new Frame(g2, f.next, f.cb, f.cc);
          return true;
        }
        break;
      case 3:
        if (name === "findall") {
          const h = this.cps.length;
          const cp = this.pushCP(K.Findall, f.next, f.cb, f.cc);
          cp.results = [];
          cp.template = args[0]!;
          cp.list = args[2]!;
          this.goals = new Frame(args[1]!, new Frame(mkStruct("$fa_collect", h), null, h + 1, f.cc), h + 1, f.cc);
          return true;
        }
        if (name === "catch") {
          const h = this.cps.length;
          const cp = this.pushCP(K.Catch, f.next, f.cb, f.cc);
          cp.catcher = args[1]!;
          cp.recovery = args[2]!;
          this.goals = new Frame(args[0]!, f.next, h + 1, h);
          return true;
        }
        break;
    }
    if (name === "call" && args.length > 1) {
      const goal = addArgs(args[0]!, args.slice(1));
      this.goals = new Frame(goal, f.next, this.cps.length, f.cc);
      return true;
    }
    const key = name + "/" + args.length;
    const b = this.builtins.get(key);
    if (b !== undefined) {
      if (b.det !== undefined) {
        if (!b.det(this, args)) return false;
        // A det builtin may have replaced the continuation (e.g. by pushing goals); keep it if so.
        return true;
      }
      const h = this.cps.length;
      const cp = this.pushCP(K.Redo, f.next, f.cb, f.cc);
      cp.iter = b.nondet!(this, args);
      const r = cp.iter.next();
      if (r.done) {
        this.cutTo(h);
        return false;
      }
      return true;
    }
    const p = this.db.preds.get(key);
    if (p !== undefined) {
      const cands = p.candidates(args);
      return this.tryClauses(cands, 0, cands.length, this.db.generation, args, f.next, f.cc);
    }
    if (this.flags.get("unknown") === "fail") return false;
    throw existenceError("procedure", mkStruct("/", name, args.length));
  }

  private disjunction(left: Term, right: Term, f: Frame): boolean {
    const l = deref(left);
    if (l instanceof Struct && l.args.length === 2 && (l.name === "->" || l.name === "*->")) {
      const h = this.cps.length;
      const soft = l.name === "*->";
      const cp = this.pushCP(soft ? K.Soft : K.Alt, f.next, f.cb, f.cc);
      cp.alt = new Frame(right, f.next, f.cb, f.cc);
      const commit = soft ? mkStruct("$softcut", h) : mkStruct("$cut", h);
      this.goals = new Frame(
        l.args[0]!,
        new Frame(commit, new Frame(l.args[1]!, f.next, f.cb, f.cc), f.cb, f.cc),
        h + 1,
        f.cc,
      );
      return true;
    }
    const cp = this.pushCP(K.Alt, f.next, f.cb, f.cc);
    cp.alt = new Frame(right, f.next, f.cb, f.cc);
    this.goals = new Frame(left, f.next, f.cb, f.cc);
    return true;
  }

  /** Push `goal` to run next within a det builtin, as its continuation; cut inside it is local. */
  pushGoal(goal: Term): void {
    this.goals = new Frame(goal, this.goals, this.cps.length, this.curCC);
  }
}

/** Cheap pre-filter: a clause whose first argument's principal functor differs cannot match. */
function mayMatch(head: Term, args: Term[]): boolean {
  if (args.length === 0 || !(head instanceof Struct)) return true;
  const t = head.args[0]!;
  if (t instanceof Slot) return true;
  const a = deref(args[0]!);
  if (a instanceof Var) return true;
  const tt = t instanceof Ground ? t.t : t;
  if (typeof tt === "string" || typeof tt === "number") return atomicEq(tt, a);
  if (tt instanceof Cons) return a instanceof Cons;
  if (tt instanceof Struct) return a instanceof Struct && a.name === tt.name && a.args.length === tt.args.length;
  if (tt === NIL) return a === NIL;
  return true;
}

/** Equality of two dereferenced atomic terms as unification sees it: 1 and 1.0 differ. */
export function atomicEq(x: Term, y: Term): boolean {
  if (x === y) return true;
  if (typeof x === "bigint" || typeof y === "bigint") return typeof x === typeof y && x === y;
  if (x instanceof Float) return y instanceof Float && (x.v === y.v || (Number.isNaN(x.v) && Number.isNaN(y.v)));
  if (x instanceof Str) return y instanceof Str && x.s === y.s;
  return false;
}

/** Add arguments to a callable term, as call/N does. */
export function addArgs(goal: Term, extra: Term[]): Term {
  const g = deref(goal);
  if (typeof g === "string") return new Struct(g, extra);
  if (g instanceof Struct) return new Struct(g.name, [...g.args, ...extra]);
  if (g instanceof Var) throw instantiationError();
  throw typeError("callable", g);
}

/** copy_term/2 without attributes: fresh variables, sharing preserved. Time: term size. */
export function copyTerm(t: Term, map: Map<Var, Var> = new Map()): Term {
  t = deref(t);
  if (t instanceof Var) {
    let v = map.get(t);
    if (v === undefined) {
      v = mkVar();
      map.set(t, v);
    }
    return v;
  }
  if (t instanceof Cons) {
    const first = new Cons(copyTerm(t.head, map), NIL);
    let last = first;
    let rest = deref(t.tail);
    while (rest instanceof Cons) {
      const cell = new Cons(copyTerm(rest.head, map), NIL);
      last.tail = cell;
      last = cell;
      rest = deref(rest.tail);
    }
    last.tail = copyTerm(rest, map);
    return first;
  }
  if (t instanceof Struct) return new Struct(t.name, t.args.map((a) => copyTerm(a, map)));
  return t;
}

/** The fully dereferenced form of a term, sharing unbound variables. */
export function resolve(t: Term): Term {
  t = deref(t);
  if (t instanceof Cons) {
    const first = new Cons(resolve(t.head), NIL);
    let last = first;
    let rest = deref(t.tail);
    while (rest instanceof Cons) {
      const cell = new Cons(resolve(rest.head), NIL);
      last.tail = cell;
      last = cell;
      rest = deref(rest.tail);
    }
    last.tail = resolve(rest);
    return first;
  }
  if (t instanceof Struct) return new Struct(t.name, t.args.map(resolve));
  return t;
}
