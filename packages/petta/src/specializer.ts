// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: PeTTa's higher-order call specializer (src/specializer.pl): a call that passes a registered function
// or a partial into a parameter its callee's clauses call or pass on is compiled against a copy of the callee
// specialized to that argument, named Callee_Spec_<bind set>, whose clauses and type declarations also enter
// &self as atoms. A copy that does not type-check, or whose body never calls the argument, is not made.
// am[implements a-pe-types-runtime]

import type { Petta } from "./engine";
import { copyTerm } from "./machine";
import { Cons, PrologError, Struct, Var, deref, isList, listToArray, mkList, mkStruct, type Term } from "./terms";
import { collectVars } from "./builtins";
import { writeTerm } from "./writer";

export class Specializer {
  private readonly stack: string[] = [];
  private specNeeded = false;
  /** HV -> the names of its live specializations. */
  private readonly specs = new Map<string, Set<string>>();
  /** "HV/Arity/key" of specializations that failed. */
  private readonly failed = new Set<string>();
  constructor(private readonly p: Petta) {}

  private specializableArg(t: Term): boolean {
    const d = deref(t);
    return (typeof d === "string" && this.p.isFun(d)) || (d instanceof Struct && d.name === "partial" && d.args.length === 2);
  }

  /** var_use_check/3: Var at a call head (head), or as an argument of a specializable head (ho), in Body. */
  private varUse(mode: "head" | "ho", v: Var, body: Term): boolean {
    const items = listToArray(deref(body));
    if (items === null || items.length === 0) return false;
    if (mode === "head" && deref(items[0]!) === v) {
      this.specNeeded = true;
      return true;
    }
    if (mode === "ho" && this.specializableArg(items[0]!)) {
      for (const a of items.slice(1)) {
        const d = deref(a);
        if (d === v) return true;
        if ((d instanceof Cons && isList(d)) && this.varUse("ho", v, d)) return true;
      }
    }
    for (const e of items) {
      const d = deref(e);
      if (d instanceof Cons && isList(d) && this.varUse(mode, v, d)) return true;
    }
    return false;
  }

  /** traverse_list/3 with [A,V]>>(nonvar(V) -> V = A ; true): bind pattern copy positions to call values. */
  private traverse(from: Term, into: Term): void {
    const f = deref(from);
    const t = deref(into);
    const fl = listToArray(f);
    const tl = listToArray(t);
    if (fl !== null && tl !== null && fl.length === tl.length) {
      fl.forEach((x, i) => this.traverse(x, tl[i]!));
      return;
    }
    if (!(t instanceof Var)) {
      const m = this.p.m;
      const mark = m.trailMark();
      if (!m.unify(t, f)) m.undoTo(mark);
    }
  }

  /** maybe_specialize_call/4: the goal calling the specialization, or null. */
  maybeSpecialize(hv: string, avs: Term[], out: Term): Term | null {
    if (this.stack.includes(hv)) return null;
    const prev = this.specNeeded;
    this.specNeeded = false;
    this.stack.push(hv);
    try {
      return this.specialize(hv, avs, out);
    } finally {
      this.stack.pop();
      if (prev) this.specNeeded = prev;
    }
  }

  private specialize(hv: string, avs: Term[], out: Term): Term | null {
    const metas0 = this.p.funMetaOf(hv);
    if (metas0 === undefined || metas0.length === 0) return null;
    // Copy every meta clause: the specialization binds their variables.
    const metas = metas0.map((mt) => {
      const c = copyTerm(mkList([mkList(mt.args), mt.body])) as Cons;
      const items = listToArray(c)!;
      return { args: listToArray(items[0]!)!, body: items[1]! };
    });
    const bindSet: Term[] = [];
    for (const mt of metas) {
      if (mt.args.length !== avs.length) continue;
      mt.args.forEach((arg, i) => {
        const vars = collectVars(arg);
        const map = new Map<Var, Var>();
        const argCopy = copyTerm(arg, map);
        this.traverse(argCopy, avs[i]!);
        for (const v of vars) {
          const cp = map.get(v)!;
          const cpd = deref(cp);
          if (cpd instanceof Var) continue;
          if (!this.specializableArg(cpd)) continue;
          if (!(this.varUse("head", v, mt.body) || this.varUse("ho", v, mt.body))) continue;
          this.p.m.unify(v, cpd);
          bindSet.push(v);
        }
      });
    }
    if (bindSet.length === 0) return null;
    const key = writeTerm(this.normalizeKey(mkList(bindSet)), { numbervars: true });
    const arity = avs.length + 1;
    if (this.failed.has(`${hv}/${arity}/${key}`)) return null;
    const specName = `${hv}_Spec_${key}`;
    const existing = this.specs.get(hv);
    if (existing === undefined || !existing.has(specName)) {
      if (!this.build(hv, specName, arity, metas)) {
        this.failed.add(`${hv}/${arity}/${key}`);
        return null;
      }
    }
    return new Struct(specName, [...avs, out]);
  }

  /** normalize_specialization_key/2: a copy with variables numbered, singletons as _. */
  private normalizeKey(t: Term): Term {
    const c = copyTerm(t);
    const counts = new Map<Var, number>();
    const walk = (x: Term): void => {
      x = deref(x);
      if (x instanceof Var) counts.set(x, (counts.get(x) ?? 0) + 1);
      else if (x instanceof Cons) {
        walk(x.head);
        walk(x.tail);
      } else if (x instanceof Struct) x.args.forEach(walk);
    };
    walk(c);
    let n = 0;
    for (const v of collectVars(c)) v.ref = counts.get(v) === 1 ? mkStruct("$VAR", "_") : mkStruct("$VAR", n++);
    return c;
  }

  private build(hv: string, specName: string, arity: number, metas: { args: Term[]; body: Term }[]): boolean {
    const p = this.p;
    p.registerFun(specName);
    p.noteArity(specName, arity);
    const set = this.specs.get(hv) ?? new Set<string>();
    set.add(specName);
    this.specs.set(hv, set);
    try {
      // Reuse the parent's declarations for the specialization.
      for (const decl of p.typeChainsOf(hv)) p.addSexp("&self", mkList([":", specName, decl]));
      const clauses: { input: Term; clause: Term }[] = [];
      for (const mt of metas) {
        if (mt.args.length !== arity - 1) continue;
        const input = mkList(["=", mkList([specName, ...mt.args]), mt.body]);
        try {
          clauses.push({ input, clause: p.translator.clause(input, false) });
        } catch (e) {
          if (e instanceof PrologError && isTypecheckError(e.ball)) throw new SpecFail();
          throw e;
        }
      }
      if (!this.specNeeded) throw new SpecFail();
      for (const c of clauses.reverse()) p.assertSpecialization(c.input, c.clause);
      return true;
    } catch (e) {
      if (!(e instanceof SpecFail)) throw e;
      p.forgetSymbol(specName);
      set.delete(specName);
      return false;
    }
  }

  /** invalidate_specializations/1: F's clauses changed, so its specializations go. */
  invalidate(f: string): void {
    this.failed.clear();
    const set = this.specs.get(f);
    if (set === undefined) return;
    for (const s of [...set]) {
      this.invalidate(s);
      this.p.forgetSymbol(s);
    }
    this.specs.delete(f);
  }
}

class SpecFail extends Error {}

function isTypecheckError(ball: Term): boolean {
  const b = deref(ball);
  return b instanceof Struct && b.name === "error" && b.args.length === 2 && deref(b.args[1]!) === "typecheck";
}
