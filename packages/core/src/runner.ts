// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Program runner: sequential top-to-bottom evaluation of a MeTTa program, a faithful port of
// LeaTTa `Stdlib.lean` (`evalSequential`, `oracleReport`). Each `!`-query is evaluated against the
// prelude plus the KB atoms that precede it; world effects (add-atom, bind!, state) thread forward.
import { type Atom, createInternTable, expr, gint, gfloat, gbool, sym } from "./atom";
import { Tokenizer } from "./tokenizer";
import { parseAll, format } from "./parser";
import {
  type St,
  type MinEnv,
  type AsyncGroundFn,
  type HostImportFn,
  type ImportMap,
  buildEnv,
  addAtomToEnv,
  initSt,
  literalImportTarget,
  mettaEval,
  mettaEvalAsync,
  promoteCompletedSelfImport,
  registerAsyncGroundedOperation,
} from "./eval";
import { stdTable } from "./builtins";
import { analyzePurity, analyzeTableWorth, MODED_IMPURE_OPS } from "./tabling";
import { PRELUDE_SRC } from "./prelude";
import { withBuiltinModules } from "./extensions";
import { stdlibAtoms } from "./stdlib";
import { type Space } from "./space";
import { pettaStdlibAtoms } from "./petta-stdlib";
import { lambdaStdlibAtoms } from "./lambda-stdlib";
import { TableSpace } from "./table-space";
import type { TraceSink } from "./trace";
import type { EvaluationDepth } from "./eval-depth";

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
const DEFAULT_CONJ_NESTED = true;
const DEFAULT_RANGE_INDEX = true;
const DEFAULT_MATCH_EVAL_MARK = true;
const DEFAULT_STATIC_COMPACT = true;
const DEFAULT_DIRECT_MATCH = true;

function flatAtomspaceEnabled(opts: RunOptions): boolean {
  return opts.experimental?.flatAtomspace ?? DEFAULT_FLAT_ATOMSPACE;
}

function conjNestedEnabled(opts: RunOptions): boolean {
  return opts.experimental?.conjNested ?? DEFAULT_CONJ_NESTED;
}

function rangeIndexEnabled(opts: RunOptions): boolean {
  return opts.experimental?.rangeIndex ?? DEFAULT_RANGE_INDEX;
}

function matchEvalMarkEnabled(opts: RunOptions): boolean {
  return opts.experimental?.matchEvalMark ?? DEFAULT_MATCH_EVAL_MARK;
}

function staticCompactEnabled(opts: RunOptions): boolean {
  return opts.experimental?.staticCompact ?? DEFAULT_STATIC_COMPACT;
}

function directMatchEnabled(opts: RunOptions): boolean {
  return opts.experimental?.directMatch ?? DEFAULT_DIRECT_MATCH;
}

interface TablingAnalysis {
  readonly pureFunctors: Set<string>;
  readonly modedPureFunctors: Set<string>;
  readonly tableWorth: Set<string>;
  readonly modedTableWorth: Set<string>;
}

let defaultTablingAnalysis: TablingAnalysis | undefined;

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
function buildDefaultEnv(imports: ImportMap, tabling: boolean, opts: RunOptions = {}): MinEnv {
  const experimental = opts.experimental;
  const env: MinEnv = buildEnv(
    [...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms(), ...lambdaStdlibAtoms()],
    stdTable(),
    staticCompactEnabled(opts),
  );
  // Everything loaded so far is the library base; `get-atoms &self` enumerates the program's own
  // atoms, which start here.
  env.preloadBase = env.atoms.length;
  env.imports = withBuiltinModules(imports);
  if (opts.hostImport !== undefined) env.hostImport = opts.hostImport;
  const decline = opts.declineCompiled;
  if (decline !== undefined) {
    const kinds = new Set(decline.kinds ?? []);
    const functors = new Set(decline.functors ?? []);
    env.declineCompiled = (functor, kind) => kinds.has(kind) || functors.has(functor);
  }
  if (opts.trace !== undefined) env.trace = opts.trace;
  if (opts.spaces !== undefined) env.spaceBackends = new Map(opts.spaces);
  if (opts.onSpaceChange !== undefined) env.onSpaceChange = opts.onSpaceChange;
  if (experimental?.hashCons === true) env.intern = createInternTable();
  if (experimental?.trail === true) env.useTrail = true;
  // buildEnv already defaults these on; assign (not just enable) so an explicit `false` forces the
  // reference path for differential tests and profiling.
  env.useConjNested = conjNestedEnabled(opts);
  env.useRangeIndex = rangeIndexEnabled(opts);
  env.useMatchEvalMark = matchEvalMarkEnabled(opts);
  env.useDirectMatch = directMatchEnabled(opts);
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
    // Anchored-acyclic conjunctive matching (eval.ts matchPlan -> matchConj). For a `(, ...)` whose first
    // goal is anchored by a ground argument and whose later goals are connected over a ground, duplicate-free
    // candidate domain, the source-ordered nested loop probes the argument index per bound join variable
    // instead of materializing every goal's full relation for the WCO join (the anchored two-hop drops from
    // ~170 ms to ~0.5 ms at 120k facts). Byte-identical to matchConjJoin (differential-gated across the corpus
    // plus property fuzzing); on by default, set false to force the WCO path.
    readonly conjNested?: boolean;
    // Single-pattern numeric range matching (eval.ts matchPlan -> ordered range index). A pure nested `if`
    // template such as `(if (>= $x lo) (if (< $x hi) result (empty)) (empty))` over one all-variable
    // functor pattern enumerates the sorted numeric column slice, then restores source order. Byte-identical
    // to the full scan under its guards; on by default, set false to force the scan.
    readonly rangeIndex?: boolean;
    // Normal-form ground results from single-pattern `match` plans are pre-marked in the evaluated-atom cache
    // so their first consumer visit skips the redundant reduce probe. Byte-identical to letting that probe
    // discover the same no-op reduction; on by default, set false for differential tests and profiling.
    readonly matchEvalMark?: boolean;
    // A public-entry bare `(match &self pat templ)` answers straight from its match plan (eval.ts
    // tryDirectTopMatch), skipping the generator driver, the worklist, and the per-result reduce probe.
    // Guarded to the cases where that machinery is a provable no-op and byte-identical under the
    // differential gate; on by default, set false to force the general path.
    readonly directMatch?: boolean;
    // Compact static fact storage: bulk buildEnv loads sweep large all-ground flat-fact functors into an
    // interned column store (eval.ts compactStaticFacts), releasing the object forest and argIndex postings;
    // candidates decode on demand and sorted columns serve equality and range probes. Byte-identical under
    // its guards; on by default, set false to keep the plain object environment.
    readonly staticCompact?: boolean;
  };
  // Initial language-level user-equation call bound. The runtime default is 320. Zero explicitly selects
  // the implementation-defined unbounded policy. A program can replace it in-language with
  // `(pragma! max-stack-depth N)`. The `fuel` argument remains the independent per-path recursion bound.
  readonly maxStackDepth?: number;
  // Initial global inference-work bound for each top-level query. The runtime default is zero, which selects
  // an unlimited budget. A program can replace it with `(pragma! mettascript-max-steps N)`.
  readonly maxSteps?: number;
  // Optional observer/state for the language-level call lineage. Reusing one instance across a program
  // records the maximum attempted depth over every query without changing evaluation results.
  readonly evaluationDepth?: EvaluationDepth;
  // Optional opt-in execution trace sink. When set, the interpreter emits a `TraceEvent` per internal
  // decision (grounded dispatch, higher-order specialization, reduction step, stack-overflow cut). Off by
  // default at zero cost; used by the `metta-debug` CLI to explain evaluation.
  readonly trace?: TraceSink | undefined;
  /** Custom {@link Space} backends by name, so `(bind! &s …)` names an outside store — a persistent
   *  space held as a value, a remote atomspace, a database — instead of a log inside the World.
   *
   *  Every named-space read and write asks the registry first and falls through when a name has none,
   *  so a program that registers nothing behaves exactly as before. A backend does not take part in the
   *  world merge that joins parallel branches: it has identity and its own lifetime, and its writes land
   *  as they happen. That is the bargain any external store makes. */
  readonly spaces?: ReadonlyMap<string, Space> | undefined;
  /** Called for each atom a space gains or loses during evaluation. A change LOG, where `trace` is an
   *  execution trace: it says what the program did to its knowledge, not how it got there. Absent by
   *  default and free when absent. */
  readonly onSpaceChange?: ((op: "add" | "remove", space: string, atom: Atom) => void) | undefined;
  // Compiled holders to leave unbuilt, for differential debugging. `kinds` names holder kinds
  // (`functional`, `scalar`, `symbolic`, `imperative`, `rewrite`, `nondet`, `choiceUnion`, `pipeline`) and
  // `functors` names individual functions. Running a program as-is and again with one of them declined
  // says whether compiling it is what changed the answer; tracing both says where.
  readonly declineCompiled?: {
    readonly kinds?: readonly string[];
    readonly functors?: readonly string[];
  };
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
  // references only those, so this reproduces the in-line evaluation. Held on the env so import
  // promotion can extend it with a promoted module's definitions; read at call time. Result strings
  // are parsed back.
  env.parRulesSrc = atoms
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
      parseBranchResults(impl(env.parRulesSrc ?? "", branchSrcs, firstOnly));
  }
  const asyncImpl = opts.parEvalAsyncImpl;
  if (asyncImpl !== undefined) {
    env.parEvalAsync = async (branchSrcs, firstOnly) =>
      parseBranchResults(await asyncImpl(env.parRulesSrc ?? "", branchSrcs, firstOnly));
  }
}

function resultsForQuery(pairs: Array<[Atom, unknown]>): Atom[] {
  return pairs.map((p) => p[0]);
}

const isErrorAtom = (a: Atom): boolean =>
  a.kind === "expr" && a.items[0]?.kind === "sym" && a.items[0].name === "Error";

/** Type-check a non-directive atom on its way into the space, for `(pragma! type-check auto)`.
 *
 *  Hyperon reports an ill-typed atom where it is written rather than where it is first called, so a
 *  wrong equation like `(= (foo $x) (+ $x 1))` under `(: foo (-> Number Bool))` is caught at load. The
 *  check is the `check-types` the standard library already exposes, which answers unit for a well-typed
 *  atom and an `(Error <atom> (BadArgType ...))` otherwise. */
function typeCheckOnLoad(
  env: MinEnv,
  fuel: number,
  st: St,
  atom: Atom,
  depth: EvaluationDepth | undefined,
): Atom[] {
  const [pairs] = mettaEval(env, fuel, st, [], expr([sym("check-types"), atom]), depth);
  return resultsForQuery(pairs).filter(isErrorAtom);
}

function evalSequentialInternal(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts: RunOptions = {},
  includeNonBang: boolean,
): QueryResult[] {
  const out: QueryResult[] = [];
  let st: St = initSt();
  if (opts.maxStackDepth !== undefined) st.world.maxStackDepth = opts.maxStackDepth;
  if (opts.maxSteps !== undefined) st.world.maxSteps = opts.maxSteps;
  const env = buildDefaultEnv(imports, opts.tabling ?? DEFAULT_TABLING, opts);
  wireParallelEvaluation(env, atoms, opts);
  for (const { atom, bang } of atoms) {
    if (!bang) {
      const errs = st.world.typeCheckAuto
        ? typeCheckOnLoad(env, fuel, st, atom, opts.evaluationDepth)
        : [];
      addAtomToEnv(env, atom);
      if (errs.length > 0) out.push({ query: atom, results: errs });
      else if (includeNonBang) out.push({ query: atom, results: [] });
      continue;
    }
    const preWorld = st.world;
    const [pairs, st2] = mettaEval(env, fuel, st, [], atom, opts.evaluationDepth);
    // A completed top-level `&self` import is folded into the static env here, where exactly one world
    // is alive, so the rest of the program evaluates as if the module had been part of the file.
    st = promoteCompletedSelfImport(env, atom, preWorld, st2) ?? st2;
    out.push({ query: atom, results: resultsForQuery(pairs) });
  }
  return out;
}

/** Evaluate a parsed program sequentially. `imports` backs `import!` (pre-read by the caller). */
export function evalSequential(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequentialInternal(atoms, fuel, imports, opts, false);
}

/** Evaluate every top-level directive, including non-`!` atoms as empty result directives. */
export function evalSequentialAllDirectives(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequentialInternal(atoms, fuel, imports, opts, true);
}

/** Parse and run a MeTTa source string sequentially. */
export function runProgram(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts: RunOptions = {},
): QueryResult[] {
  return evalSequential(parseAll(src, standardTokenizer()), fuel, imports, opts);
}

/** Parse and run a MeTTa source string, returning one result entry per top-level directive. */
export function runProgramAllDirectives(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
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
  imports: ImportMap = new Map(),
  opts: RunOptions = {},
): Promise<QueryResult[]> {
  const parsed = parseAll(src, standardTokenizer());
  const env = buildDefaultEnv(imports, opts.tabling ?? false, opts);
  wireParallelEvaluation(env, parsed, opts);
  for (const [k, v] of asyncOps) registerAsyncGroundedOperation(env, k, v);
  const out: QueryResult[] = [];
  let st: St = initSt();
  if (opts.maxStackDepth !== undefined) st.world.maxStackDepth = opts.maxStackDepth;
  if (opts.maxSteps !== undefined) st.world.maxSteps = opts.maxSteps;
  for (const { atom, bang } of parsed) {
    if (!bang) {
      const errs = st.world.typeCheckAuto
        ? typeCheckOnLoad(env, fuel, st, atom, opts.evaluationDepth)
        : [];
      addAtomToEnv(env, atom);
      if (errs.length > 0) out.push({ query: atom, results: errs });
      continue;
    }
    const preWorld = st.world;
    const [pairs, st2] = await mettaEvalAsync(
      env,
      fuel,
      st,
      [],
      atom,
      undefined,
      opts.evaluationDepth,
    );
    st = promoteCompletedSelfImport(env, atom, preWorld, st2) ?? st2;
    out.push({ query: atom, results: resultsForQuery(pairs) });
  }
  return out;
}

/** Module names referenced by top-level `import!` statements (so a caller can pre-read them). */
export function collectImports(src: string): string[] {
  const out: string[] = [];
  for (const { atom } of parseAll(src, standardTokenizer())) {
    const name = literalImportTarget(atom);
    if (name !== undefined) out.push(name);
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
  imports: ImportMap = new Map(),
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
