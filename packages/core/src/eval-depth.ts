// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import type { Atom } from "./atom";

/** Native recursion stays on the fast path below this logical user-call depth. */
export const EVALUATION_TRAMPOLINE_DEPTH = 32;

/** The default language-level call bound. Explicit `max-stack-depth 0` remains unlimited. */
export const DEFAULT_MAX_STACK_DEPTH = 320;

export interface EvaluationDepthSpan {
  base: number;
  peak: number;
}

interface ActiveEvaluationDepthSpan extends EvaluationDepthSpan {
  parent: ActiveEvaluationDepthSpan | undefined;
  active: boolean;
}

export type EvaluationDepthBoundary = "overflow" | "handoff";

/** A depth-bound branch cut raised inside compiled evaluation. The compiler unwinds to its evaluator
 *  boundary, which turns the attempted call and the state immediately before it into the normal
 *  `(Error <call> StackOverflow)` branch result. */
export class EvaluationDepthOverflow extends Error {
  constructor(
    readonly atom: Atom,
    readonly state?: unknown,
  ) {
    super("MeTTa evaluation depth exceeded");
    this.name = "EvaluationDepthOverflow";
  }
}

/** A compiled nested call reached the heap-evaluation boundary. The compiled attempt is abandoned before
 *  the call runs, then the evaluator replays the original application through its explicit driver. */
export class EvaluationDepthHandoff extends Error {
  constructor(
    readonly atom: Atom,
    readonly state?: unknown,
  ) {
    super("MeTTa evaluation moved to the heap continuation driver");
    this.name = "EvaluationDepthHandoff";
  }
}

/** The active user-equation call lineage for one evaluation branch. Tail transfers reuse the current
 *  level. Nested calls enter one level and leave it in `finally`, so host frames do not define the value.
 *  A positive bound N is exclusive: attempting level N is the StackOverflow cut, matching Hyperon's
 *  `depth >= max-stack-depth` check. Zero remains the explicit unlimited setting. */
export class EvaluationDepth {
  private level: number;
  private observed: number;
  private readonly floor: number;
  private marker: ActiveEvaluationDepthSpan | undefined;

  constructor(level = 0) {
    this.level = level;
    this.observed = level;
    this.floor = level;
  }

  get current(): number {
    return this.level;
  }

  get maximum(): number {
    return this.observed;
  }

  private observe(level: number): void {
    if (level > this.observed) this.observed = level;
    if (this.marker !== undefined && level > this.marker.peak) this.marker.peak = level;
  }

  tryEnter(limit: number): boolean {
    return this.enterBoundary(limit) === undefined;
  }

  /** Enter without constructing an error atom. The common path returns `undefined`; callers materialize
   *  boundary diagnostics only for the one attempted call that cannot enter. */
  enterBoundary(limit: number, handoffDepth = 0): EvaluationDepthBoundary | undefined {
    const next = this.level + 1;
    this.observe(next);
    if (limit > 0 && next >= limit) return "overflow";
    if (handoffDepth > 0 && next >= handoffDepth) return "handoff";
    this.level = next;
    return undefined;
  }

  enter(atom: Atom, limit: number, state?: unknown, handoffDepth = 0): void {
    const boundary = this.enterBoundary(limit, handoffDepth);
    if (boundary === "overflow") throw new EvaluationDepthOverflow(atom, state);
    if (boundary === "handoff") throw new EvaluationDepthHandoff(atom, state);
  }

  leave(): void {
    if (this.level <= this.floor) throw new Error("unbalanced MeTTa evaluation depth leave");
    this.level -= 1;
  }

  beginSpan(): EvaluationDepthSpan {
    const marker: ActiveEvaluationDepthSpan = {
      base: this.level,
      peak: this.level,
      parent: this.marker,
      active: true,
    };
    this.marker = marker;
    return marker;
  }

  span(marker: EvaluationDepthSpan): number {
    const active = marker as ActiveEvaluationDepthSpan;
    if (!active.active) throw new Error("unknown MeTTa evaluation depth span");
    return active.peak - active.base;
  }

  rebase(marker: EvaluationDepthSpan): void {
    const active = marker as ActiveEvaluationDepthSpan;
    if (!active.active) throw new Error("unknown MeTTa evaluation depth span");
    active.base = this.level;
    active.peak = this.level;
  }

  endSpan(marker: EvaluationDepthSpan): number {
    const active = marker as ActiveEvaluationDepthSpan;
    if (!active.active) throw new Error("unknown MeTTa evaluation depth span");
    if (this.marker !== active) throw new Error("out-of-order MeTTa evaluation depth span");
    this.marker = active.parent;
    active.active = false;
    if (active.parent !== undefined && active.peak > active.parent.peak)
      active.parent.peak = active.peak;
    return active.peak - active.base;
  }

  canReplay(span: number, limit: number): boolean {
    return limit === 0 || this.level + span < limit;
  }

  replay(span: number): void {
    this.observe(this.level + span);
  }

  fork(): EvaluationDepth {
    return new EvaluationDepth(this.level);
  }

  absorb(branch: EvaluationDepth): void {
    this.observe(branch.maximum);
  }
}
