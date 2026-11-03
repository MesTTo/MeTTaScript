// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: one PeTTa process: the machine with its builtins, the function registry (PeTTa's fun/1 and arity/2),
// spaces stored as per-arity facts, runtime function addition and removal, imports, and the two-pass file
// loader of src/filereader.pl that registers every function of a file before compiling any form and returns
// each runnable's results for main/0 to print after the whole load.
// am[implements a-pe-loader-cli]

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve as resolvePath, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalArith } from "./arith";
import { clauseRef, collectVars, installBuiltins, compareTerms, variant } from "./builtins";
import type { Clause } from "./db";
import { installLibrary } from "./library";
import { installConsult } from "./consult";
import { Machine, copyTerm } from "./machine";
import { METTA_RUNTIME_PL } from "./metta-runtime";
import { sread, topForms } from "./metta-reader";
import { readClauses } from "./prolog-reader";
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
  type Term,
} from "./terms";
import { Translator, conj } from "./translator";
import { TYPES_RUNTIME_PL, Types, fnTypeShape } from "./types";
import { BUILTIN_SIGNATURES_PL } from "./builtin-signatures";
import { swrite } from "./writer";

const S = mkStruct;

/** metta.pl's register_fun list: the builtins MeTTa code may call as functions. */
const BUILTIN_FUNS = [
  "superpose", "empty", "let", "let*", "+", "-", "*", "/", "%", "min", "max", "change-state!", "get-state", "bind!",
  "<", ">", "@<", "@>", "==", "!=", "=", "=?", "<=", ">=", "@<=", "@>=", "and", "or", "xor", "implies", "not", "sqrt", "exp", "log", "cos", "sin",
  "first-from-pair", "second-from-pair", "car-atom", "cdr-atom", "unique-atom", "alpha-unique-atom",
  "repr", "repra", "parse", "println!", "readln!", "test", "assert", "mm2-exec", "atom_concat", "atom_chars", "copy_term", "term_hash",
  "foldl", "first", "last", "append", "length", "size-atom", "sort", "msort", "member", "is-member", "is-alpha-member", "exclude-item", "list_to_set", "maplist", "eval", "reduce", "import!", "cached-import!",
  "add-atom", "remove-atom", "get-atoms", "match", "is-var", "is-ground", "is-expr", "is-space", "get-mettatype",
  "decons", "decons-atom", "py-call", "get-type", "get-metatype", "=alpha", "concat", "sread", "cons", "reverse",
  "#+", "#-", "#*", "#div", "#//", "#mod", "#min", "#max", "#<", "#>", "#=", "#\\=", "set_hook",
  "union-atom", "cons-atom", "intersection-atom", "subtraction-atom", "index-atom", "id",
  "pow-math", "sqrt-math", "sort-atom", "abs-math", "log-math", "trunc-math", "ceil-math",
  "floor-math", "round-math", "sin-math", "cos-math", "tan-math", "asin-math", "random-int", "random-float",
  "acos-math", "atan-math", "isnan-math", "isinf-math", "min-atom", "max-atom",
  "foldl-atom", "map-atom", "filter-atom", "current-time", "format-time", "library", "exists_file", "library-import!",
  "import_prolog_function", "Predicate", "callPredicate", "assertaPredicate", "assertzPredicate", "retractPredicate",
  "add-translator-rule!", "remove-translator-rule!", "argv",
];

export interface PettaOptions {
  readonly argv?: string[];
  readonly out?: (s: string) => void;
  readonly err?: (s: string) => void;
  readonly readLine?: () => string | null;
  readonly libDir?: string;
}

interface CompiledSource {
  readonly clause: Clause;
  readonly source: Term;
}

/** The directory holding PeTTa's lib/*.metta, shipped beside this package's dist. */
function defaultLibDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "..", "lib"), join(here, "..", "..", "lib")]) if (existsSync(c)) return c;
  return join(here, "..", "lib");
}

export class Petta {
  readonly m = new Machine();
  readonly translator = new Translator(this);
  readonly types = new Types(this);
  readonly specializer = { maybeSpecialize: (_f: string, _a: Term[], _o: Term): Term | null => null };
  readonly funs = new Set<string>();
  private readonly arities = new Map<string, number[]>();
  readonly translatorRules = new Set<string>();
  readonly symbolHeads = new Set<string>();
  private readonly funMeta = new Map<string, { args: Term[]; body: Term; headForm: string }[]>();
  private readonly compiled = new Map<string, CompiledSource[]>();
  private lambdaCounter = 0;
  private readonly workingDirs: string[] = [];
  private readonly importState = new Map<string, "loading" | "loaded">();
  private readonly activeLoads = new Set<string>();
  private readonly functionsStarted = new Set<string>();
  readonly libDir: string;
  readonly silent: boolean;
  readonly strict: boolean;

  constructor(opts: PettaOptions = {}) {
    const argv = opts.argv ?? [];
    this.silent = argv.some((a) => a === "silent" || a === "--silent" || a === "-s");
    this.strict = argv.includes("--strict") || argv.includes("--strict-det");
    this.libDir = opts.libDir ?? defaultLibDir();
    const m = this.m;
    if (opts.out) m.out = opts.out;
    if (opts.err) m.err = opts.err;
    if (opts.readLine) m.readLine = opts.readLine;
    m.flags.set("argv", mkList(argv));
    installBuiltins(m);
    installLibrary(m);
    installConsult(m);
    this.installRuntime();
    this.types.install(m);
    for (const c of readClauses(METTA_RUNTIME_PL)) m.addLibraryClause(c);
    for (const c of readClauses(TYPES_RUNTIME_PL)) m.addLibraryClause(c);
    // get-type is user-extensible (metta.pl declares it dynamic).
    for (const c of readClauses(String.raw`
'get-type'(X, T) :- ( var(T) -> ( get_type_candidate(X, T0) *-> T = T0 ; T = '%Undefined%' ) ; T == '%Undefined%' -> ( \+ get_type_candidate(X, _) -> true ; get_type_candidate(X, T) ) ; get_type_candidate(X, T) ).
`))
      m.addClause(c, true);
    m.db.ensure("space_primitive", 2).dynamic = true;
    m.db.ensure("translated_from", 2).dynamic = true;
    // src/ext_points.pl: hooks a consulted library (lib_memo) may extend.
    for (const c of readClauses("metta_on_function_changed(_).\nmetta_on_function_removed(_).")) m.addClause(c, true);
    m.db.ensure("metta_memoized_dispatch_call", 4).dynamic = true;
    for (const f of BUILTIN_FUNS) this.registerFun(f);
    // seed_builtin_types: every builtin signature is a declaration from the start.
    for (const c of readClauses(BUILTIN_SIGNATURES_PL)) m.addLibraryClause(c);
    for (const d of this.builtinTypeDeclarations()) this.types.cacheDecl(d[1]!, d[2]!);
  }

  // ---- registry ----

  isFun(f: string): boolean {
    return this.funs.has(f);
  }

  /** register_fun/1: mark callable and record every existing arity, ascending, except operators' arities up to 2. */
  registerFun(f: string): void {
    if (this.funs.has(f)) return;
    this.funs.add(f);
    const ars = this.predArities(f).filter((a) => !(this.isOperatorName(f) && a <= 2)).sort((a, b) => a - b);
    for (const a of ars) this.noteArity(f, a);
  }

  unregisterFun(f: string): void {
    this.funs.delete(f);
  }

  private predArities(f: string): number[] {
    const out = new Set<number>();
    const prefix = f + "/";
    for (const k of this.m.builtins.keys()) if (k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length))) out.add(Number(k.slice(prefix.length)));
    for (const k of this.m.libraryPreds) if (k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length))) out.add(Number(k.slice(prefix.length)));
    for (const p of this.m.db.preds.values()) if (p.name === f && (p.live > 0 || p.dynamic)) out.add(p.arity);
    return [...out];
  }

  noteArity(f: string, a: number): void {
    const l = this.arities.get(f);
    if (l === undefined) this.arities.set(f, [a]);
    else if (!l.includes(a)) l.push(a);
  }

  hasArity(f: string, a: number): boolean {
    return this.arities.get(f)?.includes(a) ?? false;
  }

  firstArity(f: string): number | undefined {
    return this.arities.get(f)?.[0];
  }

  aritiesOf(f: string): number[] {
    return this.arities.get(f) ?? [];
  }

  /** current_predicate(F/A): a builtin, a library predicate, or a predicate with clauses or declared dynamic. */
  hasPredicate(f: string, a: number): boolean {
    const key = f + "/" + a;
    if (this.m.builtins.has(key) || this.m.libraryPreds.has(key)) return true;
    const p = this.m.db.get(f, a);
    return p !== undefined && (p.live > 0 || p.dynamic);
  }

  isOperatorName(f: string): boolean {
    const ops = this.m.ops;
    return ops.infix.has(f) || ops.prefix.has(f) || ops.postfix.has(f);
  }

  /** incomplete_application_kind/3. */
  incompleteApplicationKind(f: string, a: number): "partial" | "overapplied" {
    const ars = this.arities.get(f);
    if (ars === undefined || ars.length === 0 || ars.some((k) => k >= a)) return "partial";
    return "overapplied";
  }

  /** builtin_untouched/1: the builtin's 3-argument definition still has its single library clause. */
  builtinUntouched(f: string): boolean {
    const p = this.m.db.get(f, 3);
    return p !== undefined && p.live === 1 && this.m.libraryPreds.has(f + "/3");
  }

  /** resolve_memoization/4: a memoizing library's dispatch hook may replace the direct call. */
  memoizedCall(f: string, avs: Term[], out: Term): Term | null {
    if ((this.m.db.get("metta_memoized_dispatch_call", 4)?.live ?? 0) === 0) return null;
    const goal = mkVar();
    if (this.m.solveOnce(S("metta_memoized_dispatch_call", f, mkList(avs), out, goal))) return deref(goal);
    return null;
  }

  private functionChanged(f: string): void {
    this.m.solveOnce(S("metta_on_function_changed", f));
  }

  commitCall(_f: string, _avs: Term[], goal: Term): Term {
    return goal;
  }

  clauseCommitCut(_f: string, _n: number): boolean {
    return false;
  }

  addFunMeta(f: string, args: Term[], body: Term, headForm: string): void {
    const l = this.funMeta.get(f) ?? [];
    l.unshift({ args, body, headForm });
    this.funMeta.set(f, l);
  }

  nextLambdaName(): string {
    for (;;) {
      this.lambdaCounter++;
      const name = `lambda_${this.lambdaCounter}`;
      if (!this.funs.has(name) && this.predArities(name).length === 0) return name;
    }
  }

  evalArith(t: Term): Term {
    return evalArith(t);
  }

  swrite(t: Term): string {
    return swrite(t);
  }

  // ---- compiling ----

  /** Translate a (= Head Body) source term, assert the clause and remember its source for remove-atom. */
  compileAndAssert(source: Term, _label: string): Clause {
    const clauseT = this.translator.clause(source, true);
    const c = this.m.addClause(clauseT, true);
    const items = listToArray(deref(source))!;
    const f = deref(listToArray(deref(items[1]!))![0]!) as string;
    const l = this.compiled.get(f) ?? [];
    l.push({ clause: c, source: copyTerm(source) });
    this.compiled.set(f, l);
    this.m.addClause(S("translated_from", clauseRef(c), copyTerm(source)), true);
    this.functionChanged(f);
    return c;
  }

  // ---- spaces ----

  /** add_sexp/2. */
  addSexp(space: string, term: Term): void {
    const t = deref(term);
    if (t instanceof Var) throw instantiationError();
    const items = listToArray(t);
    if (items !== null && items.length > 0) {
      this.m.addClause(new Struct(space, items), true);
      if (space === "&self" && items.length === 3 && deref(items[0]!) === ":") this.types.cacheDecl(items[1]!, items[2]!);
    } else {
      this.m.addClause(S("space_primitive", space, t), true);
    }
  }

  /** remove_sexp/2: retract every row unifying with the term. */
  removeSexp(space: string, term: Term): void {
    const t = deref(term);
    if (t instanceof Var) throw instantiationError();
    const items = listToArray(t);
    if (items !== null && items.length > 0) {
      this.retractAll(new Struct(space, items));
      if (space === "&self" && items.length === 3 && deref(items[0]!) === ":") this.types.uncacheDecl(items[1]!, items[2]!);
    } else this.retractAll(S("space_primitive", space, t));
  }

  private retractAll(head: Struct): void {
    const m = this.m;
    for (const cl of m.visibleClauses(head.name, head.args.length)) {
      const mark = m.trailMark();
      const [h] = m.clauseTerms(cl);
      if (m.unify(head, h)) m.db.retractClause(cl);
      m.undoTo(mark);
    }
  }

  /** 'add-atom'/3. */
  addAtom(space: string, term: Term): void {
    const t = deref(term);
    if (t instanceof Var) throw instantiationError();
    const items = listToArray(t);
    if (items !== null && items.length === 3 && deref(items[0]!) === "=") {
      const head = listToArray(deref(items[1]!));
      const f = head !== null && head.length > 0 ? deref(head[0]!) : null;
      if (typeof f === "string") {
        this.addSexp(space, t);
        this.registerFun(f);
        this.noteArity(f, head!.length);
        this.compileAndAssert(t, "added function");
        return;
      }
    }
    this.addSexp(space, t);
  }

  /** 'remove-atom'/3: returns whether a compiled function clause was removed (true for plain atoms). */
  removeAtom(space: string, term: Term): boolean {
    const t = deref(term);
    const items = listToArray(t);
    if (items !== null && items.length === 3 && deref(items[0]!) === "=") {
      const head = listToArray(deref(items[1]!));
      const f = head !== null && head.length > 0 ? deref(head[0]!) : null;
      if (f instanceof Var) throw instantiationError();
      if (typeof f === "string") {
        this.removeSexp(space, t);
        const meta = this.funMeta.get(f);
        if (meta !== undefined) {
          const i = meta.findIndex((x) => variant(mkList(x.args), mkList(head!.slice(1))) && variant(x.body, items[2]!));
          if (i >= 0) meta.splice(i, 1);
        }
        const srcs = this.compiled.get(f) ?? [];
        const removed: CompiledSource[] = [];
        for (const s of srcs) {
          const mark = this.m.trailMark();
          if (this.m.unify(s.source, t)) removed.push(s);
          this.m.undoTo(mark);
        }
        for (const s of removed) {
          this.m.db.retractClause(s.clause);
          this.m.solveOnce(S("retractall", S("translated_from", clauseRef(s.clause), mkVar())));
        }
        this.compiled.set(
          f,
          srcs.filter((s) => !removed.includes(s)),
        );
        this.functionChanged(f);
        if (!this.aritiesOf(f).some((a) => (this.m.db.get(f, a)?.live ?? 0) > 0) && !this.m.libraryPreds.has(f + "/" + (head!.length))) {
          this.unregisterFun(f);
          this.m.solveOnce(S("metta_on_function_removed", f));
        }
        return removed.length > 0;
      }
    }
    this.removeSexp(space, t);
    return true;
  }

  // ---- imports and loading ----

  private workingDir(): string {
    return this.workingDirs[this.workingDirs.length - 1] ?? process.cwd();
  }

  pushWorkingDir(dir: string): void {
    this.workingDirs.push(dir);
  }

  /** importer_helper/2. */
  importFile(space: string, file: Term): void {
    const f = textOfTerm(file);
    if (f.endsWith(".py")) throw new PrologError(S("error", S("existence_error", "python_module", new Str(f)), S("context", "import!", new Str(f))));
    const requested = extname(f) === ".metta" ? f : f + ".metta";
    const canon = isAbsolute(requested) ? requested : resolvePath(this.workingDir(), requested);
    if (!existsSync(canon) || !statSync(canon).isFile())
      throw new PrologError(S("error", S("existence_error", "source_sink", file), S("context", "import!", file)));
    const key = space + "\u0000" + canon;
    if (this.importState.has(key) || this.activeLoads.has(key)) return;
    this.importState.set(key, "loading");
    try {
      this.loadFile(canon, space);
      this.importState.set(key, "loaded");
    } catch (e) {
      this.importState.delete(key);
      throw e;
    }
  }

  /** library/2 then importer_helper/2. */
  libraryImport(space: string, name: Term): void {
    const n = textOfTerm(name);
    const cand = join(this.libDir, n);
    this.importFile(space, cand);
  }

  /** load_metta_file/3: returns the file's runnable results in order. */
  loadFile(path: string, space = "&self"): Term[] {
    const canon = resolvePath(path);
    const key = space + "\u0000" + canon;
    this.activeLoads.add(key);
    const mode = this.functionsStarted.has(canon) ? "space_only" : "compile_functions";
    this.functionsStarted.add(canon);
    this.workingDirs.push(dirname(canon));
    try {
      return this.processString(readFileSync(canon, "utf8"), space, mode);
    } finally {
      this.workingDirs.pop();
      this.activeLoads.delete(key);
    }
  }

  /** process_metta_string/4: parse every form, register functions, then process forms in order. */
  processString(text: string, space = "&self", mode: "compile_functions" | "space_only" = "compile_functions"): Term[] {
    const forms = topForms(text);
    const parsed = forms.map((f) => {
      const term = sread(f.text);
      if (f.kind === "runnable") return { kind: "runnable" as const, term, form: f };
      const items = listToArray(term);
      if (items !== null && items.length === 3 && deref(items[0]!) === "=") {
        const head = listToArray(deref(items[1]!));
        const fn = head !== null && head.length > 0 ? deref(head[0]!) : null;
        if (typeof fn === "string") {
          this.registerFunctionSignature(fn, head!.length);
          return { kind: "function" as const, term, form: f };
        }
      }
      return { kind: "expression" as const, term, form: f };
    });
    // declaration prepass: every function type declaration in the file is visible to every definition
    for (const p of parsed) {
      if (p.kind !== "expression") continue;
      const items = listToArray(p.term);
      if (items !== null && items.length === 3 && deref(items[0]!) === ":" && space === "&self" && fnTypeShape(items[2]!) !== null)
        this.types.cacheDecl(items[1]!, items[2]!);
    }
    const results: Term[] = [];
    for (const p of parsed) {
      if (p.kind === "expression") this.addAtom(space, p.term);
      else if (p.kind === "function") {
        this.addSexp(space, p.term);
        if (mode === "compile_functions") this.compileAndAssert(p.term, "function");
      } else {
        const [goals, out] = this.translator.expr(mkList(["collapse", p.term]));
        if (!this.m.solveOnce(conj(goals))) continue;
        const r = listToArray(out);
        if (r !== null) results.push(...r);
      }
    }
    return results;
  }

  /** register_function_signature/2. */
  private registerFunctionSignature(f: string, arity: number): void {
    if (!this.funs.has(f) && this.symbolHeads.has(f))
      this.m.err(
        `Warning: ${f} is defined or imported after already being used; earlier expressions treat it as a plain symbol. Move the import or definition above the first use.\n`,
      );
    this.registerFun(f);
    this.noteArity(f, arity);
  }

  // ---- native runtime predicates ----

  private installRuntime(): void {
    const m = this.m;
    const self = this;
    const det = (name: string, arity: number, fn: (args: Term[]) => boolean): void => m.defBuiltin(name, arity, { det: (_m, a) => fn(a) });
    det("swrite", 2, ([t, s]) => m.unify(s!, new Str(swrite(t!))));
    det("sread", 2, ([s, t]) => m.unify(t!, sread(textOfTerm(s!))));
    m.defBuiltin("fun", 1, {
      nondet: function* (m2, [f]) {
        const d = deref(f!);
        if (typeof d === "string") {
          if (self.funs.has(d)) yield;
          return;
        }
        if (!(d instanceof Var)) return;
        for (const name of [...self.funs]) {
          const mark = m2.trailMark();
          if (m2.unify(d, name)) yield;
          m2.undoTo(mark);
        }
      },
    });
    m.defBuiltin("arity", 2, {
      nondet: function* (m2, [f, a]) {
        const d = deref(f!);
        const names = typeof d === "string" ? [d] : [...self.arities.keys()];
        for (const name of names)
          for (const ar of [...(self.arities.get(name) ?? [])]) {
            const mark = m2.trailMark();
            if (m2.unify(f!, name) && m2.unify(a!, ar)) yield;
            m2.undoTo(mark);
          }
      },
    });
    det("register_fun", 1, ([f]) => (this.registerFun(textOfTerm(f!)), true));
    det("import_prolog_function", 2, ([n, out]) => (this.registerFun(textOfTerm(n!)), m.unify(out!, "true")));
    // reduce/2: call a registered function, extend a partial, or leave the expression as data.
    m.defBuiltin("reduce", 2, {
      det: (m2, [e, out]) => {
        const items = listToArray(e!);
        if (items === null || items.length === 0) throw instantiationError();
        const f = deref(items[0]!);
        const args = items.slice(1);
        if (typeof f === "string" && this.funs.has(f)) {
          const ar = args.length + 1;
          if (this.hasPredicate(f, ar) && !(this.isOperatorName(f) && ar <= 2)) {
            const goal = this.memoizedCall(f, args, out!) ?? new Struct(f, [...args, out!]);
            m2.pushGoal(S("catch", S("call", goal), mkVar(), "fail"));
            return true;
          }
          if (this.incompleteApplicationKind(f, ar) === "partial") return m2.unify(out!, S("partial", f, mkList(args)));
          throw this.overapplication(f, args.length);
        }
        if (f instanceof Struct && f.name === "partial" && f.args.length === 2) {
          const bound = listToArray(f.args[1]!) ?? [];
          m2.pushGoal(S("reduce", mkList([f.args[0]!, ...bound, ...args]), out!));
          return true;
        }
        return m2.unify(out!, e!);
      },
    });
    det("throw_function_overapplication", 2, ([f, n]) => {
      throw this.overapplication(textOfTerm(f!), deref(n!) as number);
    });
    m.defBuiltin("eval", 2, {
      det: (m2, [c, out]) => {
        const [goals, o] = this.translator.expr(c!);
        if (!m2.unify(out!, o)) return false;
        m2.pushGoal(S("call_goals", mkList(goals)));
        return true;
      },
    });
    det("add-atom", 3, ([s, t, out]) => (this.addAtom(textOfTerm(s!), t!), m.unify(out!, "true")));
    det("remove-atom", 3, ([s, t, out]) => m.unify(out!, this.removeAtom(textOfTerm(s!), t!) ? "true" : "false"));
    det("add_sexp", 2, ([s, t]) => (this.addSexp(textOfTerm(s!), t!), true));
    det("remove_sexp", 2, ([s, t]) => (this.removeSexp(textOfTerm(s!), t!), true));
    det("$space_arities", 2, ([s, out]) => {
      const name = textOfTerm(s!);
      const ars = [...m.db.preds.values()].filter((p) => p.name === name && p.live > 0).map((p) => p.arity).sort((a, b) => a - b);
      return m.unify(out!, mkList(ars));
    });
    det("import!", 3, ([s, f, out]) => (this.importFile(textOfTerm(s!), f!), m.unify(out!, "true")));
    det("library-import!", 3, ([s, n, out]) => (this.libraryImport(textOfTerm(s!), n!), m.unify(out!, "true")));
    det("cached-import!", 3, ([s, f, out]) => (this.importFile(textOfTerm(s!), f!), m.unify(out!, "true")));
    det("add-translator-rule!", 2, ([h, out]) => (this.translatorRules.add(textOfTerm(h!)), m.unify(out!, "true")));
    det("remove-translator-rule!", 2, ([h, out]) => (this.translatorRules.delete(textOfTerm(h!)), m.unify(out!, "true")));
    det("$alpha_list_to_set", 2, ([l, out]) => {
      const items = listToArray(l!) ?? [];
      const kept: Term[] = [];
      for (const it of items) if (!kept.some((k) => variant(k, it))) kept.push(it);
      return m.unify(out!, mkList(kept));
    });
    det("library", 2, ([n, out]) => m.unify(out!, join(this.libDir, textOfTerm(n!))));
    det("process_metta_string", 2, ([str, out]) => m.unify(out!, mkList(this.processString(textOfTerm(str!))))); 
    det("add_builtin_signatures", 2, ([sp, out]) => {
      for (const d of this.builtinTypeDeclarations()) this.addAtom(textOfTerm(sp!), mkList(d));
      return m.unify(out!, "true");
    });
    void compareTerms;
    void collectVars;
    void Cons;
    void NIL;
    void existenceError;
  }

  /** builtin_type_declaration/1: (: F (Arrow ArgTypes... Out)) for each builtin signature. */
  builtinTypeDeclarations(): Term[][] {
    const out: Term[][] = [];
    const [f, n, det, ats, ot] = [mkVar(), mkVar(), mkVar(), mkVar(), mkVar()];
    const arrows: Record<string, string> = { unspecified: "->", det: "-[det]->", semidet: "-[semidet]->", nondet: "-[nondet]->" };
    this.m.solveAll(S("builtin_signature", f, n, det, ats, ot), () => {
      const arrow = arrows[deref(det) as string] ?? "->";
      const types = listToArray(ats) ?? [];
      out.push([":", deref(f), copyTerm(mkList([arrow, ...types, ot]))]);
    });
    return out;
  }

  overapplication(f: string, n: number): PrologError {
    const ars = [...new Set(this.aritiesOf(f).map((a) => a - 1))].sort((a, b) => a - b);
    return new PrologError(S("error", S("domain_error", S("function_input_arities", f, mkList(ars)), n), "none"));
  }

  // ---- main ----

  /** main/0 for the given .metta files: load each, then print every result with swrite. */
  runMain(files: string[]): void {
    if (files.length === 0) return;
    this.workingDirs.push(dirname(resolvePath(files[0]!)));
    const all: Term[] = [];
    for (const f of files) all.push(...this.loadFile(f));
    const lines = all.map((r) => swrite(r)).join("\n");
    if (all.length > 0) this.m.out(lines + "\n");
  }
}

export function textOfTerm(t: Term): string {
  const d = deref(t);
  if (typeof d === "string") return d;
  if (d instanceof Str) return d.s;
  if (d instanceof Var) throw instantiationError();
  if (typeof d === "number" || typeof d === "bigint") return String(d);
  throw new PrologError(S("error", S("type_error", "text", d), mkVar()));
}
