// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: SWI-Prolog's load-time goal expansion as far as it changes what a program means: library(yall) compiles a
// lambda in a goal or meta-argument position into an auxiliary predicate, whose variables, all but the declared
// Free ones, are then local to each call even when the enclosing clause binds them first (a lambda copied at run
// time sees such bindings). The walk follows boot/expand.pl (expand_goal, expand_control, expand_meta,
// expand_meta_arg) and the rule follows yall.pl expand_lambda/2, both from swipl 10.1.17's sources.
// am[implements a-hp-yall-expansion]

import { copyTerm, type Machine } from "./machine";
import { Cons, NIL, Struct, Var, deref, mkStruct, mkVar, type Term } from "./terms";
import { writeTerm } from "./writer";
import { createHash } from "node:crypto";

/** A meta-argument specifier: an integer (a closure missing that many arguments), ^, //, :, or a mode. */
type MetaArg = number | string;

/**
 * Meta-predicates every SWI program sees from module user before loading any library (system and boot
 * predicates); library ones join when their file's meta_predicate directive is read. From swipl 10.1.17:
 * predicate_property(user:H, meta_predicate(S)) for each goal-taking system predicate (ai-tmp/probe/meta.pl).
 */
const SYSTEM_META: [string, MetaArg[]][] = [
  ["findall", ["?", 0, "-"]],
  ["findall", ["?", 0, "-", "?"]],
  ["forall", [0, 0]],
  ["bagof", ["?", "^", "-"]],
  ["setof", ["?", "^", "-"]],
  ["findnsols", ["+", "?", 0, "-"]],
  ["findnsols", ["+", "?", 0, "-", "?"]],
  ["once", [0]],
  ["ignore", [0]],
  ["not", [0]],
  ["call", [0]],
  ["call", [1, "?"]],
  ["call", [2, "?", "?"]],
  ["call", [3, "?", "?", "?"]],
  ["call", [4, "?", "?", "?", "?"]],
  ["call", [5, "?", "?", "?", "?", "?"]],
  ["call", [6, "?", "?", "?", "?", "?", "?"]],
  ["call", [7, "?", "?", "?", "?", "?", "?", "?"]],
  ["catch", [0, "?", 0]],
  ["catch_with_backtrace", [0, "?", 0]],
  ["setup_call_cleanup", [0, 0, 0]],
  ["setup_call_catcher_cleanup", [0, 0, "?", 0]],
  ["call_cleanup", [0, 0]],
  ["with_output_to", ["+", 0]],
  ["freeze", ["?", 0]],
  ["phrase", ["//", "?"]],
  ["phrase", ["//", "?", "?"]],
  ["snapshot", [0]],
  ["transaction", [0]],
  ["call_with_depth_limit", [0, "+", "-"]],
  ["call_with_inference_limit", [0, "+", "-"]],
  ["thread_create", [0, "?", "+"]],
  ["with_mutex", ["+", 0]],
  ["at_halt", [0]],
  ["sig_atomic", [0]],
  ["reset", [0, "?", "-"]],
  ["notrace", [0]],
];

interface ExpansionState {
  meta: Map<string, MetaArg[]>;
  /** library(yall) is loaded, so its goal_expansion/2 rule is active. */
  yall: boolean;
}

const states = new WeakMap<Machine, ExpansionState>();

function stateOf(m: Machine): ExpansionState {
  let s = states.get(m);
  if (s === undefined) {
    s = { meta: new Map(SYSTEM_META.map(([n, a]) => [n + "/" + a.length, a])), yall: false };
    states.set(m, s);
  }
  return s;
}

/** library(yall) is now loaded: lambdas in clauses read from here on compile to auxiliary predicates. */
export function enableYallExpansion(m: Machine): void {
  stateOf(m).yall = true;
}

/** The goal-expansion state a load leaves (image.ts saves it): meta-predicate declarations and whether yall expands. */
// am[implements a-petta-speed-1105.startup.image]
export function expansionSnapshot(m: Machine): { meta: [string, MetaArg[]][]; yall: boolean } {
  const s = stateOf(m);
  return { meta: [...s.meta], yall: s.yall };
}

// am[implements a-petta-speed-1105.startup.image]
export function restoreExpansion(m: Machine, snap: { meta: [string, MetaArg[]][]; yall: boolean }): void {
  states.set(m, { meta: new Map(snap.meta), yall: snap.yall });
}

/** Record a meta_predicate declaration's heads (a comma list of Name(Spec...) terms, possibly module-qualified). */
export function declareMetaPredicates(m: Machine, decl: Term): void {
  const st = stateOf(m);
  const visit = (t: Term): void => {
    let d = deref(t);
    while (d instanceof Struct && d.name === ":" && d.args.length === 2) d = deref(d.args[1]!);
    if (d instanceof Struct && d.name === "," && d.args.length === 2) {
      visit(d.args[0]!);
      visit(d.args[1]!);
      return;
    }
    if (d instanceof Cons) {
      for (let c: Term = d; c instanceof Cons; c = deref(c.tail)) visit(c.head);
      return;
    }
    if (d instanceof Struct) {
      const spec = d.args.map((a) => {
        const x = deref(a);
        return typeof x === "number" || typeof x === "string" ? x : "?";
      });
      st.meta.set(d.name + "/" + d.args.length, spec);
    }
  };
  visit(decl);
}

/**
 * The clause with its body goal-expanded (boot/expand.pl expand_bodies); `addAux` stores each auxiliary clause
 * a lambda compiles to, before the clause that calls it. A clause without lambdas comes back unchanged.
 */
export function expandClauseGoals(m: Machine, clause: Term, addAux: (c: Term) => void): Term {
  const st = stateOf(m);
  if (!st.yall) return clause;
  const d = deref(clause);
  if (d instanceof Struct && d.name === ":-" && d.args.length === 2) {
    const body = expandGoal(m, st, d.args[1]!, addAux);
    return body === d.args[1] ? d : mkStruct(":-", d.args[0]!, body);
  }
  return d;
}

/** A directive's goal, expanded as SWI expands it before running it. */
export function expandDirectiveGoal(m: Machine, goal: Term, addAux: (c: Term) => void): Term {
  const st = stateOf(m);
  return st.yall ? expandGoal(m, st, goal, addAux) : goal;
}

const CONTROL2 = new Set([",", ";", "->", "*->"]);

/** boot/expand.pl expand_goal and expand_control: goal_expansion first, then into control and meta-arguments. */
function expandGoal(m: Machine, st: ExpansionState, g0: Term, addAux: (c: Term) => void): Term {
  const g = deref(g0);
  if (g instanceof Var) return g0;
  if (g instanceof Struct && g.name === ":" && g.args.length === 2) {
    const inner = expandGoal(m, st, g.args[1]!, addAux);
    return inner === g.args[1] ? g0 : mkStruct(":", g.args[0]!, inner);
  }
  const lam = expandLambda(m, st, g, addAux);
  if (lam !== null) return lam;
  if (!(g instanceof Struct)) return g0;
  if (CONTROL2.has(g.name) && g.args.length === 2) {
    const a = expandGoal(m, st, g.args[0]!, addAux);
    const b = expandGoal(m, st, g.args[1]!, addAux);
    return a === g.args[0] && b === g.args[1] ? g0 : mkStruct(g.name, a, b);
  }
  if ((g.name === "\\+" || g.name === "$") && g.args.length === 1) {
    const a = expandGoal(m, st, g.args[0]!, addAux);
    return a === g.args[0] ? g0 : mkStruct(g.name, a);
  }
  const spec = st.meta.get(g.name + "/" + g.args.length);
  if (spec === undefined) return g0;
  let changed = false;
  const args = g.args.map((a, i) => {
    const e = expandMetaArg(m, st, spec[i]!, a, addAux);
    if (e !== a) changed = true;
    return e;
  });
  return changed ? new Struct(g.name, args) : g0;
}

/** boot/expand.pl expand_meta_arg: a goal, a closure extended by its missing arguments, or a ^-quantified goal. */
function expandMetaArg(m: Machine, st: ExpansionState, spec: MetaArg, a0: Term, addAux: (c: Term) => void): Term {
  if (spec === 0) return expandGoal(m, st, a0, addAux);
  if (typeof spec === "number") {
    const a = deref(a0);
    if (!(typeof a === "string" || a instanceof Struct)) return a0;
    const ex: Var[] = [];
    for (let i = 0; i < spec; i++) ex.push(mkVar());
    const extended = typeof a === "string" ? new Struct(a, ex) : new Struct(a.name, [...a.args, ...ex]);
    const e = deref(expandGoal(m, st, extended, addAux));
    if (e === extended) return a0;
    return removeExtraArgs(e, ex, a0, addAux);
  }
  if (spec === "^") return expandSetofGoal(m, st, a0, addAux);
  return a0;
}

/** boot/expand.pl remove_arg_pos: drop the extra arguments again, or wrap a goal that moved them. */
function removeExtraArgs(e: Term, ex: Var[], a0: Term, addAux: (c: Term) => void): Term {
  const n = ex.length;
  const args = e instanceof Struct ? e.args : [];
  const tail = args.slice(args.length - n);
  if (e instanceof Struct && args.length >= n && tail.every((t, i) => deref(t) === deref(ex[i]!))) {
    const rest = args.slice(0, args.length - n);
    return rest.length === 0 ? e.name : new Struct(e.name, rest);
  }
  // wrap_meta_arguments: '__aux_wrapper_<sha1>'(VL..., Ex...) :- E, called as '__aux_wrapper_<sha1>'(VL...).
  const vl = termVariables(a0);
  const name = "__aux_wrapper_" + sha1(mkStruct("+", a0, mkList([...vl, ...ex])));
  addAux(mkStruct(":-", new Struct(name, [...vl, ...ex]), e));
  return vl.length === 0 ? name : new Struct(name, vl);
}

function expandSetofGoal(m: Machine, st: ExpansionState, g0: Term, addAux: (c: Term) => void): Term {
  const g = deref(g0);
  if (g instanceof Struct && g.name === "^" && g.args.length === 2) {
    const inner = expandSetofGoal(m, st, g.args[1]!, addAux);
    return inner === g.args[1] ? g0 : mkStruct("^", g.args[0]!, inner);
  }
  return expandGoal(m, st, g0, addAux);
}

/**
 * yall.pl expand_lambda/2: Params>>Lambda called with extra arguments becomes '__aux_yall_<sha1>'(Free..., Extra...)
 * when Params unifies with the extra arguments (or Free/Params with them); Free/Closure likewise. The auxiliary
 * clause is compiled once per distinct lambda. Null when the goal is no such lambda.
 */
function expandLambda(m: Machine, st: ExpansionState, g: Term, addAux: (c: Term) => void): Term | null {
  if (!(g instanceof Struct) || g.args.length < 2 || (g.name !== ">>" && g.name !== "/")) return null;
  const extra = g.args.slice(2);
  if (g.name === ">>") {
    const parms = deref(g.args[0]!);
    const lambda = g.args[1]!;
    if (parms instanceof Var || !isCallable(lambda)) return null;
    const functor = "__aux_yall_" + sha1(mkStruct(">>", parms, lambda));
    let freeList: Term[] = [];
    if (parms instanceof Struct && parms.name === "/" && parms.args.length === 2 && unifiable(m, parms.args[1]!, mkList(extra))) {
      if (!isLambdaFree(parms.args[0]!)) return null;
      m.unify(parms.args[1]!, mkList(extra));
      freeList = freeToList(parms.args[0]!);
    } else if (unifiable(m, parms, mkList(extra))) m.unify(parms, mkList(extra));
    else return null;
    const head = mkHead(functor, [...freeList, ...extra]);
    compileAuxIfNew(m, st, head, lambda, addAux);
    return head;
  }
  const free = g.args[0]!;
  const closure = deref(g.args[1]!);
  if (!isLambdaFree(free) || !isCallable(closure)) return null;
  const functor = "__aux_yall_" + sha1(mkStruct("/", free, closure));
  const head = mkHead(functor, [...freeToList(free), ...extra]);
  const lambda = typeof closure === "string" ? mkHead(closure, extra) : new Struct((closure as Struct).name, [...(closure as Struct).args, ...extra]);
  compileAuxIfNew(m, st, head, lambda, addAux);
  return head;
}

/** yall.pl compile_aux_clause_if_new/2: the first lambda with this name defines it, its body expanded too. */
function compileAuxIfNew(m: Machine, st: ExpansionState, head: Term, lambda: Term, addAux: (c: Term) => void): void {
  const h = deref(head);
  const [name, arity] = typeof h === "string" ? [h, 0] : [(h as Struct).name, (h as Struct).args.length];
  const p = m.db.get(name, arity);
  if (p !== undefined && p.live > 0) return;
  addAux(mkStruct(":-", head, expandGoal(m, st, lambda, addAux)));
}

function mkHead(name: string, args: Term[]): Term {
  return args.length === 0 ? name : new Struct(name, args);
}

function mkList(items: Term[]): Term {
  let out: Term = NIL;
  for (let i = items.length - 1; i >= 0; i--) out = new Cons(items[i]!, out);
  return out;
}

function isCallable(t: Term): boolean {
  let d = deref(t);
  while (d instanceof Struct && d.name === ":" && d.args.length === 2) d = deref(d.args[1]!);
  return typeof d === "string" || d instanceof Struct;
}

/** {Vars} or {}: yall's is_lambda_free/1. */
function isLambdaFree(t: Term): boolean {
  const d = deref(t);
  return d === "{}" || (d instanceof Struct && d.name === "{}" && d.args.length === 1);
}

/** yall.pl free_to_list/2: the variables a {V1,V2,...} term lists. */
function freeToList(t: Term): Term[] {
  const d = deref(t);
  if (!(d instanceof Struct)) return [];
  const out: Term[] = [];
  let c = deref(d.args[0]!);
  while (c instanceof Struct && c.name === "," && c.args.length === 2) {
    out.push(c.args[0]!);
    c = deref(c.args[1]!);
  }
  out.push(c);
  return out;
}

/** Whether two terms unify, leaving no binding behind (a failed unify may bind part of its terms). */
function unifiable(m: Machine, a: Term, b: Term): boolean {
  return m.probeUnify(a, b);
}

function termVariables(t: Term): Var[] {
  const out: Var[] = [];
  const seen = new Set<Var>();
  const walk = (x: Term): void => {
    const d = deref(x);
    if (d instanceof Var) {
      if (!seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    } else if (d instanceof Cons) {
      walk(d.head);
      walk(d.tail);
    } else if (d instanceof Struct) for (const a of d.args) walk(a);
  };
  walk(t);
  return out;
}

/** variant_sha1/2 of a term without attributes: the SHA-1 of its quoted text with variables numbered in order. */
function sha1(t: Term): string {
  const c = copyTerm(t);
  let n = 0;
  for (const v of termVariables(c)) v.ref = mkStruct("$VAR", n++);
  return createHash("sha1").update(writeTerm(c, { quoted: true, numbervars: true })).digest("hex");
}
