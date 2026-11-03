// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the part of PeTTa's compile-time type system (src/typecheck) that decides how a declared call is
// compiled: function declarations from (: F (-> ...)) atoms, arguments typed Atom kept as data, overloads
// resolved statically by literal values or dispatched at runtime, residual runtime guards
// (typecheck_or_error/2, typecheck_match/2), and a body returned as data when F is declared to return Atom.
// am[implements a-pe-types-runtime]

import type { Petta } from "./engine";
import type { Goals, Tr } from "./translator";
import { copyTerm } from "./machine";
import { Cons, Float, NIL, PrologError, Str, Struct, Var, deref, isList, listToArray, mkList, mkStruct, type Term } from "./terms";

const S = mkStruct;

export interface Decl {
  readonly args: Term[];
  readonly out: Term;
  readonly det: string;
}

const ARROWS: Record<string, string> = { "->": "plain", "-[det]->": "det", "-[semidet]->": "semidet", "-[nondet]->": "nondet" };

/** fn_type_shape/4: (Arrow A1 ... An Out) with a recognised arrow. */
export function fnTypeShape(t: Term): Decl | null {
  const items = listToArray(deref(t));
  if (items === null || items.length < 2) return null;
  const a = deref(items[0]!);
  if (typeof a !== "string") return null;
  const det = ARROWS[a] ?? (/^-\[\$.+\]->$/.test(a) ? "effect" : undefined);
  if (det === undefined) return null;
  return { args: items.slice(1, -1), out: items[items.length - 1]!, det };
}

export const isWildcard = (t: Term): boolean => {
  const d = deref(t);
  return d === "%Undefined%" || d === "Atom" || d === "Expression";
};

type Status = "ok" | "mismatch" | "unknown";

/** check_value/3 for the shapes a literal argument can be checked against without type knowledge. */
export function checkValue(v: Term, t: Term): Status {
  const V = deref(v);
  const T = deref(t);
  const prim = (name: string): Status | null => {
    if (T instanceof Var) return "ok";
    if (T === name) return "ok";
    if (T === "Number" || T === "String" || T === "Bool") return "mismatch";
    if (isWildcard(T)) return "ok";
    return null;
  };
  if (typeof V === "number" || typeof V === "bigint" || V instanceof Float) return prim("Number") ?? primMismatchOther(T);
  if (V instanceof Str) return prim("String") ?? primMismatchOther(T);
  if (V === "true" || V === "false") return prim("Bool") ?? primMismatchOther(T);
  if (T instanceof Var) return "ok";
  if (isWildcard(T)) return "ok";
  const ti = listToArray(T);
  if (ti !== null && ti.length > 0 && deref(ti[0]!) === "|") {
    const ms = ti.slice(1);
    if (ms.some((m) => checkValue(V, m) === "ok")) return "ok";
    if (ms.every((m) => checkValue(V, m) === "mismatch")) return "mismatch";
    return "unknown";
  }
  if (ti !== null && ti.length === 2 && deref(ti[0]!) === "List") {
    if (V instanceof Var) return "unknown";
    const vi = listToArray(V);
    if (vi !== null) {
      let st: Status = "ok";
      for (const e of vi) {
        const s = deref(e) instanceof Var ? "unknown" : checkValue(e, ti[1]!);
        if (s === "mismatch") return "mismatch";
        if (s === "unknown") st = "unknown";
      }
      return st;
    }
    return isNonList(V) ? "mismatch" : "unknown";
  }
  return "unknown";
}

/** prim_mismatch_status/3: a primitive value against a structured or nominal type. */
function primMismatchOther(T: Term): Status {
  const ti = listToArray(T);
  if (ti !== null && ti.length > 0) {
    const h = deref(ti[0]!);
    if (h === "|") return "unknown";
    return "mismatch";
  }
  return "unknown";
}

function isNonList(x: Term): boolean {
  const d = deref(x);
  if (d instanceof Var) return false;
  if (d === NIL) return false;
  if (d instanceof Cons) return false;
  return true;
}

export class Types {
  /** Declarations by function name, in declaration order. */
  readonly fnDecls = new Map<string, Decl[]>();
  constructor(private readonly p: Petta) {}

  /** maybe_cache_type_decl/2 for a (: Name Type) atom. */
  cacheDecl(name: Term, type: Term): void {
    const n = deref(name);
    if (typeof n !== "string") return;
    const shape = fnTypeShape(type);
    if (shape === null) return;
    const list = this.fnDecls.get(n) ?? [];
    // a re-added identical declaration is not a second overload
    const key = JSON.stringify([...shape.args, shape.out].map((t) => this.p.swrite(t)));
    if (list.some((d) => JSON.stringify([...d.args, d.out].map((t) => this.p.swrite(t))) === key)) return;
    list.push({ args: shape.args, out: shape.out, det: shape.det });
    this.fnDecls.set(n, list);
  }

  uncacheDecl(name: Term, type: Term): void {
    const n = deref(name);
    if (typeof n !== "string") return;
    const shape = fnTypeShape(type);
    const list = this.fnDecls.get(n);
    if (shape === null || list === undefined) return;
    const key = JSON.stringify([...shape.args, shape.out].map((t) => this.p.swrite(t)));
    this.fnDecls.set(
      n,
      list.filter((d) => JSON.stringify([...d.args, d.out].map((t) => this.p.swrite(t))) !== key),
    );
  }

  /** fn_decl_arity/4 with fresh type variables per lookup. */
  declsArity(f: string, n: number): Decl[] {
    const list = this.fnDecls.get(f);
    if (list === undefined) return [];
    return list
      .filter((d) => d.args.length === n)
      .map((d) => {
        const c = copyTerm(mkList([...d.args, d.out])) as Term;
        const items = listToArray(c)!;
        return { args: items.slice(0, -1), out: items[items.length - 1]!, det: d.det };
      });
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

  /** check_call_arg/5 in declared mode: a literal mismatch is a compile error, an unresolved value a guard. */
  callGuards(fun: string, avs: Term[], ats: Term[]): Goals {
    const gs: Goals = [];
    avs.forEach((av, i) => {
      const t = ats[i];
      if (t === undefined) return;
      const T = deref(t);
      const v = deref(av);
      if (v instanceof Var || isPartialOrFun(v, this.p)) {
        if (T instanceof Var || isWildcard(T)) return;
        if (v instanceof Var) gs.push(guardGoal(v, T));
        return;
      }
      const st = checkValue(v, T);
      if (st === "ok") return;
      if (st === "mismatch") throw new PrologError(S("error", S("literal_type_mismatch", v, T), "typecheck"));
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
      const v = deref(av);
      if (!(v instanceof Var) && checkValue(v, t) === "ok") return;
      gs.push(S("typecheck_match", av, t));
    });
    return gs;
  }

  /** decl_survives/2: no argument definitely mismatches. */
  declSurvives(avs: Term[], ats: Term[]): boolean {
    return avs.every((av, i) => {
      const v = deref(av);
      const t = ats[i];
      if (t === undefined || v instanceof Var) return true;
      return checkValue(v, t) !== "mismatch";
    });
  }

  /** overload_out_guard/5 for a multiply declared function: the result is filtered by the output type. */
  overloadOutGuard(out: Term, ot: Term): Goals {
    const o = deref(ot);
    if (isGroundType(o) && !isWildcard(o)) return [S("typecheck_match", out, o)];
    return [];
  }

  /** translate_declared_body/5: a function declared to return Atom returns its body as source data. */
  declaredBody(f: string, n: number, body: Term): Tr {
    const decls = this.fnDecls.get(f)?.filter((d) => d.args.length === n) ?? [];
    if (decls.some((d) => deref(d.out) === "Atom")) return [[], body];
    return this.p.translator.expr(body);
  }
}

function isPartialOrFun(v: Term, p: Petta): boolean {
  if (typeof v === "string") return p.isFun(v);
  return v instanceof Struct && v.name === "partial";
}

function isGroundType(t: Term): boolean {
  const d = deref(t);
  if (d instanceof Var) return false;
  if (d instanceof Cons) return isGroundType(d.head) && isGroundType(d.tail);
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

/** Runtime residual guards (value_checks.pl typecheck_or_error/2, typecheck_match/2, runtime_type_ok/2). */
export const TYPES_RUNTIME_PL = String.raw`
typecheck_or_error(V, T) :- ( var(V) -> true ; runtime_type_ok(V, T) -> true ; throw(error(literal_type_mismatch(V, T), typecheck)) ).
typecheck_match(V, T) :- ( var(V) -> true ; runtime_type_ok(V, T) ).
runtime_type_ok(V, 'Number') :- number(V), !.
runtime_type_ok(V, 'String') :- string(V), !.
runtime_type_ok(V, 'Bool') :- ( V == true ; V == false ), !.
runtime_type_ok(_, T) :- var(T), !.
runtime_type_ok(_, T) :- '$wildcard_type'(T), !.
runtime_type_ok(V, ['List', ET]) :- !, '$runtime_list_ok'(V, ET).
runtime_type_ok(V, [A|Ts]) :- '$arrow_atom'(A), !, '$runtime_callable_at_arrow_arity'(V, [A|Ts]).
runtime_type_ok(V, ['|'|Ms]) :- !, member(M, Ms), runtime_type_ok(V, M), !.
runtime_type_ok(V, T) :- is_list(T), T = [Tag|FieldTs], atom(Tag), \+ '$type_name'(Tag), !, is_list(V), V = [VTag|Fields], VTag == Tag, same_length(Fields, FieldTs), '$runtime_tuple_ok'(Fields, FieldTs).
runtime_type_ok(V, T) :- is_list(T), !, is_list(V), same_length(V, T), '$runtime_tuple_ok'(V, T).
runtime_type_ok(_, _) :- nb_current('$in_typecheck', true), !.
runtime_type_ok(V, T) :- setup_call_cleanup(nb_setval('$in_typecheck', true), ( 'get-type'(V, T) *-> true ; 'get-metatype'(V, T) ), nb_setval('$in_typecheck', false)).
'$runtime_list_ok'(V, _) :- var(V), !.
'$runtime_list_ok'([], _).
'$runtime_list_ok'([E|Es], ET) :- ( var(E) -> true ; runtime_type_ok(E, ET) ), '$runtime_list_ok'(Es, ET).
'$runtime_tuple_ok'([], []).
'$runtime_tuple_ok'([F|Fs], [T|Ts]) :- ( var(F) -> true ; runtime_type_ok(F, T) ), '$runtime_tuple_ok'(Fs, Ts).
'$runtime_callable_at_arrow_arity'(V, [_|Tail]) :- length(Tail, TailLen), Required is TailLen - 1, Required >= 0, ( atom(V), fun(V), CompiledArity is Required + 1, arity(V, CompiledArity) ; nonvar(V), V = partial(F, Bound), atom(F), fun(F), is_list(Bound), length(Bound, NB), arity(F, FullArity), Required =:= FullArity - NB - 1 ), !.
'$wildcard_type'(T) :- atom(T), memberchk(T, ['%Undefined%', 'Atom', 'Expression']).
'$arrow_atom'(A) :- atom(A), ( memberchk(A, ['->', '-[det]->', '-[semidet]->', '-[nondet]->']) -> true ; sub_atom(A, 0, 3, _, '-[$'), sub_atom(A, _, 3, 0, ']->') ).
'$type_name'(T) :- memberchk(T, ['Number', 'String', 'Bool', 'Symbol', 'Expression', 'Atom', 'Type', 'Variable', 'Grounded', '%Undefined%', 'List']).
same_length([], []).
same_length([_|T1], [_|T2]) :- same_length(T1, T2).
`;

void isList;
