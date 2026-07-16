// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Program runner: sequential top-to-bottom evaluation of a MeTTa program, a faithful port of
// LeaTTa `Stdlib.lean` (`evalSequential`, `oracleReport`). Each `!`-query is evaluated against the
// prelude plus the KB atoms that precede it; world effects (add-atom, bind!, state) thread forward.
import { type Atom, createInternTable, gint, gfloat, gbool } from "./atom";
import { Tokenizer } from "./tokenizer";
import { parseAll, format } from "./parser";
import {
  type St,
  type MinEnv,
  type AsyncGroundFn,
  type HostImportFn,
  buildEnv,
  addAtomToEnv,
  initSt,
  mettaEval,
  mettaEvalAsyncOwned,
  registerAsyncGroundedOperation,
} from "./eval";
import { stdTable } from "./builtins";
import { analyzePurity, analyzeTableWorth, MODED_IMPURE_OPS } from "./tabling";
import { PRELUDE_SRC } from "./prelude";
import { withBuiltinModules } from "./extensions";
import { stdlibAtoms } from "./stdlib";
import { pettaStdlibAtoms } from "./petta-stdlib";
import { RevisionMap, RevisionSet } from "./revision-collection";
import { TableSpace } from "./table-space";

/** The standard tokenizer: integer/float literals and the `True`/`False` grounded booleans. */
export function standardTokenizer(): Tokenizer {
  const t = new Tokenizer();
  t.register(/^[+-]?\d+$/, (s) => gint(BigInt(s)));
  t.register(/^[+-]?\d+\.\d+$/, (s) => gfloat(Number(s)));
  // Scientific-notation floats (Hyperon arithmetics.rs: `[\-\+]?\d+(\.\d+)?[eE][\-\+]?\d+`), e.g. 1e-3,
  // 1.5e2, -2e10. Registered after the plain int/decimal forms, which it does not overlap.
  t.register(/^[+-]?\d+(\.\d+)?[eE][-+]?\d+$/, (s) => gfloat(Number(s)));
  t.register(/^True$/, () => gbool(true));
  t.register(/^False$/, () => gbool(false));
  return t;
}

let preludeCache: Atom[] | undefined;
/** The prelude's atoms (parsed once and cached). */
export function preludeAtoms(): Atom[] {
  if (preludeCache === undefined)
    preludeCache = parseAll(PRELUDE_SRC, standardTokenizer())
      .filter((t) => !t.bang)
      .map((t) => t.atom);
  return preludeCache;
}

export interface QueryResult {
  readonly query: Atom;
  readonly results: Atom[];
}

export const DEFAULT_FUEL = 100_000;
const DEFAULT_TABLING = true;
const DEFAULT_FLAT_ATOMSPACE = true;

function flatAtomspaceEnabled(opts: RunOptions): boolean {
  return opts.experimental?.flatAtomspace ?? DEFAULT_FLAT_ATOMSPACE;
}

interface TablingAnalysis {
  readonly pureFunctors: Set<string>;
  readonly modedPureFunctors: Set<string>;
  readonly tableWorth: Set<string>;
  readonly modedTableWorth: Set<string>;
}

let defaultTablingAnalysis: TablingAnalysis | undefined;
let defaultProgramTemplate: MinEnv | undefined;

function baseProgramTemplate(): MinEnv {
  if (defaultProgramTemplate !== undefined) return defaultProgramTemplate;
  const env = buildEnv([...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms()], stdTable());
  env.sharedContextAtoms = env.atoms;
  defaultProgramTemplate = env;
  return env;
}

function baseTablingAnalysis(env: MinEnv): TablingAnalysis {
  if (defaultTablingAnalysis === undefined) {
    const pureFunctors = analyzePurity(env);
    const modedPureFunctors = analyzePurity(env, MODED_IMPURE_OPS);
    defaultTablingAnalysis = {
      pureFunctors,
      modedPureFunctors,
      tableWorth: analyzeTableWorth(env, pureFunctors),
      modedTableWorth: analyzeTableWorth(env, modedPureFunctors),
    };
  }
  return defaultTablingAnalysis;
}

/** A fresh environment preloaded with the prelude and standard library, with `imports` seeded by the
 *  built-in extension modules (e.g. `concurrency`). The env is built once and extended per non-bang
 *  atom; built-in modules apply only when a program actually `(import! ...)`s them, so the Hyperon
 *  oracle baseline is unaffected. */
function buildDefaultEnv(
  imports: Map<string, Atom[]>,
  tabling: boolean,
  opts: RunOptions = {},
): MinEnv {
  const experimental = opts.experimental;
  const template = baseProgramTemplate();
  // Static program indexes are immutable between top-level additions. Share the cached image and detach all
  // mutable indexes together on the first write, while keeping per-run effects and semantic caches private.
  const env: MinEnv = {
    ...template,
    staticProgramShared: true,
    imports: new RevisionMap(),
    agt: new RevisionMap(),
    capabilities: new RevisionSet(template.capabilities),
    mutexes: new Map(),
    evaluatedAtoms: new WeakSet(),
  };
  env.imports = new RevisionMap(withBuiltinModules(imports));
  if (opts.hostImport !== undefined) env.hostImport = opts.hostImport;
  if (experimental?.hashCons === true) env.intern = createInternTable();
  if (experimental?.trail === true) env.useTrail = true;
  if (flatAtomspaceEnabled(opts)) env.useFlatAtomspace = true;
  if (tabling) {
    env.tableSpace = new TableSpace();
    const base = baseTablingAnalysis(env);
    env.pureFunctors = base.pureFunctors;
    env.modedPureFunctors = base.modedPureFunctors;
    env.tableWorth = base.tableWorth;
    env.modedTableWorth = base.modedTableWorth;
    env.tablingDirty = false;
    env.compiled = new Map();
    env.compileDirty = true;
    env.compiledComplete = false;
  }
  return env;
}

export interface RunOptions {
  readonly tabling?: boolean;
  readonly experimental?: {
    readonly hashCons?: boolean;
    // Compact interned runtime `&self` store (typed-array term columns + a decode cache): default on.
    // It lowers peak RSS on add-heavy runs and stays byte-identical to the plain AtomLog path. The `false`
    // value is kept for differential tests and profiling. Atoms that cannot be encoded (a grounded
    // executor, matcher, or non-default grounded type) fall back to the log automatically.
    readonly flatAtomspace?: boolean;
    // Trail-based zero-allocation conjunctive matching (eval.ts matchConjTrail). Byte-identical to the
    // immutable matcher, differential-gated; off by default.
    readonly trail?: boolean;
  };
  // Initial interpreter stack-depth bound; 0 (the default) means unlimited, matching Hyperon. A program can
  // tighten it in-language with `(pragma! max-stack-depth N)`. This is the embedder's knob: it sets the
  // starting bound but is not a hard ceiling; the `fuel` argument is the resource ceiling. Left to the
  // developer rather than hardcoded so a host embedding untrusted programs can pick its own policy.
  readonly maxStackDepth?: number;
  // Optional parallel branch evaluator for `(once (hyperpose …))`, supplied by hosts that can block the
  // caller while branch workers run. Node uses this for the CLI worker_threads path.
  readonly parEvalImpl?: (
    rulesSrc: string,
    branchSrcs: string[],
    firstOnly: boolean,
  ) => (string[] | null)[];
  // Async equivalent for hosts such as browsers where Web Workers report back through messages. Used only by
  // the async runner; the sync runner still falls back unless `parEvalImpl` is present.
  readonly parEvalAsyncImpl?: (
    rulesSrc: string,
    branchSrcs: string[],
    firstOnly: boolean,
  ) => Promise<(string[] | null)[]>;
  readonly hostImport?: HostImportFn;
}

function wireParallelEvaluation(
  env: MinEnv,
  atoms: readonly { atom: Atom; bang: boolean }[],
  opts: RunOptions,
): void {
  if (opts.parEvalImpl === undefined && opts.parEvalAsyncImpl === undefined) return;
  env.pureFunctors ??= analyzePurity(env);
  // Re-evaluate a branch in a worker from the program's static (non-`!`) rules; a pure ground branch
  // references only those, so this reproduces the in-line evaluation. Result strings are parsed back.
  const rulesSrc = atoms
    .filter((a) => !a.bang)
    .map((a) => format(a.atom))
    .join("\n");
  const parseBranchResults = (results: (string[] | null)[]): (Atom[] | null)[] =>
    results.map((r) =>
      r === null ? null : r.flatMap((s) => parseAll(s, standardTokenizer()).map((p) => p.atom)),
    );
  const impl = opts.parEvalImpl;
  if (impl !== undefined) {
    env.parEval = (branchSrcs, firstOnly) =>
      parseBranchResults(impl(rulesSrc, branchSrcs, firstOnly));
  }
  const asyncImpl = opts.parEvalAsyncImpl;
  if (asyncImpl !== undefined) {
    env.parEvalAsync = async (branchSrcs, firstOnly) =>
      parseBranchResults(await asyncImpl(rulesSrc, branchSrcs, firstOnly));
  }
}

function resultsForQuery(pairs: Array<[Atom, unknown]>): Atom[] {
  return pairs.map((p) => p[0]);
}

function evalSequentialInternal(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
  opts: RunOptions = {},
  includeNonBang: boolean,
): QueryResult[] {
  const out: QueryResult[] = [];
  let st: St = initSt();
  if (opts.maxStackDepth !== undefined) st.world.maxStackDepth = opts.maxStackDepth;
  const env = buildDefaultEnv(imports, opts.tabling ?? DEFAULT_TABLING, opts);
  wireParallelEvaluation(env, atoms, opts);
  for (const { atom, bang } of atoms) {
    if (!bang) {
      addAtomToEnv(env, atom);
      if (includeNonBang) out.push({ query: atom, results: [] });
      continue;
    }
    const [pairs, st2] = mettaEval(env, fuel, st, [], atom);
    st = st2;
    out.push({ query: atom, results: resultsForQuery(pairs) });
  }
  return out;
}

/** Evaluate a parsed program sequentially. `imports` backs `import!` (pre-read by the caller). */
export function evalSequential(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequentialInternal(atoms, fuel, imports, opts, false);
}

/** Evaluate every top-level directive, including non-`!` atoms as empty result directives. */
export function evalSequentialAllDirectives(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequentialInternal(atoms, fuel, imports, opts, true);
}

/** Parse and run a MeTTa source string sequentially. */
export function runProgram(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequential(parseAll(src, standardTokenizer()), fuel, imports, opts);
}

/** Parse and run a MeTTa source string, returning one result entry per top-level directive. */
export function runProgramAllDirectives(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequentialAllDirectives(parseAll(src, standardTokenizer()), fuel, imports, opts);
}

/** Async sequential evaluation: like `runProgram`, but `!`-queries are awaited, so async grounded
 *  operations (registered in `asyncOps`) can perform I/O. Sync programs give identical results to
 *  `runProgram`; the async path only differs when an async op is actually reached. */
export async function runProgramAsync(
  src: string,
  asyncOps: Map<string, AsyncGroundFn> = new Map(),
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
  opts: RunOptions = {},
): Promise<QueryResult[]> {
  const parsed = parseAll(src, standardTokenizer());
  const env = buildDefaultEnv(imports, opts.tabling ?? false, opts);
  wireParallelEvaluation(env, parsed, opts);
  for (const [k, v] of asyncOps) registerAsyncGroundedOperation(env, k, v);
  const out: QueryResult[] = [];
  let st: St = initSt();
  if (opts.maxStackDepth !== undefined) st.world.maxStackDepth = opts.maxStackDepth;
  for (const { atom, bang } of parsed) {
    if (!bang) {
      addAtomToEnv(env, atom);
      continue;
    }
    const [pairs, st2] = await mettaEvalAsyncOwned(env, fuel, st, [], atom);
    st = st2;
    out.push({ query: atom, results: resultsForQuery(pairs) });
  }
  return out;
}

/** Module names referenced by top-level `import!` statements (so a caller can pre-read them). */
export function collectImports(src: string): string[] {
  const out: string[] = [];
  const importName = (atom: Atom): string | undefined => {
    if (atom.kind === "sym") return atom.name;
    if (atom.kind === "gnd" && atom.value.g === "str") return atom.value.s;
    return undefined;
  };
  for (const { atom } of parseAll(src, standardTokenizer())) {
    if (
      atom.kind === "expr" &&
      atom.items.length === 3 &&
      atom.items[0]!.kind === "sym" &&
      atom.items[0]!.name === "import!"
    ) {
      const name = importName(atom.items[2]!);
      if (name !== undefined) out.push(name);
    }
  }
  return out;
}

/** An oracle assertion passes iff its query evaluates to exactly the unit atom `()`. */
export function isOraclePass(r: QueryResult): boolean {
  return (
    r.results.length === 1 && r.results[0]!.kind === "expr" && r.results[0]!.items.length === 0
  );
}

/** Run a test file and report pass/fail counts and the failing queries. */
export function oracleReport(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: Map<string, Atom[]> = new Map(),
): { total: number; passed: number; failures: string[] } {
  const results = runProgram(src, fuel, imports);
  let passed = 0;
  const failures: string[] = [];
  for (const r of results) {
    if (isOraclePass(r)) passed++;
    else
      failures.push(
        `FAIL: ${format(r.query)}\n   got: ${r.results.map(format).join(" ") || "(no results)"}`,
      );
  }
  return { total: results.length, passed, failures };
}
