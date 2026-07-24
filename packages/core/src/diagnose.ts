// SPDX-FileCopyrightText: 2026 MesTTo
// SPDX-License-Identifier: MIT

// The static analyzer: a pure function of (source, spanned CST, env, config) that collects every
// diagnostic in one pass. It never evaluates. Checks read the interpreter's own signature map, so a
// call the interpreter would reject for arity is flagged here, before running.
import { type Atom } from "./atom";
import { type MinEnv, type ImportMap, type ImportEntry, buildEnv } from "./eval";
import { type SpannedNode, parseAllSpanned } from "./cst";
import { standardTokenizer, preludeAtoms } from "./runner";
import { stdlibAtoms } from "./stdlib";
import { pettaStdlibAtoms } from "./petta-stdlib";
import { stdTable } from "./builtins";
import { type Diagnostic, DiagnosticSeverity, Applicability, spanToRange } from "./diagnostic";
import { FuzzyMatcher } from "./fuzzy";

export interface DiagnoseConfig {
  /** Enable the undefined-head near-miss check. Off by default: MeTTa's ADD-mode makes an unknown
   *  head legal (added to the space as data), so this heuristic must be opted into. */
  readonly undefinedSymbols: boolean;
}

/** The head symbol name of a call node, or undefined if the node is not `(sym ...)`. */
function headName(node: SpannedNode): string | undefined {
  const h = node.children?.[0]?.atom;
  return h?.kind === "sym" ? h.name : undefined;
}

/** The head symbol name of a type atom, mirroring eval's `opOf` for the tuple-type test. */
function typeHead(t: Atom): string | undefined {
  return t.kind === "expr" && t.items[0]?.kind === "sym" ? t.items[0].name : undefined;
}

/** Does the op also carry a non-arrow (tuple/atom) type? If so, an arity check against its arrow
 *  signature is unsafe, matching eval's `has_tuple_type` fallback. */
function hasTupleType(env: MinEnv, name: string): boolean {
  return (env.types.get(name) ?? []).some((t) => typeHead(t) !== "->");
}

/** Every head name the analyzer considers "known": declared signatures, rule heads, other type
 *  declarations, and grounded builtin ops. Used as the fuzzy dictionary and the defined-set. */
function knownNames(env: MinEnv): Set<string> {
  const names = new Set<string>();
  for (const k of env.sigs.keys()) names.add(k);
  for (const k of env.ruleIndex.keys()) names.add(k);
  for (const k of env.types.keys()) names.add(k);
  for (const k of env.gt.keys()) names.add(k);
  return names;
}

function checkUnknownHead(
  src: string,
  node: SpannedNode,
  known: Set<string>,
  matcher: FuzzyMatcher,
  out: Diagnostic[],
): void {
  const headNode = node.children?.[0];
  const name = headName(node);
  if (name === undefined || headNode === undefined) return;
  if (known.has(name)) return;
  const suggestions = matcher.suggest(name);
  if (suggestions.length === 0) return;
  const best = suggestions[0]!;
  const headRange = spanToRange(src, headNode.span.start, headNode.span.end);
  out.push({
    range: headRange,
    severity: DiagnosticSeverity.Warning,
    code: "unknown-symbol",
    message: `unknown symbol \`${name}\``,
    relatedInformation: [{ message: `a similar name is in scope: \`${best}\`` }],
    suggestions: [
      {
        span: headRange,
        replacement: best,
        applicability: Applicability.MaybeIncorrect,
        message: `did you mean \`${best}\`?`,
      },
    ],
  });
}

/** The parameter counts of every arrow type declared for `name`. The stdlib declares some ops more than
 *  once — `@doc`, `@param`, and `@return` each have an informal and a formal form — and Hyperon
 *  `check_if_function_type_is_applicable` accepts a call when ANY function type applies, so the well-formed
 *  argument counts are the union over every overload, not just `env.sigs`'s single kept signature. */
function declaredArities(env: MinEnv, name: string): Set<number> {
  const arities = new Set<number>();
  for (const t of env.types.get(name) ?? [])
    if (t.kind === "expr" && typeHead(t) === "->" && t.items.length >= 2)
      arities.add(t.items.length - 2);
  return arities;
}

/** "1 argument", "2 arguments", or "1 or 2 arguments" for an op with overloaded arities. */
function describeArities(arities: ReadonlySet<number>): string {
  const sorted = [...arities].sort((a, b) => a - b);
  const counts =
    sorted.length === 1
      ? `${sorted[0]}`
      : `${sorted.slice(0, -1).join(", ")} or ${sorted[sorted.length - 1]}`;
  const noun = sorted.length === 1 && sorted[0] === 1 ? "argument" : "arguments";
  return `${counts} ${noun}`;
}

function checkArity(src: string, node: SpannedNode, env: MinEnv, out: Diagnostic[]): void {
  const name = headName(node);
  if (name === undefined) return;
  // An op that also carries a non-arrow (tuple/atom) type can legitimately appear as data, so an arity check
  // against its arrow signature is unsafe — matches eval's `has_tuple_type` fallback.
  if (hasTupleType(env, name)) return;
  const arities = declaredArities(env, name);
  if (arities.size === 0) return; // no declared function type: an unknown head is legal data, not an error
  const argCount = (node.children?.length ?? 1) - 1;
  if (arities.has(argCount)) return; // the call matches one of the op's declared overloads
  out.push({
    range: spanToRange(src, node.span.start, node.span.end),
    severity: DiagnosticSeverity.Error,
    code: "arity-mismatch",
    message: `${name} expects ${describeArities(arities)}, got ${argCount}`,
  });
}

/** Parameter types the interpreter passes UNEVALUATED: `Atom` (spec `metta`: `$type == Atom` returns the
 *  argument as-is) and the `Variable`/`Expression` meta-types a form binds or matches. A call sitting at
 *  such a position — a case/if/let branch, a match/unify pattern, a quoted term — is data the interpreter
 *  never applies, so it is never arity- or undefined-checked. Read straight from the ops' own signatures. */
const UNEVALUATED_PARAM_TYPES = new Set(["Atom", "Variable", "Expression"]);

/** For each op, the argument positions its signature leaves unevaluated. `case : (-> Atom Expression
 *  %Undefined%)` marks its scrutinee and clause list; `if : (-> Bool Atom Atom $t)` marks its two branches;
 *  `let`, `match`, `unify`, and `quote` mark their pattern slots. Overloads are unioned. */
function unevaluatedArgPositions(env: MinEnv): Map<string, Set<number>> {
  const positions = new Map<string, Set<number>>();
  for (const [name, types] of env.types) {
    const data = new Set<number>();
    for (const t of types)
      if (t.kind === "expr" && typeHead(t) === "->")
        for (const [index, param] of t.items.slice(1, -1).entries())
          if (param.kind === "sym" && UNEVALUATED_PARAM_TYPES.has(param.name)) data.add(index);
    if (data.size > 0) positions.set(name, data);
  }
  return positions;
}

function walk(
  src: string,
  node: SpannedNode,
  env: MinEnv,
  config: DiagnoseConfig,
  known: Set<string>,
  matcher: FuzzyMatcher | undefined,
  dataPositions: ReadonlyMap<string, ReadonlySet<number>>,
  inData: boolean,
  out: Diagnostic[],
): void {
  if (node.children === undefined) return;
  // A node in an unevaluated (data) position is never applied by the interpreter, so it carries no arity or
  // undefined-head error — the head is a pattern, constructor, or quoted symbol, not a function call.
  if (!inData) {
    checkArity(src, node, env, out);
    if (config.undefinedSymbols && matcher !== undefined) {
      checkUnknownHead(src, node, known, matcher, out);
    }
  }
  const head = headName(node);
  const dataSet = head === undefined ? undefined : dataPositions.get(head);
  node.children.forEach((child, index) => {
    // index 0 is the head; the argument at child index `index` is 0-based parameter position `index - 1`.
    const childInData = inData || (index >= 1 && dataSet?.has(index - 1) === true);
    walk(src, child, env, config, known, matcher, dataPositions, childInData, out);
  });
}

/** Analyze a parsed program. Returns diagnostics deduplicated by (position, code) and sorted by position. */
export function analyze(
  src: string,
  cst: readonly SpannedNode[],
  env: MinEnv,
  config: DiagnoseConfig,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = config.undefinedSymbols ? knownNames(env) : new Set<string>();
  const matcher = config.undefinedSymbols ? new FuzzyMatcher(known) : undefined;
  const dataPositions = unevaluatedArgPositions(env);
  for (const node of cst) walk(src, node, env, config, known, matcher, dataPositions, false, out);
  const seen = new Set<string>();
  const deduped = out.filter((d) => {
    const k = `${d.range.start.line}:${d.range.start.character}:${d.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort(
    (a, b) =>
      a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
  return deduped;
}

/** Every declaration reachable through a resolved import graph, de-duplicated by module identity (the map
 *  keys each module by both its import name and its canonical id). Feeding these to the analyzer's env lets
 *  a call to a cross-file-typed op — whose `(: ...)` lives in an imported module — be checked against the
 *  same signature the runtime sees, instead of reading as an untyped head whose arguments all evaluate.
 *  Mirrors the runtime's `import!` def extraction (eval `appendImportedModule`). */
export function importedDefinitions(imports: ImportMap): Atom[] {
  const seen = new Set<ImportEntry>();
  const defs: Atom[] = [];
  for (const entry of imports.values()) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    defs.push(...(Array.isArray(entry) ? entry : entry.defs));
  }
  return defs;
}

/** Parse `src`, build the standard env (prelude + stdlib + petta + imported declarations + the program's own
 *  atoms), and analyze. `importedAtoms` are the declarations from resolved `import!` targets; without them a
 *  cross-file-typed op reads as untyped, so pass them (see `importedDefinitions`) to analyze a multi-file
 *  program the way the runtime runs it. */
export function analyzeSource(
  src: string,
  config: DiagnoseConfig,
  importedAtoms: readonly Atom[] = [],
): Diagnostic[] {
  const tk = standardTokenizer();
  const cst = parseAllSpanned(src, tk);
  const programAtoms = cst.map((n) => n.atom);
  const env = buildEnv(
    [...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms(), ...importedAtoms, ...programAtoms],
    stdTable(),
  );
  return analyze(src, cst, env, config);
}
