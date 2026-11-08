// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the hosted engine's state after consulting PeTTa's vendored source, saved as an image file at build
// time and loaded into a fresh machine in place of consulting on every run (a-petta-speed-1105.startup.image), as
// SWI-Prolog's saved states do. The image holds the clause database, flags, global variables, operators, tables,
// the loader's files and modules and the goal-expansion state; builtins are code, so a loading machine installs them
// and the image only says which of them consulting removed. Paths under the package directory are stored relative
// to it. The image applies only while every file it was consulted from is byte-identical and the engine bundle is
// the one that built it; the directives that read argv at load time are run again with the run's own argv. Each
// predicate's clauses are kept as their own JSON text and decoded the first time the database reads them.
// am[implements a-petta-speed-1105.startup.image]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Clause, Database, Ground, Slot, type Pred } from "./db";
import { expansionSnapshot, restoreExpansion } from "./goal-expansion";
import { loaderSnapshot, restoreLoader, runFileDirective, type LoaderSnapshot } from "./consult";
import type { Machine } from "./machine";
import { Cons, Float, NIL, Str, Struct, Var, deref, mkVar, type Term } from "./terms";

type J = unknown;

/** The image file format; a reader of another format consults instead. */
const FORMAT = 2;

/**
 * Encodes terms for the image: atoms as strings, other kinds tagged, variables numbered across the whole image. An
 * encoder for clauses (`clauses` true) refuses a variable, since each predicate's clauses decode alone. A clause
 * reference is refused unless `ref` encodes it (an import snapshot keeps it as its clause's place, import-snapshot.ts),
 * and an attributed variable unless `attrs` is set, when its attributes go with its number.
 * am[rests-on c-image-clauses-alone-1108]
 */
export class Encoder {
  private readonly vars = new Map<Var, number>();
  constructor(
    private readonly root: string,
    private readonly clauses = false,
    private readonly ref: ((t: Struct) => J) | null = null,
    private readonly attrs = false,
  ) {}

  text(s: string): J {
    return s.startsWith(this.root + "/") ? { p: s.slice(this.root.length + 1) } : s;
  }

  term(t: Term | Slot | Ground): J {
    if (typeof t === "string") return this.text(t);
    if (typeof t === "number") return Object.is(t, -0) ? { z: 1 } : t;
    if (typeof t === "bigint") return { i: t.toString() };
    if (t instanceof Slot) return { v: t.i };
    if (t instanceof Ground) return { g: this.term(t.t) };
    if (t instanceof Float) return { f: Object.is(t.v, -0) ? "-0" : String(t.v) };
    if (t instanceof Str) return t.s.startsWith(this.root + "/") ? { sp: t.s.slice(this.root.length + 1) } : { s: t.s };
    if (t === NIL) return { n: 1 };
    if (t instanceof Var) {
      if (t.ref !== null) return this.term(t.ref);
      const attributed = t.attrs !== null && t.attrs.size > 0;
      if (attributed && !this.attrs) throw new Error("image: an attributed variable cannot be saved");
      if (this.clauses) throw new Error("image: a stored clause holds a variable outside its slots");
      let n = this.vars.get(t);
      if (n !== undefined) return { x: n };
      this.vars.set(t, (n = this.vars.size));
      // Numbered before its attributes, which may name it again.
      return attributed ? { x: n, at: [...t.attrs!].map(([k, v]) => [k, this.term(v)]) } : { x: n };
    }
    if (t instanceof Cons) {
      const items: J[] = [];
      let c: Term = t;
      while (c instanceof Cons) {
        items.push(this.term(c.head));
        c = c.tail instanceof Var && c.tail.ref !== null ? c.tail.ref : c.tail;
      }
      return { l: items, t: this.term(c) };
    }
    if (t instanceof Struct) {
      if (t.name === "$cref" && this.ref !== null) return { r: this.ref(t) };
      if (t.name === "$cref" || t.name === "$stream") throw new Error(`image: a ${t.name} reference cannot be saved`);
      return [t.name, ...t.args.map((a) => this.term(a))];
    }
    throw new Error("image: unknown term kind");
  }
}

export class Decoder {
  private readonly vars = new Map<number, Var>();
  constructor(
    private readonly root: string,
    private readonly ref: ((j: J) => Term) | null = null,
  ) {}

  term(j: J): Term {
    if (typeof j === "string") return j;
    if (typeof j === "number") return j;
    if (Array.isArray(j)) {
      const args = new Array<Term>(j.length - 1);
      for (let i = 1; i < j.length; i++) args[i - 1] = this.term(j[i]);
      return new Struct(j[0] as string, args);
    }
    const o = j as Record<string, J>;
    if ("p" in o) return this.root + "/" + (o.p as string);
    if ("v" in o) return new Slot(o.v as number) as unknown as Term;
    if ("g" in o) return new Ground(this.term(o.g)) as unknown as Term;
    if ("l" in o) {
      const items = o.l as J[];
      let out = this.term(o.t);
      for (let i = items.length - 1; i >= 0; i--) out = new Cons(this.term(items[i]), out);
      return out;
    }
    if ("n" in o) return NIL;
    if ("x" in o) {
      const n = o.x as number;
      let v = this.vars.get(n);
      if (v === undefined) this.vars.set(n, (v = mkVar()));
      if ("at" in o) v.attrs = new Map((o.at as [string, J][]).map(([k, a]) => [k, this.term(a)]));
      return v;
    }
    if ("i" in o) return BigInt(o.i as string);
    if ("f" in o) return new Float(o.f === "-0" ? -0 : Number(o.f));
    if ("s" in o) return new Str(o.s as string);
    if ("sp" in o) return new Str(this.root + "/" + (o.sp as string));
    if ("z" in o) return -0;
    if ("r" in o && this.ref !== null) return this.ref(o.r);
    throw new Error("image: unknown term encoding");
  }
}

/** A directive that read argv while loading, run again at load with the run's argv after the argv predicates are cleared. */
export interface ArgvDirective {
  readonly file: string;
  readonly goal: Term;
}

/**
 * How the consulted state depends on argv: `directives` read argv and are the only source of `preds`' clauses, so
 * they run again at load over emptied `preds`; `branchAtoms` are the atoms argv-reading directives test whose
 * consult changed more than `preds` (or could not finish), so a run whose argv holds one of them consults instead.
 * am[implements a-petta-speed-1105.startup.image-modes]
 */
export interface ArgvDependence {
  readonly directives: ArgvDirective[];
  readonly preds: string[];
  readonly branchAtoms: string[];
}

/** Every atom term `t` holds as an argument, at any depth, into `out`: the atoms a directive can test argv for. */
export function atomsOf(t: Term, out: Set<string>): void {
  const d = deref(t);
  if (typeof d === "string") out.add(d);
  else if (d instanceof Struct) for (const a of d.args) atomsOf(a, out);
  else if (d instanceof Cons) {
    atomsOf(d.head, out);
    atomsOf(d.tail, out);
  }
}

/** Image `data`'s argv dependence, its directives' files and goals decoded. */
export function argvDependence(data: Record<string, J>, root: string): ArgvDependence {
  const dec = new Decoder(root);
  const av = data.argv as { directives: [J, J][]; preds: string[]; branchAtoms: string[] };
  return {
    directives: av.directives.map(([file, goal]) => ({ file: dec.term(file) as string, goal: dec.term(goal) })),
    preds: av.preds,
    branchAtoms: av.branchAtoms,
  };
}

/** Run argv-reading `directives` on `m` under the argv flag it holds, the clauses of `preds` retracted first. */
export function runArgvDirectives(m: Machine, preds: readonly string[], directives: readonly ArgvDirective[]): void {
  for (const key of preds) {
    const i = key.lastIndexOf("/");
    const p = m.db.get(key.slice(0, i), Number(key.slice(i + 1)));
    if (p !== undefined) for (const c of [...p.clauses]) m.db.retractClause(c);
  }
  for (const d of directives) runFileDirective(m, d.file, d.goal);
}

/** SHA-1 of a file's bytes. */
export function fileHash(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/** SHA-1 over the engine bundle: every .js file in `dir`, in name order. Time: the bundle's size. */
export function engineHash(dir: string): string {
  const h = createHash("sha1");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js")).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest("hex");
}

/**
 * The image of `m` after consulting: `root` is the package directory paths are kept relative to, `engine` the
 * bundle's hash, `builtins` the builtin keys a fresh machine installs, `argv` the directives that read argv and the
 * predicates whose clauses depend on it. Throws when the state holds anything an image cannot restore.
 */
export function imageData(m: Machine, root: string, engine: string, builtins: string[], argv: ArgvDependence): Record<string, J> {
  const enc = new Encoder(root);
  const cenc = new Encoder(root, true);
  if (m.objectCount() > 0) throw new Error("image: consulting left host objects (streams) open");
  const loader = loaderSnapshot(m);
  const preds: J[] = [];
  for (const p of m.db.preds.values()) {
    const clauses: J[] = [];
    for (const c of p.clauses) {
      if (c.died !== Infinity) continue;
      clauses.push([cenc.term(c.head), cenc.term(c.body), c.nvars, c.file === null ? null : cenc.text(c.file), c.born, c.seq]);
    }
    // am[implements a-petta-next-1108.startup.cut.lazyimage]
    preds.push([p.name, p.arity, +p.dynamic | (+p.multifile << 1), p.file === null ? null : enc.text(p.file), clauses.length, JSON.stringify(clauses)]);
  }
  const removed = builtins.filter((k) => !m.builtins.has(k));
  const added = [...m.builtins.keys()].filter((k) => !builtins.includes(k));
  if (added.length > 0) throw new Error(`image: consulting defined builtins ${added.join(", ")}`);
  const ops: J[] = [];
  for (const [kind, map] of [["infix", m.ops.infix], ["prefix", m.ops.prefix], ["postfix", m.ops.postfix]] as const)
    for (const [name, d] of map) ops.push([kind, name, d.pri, d.type]);
  const pairs = (map: Map<string, Term>): J => [...map].map(([k, v]) => [k, enc.term(v)]);
  const data = {
    format: FORMAT,
    engine,
    files: loader.files.map((f) => [relative(root, f), fileHash(f)]),
    argv: { directives: argv.directives.map((d) => [enc.text(d.file), enc.term(d.goal)]), preds: argv.preds, branchAtoms: argv.branchAtoms },
    db: { generation: m.db.generation, seq: m.db.seqCounter, preds },
    flags: pairs(m.flags),
    globals: pairs(m.globals),
    flagValues: pairs(m.flagValues),
    ops,
    libraryPreds: [...m.libraryPreds],
    tabled: [...m.tabled],
    tables: [...m.tables].map(([k, v]) => [k, v.map((t) => enc.term(t))]),
    removedBuiltins: removed,
    loader: {
      loaded: loader.loaded.map((f) => enc.text(f)),
      files: loader.files.map((f) => enc.text(f)),
      modules: loader.modules.map(([k, f, e]) => [k, enc.text(f), enc.term(e)]),
      mainGoal: loader.mainGoal === null ? null : enc.term(loader.mainGoal),
    },
    expansion: expansionSnapshot(m),
  };
  return data;
}

/**
 * A parsed image, checked against the files it was consulted from, the running engine bundle and the run's argv;
 * null when it does not apply.
 */
export function readImage(path: string, root: string, engine: string, argv: string[]): Record<string, J> | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, J>;
  if (data.format !== FORMAT || data.engine !== engine) return null;
  const branch = new Set((data.argv as { branchAtoms: string[] }).branchAtoms);
  if (argv.some((a) => branch.has(a))) return null;
  for (const [rel, hash] of data.files as [string, string][]) {
    const f = join(root, rel);
    if (!existsSync(f) || fileHash(f) !== hash) return null;
  }
  return data;
}

/**
 * Predicate `p`'s clauses from their JSON text in an image. Time: linear in the text.
 * am[implements a-petta-next-1108.startup.cut.lazyimage]
 * am[rests-on c-image-clauses-alone-1108]
 */
function decodeClauses(p: Pred, json: string, root: string): Clause[] {
  const dec = new Decoder(root);
  const out: Clause[] = [];
  for (const [h, b, nvars, cfile, born, seq] of JSON.parse(json) as [J, J, number, J, number, number][]) {
    const c = new Clause(p, dec.term(h), dec.term(b), nvars, born, seq);
    c.file = cfile === null ? null : (dec.term(cfile) as string);
    out.push(c);
  }
  return out;
}

/**
 * Load an image into `m`, whose builtins and library are installed and which has consulted nothing: the database,
 * flags (argv set after), globals, operators, tables and loader and expansion states become the image's; then the
 * directives that read argv run again, their predicates cleared first, with the argv flag `m` already has. Each
 * predicate's clauses stay JSON text until the database first reads them (Pred.store).
 * Time: linear in the image's predicates and its non-clause state, plus the clauses the directives read.
 */
export function loadImage(m: Machine, data: Record<string, J>, root: string): void {
  const dec = new Decoder(root);
  const text = (j: J): string => dec.term(j) as string;
  const argv = m.flags.get("argv")!;
  const db = new Database();
  const d = data.db as { generation: number; seq: number; preds: J[][] };
  for (const [name, arity, bits, file, count, json] of d.preds as [string, number, number, J, number, string][]) {
    const p = db.ensure(name, arity);
    p.dynamic = (bits & 1) !== 0;
    p.multifile = (bits & 2) !== 0;
    p.file = file === null ? null : text(file);
    // am[implements a-petta-next-1108.startup.cut.lazyimage]
    if (count > 0) p.store({ count, decode: (q) => decodeClauses(q, json, root) });
  }
  db.restoreCounters(d.generation, d.seq);
  m.replaceDatabase(db);
  const fill = (map: Map<string, Term>, pairs: J): void => {
    map.clear();
    for (const [k, v] of pairs as [string, J][]) map.set(k, dec.term(v));
  };
  fill(m.flags, data.flags);
  m.flags.set("argv", argv);
  fill(m.globals, data.globals);
  fill(m.flagValues, data.flagValues);
  m.ops.infix.clear();
  m.ops.prefix.clear();
  m.ops.postfix.clear();
  for (const [kind, name, pri, type] of data.ops as [string, string, number, string][])
    m.ops[kind as "infix" | "prefix" | "postfix"].set(name, { pri, type } as never);
  m.libraryPreds.clear();
  for (const k of data.libraryPreds as string[]) m.libraryPreds.add(k);
  m.tabled.clear();
  for (const k of data.tabled as string[]) m.tabled.add(k);
  m.tables.clear();
  for (const [k, ts] of data.tables as [string, J[]][]) m.tables.set(k, ts.map((t) => dec.term(t)));
  for (const k of data.removedBuiltins as string[]) m.removeBuiltin(k);
  const ld = data.loader as { loaded: J[]; files: J[]; modules: [string, J, J][]; mainGoal: J };
  const snap: LoaderSnapshot = {
    loaded: ld.loaded.map(text),
    files: ld.files.map(text),
    modules: ld.modules.map(([k, f, e]) => [k, text(f), dec.term(e)]),
    mainGoal: ld.mainGoal === null ? null : dec.term(ld.mainGoal),
  };
  restoreLoader(m, snap);
  restoreExpansion(m, data.expansion as { meta: [string, (number | string)[]][]; yall: boolean });
  const av = argvDependence(data, root);
  runArgvDirectives(m, av.preds, av.directives);
}
