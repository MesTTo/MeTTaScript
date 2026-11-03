// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: consult Prolog source on the engine, as PeTTa's libraries do through consult/1, use_module/1 and
// load_files/2: clauses are added, directives run (dynamic, multifile, thread_local, table, op, initialization),
// module qualification M:Goal calls Goal (one module), and `:- table` predicates answer from a table of
// variant calls completed on first call.
// am[implements a-pe-libraries]

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { variant, collectVars } from "./builtins";
import { Machine, copyTerm } from "./machine";
import { PrologReader } from "./prolog-reader";
import { PrologError, Str, Struct, Var, deref, existenceError, instantiationError, listToArray, mkList, mkStruct, textOf, typeError, type Term } from "./terms";

const S = mkStruct;

/** An open string stream from open_string/2. */
class StringStream {
  constructor(readonly text: string) {}
}

function commaItems(t: Term): Term[] {
  const d = deref(t);
  if (d instanceof Struct && d.name === "," && d.args.length === 2) return [...commaItems(d.args[0]!), ...commaItems(d.args[1]!)];
  const l = listToArray(d);
  return l ?? [d];
}

function piOf(t: Term): [string, number] | null {
  const d = deref(t);
  if (d instanceof Struct && d.name === "/" && d.args.length === 2) {
    const n = deref(d.args[0]!);
    const a = deref(d.args[1]!);
    if (typeof n === "string" && typeof a === "number") return [n, a];
  }
  if (d instanceof Struct && d.name === ":" && d.args.length === 2) return piOf(d.args[1]!);
  return null;
}

/** Consult Prolog source text: add clauses, run directives. */
export function consultText(m: Machine, text: string): void {
  const r = new PrologReader(text, m.ops);
  const inits: Term[] = [];
  for (let c = r.readClause(); c !== null; c = r.readClause()) {
    const d = deref(c);
    if (d instanceof Struct && d.name === ":-" && d.args.length === 1) {
      directive(m, d.args[0]!, inits);
      continue;
    }
    if (d instanceof Struct && d.name === "?-" && d.args.length === 1) {
      m.solveOnce(d.args[0]!);
      continue;
    }
    m.addClause(stripModule(d), true);
  }
  for (const g of inits) m.solveOnce(g);
}

function stripModule(c: Term): Term {
  const d = deref(c);
  if (d instanceof Struct && d.name === ":" && d.args.length === 2) return stripModule(d.args[1]!);
  if (d instanceof Struct && d.name === ":-" && d.args.length === 2) return S(":-", stripModule(d.args[0]!), d.args[1]!);
  return d;
}

function directive(m: Machine, g: Term, inits: Term[]): void {
  const d = deref(g);
  if (d instanceof Struct && d.args.length === 1) {
    switch (d.name) {
      case "dynamic":
      case "multifile":
      case "thread_local":
      case "discontiguous":
      case "volatile":
        for (const pi of commaItems(d.args[0]!)) {
          const p = piOf(pi);
          if (p !== null && d.name !== "discontiguous") m.db.ensure(p[0], p[1]).dynamic = true;
        }
        return;
      case "table":
        for (const pi of commaItems(d.args[0]!)) {
          const p = piOf(pi);
          if (p !== null) m.tabled.add(p[0] + "/" + p[1]);
        }
        return;
      case "module":
      case "use_module":
      case "ensure_loaded":
      case "license":
      case "set_prolog_flag":
        if (d.name === "use_module" || d.name === "ensure_loaded") loadSpec(m, d.args[0]!);
        return;
      case "initialization":
        inits.push(d.args[0]!);
        return;
    }
  }
  if (d instanceof Struct && (d.name === "module" || d.name === "use_module") && d.args.length === 2) {
    if (d.name === "use_module") loadSpec(m, d.args[0]!);
    return;
  }
  if (d instanceof Struct && d.name === "initialization" && d.args.length === 2) {
    inits.push(d.args[0]!);
    return;
  }
  m.solveOnce(d);
}

/** use_module/ensure_loaded of a file path consults it; library(X) names the engine's own library. */
function loadSpec(m: Machine, spec: Term): void {
  const d = deref(spec);
  if (d instanceof Struct && d.name === "library") return;
  const path = textOf(d);
  if (path === null) return;
  consultFile(m, path);
}

const consulted = new WeakMap<Machine, Set<string>>();

export function consultFile(m: Machine, path: string): void {
  let p = resolvePath(path);
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    try {
      p = p + ".pl";
      text = readFileSync(p, "utf8");
    } catch {
      throw existenceError("source_sink", path);
    }
  }
  let seen = consulted.get(m);
  if (seen === undefined) consulted.set(m, (seen = new Set()));
  seen.add(p);
  consultText(m, text);
}

export function installConsult(m: Machine): void {
  const det = (name: string, arity: number, fn: (args: Term[]) => boolean): void => m.defBuiltin(name, arity, { det: (_m, a) => fn(a) });
  // consult/1 of one file throws when it is missing; of a list it reports each missing file and goes on.
  det("consult", 1, ([f]) => {
    const items = listToArray(f!);
    if (items === null) {
      const path = textOf(f!);
      if (path === null) throw typeError("text", f!);
      consultFile(m, path);
      return true;
    }
    for (const x of items) {
      const path = textOf(x);
      if (path === null) throw typeError("text", x);
      try {
        consultFile(m, path);
      } catch (e) {
        if (!(e instanceof PrologError)) throw e;
        m.err(`ERROR: source_sink \`${path}' does not exist\n`);
      }
    }
    return true;
  });
  det("use_module", 1, ([f]) => (loadSpec(m, f!), true));
  det("use_module", 2, ([f]) => (loadSpec(m, f!), true));
  det("ensure_loaded", 1, ([f]) => (loadSpec(m, f!), true));
  det("multifile", 1, ([spec]) => (directive(m, S("multifile", spec!), []), true));
  det("thread_local", 1, ([spec]) => (directive(m, S("thread_local", spec!), []), true));
  det("table", 1, ([spec]) => (directive(m, S("table", spec!), []), true));
  det("open_string", 2, ([s, stream]) => {
    const text = textOf(s!);
    if (text === null) throw instantiationError();
    return m.unify(stream!, S("$stream", m.registerObject(new StringStream(text))));
  });
  det("load_files", 2, ([_module, opts]) => {
    for (const o of listToArray(opts!) ?? []) {
      const d = deref(o);
      if (d instanceof Struct && d.name === "stream" && d.args.length === 1) {
        const st = m.objectOf(deref(d.args[0]!));
        if (st instanceof StringStream) consultText(m, st.text);
      }
    }
    return true;
  });
  det("atomics_to_string", 2, ([l, s]) => {
    const items = listToArray(l!);
    if (items === null) throw instantiationError();
    return m.unify(s!, new Str(items.map((x) => textOf(x) ?? "").join("")));
  });
  det("abolish_all_tables", 0, () => (m.tables.clear(), true));
  // M:Goal calls Goal: the engine has one module.
  m.defBuiltin(":", 2, {
    det: (m2, [_mod, g]) => {
      m2.pushGoal(g!);
      return true;
    },
  });
  void variant;
  void collectVars;
  void copyTerm;
  void mkList;
  void Var;
}
