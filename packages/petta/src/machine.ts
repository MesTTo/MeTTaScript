// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the resolution machine that runs PeTTa's translated Prolog: an iterative solver over goal terms
// with a heap continuation and a choicepoint stack, so recursion depth costs heap rather than JS stack.
// Cut, catch/throw, findall, negation, if-then-else and soft-cut are control frames on that stack, and the
// machine is reentrant so builtins and the translator can solve subgoals. A call tries the clauses SWI's clause
// selection picks (swi-index.ts), so a choicepoint stays exactly where SWI leaves one.
// Once a cell machine runs the program (cell/), this machine has consulted PeTTa's own sources and hosts the database
// and the builtins the cell machine reaches; a goal of the program it meets goes to the cell machine
// (Machine.solveProgram).
// am[implements a-pe-runtime]

import { readSync } from "node:fs";
import { evalArith } from "./arith";
import { Resume, compileClauseCode, type Runtime } from "./compile";
import { Clause, Database, Ground, Pred, Slot, argHashIndex, clauseArgHash, compileClause, groundHash } from "./db";
import { MAX_LOOKAHEAD, clauseScan, type Scan } from "./swi-index";
import { OpTable, PrologSyntaxError } from "./prolog-reader";
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
  type Term, unqualify,
} from "./terms";

/** A goal with its continuation, the choicepoint height its cut returns to, and its innermost catch. */
/** The variable array of one clause activation; a frame's goal is a stored template read through it. */
export type Vars = (Term | undefined)[] | null;

/**
 * A goal with its continuation, the choicepoint height its cut returns to, and its innermost catch. With
 * `vars`, the goal is a stored clause-body template (slots and shared ground terms) read through that array,
 * so a clause body is never copied whole: only the arguments a builtin or a call needs are instantiated.
 */
export class Frame {
  constructor(
    /** A goal template, or where a compiled body resumes (compile.ts Resume). */
    public readonly goal: Term | Resume,
    public readonly next: Frame | null,
    public readonly cb: number,
    public readonly cc: number,
    public readonly vars: Vars = null,
  ) {}
}

/**
 * A predicate as compiled bodies call it: its builtin, kept current by defBuiltin and by a clause replacing a
 * builtin, and its clause set once one exists (a Pred, once made, stays in the database).
 * am[implements a-petta-speed-1105.goal]
 */
export class ProcCell {
  builtin: Builtin | undefined = undefined;
  pred: Pred | undefined = undefined;
  constructor(
    readonly name: string,
    readonly arity: number,
    readonly key: string,
  ) {}
}

/**
 * A clause body is compiled on its COMPILE_AFTER-th entry; PETTA_COMPILE=off keeps every body interpreted, the
 * baseline the compiled engine is checked against.
 * am[implements a-petta-speed-1105.goal]
 */
const COMPILE_AFTER = process.env.PETTA_COMPILE === "off" ? Infinity : Number(process.env.PETTA_COMPILE_AFTER ?? 32);
const RUNTIME: Runtime = { Frame, E: evalArith, C: copyLiteral, copy: (t) => copyTerm(t), atomicEq: (x, y) => atomicEq(x, y) };

const enum K {
  Clauses,
  Alt,
  Redo,
  Catch,
  Findall,
  Not,
  Soft,
  Barrier,
  Cleanup,
}

/**
 * A choicepoint. Every kind has one shape, so the stack stays monomorphic, and three untyped fields serve each kind's
 * own data through the named accessors below, rather than a field per role.
 * am[implements a-petta-speed-1105.goal]
 */
class CP {
  private a: unknown = null;
  private b: unknown = null;
  private c: unknown = null;
  /** Clauses: the next candidate; Soft: 1 once its else branch is gone. */
  idx = 0;
  /** Clauses: the generation the call sees. */
  gen = 0;
  /** Trail entries below this index, above trailTop, were already tidied against this choicepoint (tidyTrail). */
  tidied = 0;
  /** The push order of this choicepoint among all pushed (Machine.cpSerial), which a retry keeps. */
  serial = 0;
  constructor(
    public readonly kind: K,
    public readonly trailTop: number,
    /** Variables numbered from here on are newer than the choicepoint; a clause retry moves it to the retry's start. */
    public varMark: number,
    public readonly next: Frame | null,
    public readonly cb: number,
    public readonly cc: number,
  ) {}
  // Clauses: the scan, the call's arguments, and its ground argument hashes for a long scan (tryClauses).
  get scan(): Scan | null { return this.a as Scan | null; }
  set scan(v: Scan | null) { this.a = v; }
  get args(): Term[] | null { return this.b as Term[] | null; }
  set args(v: Term[] | null) { this.b = v; }
  get hashes(): (number | null)[] | null { return this.c as (number | null)[] | null; }
  set hashes(v: (number | null)[] | null) { this.c = v; }
  // Alt and Soft: the alternative; Soft: whether it is disabled.
  get alt(): Frame | null { return this.a as Frame | null; }
  set alt(v: Frame | null) { this.a = v; }
  get disabled(): boolean { return this.idx === 1; }
  set disabled(v: boolean) { this.idx = v ? 1 : 0; }
  // Redo: the builtin's iterator.
  get iter(): Iterator<unknown> | null { return this.a as Iterator<unknown> | null; }
  set iter(v: Iterator<unknown> | null) { this.a = v; }
  // Catch: catcher, recovery and the recovery's variables; Cleanup: the cleanup goal as `recovery`.
  get catcher(): Term { return (this.a ?? NIL) as Term; }
  set catcher(v: Term) { this.a = v; }
  get recovery(): Term { return (this.b ?? NIL) as Term; }
  set recovery(v: Term) { this.b = v; }
  get recVars(): Vars { return this.c as Vars; }
  set recVars(v: Vars) { this.c = v; }
  // Findall: the results so far, the template and the list to unify with them.
  get results(): Term[] | null { return this.a as Term[] | null; }
  set results(v: Term[] | null) { this.a = v; }
  get template(): Term { return (this.b ?? NIL) as Term; }
  set template(v: Term) { this.b = v; }
  get list(): Term { return (this.c ?? NIL) as Term; }
  set list(v: Term) { this.c = v; }
}

export type DetBuiltin = (m: Machine, args: Term[]) => boolean;
/**
 * A nondeterministic builtin: each `yield` is a solution that may have more after it; returning `true` is a
 * last solution, which leaves no choicepoint (SWI's foreign predicates return TRUE there instead of retrying,
 * and setup_call_cleanup runs its cleanup at such an exit); returning anything else means no more solutions.
 * am[implements a-hp-cp-parity]
 */
export type NondetBuiltin = (m: Machine, args: Term[]) => Iterator<unknown>;
export interface Builtin {
  readonly det?: DetBuiltin;
  readonly nondet?: NondetBuiltin;
  /**
   * For a nondeterministic builtin, its answer when the call's mode makes it deterministic, decided by looking at the
   * arguments only: true or false as a det builtin returns, null when the generator must run. The generator's last
   * solution would leave no choicepoint there, so taking this answer instead changes nothing but the cost.
   * am[implements a-petta-speed-1105.goal]
   */
  readonly detMode?: (m: Machine, args: Term[]) => boolean | null;
}

/**
 * A trail entry restoring an older variable's attributes (Machine.putAttr). Unlike an undo closure it names its
 * variable, so tidying drops it once the variable is newer than every choicepoint left.
 * am[implements a-petta-speed-1105.memory.trail-values]
 */
export class AttrUndo {
  constructor(
    readonly v: Var,
    readonly old: Map<string, Term> | null,
  ) {}
}

/**
 * A trail entry restoring a b_setval global variable's value (Machine.trailGlobal), recorded for the first assignment
 * to its key after the choicepoints pushed up to serial `serial`; `live` until backtracking runs it.
 * am[implements a-petta-speed-1105.memory.trail-values]
 */
class GlobalUndo {
  live = true;
  constructor(
    readonly key: string,
    readonly old: Term | undefined,
    readonly serial: number,
  ) {}
}

type TrailEntry = Var | AttrUndo | GlobalUndo | (() => void);
const EMPTY: Term[] = [];
const EMPTY_POS: number[] = [];

/** The first index of ascending `a` whose value is at least `x`. Time: log of a's length. */
function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** The goals step() runs itself rather than through a builtin or the clause database. */
const STEP_CONTROL = new Set([
  "true/0", "fail/0", "false/0", "!/0", "halt/0", "$cut/1", "$softcut/1", "$nafail/1", "$scc_exit/1", "$fa_collect/1",
  "$catch_exit/1", "\\+/1", "call/1", "once/1", "ignore/1", "throw/1", "halt/1", ",/2", ";/2", "->/2", "*->/2",
  "call_cleanup/2", "forall/2", "findall/3", "setup_call_cleanup/3", "catch/3",
]);
/** The variable array of a clause activation with no slots; nothing writes into it. */
const NO_VARS: (Term | undefined)[] = [];

/** What one thread of control owns: its goals, choicepoints, trail, pending wakeups and global variables. */
interface SolverState {
  goals: Frame | null;
  cps: CP[];
  trail: TrailEntry[];
  trailBoundary: number;
  curCC: number;
  wakeups: Term[];
  globals: Map<string, Term>;
  globalUndos: Map<string, GlobalUndo>;
}

/** A suspended solve (Machine.newFiber, runFiber). */
export interface Fiber {
  state: SolverState;
  solved: boolean;
}

/**
 * A fresh copy of a stored ground literal, made where the literal enters an activation: SWI builds a clause's
 * terms anew for each call, so nb_setarg/setarg on them never reach the stored clause (ai-tmp/probe/lit.pl:
 * t1 printed f(a) twice). Atoms, numbers and strings are immutable and stay shared.
 * Time: one allocation per compound node of the literal.
 */
// am[implements a-hp-swi-gap]
function copyLiteral(t: Term): Term {
  if (t instanceof Struct) {
    const n = t.args.length;
    const args = new Array<Term>(n);
    for (let i = 0; i < n; i++) args[i] = copyLiteral(t.args[i]!);
    return new Struct(t.name, args);
  }
  if (t instanceof Cons) {
    const first = new Cons(copyLiteral(t.head), NIL);
    let last = first;
    let rest: Term = t.tail;
    while (rest instanceof Cons) {
      const cell = new Cons(copyLiteral(rest.head), NIL);
      last.tail = cell;
      last = cell;
      rest = rest.tail;
    }
    last.tail = copyLiteral(rest);
    return first;
  }
  return t;
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

/** Predicates SWI refuses to let user code modify: ISO builtins and those its boot files define. */
const PROTECTED = new Set([
  "=/2", "\\=/2", "==/2", "\\==/2", "@</2", "@>/2", "@=</2", "@>=/2", "compare/3", "var/1", "nonvar/1", "atom/1",
  "number/1", "integer/1", "float/1", "atomic/1", "compound/1", "callable/1", "is_list/1", "string/1", "ground/1",
  "functor/3", "arg/3", "=../2", "copy_term/2", "is/2", "=:=/2", "=\\=/2", "</2", ">/2", "=</2", ">=/2",
  "clause/2", "asserta/1", "assertz/1", "assert/1", "retract/1", "retractall/1", "abolish/1", "findall/3", "findall/4",
  "bagof/3", "setof/3", "forall/2", "atom_codes/2", "atom_chars/2", "char_code/2", "atom_length/2", "atom_concat/3",
  "sub_atom/5", "number_codes/2", "number_chars/2", "atom_number/2", "atom_string/2", "string_concat/3",
  "write/1", "writeq/1", "print/1", "nl/0", "write_canonical/1", "write_term/2", "format/1", "format/2", "format/3",
  "halt/0", "halt/1", "call/1", "catch/3", "throw/1", "once/1", "ignore/1", "\\+/1", "not/1", "length/2",
  "msort/2", "sort/2", "sort/4", "keysort/2", "nb_getval/2", "nb_setval/2", "b_getval/2", "b_setval/2",
  "term_variables/2", "setarg/3", "nb_setarg/3", "tab/1", "atom_to_term/3", "term_to_atom/2", "number_vars/3",
  "succ_or_fail/0", "read_term/2", "op/3", "current_op/3", "dynamic/1", "consult/1",
]);

/** A stored head stays a structure, since tryClauses unifies its arguments; only the arguments are shared. */
function shareHead(h: Term): Term {
  return h instanceof Struct ? new Struct(h.name, h.args.map(shareGround)) : h;
}

export class Machine {
  /** The clause database; replaceDatabase swaps in one an image rebuilt. */
  db = new Database();
  readonly builtins = new Map<string, Builtin>();
  /** The arities of each builtin name in the order their keys entered `builtins`, kept with it by defBuiltin and addClause. */
  // am[implements a-petta-speed-1105.scans]
  readonly builtinArities = new Map<string, number[]>();
  private readonly cells = new Map<string, ProcCell>();
  /** With PETTA_PROFILE set: calls per predicate key, and clause candidates examined under "#key" (profileReport). */
  readonly profile: Map<string, number> | null = process.env.PETTA_PROFILE ? new Map() : null;
  /** The file whose clauses a consult is adding now; clauses added meanwhile are static and record it. */
  sourceFile: string | null = null;
  /** Loads the library exporting Name/Arity when an undefined predicate is called; true if it did. */
  autoload: ((name: string, arity: number) => boolean) | null = null;
  /** Predicates the engine's own library defines: assert/retract on them is a permission error. */
  readonly libraryPreds = new Set<string>();
  /** Global variables (b_setval/nb_setval): per thread of control, as SWI's are per thread. */
  globals = new Map<string, Term>();
  /** Each global variable's newest b_setval trail entry (trailGlobal). */
  private globalUndos = new Map<string, GlobalUndo>();
  /** flag/3 values, shared by every thread of control as SWI's flags are. */
  readonly flagValues = new Map<string, Term>();
  readonly flags = new Map<string, Term>();
  /** When set, current_prolog_flag/2 counts its reads per flag here (the image builder finds argv's readers so). */
  // am[implements a-petta-speed-1105.startup.image]
  flagReads: Map<string, number> | null = null;
  /** The continuation: the goal to run next and, through `next`, the rest. Compiled bodies set it at a call. */
  goals: Frame | null = null;
  private cps: CP[] = [];
  private trail: TrailEntry[] = [];
  /** Variables created at or after the newest choicepoint need no trail entry. */
  private trailBoundary = 0;
  private curCC = -1;
  /** Attribute hooks woken by binding attributed variables: [module, value, other], run before the next goal. */
  wakeups: Term[] = [];
  readonly ops = new OpTable();
  /** Predicates declared with `:- table`, as Name/Arity keys, and their completed answer tables by variant. */
  readonly tabled = new Set<string>();
  readonly tables = new Map<string, Term[]>();
  private readonly objects: unknown[] = [];
  /** Opaque host objects (streams) referenced from terms by index. */
  registerObject(o: unknown): number {
    this.objects.push(o);
    return this.objects.length - 1;
  }
  objectOf(t: Term): unknown {
    const d = deref(t);
    if (d instanceof Struct && d.name === "$stream") return this.objects[deref(d.args[0]!) as number];
    return undefined;
  }
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

  /**
   * Whether a and b unify, leaving no binding behind: every binding is trailed while it runs, so a partial
   * unification of variables newer than the last choicepoint (which bind() leaves untrailed) is undone too.
   * `seen` receives the variables the unification bound, most recent last. For \=/2 and unifiable/3.
   */
  probeUnify(a: Term, b: Term, seen?: (bound: Var[]) => void): boolean {
    const saved = this.trailBoundary;
    const mark = this.trail.length;
    const wl = this.wakeups.length;
    this.trailBoundary = Infinity;
    try {
      const ok = this.unify(a, b);
      if (ok && seen !== undefined) seen(this.trail.slice(mark).filter((e): e is Var => e instanceof Var));
      return ok;
    } finally {
      this.undoTo(mark);
      this.wakeups.length = wl;
      this.trailBoundary = saved;
    }
  }

  undoTo(mark: number): void {
    const tr = this.trail;
    // Popping, not assigning length: shrinking an array through its length costs tens of nanoseconds in V8.
    // am[implements a-petta-speed-1105.goal] am[rests-on c-js-length-shrink-cost]
    while (tr.length > mark) {
      const e = tr.pop()!;
      if (e instanceof Var) e.ref = null;
      else if (e instanceof AttrUndo) e.v.attrs = e.old;
      else if (e instanceof GlobalUndo) {
        e.live = false;
        if (e.old === undefined) this.globals.delete(e.key);
        else this.globals.set(e.key, e.old);
      } else e();
    }
    // A tidy's record of the region above the top choicepoint holds only while that region stands (tidyTrail).
    // am[implements a-petta-speed-1105.memory.trail-values]
    const top = this.cps[this.cps.length - 1];
    if (top !== undefined && top.tidied > mark) {
      top.tidied = top.trailTop;
      this.tidySeen.delete(top);
    }
  }

  /**
   * Trail a b_setval of global `key`, whose value was `old`: backtracking to a choicepoint restores the value the key
   * had when the choicepoint was made, which the undo of the first assignment after it restores, so a later
   * assignment needs none while an undo recorded since the newest choicepoint was pushed is still on the trail; with
   * no choicepoint nothing is restored at all. A trail of every assignment held every value ever set: he_minimalmetta
   * kept 148 thousand under short-lived choicepoints.
   * am[implements a-petta-speed-1105.memory.trail-values]
   */
  trailGlobal(key: string, old: Term | undefined): void {
    const top = this.cps[this.cps.length - 1];
    if (top === undefined) return;
    const last = this.globalUndos.get(key);
    if (last !== undefined && last.live && last.serial >= top.serial) return;
    const e = new GlobalUndo(key, old, this.cpSerial);
    this.trail.push(e);
    this.globalUndos.set(key, e);
  }

  /**
   * After choicepoints went without backtracking (a cut, a determinate exit), drop the trail entries above the
   * choicepoint now on top that record bindings of variables made after it: backtracking to it never meets those
   * variables again, so the entries only kept them and their values alive. Undo actions stay. As WAM systems tidy the
   * trail on cut; a deterministic loop with if-then-else otherwise grows the trail by every binding it makes.
   * Time: the entries above the top choicepoint's mark.
   * am[implements a-petta-speed-1105.memory]
   */
  private tidyTrail(): void {
    const n = this.cps.length;
    if (n === 0) return;
    const top = this.cps[n - 1]!;
    const tr = this.trail;
    // What an earlier tidy against this choicepoint kept stays kept, so only newer entries are scanned: the entries
    // a tidy keeps (undo actions, older variables) are otherwise rescanned by every later cut.
    const from = Math.max(top.trailTop, Math.min(top.tidied, tr.length));
    const mark = top.varMark;
    // Of the b_setval undos above the top choicepoint only each key's first is needed, and of the attribute undos
    // only each variable's first: it restores what every choicepoint at or below the top saw. `seen` holds what the
    // region tidied before kept.
    // am[implements a-petta-speed-1105.memory.trail-values]
    let seen = this.tidySeen.get(top);
    let w = from;
    for (let r = from; r < tr.length; r++) {
      const e = tr[r]!;
      if (e instanceof Var && e.id >= mark) continue;
      if (e instanceof AttrUndo) {
        if (e.v.id >= mark) continue;
        if (seen === undefined) this.tidySeen.set(top, (seen = { keys: new Map(), vars: new Set() }));
        if (seen.vars.has(e.v)) continue;
        seen.vars.add(e.v);
      } else if (e instanceof GlobalUndo) {
        if (seen === undefined) this.tidySeen.set(top, (seen = { keys: new Map(), vars: new Set() }));
        const first = seen.keys.get(e.key);
        if (first !== undefined) {
          // trailGlobal's test now rests on the first undo, which stays on the trail.
          if (this.globalUndos.get(e.key) === e) this.globalUndos.set(e.key, first);
          continue;
        }
        seen.keys.set(e.key, e);
      }
      tr[w++] = e;
    }
    while (tr.length > w) tr.pop();
    top.tidied = w;
  }
  /** Per choicepoint, the b_setval undos by key and the variables with an attribute undo its tidied region keeps. */
  private readonly tidySeen = new WeakMap<CP, { keys: Map<string, GlobalUndo>; vars: Set<Var> }>();

  private pushCP(kind: K, next: Frame | null, cb: number, cc: number): CP {
    const vm = varCount();
    const cp = new CP(kind, this.trail.length, vm, next, cb, cc);
    cp.serial = ++this.cpSerial;
    this.cps.push(cp);
    this.trailBoundary = vm;
    return cp;
  }
  /** Choicepoints pushed so far (CP.serial). */
  private cpSerial = 0;

  cutTo(h: number): void {
    if (this.cps.length > h) {
      let cleanups: Term[] | null = null;
      for (let i = this.cps.length - 1; i >= h; i--) {
        const cp = this.cps[i]!;
        if (cp.kind === K.Cleanup) (cleanups ??= []).push(cp.recovery);
      }
      while (this.cps.length > h) this.cps.pop();
      this.trailBoundary = h > 0 ? this.cps[h - 1]!.varMark : 0;
      this.tidyTrail();
      if (cleanups !== null) for (const c of cleanups) this.runCleanup(c);
    }
  }

  /** Run a setup_call_cleanup cleanup goal once; its failure or error does not affect the caller. */
  private runCleanup(goal: Term): void {
    try {
      this.solveOnce(goal);
    } catch (e) {
      if (!(e instanceof PrologError)) throw e;
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
        if (y instanceof Var) {
          // SWI-Prolog binds a plain variable to an attributed one whatever their ages, waking nothing, and otherwise
          // the younger to the older, waking the younger's attributes (c-attvar-bind-swi-1106).
          // am[rests-on c-attvar-bind-swi-1106]
          const xa = x.attrs !== null && x.attrs.size > 0;
          const ya = y.attrs !== null && y.attrs.size > 0;
          if (xa !== ya) this.bind(xa ? y : x, xa ? x : y);
          else if (y.id > x.id) this.bindAttr(y, x);
          else this.bindAttr(x, y);
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

  /** bindAttr for compiled heads (compile.ts). */
  bindVar(v: Var, t: Term): void {
    this.bindAttr(v, t);
  }

  /**
   * Bind, waking each attribute's attr_unify_hook(Value, Other) as SWI does after the unification. Undoing a trailed
   * binding drops the wakeups it queued, so a failed try inside a builtin's generator (eachCandidate) leaves none
   * queued for the next solution, as a failed unification in SWI wakes nothing.
   * am[implements a-obj-stale-wakeup-1107]
   */
  private bindAttr(v: Var, t: Term): void {
    const tl = this.trail.length;
    this.bind(v, t);
    const a = v.attrs;
    if (a === null || a.size === 0) return;
    const w = this.wakeups, n = w.length;
    for (const [mod, val] of a) w.push(mkStruct("$attr_unify_hook", mod, val, t));
    // An untrailed binding is never undone, and a queue flushed or swapped since holds none of these.
    if (this.trail.length > tl)
      this.trail.push(() => {
        if (this.wakeups === w && w.length > n) w.length = n;
      });
  }

  /**
   * put_attr/3: backtrackable. A variable without attributes is bound to a fresh variable carrying the attribute, as
   * SWI makes a new attributed variable, so attributed variables are ordered by when they became attributed, which
   * decides which of two is bound and whose hook wakes (unify).
   * am[addresses i-obj-attvar-age-1106] am[rests-on c-swi-attvar-age-1106]
   */
  putAttr(v: Var, mod: string, val: Term): void {
    const old = v.attrs;
    if (old === null) {
      const nv = mkVar();
      nv.attrs = new Map([[mod, val]]);
      this.bind(v, nv);
      return;
    }
    // A variable newer than the newest choicepoint is unreachable from any state backtracking returns to, so its
    // attributes change in place with nothing to restore, as bind leaves such a variable off the trail.
    // am[implements a-petta-speed-1105.memory.trail-values]
    if (v.id >= this.trailBoundary) {
      old.set(mod, val);
      return;
    }
    const next = new Map(old);
    next.set(mod, val);
    v.attrs = next;
    this.trail.push(new AttrUndo(v, old));
  }

  delAttr(v: Var, mod: string): void {
    const old = v.attrs;
    if (old === null || !old.has(mod)) return;
    if (v.id >= this.trailBoundary) {
      old.delete(mod);
      if (old.size === 0) v.attrs = null;
      return;
    }
    const next = new Map(old);
    next.delete(mod);
    v.attrs = next.size > 0 ? next : null;
    this.trail.push(new AttrUndo(v, old));
  }

  /** Run the hooks woken since the last goal before the continuation. */
  private flushWakeups(): void {
    const w = this.wakeups;
    this.wakeups = [];
    let goal: Term = w[w.length - 1]!;
    for (let i = w.length - 2; i >= 0; i--) goal = mkStruct(",", w[i]!, goal);
    this.goals = new Frame(goal, this.goals, this.cps.length, this.curCC);
  }

  // ---- clause renaming ----

  /** A stored template with its slots read from `vars` (a fresh variable for a slot not yet set) and its ground parts copied. */
  inst(t: Term, vars: (Term | undefined)[]): Term {
    if (t instanceof Slot) {
      const v = vars[t.i];
      if (v !== undefined) return v;
      const nv = mkVar();
      vars[t.i] = nv;
      return nv;
    }
    if (t instanceof Ground) return copyLiteral(t.t);
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
    if (tpl instanceof Ground) return this.unifyLiteral(tpl.t, act);
    act = deref(act);
    if (act instanceof Var) {
      // An attributed variable's hooks wake, as unifyLiteral and compiled heads (bindVar) wake them.
      // am[addresses i-obj-head-wake-1106]
      this.bindAttr(act, this.inst(tpl, vars));
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

  /** unifyHead for one argument, for compiled heads whose template is too large to inline (compile.ts). */
  unifyHeadArg(tpl: Term, act: Term, vars: (Term | undefined)[]): boolean {
    return this.unifyHead(tpl, act, vars);
  }

  /** Unify a stored ground literal with a call argument; a call variable is bound to a copy of the literal's part. */
  unifyLiteral(lit: Term, act: Term): boolean {
    act = deref(act);
    if (act instanceof Var) {
      this.bindAttr(act, copyLiteral(lit));
      return true;
    }
    if (lit instanceof Cons) {
      if (!(act instanceof Cons)) return false;
      return this.unifyLiteral(lit.head, act.head) && this.unifyLiteral(lit.tail, act.tail);
    }
    if (lit instanceof Struct) {
      if (!(act instanceof Struct) || act.name !== lit.name || act.args.length !== lit.args.length) return false;
      for (let i = 0; i < lit.args.length; i++) if (!this.unifyLiteral(lit.args[i]!, act.args[i]!)) return false;
      return true;
    }
    return atomicEq(lit, act);
  }

  // ---- database interface ----

  /** assertz/asserta of a clause term `Head :- Body` or a fact. */
  addClause(clause: Term, atEnd: boolean): Clause {
    let head = unqualify(clause);
    let body: Term = "true";
    if (head instanceof Struct && head.name === ":-" && head.args.length === 2) {
      body = head.args[1]!;
      head = unqualify(head.args[0]!);
    }
    if (head instanceof Var) throw instantiationError();
    let name: string;
    let arity: number;
    if (typeof head === "string") [name, arity] = [head, 0];
    else if (head instanceof Struct) [name, arity] = [head.name, head.args.length];
    else throw typeError("callable", head);
    const pred = this.clausePred(name, arity);
    const c = compileClause(head, body);
    return this.addStoredClause(pred, shareHead(c.head), shareGround(c.body), c.nvars, atEnd);
  }

  /**
   * The predicate an asserted clause of name/arity joins, after the checks addClause makes: a protected builtin or a
   * library predicate refuses it, another builtin of the key is replaced, and the predicate is dynamic unless a
   * consult adds it.
   */
  clausePred(name: string, arity: number): Pred {
    const key = name + "/" + arity;
    // SWI protects ISO and boot-defined predicates; a user definition of any other builtin (plus/3, succ/2)
    // replaces it in the user module.
    if (this.builtins.has(key) && !PROTECTED.has(key)) this.removeBuiltin(key);
    if (this.builtins.has(key) || this.libraryPreds.has(key))
      throw new PrologError(
        mkStruct("error", mkStruct("permission_error", "modify", "static_procedure", mkStruct("/", name, arity)), mkVar()),
      );
    const pred = this.db.ensure(name, arity);
    // A clause a consult loads is static, as in SWI; assert makes the predicate dynamic.
    if (this.sourceFile === null) pred.dynamic = true;
    else pred.file ??= this.sourceFile;
    return pred;
  }

  /**
   * Add a clause already in the stored form (compileClause's slots, shareHead's and shareGround's holders) to `pred`,
   * as addClause does once it has converted the term; the cell engine converts its own (cell/clause.ts) and gives its
   * head's argument hashes (Database.addClause).
   */
  addStoredClause(pred: Pred, head: Term, body: Term, nvars: number, atEnd: boolean, argHashes?: Clause["argHashes"]): Clause {
    const cl = this.db.addClause(pred, head, body, nvars, atEnd, argHashes);
    cl.file = this.sourceFile;
    return cl;
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
    const key = name + "/" + arity;
    if (!this.builtins.has(key)) {
      const ar = this.builtinArities.get(name);
      if (ar === undefined) this.builtinArities.set(name, [arity]);
      else ar.push(arity);
    }
    this.builtins.set(key, b);
    const cell = this.cells.get(key);
    if (cell !== undefined) cell.builtin = b;
  }

  /** Remove a builtin, as a clause defining its name and arity does and as an image of such a state restores. */
  removeBuiltin(key: string): void {
    if (!this.builtins.delete(key)) return;
    const i = key.lastIndexOf("/");
    const ar = this.builtinArities.get(key.slice(0, i))!;
    ar.splice(ar.indexOf(Number(key.slice(i + 1))), 1);
    const cell = this.cells.get(key);
    if (cell !== undefined) cell.builtin = undefined;
  }

  /** Install a database an image rebuilt; procedure cells forget the predicates of the old one. */
  // am[implements a-petta-speed-1105.startup.image]
  replaceDatabase(db: Database): void {
    this.db = db;
    for (const c of this.cells.values()) c.pred = undefined;
  }

  /** How many host objects (streams) are registered. */
  objectCount(): number {
    return this.objects.length;
  }

  /** The cell compiled bodies call Name/Arity through. */
  procCell(name: string, arity: number): ProcCell {
    const key = predKey(name, arity);
    let c = this.cells.get(key);
    if (c === undefined) {
      c = new ProcCell(name, arity, key);
      c.builtin = this.builtins.get(key);
      this.cells.set(key, c);
    }
    return c;
  }

  // ---- the interface of compiled bodies (compile.ts) ----

  /** The choicepoint height now, which a cut back to it restores. */
  cpHeight(): number {
    return this.cps.length;
  }

  /**
   * Push the choicepoint an if-then-else (Alt), soft-cut (Soft) or negation (Not) pushes, its alternative the
   * body resuming at `r` (the activation's continuation when null); returns the height before it.
   */
  pushResumeCP(kind: "Alt" | "Soft" | "Not", r: Resume | null, f: Frame): number {
    const h = this.cps.length;
    const alt = r === null ? f.next : new Frame(r, f.next, f.cb, f.cc, f.vars);
    if (kind === "Not") this.pushCP(K.Not, alt, f.cb, f.cc);
    else this.pushCP(kind === "Alt" ? K.Alt : K.Soft, f.next, f.cb, f.cc).alt = alt;
    return h;
  }

  /** The commit of a soft-cut whose choicepoint is at `i` ($softcut). */
  // am[implements a-hp-cp-parity]
  softCut(i: number): void {
    const cp = this.cps[i];
    if (cp !== undefined && cp.kind === K.Soft) {
      // A condition that left no choicepoint has no more solutions, so the else branch goes now, as in SWI.
      if (i === this.cps.length - 1) this.cutTo(i);
      else cp.disabled = true;
    }
  }

  /** Return to the run loop before the step at `r`, so attribute hooks woken by a binding run first. */
  suspend(f: Frame, r: Resume | null): boolean {
    if (r !== null) this.goals = new Frame(r, f.next, f.cb, f.cc, f.vars);
    return true;
  }

  /**
   * findall/3 in a compiled body: the choicepoint that collects the goal's solutions and, once the goal has none
   * left, unifies the list and resumes the body at `r`; returns its height. As step's findall/3.
   */
  pushFindall(template: Term, list: Term, r: Resume | null, f: Frame): number {
    const h = this.cps.length;
    const cp = this.pushCP(K.Findall, r === null ? f.next : new Frame(r, f.next, f.cb, f.cc, f.vars), f.cb, f.cc);
    cp.results = [];
    cp.template = template;
    cp.list = list;
    return h;
  }

  /** One solution of a findall goal: a copy of the template joins the results ($fa_collect). */
  faCollect(h: number): void {
    const cp = this.cps[h]!;
    cp.results!.push(copyTerm(cp.template, new Map(), true));
  }

  /**
   * call/N in a compiled body, as step runs it: the closure with the extra arguments added; a control construct goes
   * to step as an interpreted goal whose cut is local to it, anything else through callCell.
   */
  callN(g: Term, extra: Term[], f: Frame, r: Resume | null): 0 | 1 | 2 {
    const goal = addArgs(unqualify(g), extra);
    const name = typeof goal === "string" ? goal : (goal as Struct).name;
    const args = typeof goal === "string" ? EMPTY : (goal as Struct).args;
    if (STEP_CONTROL.has(predKey(name, args.length)) || (name === "call" && args.length > 1)) {
      this.goals = new Frame(goal, r === null ? f.next : new Frame(r, f.next, f.cb, f.cc, f.vars), this.cps.length, f.cc);
      return 2;
    }
    return this.callCell(this.procCell(name, args.length), args, f, r);
  }

  /**
   * Call `cell` from a compiled body as step() calls a resolved goal, the body to resume at `r` after it (its own
   * continuation when null): 1 when a det builtin succeeded and the body goes on inline, 2 when the continuation is
   * in `goals` and the body returns, 0 on failure.
   */
  callCell(cell: ProcCell, args: Term[], f: Frame, r: Resume | null): 0 | 1 | 2 {
    const key = cell.key;
    if (this.profile !== null) this.profile.set(key, (this.profile.get(key) ?? 0) + 1);
    const b = cell.builtin;
    if (b !== undefined) {
      if (b.det !== undefined) {
        const before = this.goals;
        if (!b.det(this, args)) return 0;
        if (this.goals !== before) {
          // The builtin pushed goals (call-like builtins do): the rest of this body runs after them.
          if (r !== null) this.goals = this.splice(this.goals, before, new Frame(r, f.next, f.cb, f.cc, f.vars));
          return 2;
        }
        if (this.wakeups.length !== 0) {
          this.suspend(f, r);
          return 2;
        }
        return 1;
      }
      if (b.detMode !== undefined) {
        const d = b.detMode(this, args);
        if (d !== null) {
          if (!d) return 0;
          if (this.wakeups.length !== 0) {
            this.suspend(f, r);
            return 2;
          }
          return 1;
        }
      }
      const next = r === null ? f.next : new Frame(r, f.next, f.cb, f.cc, f.vars);
      const h = this.cps.length;
      const cp = this.pushCP(K.Redo, next, f.cb, f.cc);
      cp.iter = b.nondet!(this, args);
      const res = cp.iter.next();
      if (res.done) {
        this.cutTo(h);
        if (res.value !== true) return 0;
      }
      this.goals = next;
      return 2;
    }
    if (this.tabled.size > 0 && this.tabled.has(key)) {
      const next = r === null ? f.next : new Frame(r, f.next, f.cb, f.cc, f.vars);
      if (!this.callTabled(cell.name, args, next, f.cb, f.cc)) return 0;
      this.goals = next;
      return 2;
    }
    let p = cell.pred ?? (cell.pred = this.db.preds.get(key));
    if (p === undefined && this.autoload !== null && this.autoload(cell.name, cell.arity)) p = cell.pred = this.db.preds.get(key);
    if (p !== undefined) {
      const scan = clauseScan(p, args);
      return this.tryClauses(scan, scan.start, this.db.generation, args, null, f.cc, null, f, r);
    }
    if (this.flags.get("unknown") === "fail") return 0;
    throw existenceError("procedure", mkStruct("/", cell.name, cell.arity));
  }

  /** `top` with the frames it has before reaching `old` rebuilt to end in `tail` instead: they are fresh, so nothing else holds them. */
  private splice(top: Frame | null, old: Frame | null, tail: Frame): Frame {
    const pushed: Frame[] = [];
    for (let x = top; x !== old; x = x.next) {
      if (x === null) throw new Error("internal: pushed goals do not end in the continuation");
      pushed.push(x);
    }
    let out = tail;
    for (let i = pushed.length - 1; i >= 0; i--) {
      const x = pushed[i]!;
      out = new Frame(x.goal, out, x.cb, x.cc, x.vars);
    }
    return out;
  }

  // ---- solving ----

  /** Install a thread of control's solver state and return the one it replaces. */
  private swapState(s: SolverState): SolverState {
    const old: SolverState = {
      goals: this.goals,
      cps: this.cps,
      trail: this.trail,
      trailBoundary: this.trailBoundary,
      curCC: this.curCC,
      wakeups: this.wakeups,
      globals: this.globals,
      globalUndos: this.globalUndos,
    };
    this.goals = s.goals;
    this.cps = s.cps;
    this.trail = s.trail;
    this.trailBoundary = s.trailBoundary;
    this.curCC = s.curCC;
    this.wakeups = s.wakeups;
    this.globals = s.globals;
    this.globalUndos = s.globalUndos;
    return old;
  }

  /** A fiber solving `goal` on its own goal stack, choicepoints, trail and globals, sharing the clause database. */
  newFiber(goal: Term): Fiber {
    const saved = this.swapState({ goals: null, cps: [], trail: [], trailBoundary: 0, curCC: -1, wakeups: [], globals: new Map(), globalUndos: new Map() });
    try {
      this.pushCP(K.Barrier, null, 0, -1);
      this.goals = new Frame(goal, null, 1, -1);
      return { state: this.swapState(saved), solved: false };
    } catch (e) {
      this.swapState(saved);
      throw e;
    }
  }

  /**
   * Run a fiber for at most `steps` goals: "solution" when its goal is solved (its bindings are in place; the next
   * run backtracks into it for another), "failed" when it has no more, "suspended" when the slice ran out. An
   * uncaught error in the fiber propagates to the caller, as an error in a concurrent_and worker does in SWI.
   * am[implements a-hp-concurrent]
   */
  runFiber(fb: Fiber, steps: number): "solution" | "failed" | "suspended" {
    const saved = this.swapState(fb.state);
    try {
      if (fb.solved) {
        fb.solved = false;
        if (!this.backtrack(1)) return "failed";
        if (this.wakeups.length > 0) this.flushWakeups();
      }
      let left = steps;
      for (;;) {
        try {
          for (;;) {
            const f = this.goals;
            if (f === null) {
              if (this.wakeups.length === 0) {
                fb.solved = true;
                return "solution";
              }
              this.flushWakeups();
              continue;
            }
            if (left-- <= 0) return "suspended";
            this.goals = f.next;
            if (this.step(f)) {
              if (this.wakeups.length > 0) this.flushWakeups();
            } else {
              if (this.wakeups.length !== 0) this.wakeups.length = 0;
              if (!this.backtrack(1)) return "failed";
              if (this.wakeups.length > 0) this.flushWakeups();
            }
          }
        } catch (e0) {
          const e = e0 instanceof PrologSyntaxError ? new PrologError(mkStruct("error", mkStruct("syntax_error", e0.message), mkVar())) : e0;
          if (!(e instanceof PrologError)) throw e;
          if (!this.handleThrow(e, 1)) throw e;
        }
      }
    } finally {
      fb.state = this.swapState(saved);
    }
  }

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

  /**
   * Solve a goal of the program once on the engine running it: the cell machine once one does (db.ts GoalEngine), here
   * before one does, as PeTTa's own sources load. A file loaded at run time and the top level's error message rules
   * come here, so no goal of a program run on cells meets the object machine, which has no stack limit
   * (c-obj-solves-on-cells-1108, i-obj-no-stack-limit-1107). Bindings persist on success.
   * am[implements a-petta-errors-fix-1108.stack.cells]
   */
  solveProgram(goal: Term): boolean {
    const engine = this.db.cellMachine;
    return engine !== null ? engine.solveTerm(goal) : this.solveOnce(goal);
  }

  /**
   * Solve `goal` for every solution, calling `each` after each one with whether a choicepoint of the goal remains;
   * `each` returning false stops.
   */
  solveAll(goal: Term, each: (hasChoice: boolean) => boolean | void): void {
    const savedGoals = this.goals;
    const savedCC = this.curCC;
    const b = this.cps.length;
    this.pushCP(K.Barrier, null, b, savedCC);
    this.goals = new Frame(goal, null, b + 1, savedCC);
    try {
      let ok = this.run(b + 1);
      while (ok) {
        if (each(this.cps.length > b + 1) === false) break;
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
          if (f === null) {
            if (this.wakeups.length === 0) return true;
            this.flushWakeups();
            continue;
          }
          this.goals = f.next;
          // A compiled body resumes here directly; step, the interpreter, takes every other goal.
          // am[implements a-petta-speed-1105.goal]
          const g = f.goal;
          let ok: boolean;
          if (g instanceof Resume) {
            this.curCC = f.cc;
            ok = g.fn(this, f, g.pc);
          } else ok = this.step(f);
          if (ok) {
            if (this.wakeups.length > 0) this.flushWakeups();
          } else {
            if (this.wakeups.length !== 0) this.wakeups.length = 0;
            if (!this.backtrack(base)) return false;
            if (this.wakeups.length > 0) this.flushWakeups();
          }
        }
      } catch (e0) {
        // A reader error inside a builtin (read_term/2 on bad text) is a Prolog syntax error the program can catch.
        const e = e0 instanceof PrologSyntaxError ? new PrologError(mkStruct("error", mkStruct("syntax_error", e0.message), mkVar())) : e0;
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
          // The choicepoint stays for the retry, which moves it on or pops it at the last candidate.
          if (this.tryClauses(cp.scan!, cp.idx, cp.gen, cp.args!, cp.next, cp.cc, cp) !== 0) return true;
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
            if (r.value === true) {
              this.goals = cp.next;
              return true;
            }
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
        case K.Cleanup:
          cps.pop();
          this.trailBoundary = cps.length > 0 ? cps[cps.length - 1]!.varMark : 0;
          this.runCleanup(cp.recovery);
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
    this.wakeups.length = 0;
    const ball = copyTerm(e.ball, new Map(), true);
    let c = this.curCC;
    while (c >= base) {
      const cp = this.cps[c];
      if (cp === undefined || cp.kind !== K.Catch) break;
      this.unwindTo(c);
      this.undoTo(cp.trailTop);
      const mark = this.trail.length;
      if (this.unify(cp.catcher, ball)) {
        this.goals = new Frame(cp.recovery, cp.next, cp.cb, cp.cc, cp.recVars);
        return true;
      }
      this.undoTo(mark);
      c = cp.cc;
    }
    // Not ours: unwind this run to its barrier so the caller resumes from a clean state.
    const bar = this.cps[base - 1];
    this.unwindTo(base);
    if (bar !== undefined) this.undoTo(bar.trailTop);
    // Rethrow the copied ball so bindings undone here cannot change it.
    if (ball !== e.ball) throw new PrologError(ball);
    return false;
  }

  /**
   * Pop the choicepoints from height `h` up as an exception passes them: each setup_call_cleanup cleanup on the way
   * runs with the bindings undone to its own setup, so it sees what its setup left and nothing its goal bound, as in
   * SWI, so setup_call_cleanup keeps its cleanup goal as it is instead of copying it.
   * am[implements a-petta-speed-1105.goal] am[rests-on c-scc-cleanup-bindings]
   */
  private unwindTo(h: number): void {
    while (this.cps.length > h) {
      const cp = this.cps.pop()!;
      this.trailBoundary = this.cps.length > 0 ? this.cps[this.cps.length - 1]!.varMark : 0;
      if (cp.kind === K.Cleanup) {
        this.undoTo(cp.trailTop);
        this.runCleanup(cp.recovery);
      }
    }
  }

  /**
   * Try the clauses of `scan` from `start` that are visible at `gen` and that its key admits; after a match a
   * choicepoint stays only if another admitted clause follows within SWI's lookahead (pl-index.c
   * next_clause_primary_index), so the last candidate leaves none, as in SWI.
   * A retry passes the call's choicepoint, on top of the stack: it is moved on to the next alternative in place, as
   * the WAM's retry instruction does, or popped before the last candidate is tried.
   *
   * A call from a compiled body passes its activation `caller` and resume point `r` instead of `next`: the
   * continuation is then built only when a choicepoint or the clause's body keeps it, and a fact's success returns 1,
   * so the body goes on inline as after a deterministic builtin; a choicepoint left behind holds the built
   * continuation, which a retry resumes. Returns 0 on failure, 2 when `goals` holds the continuation.
   * am[implements a-hp-swi-clause-select]
   */
  private tryClauses(
    scan: Scan,
    start: number,
    gen: number,
    args: Term[],
    next: Frame | null,
    cc: number,
    retry: CP | null = null,
    caller: Frame | null = null,
    r: Resume | null = null,
  ): 0 | 1 | 2 {
    let cp = retry;
    // am[implements a-petta-speed-1105.goal.lazy-cont]
    let built = caller === null;
    const h = cp === null ? this.cps.length : this.cps.length - 1;
    const cands = scan.list;
    const len = cands.length;
    const key = scan.key;
    const keyAt = key === null ? null : scan.keyAt;
    // On a long scan, ground call arguments are hashed once so a clause whose ground head argument hashes apart is
    // passed over without a unification. The lookahead below still counts it, so choicepoints stay where SWI's do.
    const callHashes = cp !== null ? cp.hashes : len - start > 8 ? groundArgHashes(args) : null;
    const wl = this.wakeups.length;
    // With a ground call argument, the scan visits only the positions where that argument can match: those holding
    // its hash or a non-ground argument, from the argument with the fewest (db.ts ArgHashIndex). Positions are
    // skipped exactly when hashesDiffer would skip them, so the lookahead below sees what it saw before.
    // am[implements a-petta-speed-1105.outliers.spaces]
    let posA: number[] | null = null;
    let posB: number[] = EMPTY_POS;
    let ia = 0;
    let ib = 0;
    if (callHashes !== null) {
      let best = Infinity;
      for (let p = 0; p < callHashes.length; p++) {
        const hp = callHashes[p];
        if (hp === null || hp === undefined) continue;
        const ix = argHashIndex(cands, p);
        const b = ix.byHash.get(hp);
        const a = b === undefined ? EMPTY_POS : typeof b === "number" ? [b] : b;
        const n = a.length + ix.open.length;
        if (n < best) {
          best = n;
          posA = a;
          posB = ix.open;
        }
      }
      if (posA !== null) {
        ia = lowerBound(posA, start);
        ib = lowerBound(posB, start);
      }
    }
    for (let i = start; i < len; i++) {
      if (posA !== null) {
        while (ia < posA.length && posA[ia]! < i) ia++;
        while (ib < posB.length && posB[ib]! < i) ib++;
        const na = ia < posA.length ? posA[ia]! : len;
        const nb = ib < posB.length ? posB[ib]! : len;
        i = na < nb ? na : nb;
        if (i >= len) break;
      }
      const c = cands[i]!;
      if (this.profile !== null) {
        const pk = "#" + c.pred.name + "/" + c.pred.arity;
        this.profile.set(pk, (this.profile.get(pk) ?? 0) + 1);
      }
      if (c.born > gen || c.died <= gen) continue;
      if (keyAt !== null) {
        const k = keyAt(c);
        if (k !== null && k !== key) continue;
      }
      if (callHashes !== null && hashesDiffer(callHashes, c)) continue;
      let j = i + 1;
      for (let budget = MAX_LOOKAHEAD; j < len; j++) {
        const d = cands[j]!;
        if (d.born <= gen && d.died > gen) {
          if (keyAt === null) break;
          const k = keyAt(d);
          if (k === null || k === key) break;
        }
        if (--budget === 0) break;
      }
      if (j < len) {
        if (cp === null) {
          if (!built) {
            next = r === null ? caller!.next : new Frame(r, caller!.next, caller!.cb, caller!.cc, caller!.vars);
            built = true;
          }
          cp = this.pushCP(K.Clauses, next, h, cc);
          cp.scan = scan;
          cp.gen = gen;
          cp.args = args;
          cp.hashes = callHashes;
        } else this.trailBoundary = cp.varMark = varCount();
        cp.idx = j;
      } else if (cp !== null) {
        // The last candidate leaves no choicepoint.
        this.cps.pop();
        this.trailBoundary = this.cps.length > 0 ? this.cps[this.cps.length - 1]!.varMark : 0;
        cp = null;
      }
      const mark = this.trail.length;
      // am[implements a-petta-speed-1105.goal]
      let code = c.code;
      if (code === null && ++c.entries >= COMPILE_AFTER) code = c.code = compileClauseCode(this, c, RUNTIME);
      const nv = code !== null ? code.nslots : c.nvars;
      const vars: (Term | undefined)[] = nv === 0 ? NO_VARS : new Array(nv);
      let ok = true;
      if (code !== null) ok = code.head(this, args, vars);
      else {
        const head = c.head;
        if (head instanceof Struct)
          for (let k = 0; k < args.length; k++)
            if (!this.unifyHead(head.args[k]!, args[k]!, vars)) {
              ok = false;
              break;
            }
      }
      if (ok) {
        const body = c.body;
        if (body !== "true") {
          // Every body variable exists before the body runs, so its bindings are trailed against the
          // body's own choicepoints and a shared frame never meets a variable from a failed branch; a compiled
          // head has made them already, all but the slots its body assigns a value to directly (compile.ts
          // freshOutputs), which are never variables.
          if (code === null) for (let k = 0; k < c.nvars; k++) if (vars[k] === undefined) vars[k] = mkVar();
          if (!built) next = r === null ? caller!.next : new Frame(r, caller!.next, caller!.cb, caller!.cc, caller!.vars);
          this.goals = new Frame(code !== null ? code.entry! : body, next, h, cc, vars);
          return 2;
        }
        if (caller === null) {
          this.goals = next;
          return 2;
        }
        // Hooks the head woke run before the body goes on (callCell does the same after a builtin).
        if (this.wakeups.length !== 0) {
          this.suspend(caller, r);
          return 2;
        }
        return 1;
      }
      this.undoTo(mark);
      // Hooks a failed head unification woke belong to bindings it undid.
      if (this.wakeups.length !== wl) this.wakeups.length = wl;
      i = j - 1;
    }
    if (cp !== null) {
      this.cps.pop();
      this.trailBoundary = this.cps.length > 0 ? this.cps[this.cps.length - 1]!.varMark : 0;
    }
    return 0;
  }

  /** Execute one goal. Returns false on failure; may replace the continuation and push choicepoints. */
  private step(f: Frame): boolean {
    const g0 = f.goal;
    if (g0 instanceof Resume) {
      this.curCC = f.cc;
      return g0.fn(this, f, g0.pc);
    }
    this.curCC = f.cc;
    let g = g0;
    let vars = f.vars;
    if (vars !== null) {
      if (g instanceof Slot) {
        g = deref(vars[g.i] ?? (vars[g.i] = mkVar()));
        vars = null;
      } else if (g instanceof Ground) {
        g = copyLiteral(g.t);
        vars = null;
      }
    } else g = deref(g);
    const real = (t: Term): Term => (vars !== null ? this.inst(t, vars) : t);
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
          this.softCut(deref(args[0]!) as number);
          return true;
        }
        if (name === "$nafail") {
          this.cutTo(deref(args[0]!) as number);
          return false;
        }
        if (name === "$scc_exit") {
          // A determinate exit (nothing left above the cleanup choicepoint) runs the cleanup now.
          const h = deref(args[0]!) as number;
          const cp = this.cps[h];
          if (cp !== undefined && cp.kind === K.Cleanup && this.cps.length === h + 1) {
            this.cps.pop();
            this.trailBoundary = this.cps.length > 0 ? this.cps[this.cps.length - 1]!.varMark : 0;
            this.tidyTrail();
            this.runCleanup(cp.recovery);
          }
          return true;
        }
        if (name === "$fa_collect") {
          const cp = this.cps[deref(args[0]!) as number]!;
          cp.results!.push(copyTerm(cp.template, new Map(), true));
          return false;
        }
        if (name === "$catch_exit") {
          // A determinate exit of the catch goal leaves nothing to re-enter: the catch frame goes.
          const h = deref(args[0]!) as number;
          const cp = this.cps[h];
          if (cp !== undefined && cp.kind === K.Catch && this.cps.length === h + 1) {
            this.cps.pop();
            this.trailBoundary = this.cps.length > 0 ? this.cps[this.cps.length - 1]!.varMark : 0;
            this.tidyTrail();
          }
          return true;
        }
        if (name === "\\+") {
          const h = this.cps.length;
          this.pushCP(K.Not, f.next, f.cb, f.cc);
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$nafail", h), null, h + 1, f.cc), h + 1, f.cc, vars);
          return true;
        }
        if (name === "call") {
          this.goals = new Frame(args[0]!, f.next, this.cps.length, f.cc, vars);
          return true;
        }
        if (name === "once") {
          const h = this.cps.length;
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$cut", h), f.next, f.cb, f.cc), h, f.cc, vars);
          return true;
        }
        if (name === "ignore") {
          const h = this.cps.length;
          const alt = this.pushCP(K.Alt, f.next, f.cb, f.cc);
          alt.alt = f.next;
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$cut", h), f.next, f.cb, f.cc), h + 1, f.cc, vars);
          return true;
        }
        if (name === "throw") {
          const ball = deref(real(args[0]!));
          if (ball instanceof Var) throw instantiationError();
          throw new PrologError(copyTerm(ball, new Map(), true));
        }
        if (name === "halt") {
          const st = deref(real(args[0]!));
          throw new Halt(typeof st === "number" ? st : 0);
        }
        break;
      case 2:
        if (name === ",") {
          this.goals = new Frame(args[0]!, new Frame(args[1]!, f.next, f.cb, f.cc, vars), f.cb, f.cc, vars);
          return true;
        }
        if (name === ";") return this.disjunction(args[0]!, args[1]!, f, vars);
        if (name === "->") {
          const h = this.cps.length;
          this.goals = new Frame(
            args[0]!,
            new Frame(mkStruct("$cut", h), new Frame(args[1]!, f.next, f.cb, f.cc, vars), f.cb, f.cc),
            h,
            f.cc,
            vars,
          );
          return true;
        }
        if (name === "*->") {
          this.goals = new Frame(args[0]!, new Frame(args[1]!, f.next, f.cb, f.cc, vars), this.cps.length, f.cc, vars);
          return true;
        }
        if (name === "call_cleanup") return this.setupCallCleanup("true", real(args[0]!), real(args[1]!), f);
        if (name === "forall") {
          const g2 = mkStruct("\\+", mkStruct(",", args[0]!, mkStruct("\\+", args[1]!)));
          this.goals = new Frame(g2, f.next, f.cb, f.cc, vars);
          return true;
        }
        break;
      case 3:
        if (name === "findall") {
          const h = this.cps.length;
          const cp = this.pushCP(K.Findall, f.next, f.cb, f.cc);
          cp.results = [];
          cp.template = real(args[0]!);
          cp.list = real(args[2]!);
          this.goals = new Frame(args[1]!, new Frame(mkStruct("$fa_collect", h), null, h + 1, f.cc), h + 1, f.cc, vars);
          return true;
        }
        if (name === "setup_call_cleanup") return this.setupCallCleanup(real(args[0]!), real(args[1]!), real(args[2]!), f);
        if (name === "catch") {
          const h = this.cps.length;
          const cp = this.pushCP(K.Catch, f.next, f.cb, f.cc);
          cp.catcher = real(args[1]!);
          cp.recovery = args[2]!;
          cp.recVars = vars;
          this.goals = new Frame(args[0]!, new Frame(mkStruct("$catch_exit", h), f.next, f.cb, f.cc), h + 1, h, vars);
          return true;
        }
        break;
    }
    if (vars !== null) args = args.map((a) => this.inst(a, vars));
    if (name === "call" && args.length > 1) {
      // call(M:G, A...) adds A... to G: one module, so the qualification names nothing.
      const goal = addArgs(unqualify(args[0]!), args.slice(1));
      this.goals = new Frame(goal, f.next, this.cps.length, f.cc);
      return true;
    }
    const key = predKey(name, args.length);
    if (this.profile !== null) this.profile.set(key, (this.profile.get(key) ?? 0) + 1);
    const b = this.builtins.get(key);
    if (b !== undefined) {
      if (b.det !== undefined) {
        if (!b.det(this, args)) return false;
        // A det builtin may have replaced the continuation (e.g. by pushing goals); keep it if so.
        return true;
      }
      if (b.detMode !== undefined) {
        const r = b.detMode(this, args);
        if (r !== null) return r;
      }
      const h = this.cps.length;
      const cp = this.pushCP(K.Redo, f.next, f.cb, f.cc);
      cp.iter = b.nondet!(this, args);
      const r = cp.iter.next();
      if (r.done) {
        this.cutTo(h);
        return r.value === true;
      }
      return true;
    }
    if (this.tabled.size > 0 && this.tabled.has(key)) return this.callTabled(name, args, f.next, f.cb, f.cc);
    const p = this.db.preds.get(key);
    if (p !== undefined) {
      const scan = clauseScan(p, args);
      return this.tryClauses(scan, scan.start, this.db.generation, args, f.next, f.cc) !== 0;
    }
    // An undefined predicate a library exports loads that library and is called (SWI's autoloader).
    if (this.autoload !== null && this.autoload(name, args.length)) {
      const p2 = this.db.preds.get(key);
      if (p2 !== undefined) {
        const scan = clauseScan(p2, args);
        return this.tryClauses(scan, scan.start, this.db.generation, args, f.next, f.cc) !== 0;
      }
    }
    if (this.flags.get("unknown") === "fail") return false;
    throw existenceError("procedure", mkStruct("/", name, args.length));
  }

  /**
   * A call to a `:- table` predicate: the first call of a variant completes its answers (distinct up to
   * variance) by solving the clauses directly; later calls, and a recursive call while the first is running,
   * answer from the table. Time: one full evaluation per distinct variant.
   */
  private callTabled(name: string, args: Term[], next: Frame | null, cb: number, cc: number): boolean {
    const goal = new Struct(name, args);
    const vkey = variantKeyOf(goal);
    let answers = this.tables.get(vkey);
    if (answers === undefined) {
      answers = [];
      this.tables.set(vkey, answers);
      const g2 = copyTerm(goal) as Struct;
      const p = this.db.get(name, args.length);
      const collected: Term[] = [];
      if (p !== undefined) {
        const saved = this.tabled.delete(name + "/" + args.length);
        try {
          this.solveAll(g2, () => {
            const a = copyTerm(g2);
            if (!collected.some((x) => variantKeyOf(x) === variantKeyOf(a))) collected.push(a);
          });
        } finally {
          if (saved) this.tabled.add(name + "/" + args.length);
        }
      }
      answers.push(...collected);
    }
    const h = this.cps.length;
    const list = answers.slice();
    const self = this;
    const cp = this.pushCP(K.Redo, next, cb, cc);
    cp.iter = (function* () {
      for (const a of list) {
        if (self.unify(goal, copyTerm(a))) yield;
        self.undoTo(cp.trailTop);
      }
    })();
    const r = cp.iter.next();
    if (r.done) {
      this.cutTo(h);
      return false;
    }
    return true;
  }

  /** setup_call_cleanup/3: Setup once, Goal as often as it succeeds, Cleanup once when Goal is finished. */
  private setupCallCleanup(setup: Term, goal: Term, cleanup: Term, f: Frame): boolean {
    if (!this.solveOnce(setup)) return false;
    const h = this.cps.length;
    const cp = this.pushCP(K.Cleanup, f.next, f.cb, f.cc);
    // The cleanup runs on the goal as it stands: an exception undoes the goal's bindings before running it (unwindTo).
    cp.recovery = cleanup;
    this.goals = new Frame(goal, new Frame(mkStruct("$scc_exit", h), f.next, f.cb, f.cc), h + 1, f.cc);
    return true;
  }

  private disjunction(left: Term, right: Term, f: Frame, vars: Vars): boolean {
    let l: Term = left;
    let lv = vars;
    if (lv !== null) {
      if (l instanceof Slot) {
        l = deref(lv[l.i]!);
        lv = null;
      } else if (l instanceof Ground) {
        l = copyLiteral(l.t);
        lv = null;
      }
    } else l = deref(l);
    if (l instanceof Struct && l.args.length === 2 && (l.name === "->" || l.name === "*->")) {
      const h = this.cps.length;
      const soft = l.name === "*->";
      const cp = this.pushCP(soft ? K.Soft : K.Alt, f.next, f.cb, f.cc);
      cp.alt = new Frame(right, f.next, f.cb, f.cc, vars);
      const commit = soft ? mkStruct("$softcut", h) : mkStruct("$cut", h);
      this.goals = new Frame(
        l.args[0]!,
        new Frame(commit, new Frame(l.args[1]!, f.next, f.cb, f.cc, lv), f.cb, f.cc),
        h + 1,
        f.cc,
        lv,
      );
      return true;
    }
    const cp = this.pushCP(K.Alt, f.next, f.cb, f.cc);
    cp.alt = new Frame(right, f.next, f.cb, f.cc, vars);
    this.goals = new Frame(l, f.next, f.cb, f.cc, lv);
    return true;
  }

  /** Push `goal` to run next within a det builtin, as its continuation; cut inside it is local. */
  pushGoal(goal: Term): void {
    this.goals = new Frame(goal, this.goals, this.cps.length, this.curCC);
  }
}

/** A string identifying a term up to variable renaming, for table keys. */
export function variantKeyOf(t: Term): string {
  const names = new Map<Var, number>();
  const go = (x: Term): string => {
    x = deref(x);
    if (x instanceof Var) {
      let n = names.get(x);
      if (n === undefined) {
        n = names.size;
        names.set(x, n);
      }
      return "_" + n;
    }
    if (x instanceof Cons) return "[" + go(x.head) + "|" + go(x.tail) + "]";
    if (x instanceof Struct) return x.name + "(" + x.args.map(go).join(",") + ")";
    if (x instanceof Str) return JSON.stringify(x.s);
    if (x instanceof Float) return "f" + x.v;
    if (x === NIL) return "[]";
    return typeof x + ":" + String(x);
  };
  return go(t);
}

/** The profile's busiest predicates by calls and by clause candidates examined, as lines for stderr. */
export function profileReport(m: Machine, top = 40): string {
  if (m.profile === null) return "";
  const rows = [...m.profile].sort((a, b) => b[1] - a[1]);
  const calls = rows.filter(([k]) => !k.startsWith("#")).slice(0, top);
  const scans = rows.filter(([k]) => k.startsWith("#")).slice(0, top);
  return ["% calls", ...calls.map(([k, n]) => `${n}\t${k}`), "% clause candidates", ...scans.map(([k, n]) => `${n}\t${k.slice(1)}`)].join("\n") + "\n";
}

/** "Name/Arity", interned per name and arity, so dispatching a goal builds no string. */
const predKeys = new Map<string, string[]>();
export function predKey(name: string, arity: number): string {
  let byArity = predKeys.get(name);
  if (byArity === undefined) predKeys.set(name, (byArity = []));
  return (byArity[arity] ??= name + "/" + arity);
}

/** groundHash of each call argument, or null when no argument is ground (nothing to compare). */
function groundArgHashes(args: Term[]): (number | null)[] | null {
  let any = false;
  const out = args.map((a) => {
    const h = groundHash(a);
    if (h !== null) any = true;
    return h;
  });
  return any ? out : null;
}

/** Whether some argument is ground on both sides with different hashes, so the head cannot unify. */
function hashesDiffer(call: (number | null)[], c: Clause): boolean {
  for (let k = 0; k < call.length; k++) {
    const a = call[k];
    if (a === null || a === undefined) continue;
    const b = clauseArgHash(c, k);
    if (b !== null && a !== b) return true;
  }
  return false;
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
/**
 * A copy of term t with fresh variables, `map` taking each variable met to its copy. With `attrs`, an attributed
 * variable's copy gets its attributes, their values copied through the same map, as SWI's copy_term/2, findall/3 and
 * caught balls keep them; without, the copies are plain, as assert and copy_term/3's copy are (c-swi-attr-copies-1106).
 * Time: the term's size, with its attribute values when `attrs`.
 * am[addresses i-obj-copy-drops-attrs-1106] am[rests-on c-swi-attr-copies-1106]
 */
export function copyTerm(t: Term, map: Map<Var, Var> = new Map(), attrs = false): Term {
  t = deref(t);
  if (t instanceof Var) {
    let v = map.get(t);
    if (v === undefined) {
      v = mkVar();
      map.set(t, v);
      if (attrs && t.attrs !== null) {
        const copied = new Map<string, Term>();
        for (const [mod, val] of t.attrs) copied.set(mod, copyTerm(val, map, true));
        v.attrs = copied;
      }
    }
    return v;
  }
  if (t instanceof Cons) {
    const first = new Cons(copyTerm(t.head, map, attrs), NIL);
    let last = first;
    let rest = deref(t.tail);
    while (rest instanceof Cons) {
      const cell = new Cons(copyTerm(rest.head, map, attrs), NIL);
      last.tail = cell;
      last = cell;
      rest = deref(rest.tail);
    }
    last.tail = copyTerm(rest, map, attrs);
    return first;
  }
  if (t instanceof Struct) return new Struct(t.name, t.args.map((a) => copyTerm(a, map, attrs)));
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
