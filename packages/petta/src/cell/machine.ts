// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the cell engine's control. Environments and choicepoints live on one Int32Array stack whose every slot is a
// cell or a number, continuations are code ids a trampoline runs, and a call selects its clauses with swi-index.ts
// over the argument registers (CellArgs) and tries them in the candidate loop with SWI's lookahead, so choicepoints
// stay where SWI leaves them. Clauses run as code the clause compiler (compile.ts) makes from the database's templates,
// which the object machine it wraps also reads. The control's shape is the object core's (commit 9934828), cells in
// place of objects (c-cell-control-design-1106).
// am[implements a-petta-cell-store.control]

import type { Clause, Pred } from "../db";
import { copyTerm, type Builtin, type Machine } from "../machine";
import { MAX_LOOKAHEAD, clauseScan, type Scan } from "../swi-index";
import { NIL, PrologError, Struct, existenceError, instantiationError, typeError } from "../terms";
import { CellArgs } from "./args";
import { bridgeBuiltin, nextSolution, objectTrailMark, startNondet, takeSolution, type BridgeRun } from "./bridge";
import { build, headProgram, runHead, type HeadProgram } from "./headprog";
import { ATM, ATV, Heap, REF, STR } from "./heap";

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
 * argument count, the argument cells after; SO[b] and SO[b+1] a Clauses choicepoint's scan and predicate, GEN[b] its
 * generation.
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
/** The goals the meta-call interpreter runs itself (goal) when call/N builds one. */
const CONTROL = new Set([",/2", ";/2", "->/2", "*->/2", "\\+/1", "call/1", "once/1", "ignore/1", "forall/2"]);

/** A clause not yet compiled: its head and body programs and how often it has been tried. */
interface ColdFact {
  readonly prog: HeadProgram;
  tries: number;
}

/** An error leaving a solve with its ball copied, plain variables for attributed ones, as the object machine's are. */
function copiedBall(e: unknown): unknown {
  return e instanceof PrologError ? new PrologError(copyTerm(e.ball)) : e;
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
  readonly S = new Int32Array(1 << 24);
  readonly R = new Int32Array(8);
  /** Argument registers A[0..n): a call's argument cells. */
  readonly A = new Int32Array(256);
  /** Choicepoint data that is not a number: a Clauses choicepoint's scan and predicate. */
  readonly SO: unknown[] = [];
  readonly GEN = new Float64Array(1 << 24);
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
      const g = S[e + ENV]!, b = S[e + ENV + 1]!, cb = S[e + 2]!, cc = S[e + 4]!;
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
      const b = S[e + ENV]!;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      this.cutTo(S[b]!);
      return this.fail();
    });
    // once/1's goal succeeded: cut its choicepoints and go on.
    this.ONCE = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]!;
      R[RCP] = S[e + 1]!;
      R[RE] = S[e]!;
      this.cutTo(b);
      return this.proceed();
    });
    this.PROCEED = def(() => this.proceed());
    for (let n = 1; n <= 8; n++) this.proc("call", n).ctl = (cm, k, cc) => cm.callN(k, cc);
    this.proc("catch", 3).ctl = (cm, _k, cc) => cm.catchGoal(cc);
    this.proc("setup_call_cleanup", 3).ctl = (cm, _k, cc) => cm.setupCallCleanup(cm.A[0]!, cm.A[1]!, cm.A[2]!, cc);
    this.proc("call_cleanup", 2).ctl = (cm, _k, cc) => cm.setupCallCleanup(cm.A_TRUE, cm.A[0]!, cm.A[1]!, cc);
    // The goal under setup_call_cleanup/3 exited: a deterministic exit runs the cleanup now.
    this.SCC_EXIT = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]!;
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
      throw new PrologError(copyTerm(cm.hp.decode(ball, new Map())));
    };
    // catch/3's goal exited: a deterministic exit drops the catch choicepoint, as SWI drops its frame.
    this.CATCH_EXIT = def(() => {
      const S = this.S, R = this.R, e = R[RE]!;
      const b = S[e + ENV]!;
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
    S[e] = R[RE]!;
    S[e + 1] = R[RCP]!;
    S[e + 2] = cb;
    S[e + 3] = n;
    S[e + 4] = cc;
    R[RE] = e;
    return e;
  }

  /** Push a choicepoint saving the continuation, the heap and trail tops and A[0..n); returns its index. */
  pushCP(kind: number, cb: number, cc: number, n: number): number {
    const S = this.S, R = this.R, hp = this.hp, b = this.top();
    S[b] = R[RB]!;
    S[b + 1] = kind;
    S[b + 2] = hp.tr;
    S[b + 3] = R[RE]!;
    S[b + 4] = R[RCP]!;
    S[b + 5] = cb;
    S[b + 6] = cc;
    S[b + 9] = hp.top;
    S[b + 10] = n;
    for (let i = 0; i < n; i++) S[b + CPH + i] = this.A[i]!;
    R[RB] = b;
    hp.hb = hp.top;
    return b;
  }

  /** Pop the newest choicepoint `b`. */
  popCP(b: number): void {
    const p = this.S[b]!;
    this.R[RB] = p;
    this.hp.hb = this.S[p + 9]!;
  }

  /** Cut: drop the choicepoints newer than `b0`. */
  cutTo(b0: number): void {
    if (this.R[RB]! <= b0) return;
    // A cut past setup_call_cleanup's choicepoint runs its cleanup (Machine.cutTo).
    if (this.cleanups > 0) this.cleanupsAbove(b0, false);
    this.R[RB] = b0;
    this.hp.hb = this.S[b0 + 9]!;
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
      const b = R[RB]!;
      hp.undo(S[b + 2]!);
      hp.top = S[b + 9]!;
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
          if (hp.wakeups.length !== 0) throw new Error("cell engine: attribute wakeups are not built yet");
          return this.CODE[R[RCP]!]!;
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
        const e = this.allocate(1, cb, cc);
        S[e + ENV] = R[RB]!;
        R[RCP] = this.ONCE;
        return this.goal(H[p + 1]!, S[e + ENV]!, cc);
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
    S[fr + ENV + 1] = b;
    this.R[RCP] = soft ? this.ITE_SOFT : this.ITE_THEN;
    return this.goal(c, b, cc);
  }

  /** \+ G: G's cut is local to it; its success cuts back and fails, its failure goes on. */
  private negation(g: number, cb: number, cc: number): Code | null {
    const S = this.S;
    const b = this.pushCP(K_ALT, cb, cc, 0);
    S[b + 8] = this.PROCEED;
    const e = this.allocate(1, cb, cc);
    S[e + ENV] = b;
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
    if (this.hp.wakeups.length !== 0) throw new Error("cell engine: attribute wakeups are not built yet");
    return this.proceed();
  }

  /** setup_call_cleanup(S, G, C): S once; G under a cleanup choicepoint holding C, its cut local to it. */
  setupCallCleanup(setup: number, g: number, cleanup: number, cc: number): Code | null {
    const S = this.S, R = this.R;
    if (!this.solveCell(setup)) return this.fail();
    this.A[0] = cleanup;
    const b = this.pushCP(K_CLEANUP, R[RB]!, cc, 1);
    this.cleanups++;
    const e = this.allocate(1, b, cc);
    S[e + ENV] = b;
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
    S[e + ENV] = b;
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
    let b = R[RCC]!;
    // Each cleanup the ball passes runs, with the bindings undone to its setup's (Machine.unwindTo).
    if (this.cleanups > 0) this.cleanupsAbove(b > bar ? b : bar, true);
    while (b > bar && S[b + 1] === K_CATCH) {
      hp.undo(S[b + 2]!);
      hp.top = S[b + 9]!;
      R[RB] = b;
      hp.hb = S[b + 9]!;
      R[RE] = S[b + 3]!;
      R[RCP] = S[b + 4]!;
      const outer = S[b + 6]!;
      if (hp.unify(S[b + CPH]!, hp.encode(e.ball, new Map()))) {
        const recovery = S[b + CPH + 1]!;
        this.popCP(b);
        R[RCC] = outer;
        return this.goal(recovery, R[RB]!, outer);
      }
      hp.undo(S[b + 2]!);
      hp.top = S[b + 9]!;
      this.popCP(b);
      b = outer;
    }
    throw copiedBall(e);
  }

  /** Call `p` with A[0..n), the continuation being the current one. */
  callw(p: CellProc, n: number, cc: number): Code | null {
    // The catch context of the call, which a throw from inside it unwinds to (unwind).
    this.R[RCC] = cc;
    if (p.det !== undefined) {
      if (!p.det(this, n)) return this.fail();
      if (this.hp.wakeups.length !== 0) throw new Error("cell engine: attribute wakeups are not built yet");
      return this.proceed();
    }
    if (p.ctl !== undefined) return p.ctl(this, n, cc);
    let pred = p.pred;
    if (pred === undefined) {
      // A builtin comes before a predicate of its key, as the object machine resolves calls (Machine.callCell).
      const b = this.om.builtins.get(p.key);
      if (b !== undefined) {
        if (b.nondet !== undefined) p.ctl = (cm, k, c) => cm.callNondet(p.key, b, k, c);
        else {
          // A bridged det builtin answers true or false, or a goal cell it pushed, run next with its cut local.
          const run = bridgeBuiltin(p.key, b);
          p.ctl = (cm, k, c) => {
            const r = run(cm, k);
            if (r === false) return cm.fail();
            if (r !== true) return cm.goal(r, cm.R[RB]!, c);
            if (cm.hp.wakeups.length !== 0) throw new Error("cell engine: attribute wakeups are not built yet");
            return cm.proceed();
          };
        }
        return this.callw(p, n, cc);
      }
      pred = p.pred = this.om.db.preds.get(p.key);
      if (pred === undefined) throw existenceError("procedure", new Struct("/", [p.name, p.arity]));
    }
    const scan = clauseScan(pred, this.args);
    const r = this.tryClauses(pred, scan, scan.start, this.om.db.generation, cc, -1);
    return r === undefined ? this.fail() : r;
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
    for (let i = start; i < len; i++) {
      const c = cands[i]!;
      if (c.born > gen || c.died <= gen) continue;
      if (keyAt !== null) {
        const k = keyAt(c);
        if (k !== null && k !== key) continue;
      }
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
      i = j - 1;
    }
    if (cp >= 0) this.popCP(cp);
    return undefined;
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
    const S = this.S, R = this.R, hp = this.hp;
    const sE = R[RE]!, sCP = R[RCP]!, sB = R[RB]!, sCC = R[RCC]!, sBAR = R[RBAR]!;
    const sNest = this.nest;
    const sWake = this.hp.wakeups.length;
    const bar = this.pushCP(K_BARRIER, sB, sCC, 0);
    R[RBAR] = bar;
    R[RCP] = this.OK;
    try {
      let f: Code | null = () => this.callw(p, n, sCC);
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
      hp.top = S[bar + 9]!;
      R[RB] = sB;
      hp.hb = S[sB + 9]!;
      R[RE] = sE;
      R[RCP] = sCP;
      R[RCC] = sCC;
      R[RBAR] = sBAR;
      this.nest = sNest;
      this.hp.wakeups.length = sWake;
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
    if (this.hp.wakeups.length !== 0) throw new Error("cell engine: attribute wakeups are not built yet");
    if (!rule) return this.proceed();
    return this.goal(build(this.hp, st.prog.body!, 0, this.vals, this.next), h, cc);
  }

  /** Recompile hot clause `c` with an inline head and run it from its head, as its compact code was asked to. */
  retier(c: Clause, b0: number, cc: number): Code | null {
    const fn = this.compile!(this, c, true);
    c.cell = fn;
    return fn(b0, cc, 0);
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
    const sWake = this.hp.wakeups.length;
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
      this.hp.wakeups.length = sWake;
    }
  }
}
