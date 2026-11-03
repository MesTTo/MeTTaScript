// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the part of PeTTa's type system (src/typecheck) that decides how a declared call compiles and what
// a valid program prints: the declaration store for (: Name Type) atoms of every kind (function arrows, values,
// Newtype, Alias, Foreign, SpaceOf), arguments typed Atom kept as data, literal arguments checked by
// check_value/3, overloads resolved statically or dispatched at runtime, residual runtime guards, and a body
// returned as data when its function is declared to return Atom. The value checks are value_checks.pl and
// type_lang.pl ported as Prolog clauses (TYPES_RUNTIME_PL) and consulted by the translator at compile time.
// am[implements a-pe-types-runtime]

import type { Petta } from "./engine";
import type { Goals, Tr } from "./translator";
import { copyTerm, type Machine } from "./machine";
import { Cons, NIL, PrologError, Struct, Var, deref, listToArray, mkList, mkStruct, mkVar, type Term } from "./terms";
import { variant } from "./builtins";

const S = mkStruct;

export interface Decl {
  readonly args: Term[];
  readonly out: Term;
  readonly det: string;
}

const ARROWS: Record<string, string> = { "->": "plain", "-[det]->": "det", "-[semidet]->": "semidet", "-[nondet]->": "nondet" };
const KINDS: Record<string, string> = { Newtype: "declared_newtype", Alias: "declared_type_alias", Foreign: "declared_foreign_type", SpaceOf: "declared_space_type" };

function arrowDet(a: Term): string | undefined {
  const d = deref(a);
  if (typeof d !== "string") return undefined;
  return ARROWS[d] ?? (/^-\[\$.+\]->$/.test(d) ? "effect" : undefined);
}

/** fn_type_shape/4: (Arrow A1 ... An Out) with a recognised arrow. */
export function fnTypeShape(t: Term): Decl | null {
  const items = listToArray(deref(t));
  if (items === null || items.length < 2) return null;
  const det = arrowDet(items[0]!);
  if (det === undefined) return null;
  return { args: items.slice(1, -1), out: items[items.length - 1]!, det };
}

export const isWildcard = (t: Term): boolean => {
  const d = deref(t);
  return d === "%Undefined%" || d === "Atom" || d === "Expression";
};

export class Types {
  /** Function declarations by name, in declaration order, with aliases expanded. */
  readonly fnDecls = new Map<string, Decl[]>();
  /**
   * Compile-time type knowledge of variables (type_lang.pl's tknown attribute, one candidate kept): a
   * declared parameter's type, a typed call's output, a let binder's value type. A guard on a variable whose
   * known type fits the required one is elided, as check_call_arg/5 does with known_singleton/2.
   */
  private readonly known = new Map<Var, Term | null>();
  private readonly aliases = new Map<string, Term>();
  private readonly kindOf = new Map<string, string>();
  constructor(private readonly p: Petta) {}

  /** normalize_type/2: aliases expanded, arrows kept. */
  normalize(t: Term): Term {
    const d = deref(t);
    if (typeof d === "string") return this.aliases.get(d) ?? d;
    if (d instanceof Var || !(d instanceof Cons)) return d;
    const items = listToArray(d);
    if (items === null) return d;
    return mkList(items.map((x) => this.normalize(x)));
  }

  /** maybe_cache_type_decl/2 for a (: Name Type) atom in &self. */
  cacheDecl(name: Term, type: Term): void {
    const n = deref(name);
    const m = this.p.m;
    const nl = listToArray(n);
    if (nl !== null && nl.length === 1 && typeof deref(nl[0]!) === "string" && fnTypeShape(type) !== null) {
      const f = deref(nl[0]!) as string;
      m.err(`Warning: type declaration name (${f}) is an expression; write (: ${f} ...) to declare the function\n`);
      return;
    }
    if (typeof n !== "string") return;
    const t = deref(type);
    const ti = listToArray(t);
    // kind declarations (: Name (Keyword ...))
    if (ti !== null && ti.length >= 1 && typeof deref(ti[0]!) === "string" && KINDS[deref(ti[0]!) as string] !== undefined) {
      const kw = deref(ti[0]!) as string;
      let value: Term | null = null;
      if (kw === "Foreign") {
        if (ti.length === 1) value = 0;
        else if (ti.length === 2 && typeof deref(ti[1]!) === "number") value = deref(ti[1]!);
      } else if (ti.length === 2) value = this.normalize(ti[1]!);
      if (value !== null) {
        const prior = this.kindOf.get(n);
        if (prior !== undefined && prior !== kw) {
          m.err(`Warning: ${kw} declaration for ${n} ignored: name is already declared\n`);
          return;
        }
        if (prior === kw) return;
        if (kw === "SpaceOf") this.validateExistingRows(n, value);
        this.kindOf.set(n, kw);
        if (kw === "Alias") {
          this.aliases.set(n, value);
          // renormalize_late_alias/2: declarations written before the alias now read through it.
          for (const [f, list] of this.fnDecls)
            this.fnDecls.set(
              f,
              list.map((d) => ({ args: d.args.map((x) => this.normalize(x)), out: this.normalize(d.out), det: d.det })),
            );
        }
        m.addClause(S(KINDS[kw]!, n, value), true);
        return;
      }
    }
    const shape = fnTypeShape(t);
    if (shape !== null) {
      const decl: Decl = { args: shape.args.map((x) => this.normalize(x)), out: this.normalize(shape.out), det: shape.det };
      const list = this.fnDecls.get(n) ?? [];
      if (!list.some((d) => variant(mkList([...d.args, d.out]), mkList([...decl.args, decl.out])))) list.push(decl);
      this.fnDecls.set(n, list);
      return;
    }
    // a value declaration (: Name T)
    const tn = this.normalize(t);
    for (const c of m.visibleClauses("declared_value_type", 2)) {
      const [h] = m.clauseTerms(c);
      if (h instanceof Struct && deref(h.args[0]!) === n && variant(h.args[1]!, tn)) return;
    }
    m.addClause(S("declared_value_type", n, tn), true);
  }

  /** validate_existing_space_rows/2: a SpaceOf declaration rejects a space that already holds a contradicting row. */
  private validateExistingRows(space: string, schema: Term): void {
    const m = this.p.m;
    const rows: Term[] = [];
    for (const p of [...m.db.preds.values()]) {
      if (p.name !== space) continue;
      for (const c of m.visibleClauses(p.name, p.arity)) {
        const [h] = m.clauseTerms(c);
        if (h instanceof Struct) rows.push(mkList(h.args));
      }
    }
    for (const c of m.visibleClauses("space_primitive", 2)) {
      const [h] = m.clauseTerms(c);
      if (h instanceof Struct && deref(h.args[0]!) === space) rows.push(h.args[1]!);
    }
    for (const row of rows)
      if (m.solveOnce(S("value_definitely_mismatch", row, copyTerm(schema))))
        throw new PrologError(S("error", S("space_schema_row_mismatch", space, row, schema), "typecheck"));
  }

  uncacheDecl(name: Term, type: Term): void {
    const n = deref(name);
    if (typeof n !== "string") return;
    const ti = listToArray(deref(type));
    const kw = ti !== null && ti.length >= 1 ? deref(ti[0]!) : null;
    if (typeof kw === "string" && KINDS[kw] !== undefined) {
      if (this.kindOf.get(n) !== kw) return;
      const value = kw === "Foreign" ? (ti!.length === 2 ? deref(ti![1]!) : 0) : this.normalize(ti![1]!);
      const m = this.p.m;
      const found = m.visibleClauses(KINDS[kw]!, 2).some((c) => {
        const [h] = m.clauseTerms(c);
        return h instanceof Struct && deref(h.args[0]!) === n && variant(h.args[1]!, value);
      });
      if (!found) return;
      m.solveOnce(S("retractall", S(KINDS[kw]!, n, mkVar())));
      this.kindOf.delete(n);
      if (kw === "Alias") this.aliases.delete(n);
      return;
    }
    const shape = fnTypeShape(type);
    if (shape !== null) {
      const list = this.fnDecls.get(n);
      if (list === undefined) return;
      const key = mkList([...shape.args.map((x) => this.normalize(x)), this.normalize(shape.out)]);
      this.fnDecls.set(
        n,
        list.filter((d) => !variant(mkList([...d.args, d.out]), key)),
      );
      return;
    }
    const m = this.p.m;
    m.solveOnce(S("retractall", S("declared_value_type", n, this.normalize(type))));
  }

  /** fn_decl_arity/4 with fresh type variables per lookup. */
  declsArity(f: string, n: number): Decl[] {
    const list = this.fnDecls.get(f);
    if (list === undefined) return [];
    return list.filter((d) => d.args.length === n).map(freshDecl);
  }

  allDecls(f: string): Decl[] {
    return (this.fnDecls.get(f) ?? []).map(freshDecl);
  }

  expressionTyped(t: Term): boolean {
    return deref(t) === "Atom";
  }

  /** eff_arg_types/4: a provided position stays data iff every declaration types it Atom. */
  effArgTypes(decls: Decl[], nb: number, nprov: number): (Term | undefined)[] {
    const out: (Term | undefined)[] = [];
    for (let i = nb; i < nb + nprov; i++) out.push(decls.every((d) => d.args[i] !== undefined && this.expressionTyped(d.args[i]!)) ? "Atom" : undefined);
    return out;
  }

  /** known_singleton/2: the one known type of a variable, or undefined. */
  knownOf(t: Term): Term | undefined {
    const d = deref(t);
    if (!(d instanceof Var)) return undefined;
    const k = this.known.get(d);
    return k === null ? undefined : k;
  }

  /** add_known_type/2: a second, different candidate makes the type unknown. */
  addKnown(t: Term, type: Term): void {
    const d = deref(t);
    const T = deref(type);
    // A type variable is knowledge too: the declaration instance, so identical unknowns are recognised.
    if (!(d instanceof Var) || (!(T instanceof Var) && isWildcard(T))) return;
    const prior = this.known.get(d);
    if (prior === undefined) this.known.set(d, T);
    else if (prior !== null && !variant(prior, T)) this.known.set(d, null);
  }

  /** note_candidates/2 for a value: a literal's own type, or a variable's known type. */
  valueType(v: Term): Term | undefined {
    const d = deref(v);
    if (d instanceof Var) return this.knownOf(d);
    if (typeof d === "number" || typeof d === "bigint" || (d instanceof Struct ? false : typeof d === "object" && d !== null && "v" in (d as object))) return "Number";
    return undefined;
  }

  /** Merge knowledge when two compile-time variables are aliased (tknown's attr_unify_hook). */
  mergeKnown(a: Term, b: Term): void {
    const ka = this.knownOf(a);
    const kb = this.knownOf(b);
    if (ka !== undefined) this.addKnown(b, ka);
    if (kb !== undefined) this.addKnown(a, kb);
  }

  /**
   * Instantiate a declaration's type variables from what is known of the call's arguments (the effect of
   * check_call_arg/5's type_unify on the fresh declaration copy), so its output type is specific.
   */
  resolveDecl(avs: Term[], ats: Term[]): void {
    const m = this.p.m;
    avs.forEach((av, i) => {
      const t = ats[i];
      if (t === undefined) return;
      const k = this.knownOf(av);
      if (k === undefined) return;
      const mark = m.trailMark();
      if (!m.solveOnce(S("type_unify", copyTerm(k), t))) m.undoTo(mark);
    });
  }

  /** list_source_elem/2: the element type of a list value: its known (List T), the open type of (), or the common type of a literal. */
  private listSourceElem(x: Term): Term | undefined {
    const d = deref(x);
    if (d instanceof Var) {
      const k = this.knownOf(d);
      const ki = k === undefined ? null : listToArray(deref(k));
      return ki !== null && ki.length === 2 && deref(ki[0]!) === "List" ? ki[1]! : undefined;
    }
    if (d === NIL) return mkVar();
    const items = listToArray(d);
    if (items === null || items.length === 0) return undefined;
    const ts = items.map((e) => this.valueType(e));
    if (ts.some((t) => t === undefined)) return undefined;
    return ts.every((t) => variant(t!, ts[0]!)) ? ts[0] : undefined;
  }

  /**
   * untyped_call_out/3: the output knowledge of the builtins typed by a contextual rule rather than a
   * signature (builtin_registry.pl typing(contextual(...))): cons_list, list_element, list_tail, union_list,
   * first_list.
   */
  untypedCallOut(f: string, avs: Term[], out: Term): void {
    const rule = CONTEXTUAL[f + "/" + avs.length];
    if (rule === undefined || !(deref(out) instanceof Var)) return;
    const set = (t: Term): void => this.addKnown(out, t);
    switch (rule) {
      case "cons_list": {
        const T = this.listSourceElem(avs[1]!);
        if (T === undefined) return;
        const h = deref(avs[0]!);
        const Td = deref(T);
        const fitsHead = (!(Td instanceof Var) && isWildcard(Td)) || (h instanceof Var ? (this.knownOf(h) !== undefined && this.fits(this.knownOf(h)!, T)) : this.checkValue(h, copyTerm(T)) === "ok");
        if (fitsHead) set(mkList(["List", T]));
        else {
          const kh = h instanceof Var ? this.knownOf(h) : this.valueType(h);
          if (!(Td instanceof Var) && kh !== undefined) set(mkList(["List", mkList(["|", T, kh])]));
        }
        return;
      }
      case "list_element": {
        const T = this.listSourceElem(avs[0]!);
        if (T !== undefined && !(deref(T) instanceof Var) && !isWildcard(T)) set(T);
        return;
      }
      case "list_tail": {
        const T = this.listSourceElem(avs[0]!);
        set(mkList(["List", T !== undefined ? T : "%Undefined%"]));
        return;
      }
      case "union_list": {
        const TA = this.listSourceElem(avs[0]!);
        const TB = this.listSourceElem(avs[1]!);
        if (TA === undefined || TB === undefined) return;
        if (this.fits(TA, TB)) set(mkList(["List", TA]));
        else if (!(deref(TA) instanceof Var) && !(deref(TB) instanceof Var)) set(mkList(["List", mkList(["|", TA, TB])]));
        return;
      }
      case "first_list": {
        const T = this.listSourceElem(avs[0]!);
        if (T !== undefined) set(mkList(["List", T]));
        return;
      }
    }
  }

  /** bind_pattern_from/2: a destructuring let pattern types its fields from the value's tuple type. */
  bindPattern(pat: Term, type: Term): void {
    const p = deref(pat);
    const T = deref(type);
    if (p instanceof Var) {
      this.addKnown(p, T);
      return;
    }
    const pi = listToArray(p);
    const ti = listToArray(T);
    if (pi === null || ti === null || pi.length !== ti.length || fnTypeShape(T) !== null) return;
    if (ti.length > 0 && (deref(ti[0]!) === "|" || deref(ti[0]!) === "List")) return;
    pi.forEach((x, i) => this.bindPattern(x, ti[i]!));
  }

  /** type_unify/2 in place, undone when it fails. */
  private unifyTypes(k: Term, t: Term): boolean {
    const m = this.p.m;
    const mark = m.trailMark();
    if (m.solveOnce(S("type_unify", k, t))) return true;
    m.undoTo(mark);
    return false;
  }

  /** begin_clause_inference/4: an undeclared function's untyped parameters get open assumption types. */
  assumeParamTypes(args: Term[]): void {
    for (const a of args) {
      const d = deref(a);
      if (d instanceof Var && this.knownOf(d) === undefined) this.addKnown(d, mkVar());
    }
  }

  /** type_unify/2 on copies: whether the known type fits the required one. */
  private fits(k: Term, t: Term): boolean {
    const m = this.p.m;
    const mark = m.trailMark();
    const ok = m.solveOnce(S("type_unify", copyTerm(k), copyTerm(t)));
    m.undoTo(mark);
    return ok;
  }

  /**
   * clause_param_types/3 and bind_param_type/2: the unique (or only surviving) declaration of F/N types its
   * clause's head variables; a literal head argument that contradicts it is a compile error.
   */
  bindParamTypes(f: string, args: Term[]): Decl | undefined {
    const decls = this.declsArity(f, args.length);
    if (decls.length === 0) return undefined;
    let chosen: Decl | undefined;
    if (decls.length === 1) chosen = decls[0];
    else {
      const surv = decls.filter((d) => args.every((a, i) => deref(a) instanceof Var || this.checkValue(a, copyTerm(d.args[i]!)) !== "mismatch"));
      if (surv.length === 0) throw new PrologError(S("error", S("no_matching_overload", f), "typecheck"));
      if (surv.length === 1) chosen = surv[0];
    }
    if (chosen === undefined) return undefined;
    args.forEach((a, i) => this.bindParamType(a, chosen!.args[i]!));
    return chosen;
  }

  /**
   * clause_output_goals/6: a clause of a declared function whose result is not proven of the declared output
   * type checks it at runtime; a literal result that contradicts it is a compile error.
   */
  clauseOutputGoals(decl: Decl | undefined, expOut: Term, body: Term): Goals {
    if (decl === undefined) return [];
    const OT = deref(decl.out);
    if (OT instanceof Var || isWildcard(OT)) return [];
    const b = listToArray(deref(body));
    if (b !== null && b.length === 2 && deref(b[0]!) === "quote" && !isAtomicTerm(deref(b[1]!))) {
      const st = this.checkValue(b[1]!, copyTerm(OT));
      if (st === "ok") return [];
      return [guardGoal(expOut, OT)];
    }
    const v = deref(expOut);
    if (v instanceof Var) {
      const k = this.knownOf(v);
      if (k !== undefined && this.fits(k, OT)) return [];
      return [guardGoal(v, OT)];
    }
    const st = this.checkValue(v, copyTerm(OT));
    if (st === "mismatch") throw new PrologError(S("error", S("literal_type_mismatch", v, OT), "typecheck"));
    if (st === "unknown") return [guardGoal(v, OT)];
    return [];
  }

  private bindParamType(arg: Term, t: Term): void {
    const a = deref(arg);
    const T = deref(t);
    if (a instanceof Var) {
      if (!(T instanceof Var) && isWildcard(T)) return;
      this.addKnown(a, T);
      return;
    }
    const ti = listToArray(T);
    const ai = listToArray(a);
    if (ti !== null && ti.length === 2 && deref(ti[0]!) === "List" && a instanceof Cons) {
      this.bindParamType(a.head, ti[1]!);
      this.bindParamType(a.tail, T);
      return;
    }
    // structural_pattern_fields/4: a tagged pattern (Tag Fields...) against the tuple type (Tag FieldTs...)
    // types the fields; the tag is structure, not a value to check.
    if (ai !== null && ti !== null && ai.length === ti.length && ai.length > 0 && typeof deref(ai[0]!) === "string" && deref(ai[0]!) === deref(ti[0]!)) {
      ai.slice(1).forEach((x, i) => this.bindParamType(x, ti[i + 1]!));
      return;
    }
    if (ai !== null && ti !== null && ai.length === ti.length && fnTypeShape(T) === null && deref(ti[0]!) !== "|") {
      ai.forEach((x, i) => this.bindParamType(x, ti[i]!));
      return;
    }
    if (ai === null && !(a instanceof Cons) && !(a instanceof Struct) && this.checkValue(a, T) === "mismatch")
      throw new PrologError(S("error", S("literal_type_mismatch", a, T), "typecheck"));
  }

  /** ascribe_type/3: (the T Expr) checks Expr against T, statically where it can and by a guard otherwise. */
  ascribe(v: Term, t: Term): Goals {
    const T = deref(t);
    if (T instanceof Var || isWildcard(T)) return [];
    const d = deref(v);
    const guard = (): Goals => (isGroundType(T) ? [guardGoal(d, T)] : []);
    if (d instanceof Var) {
      const k = this.knownOf(d);
      if (k !== undefined && deref(k) instanceof Var) {
        // only a bare declaration variable is known: narrow locally and keep the boundary's guard
        this.known.set(d, T);
        return guard();
      }
      if (k !== undefined) {
        if (this.fits(k, T)) return [];
        if (this.fits(T, k)) {
          this.known.set(d, T);
          return guard();
        }
        throw new PrologError(S("error", S("type_conflict", S("existing", k), S("required", T)), "typecheck"));
      }
      this.addKnown(d, T);
      return guard();
    }
    const st = this.checkValue(d, copyTerm(T));
    if (st === "ok") return [];
    if (st === "mismatch") throw new PrologError(S("error", S("literal_type_mismatch", d, T), "typecheck"));
    return guard();
  }

  /** check_value/3 through the ported Prolog definition: ok, mismatch or unknown. Binds type variables. */
  checkValue(v: Term, t: Term): string {
    const st = mkVar();
    const m = this.p.m;
    if (!m.solveOnce(S("check_value", v, t, st))) return "unknown";
    return deref(st) as string;
  }

  /** check_call_arg/5 in declared mode: a literal mismatch is a compile error, an unresolved value a guard. */
  callGuards(fun: string, avs: Term[], ats: Term[]): Goals {
    const gs: Goals = [];
    avs.forEach((av, i) => {
      const t = ats[i];
      if (t === undefined) return;
      const v = deref(av);
      if (v instanceof Var) {
        const T = deref(t);
        if (T instanceof Var || isWildcard(T)) return;
        const k = this.knownOf(v);
        // type_unify(K, T) in place: an open assumption or declaration variable takes the required type.
        if (k !== undefined && this.unifyTypes(k, T)) return;
        gs.push(guardGoal(v, T));
        return;
      }
      const st = this.checkValue(v, t);
      if (st === "ok") return;
      if (st === "mismatch") throw new PrologError(S("error", S("literal_type_mismatch", v, deref(t)), "typecheck"));
      const T = deref(t);
      if (T instanceof Var || isWildcard(T)) return;
      gs.push(guardGoal(v, T));
    });
    void fun;
    return gs;
  }

  /** Non-throwing guards for one overload branch (overload_branch_guard/4). */
  matchGuards(avs: Term[], ats: Term[]): Goals {
    const gs: Goals = [];
    avs.forEach((av, i) => {
      const t = ats[i];
      if (t === undefined) return;
      if (this.argStaticallyOk(av, t)) return;
      gs.push(S("typecheck_match", av, t));
    });
    return gs;
  }

  /** arg_statically_ok/2 without type knowledge for variables. */
  private argStaticallyOk(av: Term, t: Term): boolean {
    const v = deref(av);
    const T = deref(t);
    if (v instanceof Var) return T instanceof Var || isWildcard(T);
    const m = this.p.m;
    const mark = m.trailMark();
    const ok = m.solveOnce(S("check_value", v, copyTerm(t), "ok"));
    m.undoTo(mark);
    return ok;
  }

  /** decl_survives/2: no argument definitely mismatches. */
  declSurvives(avs: Term[], ats: Term[]): boolean {
    const m = this.p.m;
    const mark = m.trailMark();
    const ok = avs.every((av, i) => {
      const v = deref(av);
      const t = ats[i];
      if (t === undefined || v instanceof Var) return true;
      return this.checkValue(v, t) !== "mismatch";
    });
    m.undoTo(mark);
    return ok;
  }

  /** overload_out_guard/5 for a multiply declared function: the result is filtered by the output type. */
  overloadOutGuard(out: Term, ot: Term): Goals {
    const o = deref(ot);
    if (isGroundType(o) && !isWildcard(o)) return [S("typecheck_match", out, o)];
    return [];
  }

  /** translate_declared_body/5: a function declared to return Atom returns its body as source data. */
  declaredBody(f: string, n: number, body: Term): Tr {
    if (this.declaredOutputAtom(f, n)) return [[], body];
    return this.p.translator.expr(body);
  }

  /** declared_output_type(F, 'Atom'): a (: F (-> ... Atom)) declaration; it matches the plain arrow only. */
  private declaredOutputAtom(f: string, n: number): boolean {
    return (this.fnDecls.get(f) ?? []).some((d) => d.args.length === n && d.det === "plain" && deref(d.out) === "Atom");
  }

  /** Native views of the store for the Prolog value checks. */
  install(m: Machine): void {
    const self = this;
    const declGen = (filter: (d: Decl) => boolean, build: (d: Decl) => Term[]) =>
      function* (m2: Machine, args: Term[]): Generator<void> {
        const f = deref(args[0]!);
        if (typeof f !== "string") return;
        for (const d of self.allDecls(f)) {
          if (!filter(d)) continue;
          const vals = build(d);
          const mark = m2.trailMark();
          let ok = true;
          for (let i = 0; i < vals.length && ok; i++) ok = m2.unify(args[i + 1]!, vals[i]!);
          if (ok) yield;
          m2.undoTo(mark);
        }
      };
    m.defBuiltin("fn_decl_arity", 4, {
      nondet: (m2, a) => {
        const n = deref(a[1]!);
        return declGen(
          (d) => typeof n !== "number" || d.args.length === n,
          (d) => [d.args.length, mkList(d.args), d.out],
        )(m2, a);
      },
    });
    m.defBuiltin("declared_fn_type", 4, { nondet: (m2, a) => declGen(() => true, (d) => [mkList(d.args), d.out, d.det])(m2, a) });
    m.defBuiltin("fn_decl_partial", 6, {
      nondet: function* (m2, [f, nT, pts, rts, ot, det]) {
        const fd = deref(f!);
        const n = deref(nT!);
        if (typeof fd !== "string" || typeof n !== "number") return;
        for (const d of self.allDecls(fd)) {
          if (d.args.length <= n) continue;
          const mark = m2.trailMark();
          if (m2.unify(pts!, mkList(d.args.slice(0, n))) && m2.unify(rts!, mkList(d.args.slice(n))) && m2.unify(ot!, d.out) && m2.unify(det!, d.det)) yield;
          m2.undoTo(mark);
        }
      },
    });
    m.defBuiltin("user_extended_get_type", 0, { det: () => (m.db.get("get-type", 2)?.live ?? 0) > 1 });
    m.defBuiltin("current_arithmetic_function", 1, {
      det: (_m, [t]) => {
        const d = deref(t!);
        return typeof d === "string" && ["pi", "e", "inf", "infinite", "nan", "epsilon", "random", "random_float", "cputime", "realtime", "max_tagged_integer", "min_tagged_integer"].includes(d);
      },
    });
    for (const s of ["declared_value_type", "declared_newtype", "declared_type_alias", "declared_foreign_type", "declared_space_type"]) m.db.ensure(s, 2).dynamic = true;
  }
}

const CONTEXTUAL: Record<string, string> = {
  "cons/2": "cons_list",
  "cons-atom/2": "cons_list",
  "first/1": "list_element",
  "last/1": "list_element",
  "car-atom/1": "list_element",
  "cdr-atom/1": "list_tail",
  "union-atom/2": "union_list",
  "append/2": "union_list",
  "subtraction-atom/2": "first_list",
  "list_to_set/1": "first_list",
};

function isAtomicTerm(t: Term): boolean {
  return !(t instanceof Var) && !(t instanceof Cons) && !(t instanceof Struct);
}

function freshDecl(d: Decl): Decl {
  const items = listToArray(copyTerm(mkList([...d.args, d.out])))!;
  return { args: items.slice(0, -1), out: items[items.length - 1]!, det: d.det };
}

function isGroundType(t: Term): boolean {
  const d = deref(t);
  if (d instanceof Var) return false;
  if (d instanceof Cons) return isGroundType(d.head) && isGroundType(d.tail);
  if (d instanceof Struct) return d.args.every(isGroundType);
  return true;
}

/** guard_goal/3: primitive types test natively before the reflective check. */
function guardGoal(av: Term, t: Term): Term {
  const T = deref(t);
  if (T === "Number") return S(";", S("->", S("number", av), "true"), S("typecheck_or_error", av, "Number"));
  if (T === "String") return S(";", S("->", S("string", av), "true"), S("typecheck_or_error", av, "String"));
  if (T === "Bool") return S(";", S("->", S(";", S("==", av, "true"), S("==", av, "false")), "true"), S("typecheck_or_error", av, "Bool"));
  return S("typecheck_or_error", av, t);
}

/**
 * value_checks.pl and type_lang.pl, ported: candidate types of values, check_value/3, brand-aware
 * type_unify/2, and the runtime guards typecheck_or_error/2 and typecheck_match/2 over runtime_type_ok/2.
 * Variables carry no compile-time type knowledge here, so known_singleton/2 fails.
 */
export const TYPES_RUNTIME_PL = String.raw`
primitive_type('Number').
primitive_type('String').
primitive_type('Bool').
wildcard_type(T) :- atom(T), memberchk(T, ['%Undefined%', 'Atom', 'Expression']).
is_union(T) :- nonvar(T), T = [P|_], P == '|'.
arrow_atom(A) :- atom(A), ( memberchk(A, ['->', '-[det]->', '-[semidet]->', '-[nondet]->']) -> true ; sub_atom(A, 0, 3, _, '-[$'), sub_atom(A, _, 3, 0, ']->') ).
arrow_atom_det('->', plain).
arrow_atom_det('-[det]->', det).
arrow_atom_det('-[semidet]->', semidet).
arrow_atom_det('-[nondet]->', nondet).
arrow_atom_det(A, effect(A)) :- atom(A), sub_atom(A, 0, 3, _, '-[$'), sub_atom(A, _, 3, 0, ']->').
is_arrow_type(T) :- nonvar(T), T = [A|_], arrow_atom(A).
list_type(T, ET) :- nonvar(T), T = [L, ET], L == 'List'.
special_compound_type(T) :- ( is_arrow_type(T) ; is_union(T) ; list_type(T, _) ; foreign_type(T) ).
foreign_type(T) :- atom(T), declared_foreign_type(T, 0).
foreign_type(T) :- nonvar(T), T = [Name|Params], atom(Name), declared_foreign_type(Name, N), length(Params, N).
user_atom_type(T) :- atom(T), \+ primitive_type(T), \+ wildcard_type(T).
tuple_type(C) :- is_list(C), C \= [->|_], C \= ['List', _].
type_name_declared(Tag) :- ( declared_value_type(Tag, _) -> true ; declared_newtype(Tag, _) -> true ; declared_foreign_type(Tag, _) -> true ; declared_fn_type(Tag, _, _, _) ).
tagged_tuple_type(T, Tag, FieldTs) :- nonvar(T), T = [Tag|FieldTs], atom(Tag), user_atom_type(Tag), \+ special_compound_type(T), length(FieldTs, N), ( fn_decl_arity(Tag, N, _, _) -> true ; \+ type_name_declared(Tag) ).
known_singleton(_, _) :- fail.
committed_det(det).
committed_det(semidet).
det_arrow_head(Det, H) :- nonvar(Det), arrow_atom_det(H, Det), !.
det_arrow_head(_, (->)).
value_arrow_head(_, _, Det, H) :- det_arrow_head(Det, H).
value_candidate_types(V, ['Number']) :- number(V), !.
value_candidate_types(V, ['String']) :- string(V), !.
value_candidate_types(true, ['Bool']) :- !.
value_candidate_types(false, ['Bool']) :- !.
value_candidate_types(V, Cs) :- atom(V), !, findall(T, declared_value_type(V, T), Vs), findall([H|Xs], ( declared_fn_type(V, ATs, OT, Det), length(ATs, NA), value_arrow_head(V, NA, Det, H), append(ATs, [OT], Xs) ), Fs), append(Vs, Fs, Cs0), ( Cs0 == [], current_arithmetic_function(V) -> Cs = ['Number'] ; Cs = Cs0 ).
value_candidate_types(partial(F, B), Cs) :- !, length(B, N), findall([H|Xs], ( fn_decl_partial(F, N, PTs, RTs, OT, Det), length(RTs, NR), NA is N + NR, value_arrow_head(F, NA, Det, H), bound_args_match(B, PTs), append(RTs, [OT], Xs) ), Cs).
value_candidate_types([], [['List', _]]) :- !.
value_candidate_types([H|Args], Cs) :- atom(H), is_list(Args), length(Args, N), fn_decl_arity(H, N, _, _), !, findall(OT, ( fn_decl_arity(H, N, ATs, OT), bound_args_match(Args, ATs) ), Cs).
value_candidate_types(V, Cs) :- is_list(V), maplist(value_single_type, V, Ts), !, Cs = [Ts].
value_candidate_types(_, []).
value_single_type(V, T) :- ( var(V) -> known_singleton(V, T) ; value_candidate_types(V, [T0]), T = T0 ).
bound_args_match(B, PTs) :- \+ \+ maplist(arg_soft_ok, B, PTs).
type_unify(A, B) :- ( var(A) ; var(B) ), !, A = B.
type_unify(A, B) :- ( brand_name(A) ; brand_name(B) ), !, brand_unify(A, B).
type_unify(A, B) :- ( wildcard_type(A) ; wildcard_type(B) ), !.
type_unify(A, B) :- is_union(A), !, A = ['|'|As], \+ ( member(MA, As), \+ type_compat_soft(MA, B) ).
type_unify(A, B) :- is_union(B), !, B = ['|'|Ms], member(M, Ms), type_unify(A, M), !.
type_unify(A, B) :- atom(A), !, A == B.
type_unify(A, B) :- is_arrow_type(A), is_arrow_type(B), !, A = [HA|As], B = [HB|Bs], det_arrow_fits(HA, HB), same_length(As, Bs), maplist(type_unify, As, Bs).
type_unify(A, B) :- is_list(A), !, is_list(B), same_length(A, B), maplist(type_unify, A, B).
type_unify(A, B) :- A == B.
type_compat_soft(A, B) :- \+ \+ type_unify(A, B).
brand_name(T) :- atom(T), declared_newtype(T, _).
brand_unify(A, B) :- brand_name(A), brand_name(B), !, A == B.
brand_unify(A, B) :- brand_name(B), !, is_union(A), A = ['|'|As], \+ ( member(MA, As), \+ type_compat_soft(MA, B) ).
brand_unify(_, B) :- wildcard_type(B), !.
brand_unify(A, B) :- is_union(B), !, B = ['|'|Ms], member(M, Ms), type_unify(A, M), !.
brand_unify(A, B) :- atom(A), declared_newtype(A, RA), \+ wildcard_type(RA), type_unify(RA, B).
det_arrow_fits(HA, HB) :- arrow_atom_det(HA, LA), arrow_atom_det(HB, LB), det_level_fits(LA, LB).
det_level_fits(_, nondet) :- !.
det_level_fits(_, plain) :- !.
det_level_fits(_, effect(_)) :- !.
det_level_fits(LA, LB) :- ( LA == det -> true ; LA == semidet -> LB == semidet ).
check_value(V, T, St) :- number(V), !, ( var(T) -> T = 'Number', St = ok ; T == 'Number' -> St = ok ; prim_mismatch_status('Number', T, St) ).
check_value(V, T, St) :- string(V), !, ( var(T) -> T = 'String', St = ok ; T == 'String' -> St = ok ; prim_mismatch_status('String', T, St) ).
check_value(V, T, St) :- ( V == true ; V == false ), !, ( var(T) -> T = 'Bool', St = ok ; T == 'Bool' -> St = ok ; prim_mismatch_status('Bool', T, St) ).
check_value(V, T, St) :- var(T), !, ( value_single_type(V, VT) -> T = VT ; true ), St = ok.
check_value(_, T, ok) :- foreign_type(T), !.
check_value(_, T, St) :- wildcard_type(T), !, St = ok.
check_value(V, T, St) :- is_union(T), !, T = ['|'|Ms], ( member(M, Ms), check_value(V, M, SM), SM == ok -> St = ok ; forall(member(M, Ms), check_value(V, M, mismatch)) -> St = mismatch ; St = unknown ).
check_value(V, T, St) :- list_type(T, ET), !, ( is_list(V) -> list_elems_status(V, ET, St) ; non_list(V) -> St = mismatch ; St = unknown ).
check_value(V, T, St) :- is_arrow_type(T), !, ( ( atom(V) ; V = partial(_, _) ) -> value_candidate_types(V, Cs), ( Cs == [] -> St = unknown ; member(C, Cs), type_unify(C, T) -> St = ok ; St = mismatch ) ; ( number(V) ; string(V) ) -> St = mismatch ; St = unknown ).
check_value(V, T, St) :- tagged_tuple_type(T, Tag, FieldTs), !, ( is_list(V) -> ( V = [VTag|Fields], VTag == Tag, same_length(Fields, FieldTs) -> tuple_fields_status(Fields, FieldTs, St) ; St = mismatch ) ; atom(V) -> atom_value_status(V, T, St) ; non_list(V) -> St = mismatch ; St = unknown ).
check_value(V, T, St) :- is_list(T), !, ( is_list(V) -> ( same_length(V, T) -> tuple_fields_status(V, T, St) ; St = mismatch ) ; atom(V) -> atom_value_status(V, T, St) ; non_list(V) -> St = mismatch ; St = unknown ).
check_value(V, T, St) :- atom(T), !, check_named_value(V, T, St).
check_value(_, _, unknown).
check_named_value(V, T, St) :- declared_newtype(T, R), !, value_candidate_types(V, Cs), ( Cs == [] -> ( constructed_definite_mismatch(V) -> St = mismatch ; check_value(V, R, St) ) ; member(C, Cs), type_unify(C, T) -> St = ok ; member(C, Cs), candidate_not_branded(C), type_unify(C, R) -> St = ok ; St = mismatch ).
check_named_value(V, T, St) :- value_candidate_types(V, Cs), ( Cs == [] -> ( constructed_definite_mismatch(V) -> St = mismatch ; St = unknown ) ; member(C, Cs), type_unify(C, T) -> St = ok ; member(C, Cs), refinement_pair(C, T) -> St = unknown ; St = mismatch ).
candidate_not_branded(C) :- ( atom(C) -> \+ declared_newtype(C, _) ; true ).
constructed_definite_mismatch(V) :- is_list(V), V = [H|Args], atom(H), length(Args, N), fn_decl_arity(H, N, _, _), forall(fn_decl_arity(H, N, ATs, _), \+ \+ tuple_fields_status(Args, ATs, mismatch)).
atom_value_status(V, T, St) :- value_candidate_types(V, Cs), ( Cs == [] -> St = unknown ; member(C, Cs), type_unify(C, T) -> St = ok ; St = mismatch ).
tuple_fields_status([], [], ok).
tuple_fields_status([F|Fs], [T|Ts], St) :- elem_status(F, T, S1), ( S1 == mismatch -> St = mismatch ; tuple_fields_status(Fs, Ts, S2), ( S2 == mismatch -> St = mismatch ; S1 == unknown -> St = unknown ; St = S2 ) ).
list_elems_status(Es, ET, St) :- var(ET), !, St = ok, ( maplist(value_single_type, Es, Ts), Ts = [T1|Rest], forall(member(T2, Rest), T2 =@= T1) -> ET = T1 ; true ).
list_elems_status([], _, ok).
list_elems_status([E|Es], ET, St) :- elem_status(E, ET, S1), ( S1 == mismatch -> St = mismatch ; list_elems_status(Es, ET, S2), ( S2 == mismatch -> St = mismatch ; S1 == unknown -> St = unknown ; St = S2 ) ).
elem_status(E, ET, St) :- ( var(E) -> ( known_singleton(E, K) -> ( type_unify(K, ET) -> St = ok ; St = mismatch ) ; St = unknown ) ; check_value(E, ET, St) ).
prim_mismatch_status(P, T, St) :- ( wildcard_type(T) -> St = ok ; is_union(T) -> ( T = ['|'|Ms], member(M, Ms), type_compat_soft(P, M) -> St = ok ; St = mismatch ) ; atom(T), declared_newtype(T, R) -> prim_mismatch_status(P, R, St) ; atom(T) -> ( refinement_pair(P, T) -> St = unknown ; St = mismatch ) ; ( T = [L|_], L == 'List' ; is_arrow_type(T) ) -> St = mismatch ; St = unknown ).
refinement_pair(C, T) :- user_extended_get_type, ( ( primitive_type(C) ; tuple_type(C) ), user_atom_type(T) -> true ; user_atom_type(C), ( primitive_type(T) ; tuple_type(T) ) ).
arg_soft_ok(AV, T) :- ( var(AV) -> ( known_singleton(AV, K) -> copy_term(K, K2), type_unify(K2, T) ; true ) ; check_value(AV, T, St), St \== mismatch ).
value_definitely_mismatch(V, T) :- copy_term(T, T2), check_value(V, T2, St), !, St == mismatch.
typecheck_or_error(V, T) :- ( var(V) -> constrain_var_type(V, T) ; runtime_type_ok(V, T) -> true ; throw(error(literal_type_mismatch(V, T), typecheck)) ).
typecheck_match(V, T) :- ( var(V) -> constrain_var_type(V, T) ; runtime_type_ok(V, T) ).
constrain_var_type(V, T) :- ( get_attr(V, mreq, Rs) -> variant_union([T], Rs, U), put_attr(V, mreq, U) ; put_attr(V, mreq, [T]) ).
'$attr_unify_hook'(mreq, Rs, Other) :- !, ( var(Other) -> ( get_attr(Other, mreq, R2) -> variant_union(Rs, R2, U), put_attr(Other, mreq, U) ; put_attr(Other, mreq, Rs) ) ; forall(member(R, Rs), typecheck_or_error(Other, R)) ).
'$attr_unify_hook'(_, _, _).
variant_union([], Ys, Ys).
variant_union([X|Xs], Ys, U) :- ( variant_member(X, Ys) -> variant_union(Xs, Ys, U) ; variant_union(Xs, [X|Ys], U) ).
variant_member(X, [Y|Ys]) :- ( X =@= Y -> true ; variant_member(X, Ys) ).
runtime_type_ok(V, 'Number') :- number(V), !.
runtime_type_ok(V, 'String') :- string(V), !.
runtime_type_ok(V, 'Bool') :- ( V == true ; V == false ), !.
runtime_type_ok(_, T) :- var(T), !.
runtime_type_ok(_, T) :- wildcard_type(T), !.
runtime_type_ok(V, T) :- list_type(T, ET), !, runtime_list_ok(V, ET).
runtime_type_ok(V, T) :- is_arrow_type(T), !, runtime_callable_at_arrow_arity(V, T), \+ value_definitely_mismatch(V, T).
runtime_type_ok(V, T) :- is_union(T), !, T = ['|'|Ms], member(M, Ms), runtime_type_ok(V, M), !.
runtime_type_ok(V, T) :- atom(T), declared_newtype(T, R), !, runtime_type_ok(V, R).
runtime_type_ok(V, T) :- tagged_tuple_type(T, Tag, FieldTs), !, is_list(V), V = [VTag|Fields], VTag == Tag, same_length(Fields, FieldTs), runtime_tuple_ok(Fields, FieldTs).
runtime_type_ok(V, T) :- is_list(T), !, is_list(V), same_length(V, T), runtime_tuple_ok(V, T).
runtime_type_ok(V, T) :- atom(T), nominal_value_ok(V, T), !.
runtime_type_ok(_, _) :- nb_current('$in_typecheck', true), !.
runtime_type_ok(V, T) :- setup_call_cleanup(nb_setval('$in_typecheck', true), ( 'get-type'(V, T) *-> true ; 'get-metatype'(V, T) ), nb_setval('$in_typecheck', false)).
runtime_callable_at_arrow_arity(V, T) :- T = [_|Tail], length(Tail, TailLen), Required is TailLen - 1, Required >= 0, ( atom(V), fun(V), CompiledArity is Required + 1, arity(V, CompiledArity) ; nonvar(V), V = partial(F, Bound), atom(F), fun(F), is_list(Bound), length(Bound, NB), arity(F, FullArity), Required =:= FullArity - NB - 1 ).
runtime_list_ok(V, ET) :- var(V), !, constrain_var_type(V, ['List', ET]).
runtime_list_ok([], _).
runtime_list_ok([E|Es], ET) :- ( var(E) -> constrain_var_type(E, ET) ; runtime_type_ok(E, ET) ), runtime_list_ok(Es, ET).
nominal_value_ok(V, T) :- is_list(V), V = [Ctor|Fields], atom(Ctor), !, length(Fields, N), unique_fn_decl(Ctor, N, FieldTs, OT1), OT1 == T, runtime_tuple_ok(Fields, FieldTs).
nominal_value_ok(V, T) :- atom(V), declared_value_type(V, VT), VT == T.
unique_fn_decl(F, N, ATs, OT) :- findall(A-O, fn_decl_arity(F, N, A, O), [ATs-OT]).
runtime_tuple_ok([], []).
runtime_tuple_ok([F|Fs], [T|Ts]) :- ( var(F) -> constrain_var_type(F, T) ; runtime_type_ok(F, T) ), runtime_tuple_ok(Fs, Ts).
same_length([], []).
same_length([_|T1], [_|T2]) :- same_length(T1, T2).
`;

void NIL;
