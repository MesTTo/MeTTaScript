// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: PeTTa's MeTTa-to-Prolog translator, ported from src/translator.pl: an expression becomes a list of
// Prolog goals and an output term, an equation becomes a clause. The head of every application decides, at
// compile time, between a special form, a call to a registered function (arguments evaluated first unless a
// declaration types them Atom), data construction, and a runtime reduce/2 dispatch.
// am[implements a-pe-translator]

import type { Petta } from "./engine";
import { Cons, NIL, PrologError, Struct, Var, deref, isList, listToArray, mkList, mkStruct, mkVar, type Term } from "./terms";
import { copyTerm } from "./machine";
import { collectVars } from "./builtins";

const S = mkStruct;
const L = (...items: Term[]): Term => mkList(items);

export type Goals = Term[];
/** A translation: its goals and the term standing for its value. */
export type Tr = [Goals, Term];

/** goals_list_to_conj/2. */
export function conj(gs: Goals): Term {
  if (gs.length === 0) return "true";
  let out = gs[gs.length - 1]!;
  for (let i = gs.length - 2; i >= 0; i--) out = S(",", gs[i]!, out);
  return out;
}

/** disj_list/2. */
function disj(gs: Goals): Term {
  if (gs.length === 0) return "fail";
  let out = gs[gs.length - 1]!;
  for (let i = gs.length - 2; i >= 0; i--) out = S(";", gs[i]!, out);
  return out;
}

const isVar = (t: Term): t is Var => t instanceof Var;
const isAtomic = (t: Term): boolean => !(t instanceof Var) && !(t instanceof Cons) && !(t instanceof Struct);
const isPartial = (t: Term): boolean => t instanceof Struct && t.name === "partial" && t.args.length === 2;

/** Special forms by name/arity, from builtin_registry.pl's evaluation(special) entries; -1 is variadic. */
const SPECIAL: Record<string, Record<number, string>> = {
  superpose: { 1: "superpose_literal" },
  match: { 3: "typed_space_match" },
  "add-atom": { 2: "typed_space_update" },
  "remove-atom": { 2: "typed_space_update" },
  test: { 2: "test_collect" },
  "foldl-atom": { 5: "foldl_pseudo_lambda" },
  "map-atom": { 3: "map_pseudo_lambda" },
  "filter-atom": { 3: "filter_pseudo_lambda" },
  eval: { 1: "eval_source" },
  reduce: { 1: "dynamic_reduce" },
  data: { [-1]: "explicit_data" },
  "make-list": { [-1]: "explicit_list" },
  collapse: { 1: "collapse_all" },
  cut: { 0: "cut" },
  once: { 1: "once" },
  hyperpose: { 1: "hyperpose" },
  with_mutex: { 2: "with_mutex" },
  transaction: { 1: "transaction" },
  progn: { [-1]: "progn" },
  prog1: { [-1]: "prog1" },
  if: { 2: "if_then", 3: "if_then_else" },
  case: { 2: "case" },
  "and-then": { 2: "and_then" },
  "or-else": { 2: "or_else" },
  let: { 3: "let_bind" },
  chain: { 3: "let_bind" },
  "let*": { 2: "let_star" },
  sealed: { 2: "sealed" },
  forall: { 2: "forall" },
  foldall: { 3: "foldall" },
  "|->": { 2: "lambda" },
  translatePredicate: { 1: "translate_predicate" },
  call: { 1: "manual_call" },
  brand: { 2: "brand" },
  the: { 2: "type_ascription" },
  quote: { 1: "quote" },
  catch: { 1: "catch" },
};

export function specialForm(head: Term, nargs: number): string | null {
  if (typeof head !== "string") return null;
  const e = SPECIAL[head];
  if (e === undefined) return null;
  return e[nargs] ?? e[-1] ?? null;
}

export class Translator {
  /** Variables of the source form being translated (current_unified_source_variable/1). */
  private sourceVars = new Set<Var>();
  /** Symbols the clause being compiled used as plain data heads, for late-definition recompilation. */
  dataSymbols: Set<string> | null = null;
  constructor(private readonly p: Petta) {}

  /** Translate a runnable's expression with its source variables known. */
  runnable(e: Term): Tr {
    const saved = this.sourceVars;
    this.sourceVars = new Set(collectVars(e));
    try {
      return this.expr(mkList(["collapse", e]));
    } finally {
      this.sourceVars = saved;
    }
  }

  /**
   * build_isolated_branch/4: an if arm whose value is a source variable emits Out = Val instead of aliasing
   * it to the output at compile time, which would also bind every other use of that variable.
   */
  private buildIsolatedBranch(con: Term, val: Term, out: Term): Term {
    const v = deref(val);
    if (isVar(v) && this.sourceVars.has(v)) {
      const k = this.p.types.knownOf(v);
      if (k !== undefined) this.p.types.addKnown(out, k);
      return deref(con) === "true" ? S("=", out, v) : S(",", con, S("=", out, v));
    }
    return this.buildBranch(con, val, out);
  }

  private unify(a: Term, b: Term): void {
    this.p.types.mergeKnown(a, b);
    if (!this.p.m.unify(a, b)) throw new Error("translator: compile-time unification failed");
  }

  // ---- expressions ----

  /** translate_expr/3. */
  expr(e: Term): Tr {
    const x = deref(e);
    if (isVar(x) || isAtomic(x) || isPartial(x)) return [[], x];
    if (!(x instanceof Cons)) return [[], x];
    const items = listToArray(x);
    if (items === null) {
      // a partial list (from a cons pattern) is data
      return [[], x];
    }
    return this.application(this.rewriteStreamops(items));
  }

  /** rewrite_streamops/2 over a list of items. */
  private rewriteStreamops(items: Term[]): Term[] {
    const op = deref(items[0]!);
    if (typeof op !== "string") return items;
    const n = items.length - 1;
    const a = items.slice(1);
    if (op === "trace!" && n === 2) return ["progn", L("println!", a[0]!), a[1]!];
    if (op === "unique" && n === 1) return ["call", L("superpose", L("unique-atom", L("collapse", a[0]!)))];
    if (op === "alpha-unique" && n === 1) return ["call", L("superpose", L("alpha-unique-atom", L("collapse", a[0]!)))];
    if (op === "import!" && n === 2) {
      const lib = deref(a[1]!);
      const li = listToArray(lib);
      if (li !== null && li.length === 2 && deref(li[0]!) === "library") return ["library-import!", a[0]!, li[1]!];
    }
    if ((op === "union" || op === "intersection" || op === "subtraction") && n === 2) {
      const sa = listToArray(deref(a[0]!));
      const sb = listToArray(deref(a[1]!));
      if (sa !== null && sb !== null && sa.length > 0 && sb.length > 0 && deref(sa[0]!) === "superpose" && deref(sb[0]!) === "superpose") {
        const fn = op + "-atom";
        return ["call", L("superpose", L(fn, L("collapse", a[0]!), L("collapse", a[1]!)))];
      }
    }
    return items;
  }

  private application(items: Term[]): Tr {
    const [gsH, hv0] = this.expr(items[0]!);
    const hv = deref(hv0);
    const T = items.slice(1);
    const n = T.length;
    // translator rules: compile-time macros
    if (typeof hv === "string" && this.p.translatorRules.has(hv)) {
      const decls = this.p.types.declsArity(hv, n);
      const [gsT, t1] = decls.length > 0 ? this.argsByType(T, decls[0]!.args) : this.args(T);
      const gs = mkVar();
      const hook = new Struct(hv, [...t1, gs]);
      // The rule runs now, at compile time; its result is translated in place of the call.
      if (!this.p.m.solveOnce(conj([...gsT, ...this.callGoals(hook)]))) throw new PrologError(S("error", S("translator_rule_failed", hv), "none"));
      const [gsE, out] = this.expr(gs);
      return [[...gsH, ...gsT, ...gsE], out];
    }
    const sf = specialForm(hv, n);
    if (sf !== null) {
      const r = this.special(sf, hv as string, T, gsH);
      if (r !== null) return r;
    }
    if (hv === "case" && !(n === 2 && this.casePairsOk(T[1]!))) {
      this.p.m.err("Warning: (case ...) does not match (case Key ((Pattern Value) ...)) and compiles as plain data\n");
      const [gsD, out] = this.evalDataList([hv, ...T]);
      return [[...gsH, ...gsD], out];
    }
    // smart dispatch: known function or closure => call
    if (typeof hv === "string" && this.p.isFun(hv)) return this.typedCall(hv, [], T, gsH);
    if (hv instanceof Struct && hv.name === "partial" && hv.args.length === 2) {
      const fun = deref(hv.args[0]!);
      const bound = listToArray(hv.args[1]!) ?? [];
      if (typeof fun === "string") return this.typedCall(fun, bound, T, gsH);
    }
    // literals and non-function atoms => data
    if (isAtomic(hv) || typeof hv === "string") {
      if (typeof hv === "string") {
        this.p.symbolHeads.add(hv);
        this.dataSymbols?.add(hv);
      }
      const [gsT, avs] = this.args(T);
      return [[...gsH, ...gsT], mkList([hv, ...avs])];
    }
    // a data list in head position: evaluate inner function sublists
    if (hv instanceof Cons && isList(hv)) {
      const [gsT, avs] = this.args(T);
      const [gd, hv1] = this.evalDataTerm(hv);
      return [[...gsH, ...gsT, ...gd], mkList([hv1, ...avs])];
    }
    // unknown head (variable or compound) => runtime dispatch
    const [gsT, avs] = this.args(T);
    const inner = [...gsH, ...gsT];
    const out = mkVar();
    if (isVar(hv) && avs.length === 0) return [[...inner, S("reduce", L(hv), out)], out];
    return [[...inner, S("reduce", mkList([hv, ...avs]), out)], out];
  }

  private casePairsOk(ps: Term): boolean {
    const items = listToArray(deref(ps));
    if (items === null) return false;
    return items.every((pr) => {
      const p = listToArray(deref(pr));
      return p !== null && p.length === 2;
    });
  }

  private callGoals(t: Term): Goals {
    return [t];
  }

  /** translate_args/3. */
  args(xs: Term[]): [Goals, Term[]] {
    const goals: Goals = [];
    const vals: Term[] = [];
    for (const x of xs) {
      const [g, v] = this.expr(x);
      goals.push(...g);
      vals.push(v);
    }
    return [goals, vals];
  }

  /** translate_args_by_type/4: Atom-typed positions stay data. */
  argsByType(xs: Term[], types: (Term | undefined)[]): [Goals, Term[]] {
    const goals: Goals = [];
    const vals: Term[] = [];
    xs.forEach((x, i) => {
      const t = types[i];
      if (t !== undefined && this.p.types.expressionTyped(t)) vals.push(this.expressionArgValue(x));
      else {
        const [g, v] = this.expr(x);
        goals.push(...g);
        vals.push(v);
      }
    });
    return [goals, vals];
  }

  /** expression_arg_value/2: an Atom-typed argument stays data unless it is an underapplied known function. */
  private expressionArgValue(a: Term): Term {
    const d = deref(a);
    const items = listToArray(d);
    if (items !== null && items.length >= 1) {
      const f = deref(items[0]!);
      if (f === "brand" && items.length === 3) return this.expressionArgValue(items[2]!);
      if (typeof f === "string" && this.p.isFun(f) && this.maybeClosureExpr(f, items.length - 1)) {
        try {
          const [gs, v] = this.expr(d);
          const vd = deref(v);
          const trivial = gs.every((g) => deref(g) === "true");
          if (trivial && ((typeof vd === "string" && this.p.isFun(vd)) || (vd instanceof Struct && vd.name === "partial" && isGroundTerm(vd.args[1]!))))
            return vd;
        } catch (e) {
          if (!(e instanceof PrologError)) throw e;
        }
      }
    }
    return a;
  }

  private maybeClosureExpr(f: string, nargs: number): boolean {
    const ar = nargs + 1;
    return !(this.p.hasPredicate(f, ar) || this.p.hasArity(f, ar)) || (this.p.isOperatorName(f) && ar <= 2);
  }

  /** eval_data_term/3. */
  private evalDataTerm(x: Term): Tr {
    const d = deref(x);
    if (isVar(d) || isAtomic(d)) return [[], d];
    const items = listToArray(d);
    if (items === null) return [[], d];
    const f = deref(items[0]!);
    if (typeof f === "string" && this.p.isFun(f)) return this.expr(d);
    return this.evalDataList(items);
  }

  /** eval_data_list/3: elements that are lists are evaluated as data terms. */
  private evalDataList(items: Term[]): Tr {
    const goals: Goals = [];
    const vals: Term[] = [];
    for (const e of items) {
      const ed = deref(e);
      if (ed === NIL || (ed instanceof Cons && isList(ed))) {
        const [g, v] = this.evalDataTerm(ed);
        goals.push(...g);
        vals.push(v);
      } else vals.push(e);
    }
    return [goals, mkList(vals)];
  }

  /** translate_expr_to_conj/3. */
  toConj(e: Term): [Term, Term] {
    const [gs, out] = this.expr(e);
    return [conj(gs), out];
  }

  // ---- special forms ----

  private special(sf: string, hv: string, T: Term[], gsH: Goals): Tr | null {
    switch (sf) {
      case "explicit_data": {
        const [gs, vals] = this.args(T);
        const out = mkVar();
        return [[...gsH, ...gs, S("=", out, mkList(vals))], out];
      }
      case "explicit_list": {
        const [gs, vals] = this.args(T);
        const out = mkVar();
        return [[...gsH, ...gs, S("=", out, mkList(vals))], out];
      }
      case "superpose_literal": {
        const lst = listToArray(deref(T[0]!));
        if (lst === null) return null;
        const out = mkVar();
        const branches = lst.map((e) => {
          const [c, v] = this.toConj(e);
          return this.buildBranch(c, v, out);
        });
        return [[...gsH, disj(branches)], out];
      }
      case "collapse_all": {
        const [c, ev] = this.toConj(T[0]!);
        const out = mkVar();
        return [[...gsH, S("findall", ev, c, out)], out];
      }
      case "cut":
        return [[...gsH, "!"], "true"];
      case "test_collect": {
        const [c, val] = this.toConj(T[0]!);
        const [gsE, expVal] = this.expr(T[1]!);
        const results = mkVar();
        const actual = mkVar();
        const out = mkVar();
        const g1 = S(",", S("findall", val, c, results), S(";", S("->", S("=", results, L(actual)), "true"), S("=", actual, results)));
        return [[...gsH, g1, ...gsE, S("test", actual, expVal, out)], out];
      }
      case "once": {
        const [c, out] = this.toConj(T[0]!);
        return [[...gsH, S("once", c)], out];
      }
      case "hyperpose": {
        const lst = listToArray(deref(T[0]!));
        const out = mkVar();
        if (lst !== null) {
          const branches = lst.map((e) => {
            const [g, r] = this.toConj(e);
            return S(",", g, r);
          });
          const goal = mkVar();
          const res = mkVar();
          return [[...gsH, S("concurrent_and", S("member", S(",", goal, res), mkList(branches)), S(",", S("call", goal), S("=", out, res)))], out];
        }
        const [gsL, lv] = this.expr(T[0]!);
        return [[...gsH, ...gsL, S("hyperpose_runtime", lv, out)], out];
      }
      case "with_mutex": {
        const [c, out] = this.toConj(T[1]!);
        return [[...gsH, S("with_mutex", T[0]!, c)], out];
      }
      case "transaction": {
        const [c, out] = this.toConj(T[0]!);
        return [[...gsH, S("transaction", c)], out];
      }
      case "progn": {
        const [gs, outs] = this.args(T);
        return [[...gsH, ...gs], outs.length > 0 ? outs[outs.length - 1]! : mkVar()];
      }
      case "prog1": {
        if (T.length === 0) return null;
        const [gsF, out] = this.expr(T[0]!);
        const [gsR] = this.args(T.slice(1));
        return [[...gsH, ...gsF, ...gsR], out];
      }
      case "if_then": {
        const [preC, condGoal] = this.ifCond(T[0]!);
        const [conT, tv] = this.toConj(T[1]!);
        const out = mkVar();
        const bt = this.buildIsolatedBranch(conT, tv, out);
        const ite = S("->", condGoal, bt);
        return [[...gsH, preC === "true" ? ite : S(",", preC, ite)], out];
      }
      case "if_then_else": {
        const [preC, condGoal] = this.ifCond(T[0]!);
        const out = mkVar();
        const [conT, tv] = this.toConj(T[1]!);
        const bt = this.buildIsolatedBranch(conT, tv, out);
        const [conE, ev] = this.toConj(T[2]!);
        const be = this.buildIsolatedBranch(conE, ev, out);
        const ite = S(";", S("->", condGoal, bt), be);
        return [[...gsH, preC === "true" ? ite : S(",", preC, ite)], out];
      }
      case "case": {
        const pairs = listToArray(deref(T[1]!));
        if (pairs === null) return null;
        const out = mkVar();
        const idx = pairs.findIndex((pr) => {
          const p = listToArray(deref(pr));
          return p !== null && p.length === 2 && deref(p[0]!) === "Empty";
        });
        if (idx >= 0) {
          const dflt = listToArray(deref(pairs[idx]!))![1]!;
          const normal = pairs.filter((_, i) => i !== idx);
          const [gkConj, kv] = this.toConj(T[0]!);
          const [caseGoal, keyGoals] = this.translateCase(normal, kv, out);
          const [conD, dOut] = this.toConj(dflt);
          const dThen = this.buildBranch(conD, dOut, out);
          return [[...gsH, ...keyGoals, this.caseWithEmpty(gkConj, caseGoal, dThen)], out];
        }
        const [gk, kv] = this.expr(T[0]!);
        const [ifGoal, keyGoals] = this.translateCase(pairs, kv, out);
        return [[...gsH, ...gk, ...keyGoals, ifGoal], out];
      }
      case "and_then": {
        const [ca, av] = this.toConj(T[0]!);
        const [cb, bv] = this.toConj(T[1]!);
        const out = mkVar();
        return [[...gsH, S(",", ca, S(";", S("->", S("==", av, "true"), S(",", cb, S("=", out, bv))), S("=", out, "false")))], out];
      }
      case "or_else": {
        const [ca, av] = this.toConj(T[0]!);
        const [cb, bv] = this.toConj(T[1]!);
        const out = mkVar();
        return [[...gsH, S(",", ca, S(";", S("->", S("==", av, "true"), S("=", out, "true")), S(",", cb, S("=", out, bv))))], out];
      }
      case "let_bind": {
        const [gp, pv] = this.expr(T[0]!);
        const [gv, v] = this.expr(T[1]!);
        const vt = this.p.types.valueType(v);
        if (vt !== undefined) this.p.types.bindPattern(pv, vt);
        const [gi, out] = this.expr(T[2]!);
        return [[...gsH, S("=", pv, v), ...gp, ...gv, ...gi], out];
      }
      case "let_star": {
        const binds = listToArray(deref(T[0]!));
        if (binds === null || binds.length === 0) return null;
        return this.expr(letstarToRecLet(binds, T[1]!));
      }
      case "sealed": {
        const [con, val] = this.toConj(T[1]!);
        const out = mkVar();
        const ncon = mkVar();
        return [[S("copy_term", T[0]!, L(con, val), mkVar(), L(ncon, out)), ncon], out];
      }
      case "forall": {
        const gf = deref(T[0]!);
        let gsGF: Goals;
        let genList: Term[];
        const gfl = listToArray(gf);
        if (gfl !== null && gfl.length > 0) {
          const [gsH2, gfhv] = this.expr(gfl[0]!);
          const [gsA, avs] = this.args(gfl.slice(1));
          gsGF = [...gsH2, ...gsA];
          genList = [gfhv, ...avs];
        } else {
          const [g, v] = this.expr(gf);
          gsGF = g;
          genList = [v];
        }
        const [gsTF, tfhv] = this.expr(T[1]!);
        const v = mkVar();
        const truth = mkVar();
        const out = mkVar();
        const genGoal = S(",", conj(gsGF), S("reduce", mkList(genList), v));
        const test = S(",", S("reduce", L(tfhv, v), truth), S("==", truth, "true"));
        return [[...gsH, ...gsTF, S(";", S("->", S("forall", genGoal, test), S("=", out, "true")), S("=", out, "false"))], out];
      }
      case "foldall": {
        const [conjInit, init] = this.toConj(T[2]!);
        const [gsAF, afv] = this.expr(T[0]!);
        const gf = deref(T[1]!);
        const gfl = listToArray(gf);
        let gsGF: Goals;
        let genList: Term[];
        if (gfl !== null && gfl.length > 0 && ["match", "let", "let*"].includes(deref(gfl[0]!) as string)) {
          const [g, h] = this.expr(L("|->", NIL, gf));
          gsGF = g;
          genList = [h];
        } else if (gfl !== null && gfl.length > 0) {
          const [gsH2, gfhv] = this.expr(gfl[0]!);
          const [gsA, avs] = this.args(gfl.slice(1));
          gsGF = [...gsH2, ...gsA];
          genList = [gfhv, ...avs];
        } else {
          const [g, h] = this.expr(gf);
          gsGF = g;
          genList = [h];
        }
        const v = mkVar();
        const out = mkVar();
        return [[...gsH, ...gsAF, ...gsGF, conjInit, S("foldall", S("agg_reduce", afv, v), S("reduce", mkList(genList), v), init, out)], out];
      }
      case "foldl_pseudo_lambda": {
        const [list, initE, accVar, xVar, body] = T as [Term, Term, Term, Term, Term];
        const [conjList, l] = this.toConj(list);
        const [conjInit, initV] = this.toConj(initE);
        const [bodyConj, bg] = this.toConj(body);
        const newAcc = mkVar();
        const out = mkVar();
        const pre = [conjList, conjInit].filter((g) => deref(g) !== "true");
        const lam = S(">>", L(xVar, accVar, newAcc), S(",", bodyConj, S(";", S("->", S("number", bg), S("is", newAcc, bg)), S("=", newAcc, bg))));
        return [[...gsH, ...pre, S("foldl", lam, l, initV, out)], out];
      }
      case "map_pseudo_lambda": {
        const [list, xVar, body] = T as [Term, Term, Term];
        const [conjList, l] = this.toConj(list);
        const [bodyConj, bodyCall] = this.toConj(body);
        const y = mkVar();
        const out = mkVar();
        const pre = [conjList].filter((g) => deref(g) !== "true");
        const lam = S(">>", L(xVar, y), S(",", bodyConj, S(";", S("->", S("number", bodyCall), S("is", y, bodyCall)), S("=", y, bodyCall))));
        return [[...gsH, ...pre, S("maplist", lam, l, out)], out];
      }
      case "filter_pseudo_lambda": {
        const [list, xVar, cond] = T as [Term, Term, Term];
        const [conjList, l] = this.toConj(list);
        const [condConj, condGoal] = this.toConj(cond);
        const out = mkVar();
        const pre = [conjList].filter((g) => deref(g) !== "true");
        return [[...gsH, ...pre, S("include", S(">>", L(xVar), S(",", condConj, condGoal)), l, out)], out];
      }
      case "lambda": {
        const name = this.p.nextLambdaName();
        const argsT = T[0]!;
        const body = T[1]!;
        const argVars = collectVars(argsT);
        const freeVars = collectVars(body).filter((v) => !argVars.includes(v));
        const argItems = listToArray(deref(argsT)) ?? [];
        const fullArgs = [...freeVars, ...argItems];
        const source = L("=", mkList([name, ...fullArgs]), body);
        // A lambda body is deferred code: compile a copy, so its translation cannot bind the enclosing clause.
        const isolated = copyTerm(source);
        this.p.registerFun(name);
        this.p.compileAndAssert(isolated, "lambda");
        const out: Term = freeVars.length === 0 ? name : S("partial", name, mkList(freeVars));
        return [gsH, out];
      }
      case "typed_space_update": {
        const sp = deref(T[0]!);
        if (typeof sp === "string") this.p.checkTypedSpaceValue(sp, T[1]!);
        const [g1, s] = this.expr(T[0]!);
        const out = mkVar();
        return [[...gsH, ...g1, new Struct(hv, [s, T[1]!, out])], out];
      }
      case "typed_space_match": {
        const [g1, s] = this.expr(T[0]!);
        const sp = deref(T[0]!);
        let pattern: Term = T[1]!;
        let patternGoals: Goals = [];
        if (typeof sp === "string" && this.p.m.solveOnce(S("declared_space_type", sp, mkVar()))) [pattern, patternGoals] = this.constrainTypedSpaceArgs(pattern);
        const [gsB, out] = this.expr(T[2]!);
        return [[...gsH, ...g1, S("match", s, pattern, out, out), ...patternGoals, ...gsB], out];
      }
      case "translate_predicate": {
        const e = listToArray(deref(T[0]!));
        if (e === null || e.length === 0) return null;
        const [gs, outs] = this.args(e.slice(1));
        return [[...gsH, ...gs, new Struct(deref(e[0]!) as string, outs)], mkVar()];
      }
      case "manual_call": {
        const e = listToArray(deref(T[0]!));
        if (e === null || e.length === 0) return null;
        const f = deref(e[0]!) as string;
        const [gs, outs] = this.args(e.slice(1));
        const out = mkVar();
        const guards = this.manualDispatchChecks(f, outs, out);
        return [[...gsH, ...gs, ...guards, new Struct(f, [...outs, out])], out];
      }
      case "dynamic_reduce": {
        const e = deref(T[0]!);
        const out = mkVar();
        if (isVar(e)) return [[S("reduce", e, out), ...gsH], out];
        const items = listToArray(e);
        if (items === null || items.length === 0) return null;
        const [gs, outs] = this.args(items.slice(1));
        const f0 = deref(items[0]!);
        const guards = typeof f0 === "string" ? this.manualDispatchChecks(f0, outs, out) : [];
        return [[...gsH, ...gs, ...guards, S("reduce", mkList([items[0]!, ...outs]), out)], out];
      }
      case "eval_source": {
        const a = deref(T[0]!);
        const items = listToArray(a);
        if (items !== null && items.length === 2 && deref(items[0]!) === "quote") {
          const [gq, out] = this.expr(items[1]!);
          return [[...gsH, ...gq], out];
        }
        const out = mkVar();
        return [[...gsH, S("eval", a, out)], out];
      }
      case "brand": {
        const [gsE, out] = this.expr(T[1]!);
        return [[...gsH, ...gsE], out];
      }
      case "type_ascription": {
        const [gsE, out0] = this.expr(T[1]!);
        const tn = this.p.types.normalize(T[0]!);
        const gsA = this.p.types.ascribe(out0, tn);
        return [[...gsH, ...gsE, ...gsA], out0];
      }
      case "quote":
        return [gsH, T[0]!];
      case "catch": {
        const [gsE, exprOut] = this.expr(T[0]!);
        const out = mkVar();
        const exc = mkVar();
        const ty = mkVar();
        const ctx = mkVar();
        const goal = S(
          "catch",
          S(",", conj(gsE), S("=", out, exprOut)),
          exc,
          S(";", S("->", S("=", exc, S("error", ty, ctx)), S("=", out, L("Error", ty, ctx))), S("=", out, L("Error", exc, "none"))),
        );
        return [[...gsH, goal], out];
      }
    }
    return null;
  }

  /** manual_dispatch_arg_checks_status/5: a uniquely declared callee's arguments are checked as at a call. */
  private manualDispatchChecks(f: string, avs: Term[], out: Term): Goals {
    const decls = this.p.types.declsArity(f, avs.length);
    if (decls.length !== 1) return [];
    const guards = this.p.types.callGuards(f, avs, decls[0]!.args);
    if (!(deref(decls[0]!.out) instanceof Var)) this.p.types.addKnown(out, decls[0]!.out);
    return guards;
  }

  /** translate_if_cond/3: a reified builtin comparison feeding only the condition becomes the native test. */
  private ifCond(cond: Term): [Term, Term] {
    const [gsC, cv] = this.expr(cond);
    const cvd = deref(cv);
    if (isVar(cvd) && gsC.length > 0) {
      const last = deref(gsC[gsC.length - 1]!);
      if (last instanceof Struct && last.args.length === 3 && deref(last.args[2]!) === cvd) {
        const native = cmpNative(last.name, last.args[0]!, last.args[1]!);
        if (native !== null && this.p.builtinUntouched(last.name)) return [conj(gsC.slice(0, -1)), native];
      }
    }
    return [conj(gsC), S("==", cv, "true")];
  }

  /** build_branch/4: a variable branch value is aliased to the output at compile time. */
  buildBranch(con: Term, val: Term, out: Term): Term {
    if (deref(con) === "true") return S("=", out, val);
    const v = deref(val);
    if (isVar(v)) {
      this.unify(v, out);
      return con;
    }
    return S(",", S("=", val, out), con);
  }

  /** translate_case/6: nested if-then-else, first matching pattern wins. */
  private translateCase(pairs: Term[], kv: Term, out: Term): [Term, Goals] {
    if (pairs.length === 0) return ["fail", []];
    const p = listToArray(deref(pairs[0]!))!;
    const [k, vExpr] = [p[0]!, p[1]!];
    const [conV, vOut] = this.toConj(vExpr);
    const [kc, gc] = this.constrainArgs(k);
    const then = this.buildBranch(conV, vOut, out);
    if (pairs.length === 1) return [S("->", S("=", kv, kc), then), gc];
    const [next, kgi] = this.translateCase(pairs.slice(1), kv, out);
    return [S(";", S("->", S("=", kv, kc), then), next), [...gc, ...kgi]];
  }

  /** case_with_empty/4: Empty runs only if the key yields no value. */
  private caseWithEmpty(gkConj: Term, caseGoal: Term, dThen: Term): Term {
    if (!containsCut(gkConj)) return S(";", S("*->", gkConj, caseGoal), dThen);
    const seen = S("seen", mkVar());
    return S(",", S("functor", seen, "seen", 1), S(";", S(",", gkConj, S(",", S("nb_setarg", 1, seen, "true"), caseGoal)), S(",", S("arg", 1, seen, mkVar()), dThen)));
  }

  // ---- patterns ----

  /** constrain_args/3: cons patterns become list cells, registered-function patterns become calls. */
  constrainArgs(x: Term): [Term, Goals] {
    const d = deref(x);
    if (isVar(d) || isAtomic(d)) return [d, []];
    const items = listToArray(d);
    if (items === null) return [d, []];
    if (items.length === 3 && deref(items[0]!) === "cons") {
      const [a1, g1] = this.constrainArgs(items[1]!);
      const [b1, g2] = this.constrainArgs(items[2]!);
      return [new Cons(a1, b1), [...g1, ...g2]];
    }
    const f = deref(items[0]!);
    if (typeof f === "string" && f !== "cons" && this.p.isFun(f)) {
      const [gs, v] = this.expr(d);
      return [v, gs];
    }
    const outs: Term[] = [];
    const goals: Goals = [];
    for (const it of items) {
      const [o, g] = this.constrainArgs(it);
      outs.push(o);
      goals.push(...g);
    }
    return [mkList(outs), goals];
  }

  /**
   * constrain_typed_space_args/3: in a schema-backed space pattern, a functional pattern whose function has a
   * single det declaration of that arity is an exact-one inverse constraint run after the match; cons
   * patterns become list cells.
   */
  private constrainTypedSpaceArgs(x: Term): [Term, Goals] {
    const d = deref(x);
    if (d instanceof Var || isAtomic(d)) return [d, []];
    const items = listToArray(d);
    if (items === null) return [d, []];
    if (items.length === 3 && deref(items[0]!) === "cons") {
      const [a1, g1] = this.constrainTypedSpaceArgs(items[1]!);
      const [b1, g2] = this.constrainTypedSpaceArgs(items[2]!);
      return [new Cons(a1, b1), [...g1, ...g2]];
    }
    const f = deref(items[0]!);
    if (typeof f === "string" && f !== "cons" && this.p.isFun(f)) {
      const decls = this.p.types.declsArity(f, items.length - 1);
      if (decls.length === 1 && decls[0]!.det === "det") {
        const [gs, v] = this.expr(d);
        return [v, gs];
      }
    }
    const outs: Term[] = [];
    const goals: Goals = [];
    for (const it of items) {
      const [o, g] = this.constrainTypedSpaceArgs(it);
      outs.push(o);
      goals.push(...g);
    }
    return [mkList(outs), goals];
  }

  // ---- calls ----

  /** translate_typed_call/6. */
  private typedCall(fun: string, bound: Term[], argsT: Term[], gsH: Goals): Tr {
    const nTotal = argsT.length + bound.length;
    const decls = this.p.types.declsArity(fun, nTotal);
    if (decls.length > 0) {
      const effTs = this.p.types.effArgTypes(decls, bound.length, argsT.length);
      const [gsT, avs0] = this.argsByType(argsT, effTs);
      const avs = [...bound, ...avs0];
      const out = mkVar();
      if (decls.length === 1) {
        const d = decls[0]!;
        this.p.types.resolveDecl(avs, d.args);
        const guards = this.p.types.callGuards(fun, avs, d.args);
        const inner = [...gsH, ...gsT, ...guards];
        if (!(deref(d.out) instanceof Var)) this.p.types.addKnown(out, d.out);
        const arith = this.arithInline(fun, avs, out);
        if (arith !== null) return [[...inner, ...arith], out];
        return [this.buildCallOrPartial(fun, avs, out, inner, []), out];
      }
      const survivors = decls.filter((d) => this.p.types.declSurvives(avs, d.args));
      if (survivors.length === 0) throw new PrologError(S("error", S("no_matching_overload", fun), "typecheck"));
      if (survivors.length === 1) {
        const d = survivors[0]!;
        const guards = this.p.types.callGuards(fun, avs, d.args);
        const outGuard = this.p.types.overloadOutGuard(out, d.out);
        return [this.buildCallOrPartial(fun, avs, out, [...gsH, ...gsT, ...guards], outGuard), out];
      }
      const branches = survivors.map((d) => {
        const guards = this.p.types.matchGuards(avs, d.args);
        const outGuard = this.p.types.overloadOutGuard(out, d.out);
        return conj(this.buildDirectCall(fun, avs, out, guards, outGuard));
      });
      return [[...gsH, ...gsT, S("goal_or_throw", disj(branches), S("error", S("no_matching_overload", fun), "typecheck"))], out];
    }
    const [gsT, avs0] = this.args(argsT);
    const avs = [...bound, ...avs0];
    const out = mkVar();
    this.p.types.untypedCallOut(fun, avs, out);
    return [this.buildCallOrPartial(fun, avs, out, [...gsH, ...gsT], []), out];
  }

  /** arith_inline/4: builtin arithmetic on a resolved single declaration compiles to is/2. */
  private arithInline(fun: string, avs: Term[], out: Term): Goals | null {
    if (avs.length !== 2) return null;
    const op = ARITH_OPS[fun];
    if (op === undefined || !this.p.builtinUntouched(fun)) return null;
    const expr = S(op, avs[0]!, avs[1]!);
    const a = deref(avs[0]!);
    const b = deref(avs[1]!);
    if (isNum(a) && isNum(b)) {
      try {
        const v = this.p.evalArith(expr);
        this.unify(out, v);
        return [];
      } catch {
        return [S("is", out, expr)];
      }
    }
    return [S("is", out, expr)];
  }

  /** build_call_or_partial/7. */
  buildCallOrPartial(fun: string, avs: Term[], out: Term, inner: Goals, extra: Goals): Goals {
    const spec = this.p.specializer.maybeSpecialize(fun, avs, out);
    if (spec !== null) return [...inner, spec, ...extra];
    return this.buildDirectCall(fun, avs, out, inner, extra);
  }

  /** build_direct_call/7: a full-arity call, a partial, or an overapplication error. */
  buildDirectCall(fun: string, avs: Term[], out: Term, inner: Goals, extra: Goals): Goals {
    const ar = avs.length + 1;
    if ((this.p.hasPredicate(fun, ar) || this.p.hasArity(fun, ar)) && !(this.p.isOperatorName(fun) && ar <= 2)) {
      const goal = this.p.memoizedCall(fun, avs, out) ?? new Struct(fun, [...avs, out]);
      return [...inner, this.p.commitCall(fun, avs, goal), ...extra];
    }
    if (this.p.incompleteApplicationKind(fun, ar) === "partial") {
      this.unify(out, S("partial", fun, mkList(avs)));
      return [...inner, ...extra];
    }
    return [...inner, S("throw_function_overapplication", fun, avs.length), ...extra];
  }

  // ---- clauses ----

  /**
   * translate_clause/4 for (= (F Args...) Body): head patterns constrained, body translated, a partial body
   * eta-expanded into extra head arguments. Returns the clause term.
   */
  clause(input: Term, constrain = true): Term {
    const saved = this.sourceVars;
    this.sourceVars = new Set(collectVars(input));
    try {
      return this.clauseCore(input, constrain);
    } finally {
      this.sourceVars = saved;
    }
  }

  private clauseCore(input: Term, constrain: boolean): Term {
    const items = listToArray(deref(input))!;
    const headItems = listToArray(deref(items[1]!))!;
    const f = deref(headItems[0]!) as string;
    const args0 = headItems.slice(1);
    const body = items[2]!;
    let args1: Term[] = args0;
    const prefix: Goals = [];
    if (constrain) {
      args1 = [];
      for (const a of args0) {
        const [o, g] = this.constrainArgs(a);
        args1.push(o);
        prefix.push(...g);
      }
    }
    this.p.addFunMeta(f, args1, body, prefix.length === 0 ? "clean" : "head_goals");
    const decl = this.p.types.bindParamTypes(f, args1);
    const [goalsBody, expOut0] = this.p.types.declaredBody(f, args1.length, body);
    const expOut = deref(expOut0);
    let headArgs = args1;
    let finalGoals = goalsBody;
    let out: Term = expOut;
    if (expOut instanceof Struct && expOut.name === "partial" && expOut.args.length === 2) {
      const base = deref(expOut.args[0]!) as string;
      const boundL = listToArray(expOut.args[1]!) ?? [];
      const ar = this.p.firstArity(base);
      if (ar !== undefined) {
        const m = ar - boundL.length - 1;
        const extraArgs: Term[] = [];
        for (let i = 0; i < m; i++) extraArgs.push(mkVar());
        const o = mkVar();
        const goal = this.p.memoizedCall(base, [...boundL, ...extraArgs], o) ?? new Struct(base, [...boundL, ...extraArgs, o]);
        finalGoals = [...goalsBody, goal];
        headArgs = [...args1, ...extraArgs];
        out = o;
      }
    }
    const head = new Struct(f, [...headArgs, out]);
    this.p.noteArity(f, headArgs.length + 1);
    const commit = this.p.clauseCommitCut(f, args1.length) ? ["!"] : [];
    const outChecks = headArgs === args1 ? this.p.types.clauseOutputGoals(decl, out, body) : [];
    const bodyGoals = [...prefix, ...commit, ...finalGoals, ...outChecks];
    return bodyGoals.length === 0 ? head : S(":-", head, conj(bodyGoals));
  }
}

const ARITH_OPS: Record<string, string> = { "+": "+", "-": "-", "*": "*", "/": "/", "%": "mod", min: "min", max: "max" };

function cmpNative(name: string, a: Term, b: Term): Term | null {
  switch (name) {
    case "<":
      return S("<", a, b);
    case "<=":
      return S("=<", a, b);
    case ">":
      return S(">", a, b);
    case ">=":
      return S(">=", a, b);
    case "==":
      return S("==", a, b);
    case "!=":
      return S("\\==", a, b);
  }
  return null;
}

function isNum(t: Term): boolean {
  return typeof t === "number" || typeof t === "bigint" || (t instanceof Struct ? false : t !== null && typeof t === "object" && "v" in (t as object));
}

/** letstar_to_rec_let/3. */
function letstarToRecLet(binds: Term[], body: Term): Term {
  const first = listToArray(deref(binds[0]!))!;
  if (binds.length === 1) return L("let", first[0]!, first[1]!, body);
  return L("let", first[0]!, first[1]!, letstarToRecLet(binds.slice(1), body));
}

function containsCut(t: Term): boolean {
  const d = deref(t);
  if (d === "!") return true;
  if (d instanceof Struct) return d.args.some(containsCut);
  if (d instanceof Cons) return containsCut(d.head) || containsCut(d.tail);
  return false;
}

function isGroundTerm(t: Term): boolean {
  return collectVars(t).length === 0;
}
