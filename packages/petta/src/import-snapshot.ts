// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: import snapshots: the effect of loading one of the package's MeTTa libraries (lib/*.metta), recorded when
// the package builds (import-build.ts) and replayed by load_metta_file/3 on cells in place of translating the library
// again. A load's effect is a function of the state it starts from and the files it reads, as PeTTa's load_cache.pl
// has it (c-petta-load-cache-1108). A snapshot holds the fingerprint of the starting state, the digest of every file
// the load read and of the listing of each directory it read them from, and the effect: the clauses it appended, the
// predicates it made, the globals, counters and flags it set, the output it printed and the results it bound. It
// replays only when the run's state at the call has that fingerprint and every digest still holds; anything else
// translates as before. The fingerprint leaves out the importing file's own loader bookkeeping, which names that
// file's path, directory and line (c-import-bookkeeping-1108); the build requires the effects recorded under two
// importers at different paths to agree, and a replay under the second to leave the state and output translating
// left (import-build.ts). A load whose effect a snapshot cannot hold (a stream left open, an operator,
// table or loaded file changed, a clause of the starting state removed or one put in front of it) gets no snapshot.
// Nothing is written at run time (a-petta-next-1108.speed.imports.buildonly).
// am[implements a-petta-next-1108.speed.imports]
// am[implements a-petta-next-1108.speed.imports.replay]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CellMachine } from "./cell/machine";
import { RCP } from "./cell/machine";
import { clauseRef, refClause } from "./builtins";
import { loaderSnapshot } from "./consult";
import { expansionSnapshot } from "./goal-expansion";
import { Decoder, Encoder, fileHash } from "./image";
import { Ground, type Clause } from "./db";
import { Cons, Str, Struct, deref, listToArray, mkVar, textOf, type Term } from "./terms";

type J = unknown;

/**
 * The directory the package build writes the snapshots to beside the bundle and the image: one file per library, argv
 * form and starting fingerprint (snapshotFile), so a run parses a snapshot only once its import matches it and a miss
 * costs the fingerprint and a file check.
 */
export const IMPORTS_DIR = "petta.imports";
/** The snapshot file format; a reader of another format replays nothing. */
const FORMAT = 1;

/** What a load did, as a snapshot replays it. */
export interface Effect {
  /** Each predicate the load made, appended to or flagged: name, arity, and dynamic and multifile bits after. */
  readonly preds: [string, number, number][];
  /**
   * The clauses the load added and left, in the order it added them: the predicate's index in `preds`, 1 when the
   * clause went in front of the predicate's other added ones (asserta/1) and 0 at their end, and the clause as the
   * image stores one, a clause reference in it kept as {a: the referenced addition's index} or {s: [predicate, the
   * clause's place among that predicate's clauses before the load]}.
   */
  readonly adds: [number, 0 | 1, J][];
  /**
   * Each global variable whose value the load changed: its value after, or null when the load deleted it, and 1 when
   * b_setval/2 set it last (a binding backtracking undoes), 0 when nb_setval/2 did.
   */
  readonly globals: [string, J | null, 0 | 1][];
  /** Each flag/3 counter and each Prolog flag the load set, with its value after. */
  readonly flagValues: [string, J][];
  readonly flags: [string, J][];
  /** What the load printed, in order: 0 for standard output, 1 for standard error. */
  readonly output: [0 | 1, string][];
  /** The load's results argument as it bound it. */
  readonly results: J;
}

export interface Snapshot {
  /** The library, relative to the package directory. */
  readonly lib: string;
  /** The space it was loaded into and the run's argv after its file. */
  readonly space: string;
  readonly argv: string[];
  /** Every MeTTa file the load read, relative to the package directory, with its SHA-1. */
  readonly files: [string, string][];
  /** Every directory it read them from, relative to the package directory, with the SHA-1 of its sorted listing. */
  readonly dirs: [string, string][];
  /** The fingerprint of the state the load started from. */
  readonly start: string;
  readonly effect: Effect;
}

export interface SnapshotFile {
  readonly format: number;
  readonly engine: string;
  readonly snapshots: Snapshot[];
}

/**
 * The importing file's loader bookkeeping, the clauses of which name it (its path, its directory, the line of its
 * import): a library's load reads these only for the files it loads itself (c-import-bookkeeping-1108).
 * am[rests-on c-import-bookkeeping-1108]
 */
const BOOKKEEPING = new Set(["active_metta_load/2", "metta_source_functions_started/1", "declaration_provenance/1"]);
/**
 * The working directory stack, which main.pl starts with the program's directory as its argv names it: a load pushes
 * its own file's directory before reading anything and pops it after, and current_working_dir/1 reads only the top
 * (petta-src filereader.pl push_working_dir, metta.pl current_working_dir), so a load never reads what was below.
 * am[rests-on c-import-bookkeeping-1108]
 */
const STACK = "working_dir/1";
/** The global the loader keeps the file being loaded in, saved and put back around every load. */
const FILE_GLOBAL = "$metta_file";
/** The global the build-time recorder holds a load's results argument in; never part of a state or an effect. */
const RESULTS_GLOBAL = "$import_snapshot_results";

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** Whether term `t` holds an atom or string that is `file`, `dir` or a path under `dir`. Time: the term's size. */
function names(t: Term, file: string, dir: string): boolean {
  // A stored clause holds its ground compounds as Ground holders (db.ts).
  const d = deref(t) as Term | Ground;
  if (typeof d === "string" || d instanceof Str) {
    const s = typeof d === "string" ? d : d.s;
    return s === file || s === dir || s.startsWith(dir + "/");
  }
  if (d instanceof Ground) return names(d.t as Term, file, dir);
  if (d instanceof Cons) return names(d.head, file, dir) || names(d.tail, file, dir);
  if (d instanceof Struct) return d.args.some((a) => names(a, file, dir));
  return false;
}

/** The file being loaded now: the loader's global as the cell engine holds it, the object machine's when it holds none. */
function loadingFile(cm: CellMachine): string | null {
  const t = globalTerm(cm, FILE_GLOBAL);
  if (t === undefined) return null;
  const d = deref(t);
  return typeof d === "string" ? d : null;
}

/** Global `key`'s value: the cell engine's when set there, the object machine's otherwise; undefined when unset. */
function globalTerm(cm: CellMachine, key: string): Term | undefined {
  const c = cm.globalStore?.cell(key) ?? 0;
  return c !== 0 ? cm.hp.decode(c, new Map()) : cm.om.globals.get(key);
}

/** Every global variable with a value, in key order. */
function globalTerms(cm: CellMachine): [string, Term][] {
  const keys = new Set([...(cm.globalStore?.keys() ?? []), ...cm.om.globals.keys()]);
  const out: [string, Term][] = [];
  for (const k of [...keys].sort()) {
    const t = globalTerm(cm, k);
    if (t !== undefined) out.push([k, t]);
  }
  return out;
}

/** A clause as the image stores one: head, body, variable count and file. */
const clauseJson = (enc: Encoder, c: Clause): J => [enc.term(c.head), enc.term(c.body), c.nvars, c.file === null ? null : enc.text(c.file)];

/** The state a snapshot cannot change: operators, tables, the loader's files and modules, goal expansion. */
function restOf(cm: CellMachine, root: string): string {
  const m = cm.om, enc = new Encoder(root);
  const ops: J[] = [];
  for (const [kind, map] of [["infix", m.ops.infix], ["prefix", m.ops.prefix], ["postfix", m.ops.postfix]] as const)
    for (const [name, d] of map) ops.push([kind, name, d.pri, d.type]);
  const ld = loaderSnapshot(m);
  return JSON.stringify({
    ops,
    tabled: [...m.tabled],
    tables: [...m.tables].map(([k, v]) => [k, v.map((t) => enc.term(t))]),
    libraryPreds: [...m.libraryPreds],
    loaded: ld.loaded.map((f) => enc.text(f)),
    files: ld.files.map((f) => enc.text(f)),
    modules: ld.modules.map(([k, f]) => [k, enc.text(f)]),
    expansion: expansionSnapshot(m),
  });
}

/**
 * The state's lines in order: every predicate's name, arity and flags; the live clauses, in order, of every predicate
 * a run has touched since the image (Pred.touched), or of every predicate when `all`, without the loading file's own
 * bookkeeping unless `all`; every global but the loader's file; the flags but argv; the counters; and the rest restOf
 * names. Throws on a term no image encoder takes (an attributed variable, a stream). Time: the predicates' count plus
 * the listed clauses and globals.
 */
export function stateLines(cm: CellMachine, root: string, all = false): string[] {
  const m = cm.om;
  // A clause reference is its clause's predicate and place among that predicate's live clauses.
  const ref = (t: Struct): J => {
    const c = refClause(t);
    if (c === undefined || c.died !== Infinity) return "dead";
    return [`${c.pred.name}/${c.pred.arity}`, c.pred.clauses.filter((x) => x.died === Infinity).indexOf(c)];
  };
  const enc = new Encoder(root, true, ref), venc = new Encoder(root, false, ref, true);
  const file = all ? null : loadingFile(cm);
  const dir = file === null ? null : dirname(file);
  const lines: string[] = [];
  for (const p of m.db.preds.values()) {
    const key = `${p.name}/${p.arity}`;
    lines.push(`p ${key} ${+p.dynamic}${+p.multifile}`);
    if (!p.touched && !all) continue;
    if (!all && key === STACK) continue;
    const own = file !== null && BOOKKEEPING.has(key);
    const live: J[] = [];
    for (const c of p.clauses) {
      if (c.died !== Infinity) continue;
      if (own && (names(c.head, file, dir!) || names(c.body, file, dir!))) continue;
      live.push(clauseJson(enc, c));
    }
    if (live.length > 0) lines.push(`c ${key} ${JSON.stringify(live)}`);
  }
  for (const [k, v] of globalTerms(cm)) if ((all || k !== FILE_GLOBAL) && k !== RESULTS_GLOBAL) lines.push(`g ${k} ${JSON.stringify(venc.term(v))}`);
  for (const [k, v] of m.flags) if (k !== "argv") lines.push(`f ${k} ${JSON.stringify(venc.term(v))}`);
  for (const [k, v] of m.flagValues) lines.push(`v ${k} ${JSON.stringify(venc.term(v))}`);
  lines.sort();
  lines.push(`r ${restOf(cm, root)}`, `s ${m.objectCount()}`);
  return lines;
}

/**
 * The fingerprint of the state a load starting now would read: the SHA-1 of its stateLines. Null when the state
 * holds a term a snapshot cannot encode. Time: stateLines', once per import of a library.
 */
export function fingerprint(cm: CellMachine, root: string): string | null {
  try {
    return sha1(stateLines(cm, root).join("\n"));
  } catch {
    return null;
  }
}

/** The run's argv after its file, as strings. */
function argvTail(cm: CellMachine): string[] {
  const items = listToArray(cm.om.flags.get("argv") ?? "[]") ?? [];
  return items.slice(1).map((t) => textOf(deref(t)) ?? "");
}

/** What the build reads of the state a load starts from, to tell its effect from it. */
interface Start {
  readonly gen: number;
  readonly preds: number;
  readonly bits: Map<string, number>;
  readonly globals: Map<string, string>;
  readonly flagValues: Map<string, string>;
  readonly flags: Map<string, string>;
  readonly rest: string;
  readonly streams: number;
}

const bitsOf = (p: { dynamic: boolean; multifile: boolean }): number => +p.dynamic | (+p.multifile << 1);

function startOf(cm: CellMachine, root: string): Start {
  const m = cm.om, enc = new Encoder(root);
  const bits = new Map<string, number>();
  for (const [k, p] of m.db.preds) bits.set(k, bitsOf(p));
  const json = (pairs: Iterable<[string, Term]>): Map<string, string> => new Map([...pairs].map(([k, v]) => [k, JSON.stringify(enc.term(v))]));
  return {
    gen: m.db.generation,
    preds: m.db.preds.size,
    bits,
    globals: json(globalTerms(cm)),
    flagValues: json(m.flagValues),
    flags: json([...m.flags].filter(([k]) => k !== "argv")),
    rest: restOf(cm, root),
    streams: m.objectCount(),
  };
}

/**
 * The effect of a load since `s`, or why a snapshot cannot hold it. Time: the touched predicates' clauses and the
 * globals, once per library built.
 */
function effectSince(cm: CellMachine, root: string, s: Start, results: Term, output: [0 | 1, string][], backtrackable: Set<string>): Effect | string {
  const m = cm.om;
  if (m.objectCount() !== s.streams) return "the load left a stream open";
  if (restOf(cm, root) !== s.rest) return "the load changed operators, tables, loaded files or goal expansion";
  const preds: [string, number, number][] = [];
  const added: [number, Clause, 0 | 1][] = [];
  let i = 0;
  for (const [k, p] of m.db.preds) {
    const made = i++ >= s.preds;
    const flagged = !made && s.bits.get(k) !== bitsOf(p);
    const own: Clause[] = [];
    if (p.touched || made) {
      let appended = false;
      for (const c of p.clauses) {
        if (c.born <= s.gen) {
          if (c.died !== Infinity && c.died > s.gen) return `the load removed a clause of ${k} it did not add`;
          if (c.died === Infinity && appended) return `the load put a clause of ${k} in front of the starting state's`;
        } else if (c.died === Infinity) {
          appended = true;
          own.push(c);
        }
      }
    }
    if (made || flagged || own.length > 0) {
      // Each clause in the order it was added went to the front or the end of those added before it, as its place in
      // the final order says; one landing between them came from more than asserta/1 and assertz/1.
      const place = new Map(own.map((c, j) => [c, j]));
      let lo = Infinity, hi = -Infinity;
      for (const c of [...own].sort((a, b) => a.born - b.born)) {
        const at = place.get(c)!;
        let front: 0 | 1 = 0;
        if (lo === Infinity) lo = hi = at;
        else if (at < lo) (lo = at), (front = 1);
        else if (at > hi) hi = at;
        else return `the load put a clause of ${k} between clauses it added`;
        added.push([preds.length, c, front]);
      }
      preds.push([p.name, p.arity, bitsOf(p)]);
    }
  }
  added.sort((a, b) => a[1].born - b[1].born);
  const index = new Map(added.map(([, c], j) => [c, j]));
  // A reference is to a clause the load added and left, or to one of the starting state's outside the importer's
  // bookkeeping, by its place among its predicate's clauses before the load.
  const ref = (t: Struct): J => {
    const c = refClause(t);
    if (c === undefined) throw new Error("a clause reference to no clause");
    const j = index.get(c);
    if (j !== undefined) return { a: j };
    const key = `${c.pred.name}/${c.pred.arity}`;
    if (c.born > s.gen || c.died !== Infinity || BOOKKEEPING.has(key)) throw new Error(`a reference to a clause of ${key} the load removed or the importer owns`);
    return { s: [key, c.pred.clauses.filter((x) => x.born <= s.gen && x.died === Infinity).indexOf(c)] };
  };
  const enc = new Encoder(root, true, ref), venc = new Encoder(root, false, ref, true);
  const adds: [number, 0 | 1, J][] = [];
  for (const [pi, c, front] of added) {
    try {
      adds.push([pi, front, clauseJson(enc, c)]);
    } catch (e) {
      return `the load added a clause of ${preds[pi]![0]}/${preds[pi]![1]} a snapshot cannot hold (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  const changes = (before: Map<string, string>, after: [string, Term][], skip: Set<string>): [string, J | null][] | string => {
    const out: [string, J | null][] = [];
    const now = new Map<string, J>();
    for (const [k, v] of after) {
      if (skip.has(k)) continue;
      try {
        now.set(k, venc.term(v));
      } catch (e) {
        return `${k} holds a term a snapshot cannot hold (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    for (const [k, v] of now) if (!skip.has(k) && before.get(k) !== JSON.stringify(v)) out.push([k, v]);
    for (const k of before.keys()) if (!skip.has(k) && !now.has(k)) out.push([k, null]);
    return out;
  };
  const globals = changes(s.globals, globalTerms(cm), new Set([RESULTS_GLOBAL]));
  if (typeof globals === "string") return globals;
  const fileBefore = s.globals.get(FILE_GLOBAL);
  if (globals.some(([k]) => k === FILE_GLOBAL)) return `the load left ${FILE_GLOBAL} changed (${fileBefore})`;
  const flagValues = changes(s.flagValues, [...m.flagValues], new Set());
  const flags = changes(s.flags, [...m.flags].filter(([k]) => k !== "argv"), new Set());
  if (typeof flagValues === "string") return flagValues;
  if (typeof flags === "string") return flags;
  const marked: [string, J | null, 0 | 1][] = globals.map(([k, v]) => [k, v, backtrackable.has(k) ? 1 : 0]);
  if ([...flagValues, ...flags].some(([, v]) => v === null)) return "the load removed a flag or counter";
  let res: J;
  try {
    res = venc.term(results);
  } catch (e) {
    return `the load's results hold a term a snapshot cannot hold (${e instanceof Error ? e.message : String(e)})`;
  }
  return { preds, adds, globals: marked, flagValues: flagValues as [string, J][], flags: flags as [string, J][], output, results: res };
}

/** The SHA-1 of directory `dir`'s sorted listing. */
const listingHash = (dir: string): string => sha1(readdirSync(dir).sort().join("\n"));

/** Whether every file and directory a snapshot read still has its digest under `root`. Time: those files' sizes. */
function inputsHold(s: Snapshot, root: string): boolean {
  for (const [rel, hash] of s.files) {
    const f = join(root, rel);
    if (!existsSync(f) || fileHash(f) !== hash) return false;
  }
  for (const [rel, hash] of s.dirs) {
    const d = join(root, rel);
    if (!existsSync(d) || listingHash(d) !== hash) return false;
  }
  return true;
}

/**
 * Apply snapshot `s`'s effect, as the load would have left the state, and unify the call's results argument `a1`
 * with its results. Time: the effect's size.
 */
function replay(cm: CellMachine, root: string, s: Snapshot, a1: number): boolean {
  const m = cm.om, hp = cm.hp;
  const e = s.effect;
  const gen = m.db.generation;
  const made: Clause[] = [];
  const ref = (j: J): Term => {
    const o = j as { a?: number; s?: [string, number] };
    if (o.a !== undefined) return clauseRef(made[o.a]!);
    const [key, at] = o.s!;
    const slash = key.lastIndexOf("/");
    const p = m.db.get(key.slice(0, slash), Number(key.slice(slash + 1)))!;
    return clauseRef(p.clauses.filter((x) => x.born <= gen && x.died === Infinity)[at]!);
  };
  const dec = new Decoder(root, ref);
  const preds = e.preds.map(([name, arity, bits]) => {
    const p = m.db.ensure(name, arity);
    p.dynamic = (bits & 1) !== 0;
    p.multifile = (bits & 2) !== 0;
    return p;
  });
  for (const [pi, front, [h, b, nvars, file]] of e.adds as [number, 0 | 1, [J, J, number, J]][]) {
    const c = m.db.addClause(preds[pi]!, dec.term(h), dec.term(b), nvars, front === 0);
    c.file = file === null ? null : (dec.term(file) as string);
    made.push(c);
  }
  for (const [k, v, bt] of e.globals) {
    if (v === null) cm.globalStore!.remove(k);
    else if (bt === 1) cm.globalStore!.bind(k, hp.encode(dec.term(v), new Map()));
    else cm.globalStore!.set(k, hp.encode(dec.term(v), new Map()));
  }
  for (const [k, v] of e.flagValues) m.flagValues.set(k, dec.term(v));
  for (const [k, v] of e.flags) m.flags.set(k, dec.term(v));
  for (const [stream, text] of e.output) (stream === 0 ? m.out : m.err)(text);
  return hp.unify(a1, hp.encode(dec.term(e.results), new Map()));
}

/** The atom or string cell `c` as text, or null. */
function cellText(cm: CellMachine, c: number): string | null {
  const t = deref(cm.hp.decode(c, new Map()));
  return typeof t === "string" ? t : t instanceof Str ? t.s : null;
}

/**
 * Make load_metta_file/3 on `cm` replay a snapshot when one matches the call and the state, and run its clauses
 * otherwise. `snapshots` gives the snapshots of a library and argv form that start from a fingerprint; it is asked
 * only for loads of files under the package's lib directory, so a run that imports no library computes no
 * fingerprint. `trace`, when given, hears of each library load: "replay <lib>" or "miss <lib>: <why>".
 */
export function installImportReplay(
  cm: CellMachine,
  root: string,
  snapshots: (lib: string, argv: readonly string[], start: string) => readonly Snapshot[],
  trace?: (event: string) => void,
): void {
  const p = cm.om.db.get("load_metta_file", 3);
  if (p === undefined) return;
  const libDir = join(root, "lib") + "/";
  cm.proc("load_metta_file", 3).ctl = (m, _n, cc) => {
    const path = cellText(cm, m.A[0]!);
    if (path === null || !path.startsWith(libDir)) return m.runClauses(p, cc);
    const lib = relative(root, path);
    const space = cellText(cm, m.A[2]!);
    const argv = argvTail(cm);
    const fp = fingerprint(cm, root);
    const started = fp === null ? [] : snapshots(lib, argv, fp).filter((s) => s.space === space && s.argv.join("\0") === argv.join("\0") && s.start === fp);
    const s = started.find((x) => inputsHold(x, root));
    if (s === undefined) {
      trace?.(`miss ${lib}: ${started.length === 0 ? "no snapshot starts from this state, space and argv" : "a file it read changed"}`);
      return m.runClauses(p, cc);
    }
    trace?.(`replay ${lib}`);
    return m.answer(replay(cm, root, s, m.A[1]!), cc);
  };
}

/** The name of the file holding library `lib`'s snapshots for argv form `argv` from fingerprint `start`, in IMPORTS_DIR. */
export const snapshotFile = (lib: string, argv: readonly string[], start: string): string =>
  `${lib.replace(/[^\w.-]/g, "_")}${argv.join("")}.${start.slice(0, 16)}.json`;

/**
 * A lookup of the snapshots in directory `dir` built by the bundle with hash `engine`: each file is read and parsed
 * once, at its first lookup, and a file that is absent or another bundle's gives none.
 */
export function snapshotDir(dir: string, engine: string): (lib: string, argv: readonly string[], start: string) => readonly Snapshot[] {
  const read = new Map<string, readonly Snapshot[]>();
  return (lib, argv, start) => {
    const name = snapshotFile(lib, argv, start);
    let got = read.get(name);
    if (got === undefined) {
      const f = join(dir, name);
      const data = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as SnapshotFile) : null;
      got = data !== null && data.format === FORMAT && data.engine === engine ? data.snapshots : [];
      read.set(name, got);
    }
    return got;
  };
}

/** A lookup of the snapshots in `list`, for tests and the build's own check. */
export const snapshotList =
  (list: readonly Snapshot[]): ((lib: string, argv: readonly string[], start: string) => readonly Snapshot[]) =>
  (lib) =>
    list.filter((s) => s.lib === lib);

/** The snapshot files for `snapshots`: each file name with its content. */
export function snapshotFiles(engine: string, snapshots: readonly Snapshot[]): Map<string, SnapshotFile> {
  const out = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    const name = snapshotFile(s.lib, s.argv, s.start);
    const list = out.get(name);
    if (list === undefined) out.set(name, [s]);
    else list.push(s);
  }
  return new Map([...out].map(([k, v]) => [k, { format: FORMAT, engine, snapshots: v }]));
}

/**
 * Make load_metta_file/3 on `cm` record a snapshot of its first load of `target` (an absolute path) for the build,
 * calling `started` when that load begins and `done` with the snapshot or with why it cannot be one once it returns
 * (a load that fails or throws never returns); other loads, nested ones included, run their clauses and are part of
 * the recorded effect. The load's return is caught by giving it a continuation of its own, which records the
 * effect and goes on with the call's own.
 */
export function recordImport(cm: CellMachine, root: string, target: string, done: (r: Snapshot | string) => void, started?: () => void): void {
  const p = cm.om.db.get("load_metta_file", 3);
  if (p === undefined) throw new Error("import snapshots: no load_metta_file/3");
  const m0 = cm.om;
  let state: "before" | "loading" | "after" = "before";
  const read = new Set<string>();
  // The globals b_setval/2 set last during the load, which replay binds as it did.
  const backtrackable = new Set<string>();
  for (const [name, bt] of [["b_setval", true], ["nb_setval", false]] as const) {
    const proc = cm.proc(name, 2), det = proc.det!;
    proc.det = (mm, n) => {
      if (state === "loading") {
        const key = cellText(cm, mm.A[0]!);
        if (key !== null) {
          if (bt) backtrackable.add(key);
          else backtrackable.delete(key);
        }
      }
      return det(mm, n);
    };
  }
  cm.proc("load_metta_file", 3).ctl = (m, _n, cc) => {
    const path = cellText(cm, m.A[0]!);
    if (state === "loading" && path !== null) read.add(path);
    if (state !== "before" || path !== target) return m.runClauses(p, cc);
    state = "loading";
    started?.();
    read.add(path);
    const space = cellText(cm, m.A[2]!) ?? "";
    const argv = argvTail(cm);
    const start = fingerprint(cm, root);
    const s0 = startOf(cm, root);
    const output: [0 | 1, string][] = [];
    const out = m0.out, err = m0.err;
    m0.out = (t) => (output.push([0, t]), out(t));
    m0.err = (t) => (output.push([1, t]), err(t));
    // The results argument, held through the load by a global slot, which the collector keeps as a root.
    const v = cm.hp.encode(mkVar(), new Map());
    cm.hp.unify(m.A[1]!, v);
    cm.globalStore!.bind(RESULTS_GLOBAL, v);
    const back = m.R[RCP]!;
    const id = m.CODE.push(() => {
      state = "after";
      m0.out = out;
      m0.err = err;
      const results = globalTerm(cm, RESULTS_GLOBAL) ?? mkVar();
      cm.globalStore!.remove(RESULTS_GLOBAL);
      if (start === null) done("the starting state holds a term a snapshot cannot encode");
      else {
        const effect = effectSince(cm, root, s0, results, output, backtrackable);
        if (typeof effect === "string") done(effect);
        else {
          const files = [...read].sort();
          const outside = files.find((f) => relative(root, f).startsWith(".."));
          if (outside !== undefined) done(`the load read ${outside}, outside the package`);
          else
            done({
              lib: relative(root, target),
              space,
              argv,
              files: files.map((f) => [relative(root, f), fileHash(f)]),
              dirs: [...new Set(files.map(dirname))].sort().map((d) => [relative(root, d), listingHash(d)]),
              start,
              effect,
            });
        }
      }
      m.R[RCP] = back;
      return m.CODE[back]!;
    }) - 1;
    m.R[RCP] = id;
    return m.runClauses(p, cc);
  };
}
