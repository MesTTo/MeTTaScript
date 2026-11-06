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
import type { Machine } from "../machine";
import { MAX_LOOKAHEAD, clauseScan, type Scan } from "../swi-index";
import { CellArgs } from "./args";
import { bridgeBuiltin } from "./bridge";
import { headProgram, runHead, type HeadProgram } from "./headprog";
import { Heap } from "./heap";

/** Code the trampoline runs: the code to run next, or null at a run's exit. */
export type Code = () => Code | null;

/** What compiled clause code returns when its head does not unify. */
export const HEADFAIL = Object.freeze({ headFailed: true }) as unknown as Code;

/** Choicepoint kinds at S[b + 1]. */
export const K_CLAUSES = 0;
export const K_ALT = 1;
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

/** A fact not yet compiled: its head program and how often it has been tried. */
interface ColdFact {
  readonly prog: HeadProgram;
  tries: number;
}

/** A procedure as compiled code calls it: the predicate once one exists, or a native builtin over cells. */
export class CellProc {
  pred: Pred | undefined = undefined;
  /** A native deterministic builtin over the argument registers: true on success. */
  det: ((cm: CellMachine, n: number) => boolean) | undefined = undefined;
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
          for (let i = 0, n = S[b + 10]!; i < n; i++) this.A[i] = S[b + CPH + i]!;
          return this.CODE[this.RETRY]!;
        case K_ALT:
          this.popCP(b);
          R[RE] = S[b + 3]!;
          R[RCP] = S[b + 4]!;
          return this.CODE[S[b + 8]!]!;
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

  /** Call `p` with A[0..n), the continuation being the current one. */
  callw(p: CellProc, n: number, cc: number): Code | null {
    if (p.det !== undefined) return p.det(this, n) ? this.proceed() : this.fail();
    let pred = p.pred;
    if (pred === undefined) {
      // A builtin comes before a predicate of its key, as the object machine resolves calls (Machine.callCell).
      const b = this.om.builtins.get(p.key);
      if (b !== undefined) {
        p.det = bridgeBuiltin(p.key, b);
        return this.callw(p, n, cc);
      }
      pred = p.pred = this.om.db.preds.get(p.key);
      if (pred === undefined) throw new Error(`cell machine: unknown procedure ${p.key}`);
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

  /**
   * Solve the goal predicate `p` with A[0..n) for every solution, calling `each` after each one with whether a
   * choicepoint of the goal remains, as Machine.solveAll does; `each` returning false stops. Every binding and heap
   * cell of the run is undone at the end.
   */
  solveAll(p: CellProc, n: number, each: (hasChoice: boolean) => boolean | void): void {
    const S = this.S, R = this.R, hp = this.hp;
    const sE = R[RE]!, sCP = R[RCP]!, sB = R[RB]!, sCC = R[RCC]!, sBAR = R[RBAR]!;
    const sNest = this.nest;
    const bar = this.pushCP(K_BARRIER, sB, sCC, 0);
    R[RBAR] = bar;
    R[RCP] = this.OK;
    try {
      let f: Code | null = () => this.callw(p, n, sCC);
      this.nest = 0;
      for (;;) {
        while (f !== null) f = f();
        if (!this.result || each(R[RB] !== bar) === false) break;
        f = this.fail();
      }
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
    }
  }

  /**
   * Try clause `c`, which has no code yet: a rule is compiled now; a fact runs its head program until its
   * COMPILE_AFTERth try, when it is compiled. Returns what the clause's code would.
   */
  private cold(c: Clause, h: number, cc: number): Code | null {
    let st = c.cell as ColdFact | null;
    // A rule is compiled with an inline head at once; a fact first with a compact one (compile.ts, c-head-tiers-1106).
    const rule = c.body !== "true";
    if (rule || (st !== null && ++st.tries >= COMPILE_AFTER)) {
      const fn = this.compile!(this, c, rule);
      c.cell = fn;
      return fn(h, cc, 0);
    }
    if (st === null) c.cell = st = { prog: headProgram(this.hp, c), tries: 1 };
    if (c.nvars > this.vals.length) this.vals = new Int32Array(2 * c.nvars);
    if (!runHead(this.hp, st.prog, this.A, this.vals, this.next)) return HEADFAIL;
    if (this.hp.wakeups.length !== 0) throw new Error("cell engine: attribute wakeups are not built yet");
    return this.proceed();
  }

  /** Recompile hot clause `c` with an inline head and run it from its head, as its compact code was asked to. */
  retier(c: Clause, b0: number, cc: number): Code | null {
    const fn = this.compile!(this, c, true);
    c.cell = fn;
    return fn(b0, cc, 0);
  }

  /** Solve the goal predicate `p` with A[0..n) once; bindings persist on success. */
  solveOnce(p: CellProc, n: number): boolean {
    const R = this.R;
    const sE = R[RE]!, sCP = R[RCP]!, sB = R[RB]!, sCC = R[RCC]!, sBAR = R[RBAR]!;
    const sNest = this.nest;
    const bar = this.pushCP(K_BARRIER, sB, sCC, 0);
    R[RBAR] = bar;
    R[RCP] = this.OK;
    try {
      let f: Code | null = () => this.callw(p, n, sCC);
      this.nest = 0;
      while (f !== null) f = f();
      this.cutTo(sB);
      return this.result;
    } finally {
      R[RE] = sE;
      R[RCP] = sCP;
      R[RCC] = sCC;
      R[RBAR] = sBAR;
      this.nest = sNest;
    }
  }
}
