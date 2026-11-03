// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the core of PeTTa's determinism checking (src/typecheck/det_validate.pl, det_proofs.pl,
// det_analysis.pl): a function declared -[det]-> or -[semidet]-> has its body walked for constructs that can
// produce several results or none (superpose, match, a nondet or semidet call, an if without else), a
// definite violation is the compile error determinism_conflict(F, Reason), overlapping committed clauses are
// rejected, and committed functions commit to their first matching clause with a cut. Where PeTTa's richer
// inference would decide and this walk cannot, it stays silent rather than reject a valid program.
// am[implements a-pe-det-checker]

import type { Petta } from "./engine";
import { Cons, PrologError, Struct, Var, deref, listToArray, mkList, mkStruct, type Term } from "./terms";

const S = mkStruct;

/** ok < may_fail < nondeterministic, unknown (det_result_rank/2). */
interface DetR {
  readonly rank: 0 | 1 | 2;
  readonly kind: "ok" | "may_fail" | "nondeterministic" | "unknown";
  readonly why: Term;
}
const OK: DetR = { rank: 0, kind: "ok", why: "ok" };
const mayFail = (why: Term): DetR => ({ rank: 1, kind: "may_fail", why });
const nondet = (why: Term): DetR => ({ rank: 2, kind: "nondeterministic", why });
const unknown = (why: Term): DetR => ({ rank: 2, kind: "unknown", why });
const combine = (a: DetR, b: DetR): DetR => (b.rank > a.rank ? b : a);

export class Det {
  private readonly analyzing = new Set<string>();
  /** Variables proven nonempty lists on the path being analysed (the else of (if (== V ()) ...)). */
  private readonly nonempty = new Set<Var>();
  constructor(private readonly p: Petta) {}

  /** fn_determinism/3 from the declarations' arrows: det, semidet, nondet, or unspecified. */
  fnDeterminism(f: string, n: number): string {
    const ds = [...new Set(this.p.types.declsArity(f, n).map((d) => (d.det === "plain" || d.det === "effect" ? "unspecified" : d.det)))].sort();
    if (ds.length === 0) return "unspecified";
    if (ds.length === 1) return ds[0]!;
    if (ds.join() === "det,semidet") return "semidet";
    if (ds.join() === "nondet,unspecified") return "nondet";
    return "unspecified";
  }

  committed(f: string, n: number): boolean {
    const d = this.fnDeterminism(f, n);
    return d === "det" || d === "semidet";
  }

  /** validate_function_determinism/5 for one clause of F. */
  validate(f: string, args: Term[], body: Term, prev: { args: Term[]; body: Term }[], headForm: string): void {
    const det = this.fnDeterminism(f, args.length);
    if (det !== "det" && det !== "semidet") return;
    if (headForm === "head_goals") throw new PrologError(S("error", S("det_functional_head_commitment", f, mkList(args)), "determinism"));
    const r = this.exprDet(body);
    if (r.kind === "nondeterministic" || (r.kind === "may_fail" && det === "det"))
      throw new PrologError(S("error", S("determinism_conflict", f, r.why), "determinism"));
    for (const pm of prev) {
      if (pm.args.length !== args.length) continue;
      if (this.headsOverlap(args, pm.args) && !bodyCommits(pm.body))
        throw new PrologError(S("error", S("overlapping_deterministic_clauses", f, mkList(args), mkList(pm.args)), "determinism"));
    }
  }

  /** clause_heads_overlap/2: the two heads unify. */
  private headsOverlap(a: Term[], b: Term[]): boolean {
    const m = this.p.m;
    const mark = m.trailMark();
    const ok = m.unify(mkList(a), mkList(b));
    m.undoTo(mark);
    return ok;
  }

  private list(exprs: Term[]): DetR {
    let r = OK;
    for (const e of exprs) {
      const x = this.exprDet(e);
      if (x.rank === 2) return x;
      r = combine(r, x);
    }
    return r;
  }

  /** deterministic_expr_core/2, the cases this port decides. */
  exprDet(e: Term): DetR {
    const d = deref(e);
    if (d instanceof Var || !(d instanceof Cons) || (d instanceof Struct && d.name === "partial")) return OK;
    const items = listToArray(d);
    if (items === null || items.length === 0) return OK;
    const head = deref(items[0]!);
    const args = items.slice(1);
    if (head instanceof Var) {
      if (args.length === 0) return OK;
      const k = this.p.types.knownOf(head);
      const kd = k === undefined ? undefined : deref(k);
      if (kd !== undefined && !(kd instanceof Var)) {
        const ki = listToArray(kd);
        const arrow = ki !== null && ki.length > 0 ? deref(ki[0]!) : null;
        if (arrow === "-[det]->") return this.list(args);
        if (arrow === "-[semidet]->") return combine(mayFail("semidet_closure"), this.list(args));
        if (arrow === "-[nondet]->") return nondet("nondet_closure");
      }
      return unknown(S("dynamic_head", head));
    }
    switch (head) {
      case "collapse":
      case "quote":
      case "|->":
      case "forall":
      case "foldall":
        return OK;
      case "trace!":
      case "progn":
      case "prog1":
      case "data":
      case "make-list":
        return this.list(args);
      case "once": {
        const r = this.exprDet(args[0]!);
        if (r.rank <= 1) return r;
        return mayFail(S("once", r.why));
      }
      case "eval":
        return unknown("dynamic_eval");
      case "reduce":
        return unknown("dynamic_reduce");
      case "superpose":
        return nondet("superpose");
      case "match":
        return nondet("match");
      case "hyperpose":
        return nondet("hyperpose");
      case "translatePredicate":
        return nondet("translatePredicate");
      case "sealed":
        return args.length === 2 ? this.exprDet(args[1]!) : OK;
      case "if":
        if (args.length === 2) return combine(mayFail("if_without_else"), this.list(args));
        if (args.length === 3) {
          const v = nonemptyNarrowingVar(args[0]!);
          if (v === null) return this.list(args);
          const rc = this.exprDet(args[0]!);
          const rt = this.exprDet(args[1]!);
          const had = this.nonempty.has(v);
          this.nonempty.add(v);
          try {
            return combine(combine(rc, rt), this.exprDet(args[2]!));
          } finally {
            if (!had) this.nonempty.delete(v);
          }
        }
        break;
      case "let":
      case "chain":
        if (args.length === 3) return this.letDet(args[0]!, args[1]!, args[2]!);
        break;
      case "let*": {
        const binds = listToArray(deref(args[0]!));
        if (binds === null || args.length !== 2) break;
        return this.bindsDet(binds, args[1]!);
      }
      case "case":
        if (args.length === 2) {
          const k = this.exprDet(args[0]!);
          if (k.rank === 2) return k;
          const pairs = listToArray(deref(args[1]!)) ?? [];
          let r = k;
          for (const pr of pairs) {
            const pi = listToArray(deref(pr));
            if (pi !== null && pi.length === 2) r = combine(r, this.exprDet(pi[1]!));
          }
          return r;
        }
        break;
      case "call": {
        const inner = listToArray(deref(args[0]!));
        if (inner !== null && inner.length > 0 && typeof deref(inner[0]!) === "string") return this.callDet(deref(inner[0]!) as string, inner.slice(1));
        return unknown("dynamic_call");
      }
      case "=":
      case "=?":
      case "=alpha":
      case "=@=":
        if (args.length === 2) return OK;
        break;
    }
    if (typeof head === "string" && this.p.isFun(head)) return this.callDet(head, args);
    // data: a literal or non-function head, or a list in head position
    return this.list(items);
  }

  private unboundGenerator(a: Term): boolean {
    const d = deref(a);
    if (!(d instanceof Var)) return false;
    const k = this.p.types.knownOf(d);
    return k === undefined || deref(k) instanceof Var;
  }

  /** callPredicate of (Predicate (F ...)): as det as F's declaration says; an undeclared predicate is not proven. */
  private predicateDet(arg: Term): string {
    const a = listToArray(deref(arg));
    if (a === null || a.length !== 2 || deref(a[0]!) !== "Predicate") return "unspecified";
    let g = listToArray(deref(a[1]!));
    if (g !== null && g.length === 2 && deref(g[0]!) === "quote") g = listToArray(deref(g[1]!));
    if (g === null || g.length === 0 || typeof deref(g[0]!) !== "string") return "unspecified";
    const d = this.fnDeterminism(deref(g[0]!) as string, g.length - 1);
    return d === "unspecified" ? "nondet" : d;
  }

  /** let_determinism/4: a destructuring pattern may fail to unify. */
  private letDet(pat: Term, val: Term, inn: Term): DetR {
    const p = deref(pat);
    const pr = p instanceof Var || this.patternGuaranteed(p, val) ? OK : this.patternDet(p);
    if (pr.rank === 2) return pr;
    const v = this.exprDet(val);
    if (v.rank === 2) return v;
    return combine(combine(pr, v), this.exprDet(inn));
  }

  /** A (Ctor vars...) pattern over a value whose declared or known type is Ctor's output type cannot fail. */
  private patternGuaranteed(p: Term, val: Term): boolean {
    const pi = listToArray(p);
    if (pi === null || pi.length === 0 || typeof deref(pi[0]!) !== "string" || !pi.slice(1).every((x) => deref(x) instanceof Var)) return false;
    const ctorDecls = this.p.types.declsArity(deref(pi[0]!) as string, pi.length - 1);
    if (ctorDecls.length !== 1) return false;
    const vi = listToArray(deref(val));
    let vt: Term | undefined = this.p.types.knownOf(val);
    if (vt === undefined && vi !== null && vi.length > 0 && typeof deref(vi[0]!) === "string") {
      const ds = this.p.types.declsArity(deref(vi[0]!) as string, vi.length - 1);
      if (ds.length === 1) vt = ds[0]!.out;
    }
    if (vt === undefined) return false;
    const a = deref(vt);
    const b = deref(ctorDecls[0]!.out);
    return typeof a === "string" && a === b;
  }

  private patternDet(p: Term): DetR {
    const items = listToArray(p);
    if (items !== null && items.every((x) => deref(x) instanceof Var)) return OK;
    return mayFail("let_pattern");
  }

  private bindsDet(binds: Term[], body: Term): DetR {
    if (binds.length === 0) return this.exprDet(body);
    const b = listToArray(deref(binds[0]!));
    if (b === null || b.length !== 2) return OK;
    const rest = binds.slice(1);
    const inn = rest.length === 0 ? body : mkList(["let*", mkList(rest), body]);
    return this.letDet(b[0]!, b[1]!, inn);
  }

  /** deterministic_call_expr/2 over call_site_determinism/4. */
  private callDet(f: string, args: Term[]): DetR {
    const n = args.length;
    const evaluated = (f === "add-atom" || f === "remove-atom") && n === 2 ? [args[0]!] : args;
    const det = this.callSiteDet(f, n, args);
    if (det === "nondet") return nondet(S("call", f));
    // semidet_site_upgraded_to_det/3: a semidet call on a list proven nonempty here cannot fail.
    if (det === "semidet" && args.some((a) => { const d = deref(a); return d instanceof Var && this.nonempty.has(d); })) return this.list(evaluated);
    if (det === "semidet") return combine(mayFail(S("call", f)), this.list(evaluated));
    if (det === "det") return this.list(evaluated);
    // An undeclared callee: its own clauses decide, analysed assuming the recursive call is det.
    const key = f + "/" + n;
    if (this.analyzing.has(key)) return this.list(evaluated);
    const metas = this.p.funMetaOf(f)?.filter((mt) => mt.args.length === n);
    if (metas === undefined || metas.length === 0) return unknown(S("undetermined_call", f));
    this.analyzing.add(key);
    try {
      let r = OK;
      for (const mt of metas) r = combine(r, this.exprDet(mt.body));
      if (metas.length > 1) return combine(unknown(S("undetermined_call", f)), this.list(evaluated));
      return combine(r, this.list(evaluated));
    } finally {
      this.analyzing.delete(key);
    }
  }

  private callSiteDet(f: string, n: number, args: Term[]): string {
    if (f === "callPredicate" && n === 1) return this.predicateDet(args[0]!);
    const card = this.p.builtinCardinality(f, n);
    if (card !== undefined) {
      const c = deref(card);
      if (c instanceof Struct && c.name === "fixed") return deref(c.args[0]!) as string;
      if (c instanceof Struct && c.name === "argument_sensitive") {
        const rule = deref(c.args[0]!);
        // manifest_booleans: an operand that is an unbound variable with no Bool evidence enumerates.
        if (rule === "manifest_booleans") return args.some((a) => this.unboundGenerator(a)) ? (deref(c.args[1]!) as string) : "det";
        // the other rules (list shapes, space updates) are proven by PeTTa's analysis this walk lacks
        return "det";
      }
    }
    const d = this.fnDeterminism(f, n);
    return d;
  }
}

/** nonempty_narrowing_var/2: (== V ()) or (== () V) narrows V to a nonempty list in the else branch. */
function nonemptyNarrowingVar(cond: Term): Var | null {
  const c = listToArray(deref(cond));
  if (c === null || c.length !== 3 || deref(c[0]!) !== "==") return null;
  const [a, b] = [deref(c[1]!), deref(c[2]!)];
  const isNil = (x: Term): boolean => !(x instanceof Var) && listToArray(x)?.length === 0;
  if (a instanceof Var && isNil(b)) return a;
  if (b instanceof Var && isNil(a)) return b;
  return null;
}

/** body_commits/1: a clause body that cuts first never falls through to a later clause. */
function bodyCommits(body: Term): boolean {
  const items = listToArray(deref(body));
  if (items === null || items.length === 0) return false;
  const h = deref(items[0]!);
  if (h === "cut" && items.length === 1) return true;
  if (h === "progn" && items.length > 1) return bodyCommits(items[1]!);
  // let/let* unify a variable pattern before their value goals, so a cut value runs first
  if ((h === "let" || h === "chain") && items.length === 4 && deref(items[1]!) instanceof Var) return bodyCommits(items[2]!);
  if (h === "let*" && items.length === 3) {
    const binds = listToArray(deref(items[1]!));
    const first = binds !== null && binds.length > 0 ? listToArray(deref(binds[0]!)) : null;
    if (first !== null && first.length === 2 && deref(first[0]!) instanceof Var) return bodyCommits(first[1]!);
  }
  return false;
}
