// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: consult Prolog source on the machine with SWI-Prolog's loading semantics, enough to load PeTTa's own
// src, its libraries and the vendored SWI libraries: clauses enter one namespace (module directives and M:
// qualifications are dropped, which c-petta-flatten-safe shows keeps every definition), DCG rules translate as
// SWI's dcg_translate_rule/2 does, directives run (dynamic, multifile, table, initialization, use_module and
// ensure_loaded of files resolved against the loading file's directory, each loaded once), their goals and if/elif
// conditions on the engine running the program (Machine.solveProgram), plunit blocks are skipped, and
// prolog_load_context/2 answers for the file being loaded. Clause bodies are goal-expanded as SWI expands them once
// library(yall) is loaded (goal-expansion.ts), meta_predicate declarations taken into account.
// am[implements a-hp-loader]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Machine } from "./machine";
import { PrologReader } from "./prolog-reader";
import { writeTerm } from "./writer";
import {
  Cons,
  NIL,
  PrologError,
  Str,
  Struct,
  Var,
  deref,
  existenceError,
  instantiationError,
  listToArray,
  mkList,
  mkStruct,
  mkVar,
  textOf,
  typeError,
  unqualify,
  type Term,
} from "./terms";
import { InStream } from "./builtins";
import { declareMetaPredicates, enableYallExpansion, expandClauseGoals, expandDirectiveGoal } from "./goal-expansion";

const S = mkStruct;

/** One file being loaded: what prolog_load_context/2 reports and the goals to run once it is loaded. */
interface LoadCtx {
  file: string;
  directory: string;
  module: string;
  inTests: boolean;
  inits: Term[];
  /** :- if/elif/else/endif frames: whether this branch loads, and whether an earlier branch already did. */
  conds: { active: boolean; taken: boolean }[];
  /** Predicates this file defines with => rules, which end in a clause raising existence_error(matching_rule). */
  ssu: Set<string>;
}

interface LoaderState {
  stack: LoadCtx[];
  /** Absolute paths loaded by ensure_loaded/use_module, which load a file once. */
  loaded: Set<string>;
  /** Every file loaded, in load order (source_file/1). */
  files: string[];
  /** Module name to the file declaring it (current_module/1, module_property/2). */
  modules: Map<string, { file: string; exports: Term }>;
  /** The goal of initialization(G, main), run by the program's entry. */
  mainGoal: Term | null;
}

const states = new WeakMap<Machine, LoaderState>();

function stateOf(m: Machine): LoaderState {
  let s = states.get(m);
  if (s === undefined) states.set(m, (s = { stack: [], loaded: new Set(), files: [], modules: new Map(), mainGoal: null }));
  return s;
}

/** What a finished load leaves in the loader (image.ts saves it): files loaded, modules declared, the main goal. */
export interface LoaderSnapshot {
  readonly loaded: string[];
  readonly files: string[];
  readonly modules: [string, string, Term][];
  readonly mainGoal: Term | null;
}

// am[implements a-petta-speed-1105.startup.image]
export function loaderSnapshot(m: Machine): LoaderSnapshot {
  const s = stateOf(m);
  if (s.stack.length > 0) throw new Error("internal: loader snapshot taken while a file is loading");
  return { loaded: [...s.loaded], files: [...s.files], modules: [...s.modules].map(([k, v]) => [k, v.file, v.exports]), mainGoal: s.mainGoal };
}

// am[implements a-petta-speed-1105.startup.image]
export function restoreLoader(m: Machine, snap: LoaderSnapshot): void {
  states.set(m, {
    stack: [],
    loaded: new Set(snap.loaded),
    files: [...snap.files],
    modules: new Map(snap.modules.map(([k, file, exports]) => [k, { file, exports }])),
    mainGoal: snap.mainGoal,
  });
}

/**
 * Runs every load-time directive when set: `run` runs it. The image builder uses it to find the directives that
 * read the argv flag (image.ts), whose effects differ between runs.
 */
let directiveHook: ((m: Machine, g: Term, file: string, run: () => void) => void) | null = null;
export function setDirectiveHook(h: typeof directiveHook): void {
  directiveHook = h;
}

/** Run a directive goal as consult does while loading `file`: in that file's load context, warning on failure or error. */
// am[implements a-petta-speed-1105.startup.image]
export function runFileDirective(m: Machine, file: string, g: Term): void {
  const st = stateOf(m);
  const ctx = freshCtx(file);
  st.stack.push(ctx);
  try {
    runDirective(m, ctx, g);
  } finally {
    st.stack.pop();
  }
}

function freshCtx(file: string): LoadCtx {
  return { file, directory: file ? dirname(file) : process.cwd(), module: "user", inTests: false, inits: [], conds: [], ssu: new Set() };
}

function loading(ctx: LoadCtx): boolean {
  return ctx.conds.every((c) => c.active);
}

/** Treat a file as loaded already, so use_module and ensure_loaded of it do nothing. */
export function markLoaded(m: Machine, path: string): void {
  stateOf(m).loaded.add(resolvePath(path));
}

/** The goal a loaded file registered with initialization(G, main), if any. */
export function mainGoalOf(m: Machine): Term | null {
  return stateOf(m).mainGoal;
}

/** The vendored SWI-Prolog library directory (swipl/library beside dist or src). */
function swiLibraryDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "..", "swipl", "library"), join(here, "..", "..", "swipl", "library")]) if (existsSync(c)) return c;
  return join(here, "..", "swipl", "library");
}

function commaItems(t: Term): Term[] {
  const d = deref(t);
  if (d instanceof Struct && d.name === "," && d.args.length === 2) return [...commaItems(d.args[0]!), ...commaItems(d.args[1]!)];
  const l = listToArray(d);
  return l ?? [d];
}

/** Name/Arity or Name//Arity (a DCG nonterminal, two more arguments), possibly module-qualified. */
function piOf(t: Term): [string, number] | null {
  const d = deref(t);
  if (d instanceof Struct && (d.name === "/" || d.name === "//") && d.args.length === 2) {
    const n = deref(d.args[0]!);
    const a = deref(d.args[1]!);
    if (typeof n === "string" && typeof a === "number") return [n, d.name === "//" ? a + 2 : a];
  }
  if (d instanceof Struct && d.name === ":" && d.args.length === 2) return piOf(d.args[1]!);
  return null;
}

function stripModule(c: Term): Term {
  const d = deref(c);
  if (d instanceof Struct && d.name === ":" && d.args.length === 2) return stripModule(d.args[1]!);
  if (d instanceof Struct && (d.name === ":-" || d.name === "-->") && d.args.length === 2) return S(d.name, stripModule(d.args[0]!), d.args[1]!);
  if (d instanceof Struct && d.name === "," && d.args.length === 2) return S(",", stripModule(d.args[0]!), d.args[1]!);
  return d;
}

/**
 * Module:attr_unify_hook(A, B) and Module:attribute_goals(V)//: the one namespace keeps the module as the
 * first argument of '$attr_unify_hook'/3 and '$attribute_goals'/4, which the machine's wakeups and
 * copy_term/3 call, so each attribute module keeps its own hook.
 */
function hookClause(c: Term, fileModule: string): Term | null {
  const d = deref(c);
  const isRule = d instanceof Struct && (d.name === ":-" || d.name === "-->") && d.args.length === 2;
  let head = isRule ? deref((d as Struct).args[0]!) : d;
  let mod = fileModule;
  while (head instanceof Struct && head.name === ":" && head.args.length === 2) {
    const q = deref(head.args[0]!);
    if (typeof q === "string") mod = q;
    head = deref(head.args[1]!);
  }
  if (!(head instanceof Struct)) return null;
  let renamed: Term | null = null;
  if (head.name === "attr_unify_hook" && head.args.length === 2) renamed = new Struct("$attr_unify_hook", [mod, ...head.args]);
  else if (head.name === "attribute_goals" && head.args.length === 1 && isRule && (d as Struct).name === "-->")
    renamed = new Struct("$attribute_goals", [mod, ...head.args]);
  if (renamed === null) return null;
  return isRule ? S((d as Struct).name, renamed, (d as Struct).args[1]!) : renamed;
}

// ---- DCG translation (SWI-Prolog boot/dcg.pl, dcg_translate_rule/2 and dcg_body/7) ----

/** dcg_extend/4: a nonterminal with the two list arguments appended; call//N passes them to its closure. */
function dcgExtend(t: Term, s0: Term, s: Term): Term {
  const d = deref(t);
  if (d instanceof Var) throw instantiationError();
  if (typeof d === "string") return S(d, s0, s);
  if (d instanceof Struct) return new Struct(d.name, [...d.args, s0, s]);
  throw typeError("callable", d);
}

function codesOf(text: string): Term[] {
  return [...text].map((ch) => ch.codePointAt(0)!);
}

/** dcg_body/7 without positions: the goal reading S0 to S for a grammar body. */
export function dcgBody(b: Term, s0: Term, s: Term): Term {
  const d = deref(b);
  if (d instanceof Var) return S("phrase", d, s0, s);
  if (d instanceof Struct && d.name === ":" && d.args.length === 2) return dcgBody(d.args[1]!, s0, s);
  if (d === NIL) return S("=", s0, s);
  if (d instanceof Cons) {
    const items = listToArray(d);
    if (items === null) throw typeError("list", d);
    return S("=", s0, mkList(items, s));
  }
  if (d instanceof Str) return S("=", s0, mkList(codesOf(d.s), s));
  if (d === "{}") return S("=", s0, s);
  if (d instanceof Struct && d.name === "{}" && d.args.length === 1) return S(",", d.args[0]!, S("=", s, s0));
  if (d === "!") return S(",", "!", S("=", s, s0));
  if (d instanceof Struct && d.args.length === 2) {
    const [x, y] = d.args as [Term, Term];
    switch (d.name) {
      case ",": {
        const mid = mkVar();
        return S(",", dcgBody(x, s0, mid), dcgBody(y, mid, s));
      }
      case ";":
      case "|":
        return S(";", dcgBranch(x, s0, s), dcgBranch(y, s0, s));
      case "->":
      case "*->": {
        const mid = mkVar();
        return S(d.name, dcgBody(x, s0, mid), dcgBody(y, mid, s));
      }
    }
  }
  if (d instanceof Struct && d.name === "\\+" && d.args.length === 1) return S(",", S("\\+", dcgBody(d.args[0]!, s0, mkVar())), S("=", s, s0));
  return dcgExtend(d, s0, s);
}

/** A disjunct ends at S itself: its own output variable is bound to S when it is still free (my_unify/4). */
function dcgBranch(b: Term, s0: Term, s: Term): Term {
  const out = mkVar();
  const g = dcgBody(b, s0, out);
  out.ref = s;
  return g;
}

/** dcg_translate_rule/2: (Head, PushBack --> Body) and (Head --> Body) to a clause. */
export function dcgTranslateRule(rule: Term): Term {
  const r = deref(rule);
  if (!(r instanceof Struct && r.name === "-->" && r.args.length === 2)) throw typeError("dcg_rule", r);
  const [lhs, rhs] = r.args as [Term, Term];
  const s0 = mkVar();
  const s = mkVar();
  const l = deref(lhs);
  if (l instanceof Struct && l.name === "," && l.args.length === 2) {
    const s1 = mkVar();
    return S(":-", dcgExtend(stripModule(l.args[0]!), s0, s), S(",", dcgBody(rhs, s0, s1), dcgBody(l.args[1]!, s, s1)));
  }
  return S(":-", dcgExtend(stripModule(l), s0, s), dcgBody(rhs, s0, s));
}

// ---- loading ----

/** Consult Prolog source text as the file `file` (for load context and relative paths). */
export function consultText(m: Machine, text: string, file = ""): void {
  const st = stateOf(m);
  const ctx = freshCtx(file);
  if (file) st.files.push(file);
  st.stack.push(ctx);
  try {
    const r = new PrologReader(text, m.ops);
    const terms: Term[] = [];
    for (let c = r.readClause(); c !== null; c = r.readClause()) {
      const d = deref(c);
      // An op/3 directive changes how the rest of the file reads, so it runs as soon as it is read.
      if (d instanceof Struct && d.name === ":-" && d.args.length === 1) {
        const g = deref(d.args[0]!);
        if (g instanceof Struct && g.name === "op" && g.args.length === 3) runDirective(m, ctx, g);
      }
      terms.push(d);
    }
    const priv = libraryPrivacy(m, file, terms);
    for (const t of terms) {
      const d = priv === null ? t : priv(t);
      if (d instanceof Struct && d.name === ":-" && d.args.length === 1) {
        const g = deref(d.args[0]!);
        if (!(g instanceof Struct && g.name === "op" && g.args.length === 3)) directive(m, ctx, g);
        continue;
      }
      if (ctx.inTests || !loading(ctx)) continue;
      if (d instanceof Struct && d.name === "?-" && d.args.length === 1) {
        runDirective(m, ctx, d.args[0]!);
        continue;
      }
      const stored = addSourceClause(m, ctx, d);
      if (stored !== null && isSsuRule(t)) {
        const k = headKey(stored);
        if (k !== null) ctx.ssu.add(k);
      }
    }
    // A call no => rule matches raises existence_error(matching_rule, Head), as SWI does.
    for (const k of ctx.ssu) {
      const i = k.lastIndexOf("/");
      const [name, arity] = [k.slice(0, i), Number(k.slice(i + 1))];
      const args: Term[] = [];
      for (let j = 0; j < arity; j++) args.push(mkVar());
      const h = arity === 0 ? name : new Struct(name, args);
      addSourceClause(m, ctx, S(":-", h, S("throw", S("error", S("existence_error", "matching_rule", S(":", "user", h)), mkVar()))));
    }
  } finally {
    st.stack.pop();
  }
  for (const g of ctx.inits) runDirective(m, ctx, g);
}

/** Add one clause read from a file and return it; an error is reported as SWI's loader does, and loading goes on. */
function addSourceClause(m: Machine, ctx: LoadCtx, d: Term): Term | null {
  try {
    // Goal expansion (yall lambdas) runs on the translated clause; its auxiliary clauses are stored first.
    const clause = expandClauseGoals(m, sourceClause(d, ctx.module), (aux) => addSourceClause(m, ctx, aux));
    warnRedefinition(m, clause, ctx.file);
    m.sourceFile = ctx.file || null;
    try {
      m.addClause(clause, true);
    } finally {
      m.sourceFile = null;
    }
    return clause;
  } catch (e) {
    if (!(e instanceof PrologError)) throw e;
    m.err(`ERROR: ${ctx.file}:\nERROR:    ${writeTerm(e.ball, { quoted: true })}\n`);
    return null;
  }
}

function isSsuRule(t: Term): boolean {
  const d = unqualify(t);
  return d instanceof Struct && d.name === "=>" && d.args.length === 2;
}

/**
 * Head, Guard => Body (or Head => Body), SWI's single-sided unification rule, as an ordinary clause: the call
 * must be an instance of Head (subsumes_term/2), then Head is bound to it, the guard runs and the rule commits.
 */
function ssuClause(r: Struct): Term {
  let lhs = unqualify(r.args[0]!);
  let guard: Term | null = null;
  if (lhs instanceof Struct && lhs.name === "," && lhs.args.length === 2) {
    guard = lhs.args[1]!;
    lhs = unqualify(lhs.args[0]!);
  }
  const fresh = typeof lhs === "string" ? lhs : lhs instanceof Struct ? new Struct(lhs.name, lhs.args.map(() => mkVar())) : lhs;
  const match = S(",", S("subsumes_term", lhs, fresh), S("=", lhs, fresh));
  const commit = guard === null ? S(",", "!", r.args[1]!) : S(",", guard, S(",", "!", r.args[1]!));
  return S(":-", fresh, S(",", match, commit));
}

/** A read term as the clause it stores: attribute hooks keep their module, DCG and => rules translate. */
function sourceClause(d: Term, fileModule: string): Term {
  const cl = hookClause(d, fileModule) ?? stripModule(d);
  const dc = deref(cl);
  if (dc instanceof Struct && dc.name === "=>" && dc.args.length === 2) return ssuClause(dc);
  return dc instanceof Struct && dc.name === "-->" && dc.args.length === 2 ? dcgTranslateRule(dc) : cl;
}

function headKey(clause: Term): string | null {
  let h = deref(clause);
  if (h instanceof Struct && h.name === ":-" && h.args.length === 2) h = deref(h.args[0]!);
  if (typeof h === "string") return h + "/0";
  if (h instanceof Struct) return h.name + "/" + h.args.length;
  return null;
}

/**
 * A vendored SWI library module keeps its non-exported predicates private, as SWI's module system does:
 * each is renamed Module:Name in its clauses' heads, in goals of its bodies (through control constructs and
 * the closure of call/N) and in directives, so a helper such as dcg_basics's exp//0 cannot merge with a
 * user predicate of the same name (metta.pl's exp/2). PeTTa's own modules share one namespace, which
 * c-petta-flatten-safe measured to keep every definition. Null for a file that is not a library module.
 */
function libraryPrivacy(m: Machine, file: string, terms: Term[]): ((t: Term) => Term) | null {
  if (!file || !file.startsWith(swiLibraryDir())) return null;
  const head = deref(terms[0] ?? NIL);
  const decl = head instanceof Struct && head.name === ":-" && head.args.length === 1 ? deref(head.args[0]!) : null;
  if (!(decl instanceof Struct && decl.name === "module" && decl.args.length === 2)) return null;
  const mod = deref(decl.args[0]!) as string;
  const exported = new Set<string>();
  for (const e of listToArray(decl.args[1]!) ?? []) {
    const ed = deref(e);
    if (ed instanceof Struct && ed.name === "op" && ed.args.length === 3) {
      for (const n of listToArray(ed.args[2]!) ?? [ed.args[2]!]) m.ops.add(deref(ed.args[0]!) as number, deref(ed.args[1]!) as never, deref(n) as string);
      continue;
    }
    const p = piOf(ed);
    if (p !== null) exported.add(p[0] + "/" + p[1]);
  }
  const defined = new Set<string>();
  // am[implements a-hp-library-multifile]
  // A multifile predicate is meant to be extended from other modules (error:has_type/2 from assoc.pl), so it stays shared.
  const multifile = new Set<string>();
  for (const t of terms) {
    const d = deref(t);
    if (d instanceof Struct && d.name === ":-" && d.args.length === 1) {
      const g = deref(d.args[0]!);
      if (g instanceof Struct && g.name === "multifile" && g.args.length === 1)
        for (const pi of commaItems(g.args[0]!)) {
          const p = piOf(pi);
          if (p !== null) multifile.add(p[0] + "/" + p[1]);
        }
      continue;
    }
    if (d instanceof Struct && d.name === "?-" && d.args.length === 1) continue;
    const k = headKey(sourceClause(d, mod));
    if (k !== null) defined.add(k);
  }
  const isPrivate = (name: string, arity: number): boolean =>
    defined.has(name + "/" + arity) && !exported.has(name + "/" + arity) && !multifile.has(name + "/" + arity);
  const rename = (name: string, arity: number): string => (isPrivate(name, arity) ? `${mod}:${name}` : name);
  const closure = (c: Term, extra: number): Term => {
    const d = unqualify(c);
    if (typeof d === "string") return rename(d, extra);
    if (d instanceof Struct) return new Struct(rename(d.name, d.args.length + extra), d.args);
    return d;
  };
  const goal = (g: Term): Term => {
    const d = unqualify(g);
    if (typeof d === "string") return rename(d, 0);
    if (!(d instanceof Struct)) return d;
    const a = d.args;
    switch (`${d.name}/${a.length}`) {
      case ",/2":
      case ";/2":
      case "->/2":
      case "*->/2":
      case "forall/2":
        return S(d.name, goal(a[0]!), goal(a[1]!));
      case "\\+/1":
      case "once/1":
      case "ignore/1":
      case "call/1":
        return S(d.name, goal(a[0]!));
      case "findall/3":
      case "aggregate_all/3":
      case "bagof/3":
      case "setof/3":
        return S(d.name, a[0]!, goal(a[1]!), a[2]!);
      case "^/2":
        return S("^", a[0]!, goal(a[1]!));
      case "catch/3":
        return S("catch", goal(a[0]!), a[1]!, goal(a[2]!));
      // am[implements a-hp-library-multifile]
      // Database predicates take a clause head or clause (meta-argument :), which names the module's own predicate.
      case "clause/2":
        return S("clause", goal(a[0]!), a[1]!);
      case "clause/3":
        return S("clause", goal(a[0]!), a[1]!, a[2]!);
      case "assert/1":
      case "asserta/1":
      case "assertz/1":
      case "retract/1":
      case "retractall/1":
        return S(d.name, clause(a[0]!));
      case "setup_call_cleanup/3":
        return S(d.name, goal(a[0]!), goal(a[1]!), goal(a[2]!));
    }
    if (d.name === "call" && a.length > 1) return new Struct("call", [closure(a[0]!, a.length - 1), ...a.slice(1)]);
    return new Struct(rename(d.name, a.length), a);
  };
  const clause = (c: Term): Term => {
    const d = deref(c);
    if (d instanceof Struct && d.name === ":-" && d.args.length === 2) return S(":-", goal(d.args[0]!), goal(d.args[1]!));
    return goal(d);
  };
  return (t: Term): Term => {
    const d = deref(t);
    if (d instanceof Struct && d.name === ":-" && d.args.length === 1) {
      const g = deref(d.args[0]!);
      // Declarations name predicates by indicator, which stay as written; goal directives run renamed.
      if (g instanceof Struct && ["module", "use_module", "autoload", "meta_predicate", "dynamic", "multifile", "discontiguous", "if", "elif", "license", "public", "create_prolog_flag"].includes(g.name)) return d;
      return S(":-", goal(g));
    }
    return clause(sourceClause(d, mod));
  };
}

/** Two files defining one non-multifile predicate would merge silently in one namespace: say so on stderr. */
function warnRedefinition(m: Machine, clause: Term, file: string): void {
  if (!file) return;
  let h = deref(clause);
  if (h instanceof Struct && h.name === ":-" && h.args.length === 2) h = deref(h.args[0]!);
  const [name, arity] = typeof h === "string" ? [h, 0] : h instanceof Struct ? [h.name, h.args.length] : ["", -1];
  const p = m.db.get(name, arity);
  if (p !== undefined && p.file !== null && p.file !== file && !p.multifile)
    m.err(`Warning: ${file}: ${name}/${arity} is also defined in ${p.file}; one namespace merges their clauses\n`);
}

/**
 * A directive goal: run once on the engine running the program (Machine.solveProgram); failure and errors are reported
 * as SWI's loader warns, and loading goes on.
 * am[implements a-petta-errors-fix-1108.stack.cells]
 */
function runDirective(m: Machine, ctx: LoadCtx, g: Term): void {
  const run = (): void => {
    try {
      if (!m.solveProgram(g)) m.err(`Warning: ${ctx.file}:\nWarning:    Goal (directive) failed\n`);
    } catch (e) {
      if (!(e instanceof PrologError)) throw e;
      m.err(`Warning: ${ctx.file}:\nWarning:    Goal (directive) raised ${writeTerm(e.ball, { quoted: true })}\n`);
    }
  };
  if (directiveHook === null) run();
  else directiveHook(m, g, ctx.file, run);
}

function directive(m: Machine, ctx: LoadCtx, g: Term): void {
  const d = deref(g);
  const name = d instanceof Struct ? d.name : typeof d === "string" ? d : "";
  const arity = d instanceof Struct ? d.args.length : 0;
  const a = d instanceof Struct ? d.args : [];
  // Conditional compilation (:- if(G). ... :- elif(G). ... :- else. ... :- endif.) nests and runs first.
  // am[implements a-petta-errors-fix-1108.stack.cells]
  if (name === "if" && arity === 1) {
    const on = loading(ctx) && !ctx.inTests && m.solveProgram(a[0]!);
    ctx.conds.push({ active: on, taken: on });
    return;
  }
  if (name === "elif" && arity === 1) {
    const top = ctx.conds[ctx.conds.length - 1];
    if (top === undefined) return;
    const outer = ctx.conds.slice(0, -1).every((c) => c.active);
    top.active = outer && !top.taken && m.solveProgram(a[0]!);
    top.taken ||= top.active;
    return;
  }
  if (name === "else" && arity === 0) {
    const top = ctx.conds[ctx.conds.length - 1];
    if (top === undefined) return;
    top.active = !top.taken;
    top.taken = true;
    return;
  }
  if (name === "endif" && arity === 0) {
    ctx.conds.pop();
    return;
  }
  if (!loading(ctx)) return;
  if (name === "begin_tests" && (arity === 1 || arity === 2)) {
    ctx.inTests = true;
    return;
  }
  if (name === "end_tests" && arity === 1) {
    ctx.inTests = false;
    return;
  }
  if (ctx.inTests) return;
  switch (`${name}/${arity}`) {
    case "dynamic/1":
    case "multifile/1":
    case "thread_local/1":
    case "discontiguous/1":
    case "volatile/1":
    case "public/1":
      for (const pi of commaItems(a[0]!)) {
        const p = piOf(pi);
        if (p === null) continue;
        if (name === "dynamic" || name === "thread_local" || name === "volatile") m.db.ensure(p[0], p[1]).dynamic = true;
        if (name === "multifile") m.db.ensure(p[0], p[1]).multifile = true;
      }
      return;
    case "table/1":
      for (const pi of commaItems(a[0]!)) {
        const p = piOf(pi);
        if (p !== null) m.tabled.add(p[0] + "/" + p[1]);
      }
      return;
    case "module/2": {
      const mod = deref(a[0]!);
      if (typeof mod === "string") {
        ctx.module = mod;
        stateOf(m).modules.set(mod, { file: ctx.file, exports: a[1]! });
      }
      return;
    }
    case "use_module/1":
    case "use_module/2":
    case "ensure_loaded/1":
    case "reexport/1":
    case "reexport/2":
      if (isLibrary(a[0]!, "yall")) enableYallExpansion(m);
      loadSpecs(m, a[0]!, true);
      return;
    case "consult/1":
      loadSpecs(m, a[0]!, false);
      return;
    case "meta_predicate/1":
      declareMetaPredicates(m, a[0]!);
      return;
    case "autoload/1":
    case "autoload/2":
    case "license/1":
    case "noprofile/1":
    case "set_prolog_flag/2":
    case "create_prolog_flag/3":
      // Modules and autoloading are one namespace here; encoding is always UTF-8.
      return;
    case "initialization/1":
      ctx.inits.push(a[0]!);
      return;
    case "initialization/2": {
      const when = deref(a[1]!);
      if (when === "main") stateOf(m).mainGoal = a[0]!;
      else if (when === "now") runDirective(m, ctx, a[0]!);
      else ctx.inits.push(a[0]!);
      return;
    }
  }
  if (d instanceof Cons) {
    loadSpecs(m, d, false);
    return;
  }
  runDirective(m, ctx, expandDirectiveGoal(m, d, (aux) => addSourceClause(m, ctx, aux)));
}

/** Whether a load spec is library(Name). */
function isLibrary(spec: Term, name: string): boolean {
  const d = deref(spec);
  return d instanceof Struct && d.name === "library" && d.args.length === 1 && deref(d.args[0]!) === name;
}

/** A file spec as a path: an atom or string, or Dir/File written with the / operator. */
function specPath(t: Term): string | null {
  const d = deref(t);
  if (d instanceof Struct && d.name === "/" && d.args.length === 2) {
    const a = specPath(d.args[0]!);
    const b = specPath(d.args[1]!);
    return a !== null && b !== null ? a + "/" + b : null;
  }
  return textOf(d);
}

/** absolute_file_name/3 with file_type(prolog): Spec as given or with .pl, relative to the loading file. */
function resolveSource(m: Machine, spec: Term): string | null {
  const d = deref(spec);
  if (d instanceof Struct && d.name === "library" && d.args.length === 1) {
    const rel = specPath(d.args[0]!);
    if (rel === null) return null;
    const p = join(swiLibraryDir(), rel + ".pl");
    return existsSync(p) ? p : null;
  }
  const rel = specPath(d);
  if (rel === null) throw typeError("source_sink", d);
  const st = stateOf(m);
  const base = st.stack.length > 0 ? st.stack[st.stack.length - 1]!.directory : process.cwd();
  const p = isAbsolute(rel) ? rel : resolvePath(base, rel);
  const candidates = /\.[A-Za-z0-9]+$/.test(rel) ? [p, p + ".pl"] : [p + ".pl", p];
  for (const c of candidates) if (existsSync(c)) return c;
  throw existenceError("source_sink", d);
}

/** use_module, ensure_loaded or consult of one spec or a list; library(X) the machine provides itself is a no-op. */
function loadSpecs(m: Machine, spec: Term, once: boolean): void {
  const items = listToArray(deref(spec));
  for (const s of items ?? [spec]) {
    const p = resolveSource(m, s);
    if (p === null) continue;
    const st = stateOf(m);
    if (once && st.loaded.has(p)) continue;
    st.loaded.add(p);
    consultText(m, readFileSync(p, "utf8"), p);
  }
}

export function consultFile(m: Machine, path: string): void {
  loadSpecs(m, path, false);
}

/** Name/Arity to the vendored library file exporting it, read from each file's module declaration once. */
let autoloadIndexCache: Map<string, string> | null = null;
function autoloadIndex(): Map<string, string> {
  if (autoloadIndexCache !== null) return autoloadIndexCache;
  const index = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".pl")) {
        const first = deref(new PrologReader(readFileSync(p, "utf8")).readClause() ?? NIL);
        const decl = first instanceof Struct && first.name === ":-" && first.args.length === 1 ? deref(first.args[0]!) : null;
        if (!(decl instanceof Struct && decl.name === "module" && decl.args.length === 2)) continue;
        for (const x of listToArray(decl.args[1]!) ?? []) {
          const pi = piOf(x);
          if (pi !== null && !index.has(pi[0] + "/" + pi[1])) index.set(pi[0] + "/" + pi[1], p);
        }
      }
    }
  };
  walk(swiLibraryDir());
  return (autoloadIndexCache = index);
}

export function installConsult(m: Machine): void {
  m.autoload = (name, arity) => {
    const file = autoloadIndex().get(name + "/" + arity);
    if (file === undefined || stateOf(m).loaded.has(file)) return false;
    loadSpecs(m, file, true);
    return true;
  };
  const det = (name: string, arity: number, fn: (args: Term[]) => boolean): void => m.defBuiltin(name, arity, { det: (_m, a) => fn(a) });
  // consult/1 of one file throws when it is missing; of a list it reports each missing file and goes on.
  det("consult", 1, ([f]) => {
    const items = listToArray(f!);
    if (items === null) {
      loadSpecs(m, f!, false);
      return true;
    }
    for (const x of items) {
      try {
        loadSpecs(m, x, false);
      } catch (e) {
        if (!(e instanceof PrologError)) throw e;
        m.err(`ERROR: source_sink \`${specPath(x) ?? ""}' does not exist\n`);
      }
    }
    return true;
  });
  det("use_module", 1, ([f]) => (loadSpecs(m, f!, true), true));
  det("use_module", 2, ([f]) => (loadSpecs(m, f!, true), true));
  det("ensure_loaded", 1, ([f]) => (loadSpecs(m, f!, true), true));
  for (const n of ["dynamic", "multifile", "thread_local", "discontiguous", "table"]) {
    det(n, 1, ([spec]) => {
      const st = stateOf(m);
      const ctx = st.stack[st.stack.length - 1] ?? freshCtx("");
      directive(m, ctx, S(n, spec!));
      return true;
    });
  }
  det("initialization", 1, ([g]) => {
    const st = stateOf(m);
    const ctx = st.stack[st.stack.length - 1];
    if (ctx !== undefined) ctx.inits.push(g!);
    else m.pushGoal(g!);
    return true;
  });
  det("prolog_load_context", 2, ([key, val]) => {
    const st = stateOf(m);
    const ctx = st.stack[st.stack.length - 1];
    if (ctx === undefined) return false;
    const k = deref(key!);
    const table: Record<string, Term> = { module: ctx.module, source: ctx.file, file: ctx.file, directory: ctx.directory, dialect: "swi" };
    if (typeof k === "string") return k in table && m.unify(val!, table[k]!);
    throw instantiationError();
  });
  // source_file(?Head, ?File): the file whose consult defined Head's predicate.
  m.defBuiltin("source_file", 2, {
    nondet: function* (m2, [h, f]) {
      const head = unqualify(h!);
      if (!(head instanceof Var)) {
        const [name, arity] = typeof head === "string" ? [head, 0] : head instanceof Struct ? [head.name, head.args.length] : ["", -1];
        const p = m2.db.get(name, arity);
        if (p !== undefined && p.file !== null && m2.unify(f!, p.file)) yield;
        return;
      }
      const want = deref(f!);
      for (const p of [...m2.db.preds.values()]) {
        if (p.file === null || (typeof want === "string" && want !== p.file)) continue;
        const mark = m2.trailMark();
        const args: Term[] = [];
        for (let i = 0; i < p.arity; i++) args.push(mkVar());
        if (m2.unify(head, p.arity === 0 ? p.name : new Struct(p.name, args)) && m2.unify(f!, p.file)) yield;
        m2.undoTo(mark);
      }
    },
  });
  m.defBuiltin("source_file", 1, {
    nondet: function* (m2, [f]) {
      for (const file of [...stateOf(m2).files]) {
        const mark = m2.trailMark();
        if (m2.unify(f!, file)) yield;
        m2.undoTo(mark);
      }
    },
  });
  m.defBuiltin("source_file_property", 2, {
    nondet: function* (m2, [f, prop]) {
      const st = stateOf(m2);
      for (const file of [...st.files]) {
        const mod = [...st.modules].find(([, v]) => v.file === file)?.[0] ?? "user";
        for (const pr of [S("module", mod), S("load_context", "user", S(":", file, 0), NIL)]) {
          const mark = m2.trailMark();
          if (m2.unify(f!, file) && m2.unify(prop!, pr)) yield;
          m2.undoTo(mark);
        }
      }
    },
  });
  m.defBuiltin("current_module", 1, {
    nondet: function* (m2, [mod]) {
      for (const name of ["user", "system", ...stateOf(m2).modules.keys()]) {
        const mark = m2.trailMark();
        if (m2.unify(mod!, name)) yield;
        m2.undoTo(mark);
      }
    },
  });
  m.defBuiltin("module_property", 2, {
    nondet: function* (m2, [mod, prop]) {
      const st = stateOf(m2);
      const rows: [string, Term][] = [
        ["user", S("class", "user")],
        ["system", S("class", "system")],
      ];
      for (const [name, v] of st.modules) {
        const lib = v.file.startsWith(swiLibraryDir());
        rows.push([name, S("class", lib ? "library" : "user")], [name, S("file", v.file)], [name, S("exports", v.exports)]);
      }
      for (const [name, pr] of rows) {
        const mark = m2.trailMark();
        if (m2.unify(mod!, name) && m2.unify(prop!, pr)) yield;
        m2.undoTo(mark);
      }
    },
  });
  det("dcg_translate_rule", 2, ([rule, clause]) => m.unify(clause!, dcgTranslateRule(rule!)));
  det("expand_term", 2, ([t, x]) => {
    const d = deref(t!);
    return m.unify(x!, d instanceof Struct && d.name === "-->" && d.args.length === 2 ? dcgTranslateRule(d) : d);
  });
  m.defBuiltin("phrase", 2, {
    det: (m2, [g, l]) => {
      m2.pushGoal(dcgBody(g!, l!, NIL));
      return true;
    },
  });
  m.defBuiltin("phrase", 3, {
    det: (m2, [g, l, r]) => {
      m2.pushGoal(dcgBody(g!, l!, r!));
      return true;
    },
  });
  det("open_string", 2, ([s, stream]) => {
    const text = textOf(s!);
    if (text === null) throw instantiationError();
    return m.unify(stream!, S("$stream", m.registerObject(new InStream(text))));
  });
  det("load_files", 2, ([files, opts]) => {
    let fromStream = false;
    for (const o of listToArray(opts!) ?? []) {
      const d = deref(o);
      if (d instanceof Struct && d.name === "stream" && d.args.length === 1) {
        const st = m.objectOf(deref(d.args[0]!));
        if (st instanceof InStream) consultText(m, st.rest(), specPath(files!) ?? "");
        fromStream = true;
      }
    }
    if (!fromStream) loadSpecs(m, files!, false);
    return true;
  });
  det("atomics_to_string", 2, ([l, s]) => {
    const items = listToArray(l!);
    if (items === null) throw instantiationError();
    return m.unify(s!, new Str(items.map((x) => textOf(x) ?? "").join("")));
  });
  det("abolish_all_tables", 0, () => (m.tables.clear(), true));
  // M:Goal calls Goal: the machine has one module.
  m.defBuiltin(":", 2, {
    det: (m2, [_mod, g]) => {
      m2.pushGoal(g!);
      return true;
    },
  });
}
