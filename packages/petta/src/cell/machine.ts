// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the cell engine's control. Environments and choicepoints live on one Int32Array stack whose every slot is a
// cell or a number, continuations are code ids a trampoline runs, and a call selects its clauses with swi-index.ts
// over the argument registers (CellArgs) and tries them in the candidate loop with SWI's lookahead, so choicepoints
// stay where SWI leaves them. Clauses run as code the clause compiler (compile.ts) makes from the database's templates,
// which the object machine it wraps also reads. The control's shape is the object core's (commit 9934828), cells in
// place of objects (c-cell-control-design-1106). At a call port the heap is collected once it has grown by what it
// held, the roots being the registers, the stack's frames and the cells JS frames hold across nested solves.
// am[implements a-petta-cell-store.control]

import { argHashIndex, clauseArgHash, type Clause, type Pred } from "../db";
import { copyTerm, variantKeyOf, type Builtin, type Machine } from "../machine";
import { MAX_LOOKAHEAD, clauseScan, type Scan } from "../swi-index";
import { Halt, NIL, PrologError, Struct, existenceError, instantiationError, mkList, typeError, type Term, type Var } from "../terms";
import { CellArgs } from "./args";
import { bridgeBuiltin, nextSolution, objectTrailMark, startNondet, takeSolution, type BridgeRun } from "./bridge";
import { build, headProgram, runHead, type HeadProgram } from "./headprog";
import { ATM, ATV, BOX, GLOBAL_SLOTS, HEAP_CELLS, Heap, INT, REF, STR, type TrailState, type Wakeup } from "./heap";

/** Code the trampoline runs: the code to run next, or null at a run's exit. */
export type Code = () => Code | null;

/** What compiled clause code returns when its head does not unify. */
export const HEADFAIL = Object.freeze({ headFailed: true }) as unknown as Code;

/** Choicepoint kinds at S[b + 1]. */
export const K_CLAUSES = 0;
export const K_ALT = 1;
/** A nondeterministic builtin's generator (bridge.ts): SO[b] its run, S[b + 7] the object trail mark. */
export const K_BRIDGE = 2;
/** catch/3's choicepoint: the catcher and recovery saved as its arguments, S[b + 6] the catch context outside it. */
export const K_CATCH = 3;
/** setup_call_cleanup/3's choicepoint: its cleanup goal saved as its argument (Machine.setupCallCleanup). */
export const K_CLEANUP = 4;
/**
 * concurrent_and/2,3's choicepoint: SO[b] its fiber group, and its argument area the control stacks of the group's
 * workers, so cutting or exhausting it frees them.
 */
export const K_FIBERS = 5;
export const K_BARRIER = 7;

// Registers, as indexes of R: E, CP, B, CC, the run's barrier, the cut barrier a clause is entered with.
export const RE = 0;
export const RCP = 1;
export const RB = 2;
export const RCC = 3;
export const RBAR = 4;
export const RB0 = 6;

/** An environment at e: S[e] CE, S[e+1] CP, S[e+2] cut barrier, S[e+3] slot count, S[e+4] catch context, cells after. */
export const ENV = 5;
/**
 * A choicepoint at b: S[b] previous, S[b+1] kind, S[b+2] trail top, S[b+3] E, S[b+4] CP, S[b+5] cut barrier,
 * S[b+6] catch context, S[b+7] next candidate, S[b+8] the alternative's code id, S[b+9] heap top, S[b+10] the saved
 * argument count, the argument cells after; SO[b], SO[b+1] and SO[b+2] a Clauses choicepoint's scan, predicate and
 * call argument hashes, GEN[b] its generation.
 */
export const CPH = 11;

/**
 * Calls a run nests on the JS stack before bouncing through the trampoline (callLater). Each nesting adds four frames
 * (callLater, callw, tryClauses, the clause) that unwind together at the bounce; 4 keep that within the CPU's return
 * stack predictor while paying the trampoline's indirect call once per 4 calls: against no nesting, 4 runs eloop and
 * nloop in 9% and 6% fewer instructions at equal or lower time, where 64 cut eloop's instructions as much but took
 * 15% longer (c-nest-bound-1106).
 */
const NEST = 4;
/**
 * Tries before a fact gets generated code; until then its head runs from its head program, which V8 need not compile
 * (c-cold-plan-facts-1106). The object engine compiles a clause on the same try (machine.ts COMPILE_AFTER).
 */
const COMPILE_AFTER = 32;
/**
 * Control stack cells: environments and choicepoints. A frame that would pass the end fails the run hard, as a full
 * heap does, where a typed array would drop the writes (i-cell-bounds-unchecked-1106).
 * am[implements a-petta-cell-store.control.bounds]
 */
const S_LIMIT = 1 << 24;
/**
 * Heap cells a run may grow by between collections however little the last one kept: 16 MB, so short runs never
 * collect (a-petta-cell-store.gc.trigger).
 */
const GC_MIN_GROWTH = 1 << 22;
/**
 * The heap cells a runtime box weighs in the collector's schedule: hyperpose_primes held about 80 bytes of V8 heap
 * per box made between collections (c-box-weight-1107), so numeric loops whose results are boxed collect though the
 * heap barely grows, and a large live heap still waits for as much growth as it holds.
 */
const BOX_CELLS = 20;
/** Control stack cells each concurrent_and worker gets in its choicepoint's area. */
const FIBER_S = 1 << 18;
/** Trampoline bounces a worker runs before the next takes its turn, as the object machine's workers run SLICE goals. */
const SLICE = 2000;

/**
 * A computation's state beyond its stack frames: registers, the arguments of a call left pending for the trampoline
 * (callLater), which a slice can end on, heap array, trail, queue, and where its stack must end.
 * am[implements a-cell-fiber-args-1107]
 */
interface Ctx {
  readonly R: Int32Array;
  readonly A: Int32Array;
  readonly h: Int32Array;
  readonly boxes: unknown[];
  readonly top: number;
  readonly hb: number;
  readonly frozen: number;
  readonly trail: TrailState;
  readonly wakeups: Wakeup[];
  readonly nest: number;
  readonly pend: CellProc | null;
  readonly pendN: number;
  readonly pendCC: number;
  readonly cleanups: number;
  readonly result: boolean;
  readonly sLimit: number;
  readonly inFiber: boolean;
  readonly roots: number[];
  readonly gcAt: number;
}

/**
 * A concurrent_and worker: its state while another runs, the code it goes on with and its barrier; its pair, on its
 * own heap, is its context's first root, so its collections move it (gc).
 */
interface Fiber {
  ctx: Ctx;
  next: Code | null;
  solved: boolean;
  readonly bar: number;
}

/** A concurrent_and call's workers in turn order, the next to run, and the caller's Generator-Test pair cell. */
interface FiberGroup {
  readonly workers: Fiber[];
  i: number;
  pair: number;
}
/** The goals the meta-call interpreter runs itself (goal) when call/N builds one. */
const CONTROL = new Set([",/2", ";/2", "->/2", "*->/2", "\\+/1", "call/1", "once/1", "ignore/1", "forall/2"]);

/** A clause not yet compiled: its head and body programs and how often it has been tried. */
interface ColdFact {
  readonly prog: HeadProgram;
  tries: number;
}

const EMPTY_POS: number[] = [];

/** The first index of ascending `a` holding a value at least x. Time: log of a's length. */
function lowerBound(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether some argument is ground on both sides with different hashes, so the head cannot unify (Machine's hashesDiffer). */
function hashesDiffer(call: (number | null)[], c: Clause): boolean {
  for (let k = 0; k < call.length; k++) {
    const a = call[k];
    if (a === null || a === undefined) continue;
    const b = clauseArgHash(c, k);
    if (b !== null && a !== b) return true;
  }
  return false;
}

/** An error leaving a solve with its ball copied, attributes kept, as the object machine copies its balls. */
function copiedBall(e: unknown): unknown {
  return e instanceof PrologError ? new PrologError(copyTerm(e.ball, new Map(), true)) : e;
}

/** A procedure as compiled code calls it: the predicate once one exists, or a native builtin over cells. */
export class CellProc {
  pred: Pred | undefined = undefined;
  /** A native deterministic builtin over the argument registers: true on success. */
  det: ((cm: CellMachine, n: number) => boolean) | undefined = undefined;
  /** A control builtin over the argument registers (call/N): the code to run next, as callw returns it. */
  ctl: ((cm: CellMachine, n: number, cc: number) => Code | null) | undefined = undefined;
  constructor(
    readonly name: string,
    readonly arity: number,
    readonly key: string,
  ) {}
}

/**
 * A clause's compiled code: with `pc` 0, from its head with cut barrier `b0` and catch context `cc`, the argument
 * registers holding the call; with another `pc`, resumed at that step of its body, its environment current.
 */
export type ClauseFn = (b0: number, cc: number, pc: number) => Code | null;

export class CellMachine {
  readonly hp = new Heap();
  readonly S = new Int32Array(S_LIMIT);
  readonly R = new Int32Array(8);
  /** Argument registers A[0..n): a call's argument cells. */
  readonly A = new Int32Array(256);
  /** Choicepoint data that is not a number: a Clauses choicepoint's scan and predicate. */
  readonly SO: unknown[] = [];
  readonly GEN = new Float64Array(S_LIMIT);
  /**
   * For each choicepoint, the trail index up to which a cut back to it has tidied (cutTo): what a tidy kept stays
   * kept, so a later cut to the same choicepoint scans only newer entries, where rescanning them made he_minimalmetta
   * spend 77% of its time tidying (Machine.tidyTrail keeps the same mark).
   */
  private readonly TIDIED = new Int32Array(S_LIMIT);
  readonly CODE: Code[] = [];
  /** The argument registers as clause selection reads them. */
  private readonly args: CellArgs;
  private readonly procs = new Map<string, CellProc>();
  /** The clause compiler (compile.ts), set by it, so this module does not import it. */
  compile: ((cm: CellMachine, c: Clause, hot: boolean) => ClauseFn) | null = null;
  private result = false;
  readonly OK: number;
  readonly NO: number;
  private readonly CALL: number;
  private readonly RETRY: number;
  /** Code that only fails on: a soft-cut gives it to its choicepoint, whose alternative may no longer run. */
  readonly FAILC: number;
  // The meta-call interpreter's continuations (goal): after a conjunction's left goal, a disjunction's or
  // if-then-else's other branch, an if-then-else's or soft-cut's condition, a negated goal, once/1's goal, and a
  // negation's choicepoint going on with the continuation it saved.
  private readonly CONJ: number;
  private readonly DISJ: number;
  private readonly ITE_THEN: number;
  private readonly ITE_SOFT: number;
  private readonly NOT: number;
  private readonly ONCE: number;
  private readonly PROCEED: number;
  private readonly CATCH_EXIT: number;
  private readonly SCC_EXIT: number;
  /** Cleanup choicepoints on the stack, so a cut or an unwind looks for them only when there are any. */
  private cleanups = 0;
  /** The choicepoint fail() last popped for an alternative, which the alternative's code reads its data from. */
  private lastAlt = 0;
  // Functor and atom cells the interpreter dispatches on.
  private readonly F_COMMA: number;
  private readonly F_SEMI: number;
  private readonly F_ARROW: number;
  private readonly F_SOFT: number;
  private readonly F_NOT: number;
  private readonly F_COLON: number;
  private readonly F_CALL1: number;
  private readonly F_ONCE: number;
  private readonly F_IGNORE: number;
  private readonly F_FORALL: number;
  /** '$attr_unify_hook'/3, the goal each woken attribute runs (consult.ts renames Module:attr_unify_hook/2 to it). */
  private readonly F_HOOK: number;
  private readonly A_TRUE: number;
  private readonly A_FAIL: number;
  private readonly A_FALSE: number;
  private readonly A_CUT: number;
  /** Procedures by functor id and by atom id, so a meta-call finds its procedure without building its key. */
  private readonly funProcs: (CellProc | undefined)[] = [];
  private readonly atomProcs: (CellProc | undefined)[] = [];
  private pend: CellProc | null = null;
  private pendN = 0;
  private pendCC = -1;
  /** Calls nested on the JS stack now (callLater). */
  private nest = 0;
  /** Head slots, of compiled heads (compile.ts) and cold facts' head programs (headprog.ts); grown to the most slots a clause has. */
  vals = new Int32Array(64);
  private readonly next = new Int32Array(1);
  /** Where the running computation's control stack must end: the stack's end, or a worker's area's end. */
  private sLimit = S_LIMIT;
  /** Whether a concurrent_and worker is running, which starts with no global variables (installGlobalBuiltins). */
  inFiber = false;
  /**
   * Cells a JS frame holds across a nested solve, which the collector marks and moves in place (hold).
   */
  roots: number[] = [];
  /** The heap used, its cells and its runtime boxes weighed (BOX_CELLS), from which a call port collects. */
  private gcAt = 1 + GLOBAL_SLOTS + GC_MIN_GROWTH;
  /** Cells the heap grows by between collections when fixed (collectEvery); null grows it by what the last kept. */
  private gcGrowth: number | null = null;

  constructor(readonly om: Machine) {
    if (om.db.cellMachine !== null) throw new Error("cell machine: a database has one cell machine, the clauses' code being bound to it");
    om.db.cellMachine = this;
    const def = (c: Code): number => this.CODE.push(c) - 1;
    this.OK = def(() => {
      this.result = true;
      return null;
    });
    this.NO = def(() => {
      this.result = false;
      return null;
    });
    this.CALL = def(() => this.callw(this.pend!, this.pendN, this.pendCC));
    this.FAILC = def(() => this.fail());
    const hp = this.hp;
    this.F_COMMA = hp.functor(",", 2);
    this.F_SEMI = hp.functor(";", 2);
    this.F_ARROW = hp.functor("->", 2);
    this.F_SOFT = hp.functor("*->", 2);
    this.F_NOT = hp.functor("\\+", 1);
    this.F_COLON = hp.functor(":", 2);
    this.F_CALL1 = hp.functor("call", 1);
    this.F_ONCE = hp.functor("once", 1);
    this.F_IGNORE = hp.functor("ignore", 1);
    this.F_FORALL = hp.functor("forall", 2);
    this.F_HOOK = hp.functor("$attr_unify_hook", 3);
    this.A_TRUE = hp.atom("true");
    this.A_FAIL = hp.atom("fail");
    this.A_FALSE = hp.atom("false");
    this.A_CUT = hp.atom("!");
    // The conjunction's right goal waits in its frame: leave the frame and run it.
    this.CONJ = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const g = S[e + ENV]!, cb = S[e + 2]!, cc = S[e + 4]!;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      return this.goal(g, cb, cc);
    });
    // The other branch waits in the popped choicepoint's saved argument.
    this.DISJ = def(() => {
      const S = this.S, b = this.lastAlt;
      return this.goal(S[b + CPH]!, S[b + 5]!, S[b + 6]!);
    });
    // The condition succeeded: cut back past the if-then-else's choicepoint (or, for a soft-cut, only disable its
    // alternative), leave the frame and run the then-branch.
    const then = (soft: boolean): Code => () => {
      const S = this.S, R = this.R, e = R[RE]!;
      const g = S[e + ENV]!, b = S[e + ENV + 1]! >> 3, cb = S[e + 2]!, cc = S[e + 4]!;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      if (soft) S[b + 8] = this.FAILC;
      else this.cutTo(S[b]!);
      return this.goal(g, cb, cc);
    };
    this.ITE_THEN = def(then(false));
    this.ITE_SOFT = def(then(true));
    // The negated goal succeeded: cut back past the negation's choicepoint and fail.
    this.NOT = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]! >> 3;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      this.cutTo(S[b]!);
      return this.fail();
    });
    // once/1's goal succeeded: cut its choicepoints and go on.
    this.ONCE = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]! >> 3;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      this.cutTo(b);
      return this.proceed();
    });
    this.PROCEED = def(() => this.proceed());
    for (let n = 1; n <= 8; n++) this.proc("call", n).ctl = (cm, k, cc) => cm.callN(k, cc);
    this.proc("catch", 3).ctl = (cm, _k, cc) => cm.catchGoal(cc);
    this.proc("findall", 3).ctl = (cm) => cm.findall();
    this.proc("setup_call_cleanup", 3).ctl = (cm, _k, cc) => cm.setupCallCleanup(cm.A[0]!, cm.A[1]!, cm.A[2]!, cc);
    this.proc("call_cleanup", 2).ctl = (cm, _k, cc) => cm.setupCallCleanup(cm.A_TRUE, cm.A[0]!, cm.A[1]!, cc);
    this.proc("concurrent_and", 2).ctl = (cm, _k, cc) => cm.concurrentAnd(cc);
    this.proc("concurrent_and", 3).ctl = (cm, _k, cc) => cm.concurrentAnd(cc);
    // The goal under setup_call_cleanup/3 exited: a deterministic exit runs the cleanup now.
    this.SCC_EXIT = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]! >> 3;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      if (R[RB] === b) {
        this.popCP(b);
        this.cleanups--;
        this.runCleanup(S[b + CPH]!);
      }
      return this.proceed();
    });
    this.proc("throw", 1).ctl = (cm) => {
      const ball = cm.hp.deref(cm.A[0]!);
      if ((ball & 7) === REF || (ball & 7) === ATV) throw instantiationError();
      throw new PrologError(copyTerm(cm.hp.decode(ball, new Map()), new Map(), true));
    };
    // halt/0 and halt/1 end the run as the object machine's step does (Machine.step): Halt carries the status, a
    // status that is not a number giving 0.
    this.proc("halt", 0).ctl = () => {
      throw new Halt(0);
    };
    this.proc("halt", 1).ctl = (cm) => {
      const s = cm.hp.deref(cm.A[0]!);
      const v = (s & 7) === INT ? s >> 3 : (s & 7) === BOX ? cm.hp.boxed(s) : null;
      throw new Halt(typeof v === "number" ? v : 0);
    };
    // catch/3's goal exited: a deterministic exit drops the catch choicepoint, as SWI drops its frame.
    this.CATCH_EXIT = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]! >> 3;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      if (R[RB] === b) this.popCP(b);
      R[RCC] = S[b + 6]!;
      return this.proceed();
    });
    // A control construct called as a procedure, as call/N or a caller of ','/2 calls it, runs as that goal's
    // meta-call: built from the registers and interpreted, its cut local to it.
    for (const key of CONTROL) {
      const at = key.lastIndexOf("/");
      const name = key.slice(0, at), n = Number(key.slice(at + 1));
      if (name === "call") continue;
      const f = hp.functor(name, n);
      this.proc(name, n).ctl = (cm, _k, cc) => {
        const q = cm.hp.alloc(n + 1);
        cm.hp.h[q] = f;
        for (let i = 0; i < n; i++) cm.hp.h[q + 1 + i] = cm.A[i]!;
        return cm.goal((q << 3) | STR, cm.R[RB]!, cc);
      };
    }
    // The machine has one module, so M:G runs G (consult.ts's :/2), its cut local as call/1's.
    this.proc(":", 2).ctl = (cm, _k, cc) => cm.goal(cm.A[1]!, cm.R[RB]!, cc);
    this.RETRY = def(() => {
      const b = this.R[RB]!;
      const r = this.tryClauses(this.SO[b + 1] as Pred, this.SO[b] as Scan, this.S[b + 7]!, this.GEN[b]!, this.S[b + 6]!, b);
      return r === undefined ? this.fail() : r;
    });
    this.args = new CellArgs(this.hp, this.A, 0);
    const S = this.S;
    // The bottom: an empty environment at 0 and a barrier after it.
    S[0] = 0;
    S[1] = this.OK;
    S[2] = ENV;
    S[3] = 0;
    S[4] = -1;
    const b = ENV;
    S[b] = b;
    S[b + 1] = K_BARRIER;
    S[b + 9] = this.hp.top;
    this.R[RE] = 0;
    this.R[RCP] = this.OK;
    this.R[RB] = b;
    this.R[RCC] = -1;
    this.R[RBAR] = b;
  }

  /** The procedure compiled code calls name/arity through. */
  proc(name: string, arity: number): CellProc {
    const key = name + "/" + arity;
    let p = this.procs.get(key);
    if (p === undefined) this.procs.set(key, (p = new CellProc(name, arity, key)));
    return p;
  }

  /** The first free stack index, above the current environment and the newest choicepoint. */
  top(): number {
    const S = this.S, R = this.R, e = R[RE]!, b = R[RB]!;
    const te = e + ENV + S[e + 3]!, tb = b + CPH + S[b + 10]!;
    return te > tb ? te : tb;
  }

  /** Push an environment of `n` cell slots whose continuation is the current one. */
  allocate(n: number, cb: number, cc: number): number {
    const S = this.S, R = this.R, e = this.top();
    if (e + ENV + n > this.sLimit) throw new Error("cell control stack exhausted");
    S[e] = R[RE]!;
    S[e + 1] = R[RCP]!;
    S[e + 2] = cb;
    S[e + 3] = n;
    S[e + 4] = cc;
    // Its slots start as cell 0, which no term uses, so the collector reads every slot as a cell (gc.ts).
    for (let i = e + ENV, end = i + n; i < end; i++) S[i] = 0;
    R[RE] = e;
    return e;
  }

  /** Push a choicepoint saving the continuation, the heap and trail tops and A[0..n); returns its index. */
  pushCP(kind: number, cb: number, cc: number, n: number): number {
    const S = this.S, R = this.R, hp = this.hp, b = this.top();
    if (b + CPH + n > this.sLimit) throw new Error("cell control stack exhausted");
    S[b] = R[RB]!;
    S[b + 1] = kind;
    S[b + 2] = hp.tr;
    S[b + 3] = R[RE]!;
    S[b + 4] = R[RCP]!;
    S[b + 5] = cb;
    S[b + 6] = cc;
    S[b + 9] = hp.top;
    S[b + 10] = n;
    this.TIDIED[b] = hp.tr;
    for (let i = 0; i < n; i++) S[b + CPH + i] = this.A[i]!;
    R[RB] = b;
    hp.hb = hp.top;
    return b;
  }

  /** Pop the newest choicepoint `b`. */
  popCP(b: number): void {
    const p = this.S[b]!;
    this.R[RB] = p;
    this.hp.hb = this.hp.above(this.S[p + 9]!);
  }

  /** Cut: drop the choicepoints newer than `b0`. */
  cutTo(b0: number): void {
    if (this.R[RB]! <= b0) return;
    // A cut past setup_call_cleanup's choicepoint runs its cleanup (Machine.cutTo).
    if (this.cleanups > 0) this.cleanupsAbove(b0, false);
    this.R[RB] = b0;
    const hp = this.hp, mark = this.S[b0 + 2]!, done = this.TIDIED[b0]!;
    hp.hb = hp.above(this.S[b0 + 9]!);
    const from = done > mark ? (done < hp.tr ? done : hp.tr) : mark;
    if (hp.tr > from) hp.tidy(from);
    this.TIDIED[b0] = hp.tr;
  }

  /** Go on with the continuation. */
  proceed(): Code | null {
    return this.CODE[this.R[RCP]!]!;
  }

  /**
   * Backtrack to the newest choicepoint with an alternative and return the code resuming there; at the run's barrier,
   * the failure exit. Restores the heap top, so everything built since the choicepoint is freed.
   */
  fail(): Code | null {
    const S = this.S, R = this.R, hp = this.hp;
    for (;;) {
      // Hooks woken by bindings this failure undoes are dropped, as the object machine drops them before backtracking.
      if (hp.wakeups.length !== 0) hp.wakeups.length = 0;
      const b = R[RB]!;
      hp.undo(S[b + 2]!);
      this.TIDIED[b] = S[b + 2]!;
      hp.top = hp.above(S[b + 9]!);
      switch (S[b + 1]) {
        case K_BARRIER:
          return this.CODE[this.NO]!;
        case K_CLAUSES:
          R[RE] = S[b + 3]!;
          R[RCP] = S[b + 4]!;
          R[RCC] = S[b + 6]!;
          for (let i = 0, n = S[b + 10]!; i < n; i++) this.A[i] = S[b + CPH + i]!;
          return this.CODE[this.RETRY]!;
        case K_ALT:
          this.popCP(b);
          R[RE] = S[b + 3]!;
          R[RCP] = S[b + 4]!;
          R[RCC] = S[b + 6]!;
          this.lastAlt = b;
          return this.CODE[S[b + 8]!]!;
        case K_BRIDGE: {
          // The generator's next solution: none pops this choicepoint and backtracks further; the last pops it and
          // goes on; another keeps it. A solution the cells do not take backtracks again.
          R[RE] = S[b + 3]!;
          R[RCP] = S[b + 4]!;
          R[RCC] = S[b + 6]!;
          const run = this.SO[b] as BridgeRun;
          const r = nextSolution(this, run);
          if (r === 0) {
            this.popCP(b);
            continue;
          }
          if (r === 1) this.popCP(b);
          else hp.hb = hp.top;
          if (!takeSolution(this, run, S[b + 7]!)) continue;
          return hp.wakeups.length !== 0 ? this.wake(R[RCC]!) : this.CODE[R[RCP]!]!;
        }
        case K_CATCH:
          // The caught goal has no more solutions: catch/3 fails.
          this.popCP(b);
          continue;
        case K_CLEANUP:
          // The goal has no more solutions: its cleanup runs, with the bindings undone to its setup's.
          this.popCP(b);
          this.cleanups--;
          this.runCleanup(S[b + CPH]!);
          continue;
        case K_FIBERS: {
          // The workers' next solution, unified with the caller's pair as the object builtin unifies its copy; none
          // left pops the choicepoint, its workers going with it.
          R[RE] = S[b + 3]!;
          R[RCP] = S[b + 4]!;
          R[RCC] = S[b + 6]!;
          const g = this.SO[b] as FiberGroup;
          const sol = this.nextFiberSolution(g);
          if (sol === null) {
            this.popCP(b);
            continue;
          }
          if (!hp.unify(g.pair, hp.encode(sol, new Map()))) continue;
          return hp.wakeups.length !== 0 ? this.wake(R[RCC]!) : this.CODE[R[RCP]!]!;
        }
        default:
          throw new Error(`cell machine: choicepoint kind ${S[b + 1]} is not built yet`);
      }
    }
  }

  /**
   * A call from compiled code, which makes it in tail position: the caller returns whatever this returns and does
   * nothing after. Up to NEST calls deep it runs at once, nested on the JS stack; deeper, it is left pending for the
   * trampoline, which unwinds the stack, so a recursion of any depth uses at most NEST nestings of stack.
   */
  callLater(p: CellProc, n: number, cc: number): Code {
    if (this.nest < NEST) {
      this.nest++;
      const r = this.callw(p, n, cc);
      this.nest--;
      return r as Code;
    }
    this.pend = p;
    this.pendN = n;
    this.pendCC = cc;
    return this.CODE[this.CALL]!;
  }

  /** The procedure of functor cell `f` (name/n) or of atom cell `a` (name/0), found by its id. */
  private funProc(f: number): CellProc {
    const id = f >> 3;
    return (this.funProcs[id] ??= this.proc(this.hp.funNames[id]!, this.hp.funArity[id]!));
  }
  private atomProc(a: number): CellProc {
    const id = a >> 3;
    return (this.atomProcs[id] ??= this.proc(this.hp.atomNames[id]!, 0));
  }

  /**
   * Run the goal on the heap at cell `g0` with the current continuation, as call/1 runs a goal (Machine.step): the
   * control constructs are interpreted here with `cb` the choicepoint a cut in them cuts back to, a module-qualified
   * goal runs its goal, and any other goal is called through its procedure. Throws instantiation_error for an unbound
   * goal and type_error(callable, G) for one that is not callable.
   */
  goal(g0: number, cb: number, cc: number): Code | null {
    const hp = this.hp, H = hp.h, S = this.S, R = this.R;
    let g = hp.deref(g0);
    while ((g & 7) === STR && H[g >> 3] === this.F_COLON) g = hp.deref(H[(g >> 3) + 2]!);
    const tag = g & 7;
    if (tag === REF || tag === ATV) throw instantiationError();
    if (tag === ATM) {
      if (g === this.A_TRUE) return this.proceed();
      if (g === this.A_FAIL || g === this.A_FALSE) return this.fail();
      if (g === this.A_CUT) {
        this.cutTo(cb);
        return this.proceed();
      }
      if (g === hp.NIL) throw typeError("callable", NIL);
      return this.callw(this.atomProc(g), 0, cc);
    }
    if (tag !== STR) throw typeError("callable", hp.decode(g, new Map()));
    const p = g >> 3, f = H[p]!;
    switch (f) {
      case this.F_COMMA: {
        const e = this.allocate(1, cb, cc);
        S[e + ENV] = H[p + 2]!;
        R[RCP] = this.CONJ;
        return this.goal(H[p + 1]!, cb, cc);
      }
      case this.F_SEMI: {
        const l = hp.deref(H[p + 1]!);
        const lf = (l & 7) === STR ? H[l >> 3]! : 0;
        if (lf === this.F_ARROW || lf === this.F_SOFT) return this.ifThenElse(H[(l >> 3) + 1]!, H[(l >> 3) + 2]!, H[p + 2]!, lf === this.F_SOFT, cb, cc);
        this.A[0] = H[p + 2]!;
        const b = this.pushCP(K_ALT, cb, cc, 1);
        S[b + 8] = this.DISJ;
        return this.goal(l, cb, cc);
      }
      // (C -> T) and (C *-> T) alone are their if-then-else with a failing else.
      case this.F_ARROW:
        return this.ifThenElse(H[p + 1]!, H[p + 2]!, this.A_FAIL, false, cb, cc);
      case this.F_SOFT:
        return this.ifThenElse(H[p + 1]!, H[p + 2]!, this.A_FAIL, true, cb, cc);
      case this.F_NOT:
        return this.negation(H[p + 1]!, cb, cc);
      case this.F_CALL1:
        return this.goal(H[p + 1]!, R[RB]!, cc);
      case this.F_ONCE: {
        const e = this.allocate(1, cb, cc), b = R[RB]!;
        S[e + ENV] = (b << 3) | INT;
        R[RCP] = this.ONCE;
        return this.goal(H[p + 1]!, b, cc);
      }
      case this.F_IGNORE:
        return this.ifThenElse(H[p + 1]!, this.A_TRUE, this.A_TRUE, false, cb, cc);
      case this.F_FORALL: {
        // forall(C, A) is \+ (C, \+ A), as the object machine rewrites it.
        const q = hp.alloc(5);
        H[q] = this.F_NOT;
        H[q + 1] = H[p + 2]!;
        H[q + 2] = this.F_COMMA;
        H[q + 3] = H[p + 1]!;
        H[q + 4] = (q << 3) | STR;
        return this.negation(((q + 2) << 3) | STR, cb, cc);
      }
    }
    const n = hp.funArity[f >> 3]!;
    for (let i = 0; i < n; i++) this.A[i] = H[p + 1 + i]!;
    return this.callw(this.funProc(f), n, cc);
  }

  /** (C -> T ; E), or (C *-> T ; E) when `soft`: C's cut is local to it, its success commits to T. */
  private ifThenElse(c: number, t: number, e: number, soft: boolean, cb: number, cc: number): Code | null {
    const S = this.S;
    this.A[0] = e;
    const b = this.pushCP(K_ALT, cb, cc, 1);
    S[b + 8] = this.DISJ;
    const fr = this.allocate(2, cb, cc);
    S[fr + ENV] = t;
    S[fr + ENV + 1] = (b << 3) | INT;
    this.R[RCP] = soft ? this.ITE_SOFT : this.ITE_THEN;
    return this.goal(c, b, cc);
  }

  /** \+ G: G's cut is local to it; its success cuts back and fails, its failure goes on. */
  private negation(g: number, cb: number, cc: number): Code | null {
    const S = this.S;
    const b = this.pushCP(K_ALT, cb, cc, 0);
    S[b + 8] = this.PROCEED;
    const e = this.allocate(1, cb, cc);
    S[e + ENV] = (b << 3) | INT;
    this.R[RCP] = this.NOT;
    return this.goal(g, b, cc);
  }

  /**
   * call/N with A[0] the goal and A[1..n) the arguments it gets: a control construct is built on the heap and
   * interpreted (goal); any other goal is called with its own arguments then these, its cut local to it.
   */
  callN(n: number, cc: number): Code | null {
    const hp = this.hp, H = hp.h, A = this.A;
    let g = hp.deref(A[0]!);
    while ((g & 7) === STR && H[g >> 3] === this.F_COLON) g = hp.deref(H[(g >> 3) + 2]!);
    const tag = g & 7;
    if (tag === REF || tag === ATV) throw instantiationError();
    if (n === 1) return this.goal(g, this.R[RB]!, cc);
    let name: string, k: number, base: number;
    if (tag === ATM && g !== hp.NIL) {
      name = hp.atomNames[g >> 3]!;
      k = 0;
      base = 0;
    } else if (tag === STR) {
      const f = H[g >> 3]! >> 3;
      name = hp.funNames[f]!;
      k = hp.funArity[f]!;
      base = (g >> 3) + 1;
    } else throw typeError("callable", hp.decode(g, new Map()));
    const m = n - 1, total = k + m;
    const f = hp.functor(name, total);
    if (CONTROL.has(name + "/" + total)) {
      const q = hp.alloc(total + 1);
      H[q] = f;
      for (let i = 0; i < k; i++) H[q + 1 + i] = H[base + i]!;
      for (let i = 0; i < m; i++) H[q + 1 + k + i] = A[1 + i]!;
      return this.goal((q << 3) | STR, this.R[RB]!, cc);
    }
    // The extra arguments move to follow the goal's own, in an order that reads each before overwriting it.
    if (k > 1) for (let i = m - 1; i >= 0; i--) A[k + i] = A[1 + i]!;
    else if (k === 0) for (let i = 0; i < m; i++) A[i] = A[1 + i]!;
    for (let i = 0; i < k; i++) A[i] = H[base + i]!;
    return this.callw(this.funProc(f), total, cc);
  }

  /**
   * Call nondeterministic object builtin `b` named `key` on A[0..n) through the bridge: its first solution, with a
   * choicepoint (K_BRIDGE) resuming its generator when more may follow.
   */
  callNondet(key: string, b: Builtin, n: number, cc: number): Code | null {
    const run = startNondet(this, key, b, n);
    if (run === false) return this.fail();
    if (run !== true) {
      const mark = objectTrailMark(this);
      const r = nextSolution(this, run);
      if (r === 0) return this.fail();
      if (r === 2) {
        const bp = this.pushCP(K_BRIDGE, 0, cc, 0);
        this.SO[bp] = run;
        this.S[bp + 7] = mark;
      }
      if (!takeSolution(this, run, mark)) return this.fail();
    }
    return this.hp.wakeups.length !== 0 ? this.wake(cc) : this.proceed();
  }

  /**
   * findall(T, G, L) with A[0..3) holding them: G solved to exhaustion under its own barrier, its cut local, a
   * decoded copy of T kept at each solution outside the heap backtracking frees, L unified with their list encoded.
   */
  findall(): Code | null {
    const hp = this.hp, A = this.A, g = A[1]!;
    const found: Term[] = [];
    const l = this.hold([A[0]!, A[2]!], (at) => {
      this.solveAllFrom(() => this.goal(g, this.R[RB]!, this.R[RCC]!), () => void found.push(hp.decode(at(0), new Map())));
      return at(1);
    });
    if (!hp.unify(l, hp.encode(mkList(found), new Map()))) return this.fail();
    return hp.wakeups.length !== 0 ? this.wake(this.R[RCC]!) : this.proceed();
  }

  /**
   * concurrent_and(Generator, Test[, Options]) with A[0..2) holding them, as the object builtin runs it (library.ts):
   * every solution of Generator, solved once here, gives a worker solving a copy of Test; the workers run interleaved
   * in slices of SLICE bounces, as SWI's threads run at once, and each solution is returned as its worker finds it,
   * unified back into Generator-Test, so once/1 around it takes the first worker to finish (hyperpose_primes) and an
   * error in a worker reaches the caller. A worker is a fiber: a heap array, trail and queue of its own, its control
   * stack in the area of the K_FIBERS choicepoint, which frees them all when it is cut or exhausted.
   * am[implements a-petta-cell-store.runtime.rest.fibers]
   */
  concurrentAnd(cc: number): Code | null {
    const hp = this.hp, A = this.A;
    const q = hp.alloc(3);
    hp.h[q] = hp.functor("-", 2);
    hp.h[q + 1] = A[0]!;
    hp.h[q + 2] = A[1]!;
    const pairs: Term[] = [];
    const pair = this.hold([(q << 3) | STR], (at) => {
      this.solveEach(A[0]!, () => void pairs.push(copyTerm(hp.decode(at(0), new Map()))));
      return at(0);
    });
    if (pairs.length === 0) return this.fail();
    const b = this.pushCP(K_FIBERS, this.R[RB]!, cc, 0);
    const area = pairs.length * FIBER_S;
    if (b + CPH + area > this.sLimit) throw new Error("cell control stack exhausted");
    this.S[b + 10] = area;
    const group: FiberGroup = { workers: pairs.map((p, k) => this.newFiber(p, b + CPH + k * FIBER_S)), i: 0, pair };
    this.SO[b] = group;
    return this.fail();
  }

  /**
   * Collect the heap at a call port with A[0..n) holding the call (Heap.collect): the roots are A[0..n), the slots of
   * every environment on the chains from E and from each choicepoint, each choicepoint's saved arguments (a
   * concurrent_and choicepoint's caller pair instead of its area), the cells of the variables a bridged generator
   * decoded, and the cells held across nested solves (hold); each moves with the heap and the runtime boxes, as does
   * every choicepoint's saved heap top. scheduleCollection then sets where the next one comes. Time: Heap.collect's
   * plus the frames on the stack.
   * am[implements a-petta-cell-store.gc.trigger] am[implements a-petta-cell-store.gc.roots]
   */
  private collect(n: number): void {
    const S = this.S, A = this.A, R = this.R, SO = this.SO, hp = this.hp;
    const envs: number[] = [], cps: number[] = [];
    const seen = new Set<number>();
    const chain = (e0: number): void => {
      for (let e = e0; !seen.has(e); e = S[e]!) {
        seen.add(e);
        envs.push(e);
        if (S[e] === e) break;
      }
    };
    chain(R[RE]!);
    for (let b = R[RB]!; ; b = S[b]!) {
      cps.push(b);
      chain(S[b + 3]!);
      if (S[b] === b) break;
    }
    hp.collect(
      (mark) => {
        for (let i = 0; i < n; i++) mark(A[i]!);
        for (const e of envs) for (let i = e + ENV, end = i + S[e + 3]!; i < end; i++) mark(S[i]!);
        for (const b of cps) {
          const kind = S[b + 1]!;
          if (kind === K_FIBERS) mark((SO[b] as FiberGroup).pair);
          else for (let i = b + CPH, end = i + S[b + 10]!; i < end; i++) mark(S[i]!);
          // A decoded variable's cell must stay, bound or not, for the generator's solutions to bind it; its key is
          // its own cell, so an attributed one keeps its attribute list.
          if (kind === K_BRIDGE) for (const c of (SO[b] as BridgeRun).back.keys()) mark(c);
        }
        for (const c of this.roots) mark(c);
      },
      (cell, addr) => {
        for (let i = 0; i < n; i++) A[i] = cell(A[i]!);
        for (const e of envs) for (let i = e + ENV, end = i + S[e + 3]!; i < end; i++) S[i] = cell(S[i]!);
        for (const b of cps) {
          const kind = S[b + 1]!;
          S[b + 9] = addr(S[b + 9]!);
          if (kind === K_FIBERS) {
            const g = SO[b] as FiberGroup;
            g.pair = cell(g.pair);
          } else for (let i = b + CPH, end = i + S[b + 10]!; i < end; i++) S[i] = cell(S[i]!);
          if (kind === K_BRIDGE) {
            const run = SO[b] as BridgeRun;
            const moved = new Map<number, Var>();
            for (const [c, v] of run.back) moved.set(cell(c), v);
            run.back = moved;
          }
        }
        for (let i = 0; i < this.roots.length; i++) this.roots[i] = cell(this.roots[i]!);
      },
    );
    this.scheduleCollection();
  }

  /**
   * Collect whenever the heap has grown by `cells` since the last collection, or at every call port when `cells` is
   * 0, instead of by what the last collection kept: tests collect at every call port to reach each root at each point
   * (gc.test).
   * am[implements a-petta-cell-store.gc.trigger]
   */
  collectEvery(cells: number): void {
    this.gcGrowth = cells;
    this.scheduleCollection();
  }

  /**
   * Where the next call port collects: once the heap used, its cells and its runtime boxes weighed (BOX_CELLS), has
   * grown by what it is now, at least GC_MIN_GROWTH cells, so collecting costs a constant per cell or box made; or
   * by the fixed growth, a fixed growth of 0 being every call port however far backtracking lowers the heap.
   */
  private scheduleCollection(): void {
    const used = this.hp.top + BOX_CELLS * this.hp.boxes.length, g = this.gcGrowth;
    this.gcAt = g === 0 ? 0 : used + (g ?? Math.max(used, GC_MIN_GROWTH));
  }

  /**
   * Run `body` with `cells` held as collector roots, `at(i)` giving cell i where the last collection put it: a JS frame
   * keeping cells across a nested solve reads them back through `at`, since a collection inside the solve moves them.
   * am[implements a-petta-cell-store.gc.roots]
   */
  hold<T>(cells: readonly number[], body: (at: (i: number) => number) => T): T {
    const roots = this.roots, k = roots.length;
    for (const c of cells) roots.push(c);
    try {
      return body((i) => roots[k + i]!);
    } finally {
      roots.length = k;
    }
  }

  /** The running computation's state, to put back with loadCtx. */
  private saveCtx(): Ctx {
    const hp = this.hp;
    return {
      R: this.R.slice(),
      A: this.A.slice(0, this.pendN),
      h: hp.h,
      boxes: hp.boxes,
      top: hp.top,
      hb: hp.hb,
      frozen: hp.frozen,
      trail: hp.trailState(),
      wakeups: hp.wakeups,
      nest: this.nest,
      pend: this.pend,
      pendN: this.pendN,
      pendCC: this.pendCC,
      cleanups: this.cleanups,
      result: this.result,
      sLimit: this.sLimit,
      inFiber: this.inFiber,
      roots: this.roots,
      gcAt: this.gcAt,
    };
  }

  /** Make `c` the running computation. */
  private loadCtx(c: Ctx): void {
    const hp = this.hp;
    this.R.set(c.R);
    this.A.set(c.A);
    hp.h = c.h;
    hp.boxes = c.boxes;
    hp.top = c.top;
    hp.hb = c.hb;
    hp.frozen = c.frozen;
    hp.setTrailState(c.trail);
    hp.wakeups = c.wakeups;
    this.nest = c.nest;
    this.pend = c.pend;
    this.pendN = c.pendN;
    this.pendCC = c.pendCC;
    this.cleanups = c.cleanups;
    this.result = c.result;
    this.sLimit = c.sLimit;
    this.inFiber = c.inFiber;
    this.roots = c.roots;
    this.gcAt = c.gcAt;
  }

  /**
   * A worker solving the Test of `pairTerm`, a Generator-Test copy, its control stack from `base`: an empty
   * environment and a barrier there as at the machine's bottom, its heap a fresh array holding the pair's cells.
   */
  private newFiber(pairTerm: Term, base: number): Fiber {
    const main = this.saveCtx();
    const hp = this.hp, S = this.S, R = this.R;
    try {
      hp.h = new Int32Array(HEAP_CELLS);
      hp.boxes = [];
      hp.top = hp.hb = 1 + GLOBAL_SLOTS;
      hp.frozen = 0;
      hp.setTrailState(null);
      hp.wakeups = [];
      this.sLimit = base + FIBER_S;
      this.inFiber = true;
      this.roots = [];
      this.cleanups = 0;
      this.scheduleCollection();
      const bar = base + ENV;
      S[base] = base;
      S[base + 1] = this.OK;
      S[base + 2] = bar;
      S[base + 3] = 0;
      S[base + 4] = -1;
      S[bar] = bar;
      S[bar + 1] = K_BARRIER;
      S[bar + 2] = 0;
      S[bar + 3] = base;
      S[bar + 9] = hp.top;
      S[bar + 10] = 0;
      R[RE] = base;
      R[RCP] = this.OK;
      R[RB] = bar;
      R[RCC] = -1;
      R[RBAR] = bar;
      this.roots.push(hp.encode(pairTerm, new Map()));
      const next: Code = () => this.goal(this.hp.h[(this.roots[0]! >> 3) + 2]!, this.R[RB]!, this.R[RCC]!);
      return { ctx: this.saveCtx(), next, solved: false, bar };
    } finally {
      this.loadCtx(main);
    }
  }

  /**
   * Run worker `w` for at most `steps` bounces, backtracking into it first when its last solution was taken: a copy of
   * its pair when it reaches a solution, "failed" when it has no more, "suspended" when the slice ran out. A ball no
   * catch inside the worker takes reaches the caller. Time: the slice.
   */
  private runFiber(w: Fiber, steps: number): Term | "failed" | "suspended" {
    const main = this.saveCtx();
    this.loadCtx(w.ctx);
    try {
      let f: Code | null;
      if (w.solved) {
        w.solved = false;
        f = this.fail();
      } else f = w.next;
      let left = steps;
      this.nest = 0;
      for (;;) {
        try {
          while (f !== null && left > 0) {
            left--;
            f = f();
          }
          break;
        } catch (e) {
          if (!(e instanceof PrologError)) throw e;
          this.nest = 0;
          f = this.unwind(e, w.bar);
        }
      }
      if (f !== null) {
        w.next = f;
        return "suspended";
      }
      if (!this.result) return "failed";
      w.solved = true;
      return copyTerm(this.hp.decode(this.roots[0]!, new Map()));
    } finally {
      w.ctx = this.saveCtx();
      this.loadCtx(main);
    }
  }

  /** The next solution of group `g`'s workers in turn, as the object builtin's loop takes them, or null when none. */
  private nextFiberSolution(g: FiberGroup): Term | null {
    while (g.workers.length > 0) {
      while (g.i < g.workers.length) {
        const r = this.runFiber(g.workers[g.i]!, SLICE);
        if (r === "failed") {
          g.workers.splice(g.i, 1);
          continue;
        }
        g.i++;
        if (r !== "suspended") return r;
      }
      g.i = 0;
    }
    return null;
  }

  /** setup_call_cleanup(S, G, C): S once; G under a cleanup choicepoint holding C, its cut local to it. */
  setupCallCleanup(setup: number, g: number, cleanup: number, cc: number): Code | null {
    const S = this.S, R = this.R;
    const held = this.hold([g, cleanup], (at) => (this.solveCell(setup) ? [at(0), at(1)] : null));
    if (held === null) return this.fail();
    [g, cleanup] = held as [number, number];
    this.A[0] = cleanup;
    const b = this.pushCP(K_CLEANUP, R[RB]!, cc, 1);
    this.cleanups++;
    const e = this.allocate(1, b, cc);
    S[e + ENV] = (b << 3) | INT;
    R[RCP] = this.SCC_EXIT;
    return this.goal(g, b, cc);
  }

  /** Run cleanup goal cell `c` once; its failure or error does not reach the caller (Machine.runCleanup). */
  private runCleanup(c: number): void {
    try {
      this.solveCell(c);
    } catch (e) {
      if (!(e instanceof PrologError)) throw e;
    }
  }

  /** The cleanups of the cleanup choicepoints above `b0`, newest first, each after undoing to its setup when `undo`. */
  private cleanupsAbove(b0: number, undo: boolean): void {
    const S = this.S;
    const found: number[] = [];
    for (let b = this.R[RB]!; b > b0; b = S[b]!) if (S[b + 1] === K_CLEANUP) found.push(b);
    for (const b of found) {
      this.cleanups--;
      // Retire it before running, so the cleanup's own cuts do not meet it again.
      S[b + 1] = K_ALT;
      S[b + 8] = this.FAILC;
      if (undo) this.hp.undo(S[b + 2]!);
      this.runCleanup(S[b + CPH]!);
    }
  }

  /** catch(G, C, R) with A[0..3) holding them: G runs under a catch choicepoint, its cut local to it. */
  catchGoal(cc: number): Code | null {
    const A = this.A, S = this.S, R = this.R;
    const g = A[0]!;
    A[0] = A[1]!;
    A[1] = A[2]!;
    const b = this.pushCP(K_CATCH, R[RB]!, cc, 2);
    const e = this.allocate(1, b, cc);
    S[e + ENV] = (b << 3) | INT;
    R[RCP] = this.CATCH_EXIT;
    R[RCC] = b;
    return this.goal(g, b, b);
  }

  /**
   * A ball thrown inside this run (a PrologError): unwind to the innermost catch around the code that threw (the
   * catch context R[RCC]) whose catcher unifies with the ball encoded, restoring the state at that catch and running
   * its recovery; catches at or below `bar`, the run's barrier, belong to an outer run, so the ball is thrown on.
   */
  private unwind(e: PrologError, bar: number): Code | null {
    const S = this.S, R = this.R, hp = this.hp;
    hp.wakeups.length = 0;
    let b = R[RCC]!;
    // Each cleanup the ball passes runs, with the bindings undone to its setup's (Machine.unwindTo).
    if (this.cleanups > 0) this.cleanupsAbove(b > bar ? b : bar, true);
    while (b > bar && S[b + 1] === K_CATCH) {
      hp.undo(S[b + 2]!);
      hp.top = hp.above(S[b + 9]!);
      R[RB] = b;
      hp.hb = hp.top;
      R[RE] = S[b + 3]!;
      R[RCP] = S[b + 4]!;
      const outer = S[b + 6]!;
      if (hp.unify(S[b + CPH]!, hp.encode(e.ball, new Map()))) {
        const recovery = S[b + CPH + 1]!;
        this.popCP(b);
        R[RCC] = outer;
        // Hooks the catcher's unification woke run before the recovery.
        return this.goal(hp.wakeups.length !== 0 ? this.conj(this.wakeGoal(), recovery) : recovery, R[RB]!, outer);
      }
      hp.undo(S[b + 2]!);
      hp.top = hp.above(S[b + 9]!);
      hp.wakeups.length = 0;
      this.popCP(b);
      b = outer;
    }
    throw copiedBall(e);
  }

  /**
   * Run the hooks the bindings since the last goal woke, then go on with the continuation, as Machine.flushWakeups
   * puts them before the next goal: '$attr_unify_hook'(Module, Value, Other) for each attribute of each attributed
   * variable bound, in binding order; `cc` is the catch context they run in.
   * am[implements a-petta-cell-store.runtime.attrs.wake]
   */
  wake(cc: number): Code | null {
    return this.goal(this.wakeGoal(), this.R[RB]!, cc);
  }

  /** The woken hooks as one goal cell, a conjunction in waking order, emptying the queue. Time: the hooks. */
  private wakeGoal(): number {
    const hp = this.hp, H = hp.h, w = hp.wakeups;
    const hooks: number[] = [];
    for (const { attrs, value } of w)
      for (let l = attrs; (l & 7) === STR; l = H[(l >> 3) + 3]!) {
        const q = hp.alloc(4);
        H[q] = this.F_HOOK;
        H[q + 1] = H[(l >> 3) + 1]!;
        H[q + 2] = H[(l >> 3) + 2]!;
        H[q + 3] = value;
        hooks.push((q << 3) | STR);
      }
    w.length = 0;
    let g = hooks[hooks.length - 1]!;
    for (let i = hooks.length - 2; i >= 0; i--) g = this.conj(hooks[i]!, g);
    return g;
  }

  /** The goal cell (a, b). */
  private conj(a: number, b: number): number {
    const H = this.hp.h, q = this.hp.alloc(3);
    H[q] = this.F_COMMA;
    H[q + 1] = a;
    H[q + 2] = b;
    return (q << 3) | STR;
  }

  /** Call `p` with A[0..n), the continuation being the current one. */
  callw(p: CellProc, n: number, cc: number): Code | null {
    // A call port is where the collector runs: compiled code calls in tail position, so only A[0..n), the control
    // stack and the held roots hold cells.
    if (this.hp.top + BOX_CELLS * this.hp.boxes.length >= this.gcAt) this.collect(n);
    // The catch context of the call, which a throw from inside it unwinds to (unwind).
    this.R[RCC] = cc;
    if (p.det !== undefined) {
      if (!p.det(this, n)) return this.fail();
      return this.hp.wakeups.length !== 0 ? this.wake(cc) : this.proceed();
    }
    if (p.ctl !== undefined) return p.ctl(this, n, cc);
    let pred = p.pred;
    if (pred === undefined) {
      // A builtin comes before a predicate of its key, as the object machine resolves calls (Machine.callCell).
      const b = this.om.builtins.get(p.key);
      if (b !== undefined) {
        if (b.nondet !== undefined) p.ctl = (cm, k, c) => cm.callNondet(p.key, b, k, c);
        else {
          // A bridged det builtin answers true or false, or a goal cell it pushed, run next with its cut local after
          // the hooks the call woke, as flushWakeups puts them in front of pushed goals.
          const run = bridgeBuiltin(p.key, b);
          p.ctl = (cm, k, c) => {
            const r = run(cm, k);
            if (r === false) return cm.fail();
            const woke = cm.hp.wakeups.length !== 0;
            if (r === true) return woke ? cm.wake(c) : cm.proceed();
            return cm.goal(woke ? cm.conj(cm.wakeGoal(), r) : r, cm.R[RB]!, c);
          };
        }
        return this.callw(p, n, cc);
      }
      // A tabled predicate answers from its tables (Machine.callTabled).
      if (this.om.tabled.size > 0 && this.om.tabled.has(p.key)) {
        p.ctl = (cm, k, c) => cm.tabledCall(p, k, c);
        return this.callw(p, n, cc);
      }
      const r = this.resolve(p);
      if (r === undefined) return this.fail();
      pred = r;
    }
    const scan = clauseScan(pred, this.args);
    const r = this.tryClauses(pred, scan, scan.start, this.om.db.generation, cc, -1);
    return r === undefined ? this.fail() : r;
  }

  /**
   * The predicate `p` calls, cached on it: an undefined predicate a library exports loads that library (SWI's
   * autoloader, Machine.autoload); one still undefined is undefined under the unknown flag's fail and raises
   * existence_error otherwise, as Machine.callCell does.
   */
  private resolve(p: CellProc): Pred | undefined {
    const om = this.om;
    let pred = (p.pred = om.db.preds.get(p.key));
    if (pred === undefined && om.autoload !== null && om.autoload(p.name, p.arity)) pred = p.pred = om.db.preds.get(p.key);
    if (pred === undefined && om.flags.get("unknown") !== "fail") throw existenceError("procedure", new Struct("/", [p.name, p.arity]));
    return pred;
  }

  /**
   * A call of tabled predicate `p` with A[0..n), as Machine.callTabled answers it: the first call of a variant solves
   * it to completion on cells with `p` untabled, so its own recursive calls run the clauses, keeping its distinct
   * answers up to variance in the object machine's tables, which both engines share; every call then answers from
   * its variant's table as a nondeterministic builtin would. While its table fills, `p` is untabled and a call of it
   * runs its clauses. Time: the solve once per variant, then the answers each call tries.
   * am[implements a-petta-cell-store.runtime.rest]
   */
  tabledCall(p: CellProc, n: number, cc: number): Code | null {
    const om = this.om, hp = this.hp, H = hp.h, A = this.A;
    if (!om.tabled.has(p.key)) {
      const pred = p.pred ?? this.resolve(p);
      if (pred === undefined) return this.fail();
      const scan = clauseScan(pred, this.args);
      const r = this.tryClauses(pred, scan, scan.start, om.db.generation, cc, -1);
      return r === undefined ? this.fail() : r;
    }
    const args: Term[] = [];
    for (let i = 0; i < n; i++) args.push(hp.decode(A[i]!, new Map()));
    const vkey = variantKeyOf(new Struct(p.name, args));
    let answers = om.tables.get(vkey);
    if (answers === undefined) {
      om.tables.set(vkey, (answers = []));
      if (om.db.get(p.name, n) !== undefined) {
        // The call as a goal cell; the solve undoes every binding it makes, so the caller's arguments stay as they are.
        let g: number;
        if (n === 0) g = hp.atom(p.name);
        else {
          const q = hp.alloc(n + 1);
          H[q] = hp.functor(p.name, n);
          for (let i = 0; i < n; i++) H[q + 1 + i] = A[i]!;
          g = (q << 3) | STR;
        }
        const seen = new Set<string>();
        const found: Term[] = [];
        // The solve reuses the argument registers, which the answering below reads, so they are held with the goal.
        om.tabled.delete(p.key);
        try {
          this.hold([g, ...A.subarray(0, n)], (at) => {
            this.solveEach(g, () => {
              const a = copyTerm(hp.decode(at(0), new Map()));
              const key = variantKeyOf(a);
              if (!seen.has(key)) {
                seen.add(key);
                found.push(a);
              }
            });
            for (let i = 0; i < n; i++) A[i] = at(1 + i);
          });
        } finally {
          om.tabled.add(p.key);
        }
        answers.push(...found);
      }
    }
    const list = answers.slice(), name = p.name;
    const table: Builtin = {
      nondet: function* (m: Machine, as: Term[]) {
        const goal = new Struct(name, as);
        for (const a of list) if (m.unify(goal, copyTerm(a))) yield;
        return false;
      },
    };
    return this.callNondet(p.key, table, n, cc);
  }

  /**
   * The candidate loop (the object Machine's tryClauses over cells): the scan's visible clauses its key admits, a
   * choicepoint left only where another admitted clause follows within SWI's lookahead; a retry passes its
   * choicepoint. Returns the code to run, or undefined when no candidate's head unified.
   * am[implements a-hp-swi-clause-select]
   */
  tryClauses(pred: Pred, scan: Scan, start: number, gen: number, cc: number, retry: number): Code | null | undefined {
    const S = this.S, R = this.R, hp = this.hp;
    let cp = retry;
    const h = cp < 0 ? R[RB]! : S[cp]!;
    const cands = scan.list, len = cands.length, key = scan.key;
    const keyAt = key === null ? null : scan.keyAt;
    // On a long scan, ground call arguments are hashed once, kept with a choicepoint for its retries, and the scan
    // visits only the positions where the argument with the fewest can match: those holding its hash or a non-ground
    // argument (db.ts ArgHashIndex), skipping exactly the clauses hashesDiffer rules out, so the lookahead below sees
    // what it saw before and choicepoints stay where SWI's do (Machine.tryClauses, a-petta-speed-1105.outliers.spaces).
    // am[implements a-petta-speed-1105.outliers.spaces]
    const callHashes = cp >= 0 ? (this.SO[cp + 2] as (number | null)[] | null) : len - start > 8 ? this.groundArgHashes(pred.arity) : null;
    let posA: number[] | null = null;
    let posB: number[] = EMPTY_POS;
    let ia = 0;
    let ib = 0;
    if (callHashes !== null) {
      let best = Infinity;
      for (let p = 0; p < callHashes.length; p++) {
        const hc = callHashes[p];
        if (hc === null || hc === undefined) continue;
        const ix = argHashIndex(cands, p);
        const b = ix.byHash.get(hc);
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
        if (cp < 0) {
          cp = this.pushCP(K_CLAUSES, h, cc, pred.arity);
          this.SO[cp] = scan;
          this.SO[cp + 1] = pred;
          this.SO[cp + 2] = callHashes;
          this.GEN[cp] = gen;
        } else hp.hb = hp.top;
        S[cp + 7] = j;
      } else if (cp >= 0) {
        this.popCP(cp);
        cp = -1;
      }
      const mark = hp.tr, h0 = hp.top;
      const fn = c.cell;
      const r = typeof fn === "function" ? (fn as ClauseFn)(h, cc, 0) : this.cold(c, h, cc);
      if (r !== HEADFAIL) return r;
      hp.undo(mark);
      hp.top = h0;
      if (hp.wakeups.length !== 0) hp.wakeups.length = 0;
      i = j - 1;
    }
    if (cp >= 0) this.popCP(cp);
    return undefined;
  }

  /** groundHash of each of A[0..n), or null when none is ground (Machine's groundArgHashes). Time: their size. */
  private groundArgHashes(n: number): (number | null)[] | null {
    let any = false;
    const out = new Array<number | null>(n);
    for (let i = 0; i < n; i++) {
      const h = this.hp.groundHash(this.A[i]!);
      if (h !== null) any = true;
      out[i] = h;
    }
    return any ? out : null;
  }

  /** Run the trampoline from `f` until a run's exit, a thrown ball unwinding to its catch (unwind). */
  private drive(f0: Code | null, bar: number): null {
    let f = f0;
    for (;;) {
      try {
        while (f !== null) f = f();
        return null;
      } catch (e) {
        if (!(e instanceof PrologError)) throw e;
        this.nest = 0;
        f = this.unwind(e, bar);
      }
    }
  }

  /**
   * Solve the goal predicate `p` with A[0..n) for every solution, calling `each` after each one with whether a
   * choicepoint of the goal remains, as Machine.solveAll does; `each` returning false stops. Every binding and heap
   * cell of the run is undone at the end.
   */
  solveAll(p: CellProc, n: number, each: (hasChoice: boolean) => boolean | void): void {
    this.solveAllFrom(() => this.callw(p, n, this.R[RCC]!), each);
  }

  /** Run code `start` for every solution under a barrier, as solveAll; every binding is undone at the end. */
  private solveAllFrom(start: Code, each: (hasChoice: boolean) => boolean | void): void {
    const S = this.S, R = this.R, hp = this.hp;
    const sE = R[RE]!, sCP = R[RCP]!, sB = R[RB]!, sCC = R[RCC]!, sBAR = R[RBAR]!;
    const sNest = this.nest;
    // The run queues its own wakeups: its failures empty the queue, which must not drop the caller's.
    const sWake = hp.wakeups;
    hp.wakeups = [];
    const bar = this.pushCP(K_BARRIER, sB, sCC, 0);
    R[RBAR] = bar;
    R[RCP] = this.OK;
    try {
      let f: Code | null = start;
      this.nest = 0;
      for (;;) {
        f = this.drive(f, bar);
        if (!this.result || each(R[RB] !== bar) === false) break;
        f = this.fail();
      }
    } catch (e) {
      throw copiedBall(e);
    } finally {
      hp.undo(S[bar + 2]!);
      hp.top = hp.above(S[bar + 9]!);
      R[RB] = sB;
      hp.hb = hp.above(S[sB + 9]!);
      R[RE] = sE;
      R[RCP] = sCP;
      R[RCC] = sCC;
      R[RBAR] = sBAR;
      this.nest = sNest;
      hp.wakeups = sWake;
    }
  }

  /**
   * Try clause `c`, which has no code yet: for its first COMPILE_AFTER tries it runs from its head program, a rule
   * then building its body on the heap and running it through the meta-call interpreter with the clause's cut
   * barrier; on that try it is compiled, a rule with an inline head, a fact with a compact one (compile.ts,
   * c-head-tiers-1106). Returns what the clause's code would.
   */
  private cold(c: Clause, h: number, cc: number): Code | null {
    let st = c.cell as ColdFact | null;
    const rule = c.body !== "true";
    if (st !== null && ++st.tries >= COMPILE_AFTER) {
      const fn = this.compile!(this, c, rule);
      c.cell = fn;
      return fn(h, cc, 0);
    }
    if (st === null) c.cell = st = { prog: headProgram(this.hp, c), tries: 1 };
    if (c.nvars > this.vals.length) this.vals = new Int32Array(2 * c.nvars);
    if (!runHead(this.hp, st.prog, this.A, this.vals, this.next)) return HEADFAIL;
    const woke = this.hp.wakeups.length !== 0;
    if (!rule) return woke ? this.wake(cc) : this.proceed();
    // The hooks the head woke run before the body, which they are put in front of.
    const body = build(this.hp, st.prog.body!, 0, this.vals, this.next);
    return this.goal(woke ? this.conj(this.wakeGoal(), body) : body, h, cc);
  }

  /** Recompile hot clause `c` with an inline head and run it from its head, as its compact code was asked to. */
  retier(c: Clause, b0: number, cc: number): Code | null {
    const fn = this.compile!(this, c, true);
    c.cell = fn;
    return fn(b0, cc, 0);
  }

  /** Solve goal cell `g` for every solution, its cut local, calling `each` after each; `each` returning false stops. */
  solveEach(g: number, each: () => boolean | void): void {
    this.solveAllFrom(() => this.goal(g, this.R[RB]!, this.R[RCC]!), each);
  }

  /** Solve goal cell `g` once, its cut local; bindings persist on success. */
  solveCell(g: number): boolean {
    return this.solveFrom(() => this.goal(g, this.R[RB]!, this.R[RCC]!));
  }

  /** Solve the goal predicate `p` with A[0..n) once; bindings persist on success. */
  solveOnce(p: CellProc, n: number): boolean {
    return this.solveFrom(() => this.callw(p, n, this.R[RCC]!));
  }

  /** Run code `start` once under a barrier; bindings persist on success. */
  private solveFrom(start: Code): boolean {
    const R = this.R;
    const sE = R[RE]!, sCP = R[RCP]!, sB = R[RB]!, sCC = R[RCC]!, sBAR = R[RBAR]!;
    const sNest = this.nest;
    const sWake = this.hp.wakeups;
    this.hp.wakeups = [];
    const bar = this.pushCP(K_BARRIER, sB, sCC, 0);
    R[RBAR] = bar;
    R[RCP] = this.OK;
    try {
      this.nest = 0;
      this.drive(start, bar);
      this.cutTo(sB);
      return this.result;
    } catch (e) {
      throw copiedBall(e);
    } finally {
      R[RE] = sE;
      R[RCP] = sCP;
      R[RCC] = sCC;
      R[RBAR] = sBAR;
      this.nest = sNest;
      this.hp.wakeups = sWake;
    }
  }
}
